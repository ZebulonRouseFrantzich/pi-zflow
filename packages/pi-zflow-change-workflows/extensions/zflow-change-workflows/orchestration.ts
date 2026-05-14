/**
 * orchestration.ts — Phase 4 subagent orchestration wiring layer.
 *
 * Composes the Phase 4 infrastructure modules into dispatchable helpers
 * for chain/agent selection, launch-config injection, prompt assembly,
 * reviewer-manifest construction, and output routing.
 *
 * ## Design rules
 *
 * - This layer CHOOSES which agents/chains to run and HOW to configure them.
 * - It does NOT implement a runner — `pi-subagents` remains the sole runtime.
 * - It consumes resolved profile bindings (pi-zflow-profiles) and agent assets
 *   (pi-zflow-agents) without copying or duplicating them.
 * - Extension command registration (/zflow-change-prepare, etc.) is deferred
 *   to Phase 7; this module provides the library that those commands will call.
 *
 * ## Usage (planned — Phase 7 wiring)
 *
 * ```ts
 * import { buildWorkflowLaunchPlan } from "pi-zflow-change-workflows/orchestration"
 * import { subagent } from "pi-subagents"  // runtime API
 *
 * const plan = await buildWorkflowLaunchPlan("zflow.planner-frontier", activeProfile)
 * const output = await subagent(plan)
 * ```
 *
 * @module pi-zflow-change-workflows/orchestration
 */

import type {
  LaunchAgentConfig,
  ResolvedProfile,
} from "pi-zflow-profiles"
import {
  buildLaunchConfig,
  applyBuiltinOverride,
  getBuiltinOverride,
  applyDefaultMaxSubagentDepth,
  applyDefaultMaxOutput,
} from "pi-zflow-profiles"
import type {
  PromptAssemblyInput,
  WorkflowMode,
  ReminderId,
} from "pi-zflow-agents"
import {
  assemblePrompt,
  getOutputConvention,
  getOutputInstructions,
} from "pi-zflow-agents"
import type {
  ReviewerManifest,
  ReviewerMode,
} from "pi-zflow-review"
import {
  createManifest,
  recordSkipped as recordSkippedFn,
  getCoverageSummary,
} from "pi-zflow-review"
import { readRun, updateRun, setRunPhase, addRetainedArtifact, createRun, createRecoveryRef, removeRecoveryRef } from "pi-zflow-artifacts"
import type { RunPhase, RetainedArtifact, RunJson } from "pi-zflow-artifacts"
import { resolveRunDir, resolveRunStatePath, resolvePlanVersionDir, resolvePlanStatePath } from "pi-zflow-artifacts/artifact-paths"
import { addStateIndexEntry, loadStateIndex, listStateIndexEntries } from "pi-zflow-artifacts/state-index"
import type { StateIndexEntry } from "pi-zflow-artifacts/state-index"
import { assertCleanPrimaryTree } from "./git-preflight.js"
import type { GitPreflightResult } from "./git-preflight.js"
import { validateOwnershipAndDependencies, topoSortGroups } from "./ownership-validator.js"
import type { ExecutionGroup, OwnershipValidationResult } from "./ownership-validator.js"
import { captureGroupResult } from "./group-result.js"
import type { GroupResult, GroupVerificationResult } from "./group-result.js"
import { executeApplyBack } from "./apply-back.js"
import type { ApplyBackResult } from "./apply-back.js"
import { writeDeviationSummary, readDeviationReports } from "./deviations.js"

// ── Types ───────────────────────────────────────────────────────

/**
 * A fully resolved launch plan for a single subagent invocation.
 *
 * Combines the launch config (model, tools, limits) with the
 * assembled prompt and output-handling metadata. This is the
 * shape that extension commands will pass to `pi-subagents`.
 */
export interface SubagentLaunchPlan {
  /** Launch-time agent configuration. */
  config: LaunchAgentConfig
  /** The assembled prompt for this invocation. */
  prompt: string
  /** Output convention metadata for persisting results. */
  outputConvention: {
    /** Whether the orchestrator persists the output. */
    persistsOutput: boolean
    /** Expected output format. */
    format: "structured-markdown" | "file-changes" | "plan-artifact"
    /** Human-readable description of expected output. */
    description: string
  }
  /** Debug info: breakdown of prompt assembly. */
  promptSources: {
    /** Whether the role prompt was included. */
    rolePromptIncluded: boolean
    /** Which mode fragment was included, if any. */
    modeFragment: string | null
    /** Which reminder fragments were included. */
    activeReminders: string[]
    /** Number of distilled invariants included. */
    distilledCount: number
  }
}

/**
 * A complete multi-step workflow execution plan.
 *
 * Maps each workflow phase to one or more agent/chain launch plans.
 * Extension commands iterate over these entries to dispatch work.
 */
export interface WorkflowExecutionPlan {
  /** Unique correlation ID for this execution. */
  workflowId: string
  /** Timestamp when the plan was built. */
  createdAt: string
  /** Ordered list of execution steps. */
  steps: WorkflowStep[]
}

/**
 * A single step in a workflow execution plan.
 */
export interface WorkflowStep {
  /** Human-readable label for this step. */
  label: string
  /** The chain or agent to invoke. */
  target:
    | { type: "chain"; name: string }
    | { type: "agent"; plan: SubagentLaunchPlan }
    | { type: "parallel"; agents: SubagentLaunchPlan[] }
  /** Optional: whether this step runs conditionally. */
  condition?: {
    predicate: string
    description: string
  }
}

/**
 * Review configuration for assembling a review manifest.
 */
export interface ReviewSwarmConfig {
  /** Review mode: code-review or plan-review. */
  mode: ReviewerMode
  /** Tier classification from the plan's reviewTags. */
  tier: string
  /** The set of requested reviewer short names. */
  requestedReviewers: string[]
  /** Which reviewers should be skipped (with reasons). */
  skips?: Array<{ name: string; reason: string }>
}

// ── Launch-plan builders ───────────────────────────────────────

/**
 * Resolve a launch config for a builtin agent (e.g. "builtin:scout").
 *
 * Builtins aren't in `resolvedProfile.agentBindings`, so we derive the
 * config from their override definition and the resolved lane.
 *
 * @param agentName - The builtin runtime name (e.g. "builtin:scout").
 * @param resolvedProfile - The fully resolved active profile.
 * @returns A `LaunchAgentConfig` or `null` if the override or lane is missing.
 */
