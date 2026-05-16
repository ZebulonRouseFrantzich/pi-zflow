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
import { resolveRunDir, resolveRunStatePath, resolvePlanVersionDir, resolvePlanStatePath, resolvePlanArtifactPath, resolveCodeReviewFindingsPath } from "pi-zflow-artifacts/artifact-paths"
import { addStateIndexEntry, loadStateIndex, listStateIndexEntries, updateStateIndexEntry } from "pi-zflow-artifacts/state-index"
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
import { getCurrentBranch } from "./git-preflight.js"
import { getZflowRegistry } from "pi-zflow-core/registry"
import {
  isRepoMapFresh,
  writeRepoMapCache,
  computeRepoStructureHash,
} from "./repo-map-cache.js"
import {
  resolveVerificationCommand,
  runVerification,
  appendFailureLog,
  runVerificationFixLoop,
} from "./verification.js"
import type { VerificationResult, FixLoopResult, FixLoopOptions } from "./verification.js"

// ── Execution groups parsing ──────────────────────────────────

/**
 * Parse execution-groups.md content into ExecutionGroup objects.
 *
 * Expects the format:
 *
 * ```markdown
 * ## Group {n}: {descriptive name}
 *
 * - **Files:** path/to/file.ts, another/file.ts
 * - **Agent:** zflow.implement-routine
 * - **Verification:** optional scoped verification text
 * ```
 */
