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
 * Build a complete `SubagentLaunchPlan` for a single agent.
 *
 * Resolves the agent's launch config from the active profile,
 * assembles the appropriate prompt with mode/reminder fragments,
 * and attaches output-convention metadata.
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
  // 1. Resolve launch config from profile bindings
  let config = buildLaunchConfig(agentName, resolvedProfile)
  if (!config) return null

  // 2. Apply builtin overrides for scout / context-builder
  const shortName = agentName.replace("zflow.", "").replace("builtin:", "")
  const overrideDef = getBuiltinOverride(shortName)
  if (overrideDef) {
    config = applyBuiltinOverride(config, overrideDef)
  }

  // 3. Apply default depth and output limits (validates as a side effect)
  config = applyDefaultMaxSubagentDepth(config)
  config = applyDefaultMaxOutput(config)

  // 4. Assemble the prompt
  const assemblyInput: PromptAssemblyInput = {
    agentName,
    mode: options?.mode,
    activeReminders: options?.activeReminders
      ? new Set(options.activeReminders)
      : undefined,
    artifactPaths: options?.artifactPaths,
    distilledOrchestratorInvariants: options?.distilledInvariants,
  }

  const assembled = assemblePrompt(assemblyInput)

  // 5. Attach output convention metadata
  const convention = getOutputConvention(agentName)
  const outputInstructions = getOutputInstructions(agentName)

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
      activeReminders: Array.from(assembled.activeReminders ?? []),
      distilledCount: assembled.distilledCount ?? 0,
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

      // Conditional plan-review: only when reviewTags != "standard"
      const reviewTags = options?.reviewTags ?? "standard"
      if (reviewTags !== "standard") {
        const planReviewCorrectness = buildSubagentLaunchPlan("zflow.plan-review-correctness", resolvedProfile, {
          mode: "plan-mode",
          artifactPaths: options?.artifactPaths,
        })
        if (planReviewCorrectness) {
          steps.push({
            label: "Plan-review correctness",
            target: { type: "agent", plan: planReviewCorrectness },
            condition: { predicate: `reviewTags=${reviewTags}`, description: "Runs when reviewTags != standard" },
          })
        }

        if (reviewTags === "system" || reviewTags === "logic,system") {
          const planReviewFeasibility = buildSubagentLaunchPlan("zflow.plan-review-feasibility", resolvedProfile, {
            mode: "plan-mode",
            artifactPaths: options?.artifactPaths,
          })
          if (planReviewFeasibility) {
            steps.push({
              label: "Plan-review feasibility",
              target: { type: "agent", plan: planReviewFeasibility },
              condition: { predicate: `reviewTags=${reviewTags}`, description: "Runs for system or logic,system tier" },
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