function resolveBuiltinLaunchConfig(
  agentName: string,
  resolvedProfile: ResolvedProfile,
): LaunchAgentConfig | null {
  // Strip "builtin:" prefix to get the override key (e.g. "scout")
  const shortName = agentName.replace("builtin:", "")
  const overrideDef = getBuiltinOverride(shortName)
  if (!overrideDef) return null

  const lane = overrideDef.override.lane ?? "scout-cheap"
  const resolvedLane = resolvedProfile.resolvedLanes[lane]
  if (!resolvedLane) return null

  return {
    agent: agentName,
    model: resolvedLane.resolvedModel,
    tools: overrideDef.override.tools,
    maxOutput: overrideDef.override.maxOutput,
    maxSubagentDepth: overrideDef.override.maxSubagentDepth,
    thinking: resolvedLane.thinking,
  }
}

/**
 * Build a complete `SubagentLaunchPlan` for a single agent.
 *
 * Resolves the agent's launch config from the active profile (or from
 * builtin override definitions for `builtin:*` agents), assembles the
 * appropriate prompt with mode/reminder fragments, and attaches
 * output-convention metadata.
 *
 * @param agentName - Agent runtime name (e.g. "zflow.planner-frontier").
 * @param resolvedProfile - The fully resolved active profile.
 * @param options - Assembly options (mode, reminders, artifacts).
 * @returns A `SubagentLaunchPlan` or `null` if the agent has no
 *          resolved model binding.
 */
export function buildSubagentLaunchPlan(
  agentName: string,
  resolvedProfile: ResolvedProfile,
  options?: {
    mode?: WorkflowMode
    activeReminders?: ReminderId[]
    artifactPaths?: Record<string, string>
    distilledInvariants?: string[]
  },
): SubagentLaunchPlan | null {
  // 1. Resolve launch config — builtins via overrides, custom via profile bindings
  let config: LaunchAgentConfig | null = null

  if (agentName.startsWith("builtin:")) {
    config = resolveBuiltinLaunchConfig(agentName, resolvedProfile)
  } else {
    config = buildLaunchConfig(agentName, resolvedProfile)
    // Apply builtin overrides for agents whose short name matches a builtin
    if (config) {
      const shortName = agentName.replace("zflow.", "")
      const overrideDef = getBuiltinOverride(shortName)
      if (overrideDef) {
        config = applyBuiltinOverride(config, overrideDef)
      }
    }
  }

  if (!config) return null

  // 2. Apply default depth and output limits (validates as a side effect)
  config = applyDefaultMaxSubagentDepth(config)
  config = applyDefaultMaxOutput(config)

  // 3. Assemble the prompt
  const assemblyInput: PromptAssemblyInput = {
    agentName,
    mode: options?.mode,
    activeReminders: options?.activeReminders,  // pass as-is (ReminderId[])
    artifactPaths: options?.artifactPaths,
    distilledOrchestratorInvariants: options?.distilledInvariants,
  }

  const assembled = assemblePrompt(assemblyInput)

  // 4. Attach output convention metadata
  const convention = getOutputConvention(agentName)

  return {
    config,
    prompt: assembled.prompt,
    outputConvention: {
      persistsOutput: convention?.persistsOutput ?? false,
      format: convention?.outputFormat ?? "structured-markdown",
      description: convention?.description ?? "",
    },
    promptSources: {
      rolePromptIncluded: true,
      modeFragment: assembled.modeFragment ?? null,
      activeReminders: Object.keys(assembled.includedReminders),
      distilledCount: assembled.orchestratorInvariants ? 1 : 0,
    },
  }
}

/**
 * Build launch plans for every configured agent in the profile.
 *
 * @param resolvedProfile - The fully resolved active profile.
 * @param defaultMode - Default workflow mode for all agents.
 * @returns A record of agent name → `SubagentLaunchPlan` for all
 *          agents with resolved model bindings.
 */
export function buildAllSubagentLaunchPlans(
  resolvedProfile: ResolvedProfile,
  defaultMode?: WorkflowMode,
): Record<string, SubagentLaunchPlan> {
  const plans: Record<string, SubagentLaunchPlan> = {}

  for (const agentName of Object.keys(resolvedProfile.agentBindings)) {
    const plan = buildSubagentLaunchPlan(agentName, resolvedProfile, {
      mode: defaultMode,
    })
    if (plan) {
      plans[agentName] = plan
    }
  }

  return plans
}

// ── Workflow execution plan builder ─────────────────────────────

let _workflowIdCounter = 0

/**
 * Generate a unique workflow ID.
 */
function generateWorkflowId(): string {
  _workflowIdCounter++
  const timestamp = Date.now().toString(36)
  const counter = _workflowIdCounter.toString(36).padStart(4, "0")
  return `zflow-${timestamp}-${counter}`
}

/**
 * Build a full `WorkflowExecutionPlan` for a given workflow phase.
 *
 * This is the main composition function that extension commands
 * (Phase 7) will call to get a complete plan for dispatching work.
 *
 * @param phase - The workflow phase to plan for.
 * @param resolvedProfile - The resolved active profile.
 * @param options - Phase-specific options.
 * @returns A `WorkflowExecutionPlan` with ordered steps.
 */