export function parseExecutionGroupsMd(mdContent: string): import("./ownership-validator.js").ExecutionGroup[] {
  const groups: import("./ownership-validator.js").ExecutionGroup[] = []
  const lines = mdContent.split("\n")
  let currentGroup: Partial<import("./ownership-validator.js").ExecutionGroup> | null = null

  for (const line of lines) {
    const groupMatch = line.match(/^## Group\s+(\d+):\s+(.+)$/i)
    if (groupMatch) {
      if (currentGroup?.id) {
        groups.push({
          id: currentGroup.id,
          files: currentGroup.files ?? [],
          dependencies: currentGroup.dependencies ?? [],
          agent: currentGroup.agent ?? "zflow.implement-routine",
          parallelizable: currentGroup.parallelizable ?? true,
          taskPrompt: currentGroup.taskPrompt ?? "",
          scopedVerification: currentGroup.scopedVerification,
        })
      }
      currentGroup = {
        id: `group-${groupMatch[1]}`,
        files: [],
        dependencies: [],
        agent: "zflow.implement-routine",
        taskPrompt: groupMatch[2],
        parallelizable: true,
      }
      continue
    }

    if (!currentGroup) continue

    const filesMatch = line.match(/-\s+\*\*Files?:\*\*\s+(.+)/i)
    if (filesMatch) {
      currentGroup.files = filesMatch[1].split(",").map((f: string) => f.trim()).filter(Boolean)
      continue
    }

    const agentMatch = line.match(/-\s+\*\*Agent:\*\*\s+(.+)/i)
    if (agentMatch) {
      currentGroup.agent = agentMatch[1].trim()
      continue
    }

    const depMatch = line.match(/-\s+\*\*Dependencies:\*\*\s+(.+)/i)
    if (depMatch) {
      currentGroup.dependencies = depMatch[1].split(",").map((d: string) => d.trim()).filter(Boolean)
      continue
    }

    const verifMatch = line.match(/-\s+\*\*Verification:\*\*\s+(.+)/i)
    if (verifMatch) {
      currentGroup.scopedVerification = verifMatch[1].trim()
      continue
    }

    const parallelMatch = line.match(/-\s+\*\*Parallelizable:\*\*\s+(.+)/i)
    if (parallelMatch) {
      currentGroup.parallelizable = parallelMatch[1].trim().toLowerCase() === "yes" ||
        parallelMatch[1].trim().toLowerCase() === "true"
      continue
    }
  }

  // Push the last group
  if (currentGroup?.id) {
    groups.push({
      id: currentGroup.id,
      files: currentGroup.files ?? [],
      dependencies: currentGroup.dependencies ?? [],
      agent: currentGroup.agent ?? "zflow.implement-routine",
      parallelizable: currentGroup.parallelizable ?? true,
      taskPrompt: currentGroup.taskPrompt ?? "",
      scopedVerification: currentGroup.scopedVerification,
    })
  }

  return groups
}

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
    model: resolvedLane.model,
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

/**
 * Inject agent-specific guidance fragments into a subagent prompt.
 *
 * For scout/context-builder agents, appends the scout-reconnaissance guide.
 * For planner/review agents, appends the code-skeleton guide.
 *
 * @param agentName - The agent runtime name (e.g. "builtin:scout", "zflow.planner-frontier").
 * @param prompt - The base prompt to extend.
 * @returns The prompt with guidance fragment appended, or original prompt if none applies.
 */
export async function injectAgentGuidanceFragments(
  agentName: string,
  prompt: string,
): Promise<string> {
  const parts: string[] = []

  if (agentName.includes("scout") || agentName.includes("context-builder")) {
    try {
      const { loadFragment } = await import("pi-zflow-agents")
      const fragment = await loadFragment("scout-reconnaissance")
      parts.push(fragment.trim())
    } catch {
      // Fragment not available — skip
    }
  }

  if (
    agentName.includes("planner") ||
    agentName.includes("plan-review") ||
    agentName.includes("review-")
  ) {
    try {
      const { loadFragment } = await import("pi-zflow-agents")
      const fragment = await loadFragment("code-skeleton-guide")
      parts.push(fragment.trim())
    } catch {
      // Fragment not available — skip
    }
  }

  if (parts.length === 0) return prompt

  return prompt + "\n\n" + parts.join("\n\n")
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

// ── Resume/recovery flows (Task 7.17) ────────────────────────────

/**
 * Resume context describing unfinished work for a given change.
 */
export interface ResumeContext {
  /** Change identifier */
  changeId: string
  /** Most recent run ID, if any */
  runId?: string
  /** Plan version, if known */
  planVersion?: string
  /** Last known phase of the workflow */
  lastPhase: string
  /** Available resume options */
  resumeOptions: string[]
  /** Human-readable details of unfinished entries */
  details: string
}

/**
 * Detect unfinished work and build a resume context.
 *
 * Reads the `state-index.json` and finds entries with unfinished statuses.
 * If a `changeId` is provided, filters to only that change. Returns the
 * most recent run's phase and available resume options.
 *
 * This is called on startup or workflow command entry.
 *
 * @param changeId - Optional change ID to filter by.
 * @param cwd - Working directory (optional).
 * @returns A `ResumeContext` if unfinished work is found, or `null`.
 */
export async function detectResumeContext(
  changeId?: string,
  cwd?: string,
): Promise<ResumeContext | null> {
  const { loadStateIndex, listUnfinishedChanges, getChangeLifecycle } =
    await import("pi-zflow-artifacts/state-index")

  const index = await loadStateIndex(cwd)

  // If a changeId is provided, look up its lifecycle record directly.
  if (changeId) {
    const cl = await getChangeLifecycle(changeId, cwd)
    if (!cl || cl.unfinishedRuns.length === 0) return null

    const details = [
      `change ${cl.changeId}: ${cl.lastPhase} (${cl.unfinishedRuns.length} unfinished run(s))`,
      ...cl.unfinishedRuns.map((rid: string) => `  run ${rid}`),
      ...cl.retainedWorktrees.map((wt: string) => `  worktree: ${wt}`),
    ].join("\n")

    return {
      changeId: cl.changeId,
      lastPhase: cl.lastPhase,
      resumeOptions: ["resume", "abandon", "inspect", "cleanup"],
      details,
    }
  }

  // No changeId — find all changes with unfinished runs.
  const unfinished = await listUnfinishedChanges(cwd)
  if (unfinished.length === 0) return null

  // Build a combined resume context from all unfinished changes.
  const details = unfinished.map((cl) =>
    `change ${cl.changeId}: ${cl.lastPhase} (${cl.unfinishedRuns.length} unfinished run(s))`,
  ).join("\n")

  // Return context for the first unfinished change.
  const first = unfinished[0]
  return {
    changeId: first.changeId,
    lastPhase: first.lastPhase,
    resumeOptions: ["resume", "abandon", "inspect", "cleanup"],
    details,
  }
}

/**
 * Resume a specific workflow from a saved state.
 *
 * Reads the run.json and determines what phase to resume. If the apply-back
 * status is unknown, it will attempt to restore the pre-apply snapshot before
 * retrying.
 *
 * @param changeId - Change identifier.
 * @param runId - Run identifier.
 * @param cwd - Working directory (optional).
 * @returns A result indicating whether the workflow can be resumed and what phase.
 */
export async function resumeWorkflow(
  changeId: string,
  runId: string,
  cwd?: string,
): Promise<{
  success: boolean
  message: string
  phase?: string
}> {
  const { readRun } = await import("pi-zflow-artifacts/run-state")

  try {
    const run = await readRun(runId, cwd)

    // Determine what to resume based on phase
    switch (run.phase) {
      case "pending":
      case "executing":
        return {
          success: true,
          message: `Resuming execution for ${changeId}`,
          phase: run.phase,
        }
      case "applying":
        return {
          success: true,
          message: `Resuming apply-back for ${changeId}`,
          phase: run.phase,
        }
      case "drift-pending":
        return {
          success: true,
          message: `Resuming drift resolution for ${changeId}`,
          phase: run.phase,
        }
      default:
        return {
          success: false,
          message: `Cannot resume run in phase "${run.phase}"`,
        }
    }
  } catch (err: unknown) {
    return {
      success: false,
      message: `Failed to read run: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Abandon a workflow and clean up its state.
 *
 * Marks the run as abandoned in the state index so it no longer appears
 * in future resume detection.
 *
 * @param changeId - Change identifier.
 * @param runId - Run identifier.
 * @param cwd - Working directory (optional).
 * @returns A result indicating success or failure.
 */
export async function abandonWorkflow(
  changeId: string,
  runId: string,
  cwd?: string,
): Promise<{ success: boolean; message: string }> {
  const { updateStateIndexEntry } = await import("pi-zflow-artifacts/state-index")

  try {
    // Mark run as abandoned in state index
    await updateStateIndexEntry(runId, {
      status: "abandoned",
      metadata: { reason: "user-abandoned" },
    }, cwd)

    return {
      success: true,
      message: `Workflow ${changeId} / ${runId} abandoned.`,
    }
  } catch (err: unknown) {
    return {
      success: false,
      message: `Failed to abandon: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Build a resume prompt for the user describing the unfinished work.
 *
 * @param context - The resume context from `detectResumeContext`.
 * @returns A markdown string describing the unfinished work and available options.
 */
export function buildResumePrompt(context: ResumeContext): string {
  const lines = [
    "# Unfinished Work Detected",
    "",
    `Change: ${context.changeId}`,
    `Last phase: ${context.lastPhase}`,
    "",
    "## Details",
    context.details,
    "",
    "## Options",
    ...context.resumeOptions.map((o) => `- ${o}`),
    "",
    "What would you like to do?",
  ]

  return lines.join("\n")
}

// ═══════════════════════════════════════════════════════════════════
// Cleanup workflow (Phase 7 — /zflow-clean, TTL-based cleanup)
// ═══════════════════════════════════════════════════════════════════

/**
 * Options for the /zflow-clean workflow.
 */
export interface CleanWorkflowOptions {
  /** Working directory for runtime state dir resolution. */
  cwd?: string
  /** If true, only preview what would be deleted; do not actually remove. */
  dryRun?: boolean
  /** If true, also clean orphaned artifacts not tied to known state-index entries. */
  orphans?: boolean
  /** Override TTL for stale artifacts in days (default: 14). */
  olderThan?: number
}

/**
 * Result of the /zflow-clean workflow.
 */
export interface CleanWorkflowResult {
  /** Whether this was a dry run (no actual deletions). */
  dryRun: boolean
  /** Cleanup candidates that were found (or processed). */
  candidates: Array<{ path: string; description: string }>
  /** Number of artifacts cleaned. */
  cleaned: number
  /** Number of artifacts kept (skipped or errors). */
  kept: number
  /** Error messages from failed cleanup operations. */
  errors: string[]
  /** Human-readable summary of the cleanup operation. */
  summary: string
}

/**
 * Run the /zflow-clean workflow.
 *
 * Scans the runtime state directory for artifacts that exceed TTL
 * policies, optionally cross-references against the state index for
 * orphan detection, and performs cleanup (or dry-run preview).
 *
 * Default retention:
 * - Stale runtime/patch artifacts: 14 days
 * - Failed/interrupted worktrees: 7 days
 * - Successful worktrees: removed immediately after verified apply-back
 *   (not handled here; this is for leftovers)
 *
 * @param options - Cleanup options (dry-run, TTL overrides, orphan detection).
 * @returns The cleanup result with summary.
 */
export async function runCleanWorkflow(
  options: CleanWorkflowOptions = {},
): Promise<CleanWorkflowResult> {
  const { scanForCleanup, cleanupArtifacts, formatCleanupSummary } =
    await import("pi-zflow-artifacts/cleanup-metadata")
  const { resolveRuntimeStateDir } = await import("pi-zflow-core/runtime-paths")

  const runtimeDir = resolveRuntimeStateDir(options.cwd)
  const dryRun = options.dryRun ?? false

  // Scan for cleanup candidates
  const rawCandidates = await scanForCleanup(runtimeDir, {
    staleDays: options.olderThan ?? 14,
    failedWorktreeDays: 7,
  })

  // Filter candidates if orphan-only mode
  const candidates = options.orphans
    ? await filterOrphanCandidates(rawCandidates, options.cwd)
    : rawCandidates

  // Execute cleanup (or dry-run preview)
  const result = await cleanupArtifacts(candidates, { dryRun })
  const summary = formatCleanupSummary(candidates)

  return {
    dryRun,
    candidates: candidates.map((c) => ({
      path: c.path,
      description: c.description,
    })),
    cleaned: result.cleaned,
    kept: result.kept,
    errors: result.errors,
    summary,
  }
}

/**
 * Filter candidates to only those not referenced in the state index.
 *
 * Cross-references candidate paths against known plan/run/review/artifact
 * IDs in the state index. Candidates whose paths do not match any known
 * entry are considered "orphans" and returned.
 *
 * @param candidates - Cleanup candidates from the scanner.
 * @param cwd - Working directory for state index resolution.
 * @returns Candidates that are orphans (not in the state index).
 */
async function filterOrphanCandidates(
  candidates: Awaited<ReturnType<typeof import("pi-zflow-artifacts/cleanup-metadata").scanForCleanup>>,
  cwd?: string,
): Promise<typeof candidates> {
  const { loadStateIndex } = await import("pi-zflow-artifacts/state-index")

  let knownIds: string[] = []
  try {
    const index = await loadStateIndex(cwd)
    knownIds = index.entries.map((e) => e.id)
  } catch {
    // If state index can't be loaded, treat all candidates as orphans
    return candidates
  }

  return candidates.filter((candidate) => {
    // A candidate is an orphan if its path doesn't contain any known ID
    const pathLower = candidate.path.toLowerCase()
    return !knownIds.some((id) => pathLower.includes(id.toLowerCase()))
  })
}

// ═══════════════════════════════════════════════════════════════════
// Phase 7 — /zflow-change-audit and /zflow-change-fix wrappers
// ═══════════════════════════════════════════════════════════════════

/**
 * Options for the change-audit workflow.
 */
export interface AuditWorkflowOptions {
  /** Change identifier to audit. */
  changeId: string
  /** Working directory (optional). */
  cwd?: string
  /** Whether to re-run review if findings already exist. */
  rerunReview?: boolean
}

/**
 * Result of the change-audit workflow.
 */
export interface AuditWorkflowResult {
  /** The audited change identifier. */
  changeId: string
  /** Current plan lifecycle state. */
  status: string
  /** Active plan version. */
  planVersion: string
  /** Verification status string. */
  verificationStatus: string
  /** Path to review findings if available. */
  reviewFindingsPath?: string
  /** Human-readable audit summary. */
  summary: string
  /** Recommended next actions. */
  recommendedActions: string[]
}

/**
 * Run the `/zflow-change-audit <change-path>` workflow.
 *
 * Resolves the approved or completed change context, loads plan state,
 * verification status, and latest review findings, then returns a
 * summarized status with recommended next actions.
 *
 * @param options - Audit workflow options.
 * @returns Audit result with summary and recommended actions.
 */
export async function runChangeAuditWorkflow(
  options: AuditWorkflowOptions,
): Promise<AuditWorkflowResult> {
  const cwd = options.cwd
  const changeId = options.changeId
  const { default: fs } = await import("node:fs/promises")

  // Read plan state
  const planStatePath = resolvePlanStatePath(changeId, cwd)
  let planState: Record<string, unknown>
  try {
    const raw = await fs.readFile(planStatePath, "utf-8")
    planState = JSON.parse(raw)
  } catch {
    throw new Error(`No plan found for change "${changeId}". Run /zflow-change-prepare ${changeId} first.`)
  }

  const planVersion = (planState.approvedVersion ?? planState.currentVersion ?? "v1") as string
  const lifecycleState = (planState.lifecycleState ?? "unknown") as string

  // Determine verification status
  let verificationStatus = "unknown"
  try {
    const versionNum = planVersion.replace(/^v/, "")
    const verificationPath = resolvePlanArtifactPath(changeId, planVersion, "verification", cwd)
    const verContent = await fs.readFile(verificationPath, "utf-8")
    if (verContent.includes("pass") || verContent.includes("PASS")) {
      verificationStatus = "passed"
    } else if (verContent.includes("fail") || verContent.includes("FAIL")) {
      verificationStatus = "failed"
    } else {
      verificationStatus = "unknown"
    }
  } catch {
    // no verification artifact
  }

  // Check for review findings
  const reviewFindingsPath = resolveCodeReviewFindingsPath(cwd)
  let hasReviewFindings = false
  try {
    await fs.access(reviewFindingsPath)
    hasReviewFindings = true
  } catch {
    // no findings file
  }

  // Build recommended actions
  const recommendedActions: string[] = []
  if (lifecycleState === "completed") {
    recommendedActions.push("Change is complete. Review findings and close out.")
  } else if (lifecycleState === "approved") {
    recommendedActions.push(`Run /zflow-change-implement ${changeId} to execute the approved plan.`)
  } else if (lifecycleState === "executing") {
    recommendedActions.push("Implementation is in progress. Wait for completion or check run status.")
  } else if (lifecycleState === "draft" || lifecycleState === "validated") {
    recommendedActions.push("Plan is not yet approved. Review and approve via the planning workflow.")
  } else if (lifecycleState === "drifted") {
    recommendedActions.push("Plan drift detected. Review deviations and create an amendment.")
  } else if (lifecycleState === "cancelled") {
    recommendedActions.push("Plan was cancelled. Start a new planning session if needed.")
  } else if (lifecycleState === "superseded") {
    recommendedActions.push("Plan was superseded by a newer version. Check for v{n+1}.")
  } else {
    recommendedActions.push("Run /zflow-change-prepare to start planning.")
  }

  if (!hasReviewFindings && lifecycleState !== "draft") {
    recommendedActions.push("Run /zflow-review-code to review the implementation.")
  }

  if (verificationStatus === "failed") {
    recommendedActions.push("Verification failed. Run /zflow-change-fix to resolve issues.")
  }

  // Build summary
  const planVersionDir = resolvePlanVersionDir(changeId, planVersion, cwd)
  const summary = [
    `## Audit: ${changeId}`,
    "",
    `**Status:** ${lifecycleState}`,
    `**Plan Version:** ${planVersion}`,
    `**Verification:** ${verificationStatus}`,
    `**Review Findings:** ${hasReviewFindings ? "available" : "none"}`,
    "",
    `Plan artifacts: \`${planVersionDir}\``,
    hasReviewFindings ? `Review findings: \`${reviewFindingsPath}\`` : "",
  ].filter(Boolean).join("\n")

  return {
    changeId,
    status: lifecycleState,
    planVersion,
    verificationStatus,
    reviewFindingsPath: hasReviewFindings ? reviewFindingsPath : undefined,
    summary,
    recommendedActions,
  }
}

/**
 * Options for the change-fix workflow.
 */
export interface FixWorkflowOptions {
  /** Change identifier to fix. */
  changeId: string
  /** Working directory (optional). */
  cwd?: string
  /** Specific finding indices to fix (empty = all). */
  findingIndices?: number[]
  /** Whether to auto-apply fixes without manual review. */
  autoFix?: boolean
}

/**
 * Result of the change-fix workflow.
 */
export interface FixWorkflowResult {
  /** The fixed change identifier. */
  changeId: string
  /** Generated fix plan description. */
  fixPlan: string
  /** Files identified for modification. */
  filesToModify: string[]
  /** Resolved verification command if available. */
  verificationCommand?: string
}

/**
 * Run the `/zflow-change-fix <change-path>` workflow.
 *
 * Loads selected findings or verification failures, builds a focused
 * fix plan, and returns the fix context for dispatch.
 *
 * @param options - Fix workflow options.
 * @returns Fix result with plan and target files.
 */
export async function runChangeFixWorkflow(
  options: FixWorkflowOptions,
): Promise<FixWorkflowResult> {
  const cwd = options.cwd
  const changeId = options.changeId
  const { default: fs } = await import("node:fs/promises")
  const { default: path } = await import("node:path")

  // Read plan state
  const planStatePath = resolvePlanStatePath(changeId, cwd)
  let planState: Record<string, unknown>
  try {
    const raw = await fs.readFile(planStatePath, "utf-8")
    planState = JSON.parse(raw)
  } catch {
    throw new Error(`No plan found for change "${changeId}". Run /zflow-change-prepare ${changeId} first.`)
  }

  const planVersion = (planState.approvedVersion ?? planState.currentVersion ?? "v1") as string
  const lifecycleState = (planState.lifecycleState ?? "unknown") as string

  // Read review findings
  const reviewFindingsPath = resolveCodeReviewFindingsPath(cwd)
  let findingsContent = ""
  let findingsLines: string[] = []
  try {
    findingsContent = await fs.readFile(reviewFindingsPath, "utf-8")
    findingsLines = findingsContent.split("\n").filter(l => l.trim().startsWith("-") || l.trim().startsWith("*"))
  } catch {
    // no findings file
  }

  // Read verification artifact
  let verificationContent = ""
  let verificationCommand: string | undefined
  try {
    const verificationPath = resolvePlanArtifactPath(changeId, planVersion, "verification", cwd)
    verificationContent = await fs.readFile(verificationPath, "utf-8")
    // Extract verification command if present
    const cmdMatch = verificationContent.match(/```(?:bash)?\s*\n([\s\S]*?)```/)
    if (cmdMatch) {
      verificationCommand = cmdMatch[1].trim()
    }
  } catch {
    // no verification artifact
  }

  // Read execution groups to determine files to modify
  const filesToModify: string[] = []
  try {
    const egPath = resolvePlanArtifactPath(changeId, planVersion, "execution-groups", cwd)
    const egContent = await fs.readFile(egPath, "utf-8")
    // Extract file paths from execution groups
    const fileMatches = egContent.matchAll(/[`"']([^`"']*\.[a-zA-Z]+)[`"']/g)
    for (const match of fileMatches) {
      const filePath = match[1]
      if (!filesToModify.includes(filePath)) {
        filesToModify.push(filePath)
      }
    }
  } catch {
    // no execution groups artifact
  }

  // Build fix plan
  const fixPlanLines: string[] = [
    `# Fix Plan for ${changeId}`,
    "",
    `**Plan Version:** ${planVersion}`,
    `**Plan State:** ${lifecycleState}`,
    "",
  ]

  if (findingsLines.length > 0) {
    fixPlanLines.push(
      "## Findings to Address",
      "",
      ...(options.findingIndices && options.findingIndices.length > 0
        ? findingsLines
            .filter((_, i) => options.findingIndices!.includes(i))
            .map(l => `- ${l}`)
        : findingsLines.map(l => `- ${l}`)),
      "",
    )
  } else {
    fixPlanLines.push("## Findings", "No review findings available.", "")
  }

  fixPlanLines.push(
    "## Approach",
    "",
    options.autoFix
      ? "Auto-fix mode: applying targeted fixes based on findings."
      : "Manual review mode: findings loaded for inspection.",
    "",
  )

  if (filesToModify.length > 0) {
    fixPlanLines.push(
      "## Target Files",
      "",
      ...filesToModify.map(f => `- \`${f}\``),
      "",
    )
  }

  if (verificationCommand) {
    fixPlanLines.push(
      "## Verification Command",
      "",
      "```bash",
      verificationCommand,
      "```",
      "",
    )
  }

  const fixPlan = fixPlanLines.join("\n")

  return {
    changeId,
    fixPlan,
    filesToModify,
    verificationCommand,
  }
}

// ── Code review input builder (Task 7.12) ────────────────────────

/**
 * Input shape for code review, matching the CodeReviewInput interface
 * from pi-zflow-review's runCodeReview.
 */
export interface CodeReviewInputContext {
  source: string
  repoPath: string
  branch: string
  planningArtifacts: {
    design: string
    executionGroups: string
    standards: string
    verification: string
  }
  verificationStatus: "passed" | "failed" | "skipped" | "unknown"
  cwd?: string
}

/**
 * Build a code review input from the current implementation context.
 *
 * Resolves the four canonical plan artifact paths for the given change
 * and version, and returns an input object ready to pass to
 * `runCodeReview` from `pi-zflow-review`.
 *
 * @param changeId - The change identifier.
 * @param planVersion - The approved plan version (e.g. "v2").
 * @param repoRoot - Absolute path to the repository root.
 * @param verificationStatus - Current verification status. Defaults to "passed".
 * @param cwd - Working directory for runtime-state resolution (optional).
 * @returns A code review input object.
 */
export function buildCodeReviewInputFromContext(
  changeId: string,
  planVersion: string,
  repoRoot: string,
  verificationStatus: "passed" | "failed" | "skipped" | "unknown" = "passed",
  cwd?: string,
): CodeReviewInputContext {
  return {
    source: `Implementation of ${changeId} ${planVersion}`,
    repoPath: repoRoot,
    branch: getCurrentBranch(repoRoot),
    planningArtifacts: {
      design: resolvePlanArtifactPath(changeId, planVersion, "design", cwd),
      executionGroups: resolvePlanArtifactPath(changeId, planVersion, "execution-groups", cwd),
      standards: resolvePlanArtifactPath(changeId, planVersion, "standards", cwd),
      verification: resolvePlanArtifactPath(changeId, planVersion, "verification", cwd),
    },
    verificationStatus,
    cwd,
  }
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
    // @ts-expect-error - optional dependency, handled via catch
    const intercomModule: { intercom?: Function } | null = await import("pi-intercom").catch(() => null)
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
    /**
     * Explicit run ID override. When provided, skips creating a new run.json
     * and state-index entry (the caller already created them). Useful when
     * the calling workflow (e.g. runChangeImplementWorkflow) has already
     * set up the run with full metadata and `runWorktreeDispatchAndFinalize`
     * only needs preflight validation + task construction.
     */
    runId?: string
    /** Proceed even with uncommitted changes in the primary worktree. */
    force?: boolean
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
  let preflight: GitPreflightResult
  if (options?.force) {
    preflight = { clean: true, trackedChanges: [], untracked: [], overlappingUntracked: [], summary: "Skipped due to --force.", headSha: "", branch: "" }
  } else {
    preflight = assertCleanPrimaryTree(repoRoot, plannedPaths)
    if (!preflight.clean) {
      throw new Error(
        `Worktree implementation preflight failed.\n${preflight.summary}`,
      )
    }
  }

  // 4. Validate ownership and dependencies
  const ownershipValidation = validateOwnershipAndDependencies(groups)
  if (!ownershipValidation.valid) {
    throw new Error(
      `Ownership/dependency validation failed:\n${ownershipValidation.summary}`,
    )
  }

  // 5. Create or reuse run.json
  const runId = options?.runId ?? `impl-${changeId}-${Date.now().toString(36)}`
  let run: RunJson
  if (options?.runId) {
    // Caller already created the run — read back existing metadata.
    // We still need run.json to exist for finalizeWorktreeImplementationRun.
    const existingRun = await readRun(options.runId, cwd).catch(() => null)
    if (!existingRun) {
      throw new Error(
        `Caller provided runId "${options.runId}" but run.json does not exist. ` +
        "The caller must create the run before calling prepareWorktreeImplementationRun " +
        "when passing a specific runId.",
      )
    }
    run = existingRun
  } else {
    run = await createRun(runId, repoRoot, changeId, planVersion, cwd)

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
  }

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

  const dispatchGroups: DispatchExecutionGroup[] = groups.map(g => ({
    id: g.id,
    agent: "zflow.implement-routine",
    files: g.files,
    dependencies: g.dependencies,
    taskPrompt: "",
  }))
  const tasks = buildWorktreeDispatchPlan(dispatchGroups, dispatchConfig, planArtifactPaths)

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
  const applyBackGroups: ExecutionGroup[] = options?.executionGroups && options.executionGroups.length > 0
    ? options.executionGroups.map((g) => ({
        id: g.id,
        files: g.files,
        dependencies: g.dependencies,
        parallelizable: g.parallelizable,
      }))
    : run.groups.map((g) => ({
        id: g.groupId,
        files: g.changedFiles,
        dependencies: [],
        parallelizable: true,
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
  unfinishedRuns: string[]
  unfinishedPlans: string[]
  hasUnfinishedWork: boolean
}> {
  const { getChangeLifecycle } = await import("pi-zflow-artifacts/state-index")

  const cl = await getChangeLifecycle(changeId, cwd)

  if (!cl || cl.unfinishedRuns.length === 0) {
    return {
      unfinishedRuns: [],
      unfinishedPlans: [],
      hasUnfinishedWork: false,
    }
  }

  return {
    unfinishedRuns: cl.unfinishedRuns,
    unfinishedPlans: [],
    hasUnfinishedWork: true,
  }
}

/**
 * Produce a human-readable summary of unfinished work for a change.
 *
 * Lists each unfinished run with its ID, followed by suggested next actions.
 *
 * @param unfinished - The result of `discoverUnfinishedWork()`.
 * @returns A formatted string describing the unfinished work.
 */
export function promptResumeChoices(unfinished: {
  unfinishedRuns: string[]
  unfinishedPlans: string[]
  hasUnfinishedWork: boolean
}): string {
  const lines: string[] = []

  const allUnfinished = [
    ...unfinished.unfinishedPlans.map((id) => ({ _label: "plan", id })),
    ...unfinished.unfinishedRuns.map((id) => ({ _label: "run", id })),
  ]

  if (allUnfinished.length === 0) {
    return "No unfinished work found for this change."
  }

  lines.push("## Unfinished work detected")
  lines.push("")
  lines.push("| Type | ID |")
  lines.push("|------|----|")
  for (const entry of allUnfinished) {
    lines.push(`| ${entry._label} | ${entry.id} |`)
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

/**
 * Structured result returned by `checkUnfinishedOnEntry` when unfinished
 * work exists for a change.
 */
export interface UnfinishedOnEntryResult {
  /** Whether unfinished work was found. */
  hasUnfinishedWork: boolean
  /** The change identifier with unfinished work. */
  changeId: string
  /** Last known phase of the change. */
  lastPhase: string
  /** Unfinished run IDs. */
  unfinishedRunIds: string[]
  /** Retained worktree paths. */
  retainedWorktrees: string[]
  /** Available user-facing choices. */
  choices: Array<{
    action: "resume" | "abandon" | "inspect" | "cleanup"
    description: string
  }>
  /** Human-readable summary for display. */
  summary: string
}

/**
 * Check for unfinished work on entry to a change workflow command.
 *
 * Looks up the change lifecycle in the state-index `changes` map. If
 * unfinished runs exist, returns structured choices with context so
 * the caller can present them to the user via `ui.notify` or similar.
 *
 * @param changeId - The change identifier to check.
 * @param cwd - Working directory (optional).
 * @returns An `UnfinishedOnEntryResult` if unfinished work exists, or a
 *          result with `hasUnfinishedWork: false`.
 */
export async function checkUnfinishedOnEntry(
  changeId: string,
  cwd?: string,
): Promise<UnfinishedOnEntryResult> {
  const { getChangeLifecycle } = await import("pi-zflow-artifacts/state-index")

  const cl = await getChangeLifecycle(changeId, cwd)

  if (!cl || cl.unfinishedRuns.length === 0) {
    return {
      hasUnfinishedWork: false,
      changeId,
      lastPhase: "none",
      unfinishedRunIds: [],
      retainedWorktrees: [],
      choices: [],
      summary: `No unfinished work for change "${changeId}".`,
    }
  }

  const summary = [
    `Change: ${cl.changeId}`,
    `Last phase: ${cl.lastPhase}`,
    `Unfinished runs: ${cl.unfinishedRuns.join(", ") || "(none)"}`,
    cl.retainedWorktrees.length > 0
      ? `Retained worktrees: ${cl.retainedWorktrees.join(", ")}`
      : "",
  ].filter(Boolean).join("\n")

  return {
    hasUnfinishedWork: true,
    changeId: cl.changeId,
    lastPhase: cl.lastPhase,
    unfinishedRunIds: cl.unfinishedRuns,
    retainedWorktrees: cl.retainedWorktrees,
    choices: [
      { action: "resume", description: "Continue the most recent unfinished run" },
      { action: "abandon", description: "Mark unfinished work as cancelled and start fresh" },
      { action: "inspect", description: "Show detailed state of each unfinished item" },
      { action: "cleanup", description: "Remove stale artifacts associated with unfinished work" },
    ],
    summary,
  }
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
 * Bump the plan version for a change.
 *
 * Reads the current plan-state.json, increments the current version
 * (v1 → v2, v2 → v3, etc.), marks the old version as "superseded"
 * in the versions map, creates the new version directory, and returns
 * the new version string.
 *
 * @param changeId - The change identifier.
 * @param cwd - Working directory (optional).
 * @returns The new version string (e.g. "v2").
 * @throws If the plan-state.json does not exist or cannot be parsed.
 */
export async function bumpPlanVersion(
  changeId: string,
  cwd?: string,
): Promise<string> {
  const { default: fs } = await import("node:fs/promises")
  const { default: path } = await import("node:path")
  const planStatePath = resolvePlanStatePath(changeId, cwd)

  // Read current plan state
  const raw = await fs.readFile(planStatePath, "utf-8")
  const planState = JSON.parse(raw) as {
    currentVersion: string
    approvedVersion: string | null
    lifecycleState: string
    updatedAt?: string
    versions: Record<string, { state: string; createdAt?: string }>
  }

  const oldVersion = planState.currentVersion
  const oldVersionNum = parseInt(oldVersion.replace(/^v/, ""), 10)
  const newVersionNum = oldVersionNum + 1
  const newVersion = `v${newVersionNum}`

  // Mark old version as superseded
  if (!planState.versions) {
    planState.versions = {}
  }
  planState.versions[oldVersion] = {
    ...planState.versions[oldVersion],
    state: "superseded",
  }

  // Add new version entry
  const now = new Date().toISOString()
  planState.versions[newVersion] = {
    state: "draft",
    createdAt: now,
  }

  // Update current version and lifecycle state
  planState.currentVersion = newVersion
  planState.lifecycleState = "draft"
  planState.updatedAt = now

  // Write updated plan state
  await fs.writeFile(planStatePath, JSON.stringify(planState, null, 2), "utf-8")

  // Create the new version directory
  const versionDir = resolvePlanVersionDir(changeId, newVersion, cwd)
  await fs.mkdir(versionDir, { recursive: true })

  return newVersion
}

/**
 * Update the state of a specific plan version.
 *
 * Updates the state of a given version in plan-state.json's versions map.
 * Only processes the "versions" sub-map — does not change lifecycleState
 * or currentVersion.
 *
 * Valid states: "draft", "validated", "reviewed", "approved", "superseded"
 *
 * @param changeId - The change identifier.
 * @param version - The version label (e.g. "v1", "v2").
 * @param state - The new state for this version.
 * @param cwd - Working directory (optional).
 * @throws If the plan-state.json does not exist or the version is not found.
 */
export async function markPlanVersionState(
  changeId: string,
  version: string,
  state: "draft" | "validated" | "reviewed" | "approved" | "superseded",
  cwd?: string,
): Promise<void> {
  const { default: fs } = await import("node:fs/promises")
  const planStatePath = resolvePlanStatePath(changeId, cwd)

  // Read current plan state
  const raw = await fs.readFile(planStatePath, "utf-8")
  const planState = JSON.parse(raw) as {
    versions: Record<string, { state: string; createdAt?: string }>
  }

  // Validate version exists
  if (!planState.versions || !planState.versions[version]) {
    throw new Error(
      `Version "${version}" not found in plan-state for change "${changeId}". ` +
      `Available versions: ${Object.keys(planState.versions ?? {}).join(", ")}`,
    )
  }

  // Update the version's state
  planState.versions[version] = {
    ...planState.versions[version],
    state,
  }

  // Write updated plan state
  await fs.writeFile(planStatePath, JSON.stringify(planState, null, 2), "utf-8")
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

// ═══════════════════════════════════════════════════════════════════
// Phase 7.5 — Prepare-workflow lifecycle helpers
// ═══════════════════════════════════════════════════════════════════

/**
 * Advance the plan lifecycle state in plan-state.json and the state index.
 *
 * Valid lifecycle progression:
 *   draft → validated → reviewed → approved → completed
 *
 * @param changeId - The change identifier.
 * @param newState - The target lifecycle state.
 * @param cwd - Working directory (optional).
 */
export async function advancePlanLifecycle(
  changeId: string,
  newState: "draft" | "validated" | "reviewed" | "approved" | "completed",
  cwd?: string,
): Promise<void> {
  await updatePlanState(changeId, { lifecycleState: newState }, cwd)

  // Also update the state-index entry for this plan
  const index = await loadStateIndex(cwd)
  const planEntry = index.entries.find(
    (e) => e.type === "plan" && e.metadata?.changeId === changeId,
  )
  if (planEntry) {
    planEntry.status = newState
    planEntry.updatedAt = new Date().toISOString()
    const { default: fs } = await import("node:fs/promises")
    const { resolveStateIndexPath } = await import("pi-zflow-artifacts/artifact-paths")
    await fs.writeFile(resolveStateIndexPath(cwd), JSON.stringify(index, null, 2), "utf-8")
  }
}

/**
 * Validate the required plan artifacts for a given version.
 *
 * Checks that the four canonical artifacts exist and have no placeholder
 * markers. Returns a pass/fail result with an issues list.
 *
 * @param changeId - The change identifier.
 * @param planVersion - Plan version (e.g. "v1").
 * @param cwd - Working directory (optional).
 * @returns Validation result with pass/fail and issues list.
 */
export async function runPlanValidation(
  changeId: string,
  planVersion: string,
  cwd?: string,
): Promise<{
  pass: boolean
  issues: string[]
}> {
  const { default: fs } = await import("node:fs/promises")
  const { default: path } = await import("node:path")

  const artifacts = {
    "design.md": resolvePlanArtifactPath(changeId, planVersion, "design", cwd),
    "execution-groups.md": resolvePlanArtifactPath(changeId, planVersion, "execution-groups", cwd),
    "standards.md": resolvePlanArtifactPath(changeId, planVersion, "standards", cwd),
    "verification.md": resolvePlanArtifactPath(changeId, planVersion, "verification", cwd),
  }

  const issues: string[] = []

  for (const [name, filePath] of Object.entries(artifacts)) {
    try {
      const content = await fs.readFile(filePath, "utf-8")

      // Check for placeholder markers
      const placeholderPatterns = [
        /\[TODO\]|\[placeholder\]/i,
        /awaiting\s+(scout|repo.mapper|planner)/i,
        /TODO:\s*(write|fill|implement|add)/i,
      ]

      for (const pattern of placeholderPatterns) {
        if (pattern.test(content)) {
          issues.push(`Artifact "${name}" contains placeholder markers (matched: ${pattern.source})`)
        }
      }
    } catch {
      issues.push(`Required artifact "${name}" is missing at: ${filePath}`)
    }
  }

  if (issues.length === 0) {
    return { pass: true, issues: [] }
  }

  return { pass: false, issues }
}

/**
 * Run plan review for a given change and plan version.
 *
 * If pi-zflow-review is available via the registry, delegates to the
 * review capability. Otherwise returns a basic review result.
 *
 * @param changeId - The change identifier.
 * @param planVersion - Plan version (e.g. "v1").
 * @param cwd - Working directory (optional).
 * @returns Review result with pass/fail and review findings path.
 */
export async function runPlanReview(
  changeId: string,
  planVersion: string,
  cwd?: string,
): Promise<{
  pass: boolean
  reviewFindingsPath?: string
  summary: string
}> {
  const registry = getZflowRegistry()
  const reviewService = registry.optional<Record<string, Function>>("review")

  if (reviewService && typeof reviewService.runPlanReview === "function") {
    try {
      const planningArtifacts = {
        design: resolvePlanArtifactPath(changeId, planVersion, "design", cwd),
        executionGroups: resolvePlanArtifactPath(changeId, planVersion, "execution-groups", cwd),
        standards: resolvePlanArtifactPath(changeId, planVersion, "standards", cwd),
        verification: resolvePlanArtifactPath(changeId, planVersion, "verification", cwd),
      }

      const result = await (reviewService.runPlanReview as Function)({
        changeId,
        planVersion,
        executionGroups: [],
        planningArtifacts,
        cwd,
      })

      return {
        pass: (result as any).action === "approve",
        reviewFindingsPath: (result as any).findingsPath,
        summary:
          (result as any).action === "approve"
            ? "Plan review passed."
            : `Plan review: ${(result as any).action}${(result as any).needsZebReason ? ` — ${(result as any).needsZebReason}` : ""}`,
      }
    } catch (err) {
      return {
        pass: false,
        summary: `Plan review via registry failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  // Fallback: basic review result
  const { default: path } = await import("node:path")
  const { resolveReviewDir } = await import("pi-zflow-artifacts/artifact-paths")
  const reviewFindingsPath = path.join(resolveReviewDir(cwd), `plan-review-${changeId}-${planVersion}.md`)
  const summary = "Plan review skipped (no review service available). Review is advisory."

  console.info(`[zflow] ${summary}`)

  return {
    pass: true,
    reviewFindingsPath,
    summary,
  }
}

/**
 * Approve a specific plan version.
 *
 * Sets the approvedVersion in plan-state.json, marks the version state
 * as "approved", advances the lifecycle to "approved", and makes the
 * version immutable by setting a write-once guard.
 *
 * @param changeId - The change identifier.
 * @param version - The plan version to approve (e.g. "v1").
 * @param cwd - Working directory (optional).
 */
export async function approvePlanVersion(
  changeId: string,
  version: string,
  cwd?: string,
): Promise<void> {
  const { default: fs } = await import("node:fs/promises")
  const planStatePath = resolvePlanStatePath(changeId, cwd)
  const raw = await fs.readFile(planStatePath, "utf-8")
  const planState = JSON.parse(raw)

  // Make the version immutable: set approvedVersion, mark version state, advance lifecycle
  planState.approvedVersion = version
  planState.lifecycleState = "approved"
  planState.updatedAt = new Date().toISOString()

  if (planState.versions && planState.versions[version]) {
    planState.versions[version].state = "approved"
    // Set immutable flag — further edits to this version are rejected
    planState.versions[version].immutableAt = planState.updatedAt
  }

  await fs.writeFile(planStatePath, JSON.stringify(planState, null, 2), "utf-8")

  // Also update the state-index
  const index = await loadStateIndex(cwd)
  const planEntry = index.entries.find(
    (e) => e.type === "plan" && e.metadata?.changeId === changeId,
  )
  if (planEntry) {
    planEntry.status = "approved"
    planEntry.updatedAt = planState.updatedAt
    const { resolveStateIndexPath } = await import("pi-zflow-artifacts/artifact-paths")
    await fs.writeFile(resolveStateIndexPath(cwd), JSON.stringify(index, null, 2), "utf-8")
  }
}

/**
 * Build handoff context metadata for session fork from planning to implementation.
 *
 * Returns a structured handoff object with plan artifact paths, version info,
 * and fork metadata that can be serialized into the forked session.
 *
 * @param changeId - The change identifier.
 * @param approvedVersion - The approved plan version.
 * @param cwd - Working directory (optional).
 * @returns Handoff metadata object.
 */
export async function buildHandoffContext(
  changeId: string,
  approvedVersion: string,
  cwd?: string,
): Promise<{
  changeId: string
  approvedVersion: string
  runtimeStateDir: string
  planArtifactPaths: Record<string, string>
  forkedAt: string
}> {
  const { default: path } = await import("node:path")
  const { resolveRuntimeStateDir } = await import("pi-zflow-core/runtime-paths")

  const runtimeStateDir = resolveRuntimeStateDir(cwd)

  const planArtifactPaths = {
    design: resolvePlanArtifactPath(changeId, approvedVersion, "design", cwd),
    executionGroups: resolvePlanArtifactPath(changeId, approvedVersion, "execution-groups", cwd),
    standards: resolvePlanArtifactPath(changeId, approvedVersion, "standards", cwd),
    verification: resolvePlanArtifactPath(changeId, approvedVersion, "verification", cwd),
  }

  return {
    changeId,
    approvedVersion,
    runtimeStateDir,
    planArtifactPaths,
    forkedAt: new Date().toISOString(),
  }
}

// ═══════════════════════════════════════════════════════════════════
// Phase 7 — File-backed prepare-workflow helpers
// ═══════════════════════════════════════════════════════════════════

/**
 * Resolve a profile if the profiles capability is available via the registry.
 *
 * Checks the zflow registry for an optional "profiles" capability. If found
 * and the service provides `ensureResolved`, calls it to ensure a profile is
 * active. Optionally records profile info in plan-state.json if a changeId
 * is provided.
 *
 * @param changeId - Optional change ID to record profile info in plan-state.json.
 * @param cwd - Working directory (optional).
 * @returns A structured result with resolution status and advisory message.
 */
export async function resolveProfileIfAvailable(
  changeId?: string,
  cwd?: string,
): Promise<{
  resolved: boolean
  method: "registry-service" | "not-available"
  advisory: string
}> {
  const registry = getZflowRegistry()

  if (registry.has("profiles")) {
    const profileService = registry.optional<{ ensureResolved?: () => Promise<unknown> }>("profiles")
    if (profileService && typeof profileService.ensureResolved === "function") {
      try {
        await profileService.ensureResolved()

        // Record profile info in plan-state.json if changeId was provided
        if (changeId) {
          try {
            const { default: fs } = await import("node:fs/promises")
            const planStatePath = resolvePlanStatePath(changeId, cwd)
            const raw = await fs.readFile(planStatePath, "utf-8")
            const planState = JSON.parse(raw)
            planState.profile = { resolved: true, method: "registry-service", resolvedAt: new Date().toISOString() }
            planState.updatedAt = new Date().toISOString()
            await fs.writeFile(planStatePath, JSON.stringify(planState, null, 2), "utf-8")
          } catch {
            // Non-critical; skip recording
          }
        }

        return {
          resolved: true,
          method: "registry-service",
          advisory: "Profile resolution completed via registry service.",
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          resolved: false,
          method: "registry-service",
          advisory: `Profile service available but ensureResolved() failed: ${message}. Caller should resolve profile explicitly.`,
        }
      }
    }
  }

  return {
    resolved: false,
    method: "not-available",
    advisory: "No profile service found in registry. Caller should resolve profile explicitly via Profile.ensureResolved().",
  }
}

/**
 * Build a lightweight repo-map.md by inspecting the repository.
 *
 * Uses git and Node.js APIs to produce concrete repo data without
 * dispatching any agents. Writes the result to
 * `<runtime-state-dir>/repo-map.md`.
 *
 * @param cwd - Working directory (optional).
 * @returns An object with the output path and entry count.
 */
export async function buildRepoMap(cwd?: string): Promise<{ path: string; entries: number }> {
  // Check cache freshness first — reuse existing map if repo structure is unchanged
  const { fresh } = await isRepoMapFresh(cwd)
  if (fresh) {
    const cached = await (await import("./repo-map-cache.js")).readRepoMapCache(cwd)
    if (cached) {
      return { path: cached.path, entries: cached.entryCount }
    }
  }

  const { default: fs } = await import("node:fs/promises")
  const { default: path } = await import("node:path")
  const { execFileSync } = await import("node:child_process")
  const { resolveRuntimeStateDir } = await import("pi-zflow-core/runtime-paths")

  const runtimeStateDir = resolveRuntimeStateDir(cwd)
  const outputPath = path.join(runtimeStateDir, "repo-map.md")

  // Resolve repo root
  let repoRoot = ""
  let branch = "unknown"
  let headSha = "unknown"
  let topLevelDirs: string[] = []
  let changedFiles: string[] = []

  try {
    repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
    }).trim()

    branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
    }).trim()

    headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
    }).trim()

    // Top-level listing via git ls-tree (avoids ls dependency)
    const lsTree = execFileSync("git", ["ls-tree", "--name-only", "HEAD"], {
      cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
    }).trim()
    topLevelDirs = lsTree ? lsTree.split("\n").filter(Boolean) : []

    // Changed files
    const statusOutput = execFileSync("git", ["status", "--porcelain"], {
      cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
    }).trim()
    changedFiles = statusOutput ? statusOutput.split("\n").map(l => l.trim()).filter(Boolean) : []
  } catch {
    // Not in a git repo or git unavailable — fall back to filesystem
    repoRoot = cwd ?? process.cwd()
    try {
      const { readdirSync } = await import("node:fs")
      topLevelDirs = readdirSync(repoRoot).filter(e => !e.startsWith("."))
    } catch {
      // Ignore listing failures
    }
  }

  // Detect verification command
  let verificationCommand: string | null = null
  if (repoRoot) {
    verificationCommand = resolveVerificationCommand(repoRoot)
  }

  // Read package/workspace info
  let packageManager = "unknown"
  let workspaces: string[] = []
  if (repoRoot) {
    const pkgJsonPath = path.join(repoRoot, "package.json")
    try {
      const pkgContent = await fs.readFile(pkgJsonPath, "utf-8")
      const pkg = JSON.parse(pkgContent)
      if (pkg.workspaces) {
        workspaces = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces.packages ?? [])
      }
      // Detect package manager from known lockfiles
      if (pkg.packageManager) {
        packageManager = pkg.packageManager
      } else {
        for (const [name, mgr] of [
          ["package-lock.json", "npm"],
          ["yarn.lock", "yarn"],
          ["pnpm-lock.yaml", "pnpm"],
          ["bun.lockb", "bun"],
        ] as const) {
          try {
            await fs.access(path.join(repoRoot, name))
            packageManager = mgr
            break
          } catch { /* not present */ }
        }
      }
    } catch {
      // No package.json — that's fine
    }
  }

  // Collect additional metadata for enriched content
  let entryPoints: string[] = []
  let configFiles: string[] = []
  let keyExports: string[] = []

  if (repoRoot) {
    try {
      const { execFileSync: execSync } = await import("node:child_process")

      // Entry points: common entry file patterns
      const entryPatterns = ["index.ts", "index.js", "main.ts", "main.js", "cli.ts", "cli.js"]
      for (const pattern of entryPatterns) {
        try {
          execSync("git", ["ls-files", `*${pattern}`], {
            cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
          }).trim().split("\n").filter(Boolean).forEach(f => {
            if (!entryPoints.includes(f)) entryPoints.push(f)
          })
        } catch { /* skip */ }
      }

      // Config files
      const configPatterns = ["package.json", "tsconfig.json", ".env*", "Dockerfile*", "docker-compose*", "Makefile", "*.config.ts", "*.config.js", ".gitignore", ".eslintrc*", ".prettierrc*", "jest.config*"]
      for (const pattern of configPatterns) {
        try {
          const matches = execSync("find", [repoRoot, "-maxdepth", "2", "-name", pattern, "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*"], {
            encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
          }).trim().split("\n").filter(Boolean)
          matches.forEach(f => {
            const relative = f.startsWith(repoRoot) ? f.slice(repoRoot.length + 1) : f
            if (!configFiles.includes(relative)) configFiles.push(relative)
          })
        } catch { /* skip */ }
      }

      // Key exports: look for `export` in key index files
      for (const entryFile of entryPoints.slice(0, 5)) {
        try {
          const content = execSync("head", ["-40", path.join(repoRoot, entryFile)], {
            encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
          }).trim()
          const exports = content.split("\n").filter(l => l.includes("export ") && !l.includes("export type"))
            .map(l => l.trim()).slice(0, 10)
          if (exports.length > 0) {
            keyExports.push(`### ${entryFile}`)
            exports.forEach(e => keyExports.push(`- \`${e}\``))
          }
        } catch { /* skip */ }
      }
    } catch { /* tools unavailable */ }
  }

  // Build enriched content — target ~200 lines max
  const lines: string[] = [
    "# Repository Map",
    "",
    `Generated by zflow-change-workflows at ${new Date().toISOString()}.`,
    "",
    "## Repository",
    `- **Root**: ${repoRoot || "(outside git)"}`,
    `- **Branch**: ${branch}`,
    `- **HEAD**: ${headSha}`,
    "",
  ]

  if (workspaces.length > 0) {
    lines.push("## Workspace", "")
    lines.push(`- **Package manager**: ${packageManager}`)
    lines.push(`- **Workspaces**: ${workspaces.join(", ")}`, "")
  }

  // Depth-3 directory tree — in-process bounded traversal (no shell find)
  if (repoRoot) {
    try {
      const MAX_TREE_FILES = 80
      const MAX_DEPTH = 3
      const excludeDirNames = new Set(["node_modules", ".git"])
      const collectedFiles: string[] = []

      const walkDir = async (dir: string, depth: number): Promise<void> => {
        if (depth > MAX_DEPTH || collectedFiles.length >= MAX_TREE_FILES) return
        let entries
        try {
          entries = await fs.readdir(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          if (collectedFiles.length >= MAX_TREE_FILES) break
          const fullPath = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            if (excludeDirNames.has(entry.name)) continue
            await walkDir(fullPath, depth + 1)
          } else if (entry.isFile()) {
            const relative = fullPath.startsWith(repoRoot)
              ? fullPath.slice(repoRoot.length + 1)
              : fullPath
            collectedFiles.push(relative)
          }
        }
      }

      await walkDir(repoRoot, 0)

      if (collectedFiles.length > 0) {
        lines.push("## Directory structure", "")
        // Build a tree-like representation
        const tree = new Map<string, string[]>()
        for (const relative of collectedFiles) {
          const parts = relative.split("/")
          if (parts.length > 1) {
            const dir = parts.slice(0, -1).join("/")
            if (!tree.has(dir)) tree.set(dir, [])
            tree.get(dir)!.push(parts[parts.length - 1])
          }
        }
        for (const [dir, entries] of [...tree.entries()].slice(0, 30)) {
          lines.push(`- \`${dir}/\``)
          for (const entry of entries.slice(0, 5)) {
            lines.push(`  - ${entry}`)
          }
          if (entries.length > 5) lines.push(`  - ... (${entries.length - 5} more)`)
        }
        lines.push("")
      }
    } catch { /* skip */ }
  }

  // Entry points and config files
  if (entryPoints.length > 0) {
    lines.push("## Entry points", "")
    for (const ep of entryPoints.slice(0, 15)) {
      lines.push(`- \`${ep}\``)
    }
    lines.push("")
  }

  if (configFiles.length > 0) {
    lines.push("## Config files", "")
    for (const cf of configFiles.slice(0, 15)) {
      lines.push(`- \`${cf}\``)
    }
    lines.push("")
  }

  // Key module exports
  if (keyExports.length > 0) {
    lines.push("## Key exports", "")
    lines.push(...keyExports)
    lines.push("")
  }

  if (changedFiles.length > 0) {
    lines.push("## Changed files", "")
    for (const file of changedFiles.slice(0, 20)) {
      lines.push(`- \`${file}\``)
    }
    if (changedFiles.length > 20) {
      lines.push(`- ... and ${changedFiles.length - 20} more`)
    }
    lines.push("")
  } else {
    lines.push("## Changed files", "", "(none)", "")
  }

  if (verificationCommand) {
    lines.push("## Verification", "")
    lines.push(`- **Detected command**: \`${verificationCommand}\``, "")
  }

  // Ensure content doesn't exceed ~250 lines
  let content = lines.join("\n")
  const contentLines = content.split("\n")
  if (contentLines.length > 250) {
    content = contentLines.slice(0, 245).join("\n") + "\n\n_(content truncated at 250 lines)_\n"
  }

  await fs.mkdir(runtimeStateDir, { recursive: true })
  await fs.writeFile(outputPath, content, "utf-8")

  // Cache the new repo-map for future freshness checks
  const hash = computeRepoStructureHash(cwd)
  await writeRepoMapCache({
    hash,
    generatedAt: new Date().toISOString(),
    entryCount: topLevelDirs.length,
    path: outputPath,
  }, cwd)

  return { path: outputPath, entries: topLevelDirs.length }
}

/**
 * Build reconnaissance.md with concrete source context.
 *
 * Inspects the provided change path (if any), nearby files, README,
 * package info, and recent failure-log entries. Writes the result
 * to `<runtime-state-dir>/reconnaissance.md`.
 *
 * @param cwd - Working directory (optional).
 * @param changePath - Optional change path to inspect.
 * @returns An object with the output path.
 */
export async function buildReconnaissance(
  cwd?: string,
  changePath?: string,
): Promise<{ path: string }> {
  const { default: fs } = await import("node:fs/promises")
  const { default: pathModule } = await import("node:path")
  const { resolveRuntimeStateDir } = await import("pi-zflow-core/runtime-paths")
  const { isReconFresh, writeReconCache, computeRepoStructureHash: reconHash } =
    await import("./recon-cache.js")

  const runtimeStateDir = resolveRuntimeStateDir(cwd)
  const outputPath = pathModule.join(runtimeStateDir, "reconnaissance.md")

  // Check cache freshness — skip regeneration if still fresh
  const { fresh } = await isReconFresh(changePath, cwd)
  if (fresh) {
    return { path: outputPath }
  }

  // Resolve repo root for git-based context
  let repoRoot = ""
  try {
    const { execFileSync } = await import("node:child_process")
    repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  } catch {
    repoRoot = cwd ?? process.cwd()
  }

  const lines: string[] = [
    "# Reconnaissance",
    "",
    `Generated by zflow-change-workflows at ${new Date().toISOString()}.`,
    "",
    "## Scope",
  ]

  // Change path analysis
  if (changePath) {
    lines.push(`- **Change path**: ${changePath}`)
    const resolvedPath = pathModule.isAbsolute(changePath)
      ? changePath
      : pathModule.join(repoRoot, changePath)
    let pathExists = false
    try {
      await fs.access(resolvedPath)
      pathExists = true
    } catch { /* does not exist */ }
    lines.push(`- **Path exists**: ${pathExists}`)
    if (pathExists) {
      try {
        const stat = await fs.stat(resolvedPath)
        lines.push(`- **Type**: ${stat.isDirectory() ? "directory" : "file"}`)
      } catch { /* stat failed */ }
    }
    lines.push("")

    // Nearby files — list directory contents if changePath is a directory
    if (pathExists) {
      try {
        const stat = await fs.stat(resolvedPath)
        if (stat.isDirectory()) {
          const entries = await fs.readdir(resolvedPath)
          if (entries.length > 0) {
            lines.push("## Nearby files", "")
            for (const entry of entries.slice(0, 30)) {
              lines.push(`- ${entry}`)
            }
            if (entries.length > 30) {
              lines.push(`- ... and ${entries.length - 30} more`)
            }
            lines.push("")
          }
        }
      } catch { /* readdir failed */ }
    }
  } else {
    lines.push("- **Change path**: (auto-generated)", "")
  }

  // README excerpt
  if (repoRoot) {
    const readmePath = pathModule.join(repoRoot, "README.md")
    try {
      const readmeContent = await fs.readFile(readmePath, "utf-8")
      lines.push("## README", "")
      const readmeLines = readmeContent.split("\n").filter(l => l.trim()).slice(0, 5)
      for (const rl of readmeLines) {
        lines.push(`> ${rl}`)
      }
      lines.push("")
    } catch {
      // No README — skip
    }

    // Package info
    const pkgJsonPath = pathModule.join(repoRoot, "package.json")
    try {
      const pkgContent = await fs.readFile(pkgJsonPath, "utf-8")
      const pkg = JSON.parse(pkgContent)
      lines.push("## Package info", "")
      lines.push(`- **Name**: ${pkg.name ?? "unknown"}`)
      if (pkg.version) lines.push(`- **Version**: ${pkg.version}`)
      if (pkg.scripts) {
        const scripts = Object.keys(pkg.scripts)
        lines.push(`- **Scripts**: ${scripts.join(", ")}`)
      }
      if (pkg.dependencies) {
        lines.push(`- **Dependencies**: ${Object.keys(pkg.dependencies).length}`)
      }
      if (pkg.devDependencies) {
        lines.push(`- **Dev dependencies**: ${Object.keys(pkg.devDependencies).length}`)
      }
      lines.push("")
    } catch {
      // No package.json — fine
    }
  }

  // Recent failure-log entries — relevance-based, not just first N
  try {
    const { loadRecentFailureLogEntries, formatFailureLogReadback } =
      await import(
        "../../src/failure-log-helpers.js"
      )

    // Use change path as search context; fall back to generic planning context
    const searchContext = changePath
      ? `planning implementation for ${pathModule.basename(changePath)}`
      : "codebase exploration and planning"

    const relevantEntries = await loadRecentFailureLogEntries({
      context: searchContext,
      limit: 3,
      maxAge: 30,
      cwd,
    })

    if (relevantEntries.length > 0) {
      lines.push("## Recent failure-log entries", "")
      lines.push(formatFailureLogReadback(relevantEntries))
      lines.push("")
    }
  } catch {
    // Failure log unavailable — skip
  }

  const content = lines.join("\n")

  await fs.mkdir(runtimeStateDir, { recursive: true })
  await fs.writeFile(outputPath, content, "utf-8")

  // Cache the new reconnaissance for future freshness checks
  await writeReconCache({
    hash: reconHash(cwd),
    generatedAt: new Date().toISOString(),
    changePath: changePath ?? null,
    path: outputPath,
  }, cwd)

  return { path: outputPath }
}

// ── Compaction reanchor helpers ───────────────────────────────────

/**
 * Resolve canonical artifact paths for post-compaction rereading.
 *
 * Returns a record of well-known artifact identifiers mapped to their
 * resolved absolute file paths in the runtime state directory.
 * Callers use these to inject into agent context after compaction.
 *
 * @param options - Optional change ID/cwd pair. For backwards compatibility,
 *   a single string argument is treated as `cwd`; pass `{ changeId, cwd }` or
 *   `(changeId, cwd)` to include plan-state.
 * @param cwd - Working directory when passing `changeId` as the first argument.
 * @returns Record of artifact ID → absolute path.
 */
export async function buildCompactionReanchorArtifacts(
  options?: { changeId?: string; cwd?: string } | string,
  cwd?: string,
): Promise<Record<string, string>> {
  const { resolveRuntimeStateDir } = await import("pi-zflow-core/runtime-paths")
  const { default: pathModule } = await import("node:path")
  const { default: fs } = await import("node:fs/promises")

  const changeId = typeof options === "object" ? options.changeId : cwd ? options : undefined
  const resolvedCwd = typeof options === "object" ? options.cwd : cwd ?? options
  const runtimeStateDir = resolveRuntimeStateDir(resolvedCwd)
  const paths: Record<string, string> = {}

  // Well-known artifacts that exist if generated
  const wellKnown: Record<string, string> = {
    "repo-map": "repo-map.md",
    "reconnaissance": "reconnaissance.md",
    "failure-log": "failure-log.md",
    "findings": "findings.md",
    "workflow-state": "workflow-state.json",
  }

  for (const [id, relativePath] of Object.entries(wellKnown)) {
    const absPath = pathModule.join(runtimeStateDir, relativePath)
    try {
      await fs.access(absPath)
      paths[id] = absPath
    } catch {
      // Artifact not yet generated — skip
    }
  }

  // Plan-state resolves via artifact-paths only when changeId is provided
  if (changeId) {
    try {
      const { resolvePlanStatePath } = await import("pi-zflow-artifacts/artifact-paths")
      const planPath = resolvePlanStatePath(changeId, resolvedCwd)
      try {
        await fs.access(planPath)
        paths["plan-state"] = planPath
      } catch { /* not created yet */ }
    } catch {
      // pi-zflow-artifacts not available — skip plan-state
    }
  }

  return paths
}

/**
 * Merge compaction-handoff metadata into existing agent launch options.
 *
 * Adds the `"compaction-handoff"` reminder ID and canonical artifact paths
 * to an existing options object without dropping existing entries.
 * This is designed to be called after compaction/resume before building a
 * subagent launch plan.
 *
 * @param options - Existing launch options (optional).
 * @returns A new options object with compaction-handoff merged in.
 */
export function withCompactionHandoff(
  options?: {
    activeReminders?: string[]
    artifactPaths?: Record<string, string>
  },
): {
  activeReminders: string[]
  artifactPaths?: Record<string, string>
} {
  const base = options?.activeReminders ?? []

  // Add compaction-handoff if not already present
  const activeReminders = base.includes("compaction-handoff")
    ? base
    : [...base, "compaction-handoff"]

  // Preserve existing artifact paths (caller should merge via
  // buildCompactionReanchorArtifacts separately if desired)
  const artifactPaths = options?.artifactPaths

  return { activeReminders, artifactPaths }
}

// ═══════════════════════════════════════════════════════════════════
// Phase 7 — Optional registry-backed agent dispatch for prepare
// ═══════════════════════════════════════════════════════════════════

/**
 * Result of attempting to dispatch prepare-phase agents via the registry.
 */
export interface PrepareAgentDispatchResult {
  /** Whether any agent dispatch was attempted and completed. */
  dispatched: boolean
  /**
   * Status of the dispatch attempt:
   * - "unavailable": no registry service exposes compatible dispatch methods
   * - "dispatched": service called successfully, outputs may exist
   * - "failed": service was called but threw an error
   */
  agentDispatchStatus: "unavailable" | "dispatched" | "failed"
  /** Name of the capability/service used, if any. */
  serviceName?: string
  /** Method used for dispatch, if any. */
  methodUsed?: string
  /** Absolute paths to any output files produced by agent dispatch. */
  producedOutputs: string[]
  /** Error message if dispatch failed. */
  error?: string
}

/**
 * Run prepare-phase agents via the registry if available.
 *
 * Checks the shared capability registry for any registered service that
 * exposes agent-dispatch methods (`runAgent`, `runChain`, `dispatch`,
 * `subagent`). Designed for optional integration — if no service exists,
 * the prepare workflow still succeeds with an explicit
 * `agentDispatchStatus: "unavailable"` recorded in plan-state.
 *
 * If a compatible service is found, calls through it defensively
 * (try/catch) and persists any outputs to repo-map, reconnaissance, and
 * plan artifact paths. If the service exists but exposes none of the
 * known dispatch method names, no dispatch is attempted.
 *
 * @param changeId - The change identifier.
 * @param planVersion - The plan version label (e.g. "v1").
 * @param cwd - Working directory (optional).
 * @returns A structured result describing the dispatch outcome.
 */
export async function runPrepareAgentsIfAvailable(
  changeId: string,
  planVersion: string,
  cwd?: string,
): Promise<PrepareAgentDispatchResult> {
  const registry = getZflowRegistry()
  const { default: fs } = await import("node:fs/promises")
  const { default: pathModule } = await import("node:path")
  const { resolveRuntimeStateDir } = await import("pi-zflow-core/runtime-paths")

  // Known dispatch method names across agent/subagent/orchestration services
  const DISPATCH_METHOD_NAMES = new Set(["runAgent", "runChain", "dispatch", "subagent"])

  // Check all registered capabilities for a service exposing dispatch methods
  const capabilities = registry.getCapabilities()
  let dispatchService: { name: string; service: unknown; method: string } | null = null

  for (const [capName, registered] of capabilities) {
    if (registered.service === undefined) continue
    const svc = registered.service as Record<string, unknown>
    for (const methodName of DISPATCH_METHOD_NAMES) {
      if (typeof svc[methodName] === "function") {
        dispatchService = { name: capName, service: svc, method: methodName }
        break
      }
    }
    if (dispatchService) break
  }

  if (!dispatchService) {
    // Record unavailable status in plan-state runtimeMetadata
    try {
      const planStatePath = resolvePlanStatePath(changeId, cwd)
      const raw = await fs.readFile(planStatePath, "utf-8")
      const planState = JSON.parse(raw)
      planState.runtimeMetadata = {
        ...(planState.runtimeMetadata ?? {}),
        agentDispatchStatus: "unavailable",
        agentCheckedAt: new Date().toISOString(),
      }
      planState.updatedAt = new Date().toISOString()
      await fs.writeFile(planStatePath, JSON.stringify(planState, null, 2), "utf-8")
    } catch {
      // Non-critical; skip recording
    }

    return {
      dispatched: false,
      agentDispatchStatus: "unavailable",
      producedOutputs: [],
    }
  }

  // A compatible dispatch service exists — call through it defensively
  const runtimeStateDir = resolveRuntimeStateDir(cwd)
  const versionDir = resolvePlanVersionDir(changeId, planVersion, cwd)
  const outputs: string[] = []

  try {
    const dispatchFn = (dispatchService.service as Record<string, unknown>)[
      dispatchService.method
    ] as (...args: unknown[]) => Promise<unknown>

    // Build a context payload with paths the service can use to write outputs
    const dispatchContext = {
      changeId,
      planVersion,
      cwd: cwd ?? process.cwd(),
      artifactPaths: {
        repoMap: pathModule.join(runtimeStateDir, "repo-map.md"),
        reconnaissance: pathModule.join(runtimeStateDir, "reconnaissance.md"),
        design: pathModule.join(versionDir, "design.md"),
        executionGroups: pathModule.join(versionDir, "execution-groups.md"),
        standards: pathModule.join(versionDir, "standards.md"),
        verification: pathModule.join(versionDir, "verification.md"),
      },
    }

    await dispatchFn(dispatchContext)

    // Collect any files the service wrote
    for (const artifactPath of Object.values(dispatchContext.artifactPaths)) {
      try {
        await fs.access(artifactPath)
        outputs.push(artifactPath)
      } catch {
        // Not written — that's fine
      }
    }

    // Record success in plan-state runtimeMetadata
    try {
      const planStatePath = resolvePlanStatePath(changeId, cwd)
      const raw = await fs.readFile(planStatePath, "utf-8")
      const planState = JSON.parse(raw)
      planState.runtimeMetadata = {
        ...(planState.runtimeMetadata ?? {}),
        agentDispatchStatus: "dispatched",
        agentDispatchService: dispatchService.name,
        agentDispatchMethod: dispatchService.method,
        agentDispatchedAt: new Date().toISOString(),
      }
      planState.updatedAt = new Date().toISOString()
      await fs.writeFile(planStatePath, JSON.stringify(planState, null, 2), "utf-8")
    } catch {
      // Non-critical
    }

    return {
      dispatched: true,
      agentDispatchStatus: "dispatched",
      serviceName: dispatchService.name,
      methodUsed: dispatchService.method,
      producedOutputs: outputs,
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)

    // Record failure in plan-state runtimeMetadata
    try {
      const planStatePath = resolvePlanStatePath(changeId, cwd)
      const raw = await fs.readFile(planStatePath, "utf-8")
      const planState = JSON.parse(raw)
      planState.runtimeMetadata = {
        ...(planState.runtimeMetadata ?? {}),
        agentDispatchStatus: "failed",
        agentDispatchService: dispatchService.name,
        agentDispatchMethod: dispatchService.method,
        agentDispatchError: errorMessage,
      }
      planState.updatedAt = new Date().toISOString()
      await fs.writeFile(planStatePath, JSON.stringify(planState, null, 2), "utf-8")
    } catch {
      // Non-critical
    }

    return {
      dispatched: false,
      agentDispatchStatus: "failed",
      serviceName: dispatchService.name,
      methodUsed: dispatchService.method,
      producedOutputs: outputs,
      error: errorMessage,
    }
  }
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
 * 7. Resolves profile via registry if available (`resolveProfileIfAvailable`).
 * 8. Detects RuneContext if changePath looks like a RuneContext path.
 * 9. Writes concrete repo-map.md (`buildRepoMap`) and reconnaissance.md
 *    (`buildReconnaissance`) with real repository data.
 * 10. Attempts optional agent dispatch via registry (`runPrepareAgentsIfAvailable`).
 * 11. Returns an initial workflow execution plan structure for the caller
 *    to populate with resolved profile steps.
 *
 * The caller (the extension command handler) is responsible for:
 * - Resolving the active profile (`Profile.ensureResolved()`)
 * - Calling `buildWorkflowExecutionPlan("prepare", ...)` with the resolved profile
 * - Dispatching agents via pi-subagents
 * - Calling `advancePlanLifecycle()` to advance lifecycle state after each phase
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
  const { resolveRuntimeStateDir } = await import("pi-zflow-core/runtime-paths")

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
  const initialPlanState: {
    changeId: string
    currentVersion: string
    approvedVersion: string | null
    lifecycleState: string
    runeContext: { enabled: boolean; changePath: string | null }
    versions: Record<string, { state: string; createdAt: string }>
    createdAt: string
    updatedAt: string
    runtimeStateDir?: string
    runtimeMetadata?: { repoMapPath: string; reconnaissancePath: string }
  } = {
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

  // ── Step 7: Resolve profile via registry if available ─────────
  const profileResult = await resolveProfileIfAvailable(changeId, cwd)
  console.info(`[zflow] ${profileResult.advisory}`)

  // ── Step 8: Detect RuneContext ─────────────────────────────────
  // If changePath looks like a RuneContext path (contains @ or /context/),
  // try to detect RuneContext via the pi-zflow-runecontext capability.
  // When RuneContext is detected, canonical RuneContext docs become the
  // requirements source and the plan-state is flagged accordingly.
  const registry = getZflowRegistry()
  const changePath = options.changePath ?? ""
  let runeContextDetected = false
  let runeContextCanonical = false
  let runeContextDocsList: string[] = []
  if (changePath.includes("@") || changePath.includes("/context/")) {
    console.info(`[zflow] Change path "${changePath}" looks like a RuneContext path — attempting detection.`)
    if (registry.has("runecontext")) {
      try {
        const runeContextService = registry.get<{
          detect?: (path: string) => Promise<{ detected?: boolean; repoRoot?: string; flavor?: string; status?: string }>
          resolveChange?: (input: { repoRoot: string; changePath?: string }) => Promise<{ changePath: string; changeId: string; flavor: string; files: Record<string, string> }>
          readDocs?: (change: unknown) => Promise<Record<string, string>>
        }>("runecontext")
        if (runeContextService && typeof runeContextService.detect === "function") {
          const detected = await runeContextService.detect(changePath)
          console.info(`[zflow] RuneContext detected: ${JSON.stringify(detected)}`)

          if (detected && detected.detected) {
            runeContextDetected = true

            // Resolve the change path to discover canonical RuneContext document locations
            if (runeContextService.resolveChange && detected.repoRoot) {
              try {
                const resolved = await runeContextService.resolveChange({
                  repoRoot: detected.repoRoot,
                  changePath,
                })
                if (resolved && resolved.files) {
                  runeContextCanonical = true
                  runeContextDocsList = Object.keys(resolved.files)

                  // ── Populate zflow artifacts from RuneContext canonical docs ──
                  // When readDocs is available, read them and map to zflow artifacts.
                  if (runeContextService.readDocs) {
                    try {
                      const runeDocs = await runeContextService.readDocs(resolved)

                      // design.md ← canonical proposal + design docs
                      await fs.writeFile(
                        artifactPaths.design,
                        [
                          "# RuneContext Design",
                          "",
                          "## Proposal",
                          "",
                          runeDocs.proposal,
                          "",
                          "## Design",
                          "",
                          runeDocs.design,
                        ].join("\n"),
                        "utf-8",
                      )
                      console.info("[zflow] Populated design.md from RuneContext proposal/design docs")

                      // standards.md ← RuneContext standards.md
                      await fs.writeFile(artifactPaths.standards, runeDocs.standards, "utf-8")
                      console.info("[zflow] Populated standards.md from RuneContext standards.md")

                      // verification.md ← verification + references/status metadata
                      await fs.writeFile(
                        artifactPaths.verification,
                        [
                          "# RuneContext Verification",
                          "",
                          runeDocs.verification,
                          runeDocs.references ? ["", "## References", "", runeDocs.references].join("\n") : "",
                          "",
                          "## Status",
                          "",
                          "```json",
                          JSON.stringify(runeDocs.status, null, 2),
                          "```",
                        ].filter(Boolean).join("\n"),
                        "utf-8",
                      )
                      console.info("[zflow] Populated verification.md from RuneContext verification/references/status docs")

                      // execution-groups.md ← derived from tasks.md or proposal+design+verification
                      try {
                        const { deriveExecutionGroupsFromRuneDocs } = await import("pi-zflow-runecontext")
                        const derived = deriveExecutionGroupsFromRuneDocs(runeDocs)
                        const lines = [
                          "# Execution Groups",
                          "",
                          `> Derived from RuneContext canonical source: ${derived.sourceDocument}.`,
                          "> Review and replace `TBD` file lists before implementation dispatch.",
                          "",
                        ]
                        for (let i = 0; i < derived.groups.length; i++) {
                          const group = derived.groups[i]!
                          const verification = group.tasks
                            .map((task) => task.verification)
                            .filter((value): value is string => Boolean(value))
                            .join("; ")
                          lines.push(
                            `## Group ${i + 1}: ${group.name}`,
                            "",
                            `- **Files:** TBD`,
                            `- **Agent:** zflow.implement-routine`,
                            `- **Verification:** ${verification || "TBD — derive scoped verification from RuneContext criteria"}`,
                            `- **Parallelizable:** true`,
                            `- **Canonical source:** ${derived.sourceDocument}`,
                            "",
                            group.description,
                            "",
                          )
                        }
                        await fs.writeFile(artifactPaths.executionGroups, lines.join("\n"), "utf-8")
                        console.info("[zflow] Populated execution-groups.md via deriveExecutionGroupsFromRuneDocs()")
                      } catch {
                        const basic = [
                          `# Execution Groups`,
                          ``,
                          `> Derived from RuneContext canonical docs.`,
                          `> Manual grouping is required before implementation dispatch.`,
                          ``,
                          `## Group 1: RuneContext implementation`,
                          ``,
                          `- **Files:** TBD`,
                          `- **Agent:** zflow.implement-routine`,
                          `- **Verification:** TBD`,
                          `- **Canonical source:** ${runeDocs.tasks ? "tasks.md" : "proposal+design+verification"}`,
                        ].join("\n")
                        await fs.writeFile(artifactPaths.executionGroups, basic, "utf-8")
                        console.info("[zflow] Wrote basic execution-groups.md from RuneContext docs")
                      }
                    } catch {
                      console.warn("[zflow] Could not populate artifacts from RuneContext docs")
                    }
                  } else {
                    console.info("[zflow] RuneContext readDocs not available — artifacts remain empty")
                  }
                }

                console.info(`[zflow] RuneContext resolved: changeId=${resolved.changeId}, flavor=${resolved.flavor}, docs=${runeContextDocsList.join(", ") || "none"}`)
              } catch {
                console.warn("[zflow] RuneContext resolveChange failed — proceeding without canonical doc resolution.")
              }
            }
          }
        }
      } catch {
        console.warn("[zflow] RuneContext service available but detection failed.")
      }
    } else {
      console.info("[zflow] No RuneContext service found in registry. Detection is caller's responsibility.")
    }
  }

  // Persist RuneContext canonical flag in plan-state.json so downstream
  // consumers (review, implement, audit) know to treat RuneContext docs
  // as the requirements source.
  if (runeContextCanonical) {
    try {
      const raw = await fs.readFile(planStatePath, "utf-8")
      const planState = JSON.parse(raw)
      planState.runeContext = {
        ...planState.runeContext,
        canonical: true,
        canonicalDocs: runeContextDocsList,
        detectedAt: new Date().toISOString(),
      }
      planState.updatedAt = new Date().toISOString()
      await fs.writeFile(planStatePath, JSON.stringify(planState, null, 2), "utf-8")
      // Also update the in-memory object returned to the caller
      initialPlanState.runeContext = planState.runeContext
    } catch {
      console.warn("[zflow] Could not persist RuneContext canonical flag in plan-state.json.")
    }
  }

  // ── Step 9: Write concrete repo-map.md and reconnaissance.md ──
  const repoMapResult = await buildRepoMap(cwd)
  const reconResult = await buildReconnaissance(cwd, options.changePath)

  // Record runtime state dir and artifact paths in returned metadata
  initialPlanState.runtimeStateDir = resolveRuntimeStateDir(cwd)
  initialPlanState.runtimeMetadata = {
    repoMapPath: repoMapResult.path,
    reconnaissancePath: reconResult.path,
  }

  // ── Step 10: Attempt optional agent dispatch via registry ───────
  const agentDispatchResult = await runPrepareAgentsIfAvailable(changeId, "v1", cwd)
  if (agentDispatchResult.dispatched) {
    console.info(
      `[zflow] Agent dispatch completed via ${agentDispatchResult.serviceName}.` +
      `${agentDispatchResult.methodUsed} (${agentDispatchResult.producedOutputs.length} outputs).`,
    )
  } else if (agentDispatchResult.agentDispatchStatus === "unavailable") {
    console.info("[zflow] No agent dispatch service available — proceeding without agent dispatch.")
  } else {
    console.warn(`[zflow] Agent dispatch failed: ${agentDispatchResult.error}`)
  }

  return {
    changeId,
    planVersion: "v1",
    stateDir: path.dirname(planStatePath),
    planStatePath,
    artifactPaths,
    initialPlanState,
  }
}

// ═══════════════════════════════════════════════════════════════════
// Phase 7 — Structured approval/revision/cancel interview gates
// ═══════════════════════════════════════════════════════════════════

/**
 * Build a JSON interview questions payload for plan approval.
 *
 * Presents the user with three structured choices (approve, request revisions,
 * cancel) for a plan version. The caller passes the returned JSON string to
 * `pi.interview()` or `ctx.interview()` to get a structured user decision.
 *
 * @param changeId - Change identifier.
 * @param version - Plan version label (e.g. "v2").
 * @param summary - Short human-readable summary of what this plan does.
 * @returns A JSON string suitable for the interview tool.
 */
export function buildPlanApprovalQuestions(
  changeId: string,
  version: string,
  summary: string,
): string {
  return JSON.stringify({
    title: `Plan Review: ${changeId} ${version}`,
    description: `Review plan version ${version} for change "${changeId}".\n\n${summary}`,
    questions: [
      {
        id: "decision",
        type: "single",
        question: "How would you like to proceed with this plan?",
        options: [
          {
            label: "Approve",
            content: "Plan looks good. Approve and proceed to implementation.",
          },
          {
            label: "Request Revisions",
            content: "Plan needs changes. Create a new version with revisions.",
          },
          {
            label: "Cancel",
            content: "Cancel this planning session. No changes will be made.",
          },
        ],
        recommended: "Approve",
      },
      {
        id: "revisionNotes",
        type: "text",
        question: "If requesting revisions, describe what needs to change:",
      },
    ],
  })
}

/**
 * Build a JSON interview questions payload for implementation/review gates.
 *
 * Provides context-appropriate structured choices for drift detection,
 * verification failure, and review findings gates.
 *
 * @param changeId - Change identifier.
 * @param gateType - Which gate triggered the decision point.
 * @param context - Human-readable context describing the current state.
 * @returns A JSON string suitable for the interview tool.
 */
export function buildImplementationGateQuestions(
  changeId: string,
  gateType: "drift" | "verification-failure" | "review-findings",
  context: string,
): string {
  const gateTitles: Record<string, string> = {
    drift: "Plan Drift Detected",
    "verification-failure": "Verification Failed",
    "review-findings": "Review Findings",
  }

  const gateOptions: Record<string, Array<{ label: string; content: string }>> = {
    drift: [
      { label: "Approve Amendment", content: "Approve the plan amendment and continue." },
      { label: "Cancel", content: "Cancel the workflow." },
      { label: "Inspect Artifacts", content: "Review retained artifacts before deciding." },
    ],
    "verification-failure": [
      { label: "Auto-fix Loop", content: "Run automated fix attempts (max 3 iterations, ~15 min cap)." },
      { label: "Manual Review", content: "Stop for manual investigation." },
      { label: "Skip Verification", content: "Skip verification — review will be advisory." },
    ],
    "review-findings": [
      { label: "Fix All", content: "Fix all findings." },
      { label: "Fix Critical/Major", content: "Fix critical and major findings only." },
      { label: "Dismiss", content: "Dismiss findings and proceed." },
    ],
  }

  return JSON.stringify({
    title: gateTitles[gateType] ?? "Decision Required",
    description: `Change: ${changeId}\n\n${context}`,
    questions: [
      {
        id: "action",
        type: "single",
        question: "How would you like to proceed?",
        options: gateOptions[gateType] ?? [
          { label: "Continue", content: "Proceed with the workflow." },
          { label: "Cancel", content: "Cancel the workflow." },
        ],
      },
    ],
  })
}

/**
 * Parse a structured interview response into a simple decision object.
 *
 * Handles both plan-approval format (field name `decision`) and gate
 * format (field name `action`). Returns a default of `"cancel"` if
 * parsing fails.
 *
 * @param response - The raw response string from the interview tool.
 * @returns An object with the decision and optional revision notes.
 */
export function parseInterviewResponse(
  response: string,
): { decision: string; revisionNotes?: string } {
  try {
    const parsed = JSON.parse(response)
    return {
      decision: parsed.decision ?? parsed.action ?? "cancel",
      revisionNotes: parsed.revisionNotes,
    }
  } catch {
    return { decision: "cancel" }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Phase 7 — Implementation session fork handoff
// ═══════════════════════════════════════════════════════════════════

/**
 * Handoff metadata for an implementation session.
 *
 * Stored in the plan-state.json or as a session metadata entry to
 * preserve the approved plan pointer across session boundaries.
 * This is intentionally separate from git branching — the handoff
 * is a Pi session fork, not a branch creation.
 */
export interface ImplementationHandoff {
  /** Change identifier from the plan */
  changeId: string
  /** Approved plan version label (e.g. "v2") */
  approvedVersion: string
  /** Absolute path to the runtime state directory */
  runtimeStateDir: string
  /** Session ID of the planning session that forked this handoff */
  sourceSessionId?: string
  /** ISO timestamp when the handoff was created */
  forkedAt: string
  /** Canonical plan artifact paths for context injection */
  planArtifactPaths: Record<string, string>
}

/**
 * Build the handoff metadata when transitioning from planning to implementation.
 *
 * Creates an `ImplementationHandoff` object with the approved plan pointer
 * and canonical artifact paths. The caller stores this in the forked
 * session's metadata or in plan-state.json.
 *
 * @param changeId - Change identifier from the plan.
 * @param approvedVersion - Approved plan version label (e.g. "v2").
 * @param runtimeStateDir - Absolute path to the runtime state directory.
 * @param planArtifactPaths - Record of artifact name → absolute file path.
 * @param sourceSessionId - Optional source planning session ID.
 * @returns An ImplementationHandoff object.
 */
export function buildImplementationHandoff(
  changeId: string,
  approvedVersion: string,
  runtimeStateDir: string,
  planArtifactPaths: Record<string, string>,
  sourceSessionId?: string,
): ImplementationHandoff {
  return {
    changeId,
    approvedVersion,
    runtimeStateDir,
    sourceSessionId,
    forkedAt: new Date().toISOString(),
    planArtifactPaths,
  }
}

/**
 * Serialize handoff metadata to a JSON string for session metadata storage.
 *
 * @param handoff - The handoff metadata to serialize.
 * @returns Pretty-printed JSON string.
 */
export function serializeHandoff(handoff: ImplementationHandoff): string {
  return JSON.stringify(handoff, null, 2)
}

/**
 * Deserialize handoff metadata from a JSON string.
 *
 * @param data - JSON string produced by serializeHandoff.
 * @returns The parsed ImplementationHandoff object.
 * @throws If the input is not valid JSON or does not match the expected shape.
 */
export function deserializeHandoff(data: string): ImplementationHandoff {
  const parsed = JSON.parse(data) as Partial<ImplementationHandoff>

  // Validate required fields
  if (!parsed.changeId || typeof parsed.changeId !== "string") {
    throw new Error("Invalid handoff: missing or invalid 'changeId'")
  }
  if (!parsed.approvedVersion || typeof parsed.approvedVersion !== "string") {
    throw new Error("Invalid handoff: missing or invalid 'approvedVersion'")
  }
  if (!parsed.runtimeStateDir || typeof parsed.runtimeStateDir !== "string") {
    throw new Error("Invalid handoff: missing or invalid 'runtimeStateDir'")
  }
  if (!parsed.planArtifactPaths || typeof parsed.planArtifactPaths !== "object") {
    throw new Error("Invalid handoff: missing or invalid 'planArtifactPaths'")
  }

  return {
    changeId: parsed.changeId,
    approvedVersion: parsed.approvedVersion,
    runtimeStateDir: parsed.runtimeStateDir,
    sourceSessionId: parsed.sourceSessionId,
    forkedAt: parsed.forkedAt ?? new Date().toISOString(),
    planArtifactPaths: parsed.planArtifactPaths,
  }
}

/**
 * Build the prompt prefix for an implementation session that received a handoff.
 *
 * This injects the approved plan context into the new session so the model
 * knows exactly what plan to execute without needing the planning session's
 * full transcript.
 *
 * The prompt explicitly distinguishes session forking from git branching.
 *
 * @param handoff - The handoff metadata from the planning session.
 * @returns A markdown string to prepend to the implementation session prompt.
 */
export function buildHandoffPromptPrefix(handoff: ImplementationHandoff): string {
  const lines: string[] = [
    "# Implementation Session",
    "",
    `This session was forked from a planning session for change **${handoff.changeId}**.`,
    "",
    "## Approved Plan Context",
    `- Change ID: ${handoff.changeId}`,
    `- Approved Version: ${handoff.approvedVersion}`,
    `- Runtime State Dir: ${handoff.runtimeStateDir}`,
    `- Forked At: ${handoff.forkedAt}`,
    "",
    "## Plan Artifacts",
  ]

  for (const [key, filePath] of Object.entries(handoff.planArtifactPaths)) {
    lines.push(`- ${key}: \`${filePath}\``)
  }

  lines.push(
    "",
    "## Handoff Rules",
    `- This is a **session fork**, not a git branch creation.`,
    `- No git branches have been created by this handoff.`,
    `- The planning session remains available via session tree/resume.`,
    "",
    `Use \`/zflow-change-implement ${handoff.changeId}\` to begin implementation.`,
  )

  return lines.join("\n")
}

/**
 * Check whether session fork capability is available.
 *
 * Returns true if `pi.forkSession` or equivalent session fork API
 * is available. This is a best-effort check; the caller should
 * handle the case where forking is not available gracefully.
 */
export function canForkSession(): boolean {
  // Session forking depends on Pi runtime version and available APIs.
  // At minimum, check that we're in a Pi session environment.
  try {
    return typeof process !== "undefined" &&
      typeof process.env !== "undefined" &&
      "PI_SESSION_ID" in process.env
  } catch {
    return false
  }
}

// ── Fork implementation session helper ────────────────────────────

/**
 * Result of attempting to fork an implementation session.
 */
export interface ForkSessionResult {
  /** Whether the session was successfully forked via ctx API. */
  forked: boolean
  /** Path to the new session file, if forked via ctx API. */
  sessionFile?: string
  /** Path to the handoff artifact file, if fallback was used. */
  handoffArtifactPath?: string
  /** The serialized handoff metadata (for reference). */
  handoffJson: string
  /** The handoff prompt prefix (for injecting into the new session). */
  handoffPromptPrefix: string
  /** Human-readable instructions for next steps. */
  message: string
}

/**
 * Attempt to fork a new implementation session with handoff metadata.
 *
 * Tries, in order:
 * 1. `ctx.newSession()` — creates a fresh session with handoff prompt as the first user message
 * 2. `ctx.fork()` — forks from the current leaf entry with handoff metadata
 * 3. Falls back to writing a `.handoff.json` artifact file under `<runtime-state-dir>/runs/`
 *
 * Uses defensive dynamic checks so it works even with partial `ctx` stubs.
 * Does NOT create git branches.
 *
 * @param ctx - A command-handler context-like object (may have `newSession`, `fork`, `ui`).
 * @param handoff - The implementation handoff metadata.
 * @returns A ForkSessionResult describing what happened.
 */
export async function forkImplementationSessionIfAvailable(
  ctx: Record<string, unknown>,
  handoff: ImplementationHandoff,
): Promise<ForkSessionResult> {
  const handoffJson = serializeHandoff(handoff)
  const handoffPromptPrefix = buildHandoffPromptPrefix(handoff)

  // ── Attempt 1: ctx.newSession() ──────────────────────────────
  const newSession = (ctx as Record<string, unknown>).newSession
  if (typeof newSession === "function") {
    try {
      const parentSession =
        typeof (ctx as Record<string, unknown>).sessionManager !== "undefined" &&
        typeof (ctx as Record<string, unknown>).sessionManager !== "string" &&
        typeof (ctx as Record<string, unknown>).sessionManager === "object" &&
        (ctx as Record<string, unknown>).sessionManager !== null
          ? ((ctx as Record<string, unknown>).sessionManager as Record<string, unknown>).getSessionFile
            ? typeof (ctx as Record<string, unknown>).sessionManager === "object" &&
              (ctx as Record<string, unknown>).sessionManager !== null &&
              typeof ((ctx as Record<string, unknown>).sessionManager as Record<string, unknown>).getSessionFile === "function"
              ? await ((ctx as Record<string, unknown>).sessionManager as { getSessionFile: () => string | Promise<string> }).getSessionFile()
              : undefined
            : undefined
          : undefined

      // Call ctx.newSession with handoff prompt sent as a user message
      // so the forked session knows it's an implementation session.
      const result = await (newSession as (opts?: Record<string, unknown>) => Promise<{ cancelled: boolean; sessionFile?: string }>)({
        parentSession,
        withSession: async (forkedCtx: Record<string, unknown>) => {
          const sendMsg = (forkedCtx as Record<string, unknown>).sendUserMessage
          if (typeof sendMsg === "function") {
            await (sendMsg as (msg: string) => Promise<void>)(handoffPromptPrefix)
          }
        },
      })

      if (!result.cancelled && result.sessionFile) {
        return {
          forked: true,
          sessionFile: result.sessionFile,
          handoffJson,
          handoffPromptPrefix,
          message: `✅ Implementation session forked.\n  Session file: ${result.sessionFile}\n  Change: ${handoff.changeId} v${handoff.approvedVersion}\n  Use \`/zflow-change-implement ${handoff.changeId}\` to begin.`,
        }
      }
    } catch {
      // newSession failed — fall through
    }
  }

  // ── Attempt 2: ctx.fork() ────────────────────────────────────
  // Requires an entryId — not always available in command context.
  // If this fails, proceed to fallback.
  const forkFn = (ctx as Record<string, unknown>).fork
  if (typeof forkFn === "function") {
    try {
      // Try to get the current entryId from ctx
      const currentEntryId =
        typeof (ctx as Record<string, unknown>).entryId === "string"
          ? (ctx as Record<string, unknown>).entryId as string
          : undefined

      if (currentEntryId) {
        const forkResult = await (forkFn as (entryId: string, opts?: Record<string, unknown>) => Promise<{ cancelled: boolean }>)(
          currentEntryId,
          {
            position: "at",
            withSession: async (forkedCtx: Record<string, unknown>) => {
              const sendMsg = (forkedCtx as Record<string, unknown>).sendUserMessage
              if (typeof sendMsg === "function") {
                await (sendMsg as (msg: string) => Promise<void>)(handoffPromptPrefix)
              }
            },
          },
        )

        if (!forkResult.cancelled) {
          return {
            forked: true,
            sessionFile: "forked-session",
            handoffJson,
            handoffPromptPrefix,
            message: `✅ Implementation session forked from current leaf.\n  Change: ${handoff.changeId} v${handoff.approvedVersion}\n  Use \`/zflow-change-implement ${handoff.changeId}\` to begin implementation.`,
          }
        }
      }
    } catch {
      // ctx.fork failed — fall through
    }
  }

  // ── Fallback: Write handoff artifact file ────────────────────
  // Write to <runtime-state-dir>/runs/<changeId>-handoff.json
  try {
    const { default: fs } = await import("node:fs/promises")
    const { default: path } = await import("node:path")
    const { resolveRuntimeStateDir } = await import("pi-zflow-core/runtime-paths")

    const runtimeStateDir = resolveRuntimeStateDir()
    const runsDir = path.join(runtimeStateDir, "runs")
    const handoffFilename = `${handoff.changeId}-handoff.json`
    const handoffArtifactPath = path.join(runsDir, handoffFilename)

    await fs.mkdir(runsDir, { recursive: true })
    await fs.writeFile(handoffArtifactPath, handoffJson, "utf-8")

    return {
      forked: false,
      handoffArtifactPath,
      handoffJson,
      handoffPromptPrefix,
      message:
        `📋 Handoff artifact written to: ${handoffArtifactPath}\n` +
        `  Change: ${handoff.changeId} v${handoff.approvedVersion}\n` +
        `  No session fork API was available.\n` +
        `  Use \`/zflow-change-implement ${handoff.changeId}\` to load the handoff and begin implementation.\n` +
        `  No git branches were created.`,
    }
  } catch (err) {
    // Last-resort: return handoff data inline
    return {
      forked: false,
      handoffJson,
      handoffPromptPrefix,
      message:
        `⚠️ Could not write handoff artifact.\n` +
        `  Change: ${handoff.changeId} v${handoff.approvedVersion}\n` +
        `  Error: ${err instanceof Error ? err.message : String(err)}\n` +
        `  Handoff data:\n${handoffJson}\n\n` +
        `  Pass this data to \`/zflow-change-implement ${handoff.changeId}\` manually.`,
    }
  }
}

/**
 * Resolve a pending handoff artifact for a given changeId.
 *
 * Reads `<runtime-state-dir>/runs/<changeId>-handoff.json` if it exists.
 * Returns null if no handoff artifact is found.
 *
 * @param changeId - The change identifier to look up.
 * @param cwd - Working directory (optional).
 */
export async function resolvePendingHandoff(
  changeId: string,
  cwd?: string,
): Promise<ImplementationHandoff | null> {
  try {
    const { default: fs } = await import("node:fs/promises")
    const { default: path } = await import("node:path")
    const { resolveRuntimeStateDir } = await import("pi-zflow-core/runtime-paths")

    const runtimeStateDir = resolveRuntimeStateDir(cwd)
    const handoffPath = path.join(runtimeStateDir, "runs", `${changeId}-handoff.json`)
    const raw = await fs.readFile(handoffPath, "utf-8")
    return deserializeHandoff(raw)
  } catch {
    return null
  }
}

/**
 * Remove a pending handoff artifact for a given changeId.
 *
 * @param changeId - The change identifier.
 * @param cwd - Working directory (optional).
 */
export async function clearPendingHandoff(
  changeId: string,
  cwd?: string,
): Promise<void> {
  try {
    const { default: fs } = await import("node:fs/promises")
    const { default: path } = await import("node:path")
    const { resolveRuntimeStateDir } = await import("pi-zflow-core/runtime-paths")

    const runtimeStateDir = resolveRuntimeStateDir(cwd)
    const handoffPath = path.join(runtimeStateDir, "runs", `${changeId}-handoff.json`)
    await fs.rm(handoffPath, { force: true })
  } catch {
    // Non-critical; ignore
  }
}

// ═══════════════════════════════════════════════════════════════════
// Phase 7 — /zflow-change-implement workflow orchestration
// ═══════════════════════════════════════════════════════════════════

/**
 * Options for running a change implementation workflow.
 *
 * Most fields are optional because the function reads the plan state
 * to discover the approved version and execution groups.
 */
export interface ImplementWorkflowOptions {
  /** Change identifier (required). */
  changeId: string
  /** Working directory for resolving runtime state dir. */
  cwd?: string
  /** Plan version to execute. Defaults to approvedVersion from plan-state.json. */
  planVersion?: string
  /** Execution groups from the approved plan. If not provided, read from plan artifact. */
  executionGroups?: DispatchExecutionGroup[]
  /** Optional reviewer runner for dispatching real reviewer agents. */
  reviewerRunner?: unknown
  /** If true, skip final verification and mark review as advisory. */
  skipVerification?: boolean
  /** If true, skip code review. */
  skipReview?: boolean
  /** If true, proceed with a dirty primary worktree. Defaults to false (dirty tree = hard error). */
  force?: boolean
}

/**
 * Result of a change implementation workflow.
 */
export interface ImplementWorkflowResult {
  /** Unique run identifier. */
  runId: string
  /** Change identifier. */
  changeId: string
  /** Plan version that was executed. */
  planVersion: string
  /** Overall workflow status. */
  status:
    | "executing"
    | "verifying"
    | "cleanup-pending"
    | "completed"
    | "failed"
    | "drift-pending"
    | "apply-back-conflicted"
  /** Verification outcome. */
  verificationStatus: "passed" | "failed" | "skipped" | "pending"
  /** Path to the code review findings file, if review was run. */
  reviewFindingsPath?: string
  /** Path to the deviation summary file, if applicable. */
  deviationSummaryPath?: string
  /** Error message if the workflow failed. */
  error?: string
  /** Ordered list of step descriptions explaining what should happen next. */
  nextSteps: string[]
}

/**
 * Run the formal /zflow-change-implement workflow end-to-end.
 *
 * Steps (matching the master plan's execution order):
 * 1. Check unfinished runs in state-index.json
 * 2. Resolve change and approved plan (plan-state.json)
 * 3. Load canonical planning artifact paths
 * 4. Update plan state to executing, create run.json
 * 5. Validate non-overlapping file ownership (via prepareWorktreeImplementationRun)
 * 6. Verify primary worktree clean (via prepareWorktreeImplementationRun)
 * 7. Run worktree-setup hook if needed
 * 8. Build and return a WorktreeImplementationRunPlan for the caller to dispatch
 *
 * After the caller dispatches the worktree tasks and collects results:
 *   - `finalizeWorktreeImplementationRun()` applies patches back
 *   - `runVerification()` runs final verification
 *   - code review runs (optional)
 *
 * @param options - Workflow options.
 * @returns An ImplementWorkflowResult with the run metadata.
 */
/**
 * IMPLEMENTATION NOTE — Worktree dispatch gap
 *
 * FUTURE: This function currently creates run state but does NOT dispatch workers
 * via pi-subagents worktree:true or execute apply-back. The
 * prepareWorktreeImplementationRun() and finalizeWorktreeImplementationRun()
 * helpers exist in this file but are not yet connected to the command lifecycle.
 *
 * Work in progress (Phase 5/7):
 * - buildWorktreeDispatchPlan() produces task descriptors
 * - prepareWorktreeImplementationRun() produces a full plan with preflight + groups
 * - The command handler at /zflow-change-implement should call
 *   prepareWorktreeImplementationRun() → dispatch via pi-subagents →
 *   finalizeWorktreeImplementationRun() → runChangeImplementWorkflow() for
 *   remaining post-dispatch steps.
 */
export async function runChangeImplementWorkflow(
  options: ImplementWorkflowOptions,
): Promise<ImplementWorkflowResult> {
  const cwd = options.cwd
  const { default: fs } = await import("node:fs/promises")
  const { default: pathModule } = await import("node:path")
  const force = options.force === true

  // 1. Check unfinished execution runs
  const unfinished = await discoverUnfinishedWork(options.changeId, cwd)
  if (unfinished.hasUnfinishedWork) {
    console.warn(
      `[zflow] Unfinished work detected for change "${options.changeId}". ` +
      "Call promptResumeChoices() before proceeding.",
    )
  }

  // 2. Resolve change and approved plan
  const planStatePath = resolvePlanStatePath(options.changeId, cwd)
  let planState: Record<string, unknown>

  try {
    const raw = await fs.readFile(planStatePath, "utf-8")
    planState = JSON.parse(raw)
  } catch {
    throw new Error(
      `No plan found for change "${options.changeId}". ` +
      "Run /zflow-change-prepare <change-path> first to create a plan.",
    )
  }

  const approvedVersion = planState.approvedVersion as string | null
  if (!approvedVersion) {
    throw new Error(
      `No approved plan version for change "${options.changeId}". ` +
      "Approve a plan version first via /zflow-change-prepare.",
    )
  }

  const planVersion = options.planVersion ?? approvedVersion

  // 3. Check worktree cleanliness — hard error unless --force
  const { default: childProcess } = await import("node:child_process")
  const repoRoot = childProcess.execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: cwd ?? process.cwd(),
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()

  let worktreeDirty = false
  try {
    const status = childProcess.execFileSync("git", ["status", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
    if (status.length > 0) {
      worktreeDirty = true
      if (force) {
        console.warn(
          `[zflow] Worktree is dirty for change "${options.changeId}". ` +
          "Proceeding with dirty worktree because --force was passed.",
        )
      } else {
        throw new Error(
          `Primary worktree must be clean for change "${options.changeId}". ` +
          "Uncommitted changes may interfere with worktree dispatch. " +
          "Commit or stash your changes first, or re-run with --force to proceed despite dirty worktree.",
        )
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Primary worktree must be clean")) {
      throw err
    }
    console.warn("[zflow] Could not check worktree cleanliness — proceeding without check.")
  }

  // 4. Update plan state to executing
  planState.lifecycleState = "executing"
  planState.updatedAt = new Date().toISOString()
  await fs.writeFile(planStatePath, JSON.stringify(planState, null, 2), "utf-8")

  // 5. Build canonical planning artifact paths
  const artifactPaths: Record<string, string> = {
    design: resolvePlanArtifactPath(options.changeId, planVersion, "design", cwd),
    executionGroups: resolvePlanArtifactPath(options.changeId, planVersion, "execution-groups", cwd),
    standards: resolvePlanArtifactPath(options.changeId, planVersion, "standards", cwd),
    verification: resolvePlanArtifactPath(options.changeId, planVersion, "verification", cwd),
  }

  // 6. Verify canonical artifacts exist (warn if missing)
  for (const [key, ap] of Object.entries(artifactPaths)) {
    try {
      await fs.access(ap)
    } catch {
      console.warn(`[zflow] Plan artifact "${key}" not found at: ${ap}`)
    }
  }

  // 7. Create a run with full metadata
  const runId = `impl-${options.changeId}-${Date.now().toString(36)}`
  const run = await createRun(runId, repoRoot, options.changeId, planVersion, cwd)

  // Update run phase to "executing" with additional fields
  await setRunPhase(runId, "executing", cwd)
  await updateRun(runId, {
    changeId: options.changeId,
    planVersion,
  } as any, cwd)

  // 8. Add state-index entry for the new run
  await addStateIndexEntry({
    type: "run",
    id: runId,
    status: "executing",
    metadata: {
      changeId: options.changeId,
      planVersion,
      repoRoot,
      worktreeDirty,
    },
  }, cwd)

  // 9. Register the run in the change lifecycle (unfinishedRuns)
  const { getChangeLifecycle, upsertChangeLifecycle } = await import("pi-zflow-artifacts/state-index")
  const existingLifecycle = await getChangeLifecycle(options.changeId, cwd)
  await upsertChangeLifecycle({
    changeId: options.changeId,
    lastPhase: "executing",
    unfinishedRuns: existingLifecycle
      ? [...new Set([...existingLifecycle.unfinishedRuns, runId])]
      : [runId],
    retainedWorktrees: existingLifecycle?.retainedWorktrees ?? [],
    artifactPaths: existingLifecycle?.artifactPaths ?? [],
    cleanupMetadata: existingLifecycle?.cleanupMetadata ?? {},
  }, cwd)

  // 10. Persist ordered next steps into run.json
  const nextSteps: string[] = [
    "1. Context-builder: review design, execution-groups, standards, and verification artifacts",
    "2. Worktree dispatch: dispatch execution groups to isolated worktrees with per-group agents",
    "3. Worker verification: each worker runs scoped verification before signalling completion",
    "4. Apply-back: merge completed worktree patches back to the primary worktree",
    "5. Final verification: run full verification suite on the primary worktree",
    "6. Code review: run /zflow-review-code to audit the implementation",
    "7. Fix loop: address any verification or review failures, then re-verify",
  ]
  await updateRun(runId, { nextSteps, metadata: { worktreeDirty } }, cwd)

  return {
    runId,
    changeId: options.changeId,
    planVersion,
    status: "executing",
    verificationStatus: options.skipVerification ? "skipped" : "pending",
    nextSteps,
  }
}

/**
 * Record or update ordered next steps in run.json.
 *
 * Reads the existing run.json, replaces `nextSteps`, and persists
 * atomically.  This is a durable helper that downstream workflow steps
 * (verification, apply-back, code review) can call to keep the run
 * metadata honest as the implementation progresses.
 *
 * @param runId - Unique run identifier.
 * @param steps - Ordered array of step descriptions (one per element).
 * @param cwd - Working directory (optional, for resolving runtime state dir).
 */
export async function recordImplementationNextSteps(
  runId: string,
  steps: string[],
  cwd?: string,
): Promise<void> {
  await updateRun(runId, { nextSteps: steps }, cwd)
}

// ═══════════════════════════════════════════════════════════════════
// Phase 7 — Plan-drift handling within the orchestrated workflow
// ═══════════════════════════════════════════════════════════════════

/**
 * Result of a drift-resolution flow.
 */
export interface DriftResolution {
  /** The chosen action. */
  action: "amend" | "cancel" | "inspect"
  /** Optional notes about the amendment. */
  amendmentNotes?: string
}

/**
 * Handle plan drift detected during implementation.
 *
 * Called when the implementation workflow enters a drift-pending state.
 * This function:
 * 1. Synthesizes deviation reports into a summary.
 * 2. Presents the user with structured choices (amend, cancel, inspect).
 * 3. If amendment is approved, creates v{n+1}, reruns validation/review,
 *    and prepares for restarting execution.
 * 4. Marks the previous plan version as superseded.
 *
 * @param changeId - The change identifier.
 * @param currentVersion - The plan version that drifted (e.g. "v1").
 * @param cwd - Working directory (optional).
 * @returns A result indicating whether replanning is needed.
 */
export async function handlePlanDrift(
  changeId: string,
  currentVersion: string,
  cwd?: string,
): Promise<{
  /** Whether replanning (amendment + validation) is needed. */
  needsReplan: boolean
  /** The new version string if an amendment was created. */
  newVersion?: string
  /** Path to the deviation summary file. */
  deviationSummaryPath?: string
}> {
  // Dynamic import to avoid circular dependency
  const { readDeviationReports, synthesizeDeviationSummary, writeDeviationSummary } =
    await import("./deviations.js")

  // 1. Read existing deviation reports for this change/version
  const reports = await readDeviationReports(changeId, currentVersion, cwd)
  if (reports.length === 0) {
    // No deviations to process — return without changes
    return { needsReplan: false }
  }

  // 2. Synthesize the deviation reports into a structured summary
  const summary = synthesizeDeviationSummary(
    `drift-${changeId}`,
    changeId,
    currentVersion,
    reports,
  )
  const summaryPath = await writeDeviationSummary(summary, cwd)

  // 3. Build a gate-prompt for the user to decide what to do
  //    (the caller uses this with pi-interview to get a decision)
  const driftContext = [
    `Change: ${changeId}`,
    `Version: ${currentVersion}`,
    `Deviation reports: ${reports.length}`,
    `Summary path: ${summaryPath}`,
  ].join("\n")

  void buildImplementationGateQuestions(changeId, "drift", driftContext)

  // 4. Mark the drifted version as superseded in plan-state.json
  try {
    await updatePlanState(changeId, {
      lifecycleState: "drifted",
      versions: {
        [currentVersion]: {
          state: "superseded",
          createdAt: new Date().toISOString(),
        },
      },
    }, cwd)
  } catch {
    // plan-state.json may not exist yet; that's OK
    console.warn(
      `[zflow] Could not update plan-state for change "${changeId}" — ` +
      "plan-state.json may not exist yet.",
    )
  }

  return {
    needsReplan: true,
    deviationSummaryPath: summaryPath,
  }
}

/**
 * Create a plan amendment after drift resolution.
 *
 * Bumps the version number, marks the old version as superseded,
 * and marks the new version as draft for replanning.
 *
 * @param changeId - The change identifier.
 * @param currentVersion - The version to supersede (e.g. "v1").
 * @param cwd - Working directory (optional).
 * @returns The new version string (e.g. "v2").
 */
export async function createPlanAmendment(
  changeId: string,
  currentVersion: string,
  cwd?: string,
): Promise<string> {
  // Bump the plan version to create a new draft version
  const newVersion = await bumpPlanVersion(changeId, cwd)

  // Mark the old version as superseded in plan-state.json
  await markPlanVersionState(changeId, currentVersion, "superseded", cwd)

  // The new version is already marked as "draft" by bumpPlanVersion

  return newVersion
}

/**
 * Build the drift-detected runtime reminder string.
 *
 * This reminder is injected into the model's context when a run
 * enters the drift-pending phase. It tells the model where to find
 * deviation reports and what to do next.
 *
 * @param changeId - The change identifier.
 * @param version - The plan version that drifted.
 * @param deviationCount - Number of deviation reports found.
 * @param summaryPath - Optional path to the deviation summary file.
 * @returns A markdown-formatted reminder string.
 */
export function buildDriftDetectedReminder(
  changeId: string,
  version: string,
  deviationCount: number,
  summaryPath?: string,
): string {
  const lines: string[] = [
    "## Drift Detected",
    "",
    `Plan drift detected for change **${changeId}** (version ${version}).`,
    `Found ${deviationCount} deviation report(s).`,
  ]

  if (summaryPath) {
    lines.push(
      "",
      `- Summary: \`${summaryPath}\``,
    )
  }

  lines.push(
    "",
    "Execution is halted until drift is resolved.",
    "Use the plan approval gate to approve an amendment, cancel, or inspect artifacts.",
    "",
    "**Available actions:**",
    "- **Approve Amendment** — create v{n+1}, re-run validation and review, restart execution",
    "- **Cancel** — stop the implementation workflow",
    "- **Inspect Artifacts** — review retained deviation reports and worktree artifacts before deciding",
  )

  return lines.join("\n")
}

// ═══════════════════════════════════════════════════════════════════
// Phase 7.9 — Implement-workflow helper functions
// ═══════════════════════════════════════════════════════════════════

/**
 * Run final verification for a completed run.
 *
 * Resolves the verification command via the precedence rules in
 * verification.ts, runs it, logs the result to run.json, and returns
 * pass/fail.
 *
 * @param runId - The run identifier.
 * @param cwd - Working directory (optional).
 * @returns Verification result with pass/fail and details.
 */
export async function finalizeVerification(
  runId: string,
  cwd?: string,
): Promise<{
  pass: boolean
  command: string
  output: string
  duration: number
  error?: string
}> {
  const run = await readRun(runId, cwd)
  const repoRoot = run.repoRoot

  // Resolve verification command
  const command = resolveVerificationCommand(repoRoot)
  if (!command) {
    console.warn("[zflow] No verification command resolved — marking verification as skipped.")
    await updateRun(runId, {
      verification: { status: "skipped" },
    } as any, cwd)
    return { pass: true, command: "(none)", output: "Verification skipped — no command resolved.", duration: 0 }
  }

  // Run verification
  const result = await runVerification(command, repoRoot)

  // Log to run.json
  await updateRun(runId, {
    verification: {
      status: result.pass ? "passed" : "failed",
      completedAt: new Date().toISOString(),
      failureCount: result.pass ? 0 : 1,
    },
  } as any, cwd)

  // Log to failure log if failed
  if (!result.pass) {
    await appendFailureLog(
      `Verification failed for run ${runId}`,
      `- **Command**: \`${command}\`\n- **Output**: \`\`\`\n${result.output}\n\`\`\`\n- **Duration**: ${result.duration}ms`,
      cwd,
    )
  }

  return {
    pass: result.pass,
    command: result.command,
    output: result.output,
    duration: result.duration,
    error: result.error,
  }
}

/**
 * Run a bounded verification fix loop for a run.
 *
 * Delegates to `runVerificationFixLoop` from verification.ts.
 * Requires the caller to provide a fix handler callback.
 *
 * @param runId - The run identifier.
 * @param fixHandler - Async callback that attempts fixes, returns true if a fix was applied.
 * @param cwd - Working directory (optional).
 * @returns Fix loop result.
 */
export async function runBoundedFixLoop(
  runId: string,
  fixHandler: (verificationResult: import("./verification.js").VerificationResult) => Promise<boolean>,
  cwd?: string,
): Promise<import("./verification.js").FixLoopResult> {
  const run = await readRun(runId, cwd)
  const repoRoot = run.repoRoot

  const result = await runVerificationFixLoop({
    repoRoot,
    cwd,
  }, fixHandler)

  // Update run.json with fix loop outcome
  await updateRun(runId, {
    verification: {
      status: result.success ? "passed" : "failed",
      completedAt: new Date().toISOString(),
      failureCount: result.success ? 0 : result.fixAttempts.length,
    },
  } as any, cwd)

  if (!result.success) {
    await appendFailureLog(
      `Fix loop exhausted for run ${runId}`,
      `- **Iterations**: ${result.iterations}\n- **Timed out**: ${result.timedOut}\n- **Final verification**: ${result.finalVerification.pass ? "passed" : "failed"}`,
      cwd,
    )
  }

  return result
}

/**
 * Finalize code review for a completed run.
 *
 * Delegates to pi-zflow-review if available via registry.
 *
 * @param runId - The run identifier.
 * @param cwd - Working directory (optional).
 * @returns Code review result.
 */
export async function finalizeCodeReview(
  runId: string,
  cwd?: string,
): Promise<{
  pass: boolean
  findingsPath?: string
  summary: string
}> {
  const registry = getZflowRegistry()
  const run = await readRun(runId, cwd)
  const reviewService = registry.optional<Record<string, Function>>("review")

  if (reviewService && typeof reviewService.runCodeReview === "function") {
    try {
      const planningArtifacts = {
        design: resolvePlanArtifactPath(run.changeId, run.planVersion, "design", cwd),
        executionGroups: resolvePlanArtifactPath(run.changeId, run.planVersion, "execution-groups", cwd),
        standards: resolvePlanArtifactPath(run.changeId, run.planVersion, "standards", cwd),
        verification: resolvePlanArtifactPath(run.changeId, run.planVersion, "verification", cwd),
      }

      const result = await (reviewService.runCodeReview as Function)({
        source: `Implementation of ${run.changeId}`,
        repoPath: run.repoRoot || cwd || process.cwd(),
        branch: run.branch || "(unknown)",
        planningArtifacts,
        verificationStatus: (run.verification as any)?.status || "unknown",
        cwd,
      })

      return {
        pass: (result as any).severity.critical === 0 && (result as any).severity.major === 0,
        findingsPath: (result as any).findingsPath,
        summary: `Code review: ${(result as any).severity.critical} critical, ${(result as any).severity.major} major, ${(result as any).severity.minor} minor issues.`,
      }
    } catch (err) {
      const summary = `Code review via registry failed: ${err instanceof Error ? err.message : String(err)}`
      console.warn(`[zflow] ${summary}`)
      return { pass: false, summary }
    }
  }

  const summary = "Code review skipped (no review service available)."
  console.info(`[zflow] ${summary}`)
  return { pass: true, summary }
}

/**
 * Mark a workflow as completed in plan-state.json, run.json, and the state index.
 *
 * Logs completion to failure-log if any issues occurred during the run.
 *
 * @param changeId - The change identifier.
 * @param runId - The run identifier.
 * @param cwd - Working directory (optional).
 */
export async function completeWorkflow(
  changeId: string,
  runId: string,
  cwd?: string,
): Promise<void> {
  const { default: fs } = await import("node:fs/promises")

  // 1. Update plan lifecycle to "completed"
  await updatePlanState(changeId, { lifecycleState: "completed" }, cwd)

  // 2. Update run.json phase to "completed"
  await setRunPhase(runId, "completed", cwd)

  // 3. Update state-index
  const index = await loadStateIndex(cwd)
  const runEntry = index.entries.find(
    (e) => e.type === "run" && e.id === runId,
  )
  if (runEntry) {
    runEntry.status = "completed"
    runEntry.updatedAt = new Date().toISOString()
  }
  const planEntry = index.entries.find(
    (e) => e.type === "plan" && e.metadata?.changeId === changeId,
  )
  if (planEntry) {
    planEntry.status = "completed"
    planEntry.updatedAt = new Date().toISOString()
  }
  const { resolveStateIndexPath } = await import("pi-zflow-artifacts/artifact-paths")
  await fs.writeFile(resolveStateIndexPath(cwd), JSON.stringify(index, null, 2), "utf-8")

  // 4. Check if there were issues by reading the run's verification status
  try {
    const run = await readRun(runId, cwd)
    if (run.verification && run.verification.status === "failed") {
      await appendFailureLog(
        `Workflow completed with issues for run ${runId}`,
        `- **Change**: ${changeId}\n- **Verification**: ${run.verification.status}\n- **Completed at**: ${new Date().toISOString()}`,
        cwd,
      )
    }
  } catch {
    // run.json may not be readable — that's OK
  }

  console.info(`[zflow] Workflow completed for change "${changeId}" (run ${runId}).`)
}

// ═══════════════════════════════════════════════════════════════════
// Post-start implementation sequence
// ═══════════════════════════════════════════════════════════════════

/**
 * Options for `runImplementationPostStartSequence`.
 */
export interface PostStartSequenceOptions {
  /** If true, skip waiting for dispatch artifacts and proceed to verification. */
  skipDispatchWait?: boolean
  /** If true, skip final verification entirely (review becomes advisory). */
  skipVerification?: boolean
  /** If true, skip code review. */
  skipReview?: boolean
  /** If false, do not attempt auto-fix loop on verification failure (default: true). */
  autoFix?: boolean
  /**
   * Optional fix handler for the bounded fix loop.
   * Receives the failed verification result and returns `true` if a fix
   * was applied. If not provided, the fix loop still runs up to 3 iterations
   * re-checking verification but without applying code changes.
   */
  fixHandler?: (result: import("./verification.js").VerificationResult) => Promise<boolean>
}

/**
 * Result of running the post-start implementation sequence.
 */
export interface PostStartSequenceResult {
  /** Current phase after the sequence ran (reflects run.json). */
  phase: string
  /** Symbolic status label. */
  status: "waiting-for-dispatch" | "verifying" | "reviewing" | "completed" | "failed"
  /** Verification outcome. */
  verificationStatus: "passed" | "failed" | "skipped" | "pending"
  /** Whether code review passed (if run). */
  reviewPassed?: boolean
  /** Path to code review findings if review was run. */
  reviewFindingsPath?: string
  /** Error message if any phase failed. */
  error?: string
  /** Run identifier. */
  runId: string
  /** Change identifier. */
  changeId: string
  /** Ordered list of next steps. */
  nextSteps: string[]
}

/**
 * Run the combined post-start implementation sequence in order where possible.
 *
 * This is the idempotent continuation function that should be called after
 * `runChangeImplementWorkflow` has created the run and (optionally) after
 * worktree dispatch has completed.
 *
 * Phase progression:
 * 1. **waiting-for-dispatch** — No group results/patches exist yet. Returns
 *    early with next steps instructing dispatch.
 * 2. **verifying** — Dispatch artifacts present (or skipDispatchWait=true).
 *    Runs `finalizeVerification()` unless explicitly skipped.
 * 3. **fix-loop** — Verification failed; runs `runBoundedFixLoop()` if
 *    options.autoFix is not false.
 * 4. **verification-failed** — Fix loop exhausted without success.
 * 5. **reviewing** — Verification passed (or advisory skip); runs
 *    `finalizeCodeReview()`.
 * 6. **completed** — Review passed (or skipped); calls `completeWorkflow()`.
 *
 * Every phase transition is persisted to run.json and state-index.
 *
 * @param runId - The run identifier.
 * @param options - Sequence options.
 * @param cwd - Working directory for runtime state path resolution.
 * @returns Current sequence result with phase, status, and next steps.
 */
export async function runImplementationPostStartSequence(
  runId: string,
  options?: PostStartSequenceOptions,
  cwd?: string,
): Promise<PostStartSequenceResult> {
  const { default: fs } = await import("node:fs/promises")
  const opts = options ?? {}
  const autoFix = opts.autoFix !== false // default true

  // 1. Read the current run state
  const run = await readRun(runId, cwd)
  const changeId = run.changeId

  // Helper: persist phase transition to run.json and state-index
  async function transitionTo(phase: RunPhase): Promise<void> {
    await setRunPhase(runId, phase, cwd)
    try {
      await updateStateIndexEntry(runId, { status: phase }, cwd)
    } catch {
      // State-index entry may not exist yet — non-fatal
    }
    // Also update change lifecycle lastPhase
    const { getChangeLifecycle, upsertChangeLifecycle } =
      await import("pi-zflow-artifacts/state-index")
    const existingLifecycle = await getChangeLifecycle(changeId, cwd)
    if (existingLifecycle) {
      await upsertChangeLifecycle({
        ...existingLifecycle,
        lastPhase: phase,
      }, cwd)
    }
  }

  // 2. Check for dispatch/apply-back artifacts
  //    Dispatch is evidenced by groups with patchPath set or apply-back having started.
  const hasGroupResults = run.groups.some((g) => g.patchPath && g.patchPath.length > 0)
  const hasApplyBackArtifacts = run.applyBack.status !== "pending"
  const hasDispatchArtifacts = hasGroupResults || hasApplyBackArtifacts

  if (!hasDispatchArtifacts && !opts.skipDispatchWait) {
    // No dispatch results yet — return waiting-for-dispatch
    const nextSteps: string[] = [
      "1. Worktree dispatch: dispatch execution groups to isolated worktrees with per-group agents",
      "2. Worker verification: each worker runs scoped verification before signalling completion",
      "3. Apply-back: merge completed worktree patches back to the primary worktree",
      "4. Final verification: run full verification suite on the primary worktree",
      "5. Code review: run /zflow-review-code to audit the implementation",
      "6. Fix loop: address any verification or review failures, then re-verify",
    ]

    await recordImplementationNextSteps(runId, nextSteps, cwd)

    return {
      phase: run.phase,
      status: "waiting-for-dispatch",
      verificationStatus: "pending",
      runId,
      changeId,
      nextSteps,
    }
  }

  // ── Gap visibility: skipDispatchWait=true means dispatch is not yet wired ─
  if (opts.skipDispatchWait) {
    console.info(
      "[zflow] skipDispatchWait is true: proceeding without worktree dispatch. " +
      "Worktree dispatch via pi-subagents worktree:true is not yet integrated. " +
      "prepareWorktreeImplementationRun() and finalizeWorktreeImplementationRun() " +
      "helpers exist but are not connected to the command lifecycle. " +
      "The post-start sequence will run verification/review on the primary worktree " +
      "without any isolated worker execution or apply-back.",
    )
  }

  // 3. Dispatch artifacts present (or explicitly skipped) → proceed to verification

  // 3a. Skip verification entirely?
  if (opts.skipVerification) {
    // Mark as advisory-skip in run.json
    await updateRun(runId, {
      verification: { status: "skipped" },
    } as any, cwd)
    await transitionTo("executing")

    // Go directly to code review (advisory)
    if (!opts.skipReview) {
      const reviewResult = await finalizeCodeReview(runId, cwd)
      await transitionTo(reviewResult.pass ? "executing" : "review-failed")

      if (reviewResult.pass) {
        await completeWorkflow(changeId, runId, cwd)
        return {
          phase: "completed",
          status: "completed",
          verificationStatus: "skipped",
          reviewPassed: true,
          reviewFindingsPath: reviewResult.findingsPath,
          runId,
          changeId,
          nextSteps: [],
        }
      } else {
        return {
          phase: "review-failed",
          status: "failed",
          verificationStatus: "skipped",
          reviewPassed: false,
          reviewFindingsPath: reviewResult.findingsPath,
          error: reviewResult.summary,
          runId,
          changeId,
          nextSteps: [
            "1. Address code review findings",
            "2. Re-run /zflow-change-implement or /zflow-change-fix to proceed",
          ],
        }
      }
    }

    // Both verification and review skipped
    await completeWorkflow(changeId, runId, cwd)
    return {
      phase: "completed",
      status: "completed",
      verificationStatus: "skipped",
      runId,
      changeId,
      nextSteps: [],
    }
  }

  // 3b. Run final verification
  await transitionTo("executing")

  if (opts.skipDispatchWait) {
    // Record nextSteps that acknowledge the worktree dispatch gap
    await recordImplementationNextSteps(runId, [
      "⚠️ Worktree dispatch via pi-subagents worktree:true is NOT yet integrated.",
      "   The implementation ran directly on the primary worktree without isolated worktrees or apply-back.",
      "1. Final verification: run full verification suite on the primary worktree",
      "2. Code review: run /zflow-review-code to audit the implementation",
      "3. Fix loop: address any verification or review failures, then re-verify",
    ], cwd)
  } else {
    await recordImplementationNextSteps(runId, [
      "1. Final verification: run full verification suite on the primary worktree",
      "2. Code review: run /zflow-review-code to audit the implementation",
      "3. Fix loop: address any verification or review failures, then re-verify",
    ], cwd)
  }

  const verificationResult = await finalizeVerification(runId, cwd)

  if (!verificationResult.pass) {
    // 3c. Verification failed — attempt fix loop if autoFix is enabled
    if (autoFix) {
      const fixHandler = opts.fixHandler ?? (async () => false)
      const fixLoopResult = await runBoundedFixLoop(runId, fixHandler, cwd)

      if (!fixLoopResult.success) {
        await transitionTo("verification-failed")
        return {
          phase: "verification-failed",
          status: "failed",
          verificationStatus: "failed",
          runId,
          changeId,
          error: `Fix loop exhausted (${fixLoopResult.iterations} iterations). ` +
            `Final verification: ${fixLoopResult.finalVerification.pass ? "passed" : "failed"}.`,
          nextSteps: [
            "1. Review failure log for details",
            "2. Manually fix issues, then re-run /zflow-change-implement or /zflow-change-fix",
            "3. Use /zflow-change-audit to re-check status",
          ],
        }
      }

      // Fix loop succeeded — verification passes now
    } else {
      // autoFix disabled — mark as failed
      await transitionTo("verification-failed")
      return {
        phase: "verification-failed",
        status: "failed",
        verificationStatus: "failed",
        runId,
        changeId,
        error: "Final verification failed (auto-fix disabled).",
        nextSteps: [
          "1. Review verification output for details",
          "2. Manually fix issues, then re-run /zflow-change-implement or /zflow-change-fix",
          "3. Use /zflow-change-audit to re-check status",
        ],
      }
    }
  }

  // 4. Verification passed (or fix loop resolved it) → code review
  if (!opts.skipReview) {
    const reviewResult = await finalizeCodeReview(runId, cwd)

    if (!reviewResult.pass) {
      await transitionTo("review-failed")
      return {
        phase: "review-failed",
        status: "failed",
        verificationStatus: "passed",
        reviewPassed: false,
        reviewFindingsPath: reviewResult.findingsPath,
        error: reviewResult.summary,
        runId,
        changeId,
        nextSteps: [
          "1. Address code review findings",
          "2. Run /zflow-change-fix to apply fixes",
          "3. Re-run /zflow-change-implement to re-verify",
        ],
      }
    }

    await transitionTo("completed")
    await completeWorkflow(changeId, runId, cwd)

    return {
      phase: "completed",
      status: "completed",
      verificationStatus: "passed",
      reviewPassed: true,
      reviewFindingsPath: reviewResult.findingsPath,
      runId,
      changeId,
      nextSteps: [],
    }
  }

  // 5. Verification passed, review skipped
  await transitionTo("completed")
  await completeWorkflow(changeId, runId, cwd)

  return {
    phase: "completed",
    status: "completed",
    verificationStatus: "passed",
    runId,
    changeId,
    nextSteps: [],
  }
}