export function buildWorkflowExecutionPlan(
  phase: "prepare" | "implement" | "review" | "plan-review",
  resolvedProfile: ResolvedProfile,
  options?: {
    mode?: WorkflowMode
    reviewTags?: string
    reviewers?: string[]
    artifactPaths?: Record<string, string>
  },
): WorkflowExecutionPlan {
  const workflowId = generateWorkflowId()
  const steps: WorkflowStep[] = []

  switch (phase) {
    case "prepare": {
      // scout → planner-frontier → plan-validator → conditional plan-review
      const scoutPlan = buildSubagentLaunchPlan("builtin:scout", resolvedProfile, {
        mode: options?.mode ?? "change-prepare",
        artifactPaths: options?.artifactPaths,
      })
      if (scoutPlan) {
        steps.push({ label: "Scout — codebase reconnaissance", target: { type: "agent", plan: scoutPlan } })
      }

      const plannerPlan = buildSubagentLaunchPlan("zflow.planner-frontier", resolvedProfile, {
        mode: "plan-mode",
        artifactPaths: options?.artifactPaths,
      })
      if (plannerPlan) {
        steps.push({ label: "Planner — produce plan artifacts", target: { type: "agent", plan: plannerPlan } })
      }

      const validatorPlan = buildSubagentLaunchPlan("zflow.plan-validator", resolvedProfile, {
        mode: "plan-mode",
        artifactPaths: options?.artifactPaths,
      })
      if (validatorPlan) {
        steps.push({ label: "Plan validator — structural validation", target: { type: "agent", plan: validatorPlan } })
      }

      // Conditional plan-review: runs when reviewTags != "standard"
      // Uses getPlanReviewersForTier() for tier→reviewer mapping (correctness + integration
      // for all tiers, plus feasibility for system / logic,system).
      const reviewTags = options?.reviewTags ?? "standard"
      if (reviewTags !== "standard") {
        const planReviewAgents = getPlanReviewersForTier(reviewTags)
        for (const prAgentName of planReviewAgents) {
          const prPlan = buildSubagentLaunchPlan(prAgentName, resolvedProfile, {
            mode: "plan-mode",
            artifactPaths: options?.artifactPaths,
          })
          if (prPlan) {
            steps.push({
              label: `Plan-review ${prAgentName.replace("zflow.plan-review-", "")}`,
              target: { type: "agent", plan: prPlan },
              condition: { predicate: `reviewTags=${reviewTags}`, description: `Plan-review tier ${reviewTags}` },
            })
          }
        }
      }
      break
    }

    case "implement": {
      // context-builder → implement-routine → verifier → review swarm
      const cbPlan = buildSubagentLaunchPlan("builtin:context-builder", resolvedProfile, {
        mode: options?.mode ?? "change-implement",
        artifactPaths: options?.artifactPaths,
      })
      if (cbPlan) {
        steps.push({ label: "Context-builder — analogical analysis", target: { type: "agent", plan: cbPlan } })
      }

      const implPlan = buildSubagentLaunchPlan("zflow.implement-routine", resolvedProfile, {
        mode: "change-implement",
        artifactPaths: options?.artifactPaths,
      })
      if (implPlan) {
        steps.push({ label: "Implementation", target: { type: "agent", plan: implPlan } })
      }

      const verifierPlan = buildSubagentLaunchPlan("zflow.verifier", resolvedProfile, {
        mode: "change-implement",
        artifactPaths: options?.artifactPaths,
      })
      if (verifierPlan) {
        steps.push({ label: "Verifier — structured verification", target: { type: "agent", plan: verifierPlan } })
      }

      // Code review swarm — build parallel plans
      const baseReviewers = [
        "zflow.review-correctness",
        "zflow.review-integration",
        "zflow.review-security",
      ]
      const optionalReviewers: string[] = []
      if (options?.reviewTags?.includes("logic")) {
        optionalReviewers.push("zflow.review-logic")
      }
      if (options?.reviewTags?.includes("system")) {
        optionalReviewers.push("zflow.review-system")
      }

      const allReviewers = [...baseReviewers, ...optionalReviewers]
      const reviewPlans = allReviewers
        .map((name) => buildSubagentLaunchPlan(name, resolvedProfile, {
          mode: "review-pr",
          artifactPaths: options?.artifactPaths,
        }))
        .filter((p): p is SubagentLaunchPlan => p !== null)

      if (reviewPlans.length > 0) {
        steps.push({
          label: `Code review swarm (${reviewPlans.length} reviewers)`,
          target: { type: "parallel", agents: reviewPlans },
        })
      }

      const synthPlan = buildSubagentLaunchPlan("zflow.synthesizer", resolvedProfile, {
        mode: "review-pr",
        artifactPaths: options?.artifactPaths,
      })
      if (synthPlan) {
        steps.push({ label: "Synthesizer — consolidated findings", target: { type: "agent", plan: synthPlan } })
      }
      break
    }

    case "review": {
      // Parallel code review swarm (standalone, e.g. for PR review)
      const baseReviewers = [
        "zflow.review-correctness",
        "zflow.review-integration",
        "zflow.review-security",
      ]
      const optionalReviewers: string[] = []
      if (options?.reviewTags?.includes("logic")) {
        optionalReviewers.push("zflow.review-logic")
      }
      if (options?.reviewTags?.includes("system")) {
        optionalReviewers.push("zflow.review-system")
      }

      const allReviewers = [...baseReviewers, ...optionalReviewers]
      const reviewPlans = allReviewers
        .map((name) => buildSubagentLaunchPlan(name, resolvedProfile, {
          mode: "review-pr",
          artifactPaths: options?.artifactPaths,
        }))
        .filter((p): p is SubagentLaunchPlan => p !== null)

      if (reviewPlans.length > 0) {
        steps.push({
          label: `Code review swarm (${reviewPlans.length} reviewers)`,
          target: { type: "parallel", agents: reviewPlans },
        })
      }

      const synthPlan = buildSubagentLaunchPlan("zflow.synthesizer", resolvedProfile, {
        mode: "review-pr",
        artifactPaths: options?.artifactPaths,
      })
      if (synthPlan) {
        steps.push({ label: "Synthesizer — consolidated findings", target: { type: "agent", plan: synthPlan } })
      }
      break
    }

    case "plan-review": {
      // Plan-review swarm with tier-based selection
      const tier = options?.reviewTags ?? "standard"
      const planReviewers: string[] = ["zflow.plan-review-correctness", "zflow.plan-review-integration"]
      if (tier === "system" || tier === "logic,system") {
        planReviewers.push("zflow.plan-review-feasibility")
      }

      const prPlans = planReviewers
        .map((name) => buildSubagentLaunchPlan(name, resolvedProfile, {
          mode: "plan-mode",
          artifactPaths: options?.artifactPaths,
        }))
        .filter((p): p is SubagentLaunchPlan => p !== null)

      if (prPlans.length > 0) {
        steps.push({
          label: `Plan-review swarm (${prPlans.length} reviewers, tier=${tier})`,
          target: { type: "parallel", agents: prPlans },
        })
      }

      const synthPlan = buildSubagentLaunchPlan("zflow.synthesizer", resolvedProfile, {
        mode: "plan-mode",
        artifactPaths: options?.artifactPaths,
      })
      if (synthPlan) {
        steps.push({ label: "Synthesizer — consolidated plan-review findings", target: { type: "agent", plan: synthPlan } })
      }
      break
    }
  }

  return {
    workflowId,
    createdAt: new Date().toISOString(),
    steps,
  }
}

// ── Reviewer-manifest helpers ───────────────────────────────────

/**
 * Create a reviewer manifest for a review swarm.
 *
 * Automatically determines which reviewers should be skipped based
 * on the tier and the available reviewer set.
 *
 * @param config - Review swarm configuration.
 * @returns A new `ReviewerManifest` with reviewers in requested state.
 */
export function createSwarmManifest(
  config: ReviewSwarmConfig,
): ReviewerManifest {
  const { mode, tier, requestedReviewers, skips } = config

  // Build the initial manifest
  const manifest = createManifest(mode, tier, requestedReviewers)

  // Apply any skips
  if (skips) {
    let current = manifest
    for (const skip of skips) {
      current = recordSkippedFn(current, skip.name, skip.reason)
    }
    return current
  }

  return manifest
}

/**
 * Determine which reviewers to include for a given tier.
 *
 * This implements the tier→reviewer mapping from the plan:
 *
 * | Tier              | Reviewers                                            |
 * | ----------------- | ---------------------------------------------------- |
 * | `standard`        | correctness, integration, security                   |
 * | `logic`           | correctness, integration, security, logic             |
 * | `system`          | correctness, integration, security, system            |
 * | `logic,system`    | correctness, integration, security, logic, system    |
 *
 * @param tier - The tier classification from the plan's reviewTags.
 * @returns Array of agent runtime names for this tier.
 */
export function getReviewersForTier(tier: string): string[] {
  const base = [
    "zflow.review-correctness",
    "zflow.review-integration",
    "zflow.review-security",
  ]

  if (tier === "standard" || !tier) {
    return [...base]
  }

  const tags = tier.split(",").map((t) => t.trim())
  if (tags.includes("logic")) {
    base.push("zflow.review-logic")
  }
  if (tags.includes("system")) {
    base.push("zflow.review-system")
  }

  return base
}

/**
 * Get plan-review reviewers for a given tier.
 *
 * | Tier              | Reviewers                                            |
 * | ----------------- | ---------------------------------------------------- |
 * | `standard`        | correctness, integration                             |
 * | `logic`           | correctness, integration                             |
 * | `system`          | correctness, integration, feasibility                |
 * | `logic,system`    | correctness, integration, feasibility                |
 *
 * @param tier - The tier classification from the plan's reviewTags.
 * @returns Array of plan-review agent runtime names for this tier.
 */
export function getPlanReviewersForTier(tier: string): string[] {
  const base = [
    "zflow.plan-review-correctness",
    "zflow.plan-review-integration",
  ]

  if (tier === "system" || tier === "logic,system") {
    base.push("zflow.plan-review-feasibility")
  }

  return base
}

// ── Worktree dispatch helpers (Phase 5) ───────────────────────

/**
 * A single task for worktree dispatch, representing one execution group.
 */
export interface WorktreeGroupTask {
  /** Group identifier from execution-groups.md. */
  groupId: string
  /** The agent runtime name assigned to this group. */
  agent: string
  /** The assembled task prompt for this group. */
  task: string
  /** Files this group is expected to write (for preflight overlap check). */
  claimedFiles: string[]
  /** Optional scoped verification command from the plan. */
  scopedVerification?: string
  /** Output path for the worktree result manifest (relative to run dir). */
  outputRelativePath: string
}

/**
 * Configuration for a worktree dispatch operation.
 */
export interface WorktreeDispatchConfig {
  /** Unique run identifier. */
  runId: string
  /** Absolute path to the repository root. */
  repoRoot: string
  /** Change identifier from the plan. */
  changeId: string
  /** Plan version (e.g. "v1"). */
  planVersion: string
}

// Type for an execution group used by worktree dispatch
export interface DispatchExecutionGroup {
  id: string
  agent: string
  files: string[]
  dependencies: string[]
  taskPrompt: string
  scopedVerification?: string
}

/**
 * Build a worker task prompt for a single execution group.
 *
 * Produces a compact, actionable prompt that tells the worker agent:
 * - what to implement (scoped to this group's files)
 * - what not to touch
 * - what context artifacts to read
 * - how to validate
 * - when to escalate
 *
 * @param group - The execution group to build a task for.
 * @param config - Dispatch configuration (run ID, repo root, etc.).
 * @param planArtifactPaths - Paths to canonical plan artifacts.
 * @returns A task prompt string for the worker agent.
 */
export function buildWorkerTask(
  group: DispatchExecutionGroup,
  config: WorktreeDispatchConfig,
  planArtifactPaths?: Record<string, string>,
): string {
  const lines: string[] = [
    `# Task: ${group.id}`,
    "",
    `Execute the approved plan for group **${group.id}** in this isolated worktree.`,
    "",
    `## Run context`,
    `- Run ID: ${config.runId}`,
    `- Change: ${config.changeId}`,
    `- Plan version: ${config.planVersion}`,
    `- Repo root: ${config.repoRoot}`,
    "",
    `## Scope`,
    `- Files you may modify: ${group.files.join(", ") || "(none specified)"}`,
    `- Agent: ${group.agent}`,
    "",
    `## Rules`,
    `1. ONLY modify files listed in your scope above. Do NOT touch files outside this list.`,
    `2. If an instruction in the plan is impossible, stop work and file a deviation report.`,
    `3. Prefer batch edits for multi-file changes (use the \`edit\` tool with \`multi\` parameter).`,
    `4. For complex refactors, use patch mode to apply structured diffs.`,
    `5. Create temporary commits as needed using format: \`[pi-worker] ${group.id}: <step>\`.`,
    `6. After implementation, run the scoped verification command if provided.`,
    `7. Do NOT launch subagents.`,
    `8. Do NOT commit to the primary branch. Your worktree commits are disposable.`,
    `9. Report all changed files and verification results in your output summary.`,
  ]

  if (group.dependencies.length > 0) {
    lines.push(
      "",
      "## Dependencies",
      `This group depends on: ${group.dependencies.join(", ")}.`,
      "Those groups have already completed in their own worktrees.",
      "If you need output from a dependency, read the plan artifacts.",
    )
  }

  if (group.scopedVerification) {
    lines.push(
      "",
      "## Scoped verification",
      "After implementing, run the following command to verify your changes:",
      "",
      "```bash",
      group.scopedVerification,
      "```",
      "",
      "Include the verification result (pass/fail/output) in your summary.",
      "Do NOT invent or run repo-wide verification commands. Run only the",
      "scoped verification command specified above.",
    )
  } else {
    lines.push(
      "",
      "## Verification",
      "No scoped verification command was specified in the plan.",
      "STOP and report a plan-quality gap: the plan is missing a Scoped verification",
      "command for this group. Do NOT invent or run your own verification.",
    )
  }

  if (planArtifactPaths && Object.keys(planArtifactPaths).length > 0) {
    lines.push(
      "",
      "## Plan artifacts",
      "The following plan documents are available:",
      ...Object.entries(planArtifactPaths).map(
        ([key, val]) => `- ${key}: \`${val}\``,
      ),
    )
  }

  lines.push(
    "",
    "## Output format",
    "When finished, provide:",
    "1. Summary of changes made",
    "2. List of changed files (relative to repo root)",
    "3. Verification result",
    "4. Any unexpected issues or deviations",
  )

  return lines.join("\n")
}

/**
 * Build a parallel worktree dispatch plan from execution groups.
 *
 * Returns an array of `WorktreeGroupTask` objects that can be passed to
 * `subagents.parallel({ worktree: true, tasks: [...] })`.
 *
 * @param groups - Execution groups with assigned agents and task prompts.
 * @param config - Dispatch configuration.
 * @param planArtifactPaths - Optional paths to plan artifacts for context.
 * @returns Array of worktree group tasks ready for subagent dispatch.
 */
export function buildWorktreeDispatchPlan(
  groups: DispatchExecutionGroup[],
  config: WorktreeDispatchConfig,
  planArtifactPaths?: Record<string, string>,
): WorktreeGroupTask[] {
  return groups.map((group, index) => ({
    groupId: group.id,
    agent: group.agent,
    task: buildWorkerTask(group, config, planArtifactPaths),
    claimedFiles: group.files,
    scopedVerification: group.scopedVerification,
    outputRelativePath: `worktree-results/${group.id}-result.md`,
  }))
}

// ── Output routing helpers ──────────────────────────────────────

/**
 * Build output routing instructions for a completed subagent run.
 *
 * Maps the agent's output convention to the correct persistence
 * target within pi-zflow-artifacts' runtime-state directory structure.
 *
 * @param agentName - The agent runtime name.
 * @param workflowId - The parent workflow ID for routing.
 * @returns Routing metadata for the output persister.
 */
export function getOutputRoute(
  agentName: string,
  workflowId: string,
): {
  persists: boolean
  relativePath: string | null
  description: string
} {
  const convention = getOutputConvention(agentName)

  if (!convention || !convention.persistsOutput) {
    return { persists: false, relativePath: null, description: "No persistence required" }
  }

  const agentRole = convention.outputFormat

  // Map output format to routes
  const routeMap: Record<string, string> = {
    "structured-markdown": `findings/${agentName}/${workflowId}.md`,
    "plan-artifact": `plans/${workflowId}/`,
    "file-changes": `worktrees/${workflowId}/`,
  }

  return {
    persists: true,
    relativePath: routeMap[agentRole] ?? `output/${agentName}/${workflowId}.md`,
    description: convention.description,
  }
}

// ── Drift signaling (Task 5.11) ─────────────────────────────────

/**
 * Signal that a deviation (plan drift) has been detected.
 *
 * Attempts to send an intercom signal if `pi-intercom` is available,
 * and always marks the run as `drift-pending` in run.json.
 *
 * If intercom is not available, logs a warning and continues with
 * the fallback behavior (workers still write deviation reports and
 * mark tasks blocked).
 *
 * @param runId - Unique run identifier.
 * @param groupId - The group that detected the drift.
 * @param workerName - The worker agent name.
 * @param deviationPath - Path to the deviation report file.
 * @param cwd - Working directory (optional).
 */
export async function signalDriftDetected(
  runId: string,
  groupId: string,
  workerName: string,
  deviationPath?: string,
  cwd?: string,
): Promise<void> {
  // Always update run phase to drift-pending
  await setRunPhase(runId, "drift-pending", cwd)

  // Attempt intercom signaling (optional — graceful fallback)
  let intercomAvailable = false
  try {
    // Dynamic import to check for pi-intercom without hard dependency
    const intercomModule = await import("pi-intercom").catch(() => null)
    if (intercomModule && typeof intercomModule.intercom === "function") {
      intercomAvailable = true
      const msg = [
        `DRIFT DETECTED: Group "${groupId}" (worker: ${workerName})`,
        deviationPath ? `Deviation report: ${deviationPath}` : "",
        "",
        "The approved plan is infeasible for this group.",
        "Pending deviation reports should be synthesized for replanning.",
        "Halting new dependent dispatch until drift is resolved.",
      ].filter(Boolean).join("\n")

      await intercomModule.intercom({
        action: "send",
        to: "orchestrator",
        message: msg,
      })
    }
  } catch {
    // intercom not available — fallback is acceptable
  }

  if (!intercomAvailable) {
    // Fallback: drift is still tracked via run.json phase and deviation report files.
    // Workers independently write deviation reports and mark tasks blocked.
    // No intercom signal was sent, but drift-pending state is recorded.
    console.warn(
      `[pi-zflow] pi-intercom not available. Drift signal suppressed for group "${groupId}". ` +
      `Workers will still write deviation reports. Run marked as drift-pending.`,
    )
  }
}

// ── Retained artifact listing (Task 5.13) ───────────────────────

/**
 * List all retained artifacts for a run.
 *
 * Reads the run.json and returns the `retainedArtifacts` array,
 * which tracks worktree paths, patch paths, retention reasons,
 * and cleanup deadlines for debugging and cleanup discovery.
 *
 * @param runId - Unique run identifier.
 * @param cwd - Working directory (optional).
 * @returns Array of retained artifact entries.
 */
export async function listRetainedArtifacts(
  runId: string,
  cwd?: string,
): Promise<RetainedArtifact[]> {
  const run = await readRun(runId, cwd)
  return run.retainedArtifacts ?? []
}

// ═══════════════════════════════════════════════════════════════════
// Phase 5 — worktree implementation run orchestration
// ═══════════════════════════════════════════════════════════════════

/**
 * A complete plan for executing a worktree implementation run.
 *
 * Contains preflight metadata, validation results, the run record,
 * and the task descriptors that the caller dispatches via
 * `pi-subagents` with `worktree: true`.
 */
export interface WorktreeImplementationRunPlan {
  /** Unique run identifier. */
  runId: string
  /** Dispatch configuration for pi-subagents. */
  config: WorktreeDispatchConfig
  /** Task descriptors to pass to pi-subagents. */
  tasks: WorktreeGroupTask[]
  /** Execution groups with dependency metadata. */
  groups: ExecutionGroup[]
  /** Set of all planned file paths (for preflight overlap check). */
  plannedPaths: Set<string>
  /** Result of clean-tree preflight. */
  preflight: GitPreflightResult
  /** Result of ownership and dependency validation. */
  ownershipValidation: OwnershipValidationResult
  /** The created run metadata. */
  run: RunJson
  /**
   * Execution ordering: parallel batches (groups that can run together)
   * and sequential groups (those that must run after their dependencies).
   */
  executionPlan: {
    /** Groups that can run in parallel (no overlapping files). */
    parallelBatches: ExecutionGroup[][]
    /** Groups that must run sequentially (overlapping files or explicit dependencies). */
    sequentialGroups: ExecutionGroup[]
  }
}

/**
 * Prepare a complete worktree implementation run.
 *
 * This is the main Phase 5 orchestration entrypoint. It:
 *
 * 1. Resolves the repo root from the current working directory.
 * 2. Collects all planned file paths from execution groups.
 * 3. Runs clean-tree preflight — rejects dirty trees.
 * 4. Validates ownership boundaries and dependency ordering.
 * 5. Creates `run.json` with recovery-grade metadata.
 * 6. Creates a git recovery ref for atomic rollback.
 * 7. Updates `state-index.json` with the new run entry.
 * 8. Determines parallel vs. sequential execution batches.
 * 9. Builds task descriptors for each group.
 *
 * The caller dispatches the tasks via pi-subagents with `worktree: true`,
 * then calls `finalizeWorktreeImplementationRun()` with the results.
 *
 * @param changeId - Change identifier from the plan.
 * @param planVersion - Plan version (e.g. "v1").
 * @param groups - Execution groups from the approved plan.
 * @param planArtifactPaths - Optional paths to plan artifacts for context.
 * @param options - Additional options.
 * @returns A complete worktree implementation run plan.
 * @throws If preflight or validation fails.
 */
export async function prepareWorktreeImplementationRun(
  changeId: string,
  planVersion: string,
  groups: ExecutionGroup[],
  planArtifactPaths?: Record<string, string>,
  options?: {
    /** Working directory for runtime state dir resolution. */
    cwd?: string
    /** Override file paths for preflight (defaults to all group files). */
    plannedPaths?: Set<string>
    /** Explicit repo root. Defaults to git rev-parse --show-toplevel from cwd. */
    repoRoot?: string
  },
): Promise<WorktreeImplementationRunPlan> {
  const cwd = options?.cwd
  const { default: path } = await import("node:path")
  const { execFileSync } = await import("node:child_process")

  // 1. Resolve repo root
  let repoRoot: string
  if (options?.repoRoot) {
    repoRoot = options.repoRoot
  } else {
    try {
      repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim()
    } catch {
      throw new Error("Not a git repository — cannot run worktree implementation.")
    }
  }

  // 2. Collect planned file paths
  const plannedPaths = options?.plannedPaths ?? new Set<string>()
  if (!options?.plannedPaths) {
    for (const group of groups) {
      for (const file of group.files) {
        plannedPaths.add(file)
      }
    }
  }

  // 3. Clean-tree preflight
  const preflight = assertCleanPrimaryTree(repoRoot, plannedPaths)
  if (!preflight.clean) {
    throw new Error(
      `Worktree implementation preflight failed.\n${preflight.summary}`,
    )
  }

  // 4. Validate ownership and dependencies
  const ownershipValidation = validateOwnershipAndDependencies(groups)
  if (!ownershipValidation.valid) {
    throw new Error(
      `Ownership/dependency validation failed:\n${ownershipValidation.summary}`,
    )
  }

  // 5. Create run.json
  const runId = `impl-${changeId}-${Date.now().toString(36)}`
  const run = await createRun(runId, repoRoot, changeId, planVersion, cwd)

  // Recovery ref is created later by executeApplyBack, right before patches are applied.
  // This ensures the ref points at the exact pre-apply snapshot and cannot diverge.

  // 6. Update state-index.json
  await addStateIndexEntry({
    type: "run",
    id: runId,
    status: "preparing",
    metadata: {
      changeId,
      planVersion,
      repoRoot,
      groupCount: groups.length,
    },
  }, cwd)

  // 8. Determine execution batches
  const parallelBatches: ExecutionGroup[][] = []
  const sequentialGroups: ExecutionGroup[] = []

  // Groups with overlapping files that must be sequential
  const sequentialIds = new Set<string>()
  for (const batch of ownershipValidation.sequentialGroups) {
    for (const id of batch) {
      sequentialIds.add(id)
    }
  }

  // Groups with explicit dependencies are also sequential (relative to their deps)
  for (const group of groups) {
    if (group.dependencies.length > 0) {
      sequentialIds.add(group.id)
    }
  }

  // Separate parallel from sequential groups
  const parallelGroupIds = groups
    .filter((g) => !sequentialIds.has(g.id))
    .map((g) => g.id)

  // Batch parallel groups (all in one batch)
  if (parallelGroupIds.length > 0) {
    parallelBatches.push(
      groups.filter((g) => parallelGroupIds.includes(g.id)),
    )
  }

  // Sequential groups in topological order
  const sequentialIdsSet = new Set(sequentialIds)
  const sequentialOnly = groups.filter((g) => sequentialIdsSet.has(g.id))
  if (sequentialOnly.length > 0) {
    const orderedSequential = topoSortGroups(sequentialOnly) ?? sequentialOnly.map((g) => g.id)
    const seqGroupMap = new Map(groups.map((g) => [g.id, g]))
    for (const id of orderedSequential) {
      const g = seqGroupMap.get(id)
      if (g) sequentialGroups.push(g)
    }
  }

  // 9. Build task descriptors
  const dispatchConfig: WorktreeDispatchConfig = {
    runId,
    repoRoot,
    changeId,
    planVersion,
  }

  const tasks = buildWorktreeDispatchPlan(groups, dispatchConfig, planArtifactPaths)

  return {
    runId,
    config: dispatchConfig,
    tasks,
    groups,
    plannedPaths,
    preflight,
    ownershipValidation,
    run,
    executionPlan: {
      parallelBatches,
      sequentialGroups,
    },
  }
}

/**
 * Finalize a worktree implementation run after worker dispatch.
 *
 * Called after the caller has dispatched the tasks via pi-subagents and
 * collected the GroupResult objects. This function:
 *
 * 1. Checks for any deviation reports and synthesizes a summary if needed.
 * 2. Applies patches back atomically in topological order.
 * 3. Records retained artifacts on conflict.
 * 4. Updates state-index.json with the final status.
 *
 * @param runId - The run identifier from prepareWorktreeImplementationRun.
 * @param groupResults - The GroupResult objects from each worker.
 * @param options - Additional options.
 * @returns The apply-back result.
 */
export async function finalizeWorktreeImplementationRun(
  runId: string,
  groupResults: GroupResult[],
  options?: {
    /** Working directory for runtime state dir resolution. */
    cwd?: string
    /** Change ID for deviation lookup. */
    changeId?: string
    /** Plan version for deviation lookup. */
    planVersion?: string
    /** Whether to retain artifacts on failure. */
    retainOnFailure?: boolean
    /**
     * Original execution groups with real dependencies from the approved plan.
     * When provided, these are used for topological apply-back ordering instead
     * of reconstructing groups from run.json (which strips dependency info).
     */
    executionGroups?: ExecutionGroup[]
  },
): Promise<ApplyBackResult & { deviationSummaryPath?: string }> {
  const cwd = options?.cwd
  const { default: path } = await import("node:path")

  // Read the run to get metadata
  let run: RunJson
  try {
    run = await readRun(runId, cwd)
  } catch {
    throw new Error(`Run "${runId}" not found. Cannot finalize.`)
  }

  const repoRoot = run.repoRoot
  const changeId = options?.changeId ?? run.changeId
  const planVersion = options?.planVersion ?? run.planVersion

  // 1. Check for deviation reports
  let deviationSummaryPath: string | undefined
  try {
    const reports = await readDeviationReports(changeId, planVersion, cwd)
    if (reports.length > 0) {
      // Synthesize deviation summary
      const { synthesizeDeviationSummary } = await import("./deviations.js")
      const summary = synthesizeDeviationSummary(runId, changeId, planVersion, reports)
      deviationSummaryPath = await writeDeviationSummary(summary, cwd)
    }
  } catch {
    // Ignore errors reading deviations — drift may not be implemented
  }

  // 2. Apply patches back atomically
  // Use original execution groups (with real dependencies) if provided,
  // falling back to reconstructed groups from run.json.
  const applyBackGroups = options?.executionGroups && options.executionGroups.length > 0
    ? options.executionGroups.map((g) => ({
        id: g.id,
        files: g.files,
        dependencies: g.dependencies,
        assignedAgent: g.agent,
      }))
    : run.groups.map((g) => ({
        id: g.groupId,
        files: g.changedFiles,
        dependencies: [],
        assignedAgent: g.agent,
      }))

  const applyBackResult = await executeApplyBack({
    runId,
    repoRoot,
    snapshot: run.preApplySnapshot!,
    groups: applyBackGroups,
    cwd,
  })

  // 3. Handle retention on conflict
  if (!applyBackResult.success && options?.retainOnFailure !== false) {
    const { resolveRunDir } = await import("pi-zflow-artifacts/artifact-paths")
    const patchesDir = await import("node:path").then((p) =>
      p.join(resolveRunDir(runId, cwd), "patches")
    )

    // Retain the patches directory
    await addRetainedArtifact(runId, {
      type: "patch",
      path: patchesDir,
      reason: applyBackResult.error
        ? `Apply-back failed: ${applyBackResult.error}`
        : "Apply-back failed",
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(), // 14 days
    }, cwd)
  }

  // 4. Update state-index.json
  try {
    const { updateStateIndexEntry } = await import("pi-zflow-artifacts/state-index")
    await updateStateIndexEntry(runId, {
      status: applyBackResult.success ? "completed" : "failed",
      metadata: {
        groupsApplied: applyBackResult.groupsApplied,
        totalGroups: applyBackResult.totalGroups,
        error: applyBackResult.error,
      },
    }, cwd)
  } catch {
    // State index entry may not exist yet; that's OK
  }

  return {
    ...applyBackResult,
    deviationSummaryPath,
  }
}

/**
 * Execute a complete worktree implementation run end-to-end.
 *
 * Combines `prepareWorktreeImplementationRun` and `finalizeWorktreeImplementationRun`
 * into a single call. Use this when the caller handles dispatching pi-subagents
 * between the two phases.
 *
 * For a fully automated version, the caller does:
 * ```
 * const plan = await prepareWorktreeImplementationRun(...)
 * // dispatch plan.tasks via pi-subagents with worktree: true
 * const results = await collectGroupResults(plan.runId, plan.groups, ...)
 * const final = await finalizeWorktreeImplementationRun(plan.runId, results, ...)
 */

// ═══════════════════════════════════════════════════════════════════
// Phase 7 — state-index lifecycle and unfinished-run discovery
// ═══════════════════════════════════════════════════════════════════

/**
 * Status values that count as "unfinished" for a run or plan.
 */
const UNFINISHED_STATUSES = new Set([
  "pending",
  "preparing",
  "planning",
  "reviewing",
  "executing",
  "applying",
  "drift-pending",
  "cleanup-pending",
  "apply-back-conflicted",
])

/**
 * Discover unfinished work for a given change ID.
 *
 * Loads the state index and filters entries whose `metadata.changeId`
 * matches the given changeId. Returns arrays of unfinished runs and
 * plans, plus a convenience boolean.
 *
 * @param changeId - The change identifier to look up.
 * @param cwd - Working directory (optional).
 * @returns Object with unfinished runs, unfinished plans, and a convenience boolean.
 */
export async function discoverUnfinishedWork(
  changeId: string,
  cwd?: string,
): Promise<{
  unfinishedRuns: StateIndexEntry[]
  unfinishedPlans: StateIndexEntry[]
  hasUnfinishedWork: boolean
}> {
  const index = await loadStateIndex(cwd)

  const changeEntries = index.entries.filter(
    (e) => e.metadata && typeof e.metadata === "object" && "changeId" in e.metadata!
      && e.metadata!.changeId === changeId,
  )

  const unfinishedRuns = changeEntries.filter(
    (e) => e.type === "run" && UNFINISHED_STATUSES.has(e.status),
  )
  const unfinishedPlans = changeEntries.filter(
    (e) => e.type === "plan" && UNFINISHED_STATUSES.has(e.status),
  )

  return {
    unfinishedRuns,
    unfinishedPlans,
    hasUnfinishedWork: unfinishedRuns.length > 0 || unfinishedPlans.length > 0,
  }
}

/**
 * Produce a human-readable summary of unfinished work for a change.
 *
 * Lists each unfinished entry with its type, ID, status, and creation
 * time, followed by suggested next actions.
 *
 * @param unfinished - The result of `discoverUnfinishedWork()`.
 * @returns A formatted string describing the unfinished work.
 */
export function promptResumeChoices(unfinished: {
  unfinishedRuns: StateIndexEntry[]
  unfinishedPlans: StateIndexEntry[]
}): string {
  const lines: string[] = []

  const allUnfinished = [
    ...unfinished.unfinishedPlans.map((e) => ({ ...e, _label: "plan" })),
    ...unfinished.unfinishedRuns.map((e) => ({ ...e, _label: "run" })),
  ]

  if (allUnfinished.length === 0) {
    return "No unfinished work found for this change."
  }

  lines.push("## Unfinished work detected")
  lines.push("")
  lines.push("| Type | ID | Status | Created |")
  lines.push("|------|----|--------|---------|")
  for (const entry of allUnfinished) {
    const created = entry.createdAt ? new Date(entry.createdAt).toISOString().slice(0, 19).replace("T", " ") : "(unknown)"
    lines.push(`| ${entry._label} | ${entry.id} | ${entry.status} | ${created} |`)
  }
  lines.push("")
  lines.push("### Available actions")
  lines.push("")
  lines.push("- `resume` — Continue the most recent unfinished run/plan")
  lines.push("- `abandon` — Mark unfinished work as cancelled and start fresh")
  lines.push("- `inspect` — Show detailed state of each unfinished item")
  lines.push("- `cleanup` — Remove stale artifacts associated with unfinished work")
  lines.push("")
  lines.push("Enter one of the above to proceed, or `skip` to ignore and continue.")

  return lines.join("\n")
}

// ═══════════════════════════════════════════════════════════════════
// Phase 7 — Formal workflow orchestration
// ═══════════════════════════════════════════════════════════════════

/**
 * Options for the `/zflow-change-prepare` workflow orchestration.
 */
export interface PrepareWorkflowOptions {
  /** Working directory for runtime state dir resolution. */
  cwd?: string
  /** Optional change path (RuneContext path or directory). */
  changePath?: string
  /** Explicit change ID. Auto-generated from changePath if omitted. */
  changeId?: string
  /** Whether to skip the plan-review step. */
  skipReview?: boolean
}

/**
 * Result of the `/zflow-change-prepare` workflow orchestration.
 */
export interface PrepareWorkflowResult {
  /** Resolved change identifier. */
  changeId: string
  /** The initial plan version label (always "v1" for a new prepare). */
  planVersion: string
  /** Absolute path to the plan-state.json file. */
  planStatePath: string
  /** Current lifecycle state of the plan. */
  status: "draft" | "validated" | "reviewed" | "approved" | "needs-revision"
  /** Absolute paths to the four canonical plan artifact files. */
  artifactPaths: Record<string, string>
  /** Absolute path to review findings, if a plan-review was run. */
  reviewFindingsPath?: string
}

/**
 * Generate a deterministic but unique change identifier.
 *
 * If a `changePath` is provided, derives a slug from it and appends a
 * timestamp suffix for uniqueness. Otherwise creates a timestamp-only ID.
 *
 * @param changePath - Optional path to derive the slug from.
 * @returns A kebab-case change ID string.
 */
function generateChangeId(changePath?: string): string {
  const timestamp = Date.now().toString(36)
  if (changePath) {
    const slug = changePath
      .replace(/[^a-zA-Z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase()
      .slice(0, 20)
    return `${slug}-${timestamp}`
  }
  return `change-${timestamp}`
}

/**
 * Update the plan-state.json for a change with partial updates.
 *
 * Reads the existing plan state, merges the provided updates, and writes
 * it back atomically. The plan-state.json file lives at
 * `<runtime-state-dir>/plans/{changeId}/plan-state.json`.
 *
 * @param changeId - The change identifier.
 * @param updates - Partial plan-state fields to merge.
 * @param cwd - Working directory (optional).
 */
export async function updatePlanState(
  changeId: string,
  updates: Partial<{
    currentVersion: string
    approvedVersion: string | null
    lifecycleState: string
    versions: Record<string, { state: string; createdAt?: string }>
  }>,
  cwd?: string,
): Promise<void> {
  const { default: fs } = await import("node:fs/promises")
  const planStatePath = resolvePlanStatePath(changeId, cwd)

  const existing = JSON.parse(await fs.readFile(planStatePath, "utf-8"))
  const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() }
  await fs.writeFile(planStatePath, JSON.stringify(updated, null, 2), "utf-8")
}

/**
 * Run the formal `/zflow-change-prepare` workflow orchestration.
 *
 * This function:
 * 1. Checks for unfinished work in the state index for the given change.
 * 2. Resolves or generates a change ID.
 * 3. Creates `plan-state.json` with draft status and version `v1`.
 * 4. Creates the version directory under `<runtime-state-dir>/plans/{changeId}/v1/`.
 * 5. Builds canonical plan artifact paths for agent dispatch.
 * 6. Adds a state-index entry tracking this plan.
 * 7. Returns an initial workflow execution plan structure for the caller
 *    to populate with resolved profile steps.
 *
 * The caller (the extension command handler) is responsible for:
 * - Resolving the active profile (`Profile.ensureResolved()`)
 * - Calling `buildWorkflowExecutionPlan("prepare", ...)` with the resolved profile
 * - Dispatching agents via pi-subagents
 * - Calling `updatePlanState()` to advance lifecycle state after each phase
 *
 * @param options - Prepare workflow options.
 * @returns The prepared plan context with change ID, version, plan state path, and initial plan.
 */
export async function runChangePrepareWorkflow(
  options: PrepareWorkflowOptions,
): Promise<{
  changeId: string
  planVersion: string
  stateDir: string
  planStatePath: string
  artifactPaths: Record<string, string>
  initialPlanState: Record<string, unknown>
}> {
  const cwd = options.cwd
  const { default: fs } = await import("node:fs/promises")
  const { default: path } = await import("node:path")

  // 1. Check for unfinished work if a changeId was provided
  if (options.changeId) {
    const unfinished = await discoverUnfinishedWork(options.changeId, cwd)
    if (unfinished.hasUnfinishedWork) {
      console.warn(
        `[zflow] Unfinished work detected for change "${options.changeId}". ` +
        "Call promptResumeChoices() before proceeding.",
      )
    }
  }

  // 2. Resolve or generate change ID
  const changeId = options.changeId ?? generateChangeId(options.changePath)

  // 3. Create initial plan-state.json
  const planStatePath = resolvePlanStatePath(changeId, cwd)
  const initialPlanState = {
    changeId,
    currentVersion: "v1",
    approvedVersion: null,
    lifecycleState: "draft",
    runeContext: {
      enabled: !!options.changePath,
      changePath: options.changePath ?? null,
    },
    versions: {
      v1: { state: "draft", createdAt: new Date().toISOString() },
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  await fs.mkdir(path.dirname(planStatePath), { recursive: true })
  await fs.writeFile(planStatePath, JSON.stringify(initialPlanState, null, 2), "utf-8")

  // 4. Create version v1 directory
  const versionDir = resolvePlanVersionDir(changeId, "v1", cwd)
  await fs.mkdir(versionDir, { recursive: true })

  // 5. Build canonical plan artifact paths
  const artifactPaths = {
    design: path.join(versionDir, "design.md"),
    executionGroups: path.join(versionDir, "execution-groups.md"),
    standards: path.join(versionDir, "standards.md"),
    verification: path.join(versionDir, "verification.md"),
  }

  // 6. Add state-index entry
  await addStateIndexEntry({
    type: "plan",
    id: `plan-${changeId}-v1`,
    status: "draft",
    metadata: {
      changeId,
      version: "v1",
      changePath: options.changePath ?? null,
    },
  }, cwd)

  return {
    changeId,
    planVersion: "v1",
    stateDir: path.dirname(planStatePath),
    planStatePath,
    artifactPaths,
    initialPlanState,
  }
}
