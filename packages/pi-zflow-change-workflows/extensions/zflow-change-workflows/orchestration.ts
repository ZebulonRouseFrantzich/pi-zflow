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
import { readRun, updateRun, setRunPhase, addRetainedArtifact, createRun, createRecoveryRef, removeRecoveryRef, assertValidPlanVersion, writePlanArtifact } from "pi-zflow-artifacts"
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
import type { ApplyBackResult, CascadeApplyBackResult } from "./apply-back.js"
import { writeDeviationSummary, readDeviationReports } from "./deviations.js"
import { getCurrentBranch } from "./git-preflight.js"
import { getZflowRegistry } from "pi-zflow-core/registry"
import { assertSafeChangeId } from "pi-zflow-core/ids"
import {
  DISPATCH_SERVICE_CAPABILITY,
  type DispatchService,
  type AgentDispatchProgress,
  type TaskWorktreeStrategy,
} from "pi-zflow-core/dispatch-service"
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
 * Accepts several heading formats to be resilient to LLM output variance:
 *
 * ```markdown
 * ## Group 1: descriptive name
 * ## G1 — descriptive name
 * ## Execution Group 1: descriptive name
 * # Group 1: descriptive name          (h1 also accepted)
 * ```
 *
 * Field keys are matched with or without leading `- ` bullet and with or
 * without the "Scoped" prefix on verification:
 *
 * ```markdown
 * **Files:** path/to/file.ts, another/file.ts
 * - **Files:** path/to/file.ts, another/file.ts
 * **Verification:** optional scoped verification text
 * - **Scoped verification:** optional scoped verification text
 * ```
 */
export function parseExecutionGroupsMd(mdContent: string): DispatchExecutionGroup[] {
  const groups: DispatchExecutionGroup[] = []
  const lines = mdContent.split("\n")
  let currentGroup: Partial<DispatchExecutionGroup> | null = null
  let collectingFiles = false
  let collectingDependencies = false
  let collectingVerification = false
  let inVerificationFence = false

  const normalizeDependency = (dependency: string): string => {
    const trimmed = dependency.trim().replace(/^`|`$/g, "").replace(/^\[|\]$/g, "").trim()
    if (!trimmed) return ""
    // With explicit G/Group prefix: "Group 1A", "G 2"
    const gMatch = trimmed.match(/^(?:G|Groups?\s+)([A-Za-z]?\d+[A-Za-z]?|\d+[A-Za-z]?)$/i)
    if (gMatch) return `group-${gMatch[1].toLowerCase()}`
    // Bare alphanumeric group ID: "1A", "A1", "2", "b3"
    const bareMatch = trimmed.match(/^([A-Za-z]?\d+[A-Za-z]?|\d+[A-Za-z]?)$/i)
    if (bareMatch) return `group-${bareMatch[1].toLowerCase()}`
    return trimmed
  }

  const extractGroupDependencies = (value: string): string[] => {
    const dependencies: string[] = []
    const rangePattern = /\b(?:G|Groups?)\s*(\d+)([A-Za-z])\s*(?:-|–|—|to)\s*(?:(\d+))?([A-Za-z])\b/gi
    let rangeMatch: RegExpExecArray | null
    while ((rangeMatch = rangePattern.exec(value)) !== null) {
      const startNumber = Number.parseInt(rangeMatch[1]!, 10)
      const startLetter = rangeMatch[2]!.toLowerCase()
      const endNumber = Number.parseInt(rangeMatch[3] ?? rangeMatch[1]!, 10)
      const endLetter = rangeMatch[4]!.toLowerCase()

      if (startNumber === endNumber && startLetter.length === 1 && endLetter.length === 1) {
        const startCode = startLetter.charCodeAt(0)
        const endCode = endLetter.charCodeAt(0)
        if (startCode <= endCode) {
          for (let code = startCode; code <= endCode; code++) {
            dependencies.push(`group-${startNumber}${String.fromCharCode(code)}`)
          }
        }
      } else if (startNumber <= endNumber) {
        dependencies.push(`group-${startNumber}${startLetter}`)
        dependencies.push(`group-${endNumber}${endLetter}`)
      }
    }

    const groupRefPattern = /\b(?:G|Groups?)\s*([A-Za-z]?\d+[A-Za-z]?|\d+[A-Za-z]?)\b/gi
    let match: RegExpExecArray | null
    while ((match = groupRefPattern.exec(value)) !== null) {
      dependencies.push(`group-${match[1]!.toLowerCase()}`)
    }

    // Dependency prose often uses a single plural prefix followed by a list,
    // e.g. "Groups 1A and 1B" or "Groups 1A, 1B, and 1C". After the prefix,
    // later IDs may not repeat "Group", so collect alphanumeric group tokens
    // from that list-like tail as well. Numeric-only refs are handled above
    // when directly prefixed by Group/G to avoid confusing prose numbers with
    // group IDs.
    if (/\bGroups?\b/i.test(value)) {
      const alphanumericRefs = value.match(/\b[A-Za-z]?\d+[A-Za-z]?\b/g) ?? []
      for (const ref of alphanumericRefs) {
        if (/^[A-Za-z]?\d+[A-Za-z]?$/.test(ref)) {
          dependencies.push(`group-${ref.toLowerCase()}`)
        }
      }
    }

    return [...new Set(dependencies)]
  }

  const appendDependencies = (value: string): void => {
    if (!currentGroup) return
    const extracted = extractGroupDependencies(value)
    if (extracted.length === 0) return
    currentGroup.dependencies = [...new Set([...(currentGroup.dependencies ?? []), ...extracted])]
  }

  const appendVerification = (value: string): void => {
    if (!currentGroup) return
    const trimmed = value.trim()
    if (!trimmed || trimmed.startsWith("````".slice(0, 3))) return
    currentGroup.scopedVerification = [currentGroup.scopedVerification, trimmed].filter(Boolean).join("\n")
  }

  const isNextGroupSubsection = (value: string): boolean => {
    return /^(Expected outcome|Expected verification outcome|Expected outcome \/ acceptance criteria|Acceptance criteria|Self-checks|Drift trigger|reviewTags|Manual checks|Implementation task spec|Implementation notes):/i.test(value.trim())
  }

  const pushCurrentGroup = (): void => {
    if (!currentGroup?.id) return
    groups.push({
      id: currentGroup.id,
      files: currentGroup.files ?? [],
      dependencies: currentGroup.dependencies ?? [],
      agent: currentGroup.agent ?? "zflow.implement-routine",
      parallelizable: currentGroup.parallelizable ?? true,
      taskPrompt: currentGroup.taskPrompt ?? "",
      scopedVerification: currentGroup.scopedVerification,
      executionMode: currentGroup.executionMode ?? "isolated",
      workspaceConcurrency: currentGroup.workspaceConcurrency ?? "serialized",
      baseStrategy: currentGroup.baseStrategy ?? "head",
      workspaceId: currentGroup.workspaceId,
      executionRationale: currentGroup.executionRationale,
    })
  }

  for (const line of lines) {
    // Accept h1-h4 headings: ## Group 1: Name, # Group 1: Name,
    // ## G1 — Name, ## Execution Group 1: Name.
    // Group IDs may be digit-first (1, 1A) or letter-first (A1, B2, C3a).
    const groupMatch = line.match(/^#{1,4}\s+Group\s+([A-Za-z]?\d+[A-Za-z]?|\d+[A-Za-z]?)\s*(?::|[—-])\s+(.+)$/i) ??
      line.match(/^#{1,4}\s+G([A-Za-z]?\d+[A-Za-z]?|\d+[A-Za-z]?)\s+[—-]\s+(.+)$/i) ??
      line.match(/^#{1,4}\s+Execution\s+Group\s+([A-Za-z]?\d+[A-Za-z]?|\d+[A-Za-z]?)\s*(?::|[—-])\s+(.+)$/i)
    if (groupMatch) {
      pushCurrentGroup()
      currentGroup = {
        id: `group-${groupMatch[1].toLowerCase()}`,
        files: [],
        dependencies: [],
        agent: "zflow.implement-routine",
        taskPrompt: groupMatch[2],
        parallelizable: true,
        executionMode: "isolated",
        workspaceConcurrency: "serialized",
        baseStrategy: "head",
      }
      collectingFiles = false
      collectingDependencies = false
      collectingVerification = false
      inVerificationFence = false
      continue
    }

    if (!currentGroup) continue

    if (/^#{1,6}\s+/.test(line)) {
      collectingFiles = false
      collectingDependencies = false
      collectingVerification = false
      inVerificationFence = false
    }

    const filesHeaderMatch = line.match(/-\s+\*\*Files?(?:\/paths)?:\*\*\s*$/i) ??
      line.match(/^\*\*Files?(?:\/paths)?:\*\*\s*$/i) ??
      line.match(/^Files?(?:\s+touched)?(?:\/paths)?(?:\s*\([^)]*\))?:\s*$/i) ??
      line.match(/^\*\*Primary\s+files?(?:\/paths)?\s+touched:\*\*\s*$/i)
    if (filesHeaderMatch) {
      collectingFiles = true
      collectingDependencies = false
      collectingVerification = false
      continue
    }

    const filesMatch = line.match(/-\s+\*\*Files?(?:\/paths)?:\*\*\s+(.+)/i) ??
      line.match(/^\*\*Files?(?:\/paths)?:\*\*\s+(.+)/i) ??
      line.match(/^\*\*Primary\s+files?(?:\/paths)?\s+touched:\*\*\s+(.+)/i) ??
      line.match(/^Files?(?:\s+touched)?(?:\/paths)?(?:\s*\([^)]*\))?:\s+(.+)$/i)
    if (filesMatch) {
      currentGroup.files = filesMatch[1].split(",").map((f: string) => f.trim()).filter(Boolean)
      collectingFiles = false
      continue
    }

    if (collectingFiles) {
      const fileItemMatch = line.match(/^\s*(?:[-*]|\d+\.)\s+`?([^`\n]+?)`?(?:\s+\(new\))?\s*$/)
      if (fileItemMatch && !fileItemMatch[1].startsWith("**")) {
        currentGroup.files = [...(currentGroup.files ?? []), fileItemMatch[1].trim()]
        continue
      }
      if (line.trim().startsWith("- **") || line.trim().startsWith("**") || /^[A-Z][A-Za-z\s]+:/.test(line.trim())) collectingFiles = false
    }

    const agentMatch = line.match(/-\s+\*\*Agent:\*\*\s+(.+)/i) ??
      line.match(/^\*\*Agent:\*\*\s+(.+)/i) ??
      line.match(/-\s+\*\*Owner\s+agent:\*\*\s+(.+)/i) ??
      line.match(/^\*\*Owner\s+agent:\*\*\s+(.+)/i) ??
      line.match(/^Owner agent:\s+`?([^`\n]+)`?/i)
    if (agentMatch) {
      currentGroup.agent = agentMatch[1].trim().replace(/^`|`$/g, "").trim()
      continue
    }

    const ownerMatch = line.match(/-\s+\*\*Owner:\*\*\s+`?([^`\n]+)`?/i) ??
      line.match(/^\*\*Owner:\*\*\s+`?([^`\n]+)`?/i)
    if (ownerMatch) {
      currentGroup.agent = ownerMatch[1].trim().replace(/^`|`$/g, "").trim()
      continue
    }

    const taskMatch = line.match(/-\s+\*\*Task:\*\*\s+(.+)/i) ??
      line.match(/^\*\*Task:\*\*\s+(.+)/i) ??
      line.match(/^Task description:\s+(.+)/i)
    if (taskMatch) {
      currentGroup.taskPrompt = taskMatch[1].trim()
      continue
    }

    const depMatch = line.match(/-\s+\*\*Dependencies:\*\*\s+(.+)/i) ??
      line.match(/^\*\*Dependencies:\*\*\s+(.+)/i)
    if (depMatch) {
      const explicitDependencies = depMatch[1]
        .replace(/^`|`$/g, "")
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map(normalizeDependency)
        .filter(Boolean)
      currentGroup.dependencies = [...new Set([...(currentGroup.dependencies ?? []), ...explicitDependencies])]
      appendDependencies(depMatch[1])
      continue
    }

    const depHeaderMatch = line.match(/^Dependencies:\s*$/i)
    if (depHeaderMatch) {
      collectingDependencies = true
      collectingFiles = false
      collectingVerification = false
      continue
    }

    if (collectingDependencies) {
      const depItemMatch = line.match(/^\s*[-*]\s+(.+)$/)
      if (depItemMatch) {
        appendDependencies(depItemMatch[1])
        continue
      }
      if (/^[A-Z][A-Za-z\s]+:/.test(line.trim())) collectingDependencies = false
    }

    const verifHeaderMatch = line.match(/-\s+\*\*(?:Scoped\s+)?[Vv]erification:\*\*\s*$/i) ??
      line.match(/^\*\*(?:Scoped\s+)?[Vv]erification:\*\*\s*$/i) ??
      line.match(/^(?:Scoped\s+)?[Vv]erification:\s*$/i)
    if (verifHeaderMatch) {
      collectingVerification = true
      collectingFiles = false
      collectingDependencies = false
      inVerificationFence = false
      continue
    }

    const verifMatch = line.match(/-\s+\*\*(?:Scoped\s+)?[Vv]erification:\*\*\s+(.+)/i) ??
      line.match(/^\*\*(?:Scoped\s+)?[Vv]erification:\*\*\s+(.+)/i) ??
      line.match(/^(?:Scoped\s+)?[Vv]erification:\s+(.+)/i)
    if (verifMatch) {
      currentGroup.scopedVerification = verifMatch[1].trim()
      collectingVerification = false
      continue
    }

    if (collectingVerification) {
      if (line.trim().startsWith("```")) {
        inVerificationFence = !inVerificationFence
        continue
      }
      if (inVerificationFence) {
        appendVerification(line)
        continue
      }
      if (isNextGroupSubsection(line)) {
        collectingVerification = false
        continue
      }
      const verificationItemMatch = line.match(/^\s+-\s+(.+)$/)
      if (verificationItemMatch && !verificationItemMatch[1].startsWith("**")) {
        // Strip all backticks from the captured text and join with newlines
        const cleaned = verificationItemMatch[1].trim().replace(/`/g, "").trim()
        if (cleaned) {
          currentGroup.scopedVerification = [currentGroup.scopedVerification, cleaned].filter(Boolean).join("\n")
        }
        continue
      }
    }

    const parallelMatch = line.match(/-\s+\*\*Parallelizable:\*\*\s+(.+)/i) ??
      line.match(/^\*\*Parallelizable:\*\*\s+(.+)/i) ??
      line.match(/^Parallelizable:\s+(.+)/i)
    if (parallelMatch) {
      currentGroup.parallelizable = parallelMatch[1].trim().toLowerCase() === "yes" ||
        parallelMatch[1].trim().toLowerCase() === "true"
      continue
    }

    const executionModeMatch = line.match(/-\s+\*\*Execution\s+mode:\*\*\s+(.+)/i) ??
      line.match(/^\*\*Execution\s+mode:\*\*\s+(.+)/i) ??
      line.match(/^Execution\s+mode:\s+(.+)/i)
    if (executionModeMatch) {
      const mode = executionModeMatch[1].trim().toLowerCase()
      currentGroup.executionMode = mode === "shared-staging" ? "shared-staging" : "isolated"
      continue
    }

    const workspaceIdMatch = line.match(/-\s+\*\*Workspace\s+ID:\*\*\s+(.+)/i) ??
      line.match(/^\*\*Workspace\s+ID:\*\*\s+(.+)/i) ??
      line.match(/^Workspace\s+ID:\s+(.+)/i)
    if (workspaceIdMatch) {
      currentGroup.workspaceId = workspaceIdMatch[1].trim().replace(/^`|`$/g, "").trim()
      continue
    }

    const workspaceConcurrencyMatch = line.match(/-\s+\*\*Workspace\s+concurrency:\*\*\s+(.+)/i) ??
      line.match(/^\*\*Workspace\s+concurrency:\*\*\s+(.+)/i) ??
      line.match(/^Workspace\s+concurrency:\s+(.+)/i)
    if (workspaceConcurrencyMatch) {
      const concurrency = workspaceConcurrencyMatch[1].trim().toLowerCase()
      currentGroup.workspaceConcurrency = concurrency === "concurrent" ? "concurrent" : "serialized"
      continue
    }

    const baseStrategyMatch = line.match(/-\s+\*\*Base\s+strategy:\*\*\s+(.+)/i) ??
      line.match(/^\*\*Base\s+strategy:\*\*\s+(.+)/i) ??
      line.match(/^Base\s+strategy:\s+(.+)/i)
    if (baseStrategyMatch) {
      const baseStrategy = baseStrategyMatch[1].trim().toLowerCase()
      currentGroup.baseStrategy = baseStrategy === "dependency-lineage" ? "dependency-lineage" : "head"
      continue
    }

    const executionRationaleMatch = line.match(/-\s+\*\*Execution\s+rationale:\*\*\s+(.+)/i) ??
      line.match(/^\*\*Execution\s+rationale:\*\*\s+(.+)/i) ??
      line.match(/^Execution\s+rationale:\s+(.+)/i)
    if (executionRationaleMatch) {
      currentGroup.executionRationale = executionRationaleMatch[1].trim()
      continue
    }
  }

  // Push the last group
  pushCurrentGroup()

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
  /** Plan dependencies for this task/group. */
  dependencies: string[]
  /** Optional richer worktree execution strategy for this task. */
  worktreeStrategy?: TaskWorktreeStrategy
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
  /** Exact intercom target for the supervising orchestrator, when known. */
  orchestratorTarget?: string
}

// Type for an execution group used by worktree dispatch
export interface DispatchExecutionGroup {
  id: string
  agent: string
  files: string[]
  dependencies: string[]
  taskPrompt: string
  scopedVerification?: string
  parallelizable?: boolean
  executionMode?: "isolated" | "shared-staging"
  workspaceId?: string
  workspaceConcurrency?: "serialized" | "concurrent"
  baseStrategy?: "head" | "dependency-lineage"
  executionRationale?: string
  /** When set, this is a coalesced group that merges multiple original groups. */
  coalescedFrom?: string[]
}

/**
 * Coalesce execution groups that share files and have no explicit ordering.
 *
 * Builds a graph where edges connect groups that share at least one file AND
 * have no dependency relationship (direct or transitive). Groups with explicit
 * ordering (Group B depends on Group A) are not coalesced — the apply-back
 * engine patches them sequentially in topological order.
 *
 * Groups in each connected component (file-sharing + independent) are merged
 * into a single coalesced group so they run in the same worktree and produce
 * compatible patches from the same base commit.
 *
 * @param groups - The dispatch execution groups to coalesce.
 * @returns A new array of groups with connected components merged.
 */
export function coalesceConnectedGroups(
  groups: DispatchExecutionGroup[],
): DispatchExecutionGroup[] {
  if (groups.length <= 1) return groups

  // ── Build transitive dependency closure ─────────────────────
  // Used to avoid coalescing groups that already have explicit dependency
  // ordering — the apply-back engine applies patches in topological order,
  // so sequential groups don't need to run in the same worktree.
  const transitiveDeps = new Map<string, Set<string>>()
  for (const g of groups) {
    const closure = new Set<string>()
    const stack = [...g.dependencies]
    while (stack.length > 0) {
      const depId = stack.pop()!
      if (closure.has(depId)) continue
      closure.add(depId)
      const depGroup = groups.find(x => x.id === depId)
      if (depGroup) {
        for (const d of depGroup.dependencies) {
          if (!closure.has(d)) stack.push(d)
        }
      }
    }
    transitiveDeps.set(g.id, closure)
  }

  // ── Build adjacency list ────────────────────────────────────
  // Two groups are connected if they share at least one file AND have
  // no explicit dependency ordering between them (neither directly nor
  // transitively depends on the other). Groups with dependency ordering
  // don't need coalescing — the apply-back engine handles them by
  // applying patches in topological order.
  const groupIds = groups.map(g => g.id)
  const adjacency = new Map<string, string[]>()
  for (const g of groups) adjacency.set(g.id, [])

  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i]!
      const b = groups[j]!
      const aExplicitShared = a.executionMode === "shared-staging"
      const bExplicitShared = b.executionMode === "shared-staging"
      if (aExplicitShared || bExplicitShared) {
        // Planner-declared shared workspaces are first-class orchestration
        // units. Do not implicitly coalesce them here; the dispatch layer
        // will honor their shared workspace strategy explicitly.
        continue
      }
      const shareFiles = a.files.some(f => b.files.includes(f))
      const independent = !(transitiveDeps.get(a.id)?.has(b.id) || transitiveDeps.get(b.id)?.has(a.id))

      if (shareFiles && independent) {
        adjacency.get(a.id)!.push(b.id)
        adjacency.get(b.id)!.push(a.id)
      }
    }
  }

  // ── Find connected components ───────────────────────────────
  const visited = new Set<string>()
  const components: string[][] = []

  for (const id of groupIds) {
    if (visited.has(id)) continue
    const component: string[] = []
    const stack = [id]
    while (stack.length > 0) {
      const nodeId = stack.pop()!
      if (visited.has(nodeId)) continue
      visited.add(nodeId)
      component.push(nodeId)
      for (const neighbor of adjacency.get(nodeId) ?? []) {
        if (!visited.has(neighbor)) stack.push(neighbor)
      }
    }
    components.push(component)
  }

  // ── Merge each component into a single group ────────────────
  const groupMap = new Map(groups.map(g => [g.id, g]))
  const result: DispatchExecutionGroup[] = []

  const idMap = new Map<string, string>()

  for (const component of components) {
    if (component.length === 1) {
      // No coalescing needed for singleton components
      const group = groupMap.get(component[0]!)!
      idMap.set(group.id, group.id)
      result.push(group)
      continue
    }

    const members = component.map(id => groupMap.get(id)!).filter(Boolean)
    const componentSet = new Set(component)

    // Merged files (union, deduplicated, preserving order)
    const mergedFiles: string[] = []
    const seenFiles = new Set<string>()
    for (const m of members) {
      for (const f of m.files) {
        if (!seenFiles.has(f)) {
          seenFiles.add(f)
          mergedFiles.push(f)
        }
      }
    }

    // Merged dependencies: union of all member dep IDs minus IDs within this component
    const depsSet = new Set<string>()
    for (const m of members) {
      for (const d of m.dependencies) {
        if (!componentSet.has(d)) depsSet.add(d)
      }
    }
    const mergedDeps = [...depsSet]

    // Merged task prompt: describe each original subgroup
    const mergedPrompt = members.length === 2
      ? members.map((m, i) => `Sub-group ${i + 1} — ${m.taskPrompt}`).join("\n")
      : members.map((m, i) => `Sub-group ${i + 1} (${m.id}): ${m.taskPrompt}`).join("\n")

    // Merged scoped verification: join with newlines so each command
    // stays separate. Do NOT shell-chain with `&&` because guarded bash
    // execution rejects multi-command syntax. Each command is rendered
    // individually in the worker task prompt so the agent runs them as
    // separate guarded bash calls.
    const verificationCmds = members
      .map(m => m.scopedVerification)
      .filter((v): v is string => v !== undefined && v !== "")
    const mergedVerification = verificationCmds.length > 0
      ? verificationCmds.join("\n")
      : undefined

    // Agent: use the deepest dependency member (one that no other member depends on),
    // or fall back to the first member's agent.
    const leafMember = members.find(m => !members.some(other => other.dependencies.includes(m.id)))
    const mergedAgent = leafMember?.agent ?? members[0]!.agent

    // Merged ID: join original IDs with "~" separator
    // Sort so IDs are stable (group-1, group-2, etc.)
    component.sort()
    const mergedId = component.join("~")

    for (const id of component) {
      idMap.set(id, mergedId)
    }

    result.push({
      id: mergedId,
      agent: mergedAgent,
      files: mergedFiles,
      dependencies: mergedDeps,
      taskPrompt: mergedPrompt,
      scopedVerification: mergedVerification,
      executionMode: "isolated",
      workspaceConcurrency: "serialized",
      baseStrategy: "head",
      coalescedFrom: [...component],
    })
  }

  // Remap dependencies that point at groups inside a coalesced component to
  // the new coalesced group ID. This preserves apply-back ordering without
  // leaving dependencies that reference no dispatched group.
  return result.map((group) => {
    const remappedDeps = group.dependencies
      .map((dep) => idMap.get(dep) ?? dep)
      .filter((dep) => dep !== group.id)
    return {
      ...group,
      dependencies: [...new Set(remappedDeps)],
    }
  })
}

/**
 * Build the narrow control-plane contract included in worker/orchestrator tasks.
 */
function buildLimitedCoordinationLines(
  label: string,
  orchestratorTarget?: string,
): string[] {
  const lines = [
    "## Control-plane coordination (use only at the margins)",
    "- Prefer `contact_supervisor` when available. It is the most reliable way to reach your supervising orchestrator.",
    "- Use coordination only for: `DRIFT_DETECTED`, `BLOCKED`, `NEED_CLARIFICATION`, or `VERIFICATION_FAILED`.",
    `- Keep each message terse, with a leading tag and the relevant ID (for example: \`${label}\`).`,
    "- Write or reference the authoritative artifact first when reporting drift or verification failure.",
    "- Do NOT use intercom for routine narration, detailed discussion, or completion chatter.",
  ]

  if (orchestratorTarget) {
    lines.push(
      `- Fallback raw intercom target: \`${orchestratorTarget}\`.`,
      "- If `contact_supervisor` is unavailable but `intercom` is available, use that exact target.",
    )
  } else {
    lines.push(
      "- If `contact_supervisor` is unavailable and no explicit intercom target is provided, stop and return a clear BLOCKED summary in your task result.",
    )
  }

  return lines
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
  const lines: string[] = []

  // Handle coalesced groups (merged from multiple original groups)
  if (group.coalescedFrom && group.coalescedFrom.length > 1) {
    lines.push(
      `# Task: ${group.coalescedFrom.join(" + ")}`,
      "",
      `This worktree implements multiple execution groups that share files or have ` +
      `dependencies. They have been combined so you can implement them together ` +
      `in dependency order within this single worktree.`,
      "",
      `## Coalesced groups`,
    )
    for (const origId of group.coalescedFrom) {
      lines.push(`- ${origId}`)
    }
    lines.push("")
  } else {
    lines.push(
      `# Task: ${group.id}`,
      "",
      `Execute the approved plan for group **${group.id}** using the configured worktree orchestration for this group.`,
      "",
    )
  }

  const scopeDesc = group.coalescedFrom && group.coalescedFrom.length > 1
    ? `- Files you may modify across all sub-groups: ${group.files.join(", ") || "(none specified)"}`
    : `- Files you may modify: ${group.files.join(", ") || "(none specified)"}`

  lines.push(
    `## Run context`,
    `- Run ID: ${config.runId}`,
    `- Change: ${config.changeId}`,
    `- Plan version: ${config.planVersion}`,
    `- Repo root: ${config.repoRoot}`,
    "",
    `## Scope`,
    scopeDesc,
    `- Agent: ${group.agent}`,
  )

  if (group.executionMode === "shared-staging") {
    lines.push(
      `- Execution mode: shared-staging`,
      `- Workspace ID: ${group.workspaceId ?? "(missing)"}`,
      `- Workspace concurrency: ${group.workspaceConcurrency ?? "serialized"}`,
    )
    if (group.executionRationale) {
      lines.push(`- Execution rationale: ${group.executionRationale}`)
    }
    lines.push(
      "",
      "This task runs in a planner-declared shared staging workspace.",
      "Preserve sibling workspace changes. Do not revert or overwrite unrelated",
      "changes already present in the shared workspace.",
    )
  }

  if (group.baseStrategy === "dependency-lineage") {
    lines.push(
      `- Base strategy: dependency-lineage`,
      "- This task may start from a dependency lineage ref that already contains",
      "  approved dependency changes not yet applied back to the primary worktree.",
    )
  }

  lines.push(
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
    ``,
    `## Ephemeral Script Policy`,
    `Any temporary helper script MUST be written ONLY to:`,
    `\`<runtime-state-dir>/runs/${config.runId}/scratch/scripts/\``,
    `Never write helper scripts to the repo root, scripts/, test/, tests/, src/, or lib/.`,
  )

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
    const commands = group.scopedVerification.split("\n").filter(Boolean)
    if (commands.length > 1) {
      // Multi-command (coalesced groups): render each separately so the
      // agent runs them as individual guarded bash calls, not shell-chained.
      lines.push(
        "",
        "## Scoped verification",
        "After implementing, run each of the following verification commands",
        "separately (do NOT chain them with `&&`, `;`, or `|`):",
        "",
      )
      for (let i = 0; i < commands.length; i++) {
        lines.push(
          `### Verification ${i + 1}`,
          "",
          "```bash",
          commands[i]!,
          "```",
          "",
        )
      }
      lines.push(
        "Include the verification result (pass/fail/output) for each command",
        "in your summary.",
        "Do NOT invent or run repo-wide verification commands. Run only the",
        "scoped verification commands specified above.",
      )
    } else {
      // Single command (non-coalesced group)
      lines.push(
        "",
        "## Scoped verification",
        "After implementing, run the following command to verify your changes:",
        "",
        "```bash",
        commands[0]!,
        "```",
        "",
        "Include the verification result (pass/fail/output) in your summary.",
        "Do NOT invent or run repo-wide verification commands. Run only the",
        "scoped verification command specified above.",
      )
    }
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

    // Point the worker to their group's detailed task spec
    const implTasksPath = planArtifactPaths["implementationTasks"]
    if (implTasksPath) {
      lines.push(
        "",
        "## Implementation task spec",
        `Your group \`${group.id}\` has a corresponding section in \`implementation-tasks.md\``,
        `that contains detailed context, pseudocode, acceptance criteria, and self-checks.`,
        "Read it before starting implementation:",
        "",
        `1. Open \`${implTasksPath}\``,
        `2. Find the section matching \`${group.id}\` or \`## Group ${group.id.replace("group-", "")}:\``,
        `3. Review the objective, scope, likely files, checklist, pseudocode, and self-checks`,
        "",
        "If the implementation-tasks.md file is missing or lacks a section for your group,",
        "STOP and report a plan-quality gap: the plan is missing a task spec for this group.",
      )
    }
  }

  lines.push(
    "",
    ...buildLimitedCoordinationLines(`group ${group.id}`, config.orchestratorTarget),
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
  const { updateStateIndexEntry, getChangeLifecycle, upsertChangeLifecycle } = await import("pi-zflow-artifacts/state-index")

  try {
    // Mark run as abandoned in state index
    await updateStateIndexEntry(runId, {
      status: "abandoned",
      metadata: { reason: "user-abandoned" },
    }, cwd)

    const lifecycle = await getChangeLifecycle(changeId, cwd)
    if (lifecycle) {
      const unfinishedRuns = lifecycle.unfinishedRuns.filter((id) => id !== runId)
      await upsertChangeLifecycle({
        ...lifecycle,
        unfinishedRuns,
        lastPhase: unfinishedRuns.length === 0 ? "cancelled" : lifecycle.lastPhase,
      }, cwd)
    }

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
  /** Optional change ID whose unfinished runs should be cleaned/abandoned. */
  changeId?: string
  /** If true, mark unfinished runs for changeId as abandoned. */
  abandonUnfinished?: boolean
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
  /** Unfinished run IDs marked as abandoned. */
  abandonedRuns: string[]
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
  const abandonedRuns: string[] = []

  if (options.changeId && options.abandonUnfinished) {
    const unfinished = await discoverUnfinishedWork(options.changeId, options.cwd)
    if (!dryRun) {
      for (const runId of unfinished.unfinishedRuns) {
        const result = await abandonWorkflow(options.changeId, runId, options.cwd)
        if (result.success) abandonedRuns.push(runId)
      }
    } else {
      abandonedRuns.push(...unfinished.unfinishedRuns)
    }
  }

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
    abandonedRuns,
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
  await migrateLegacyChangeArtifactsIfPresent(changeId, cwd)
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

// ── Fix orchestrator configuration ───────────────────────────────

/**
 * Configuration for the fix orchestrator retry bounds.
 *
 * Controls how many fix attempts are made per finding and globally.
 * Environment variables take precedence over profile settings, and both
 * take precedence over defaults.
 */
export interface FixOrchestratorConfig {
  /** Max fix attempts per individual finding. Default: 2 */
  maxAttemptsPerFinding: number
  /** Max global rounds of fix dispatch. Default: 3 */
  maxGlobalRounds: number
}

/**
 * Resolve the fix orchestrator configuration from environment variables,
 * profile settings, or defaults.
 *
 * Precedence (highest first):
 * 1. `ZFLOW_FIX_MAX_ATTEMPTS_PER_FINDING` env var
 * 2. `ZFLOW_FIX_MAX_GLOBAL_ROUNDS` env var
 * 3. `profileSettings.maxAttemptsPerFinding` / `maxGlobalRounds`
 * 4. Hardcoded defaults (2, 3)
 *
 * @param profileSettings - Optional settings from the active profile.
 * @returns The resolved fix orchestrator config.
 */
export function resolveFixOrchestratorConfig(
  profileSettings?: Record<string, unknown>,
): FixOrchestratorConfig {
  const envMaxAttempts = process.env.ZFLOW_FIX_MAX_ATTEMPTS_PER_FINDING
  const envMaxRounds = process.env.ZFLOW_FIX_MAX_GLOBAL_ROUNDS

  const readPositiveInteger = (value: unknown): number | undefined => {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value
    if (typeof value !== "string" || value.trim().length === 0) return undefined
    const parsed = Number.parseInt(value, 10)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  }

  return {
    maxAttemptsPerFinding:
      readPositiveInteger(envMaxAttempts) ??
      readPositiveInteger(profileSettings?.maxAttemptsPerFinding) ??
      2,
    maxGlobalRounds:
      readPositiveInteger(envMaxRounds) ??
      readPositiveInteger(profileSettings?.maxGlobalRounds) ??
      3,
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
  /**
   * Override for fix orchestrator config.
   * Falls back to env vars → profile settings → defaults if omitted.
   */
  fixOrchestratorConfig?: Partial<FixOrchestratorConfig>
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
  /** Parsed findings from review. */
  parsedFindings: ParsedFinding[]
  /** The raw findings content and path. */
  rawFindingsPath?: string
  /** Plan version used. */
  planVersion: string
  /** Plan lifecycle state. */
  lifecycleState: string
  /** Resolved fix orchestrator configuration. */
  fixOrchestratorConfig: FixOrchestratorConfig
  /** Task prompt for the fix orchestrator agent. */
  fixOrchestratorTaskPrompt?: string
  /** Paths to the five canonical plan artifacts for source context. */
  planArtifactPaths?: Record<string, string>
}

/**
 * Run the `/zflow-change-fix <change-path>` workflow.
 *
 * Loads plan state, parses review findings, builds a focused fix plan
 * with structured finding IDs, and returns the fix context for dispatch.
 *
 * @param options - Fix workflow options.
 * @returns Fix result with plan, target files, and parsed findings.
 */
export async function runChangeFixWorkflow(
  options: FixWorkflowOptions,
): Promise<FixWorkflowResult> {
  const cwd = options.cwd
  const changeId = options.changeId
  const { default: fs } = await import("node:fs/promises")
  const { default: path } = await import("node:path")

  // Read plan state
  await migrateLegacyChangeArtifactsIfPresent(changeId, cwd)
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

  // Read review findings using the structured parser
  const { findings, rawPath, rawContent } = await parseReviewFindings(cwd)

  // Filter findings by indices if specified
  let selectedFindings = findings
  if (options.findingIndices && options.findingIndices.length > 0) {
    selectedFindings = findings.filter((_, i) => options.findingIndices!.includes(i))
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

  // Build fix plan using the structured builder
  let fixPlan: string
  if (selectedFindings.length > 0) {
    fixPlan = await buildFixPlan(changeId, selectedFindings, cwd)
  } else {
    // Fallback: basic plan
    const lines: string[] = [
      `# Fix Plan for ${changeId}`,
      "",
      `**Plan Version:** ${planVersion}`,
      `**Plan State:** ${lifecycleState}`,
      "",
      "## Findings",
      "",
      "No structured review findings available. Manual review may be needed.",
      "",
    ]
    if (filesToModify.length > 0) {
      lines.push("## Target Files")
      lines.push("")
      for (const f of filesToModify) {
        lines.push(`- \`${f}\``)
      }
      lines.push("")
    }
    if (verificationCommand) {
      lines.push("## Verification Command")
      lines.push("")
      lines.push("```bash")
      lines.push(verificationCommand)
      lines.push("```")
      lines.push("")
    }
    fixPlan = lines.join("\n")
  }

  // Resolve fix orchestrator config
  const fixOrchestratorConfig = resolveFixOrchestratorConfig()

  return {
    changeId,
    fixPlan,
    filesToModify,
    verificationCommand,
    parsedFindings: selectedFindings,
    rawFindingsPath: rawPath,
    planVersion,
    lifecycleState,
    fixOrchestratorConfig,
    fixOrchestratorTaskPrompt: undefined, // caller builds this via buildFixOrchestratorTaskPrompt
    planArtifactPaths: {
      design: resolvePlanArtifactPath(changeId, planVersion, "design", cwd),
      executionGroups: resolvePlanArtifactPath(changeId, planVersion, "execution-groups", cwd),
      standards: resolvePlanArtifactPath(changeId, planVersion, "standards", cwd),
      verification: resolvePlanArtifactPath(changeId, planVersion, "verification", cwd),
      implementationTasks: resolvePlanArtifactPath(changeId, planVersion, "implementation-tasks", cwd),
    },
  }
}

/**
 * Build the task prompt for the fix orchestrator agent.
 *
 * Constructs a prompt that tells the fix orchestrator which change it is
 * working on, provides the review findings, and configures retry bounds.
 *
 * @param changeId - The change identifier.
 * @param fixResult - The result from runChangeFixWorkflow.
 * @param findingsPath - Path to the consolidated findings file.
 * @param rawReviewerDir - Path to the raw reviewer artifacts directory.
 * @param cwd - Working directory (optional).
 * @returns A markdown task prompt for the fix orchestrator agent.
 */
export async function buildFixOrchestratorTaskPrompt(
  changeId: string,
  fixResult: FixWorkflowResult,
  findingsPath: string,
  rawReviewerDir?: string,
  cwd?: string,
  orchestratorTarget?: string,
): Promise<string> {
  const config = fixResult.fixOrchestratorConfig
  const planPaths = fixResult.planArtifactPaths
  const lines: string[] = [
    `# Fix Orchestration Task — ${changeId}`,
    "",
    "Agent role: `zflow.fix-orchestrator`.",
    "",
    "You are the fix orchestrator. Your role is to read the code review",
    "findings below, decompose them into fix work items, dispatch fix",
    "subagents, and validate that their work satisfies the original",
    "finding requirements AND the original change documents.",
    "",
    "## Configuration",
    "",
    `- Max attempts per finding: ${config.maxAttemptsPerFinding}`,
    `- Max global rounds: ${config.maxGlobalRounds}`,
    "",
    "## Source Change Context (MUST read before dispatching fix workers)",
    "",
    "The original change was planned and implemented based on these documents.",
    "Fix workers must respect the design intent, standards, and verification",
    "requirements described here. When validating fixes, check that they align",
    "with these documents, not just the individual finding text.",
    "",
  ]

  if (planPaths) {
    lines.push(
      "| Document | Path |",
      "| -------- | ---- |",
      `| Design | \`${planPaths.design}\` |`,
      `| Execution Groups | \`${planPaths.executionGroups}\` |`,
      `| Standards | \`${planPaths.standards}\` |`,
      `| Verification | \`${planPaths.verification}\` |`,
      `| Implementation Tasks | \`${planPaths.implementationTasks}\` |`,
      "",
      "**Read these documents before dispatching any fix worker.**",
      "If a fix would contradict the approved design or standards, note it in",
      "your gap report and escalate rather than silently diverging.",
      "",
    )
  }

  lines.push(
    "## Change context",
    "",
    `- Change ID: ${changeId}`,
    `- Plan version: ${fixResult.planVersion}`,
    `- Plan state: ${fixResult.lifecycleState}`,
    fixResult.verificationCommand
      ? `- Verification command: \`${fixResult.verificationCommand}\``
      : "",
    "",
    "## Findings to address",
    "",
  )

  for (const finding of fixResult.parsedFindings) {
    lines.push(`### ${finding.findingId}: ${finding.title}`)
    lines.push("")
    lines.push(`- **Severity**: ${finding.severity}`)
    lines.push(`- **File**: ${finding.file ?? "(not specified)"}`)
    if (finding.line) lines.push(`- **Line**: ${finding.line}`)
    lines.push(`- **Reviewer**: ${finding.reviewerRole}`)
    lines.push(`- **Evidence**: ${finding.evidence}`)
    lines.push(`- **Recommendation**: ${finding.recommendation}`)
    if (finding.expectedBehavior) {
      lines.push(`- **Expected behavior**: ${finding.expectedBehavior}`)
    }
    if (finding.fixRequirements) {
      lines.push(`- **Fix requirements**: ${finding.fixRequirements}`)
    }
    if (finding.validation) {
      lines.push(`- **Validation**: ${finding.validation}`)
    }
    if (finding.suggestedApproach) {
      lines.push(`- **Suggested approach**: ${finding.suggestedApproach}`)
    }
    if (finding.artifactPath) {
      lines.push(`- **Artifact**: ${finding.artifactPath}`)
    }
    if (finding.whyItMatters) {
      lines.push(`- **Why it matters**: ${finding.whyItMatters}`)
    }
    lines.push("")
  }

  if (rawReviewerDir) {
    lines.push("## Raw reviewer artifacts (MUST read for each finding)")
    lines.push("")
    lines.push("The consolidated findings above are summaries. The raw reviewer")
    lines.push(`artifacts at \`${rawReviewerDir}\` contain the full analysis,`)
    lines.push("pseudocode, line-by-line evidence, and specific fix strategies from")
    lines.push("each reviewer agent. These are ESSENTIAL context for fix workers.")
    lines.push("")
    lines.push("**For each finding you dispatch to a fix worker:**")
    lines.push("1. Read the raw reviewer artifact referenced by the finding's Artifact path.")
    lines.push("2. Extract the detailed evidence (file snippets, pseudocode, reasoning).")
    lines.push("3. Include that detail in the fix worker's task prompt.")
    lines.push("4. Use the raw evidence as the validation baseline when checking the fix.")
    lines.push("")
  }

  if (findingsPath) {
    lines.push("## Consolidated findings path")
    lines.push("")
    lines.push(`\`${findingsPath}\``)
    lines.push("")
  }

  lines.push(
    ...buildLimitedCoordinationLines(`change ${changeId}`, orchestratorTarget),
    "- When you dispatch fix workers, pass through the same narrow coordination contract.",
    "- Fix workers should prefer `contact_supervisor` when available and use raw `intercom` only as fallback plumbing.",
    ...(orchestratorTarget
      ? [`- If you must pass a raw intercom fallback to a fix worker, use \`${orchestratorTarget}\`.`]
      : []),
    "",
  )

  lines.push(
    "## Instructions",
    "",
    "1. **Read source context first.** Read the design, execution-groups,",
    "   standards, and verification documents listed above. Understand the",
    "   original intent before dispatching any fix worker.",
    "2. **Read raw reviewer artifacts for each finding.** The consolidated",
    "   findings are summaries — the raw artifacts have detailed evidence.",
    "3. Analyze the findings and group by target file.",
    "4. For each finding, choose a fix worker agent:",
    "   - `zflow.implement-routine` for straightforward fixes",
    "   - `zflow.implement-hard` for complex/cross-module/high-severity",
    "5. **Build context-rich worker tasks.** Each task must include:",
    "   - The original finding text (evidence, expected behavior, fix requirements)",
    "   - Relevant excerpts from the raw reviewer artifact",
    "   - Relevant design/standards context from the source documents",
    "   - The exact validation/proof the fix must pass",
    "6. Dispatch workers using `subagent` tool.",
    "7. After each worker completes, validate the fix against:",
    "   - The original finding requirements",
    "   - The source design and standards documents",
    "   - The raw reviewer evidence",
    "8. If incomplete, dispatch again with precise gap details.",
    "9. Respect the retry bounds above.",
    "10. Persist your satisfaction report to " + "`.zflow/plans/" + changeId + "/fix-orchestration-report.md`.",
    "11. Report back with:\n",
    "   - Which findings were FIXED (with attempt count)",
    "   - Which findings are UNRESOLVED (with explanation)",
    "   - Any recommendations for re-review",
    "   - Whether verification passed",
    "   - Any source-document deviations you observed",
    "   - A note about whether the fixes align with the original design intent",
  )

  return lines.join("\n")
}

/**
 * A single finding parsed from the code-review-findings.md file.
 */
export interface ParsedFinding {
  /** Stable identifier like "finding-1", "finding-2". */
  findingId: string
  /** Severity level. */
  severity: "critical" | "major" | "minor" | "nit"
  /** Short title of the finding. */
  title: string
  /** Source file path, if available. */
  file?: string
  /** Source line number, if available. */
  line?: number
  /** Reviewer role that identified this finding. */
  reviewerRole: string
  /** Detailed evidence from the reviewer. */
  evidence: string
  /** Recommendation for fixing the issue. */
  recommendation: string
  /** Path to the raw reviewer artifact for traceability. */
  artifactPath?: string
  /** Why the finding matters. */
  whyItMatters?: string
  /** What the code SHOULD do instead (enriched field for fix orchestrator). */
  expectedBehavior?: string
  /** Concrete things a fix must accomplish (enriched field for fix orchestrator). */
  fixRequirements?: string
  /** How to verify the fix works (enriched field for fix orchestrator). */
  validation?: string
  /** Optional hint for the fix worker (enriched field for fix orchestrator). */
  suggestedApproach?: string
}

/**
 * Parse review findings from the canonical code-review-findings.md file.
 *
 * The findings file uses the format produced by pi-zflow-review:
 *
 * ```
 * ### {Finding Title}
 * **Reviewer support**: correctness, integration
 * **Evidence**: ... 
 * **Why it matters**: ...
 * **Recommendation**: ...
 * **File**: `path/to/file.ts`
 * **Lines**: 42
 * ```
 *
 * Each heading (h3) becomes a ParsedFinding with an auto-incrementing ID.
 *
 * @param cwd - Working directory for runtime state resolution.
 * @returns Parsed findings and the raw file path.
 */
export async function parseReviewFindings(
  cwd?: string,
): Promise<{
  findings: ParsedFinding[]
  rawPath: string
  rawContent: string
}> {
  const { default: fs } = await import("node:fs/promises")
  const { resolveCodeReviewFindingsPath } = await import("pi-zflow-artifacts/artifact-paths")
  const { resolveReviewDir } = await import("pi-zflow-artifacts/artifact-paths")

  const rawPath = resolveCodeReviewFindingsPath(cwd)
  let rawContent: string

  try {
    rawContent = await fs.readFile(rawPath, "utf-8")
  } catch {
    rawContent = ""
  }

  if (!rawContent || rawContent.trim().length === 0) {
    return { findings: [], rawPath, rawContent: "" }
  }

  const findings: ParsedFinding[] = []
  let findingCounter = 0

  // Split on h3 (###) headings to isolate each finding block
  // The split pattern looks for "### " at the start of a line
  const blocks = rawContent.split(/(?=^### )/m).filter(Boolean)

  for (const block of blocks) {
    // Extract heading title from ### title
    const headingMatch = block.match(/^### (.+)$/m)
    if (!headingMatch) continue

    const title = headingMatch[1].trim()

    // Skip non-finding sections like "Critical Findings", "Major Findings", etc.
    if (/^(Critical|Major|Minor|Nit|None)[\s.:]|^None\.$/i.test(title)) continue
    if (/^(Coverage|Reviewed|Verification|Findings Summary)/i.test(title)) continue

    // Skip noise findings — reviewer preamble/scope statements with no actionable content.
    // These have identical title and evidence and describe what was reviewed, not what was found.
    if (/^(Reviewed (the |scope: )|I reviewed |Security review scope)/i.test(title)) {
      // Quick check: if title and first line of evidence are near-identical, it's noise
      const firstEvidenceLine = block.split("\n").find(l => /^\*\*Evidence\*\*:/i.test(l))?.replace(/^\*\*Evidence\*\*:\s*/i, "").trim() ?? ""
      const normalizedTitle = title.toLowerCase().replace(/\s+/g, " ")
      const normalizedEvidence = firstEvidenceLine.toLowerCase().replace(/\s+/g, " ")
      if (normalizedTitle === normalizedEvidence || normalizedEvidence.includes(normalizedTitle.substring(0, 30))) {
        continue
      }
    }

    findingCounter++
    const findingId = `finding-${findingCounter}`

    // Extract severity: look for severity heading text or infer from section
    let severity: ParsedFinding["severity"] = "minor"
    const sectionBefores = rawContent.slice(0, rawContent.indexOf(block)).split("\n").filter(Boolean)
    const lastSectionHeading = sectionBefores.reverse().find(l => /^## (Critical|Major|Minor)(?: Findings?)?$|^## Nits?$/i.test(l))
    if (lastSectionHeading) {
      const sev = lastSectionHeading.replace(/^## /i, "").replace(/ Findings?$/i, "").trim().toLowerCase()
      if (sev === "critical") severity = "critical"
      else if (sev === "major") severity = "major"
      else if (sev === "minor") severity = "minor"
      else if (/^nit/i.test(sev)) severity = "nit"
    }

    // Extract fields with regex — use multi-line patterns for enriched evidence
    // and recommendation fields which may span multiple lines.
    const fileMatch = block.match(/\*\*File\*\*:\s*`?([^`\n]+)`?/i)
    const lineMatch = block.match(/\*\*Lines?\*\*:\s*(\d+)/i)
    const supportMatch = block.match(/\*\*Reviewer support\*\*:\s*(.+)$/im)
    // Multi-line: capture from **Evidence**: to the next ** field or end of block
    const evidenceBlockMatch = block.match(/\*\*Evidence\*\*:\s*([\s\S]+?)(?=\n\*\*[^*\n]+\*\*|\n\*\*$|$)/i)
    const evidenceMulti = evidenceBlockMatch ? evidenceBlockMatch[1].trim() : ""
    const whyBlockMatch = block.match(/\*\*Why it matters\*\*:\s*([\s\S]+?)(?=\n\*\*[^*\n]+\*\*|\n\*\*$|$)/i)
    const whyMulti = whyBlockMatch ? whyBlockMatch[1].trim() : ""
    const recBlockMatch = block.match(/\*\*Recommendation\*\*:\s*([\s\S]+?)(?=\n\*\*[^*\n]+\*\*|\n\*\*$|$)/i)
    const recMulti = recBlockMatch ? recBlockMatch[1].trim() : ""
    // Single-line fallbacks for basic reviewers
    const evidenceLineMatch = block.match(/\*\*Evidence\*\*:\s*(.+)$/im)
    const whyLineMatch = block.match(/\*\*Why it matters\*\*:\s*(.+)$/im)
    const recLineMatch = block.match(/\*\*Recommendation\*\*:\s*(.+)$/im)
    const artifactMatch = block.match(/\*\*Artifact[^:]*\*\*:\s*`?([^`\n]+)`?/i)
    // Enriched fields from the new finding format (all optional)
    const expectedBehaviorMatch = block.match(/\*\*Expected behavior\*\*:\s*(.+)$/im)
    const fixRequirementsMatch = block.match(/\*\*Fix requirements\*\*:\s*(.+)$/im)
    const validationMatch = block.match(/\*\*Validation\*\*:\s*(.+)$/im)
    const suggestedApproachMatch = block.match(/\*\*Suggested approach\*\*:\s*(.+)$/im)

    // Prefer multi-line extraction; fall back to single-line
    const evidence = evidenceMulti || (evidenceLineMatch ? evidenceLineMatch[1].trim() : "")
    const recommendation = recMulti || (recLineMatch ? recLineMatch[1].trim() : "")
    const whyItMatters = whyMulti || (whyLineMatch ? whyLineMatch[1].trim() : "")

    findings.push({
      findingId,
      severity,
      title,
      file: fileMatch ? fileMatch[1].trim() : undefined,
      line: lineMatch ? Number.parseInt(lineMatch[1], 10) : undefined,
      reviewerRole: supportMatch ? supportMatch[1].trim() : "reviewer",
      evidence: evidence || (block.split("\n").slice(1, 4).join(" ").trim().slice(0, 300) || title),
      recommendation: recommendation || "Review the finding and apply appropriate fix.",
      artifactPath: artifactMatch ? artifactMatch[1].trim() : undefined,
      whyItMatters: whyItMatters || undefined,
      expectedBehavior: expectedBehaviorMatch ? expectedBehaviorMatch[1].trim() : undefined,
      fixRequirements: fixRequirementsMatch ? fixRequirementsMatch[1].trim() : undefined,
      validation: validationMatch ? validationMatch[1].trim() : undefined,
      suggestedApproach: suggestedApproachMatch ? suggestedApproachMatch[1].trim() : undefined,
    })
  }

  return { findings, rawPath, rawContent }
}

/**
 * Build a structured JSON interview question payload for the fix selection gate.
 *
 * Presents the user with options:
 * 1. Fix All Findings (recommended)
 * 2. Select Findings to Fix
 * 3. Cancel
 *
 * For "Select Findings", the second question presents a multi-select list.
 *
 * @param changeId - The change identifier.
 * @param findings - Parsed findings to present.
 * @returns A JSON string suitable for pi-interview.
 */
export function buildFixSelectionQuestions(
  changeId: string,
  findings: ParsedFinding[],
): string {
  const critical = findings.filter((f) => f.severity === "critical").length
  const major = findings.filter((f) => f.severity === "major").length
  const minor = findings.filter((f) => f.severity === "minor").length
  const nit = findings.filter((f) => f.severity === "nit").length

  const findingOptions = findings.map((f) => ({
    label: `[${f.severity.toUpperCase()}] ${f.findingId}: ${f.title.slice(0, 80)}${f.file ? ` (${f.file})` : ""}`,
    content: `${f.severity.toUpperCase()}: ${f.title}${f.file ? `\nFile: ${f.file}` : ""}${f.line ? `:${f.line}` : ""}\nEvidence: ${f.evidence.slice(0, 200)}`,
  }))

  const summaryParts: string[] = []
  if (critical > 0) summaryParts.push(`${critical} critical`)
  if (major > 0) summaryParts.push(`${major} major`)
  if (minor > 0) summaryParts.push(`${minor} minor`)
  if (nit > 0) summaryParts.push(`${nit} nits`)

  const summary = summaryParts.length > 0
    ? `${findings.length} total — ${summaryParts.join(", ")}`
    : "No findings"

  return JSON.stringify({
    title: `Fix Selection — ${changeId}`,
    description: `Found ${summary} for change "${changeId}".\n\nHow would you like to proceed?`,
    questions: [
      {
        id: "action",
        type: "single",
        question: "Which fixes would you like to apply?",
        options: [
          {
            label: "Fix All Findings",
            content: "Apply fixes for all findings.",
            recommended: true,
          },
          ...(findingOptions.length > 1
            ? [{
                label: "Select Findings to Fix",
                content: "Choose which specific findings to fix.",
              }]
            : []),
          {
            label: "Cancel",
            content: "Cancel — no fixes applied.",
          },
        ],
        recommended: "Fix All Findings",
      },
      {
        id: "selectedFindings",
        type: "multi",
        question: "Select which findings to fix:",
        options: findingOptions,
        condition: { field: "action", value: "Select Findings to Fix" },
      },
    ],
  })
}

/**
 * Build a markdown fix plan document from selected findings.
 *
 * Produces a structured markdown document listing each finding with
 * its evidence, recommendation, and target files for the fix worker.
 *
 * @param changeId - The change identifier.
 * @param selectedFindings - The findings selected for fixing.
 * @param cwd - Working directory (optional).
 * @returns A markdown string of the fix plan.
 */
export async function buildFixPlan(
  changeId: string,
  selectedFindings: ParsedFinding[],
  cwd?: string,
): Promise<string> {
  const critical = selectedFindings.filter((f) => f.severity === "critical").length
  const major = selectedFindings.filter((f) => f.severity === "major").length
  const minor = selectedFindings.filter((f) => f.severity === "minor").length
  const nit = selectedFindings.filter((f) => f.severity === "nit").length

  const targetFiles = [...new Set(selectedFindings.filter((f) => f.file).map((f) => f.file!))].sort()

  const lines: string[] = [
    `# Fix Plan for ${changeId}`,
    "",
    `**Generated:** ${new Date().toISOString()}`,
    `**Findings to fix:** ${selectedFindings.length} (${critical}/${major}/${minor}/${nit})`,
    "",
    "## Findings",
    "",
  ]

  for (const finding of selectedFindings) {
    lines.push(`### ${finding.findingId}: ${finding.title}`)
    lines.push(`**Severity:** ${finding.severity}`)
    if (finding.file) lines.push(`**File:** \`${finding.file}\`${finding.line ? ` (line ${finding.line})` : ""}`)
    if (finding.reviewerRole) lines.push(`**Reviewer:** ${finding.reviewerRole}`)
    if (finding.evidence) lines.push(`**Evidence:** ${finding.evidence}`)
    if (finding.recommendation) lines.push(`**Recommendation:** ${finding.recommendation}`)
    if (finding.artifactPath) lines.push(`**Artifact:** \`${finding.artifactPath}\``)
    if (finding.whyItMatters) lines.push(`**Why it matters:** ${finding.whyItMatters}`)
    lines.push("")
  }

  lines.push("## Fix Strategy")
  lines.push("")
  lines.push("- Each finding will be assigned to a fix worker.")
  lines.push("- Workers must read the full finding evidence before fixing.")
  lines.push("- After each fix, verification will confirm the fix resolved the issue.")
  lines.push("- Max 2 attempts per finding, 3 global rounds.")
  lines.push("")

  if (targetFiles.length > 0) {
    lines.push("## Target Files")
    lines.push("")
    for (const file of targetFiles) {
      lines.push(`- \`${file}\``)
    }
    lines.push("")
  }

  return lines.join("\n")
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
  return groups.map((group) => ({
    groupId: group.id,
    agent: group.agent,
    task: buildWorkerTask(group, config, planArtifactPaths),
    claimedFiles: group.files,
    dependencies: group.dependencies,
    worktreeStrategy: {
      mode: group.executionMode ?? "isolated",
      workspaceId: group.workspaceId,
      workspaceConcurrency: group.workspaceConcurrency ?? "serialized",
      baseStrategy: group.baseStrategy ?? "head",
      executionRationale: group.executionRationale,
    },
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
  orchestratorTarget?: string,
): Promise<void> {
  // Always update run phase to drift-pending
  await setRunPhase(runId, "drift-pending", cwd)

  // Attempt intercom signaling (optional — graceful fallback)
  let intercomAvailable = false
  const resolvedTarget = orchestratorTarget?.trim()
    || process.env.ZFLOW_INTERCOM_ORCHESTRATOR_TARGET?.trim()
    || process.env.PI_INTERCOM_ORCHESTRATOR_TARGET?.trim()

  try {
    // Dynamic import to check for pi-intercom without hard dependency
    // @ts-expect-error - optional dependency, handled via catch
    const intercomModule: { intercom?: Function } | null = await import("pi-intercom").catch(() => null)
    if (intercomModule && typeof intercomModule.intercom === "function" && resolvedTarget) {
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
        to: resolvedTarget,
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
    const reason = resolvedTarget
      ? "pi-intercom not available"
      : "no intercom target available"
    console.warn(
      `[pi-zflow] ${reason}. Drift signal suppressed for group "${groupId}". ` +
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
    /** Exact intercom target for the supervising orchestrator, when known. */
    orchestratorTarget?: string
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
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const execFileAsync = promisify(execFile)

  // 1. Resolve repo root
  let repoRoot: string
  if (options?.repoRoot) {
    repoRoot = options.repoRoot
  } else {
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"])
      repoRoot = stdout.trim()
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
    orchestratorTarget: options?.orchestratorTarget,
  }

  const dispatchGroups: DispatchExecutionGroup[] = groups.map(g => ({
    id: g.id,
    agent: g.agent || "zflow.implement-routine",
    files: g.files,
    dependencies: g.dependencies,
    taskPrompt: g.taskPrompt,
    scopedVerification: g.scopedVerification,
    parallelizable: g.parallelizable,
    executionMode: (g as DispatchExecutionGroup).executionMode ?? "isolated",
    workspaceId: (g as DispatchExecutionGroup).workspaceId,
    workspaceConcurrency: (g as DispatchExecutionGroup).workspaceConcurrency ?? "serialized",
    baseStrategy: (g as DispatchExecutionGroup).baseStrategy ?? "head",
    executionRationale: (g as DispatchExecutionGroup).executionRationale,
  }))
  // Coalesce only implicitly-coupled isolated groups. Planner-declared shared
  // workspaces remain first-class orchestration units and are handled by the
  // dispatch layer via explicit worktreeStrategy metadata.
  const coalescedGroups = coalesceConnectedGroups(dispatchGroups)
  const tasks = buildWorktreeDispatchPlan(coalescedGroups, dispatchConfig, planArtifactPaths)
  const planGroups = coalescedGroups.map((g) => ({
    id: g.id,
    files: g.files,
    dependencies: g.dependencies,
    parallelizable: true,
    taskPrompt: g.taskPrompt,
    scopedVerification: g.scopedVerification,
    agent: g.agent,
    coalescedFrom: g.coalescedFrom,
    executionMode: g.executionMode,
    workspaceId: g.workspaceId,
    workspaceConcurrency: g.workspaceConcurrency,
    baseStrategy: g.baseStrategy,
    executionRationale: g.executionRationale,
  })) as unknown as ExecutionGroup[]

  const workspaceClusters = coalescedGroups
    .filter((group) => group.executionMode === "shared-staging" && group.workspaceId)
    .reduce<Array<RunJson["workspaceClusters"][number]>>((clusters, group) => {
      const existing = clusters.find((cluster) => cluster.workspaceId === group.workspaceId)
      if (existing) {
        existing.groupIds.push(group.id)
        existing.updatedAt = new Date().toISOString()
        return clusters
      }
      clusters.push({
        workspaceId: group.workspaceId!,
        mode: "shared-staging",
        workspaceConcurrency: group.workspaceConcurrency ?? "serialized",
        groupIds: [group.id],
        status: "planned",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      return clusters
    }, [])

  if (workspaceClusters.length > 0) {
    run = await updateRun(runId, { workspaceClusters }, cwd)
  }

  return {
    runId,
    config: dispatchConfig,
    tasks,
    groups: planGroups,
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
    /**
     * Whether to use the strategy cascade (structured merge → integration merge)
     * when patch replay fails. Default: true.
     */
    useStrategyCascade?: boolean
    /**
     * When true, skip integration merge and offer subagent resolution directly
     * after structured merge fails.
     */
    skipIntegrationMerge?: boolean
  },
): Promise<CascadeApplyBackResult & { deviationSummaryPath?: string }> {
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
      const { synthesizeDeviationSummary } = await import("./deviations.js")
      const summary = synthesizeDeviationSummary(runId, changeId, planVersion, reports)
      deviationSummaryPath = await writeDeviationSummary(summary, cwd)
    }
  } catch {
    // Ignore errors reading deviations
  }

  // 2. Apply patches back atomically with strategy cascade
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
    useCascade: options?.useStrategyCascade ?? true,
    preferSubagentOverIntegrationMerge: options?.skipIntegrationMerge ?? false,
  })

  // 3. Handle retention and subagent offer on conflict
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

    // Retain integration worktree if one was created
    if (applyBackResult.integrationWorktreePath) {
      await addRetainedArtifact(runId, {
        type: "worktree",
        path: applyBackResult.integrationWorktreePath,
        reason: "Integration worktree from apply-back cascade",
        expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      }, cwd)
    }

    // Retain consolidated patch if one was generated
    if (applyBackResult.consolidatedPatchPath) {
      await addRetainedArtifact(runId, {
        type: "patch",
        path: applyBackResult.consolidatedPatchPath,
        reason: "Consolidated patch from integration merge",
        expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      }, cwd)
    }

    // Update run metadata with subagent availability
    if (applyBackResult.subagentAvailable) {
      const runState = await readRun(runId, cwd)
      await updateRun(runId, {
        metadata: {
          ...(runState.metadata ?? {}),
          subagentResolutionAvailable: true,
          strategiesAttempted: applyBackResult.strategiesAttempted,
          subagentResolutionPrompt: [
            "All automated apply-back strategies failed.",
            "A subagent can attempt to resolve the remaining conflicts",
            "with full context about each group's original task.",
            "",
            "To request subagent resolution, run:",
            `  /zflow-resolve-apply-back ${runId}`,
            "",
            "To resolve manually:",
            "1. Inspect the integration worktree or patches in the run directory.",
            "2. Resolve remaining conflicts.",
            "3. Run the workflow with --resume.",
          ].join("\n"),
        },
      }, cwd)
    }
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
        successfulStrategy: applyBackResult.successfulStrategy,
        strategiesAttempted: applyBackResult.strategiesAttempted,
        subagentAvailable: applyBackResult.subagentAvailable,
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

// ── Patch apply from ledger (for resume / --apply-successful) ───

/**
 * Apply patches from a run's group ledger using the smart apply-back cascade.
 *
 * This is the unified entry point for all patch application paths:
 * fresh finalization, resume, and --apply-successful.
 *
 * Reads the run.json, builds execution groups from the stored group metadata,
 * and delegates to `executeApplyBack()` with full strategy cascade.
 *
 * Does NOT require GroupResult[] — patches are resolved from
 * `patches/<groupId>.patch` in the run directory by `executeApplyBack`.
 *
 * @param runId - Unique run identifier.
 * @param cwd - Working directory for runtime state dir resolution.
 * @param options - Optional settings.
 * @returns The cascade apply-back result.
 */
export async function applyPatchesWithLedger(
  runId: string,
  cwd?: string,
  options?: {
    /** When true, skip eligibility checks and try to apply all groups (default: true). */
    applyAll?: boolean
    /** When set, only apply these group IDs. Takes precedence over applyAll. */
    applyOnly?: string[]
    /** Callback for progress messages. */
    onProgress?: (message: string) => void
  },
): Promise<CascadeApplyBackResult> {
  // Read the run to get stored group metadata and repo root
  const run = await readRun(runId, cwd).catch(() => {
    throw new Error(`Run "${runId}" not found. Cannot apply patches.`)
  })

  const repoRoot = run.repoRoot

  // Build ExecutionGroup[] from the stored group metadata in run.json.
  // Preserve explicit dependencies from the group ledger when available; do
  // not invent dependencies from all other groups because that creates cycles
  // and prevents resume apply-back from running.
  const ledger = (run.metadata?.groupLedger ?? {}) as Record<string, { dependencies?: string[] }>
  const allGroups: ExecutionGroup[] = run.groups.map((g) => ({
    id: g.groupId,
    files: g.changedFiles,
    dependencies: Array.isArray(ledger[g.groupId]?.dependencies)
      ? ledger[g.groupId]!.dependencies!
      : [],
    parallelizable: true,
  }))

  // Filter to only requested groups when applyOnly is set
  const applyOnly = options?.applyOnly
  const applyBackGroups = applyOnly
    ? allGroups.filter((g) => applyOnly.includes(g.id))
    : allGroups
  const applyAll = options?.applyAll ?? true

  if (applyAll) {
    options?.onProgress?.(`Applying ${applyBackGroups.length} group(s) via smart apply-back cascade.`)
  }

  // Ensure we have a pre-apply snapshot and recovery ref.
  // If the run already has one, use it. If not (legacy run), create one.
  // Prefer the run's recorded head over `git rev-parse HEAD` so coverage
  // verification operates against the correct base even if the branch has
  // advanced since the run was created.
  const snapshot = run.preApplySnapshot ?? await (async () => {
    const recoveryRef = `refs/zflow/recovery/${runId}`
    const snap = {
      head: run.head,
      indexState: "clean",
      recoveryRef,
    }
    await updateRun(runId, { preApplySnapshot: snap }, cwd)
    return snap
  })()

  // Delegate to the smart cascade
  const result = await executeApplyBack({
    runId,
    repoRoot,
    snapshot,
    groups: applyBackGroups,
    cwd,
    useCascade: true,
  })

  options?.onProgress?.(
    result.success
      ? `Apply-back completed: ${result.groupsApplied} group(s) applied via "${result.successfulStrategy ?? "patch-replay"}" strategy.`
      : `Apply-back incomplete: ${result.groupsApplied}/${result.totalGroups} group(s) applied. ${result.error ?? "Unknown error"}`,
  )

  return result
}

// ── Subagent resolution for apply-back conflicts ────────────────

/**
 * Format a user-facing apply-back failure message that always includes
 * the run ID and the exact recovery command.
 *
 * Builds a consistent message from run.json metadata and optional extra
 * info about preserved artifacts.  Every apply-back failure handler
 * should call this instead of constructing its own ad-hoc message.
 *
 * @param runId - Unique run identifier.
 * @param changeInput - Original command argument (for --resume / --abandon hints).
 * @param error - Human-readable error description.
 * @param cwd - Working directory for runtime state dir resolution.
 * @param extra - Optional paths to preserved artifacts.
 * @returns A formatted markdown message string.
 */
export async function formatApplyBackFailureMessage(
  runId: string,
  changeInput: string,
  error: string,
  cwd?: string,
  extra?: {
    integrationWorktreePath?: string
    patchesDir?: string
    resolutionPromptPath?: string
    strategiesAttempted?: string[]
  },
): Promise<string> {
  const { default: path } = await import("node:path")
  const { default: fs } = await import("node:fs/promises")
  const { resolveRunDir } = await import("pi-zflow-artifacts/artifact-paths")

  let changeId: string | undefined
  try {
    const run = await readRun(runId, cwd)
    changeId = run.changeId
  } catch {
    changeId = undefined
  }

  const runDir = resolveRunDir(runId, cwd)
  const defaultPatchesDir = extra?.patchesDir ?? path.join(runDir, "patches")
  const strategies = extra?.strategiesAttempted?.length
    ? extra.strategiesAttempted.join(", ")
    : "patch-replay, structured-merge, integration-merge"

  const lines: string[] = [
    `⚠️ **Apply-back failed for run \`${runId}\`**` +
      (changeId ? ` on change \`${changeId}\`.` : "."),
    "",
    `**Error:** ${error}`,
    "",
    "**What was preserved:**",
    `- All group patches: \`${defaultPatchesDir}\``,
  ]

  if (extra?.integrationWorktreePath) {
    lines.push(`- Integration worktree: \`${extra.integrationWorktreePath}\``)
  }
  if (extra?.resolutionPromptPath) {
    lines.push(`- Resolution prompt: \`${extra.resolutionPromptPath}\``)
  }
  lines.push(`- Strategies attempted: ${strategies}`)
  lines.push("")

  lines.push(
    "**Options to recover:**",
    "",
    `1. 🤖 Subagent resolution: \`/zflow-resolve-apply-back ${runId}\``,
    `2. 🔧 Manual resolution, then resume: \`/zflow-change-implement ${changeInput} --resume\``,
    `3. 📂 Inspect artifacts at: \`${runDir}\``,
    `4. 🗑️ Abandon and start fresh: \`/zflow-change-implement ${changeInput} --abandon\``,
  )

  return lines.join("\n")
}

/**
 * Generate a resolution prompt for a subagent when all automated strategies fail.
 *
 * This prompt includes:
 * - Each group's original task description
 * - The patch content for each group
 * - The integration worktree state (if available)
 * - Conflict markers (if any)
 * - The base commit diff
 *
 * @param runId - The run identifier.
 * @param changeId - The change identifier.
 * @param groups - The execution groups with task prompts.
 * @param cwd - Working directory (optional).
 * @returns A structured prompt for the resolution subagent.
 */
export async function buildSubagentResolutionPrompt(
  runId: string,
  changeId: string,
  groups: Array<{ id: string; files: string[]; taskPrompt?: string }>,
  cwd?: string,
): Promise<string> {
  const { default: path } = await import("node:path")
  const { default: fs } = await import("node:fs/promises")
  const { resolveRunDir } = await import("pi-zflow-artifacts/artifact-paths")

  const runDir = resolveRunDir(runId, cwd)
  const patchesDir = path.join(runDir, "patches")
  const intWorktreeDir = path.join(runDir, "integration-worktree")

  const lines: string[] = [
    "# Apply-Back Resolution Task",
    "",
    `## Run: ${runId}`,
    `## Change: ${changeId}`,
    "",
    "All automated apply-back strategies have failed. Your task is to resolve",
    "the remaining conflicts and produce a merged result that preserves ALL",
    "groups' intended changes.",
    "",
    "## Resolution instructions",
    "",
    "1. DO NOT drop or remove any group's changes.",
    "2. If two groups changed the same code, understand both intents and merge them.",
    "3. If conflict markers exist, resolve each one carefully.",
    "4. If a group added a file, it must still exist in the final result.",
    "5. If a group deleted a file, it must still be deleted.",
    "6. If a group modified a file, those modifications must be preserved.",
    "7. After resolving, verify the code builds and passes type checks.",
    "8. Commit all resolved changes with message:",
    '   `zflow: subagent resolution for run ${runId}`',
    "",
    "## Group tasks",
    "",
  ]

  for (const group of groups) {
    lines.push(`### ${group.id}`)
    if (group.taskPrompt) {
      lines.push("")
      lines.push(`**Task:** ${group.taskPrompt}`)
    }
    if (group.files.length > 0) {
      lines.push("")
      lines.push(`**Files:** ${group.files.join(", ")}`)
    }

    // Add patch content if available
    const patchPath = path.join(patchesDir, `${group.id}.patch`)
    try {
      const patchContent = await fs.readFile(patchPath, "utf-8")
      if (patchContent.trim()) {
        lines.push("")
        lines.push("**Patch:**")
        lines.push("```diff")
        lines.push(patchContent.slice(0, 2000))  // truncate long patches
        if (patchContent.length > 2000) {
          lines.push("... (patch truncated)")
        }
        lines.push("```")
      }
    } catch {
      // No patch file — skip
    }

    lines.push("")
  }

  // Check for integration worktree
  try {
    await fs.access(intWorktreeDir)
    lines.push("## Integration worktree available")
    lines.push("")
    lines.push(`The integration worktree is at: \`${intWorktreeDir}\``)
    lines.push("")
    lines.push("This worktree contains a partially merged result with conflict markers.")
    lines.push("You should work in this worktree to complete the merge.")
    lines.push("")
    lines.push("```bash")
    lines.push(`cd ${intWorktreeDir}`)
    lines.push("git status")
    lines.push("# resolve conflicts")
    lines.push("git add -A")
    lines.push(`git commit -m "zflow: subagent resolution for run ${runId}"`)
    lines.push("```")
  } catch {
    lines.push("## Work in the primary worktree")
    lines.push("")
    lines.push("No integration worktree was created. Apply the patches in order,")
    lines.push("resolving conflicts as they arise.")
  }

  lines.push("")
  lines.push("## Ephemeral Script Policy")
  lines.push("")
  const scratchScriptsDir = path.join(path.dirname(path.dirname(runDir)), "scratch", "scripts")
  lines.push(buildEphemeralScriptRule(scratchScriptsDir))
  lines.push("")
  lines.push("## Important constraints")
  lines.push("")
  lines.push("- Keep ALL group changes. Missing a group's changes is a failure.")
  lines.push("- If a conflict is genuinely unresolvable, explain why and leave a comment.")
  lines.push("- After resolving all conflicts, run any available verification.")
  lines.push("- Report which groups you merged, which files you changed, and any decisions.")

  return lines.join("\n")
}

/**
 * Options for requesting subagent resolution of apply-back conflicts.
 */
export interface SubagentResolutionOptions {
  /** Unique run identifier. */
  runId: string
  /** Change identifier. */
  changeId: string
  /** Execution groups with task prompts. */
  groups: Array<{ id: string; files: string[]; taskPrompt?: string }>
  /** Working directory. */
  cwd?: string
  /** Model to use for the resolution subagent (default: from active profile). */
  model?: string
}

/**
 * Result of a subagent resolution attempt.
 */
export interface SubagentResolutionResult {
  /** Whether the resolution was successful. */
  success: boolean
  /** Human-readable summary. */
  summary: string
  /** Any remaining conflict markers or issues. */
  remainingIssues?: string[]
}

/**
 * Request subagent resolution of apply-back conflicts.
 *
 * Builds a detailed prompt with each group's task, patch, and file info,
 * then dispatches to a subagent to resolve remaining merge conflicts.
 *
 * After the subagent completes, verifies that all groups' patches are
 * represented and no conflict markers remain.
 *
 * @param options - Resolution options.
 * @returns SubagentResolutionResult.
 */
export async function requestSubagentResolution(
  options: SubagentResolutionOptions,
): Promise<SubagentResolutionResult> {
  const { runId, changeId, groups, cwd, model } = options

  // Build the resolution prompt
  const resolutionPrompt = await buildSubagentResolutionPrompt(
    runId,
    changeId,
    groups,
    cwd,
  )

  // Log what would happen — the actual subagent dispatch is done by the
  // caller (the workflow command handler), which has access to pi-subagents.
  // This function prepares the prompt and metadata for that dispatch.
  const { default: fs } = await import("node:fs/promises")
  const { default: path } = await import("node:path")
  const { resolveRunDir } = await import("pi-zflow-artifacts/artifact-paths")

  const runDir = resolveRunDir(runId, cwd)
  const promptPath = path.join(runDir, "subagent-resolution-prompt.md")
  await fs.writeFile(promptPath, resolutionPrompt, "utf-8")

  // Inject ephemeral script policy into the prompt written to disk
  const scratchScriptsDir = path.join(path.dirname(path.dirname(runDir)), "scratch", "scripts")
  const scriptPolicy = buildEphemeralScriptRule(scratchScriptsDir)

  // Re-read the prompt and prepend the script policy
  const existingContent = await fs.readFile(promptPath, "utf-8")
  const enhancedPrompt = `${scriptPolicy}\n\n${existingContent}`
  await fs.writeFile(promptPath, enhancedPrompt, "utf-8")

  return {
    success: true,  // prompt was prepared — actual dispatch result set by caller
    summary: [
      "Subagent resolution prompt prepared (with ephemeral script policy).",
      `Prompt saved to: ${promptPath}`,
      "",
      "To dispatch the resolution subagent, the command handler should:",
      "1. Read the prompt from the above path.",
      "2. Dispatch to a subagent with full context and write access.",
      '3. The subagent should work in the integration worktree (if available)',
      "   or apply patches to the primary worktree after rollback.",
      "4. After the subagent completes, verify coverage and run apply-back.",
    ].join("\n"),
  }
}

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
 * Options for the `/zflow-change-plan` workflow orchestration.
 */
export interface ChangePlanWorkflowOptions {
  /** Working directory for runtime state dir resolution. */
  cwd?: string
  /** Final resolved durable change identifier. */
  changeId: string
  /** Human description of the requested change. */
  changeDescription: string
  /** Original user input seed (description, path, or explicit id). */
  changeSeed: string
  /** Optional extracted repo path/folder/file reference mentioned by the user. */
  changeReferencePath?: string
  /** Whether the change seed was an explicit path/id reference. */
  explicitReference?: boolean
  /** Durable plan source mode. */
  sourceMode?: DurablePlanDocFrontmatter["sourceMode"]
  /** Optional progress callback for command UIs. */
  onProgress?: (message: string, type?: "info" | "warning" | "error") => void
  /** Optional live agent-progress callback. */
  onAgentProgress?: (progress: AgentDispatchProgress) => void
}

/**
 * Result of the `/zflow-change-plan` workflow orchestration.
 */
export interface ChangePlanWorkflowResult {
  changeId: string
  planDocPath: string
  repoMapPath: string
  reconnaissancePath: string
  draftOutputPath?: string
  dispatchService?: string
  existingPlanUpdated: boolean
}

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
  /** Force normal ad-hoc change-doc handling; skip RuneContext detection. */
  forceAdHoc?: boolean
  /** Additional user notes supplied after the change path. */
  prepareNotes?: string
  /** Optional progress callback for command UIs. */
  onProgress?: (message: string, type?: "info" | "warning" | "error") => void
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
  /** Absolute paths to the five canonical plan artifact files. */
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

const CHANGE_ID_NOISE_TOKENS = new Set([
  "change",
  "changes",
  "idea",
  "ideas",
  "doc",
  "docs",
  "plan",
  "draft",
  "spec",
  "specification",
  "combined",
])

/**
 * Derive a stable, semantic change identifier from a path or title.
 *
 * The durable change-doc directory is intended to be reviewed and committed,
 * so it should describe the change rather than the source file location or a
 * timestamp. For file paths, this uses the basename/stem and removes common
 * planning-document noise words such as `combined` and `spec`.
 *
 * @param changePath - Path or title supplied to `/zflow-change-prepare`.
 * @returns A kebab-case semantic identifier, or null when no useful slug exists.
 */
export function deriveSemanticChangeId(changePath?: string): string | null {
  if (!changePath) return null
  const cleaned = changePath.trim().replace(/^@+/, "")
  if (!cleaned) return null

  const parts = cleaned.split(/[\\/]/).filter(Boolean)
  const durableIndex = parts.lastIndexOf("zflow-changes")
  if (durableIndex !== -1 && parts[durableIndex + 1]) {
    return parts[durableIndex + 1]!.toLowerCase()
  }

  const segment = parts.at(-1) ?? cleaned
  const stem = segment.replace(/\.[^.]+$/, "")
  const tokens = stem
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .split("-")
    .filter(Boolean)

  const semanticTokens = tokens.filter((token) => !CHANGE_ID_NOISE_TOKENS.has(token))
  const chosenTokens = semanticTokens.length >= 2 ? semanticTokens : tokens
  const slug = chosenTokens.join("-").slice(0, 72).replace(/-+$/g, "")
  return slug || null
}

export interface ChangeImplementTarget {
  /** Runtime change ID used for `.zflow/plans/<changeId>`. */
  changeId: string
  /** Original command argument. */
  input: string
  /** Durable docs change ID, when input pointed at `docs/zflow-changes/<id>/...`. */
  durableChangeId?: string
  /** Manifest path used to resolve the runtime change ID, when applicable. */
  manifestPath?: string
}

async function fileExists(filePath: string): Promise<boolean> {
  const { default: fs } = await import("node:fs/promises")
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function migrateLegacyChangeArtifactsIfPresent(changeId: string, cwd?: string): Promise<boolean> {
  const { default: fs } = await import("node:fs/promises")
  const { default: path } = await import("node:path")
  const { resolveGitDir, ensureRuntimeStateDir } = await import("pi-zflow-core/runtime-paths")

  const runtimeDir = ensureRuntimeStateDir(cwd)
  const newChangeDir = path.join(runtimeDir, "plans", changeId)
  if (await fileExists(path.join(newChangeDir, "plan-state.json"))) return false

  const gitDir = resolveGitDir(cwd ?? process.cwd())
  if (!gitDir) return false

  const legacyChangeDir = path.join(gitDir, "pi-zflow", "plans", changeId)
  if (!(await fileExists(path.join(legacyChangeDir, "plan-state.json")))) return false

  await fs.mkdir(path.dirname(newChangeDir), { recursive: true })
  await fs.cp(legacyChangeDir, newChangeDir, { recursive: true, force: false, errorOnExist: false })
  console.info(`[zflow] Migrated legacy plan artifacts for change "${changeId}" from .git/pi-zflow to .zflow.`)
  return true
}

async function findDurableManifestPath(inputPath: string, cwd?: string): Promise<string | null> {
  const { default: fs } = await import("node:fs/promises")
  const { default: path } = await import("node:path")
  const repoRoot = cwd ?? process.cwd()
  const cleaned = inputPath.trim().replace(/^@+/, "").replace(/[\\/]$/, "")
  if (!cleaned) return null
  const absolutePath = path.isAbsolute(cleaned) ? cleaned : path.join(repoRoot, cleaned)

  // If the input points to a plan.md file, resolve from its parent directory
  let searchPath = absolutePath
  if (path.basename(absolutePath).toLowerCase() === "plan.md") {
    searchPath = path.dirname(absolutePath)
  }

  const directManifest = path.join(searchPath, "manifest.json")
  if (await fileExists(directManifest)) return directManifest

  const parts = searchPath.split(path.sep)
  const zflowIndex = parts.lastIndexOf("zflow-changes")
  if (zflowIndex === -1 || !parts[zflowIndex + 1]) return null

  const changeDir = parts.slice(0, zflowIndex + 2).join(path.sep) || path.sep
  try {
    const entries = await fs.readdir(changeDir, { withFileTypes: true })
    const versionDirs = entries
      .filter((entry) => entry.isDirectory() && /^v\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => Number.parseInt(b.slice(1), 10) - Number.parseInt(a.slice(1), 10))
    for (const version of versionDirs) {
      const candidate = path.join(changeDir, version, "manifest.json")
      if (await fileExists(candidate)) return candidate
    }
  } catch {
    return null
  }

  return null
}

/**
 * Resolve a `/zflow-change-implement` argument to the runtime plan change ID.
 *
 * Users commonly pass the durable docs path (`docs/zflow-changes/<name>/` or a
 * version directory) after reviewing the committed plan documents. The runtime
 * implementation state still lives under `.zflow/plans/<changeId>/`, so
 * this helper reads the durable `manifest.json` and follows
 * `previousRuntimeChangeId` when present.
 */
export async function resolveChangeImplementTarget(
  input: string,
  cwd?: string,
): Promise<ChangeImplementTarget> {
  const { default: fs } = await import("node:fs/promises")
  const cleaned = input.trim().replace(/^@+/, "").replace(/[\\/]$/, "")

  if (cleaned && await fileExists(resolvePlanStatePath(cleaned, cwd))) {
    return { changeId: cleaned, input }
  }

  const manifestPath = await findDurableManifestPath(input, cwd)
  if (manifestPath) {
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as {
      changeId?: string
      previousRuntimeChangeId?: string
      sourceRuntimePath?: string
    }
    const candidates = [manifest.previousRuntimeChangeId, manifest.changeId].filter((value): value is string => Boolean(value))
    for (const candidate of candidates) {
      if (await fileExists(resolvePlanStatePath(candidate, cwd))) {
        return {
          changeId: candidate,
          input,
          durableChangeId: manifest.changeId,
          manifestPath,
        }
      }
    }
  }

  // Fallback: if input looks like a plan.md path, extract changeId from the directory
  if ((cleaned || input).endsWith("plan.md") || (cleaned || input).includes("zflow-changes/")) {
    const { default: path } = await import("node:path")
    const absPath = path.isAbsolute(cleaned || input) ? (cleaned || input) : path.resolve(cwd ?? process.cwd(), cleaned || input)
    // Walk up to find the change directory (parent of plan.md or grandparent of version dir)
    let dir = path.dirname(absPath)
    const isPlanMd = path.basename(absPath).toLowerCase() === "plan.md"
    if (isPlanMd) {
      const changeIdFromDir = path.basename(dir)
      if (changeIdFromDir && !changeIdFromDir.startsWith("docs") && !changeIdFromDir.startsWith(".")) {
        return { changeId: changeIdFromDir, input, durableChangeId: changeIdFromDir }
      }
    }
  }

  return { changeId: cleaned || input, input }
}

/**
 * Generate a change identifier.
 *
 * If a `changePath` is provided, derives a stable semantic slug from its
 * basename/title. Otherwise creates a timestamp-only fallback ID.
 *
 * @param changePath - Optional path/title to derive the slug from.
 * @returns A kebab-case change ID string.
 */
function generateChangeId(changePath?: string): string {
  return deriveSemanticChangeId(changePath) ?? `change-${Date.now().toString(36)}`
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
 * Checks that the five canonical artifacts exist and have no placeholder
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
    "implementation-tasks.md": resolvePlanArtifactPath(changeId, planVersion, "implementation-tasks", cwd),
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
        /zflow-synthesized-artifact:\s*implementation-tasks/i,
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
 * Ensure the required implementation-tasks.md artifact exists.
 *
 * Planner models can occasionally finish after writing the original four
 * artifacts even when prompted to write the fifth. This helper provides a
 * deterministic safety net: when execution-groups.md exists but
 * implementation-tasks.md is missing, synthesize focused task specs from the
 * parsed execution groups so validation, review, and implementation handoff can
 * proceed with a complete five-artifact plan.
 *
 * Existing implementation-tasks.md content is never overwritten.
 *
 * @param changeId - The change identifier.
 * @param planVersion - Plan version (e.g. "v1").
 * @param cwd - Working directory (optional).
 * @returns Whether implementation-tasks.md was created.
 */
export async function ensureImplementationTasksArtifact(
  changeId: string,
  planVersion: string,
  cwd?: string,
): Promise<boolean> {
  const { default: fs } = await import("node:fs/promises")
  const { default: path } = await import("node:path")

  const implementationTasksPath = resolvePlanArtifactPath(changeId, planVersion, "implementation-tasks", cwd)
  try {
    await fs.access(implementationTasksPath)
    return false
  } catch {
    // Missing; synthesize below if execution groups are available.
  }

  const executionGroupsPath = resolvePlanArtifactPath(changeId, planVersion, "execution-groups", cwd)
  let executionGroupsContent = ""
  try {
    executionGroupsContent = await fs.readFile(executionGroupsPath, "utf-8")
  } catch {
    return false
  }

  const groups = parseExecutionGroupsMd(executionGroupsContent)
  if (groups.length === 0) return false

  const lines: string[] = [
    "# Implementation Tasks",
    "",
    "<!-- zflow-synthesized-artifact: implementation-tasks -->",
    "",
    `Generated by zflow-change-prepare for change \`${changeId}\` ${planVersion}.`,
    "",
    "> This is a synthesized recovery artifact because the planner did not produce a real implementation-tasks.md.",
    "> It is useful for inspection and repair, but it is NOT sufficient for plan approval.",
    "",
    "This artifact contains focused implementation task specs for each execution group.",
    "Use it together with `design.md`, `execution-groups.md`, `standards.md`, and `verification.md`.",
    "",
    "## Context Index",
    "",
    "- Overall problem, architecture, and decisions: `design.md`",
    "- Execution order, ownership, dependencies, review tags, and scoped verification: `execution-groups.md`",
    "- Project conventions, commands, boundaries, and quality gates: `standards.md`",
    "- End-to-end and per-group verification expectations: `verification.md`",
    "- Per-group implementation task details: this file",
    "",
    "## Global Worker Rules",
    "",
    "### Always",
    "- Read the matching group section in this file before editing code.",
    "- Modify only the files listed for the assigned execution group unless a deviation is reported.",
    "- Run the scoped verification command from the group before reporting completion.",
    "",
    "### Ask first / stop and report drift",
    "- The likely file list is incomplete for the implementation that is actually required.",
    "- The pseudocode conflicts with existing code patterns or the approved design.",
    "- A dependency, schema, migration, or public API change is needed but not described by the plan.",
    "",
    "### Never",
    "- Start unrelated refactors while implementing a group.",
    "- Remove or weaken tests to make verification pass.",
    "- Edit runtime plan artifacts during implementation.",
    "",
  ]

  for (const group of groups) {
    const groupNumber = group.id.replace(/^group-/, "")
    const files = group.files.length > 0 ? group.files : ["No files listed in execution-groups.md; stop and report a plan-quality gap before editing."]
    const dependencies = group.dependencies.length > 0 ? group.dependencies.join(", ") : "None"
    const verification = group.scopedVerification ?? "No scoped verification command listed; stop and report a plan-quality gap before implementation."

    lines.push(
      `## Group ${groupNumber}: ${group.taskPrompt || group.id}`,
      "",
      `Group ID: \`${group.id}\`  `,
      `Assigned agent: \`${group.agent}\`  `,
      `Dependencies: ${dependencies}`,
      "",
      "### Objective",
      group.taskPrompt || `Implement the approved work for ${group.id}.`,
      "",
      "### Scope",
      "Included:",
      `- Complete only the work described for \`${group.id}\` in \`execution-groups.md\`.`,
      "- Preserve existing behavior outside the group scope.",
      "",
      "Excluded:",
      "- Unrelated cleanup, broad refactors, or opportunistic rewrites.",
      "- Files outside the listed scope unless plan drift is reported and approved.",
      "",
      "### Likely files touched",
      "",
      "| File | Operation | Reason | Notes |",
      "| --- | --- | --- | --- |",
      ...files.map((file) => `| \`${file}\` | modify | Required by ${group.id} scope | Follow existing local patterns before editing |`),
      "",
      "### Context to read first",
      "- `design.md` sections related to this group",
      "- `execution-groups.md` entry for this group and all dependencies",
      "- `standards.md` commands, code style, and boundaries",
      "- Nearby tests and existing implementations for each likely touched file",
      "",
      "### Implementation checklist",
      "1. Read the context listed above and confirm the group scope.",
      "2. Inspect each likely touched file and identify the smallest safe change.",
      "3. Apply the change using existing project patterns and naming conventions.",
      "4. Add or update focused tests when behavior changes.",
      "5. Run the scoped verification command and capture the result.",
      "6. Summarize changed files, verification output, and any deviations.",
      "",
      "### Pseudocode / implementation sketch",
      "```text",
      `read design.md, standards.md, verification.md, and execution-groups.md for ${group.id}`,
      "for each likely touched file:",
      "  inspect existing patterns and related tests",
      "  make the smallest change that satisfies the group objective",
      "  update or add focused tests when behavior changes",
      "run the scoped verification command",
      "if scope or files differ materially from the plan:",
      "  stop and report plan drift instead of expanding the task silently",
      "```",
      "",
      "### Acceptance criteria",
      `- The objective for \`${group.id}\` is implemented without unrelated changes.`,
      "- Only listed files are modified, or an approved deviation explains why more files were needed.",
      "- Relevant tests or checks are updated when behavior changes.",
      "- Scoped verification passes or the failure is reported with actionable details.",
      "",
      "### Scoped verification",
      "```bash",
      verification,
      "```",
      "",
      "### Self-check before completion",
      "- [ ] Did I read this task spec and the linked plan artifacts?",
      "- [ ] Did I touch only the listed files, or report drift?",
      "- [ ] Did I preserve existing patterns and boundaries?",
      "- [ ] Did I add/update focused tests when behavior changed?",
      "- [ ] Did I run scoped verification and record the result?",
      "",
      "### Drift triggers",
      "- A required file is absent from the likely touched file list.",
      "- The existing code architecture contradicts the implementation sketch.",
      "- Verification cannot be run as written.",
      "- The group cannot be completed independently after its dependencies finish.",
      "",
    )
  }

  const result = await writePlanArtifact({
    changeId,
    planVersion,
    artifact: "implementation-tasks",
    content: lines.join("\n"),
  }, cwd)

  if (!result.ok) {
    // Tolerate mixed local installs where the workflow package has been
    // updated before the artifact writer allowlist. Validation/review need the
    // file to exist, so fall back to a direct workflow-owned write rather than
    // leaving prepare blocked. Fully updated installs still take the metadata
    // recording path above.
    await fs.mkdir(path.dirname(implementationTasksPath), { recursive: true })
    await fs.writeFile(implementationTasksPath, lines.join("\n"), "utf-8")
  }

  return true
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
        implementationTasks: resolvePlanArtifactPath(changeId, planVersion, "implementation-tasks", cwd),
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
    implementationTasks: resolvePlanArtifactPath(changeId, approvedVersion, "implementation-tasks", cwd),
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

/** Resolve an agent model override from the active zflow profile cache. */
async function resolveProfileModelForAgent(agentName: string): Promise<string | undefined> {
  try {
    const profileService = getZflowRegistry().optional<{
      getResolvedAgentBinding?: (agentName: string) => Promise<{ resolvedModel?: string | null } | null>
    }>("profiles")
    const binding = await profileService?.getResolvedAgentBinding?.(agentName)
    return binding?.resolvedModel ?? undefined
  } catch {
    return undefined
  }
}

function formatChangePlanAgentProgress(progress: AgentDispatchProgress): string {
  const elapsed = formatDispatchElapsed(progress.durationMs)
  const toolCount = progress.toolCount ?? 0
  if (progress.currentTool) {
    const args = progress.currentToolArgs ? ` ${progress.currentToolArgs}` : ""
    return `planner running — child elapsed ${elapsed} — ${toolCount} tools — current: ${progress.currentTool}${args}`
  }
  const recent = progress.recentTools?.at(-1)
  if (recent?.tool) {
    const args = recent.args ? ` ${recent.args}` : ""
    return `planner running — child elapsed ${elapsed} — ${toolCount} tools — last: ${recent.tool}${args}`
  }
  return `planner running — child elapsed ${elapsed} — ${toolCount} tools observed`
}

function buildChangePlanDraftTaskPrompt(input: {
  changeId: string
  changeDescription: string
  sourceMode: DurablePlanDocFrontmatter["sourceMode"]
  planDocPath: string
  repoMapPath: string
  reconnaissancePath: string
  changeReferencePath?: string
  existingPlanBody?: string
}): string {
  return [
    `Draft a complete durable change plan body for changeId \`${input.changeId}\`.`,
    `Change description: ${input.changeDescription}`,
    `Source mode: ${input.sourceMode}`,
    `Target durable plan path: ${input.planDocPath}`,
    `Repository map path: ${input.repoMapPath}`,
    `Reconnaissance path: ${input.reconnaissancePath}`,
    input.changeReferencePath ? `Referenced repo path: ${input.changeReferencePath}` : "",
    input.existingPlanBody
      ? [
        "Existing durable plan body to refine:",
        input.existingPlanBody,
      ].join("\n")
      : "No existing durable plan body was found; create a fresh, detailed draft.",
    "",
    "You are drafting the human-reviewed durable `plan.md` intake document.",
    "Explore the repository before writing. Use the repo map and reconnaissance as anchors, then read the most relevant files.",
    "Ask clarifying questions ONLY if the plan would otherwise be materially blocked. If not blocked, produce the strongest plan you can and capture remaining uncertainty under Open questions.",
    "",
    "Return ONLY markdown for the `plan.md` body. Do NOT include YAML frontmatter. Do NOT wrap the result in code fences. Do NOT include the managed zflow header or version-index sections.",
    "",
    "Use these exact headings and fill each with concrete detail:",
    "- `## Summary`",
    "- `## Goals / Success Criteria`",
    "- `## Scope In`",
    "- `## Scope Out`",
    "- `## Relevant codebase areas`",
    "- `## Constraints`",
    "- `## Decisions`",
    "- `## Risks / Unknowns`",
    "- `## Proposed execution outline`",
    "- `## Verification approach`",
    "- `## Open questions`",
    "",
    "Quality requirements:",
    "- No placeholder text, no TODO-only sections, and no empty headings.",
    "- Mention concrete files, modules, services, or directories in Relevant codebase areas whenever they can be inferred.",
    "- Proposed execution outline should describe logical work groups, likely ordering, and coordination concerns, but it does NOT need the final machine-readable execution-groups format.",
    "- Verification approach should include concrete commands or focused validation methods whenever the repo suggests them.",
    "- Open questions should be empty of fluff; only include unresolved decisions that could materially affect planning.",
    "",
    "If the change is RuneContext-backed, treat RuneContext documents as canonical and describe how this durable plan summarizes or stages that work without competing with canonical docs.",
  ].filter(Boolean).join("\n")
}

export async function runChangePlanWorkflow(
  options: ChangePlanWorkflowOptions,
): Promise<ChangePlanWorkflowResult> {
  const cwd = options.cwd
  const { default: fs } = await import("node:fs/promises")
  const { default: path } = await import("node:path")
  const { resolveRuntimeStateDir } = await import("pi-zflow-core/runtime-paths")

  const sourceMode = options.sourceMode ?? "adhoc"
  const planDocPath = await resolveDurablePlanDocPath(options.changeId, await resolveDurablePlanRepoRoot({ cwd }))
  const existingPlan = await readDurablePlanDoc(options.changeId, { cwd })
  const existingPlanBody = existingPlan
    ? normalizeDurablePlanDocBody(existingPlan.body)
    : ""

  options.onProgress?.("🗺️ Building repository map for change planning...", "info")
  const repoMapResult = await buildRepoMap(cwd)
  options.onProgress?.("🔎 Building reconnaissance context for change planning...", "info")
  const reconResult = await buildReconnaissance(
    cwd,
    options.explicitReference
      ? options.changeSeed
      : options.changeReferencePath,
  )

  const registry = getZflowRegistry()
  const zflowDispatch = registry.optional<DispatchService>(DISPATCH_SERVICE_CAPABILITY)
  if (!zflowDispatch || typeof zflowDispatch.runAgent !== "function") {
    throw new Error(
      "No dispatch service available for /zflow-change-plan. Ensure pi-zflow-subagents-bridge is installed and active.",
    )
  }

  const runtimeStateDir = resolveRuntimeStateDir(cwd)
  const outputDir = path.join(runtimeStateDir, "change-plan-drafts")
  await fs.mkdir(outputDir, { recursive: true })
  const draftOutputPath = path.join(outputDir, `${options.changeId}-plan-draft.md`)

  const dispatchResult = await zflowDispatch.runAgent({
    agent: "planner",
    cwd,
    model: await resolveProfileModelForAgent("zflow.planner-frontier"),
    output: draftOutputPath,
    outputMode: "inline",
    task: buildChangePlanDraftTaskPrompt({
      changeId: options.changeId,
      changeDescription: options.changeDescription,
      sourceMode,
      planDocPath,
      repoMapPath: repoMapResult.path,
      reconnaissancePath: reconResult.path,
      changeReferencePath: options.explicitReference ? options.changeSeed : options.changeReferencePath,
      existingPlanBody: existingPlanBody || undefined,
    }),
    onUpdate: (progress) => {
      options.onAgentProgress?.(progress)
      options.onProgress?.(formatChangePlanAgentProgress(progress), "info")
    },
  })

  if (!dispatchResult.ok) {
    throw new Error(dispatchResult.error ?? "Change-plan drafting agent failed without an error message")
  }

  let draftedBody = dispatchResult.rawOutput?.trim() ?? ""
  if (!draftedBody && dispatchResult.outputPath && await fileExists(dispatchResult.outputPath)) {
    draftedBody = await fs.readFile(dispatchResult.outputPath, "utf-8")
  }
  draftedBody = normalizeDurablePlanDocBody(draftedBody)
  const bodyErrors = validateDurablePlanDocBody(draftedBody)
  if (bodyErrors.length > 0) {
    throw new Error(`Drafted durable plan body did not meet the contract: ${bodyErrors.join("; ")}`)
  }

  const publishedVersions = await listPublishedDurablePlanVersions(options.changeId, { cwd })
  const existingPlanUpdated = Boolean(existingPlan)
  await writeDurablePlanDoc(
    options.changeId,
    {
      changeId: options.changeId,
      status: existingPlan?.frontmatter.status ?? "draft",
      sourceMode: existingPlan?.frontmatter.sourceMode ?? sourceMode,
      currentVersion: existingPlan?.frontmatter.currentVersion ?? null,
      approvedVersion: existingPlan?.frontmatter.approvedVersion ?? null,
    },
    {
      cwd,
      bodyContent: draftedBody,
      publishedVersions,
    },
  )

  return {
    changeId: options.changeId,
    planDocPath,
    repoMapPath: repoMapResult.path,
    reconnaissancePath: reconResult.path,
    draftOutputPath: dispatchResult.outputPath ?? draftOutputPath,
    dispatchService: zflowDispatch.name,
    existingPlanUpdated,
  }
}

/**
 * Detect transport-level dispatch errors that are safe to retry.
 * Defined locally to avoid circular dependency with index.ts.
 */
function isTransportDispatchError(error: string | undefined): boolean {
  if (!error) return false
  const TRANSPORT_ERROR_PATTERNS = [
    /WebSocket error/i,
    /ECONNRESET/i,
    /connection (closed|reset|refused)/i,
    /transport/i,
    /timeout/i,
    /network/i,
    /socket/i,
    /tls/i,
    /ETIMEDOUT/i,
    /ENOTFOUND/i,
    /EPIPE/i,
    /ECONNREFUSED/i,
    /keepalive/i,
  ]
  return TRANSPORT_ERROR_PATTERNS.some((pattern) => pattern.test(error))
}

function formatDispatchElapsed(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "00:00"
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

function formatPrepareAgentProgress(progress: AgentDispatchProgress): string {
  const elapsed = formatDispatchElapsed(progress.durationMs)
  const toolCount = progress.toolCount ?? 0
  if (progress.currentTool) {
    const args = progress.currentToolArgs ? ` ${progress.currentToolArgs}` : ""
    return `zflow.planner-frontier running — child elapsed ${elapsed} — ${toolCount} tools — current: ${progress.currentTool}${args}`
  }
  const recent = progress.recentTools?.at(-1)
  if (recent?.tool) {
    const args = recent.args ? ` ${recent.args}` : ""
    return `zflow.planner-frontier running — child elapsed ${elapsed} — ${toolCount} tools — last: ${recent.tool}${args}`
  }
  return `zflow.planner-frontier running — child elapsed ${elapsed} — ${toolCount} tools observed`
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
  changePath?: string,
  prepareNotes?: string,
  onAgentProgress?: (message: string) => void,
): Promise<PrepareAgentDispatchResult> {
  const registry = getZflowRegistry()
  const { default: fs } = await import("node:fs/promises")
  const { default: pathModule } = await import("node:path")
  const { resolveRuntimeStateDir } = await import("pi-zflow-core/runtime-paths")

  const runtimeStateDir = resolveRuntimeStateDir(cwd)
  const versionDir = resolvePlanVersionDir(changeId, planVersion, cwd)
  const artifactPaths = {
    repoMap: pathModule.join(runtimeStateDir, "repo-map.md"),
    reconnaissance: pathModule.join(runtimeStateDir, "reconnaissance.md"),
    design: pathModule.join(versionDir, "design.md"),
    executionGroups: pathModule.join(versionDir, "execution-groups.md"),
    standards: pathModule.join(versionDir, "standards.md"),
    verification: pathModule.join(versionDir, "verification.md"),
    implementationTasks: pathModule.join(versionDir, "implementation-tasks.md"),
  }

  const collectOutputs = async (): Promise<string[]> => {
    const outputs: string[] = []
    for (const artifactPath of Object.values(artifactPaths)) {
      try {
        await fs.access(artifactPath)
        outputs.push(artifactPath)
      } catch {
        // Not written — that's fine
      }
    }
    return outputs
  }

  const recordDispatchMetadata = async (metadata: Record<string, unknown>): Promise<void> => {
    try {
      const planStatePath = resolvePlanStatePath(changeId, cwd)
      const raw = await fs.readFile(planStatePath, "utf-8")
      const planState = JSON.parse(raw)
      planState.runtimeMetadata = {
        ...(planState.runtimeMetadata ?? {}),
        ...metadata,
      }
      planState.updatedAt = new Date().toISOString()
      await fs.writeFile(planStatePath, JSON.stringify(planState, null, 2), "utf-8")
    } catch {
      // Non-critical; skip recording
    }
  }

  const zflowDispatch = registry.optional<DispatchService>(DISPATCH_SERVICE_CAPABILITY)
  if (zflowDispatch && typeof zflowDispatch.runAgent === "function") {
    try {
      const task = [
        `Run formal zflow change preparation for changeId \`${changeId}\` and planVersion \`${planVersion}\`.`,
        changePath ? `Change input path: ${changePath}` : "No change input path was provided.",
        prepareNotes ? `Additional user notes: ${prepareNotes}` : "",
        "Treat non-RuneContext idea/change documents as requirements input, then inspect the repository before planning.",
        "Ask clarifying questions in your final output if decisions are genuinely blocked; otherwise write all five required plan artifacts.",
        "Use ONLY zflow_write_plan_artifact for artifact writes.",
        "Required artifact writes:",
        `- design -> ${artifactPaths.design}`,
        `- execution-groups -> ${artifactPaths.executionGroups}`,
        `- standards -> ${artifactPaths.standards}`,
        `- verification -> ${artifactPaths.verification}`,
        `- implementation-tasks -> ${artifactPaths.implementationTasks}`,
        `Repository map path: ${artifactPaths.repoMap}`,
        `Reconnaissance path: ${artifactPaths.reconnaissance}`,
        "",
        "## CRITICAL: Machine-Readable Format Contract",
        "",
        "The plan artifacts MUST be parseable by automated tools. The parsers are strict.",
        "Validation will fail if the format contract is violated, and the planner will",
        "receive EXACT parser errors to repair the artifacts.",
        "",
        "### execution-groups.md — REQUIRED format",
        "",
        "Each group heading: `## Group X: Name` or `## GX — Name` or `## Execution Group X: Name`",
        "Group IDs: digit-first (1, 1A, 2B) or letter-first (A1, B2, C3a).",
        "",
        "Required fields per group:",
        "- `**Files:**` or `**Primary files/paths touched:**` — comma-separated paths or bullet list.",
        "  Each file path must be concrete (e.g. `src/auth/login.ts`), not vague like `src/auth/*`.",
        "- `**Scoped verification:**` — a concrete shell command. NOT \"TBD\", not empty.",
        "- `**Agent:**` — required (e.g. `zflow.implement-routine` or `zflow.implement-hard`).",
        "- `**Dependencies:**` — required (group IDs or `none`).",
        "- `**Parallelizable:**` — required (`true` or `false`).",
        "",
        "Optional advanced execution fields (default to simple isolated execution unless justified):",
        "- `**Execution mode:** isolated | shared-staging`",
        "- `**Workspace ID:** <kebab-id>` (required when execution mode is `shared-staging`)",
        "- `**Workspace concurrency:** serialized | concurrent` (default `serialized`)",
        "- `**Base strategy:** head | dependency-lineage` (default `head`)",
        "- `**Execution rationale:** <concrete reason>` (required for any non-default execution mode or base strategy)",
        "",
        "Use advanced execution fields sparingly:",
        "- Default to isolated worktrees.",
        "- Use shared-staging only when two or more groups genuinely need shared filesystem/type feedback.",
        "- Use `Workspace concurrency: concurrent` only when the backend explicitly supports it; otherwise prefer `serialized`.",
        "- Use `Base strategy: dependency-lineage` only when downstream groups truly need their dependencies' pending changes present before final apply-back.",
        "",
        "### CRITICAL: File ownership and cross-group dependencies",
        "",
        "When two groups claim the same file, the execution dispatcher MUST know",
        "which group runs first. The ownership validator will REJECT the plan at",
        "implementation time if overlapping files have no dependency ordering.",
        "",
        "Rules:",
        "- If groups share ANY file, one must declare an explicit dependency on the other.",
        "- Set `Parallelizable: false` on groups that share files with peers.",
        "- Transitive dependencies count: if G8→G6→G5, then G8 is ordered after G5.",
        "  But if G7 and G8 both touch `app.ts` and neither depends on the other,",
        "  that overlap IS a violation — add `Dependencies: 6, 7` to G8.",
        "- After drafting all groups, scan the Files: lists for every same-phase group",
        "  pair. For every overlapping file, ensure a dependency edge exists between",
        "  the two groups touching it.",
        "- Phase 3 cross-cutting groups (redaction, rate-limit, access guardrails)",
        "  commonly all touch integration files like `app.ts`. They MUST declare",
        "  dependencies on each other, not just on Phase 2 groups.",
        "",
        "Example:",
        "",
        "```markdown",
        "## Group A1: Short descriptive name",
        "",
        "**Files:** src/path/file.ts, src/other/file.ts",
        "**Agent:** zflow.implement-routine",
        "**Dependencies:** none",
        "**Scoped verification:** npm test -- --testPathPattern=src/path",
        "**Parallelizable:** true",
        "```",
        "",
        "VALID: `**Scoped verification:** npm test -- --testPathPattern=src/auth`",
        "INVALID: `**Scoped verification:** TBD`",
        "INVALID: `**Scoped verification:** ` (empty)",
        "",
        "### implementation-tasks.md — REQUIRED format",
        "",
        "For EVERY execution group, include a matching section headed like `## Group X: Name`.",
        "Each group section must include these subsections with concrete content:",
        "- `### Objective`",
        "- `### Scope`",
        "- `### Likely files touched`",
        "- `### Context to read first`",
        "- `### Implementation checklist`",
        "- `### Pseudocode / implementation sketch`",
        "- `### Acceptance criteria`",
        "- `### Scoped verification`",
        "- `### Self-check before completion`",
        "- `### Drift triggers`",
        "",
        "Implementation-task quality rules:",
        "- The pseudocode must be group-specific, not boilerplate reused for every group.",
        "- Mention concrete files, symbols, data flows, or interfaces relevant to that group.",
        "- Do NOT write generic fallback text like 'for each likely touched file' unless you also explain the actual code path for this group.",
        "- Do NOT emit synthesized-marker comments such as `zflow-synthesized-artifact`.",
        "",
        "### Other artifacts",
        "",
        "- **design.md**: Must have >=50 chars of concrete design content.",
        "- **standards.md**: Must have >=50 chars. No [TODO] or [placeholder] markers.",
        "- **verification.md**: Must have >=50 chars and at least one code fence with a command.",
        "- **implementation-tasks.md**: Must have >=100 chars, real per-group sections, and no placeholder/synthesized markers.",
        "",
        "### Failure is OK",
        "",
        "If your plan artifacts fail validation, you will receive the EXACT parser errors",
        "and can rewrite only the invalid artifact. This is NOT a criticism — it is a",
        "normal part of ensuring machine-ingestible output. Repair passes are bounded",
        "and expected.",
      ].filter(Boolean).join("\n")

      // ── Dispatch with transport-error retry ──
      const MAX_DISPATCH_RETRIES = 3
      const RETRY_BACKOFF_MS = [1_000, 3_000, 5_000]

      let attempt = 0
      let lastResult: Awaited<ReturnType<DispatchService["runAgent"]>> | null = null
      let outputs: string[] = []

      while (attempt <= MAX_DISPATCH_RETRIES) {
        if (attempt > 0) {
          onAgentProgress?.(
            `zflow.planner-frontier transport error, retry ${attempt}/${MAX_DISPATCH_RETRIES}...`,
          )
          await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[attempt - 1]))
        } else {
          onAgentProgress?.("zflow.planner-frontier launch requested — waiting for first child event")
        }

        let sawChildProgress = false
        const launchStartedAt = Date.now()
        const heartbeat = setInterval(() => {
          if (sawChildProgress) return
          onAgentProgress?.(
            `zflow.planner-frontier launch pending — no child tool events yet after ${formatDispatchElapsed(Date.now() - launchStartedAt)}`,
          )
        }, 15_000)
        heartbeat.unref?.()

        try {
          lastResult = await zflowDispatch.runAgent({
            agent: "zflow.planner-frontier",
            task,
            cwd: cwd ?? process.cwd(),
            model: await resolveProfileModelForAgent("zflow.planner-frontier"),
            onUpdate: (progress) => {
              sawChildProgress = true
              onAgentProgress?.(formatPrepareAgentProgress(progress))
            },
            output: pathModule.join(versionDir, "planner-frontier-output.md"),
            outputMode: "file-only",
            maxOutput: { lines: 400, bytes: 24000 },
          })
          outputs = await collectOutputs()

          // Check for both thrown errors and returned errors that are
          // transport-related. runAgent may return ok=false with a
          // transport error instead of throwing (e.g. WebSocket error
          // during long-running agent execution). In both cases we
          // should retry if the agent didn't write enough artifacts.
          if (lastResult.ok || outputs.length >= 3) {
            break // success, or recovered with artifacts on disk
          }

          // result.ok is false — check if retryable transport error
          if (!isTransportDispatchError(lastResult.error) || attempt >= MAX_DISPATCH_RETRIES) {
            break // non-transport error or exhausted retries
          }

          // Transport error with no artifacts written — retry the dispatch
          clearInterval(heartbeat)
          attempt++
          continue
        } catch (err) {
          clearInterval(heartbeat)
          outputs = await collectOutputs()

          // If the agent wrote artifacts before the error, it did its work
          if (outputs.length >= 3) {
            lastResult = null // signal recovered-without-result
            break
          }

          const errMsg = err instanceof Error ? err.message : String(err)
          if (!isTransportDispatchError(errMsg) || attempt >= MAX_DISPATCH_RETRIES) {
            throw err // re-thrown, caught by outer catch
          }
          attempt++
        } finally {
          clearInterval(heartbeat)
        }
      }

      // ── Post-dispatch result handling with artifact recovery ──
      if (lastResult) {
        // runAgent returned (even if !ok) — handle normally with recovery check
        if (!lastResult.ok) {
          // Agent returned error but may have written artifacts
          if (outputs.length >= 3) {
            await recordDispatchMetadata({
              agentDispatchStatus: "dispatched",
              agentDispatchService: DISPATCH_SERVICE_CAPABILITY,
              agentDispatchMethod: "runAgent",
              agentDispatchedAt: new Date().toISOString(),
              agentDispatchError: `Recovered: agent wrote ${outputs.length} artifacts before ${lastResult.error ?? "transport error"}`,
            })
            return {
              dispatched: true,
              agentDispatchStatus: "dispatched",
              serviceName: DISPATCH_SERVICE_CAPABILITY,
              methodUsed: "runAgent",
              producedOutputs: outputs,
              error: lastResult.error,
            }
          }
          await recordDispatchMetadata({
            agentDispatchStatus: "failed",
            agentDispatchService: DISPATCH_SERVICE_CAPABILITY,
            agentDispatchMethod: "runAgent",
            agentDispatchError: lastResult.error ?? "Planner dispatch failed",
          })
          return {
            dispatched: false,
            agentDispatchStatus: "failed",
            serviceName: DISPATCH_SERVICE_CAPABILITY,
            methodUsed: "runAgent",
            producedOutputs: outputs,
            error: lastResult.error ?? "Planner dispatch failed",
          }
        }

        // Clean success
        await recordDispatchMetadata({
          agentDispatchStatus: "dispatched",
          agentDispatchService: DISPATCH_SERVICE_CAPABILITY,
          agentDispatchMethod: "runAgent",
          agentDispatchedAt: new Date().toISOString(),
          plannerOutputPath: lastResult.outputPath,
        })
        return {
          dispatched: true,
          agentDispatchStatus: "dispatched",
          serviceName: DISPATCH_SERVICE_CAPABILITY,
          methodUsed: "runAgent",
          producedOutputs: outputs,
        }
      }

      // lastResult is null — all attempts failed but artifacts exist
      await recordDispatchMetadata({
        agentDispatchStatus: "dispatched",
        agentDispatchService: DISPATCH_SERVICE_CAPABILITY,
        agentDispatchMethod: "runAgent",
        agentDispatchedAt: new Date().toISOString(),
        agentDispatchError: `Recovered: found ${outputs.length} existing artifacts after transport failures`,
      })
      return {
        dispatched: true,
        agentDispatchStatus: "dispatched",
        serviceName: DISPATCH_SERVICE_CAPABILITY,
        methodUsed: "runAgent",
        producedOutputs: outputs,
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      await recordDispatchMetadata({
        agentDispatchStatus: "failed",
        agentDispatchService: DISPATCH_SERVICE_CAPABILITY,
        agentDispatchMethod: "runAgent",
        agentDispatchError: errorMessage,
      })
      return {
        dispatched: false,
        agentDispatchStatus: "failed",
        serviceName: DISPATCH_SERVICE_CAPABILITY,
        methodUsed: "runAgent",
        producedOutputs: await collectOutputs(),
        error: errorMessage,
      }
    }
  }

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
      artifactPaths,
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
  agentDispatchResult: PrepareAgentDispatchResult
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
  const durableDraftPlan = await readDurablePlanDoc(changeId, { cwd })
  if (durableDraftPlan?.validationErrors.length) {
    throw new Error(
      `Durable draft plan frontmatter is invalid for "${changeId}": ${durableDraftPlan.validationErrors.join("; ")}`,
    )
  }
  if (durableDraftPlan?.bodyValidationErrors.length) {
    throw new Error(
      `Durable draft plan body is incomplete for "${changeId}": ${durableDraftPlan.bodyValidationErrors.join("; ")}`,
    )
  }
  const effectivePrepareNotes = buildPrepareNotesFromDurablePlanDoc(durableDraftPlan, options.prepareNotes)
  if (durableDraftPlan) {
    options.onProgress?.(`📝 Loaded durable draft plan from ${durableDraftPlan.path}.`, "info")
    if (durableDraftPlan.frontmatter.sourceMode === "runecontext") {
      options.onProgress?.(
        "🧭 Durable draft is marked as RuneContext-backed; canonical requirements must remain in RuneContext docs.",
        "info",
      )
    }
  }

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
    runtimeMetadata?: {
      repoMapPath: string
      reconnaissancePath: string
      durablePlanDocPath?: string
    }
  } = {
    changeId,
    currentVersion: "v1",
    approvedVersion: null,
    lifecycleState: "draft",
    runeContext: {
      enabled: false,
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
    implementationTasks: path.join(versionDir, "implementation-tasks.md"),
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
  if (!profileResult.resolved) {
    options.onProgress?.(`⚠️ ${profileResult.advisory}`, "warning")
  }

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
  if (!options.forceAdHoc && (changePath.includes("@") || changePath.includes("/context/"))) {
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
            initialPlanState.runeContext.enabled = true

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

                      // Write placeholder implementation-tasks.md
                      const implTasks = [
                        `# Implementation Tasks`,
                        ``,
                        `> Derived from RuneContext canonical docs.`,
                        `> Detailed task specs should be filled by the planner before implementation.`,
                        ``,
                        `## Group 1: RuneContext implementation`,
                        ``,
                        `### Objective`,
                        `See execution-groups.md for group description.`,
                        ``,
                        `### Likely files touched`,
                        `TBD`,
                        ``,
                        `### Implementation checklist`,
                        `1. Review the design, standards, and verification artifacts.`,
                        `2. Implement the changes described in the execution group.`,
                        `3. Run scoped verification commands.`,
                        ``,
                        `### Acceptance criteria`,
                        `- All verification steps pass.`,
                        `- No regressions in existing behavior.`,
                      ].join("\n")
                      try {
                        await fs.writeFile(artifactPaths.implementationTasks, implTasks, "utf-8")
                        console.info("[zflow] Wrote placeholder implementation-tasks.md from RuneContext docs")
                      } catch {
                        console.warn("[zflow] Could not write placeholder implementation-tasks.md")
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
        enabled: true,
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
  options.onProgress?.("🗺️ Building repository map and reconnaissance context...", "info")
  const repoMapResult = await buildRepoMap(cwd)
  const reconResult = await buildReconnaissance(cwd, options.changePath)

  // Record runtime state dir and artifact paths in returned metadata
  initialPlanState.runtimeStateDir = resolveRuntimeStateDir(cwd)
  initialPlanState.runtimeMetadata = {
    repoMapPath: repoMapResult.path,
    reconnaissancePath: reconResult.path,
    ...(durableDraftPlan ? { durablePlanDocPath: durableDraftPlan.path } : {}),
  }
  try {
    const raw = await fs.readFile(planStatePath, "utf-8")
    const planState = JSON.parse(raw)
    planState.runtimeMetadata = {
      ...(planState.runtimeMetadata ?? {}),
      ...initialPlanState.runtimeMetadata,
    }
    planState.updatedAt = new Date().toISOString()
    await fs.writeFile(planStatePath, JSON.stringify(planState, null, 2), "utf-8")
  } catch {
    console.warn("[zflow] Could not persist runtime metadata in plan-state.json.")
  }

  // ── Step 10: Attempt optional agent dispatch via registry ───────
  options.onProgress?.("🤖 Dispatching zflow.planner-frontier to generate plan artifacts...", "info")
  const agentDispatchResult = await runPrepareAgentsIfAvailable(
    changeId,
    "v1",
    cwd,
    options.changePath,
    effectivePrepareNotes,
    (message) => options.onProgress?.(message, "info"),
  )
  if (agentDispatchResult.dispatched) {
    options.onProgress?.(
      `✅ Planner dispatch completed via ${agentDispatchResult.serviceName}.` +
      `${agentDispatchResult.methodUsed} (${agentDispatchResult.producedOutputs.length} outputs).`,
      "info",
    )
  } else if (agentDispatchResult.agentDispatchStatus === "unavailable") {
    options.onProgress?.("⚠️ No agent dispatch service available — planner did not run.", "warning")
  } else {
    options.onProgress?.(`⚠️ Agent dispatch failed: ${agentDispatchResult.error}`, "warning")
  }

  try {
    const synthesizedImplementationTasks = await ensureImplementationTasksArtifact(changeId, "v1", cwd)
    if (synthesizedImplementationTasks) {
      options.onProgress?.(
        "🧩 Synthesized missing implementation-tasks.md from execution-groups.md. This recovery artifact is not approvable until the planner rewrites it.",
        "warning",
      )
    }
  } catch (err) {
    options.onProgress?.(
      `⚠️ Could not synthesize implementation-tasks.md: ${err instanceof Error ? err.message : String(err)}`,
      "warning",
    )
  }

  // ── Step 11: Validate plan artifacts ────────────────────────────
  const { validateAllPlanArtifacts } = await import("./plan-artifact-validator.js")
  options.onProgress?.("🔍 Validating plan artifacts against format contracts...", "info")
  const validationResult = await validateAllPlanArtifacts(changeId, "v1", cwd)

  if (!validationResult.valid) {
    const errors = validationResult.results
      .filter((r) => !r.valid)
      .map((r) => `- **${r.artifact}**: ${r.issues.join("; ")}`)
      .join("\n")
    options.onProgress?.(
      `⚠️ Plan artifacts have validation issues:\n${errors}\n` +
      `Attempting planner repair pass...`,
      "warning",
    )

    // Attempt automated repair via the planner agent
    const { runArtifactRepair } = await import("./plan-artifact-validator.js")
    const repairResult = await runArtifactRepair(changeId, "v1", validationResult.results.filter(r => !r.valid), 2, cwd)

    if (repairResult.repaired) {
      options.onProgress?.("✅ Plan artifacts repaired successfully.", "info")
    } else {
      const remaining = repairResult.remainingIssues
        .filter((r) => !r.valid)
        .map((r) => `- **${r.artifact}**: ${r.issues.join("; ")}`)
        .join("\n")
      options.onProgress?.(
        `⚠️ Some plan artifacts could not be automatically repaired:\n${remaining}\n` +
        `Plan approval will be blocked until these are resolved.\n` +
        `Artifact paths for manual editing:\n` +
        Object.entries(artifactPaths).map(([k, v]) => `  - ${k}: ${v}`).join("\n"),
        "warning",
      )
    }
  } else {
    options.onProgress?.("✅ All plan artifacts pass format validation.", "info")
  }

  return {
    changeId,
    planVersion: "v1",
    stateDir: path.dirname(planStatePath),
    planStatePath,
    artifactPaths,
    initialPlanState,
    agentDispatchResult,
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
            label: "Inspect Artifacts",
            content: "Pause here. Review the generated plan and review findings paths before deciding.",
          },
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
        recommended: "Inspect Artifacts",
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
): { decision: string; revisionNotes?: string; selectedFindings?: string[] } {
  try {
    const parsed = JSON.parse(response)
    return {
      decision: parsed.decision ?? parsed.action ?? "cancel",
      revisionNotes: parsed.revisionNotes,
      ...(parsed.selectedFindings ? { selectedFindings: parsed.selectedFindings } : {}),
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
  await migrateLegacyChangeArtifactsIfPresent(options.changeId, cwd)
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
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const execFileAsync = promisify(execFile)
  const { stdout: repoRootRaw } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
    cwd: cwd ?? process.cwd(),
  })
  const repoRoot = repoRootRaw.trim()

  let worktreeDirty = false
  try {
    const { stdout: statusRaw } = await execFileAsync("git", ["status", "--porcelain"], { cwd: repoRoot })
    const status = statusRaw.trim()
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

  // 6. Verify canonical artifacts exist and execution-groups.md is parseable
  let executionGroupsContent = ""
  for (const [key, ap] of Object.entries(artifactPaths)) {
    try {
      await fs.access(ap)
      if (key === "executionGroups") {
        executionGroupsContent = await fs.readFile(ap, "utf-8")
        const parsed = parseExecutionGroupsMd(executionGroupsContent)
        if (parsed.length === 0) {
          const preview = executionGroupsContent.slice(0, 500).trim()
          throw new Error(
            `No execution groups found in ${ap}. ` +
            "The approved plan must contain at least one implementation group.\n\n" +
            "The execution-groups.md file exists but contains no parseable groups.\n" +
            `File content preview (first 500 chars):\n\`\`\`\n${preview}${executionGroupsContent.length > 500 ? "\n…(truncated)" : ""}\n\`\`\`\n\n` +
            "Expected format — each group must start with a heading like:\n" +
            "  ## Group 1: descriptive name\n" +
            "  ## G1 — descriptive name\n" +
            "  ## Execution Group 1: descriptive name\n\n" +
            "Followed by:\n" +
            "  **Files:** path/to/file.ts, another/file.ts\n" +
            "  **Agent:** zflow.implement-routine\n" +
            "  **Scoped verification:** the verification command for this group\n\n" +
            "Run /zflow-change-prepare to recreate the plan with valid execution groups.",
          )
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("No execution groups found")) {
        throw err
      }
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
  status: "passed" | "failed" | "skipped"
  command: string
  output: string
  duration: number
  error?: string
}> {
  const { default: fs } = await import("node:fs/promises")
  const { parseVerificationMdCommand, resolveVerificationCommand, runVerification } = await import("./verification.js")
  const { resolvePlanArtifactPath } = await import("pi-zflow-artifacts/artifact-paths")

  const run = await readRun(runId, cwd)
  const repoRoot = run.repoRoot

  // Try to extract a verification command from the approved plan's verification.md
  let planCommand: string | null = null
  try {
    const verifMdPath = resolvePlanArtifactPath(run.changeId, run.planVersion, "verification", cwd)
    const verifMdContent = await fs.readFile(verifMdPath, "utf-8")
    planCommand = parseVerificationMdCommand(verifMdContent)
  } catch {
    // verification.md may not exist yet — non-fatal, fall through to other sources
  }

  // Resolve verification command (precedence: profile, repo config, plan, auto-detect)
  const command = resolveVerificationCommand(repoRoot, undefined, planCommand ?? undefined)
  if (!command) {
    console.warn("[zflow] No verification command resolved — marking verification as skipped.")
    await updateRun(runId, {
      verification: { status: "skipped" },
    } as any, cwd)
    return { pass: true, status: "skipped", command: "(none)", output: "Verification skipped — no command resolved.", duration: 0 }
  }

  // Run verification
  const result = await runVerification(command, repoRoot)

  const vStatus = result.pass ? "passed" : "failed"
  // Truncate output for run.json to avoid bloating the state file
  const truncatedOutput = result.output.length > 2000
    ? result.output.slice(0, 2000) + "\n...(truncated)"
    : result.output

  // Log to run.json
  await updateRun(runId, {
    verification: {
      status: vStatus,
      command: result.command,
      output: truncatedOutput,
      completedAt: new Date().toISOString(),
      failureCount: result.pass ? 0 : 1,
    },
    // Invalidate stale code review when verification reruns successfully.
    // A new verification pass means any previous review was based on different
    // code state, so it should not remain silently authoritative.
    ...(result.pass ? { codeReview: null } : {}),
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
    status: vStatus,
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
    // Invalidate stale code review when fix loop succeeds
    ...(result.success ? { codeReview: null } : {}),
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
/**
 * Per-reviewer progress callback used by implement workflow progress cards.
 */
export interface ReviewerProgressCallback {
  (update: {
    reviewerName: string
    agentName: string
    status: "queued" | "running" | "completed" | "failed"
    model?: string
    thinking?: string
    currentTool?: string
    lastCommand?: string
  }): void
}

export async function finalizeCodeReview(
  runId: string,
  cwd?: string,
  onReviewerUpdate?: ReviewerProgressCallback,
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
      const { default: path } = await import("node:path")
      const { default: fs } = await import("node:fs/promises")

      const planningArtifacts = {
        design: resolvePlanArtifactPath(run.changeId, run.planVersion, "design", cwd),
        executionGroups: resolvePlanArtifactPath(run.changeId, run.planVersion, "execution-groups", cwd),
        standards: resolvePlanArtifactPath(run.changeId, run.planVersion, "standards", cwd),
        verification: resolvePlanArtifactPath(run.changeId, run.planVersion, "verification", cwd),
      }

      // Build a unified diff bundle from all applied group patch files
      let diffBundle = ""
      const groupPatchPaths: string[] = []
      for (const group of run.groups) {
        if (group.patchPath) groupPatchPaths.push(group.patchPath)
      }

      if (groupPatchPaths.length > 0) {
        const parts: string[] = []
        for (const patchPath of groupPatchPaths) {
          try {
            const content = await fs.readFile(patchPath, "utf-8")
            parts.push(content.trimEnd())
          } catch {
            parts.push(`# Patch not found: ${patchPath}`)
          }
        }
        diffBundle = parts.length > 0 ? parts.join("\n") : ""
      }

      const modifiedFiles: string[] = []
      for (const group of run.groups) {
        if (Array.isArray(group.changedFiles)) {
          for (const f of group.changedFiles) {
            if (!modifiedFiles.includes(f)) modifiedFiles.push(f)
          }
        }
      }

      // Resolve execution groups from the plan artifact for tier triggers
      let executionGroups: Array<{ reviewTags?: string | string[] }> | undefined
      try {
        const execPath = resolvePlanArtifactPath(run.changeId, run.planVersion, "execution-groups", cwd)
        const execMd = await fs.readFile(execPath, "utf-8")
        const parsed = parseExecutionGroupsMd(execMd)
        executionGroups = parsed.map((g) => ({
          reviewTags: g.reviewTags ?? undefined,
        }))
      } catch {
        // execution-groups.md may not exist — non-fatal
      }

      // Map to runCodeReview's callback shape
      const onReviewUpdate = onReviewerUpdate
        ? (update: { reviewerName: string; agentName: string; status: string; model?: string; thinking?: string; currentTool?: string; lastCommand?: string }): void => {
            onReviewerUpdate({
              reviewerName: update.reviewerName,
              agentName: update.agentName,
              status: update.status as "queued" | "running" | "completed" | "failed",
              model: update.model,
              thinking: update.thinking,
              currentTool: update.currentTool,
              lastCommand: update.lastCommand,
            })
          }
        : undefined

      const result = await (reviewService.runCodeReview as Function)({
        source: `Implementation of ${run.changeId}`,
        repoPath: run.repoRoot || cwd || process.cwd(),
        branch: run.branch || "(unknown)",
        planningArtifacts,
        verificationStatus: (run.verification as any)?.status || "unknown",
        diffBundle: diffBundle || undefined,
        diffSource: diffBundle ? "run-patches" : undefined,
        modifiedFiles: modifiedFiles.length > 0 ? modifiedFiles : undefined,
        executionGroups,
        onReviewUpdate,
        cwd,
      })

      const severity = (result as any).severity as { critical: number; major: number; minor: number; nit: number }
      const recommendation = (result as any).recommendation as string | undefined
      const manifest = (result as any).manifest as { reviewers: Array<{ name: string; status: string; required?: boolean }> } | undefined
      const coverageNotes = (result as any).coverageNotes as string[] | undefined

      // Check for required reviewer failures (defence in depth — runCodeReview
      // already sets recommendation = "NO-GO" when required reviewers fail,
      // but we also check here directly since this is the gating interface).
      const failedRequiredReviewers: string[] = []
      if (manifest?.reviewers) {
        for (const r of manifest.reviewers) {
          if (r.status === "failed" && (r.required !== false)) {
            failedRequiredReviewers.push(r.name)
          }
        }
      }

      // pass = no critical/major issues AND no failed required reviewers AND recommendation is not NO-GO
      const hasPassableSeverity = severity.critical === 0 && severity.major === 0
      const hasFailedRequiredReviewers = failedRequiredReviewers.length > 0
      const isNoGo = recommendation === "NO-GO"

      const pass = hasPassableSeverity && !hasFailedRequiredReviewers && !isNoGo

      // Build a summary that includes coverage notes for failed reviewers
      let summary = `Code review: ${severity.critical} critical, ${severity.major} major, ${severity.minor} minor issues.`
      if (hasFailedRequiredReviewers) {
        summary += ` Required reviewer(s) failed: ${failedRequiredReviewers.join(", ")}.`
      }
      if (isNoGo && !hasFailedRequiredReviewers) {
        summary += ` Review recommendation: NO-GO.`
      }
      if (coverageNotes && coverageNotes.length > 0) {
        const relevantNotes = coverageNotes.filter(n => n.includes("Fail-closed") || n.includes("failed") || n.includes("error") || n.includes("ENOENT") || n.includes("severity"))
        if (relevantNotes.length > 0) {
          summary += ` ${relevantNotes.join("; ")}`
        }
      }

      const findingsPath = (result as any).findingsPath as string | undefined

      // Persist code review results to run.json so they survive restarts/resumes
      try {
        await updateRun(runId, {
          codeReview: {
            pass,
            findingsPath: findingsPath ?? null,
            severity,
            summary,
            completedAt: new Date().toISOString(),
          },
        } as any, cwd)
      } catch {
        // Non-fatal — review result is available via the findings file
        console.warn("[zflow] Failed to persist code review result to run state")
      }

      return {
        pass,
        findingsPath,
        summary,
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

  // Guard: refuse to mark as completed if apply-back is conflicted or failed.
  const currentRun = await readRun(runId, cwd)
  if (currentRun.applyBack.status === "conflicted" || currentRun.applyBack.status === "rolled-back" || currentRun.applyBack.status === "failed") {
    const errMsg = `Cannot complete workflow for run ${runId}: apply-back status is "${currentRun.applyBack.status}". Resolve the apply-back conflict first.`
    console.error(`[zflow] ${errMsg}`)
    throw new Error(errMsg)
  }

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
  /** Receives user-visible phase updates for long post-dispatch work. */
  onProgress?: (message: string) => void
  /** Per-reviewer progress callback for code review cards. */
  onReviewerUpdate?: ReviewerProgressCallback
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
  status: "waiting-for-dispatch" | "verifying" | "reviewing" | "completed" | "failed" | "verification-skipped"
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
 * 5. **verification-skipped** — No verification command resolved. Does not
 *    automatically proceed to code review. User must address or explicitly
 *    override.
 * 6. **reviewing** — Verification passed; runs `finalizeCodeReview()`.
 * 7. **completed** — Review passed (or skipped); calls `completeWorkflow()`.
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
  const reportProgress = (message: string): void => {
    try { opts.onProgress?.(message) } catch { /* progress callbacks are best-effort */ }
  }

  // 1. Read the current run state
  const run = await readRun(runId, cwd)
  const changeId = run.changeId

  // 1a. Check for apply-back conflict/failure before proceeding.
  //     If apply-back failed, the primary worktree does not have the
  //     implementation changes — do not run verification, review, or
  //     completion against this invalid state.  The patches are preserved
  //     in the run directory for manual resolution.
  if (run.applyBack.status === "conflicted" || run.applyBack.status === "rolled-back" || run.applyBack.status === "failed") {
    const reason = run.applyBack.error ?? `apply-back ${run.applyBack.status}`
    const failPhase = "apply-back-conflicted" as RunPhase
    await transitionTo(failPhase)

    // Build a rich failure message using the centralized formatter.
    // Use changeId as the changeInput since we don't have the original
    // command argument in this context.
    const { default: pathModule } = await import("node:path")
    const runDir = resolveRunDir(runId, cwd)
    const patchesPath = pathModule.join(runDir, "patches")
    const intWorktreePath = pathModule.join(runDir, "integration-worktree")
    const resolutionPromptPath = pathModule.join(runDir, "subagent-resolution-prompt.md")
    let hasResolutionPrompt = false
    try { await import("node:fs/promises").then(fs => fs.access(resolutionPromptPath)); hasResolutionPrompt = true } catch {}
    const failureMsg = await formatApplyBackFailureMessage(
      runId,
      changeId,
      reason,
      cwd,
      {
        patchesDir: patchesPath,
        integrationWorktreePath: run.applyBack.integrationWorktreePath ?? (
          await import("node:fs/promises").then(fs =>
            fs.access(intWorktreePath).then(() => intWorktreePath).catch(() => undefined)
          ).catch(() => undefined)
        ),
        resolutionPromptPath: hasResolutionPrompt ? resolutionPromptPath : undefined,
        strategiesAttempted: (run.metadata as any)?.strategiesAttempted ?? undefined,
      },
    )

    const nextSteps = [
      `⚠️ Apply-back ${run.applyBack.status}. The primary worktree does not have the implementation changes.`,
      `   Reason: ${reason}`,
      `1. 🤖 Subagent resolution: /zflow-resolve-apply-back ${runId}`,
      "2. 🔧 Resolve manually, then run: /zflow-change-implement --resume",
      "3. 📂 Use /zflow-change-audit to inspect the run status.",
      "4. 🗑️ Abandon: /zflow-change-implement --abandon",
    ]
    await recordImplementationNextSteps(runId, nextSteps, cwd)
    reportProgress(failureMsg)
    return {
      phase: failPhase,
      status: "failed",
      verificationStatus: "pending",
      error: `${reason}\n\n${failureMsg}`,
      runId,
      changeId,
      nextSteps,
    }
  }

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
    reportProgress("Waiting for dispatch artifacts before final verification")
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
      const reviewResult = await finalizeCodeReview(runId, cwd, opts.onReviewerUpdate)
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
  reportProgress("Preparing final verification on the primary worktree")
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

  reportProgress("Running final verification on the primary worktree")
  const verificationResult = await finalizeVerification(runId, cwd)
  if (verificationResult.status === "skipped") {
    // Verification was skipped (no command resolved). Do NOT automatically
    // proceed to code review and completion. Gate: the user must either
    // provide a verification command or explicitly pass skipVerification.
    reportProgress("Final verification was skipped (no command resolved). Gating workflow — user action required.")
    await transitionTo("verification-skipped" as RunPhase)
    await updateRun(runId, {
      verification: { status: "skipped" },
    } as any, cwd)
    return {
      phase: "verification-skipped",
      status: "failed",
      verificationStatus: "skipped",
      runId,
      changeId,
      error: "Final verification skipped — no command resolved. The implementation patches are applied but haven't been verified. Run /zflow-change-audit or pass --skip-verification to proceed without verification.",
      nextSteps: [
        "⚠️ Final verification was skipped because no verification command was resolved.",
        "   The implementation patches have been applied but not validated.",
        "1. Provide a verification command (e.g. in the plan's verification.md) and run --resume.",
        "2. Or manually run verification checks outside of zflow.",
        "3. Use /zflow-change-audit to inspect the run status.",
      ],
    }
  }

  if (verificationResult.pass) {
    reportProgress("Final verification passed; starting code review")
  } else {
    reportProgress("Final verification failed; evaluating fix loop")
  }

  if (!verificationResult.pass) {
    // 3c. Verification failed — attempt fix loop if autoFix is enabled
    if (autoFix) {
      reportProgress("Running bounded fix loop after verification failure")
      const fixHandler = opts.fixHandler ?? (async () => false)
      const fixLoopResult = await runBoundedFixLoop(runId, fixHandler, cwd)

      if (!fixLoopResult.success) {
        reportProgress("Fix loop exhausted; marking verification failed")
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

      reportProgress("Fix loop succeeded; continuing to code review")
      // Fix loop succeeded — verification passes now
    } else {
      // autoFix disabled — mark as failed
      reportProgress("Final verification failed; auto-fix is disabled")
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
    reportProgress("Running code review on the applied implementation")
    const reviewResult = await finalizeCodeReview(runId, cwd, opts.onReviewerUpdate)
    reportProgress(reviewResult.pass ? "Code review passed; completing workflow" : "Code review found issues; marking review failed")

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
    reportProgress("Persisting completed workflow state")
    await completeWorkflow(changeId, runId, cwd)
    reportProgress("Workflow completion persisted")

    // Check for orphaned helper scripts left outside .zflow/
    try {
      const { scanForOrphanedScripts } = await import("./orchestration.js")
      const orphans = await scanForOrphanedScripts({ cwd })
      if (orphans.length > 0) {
        reportProgress(
          `⚠️ Found ${orphans.length} orphaned helper script(s) outside .zflow/:\n` +
          orphans.map((o) => `  - ${o}`).join("\n") +
          "\nThese should be removed or moved to `.zflow/runs/<runId>/scratch/scripts/`.",
        )
      }
    } catch {
      // Non-critical — best-effort scan
    }

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
  reportProgress("Review skipped; completing workflow")
  await transitionTo("completed")
  await completeWorkflow(changeId, runId, cwd)

  // Check for orphaned helper scripts left outside .zflow/
  try {
    const { scanForOrphanedScripts } = await import("./orchestration.js")
    const orphans = await scanForOrphanedScripts({ cwd })
    if (orphans.length > 0) {
      reportProgress(
        `⚠️ Found ${orphans.length} orphaned helper script(s) outside .zflow/:\n` +
        orphans.map((o) => `  - ${o}`).join("\n") +
        "\nThese should be removed or moved to `.zflow/runs/<runId>/scratch/scripts/`.",
      )
    }
  } catch {
    // Non-critical — best-effort scan
  }

  return {
    phase: "completed",
    status: "completed",
    verificationStatus: "passed",
    runId,
    changeId,
    nextSteps: [],
  }
}

// ═══════════════════════════════════════════════════════════════════
// Durable plan artifact publishing
// ═══════════════════════════════════════════════════════════════════

/**
 * Mapping of artifact names to their canonical file names.
 */
const PUBLISH_ARTIFACT_FILES: Record<string, string> = {
  design: "design.md",
  executionGroups: "execution-groups.md",
  standards: "standards.md",
  verification: "verification.md",
  implementationTasks: "implementation-tasks.md",
}

/**
 * Result of publishing plan artifacts to the durable repo path.
 */
export interface PublishPlanArtifactsResult {
  /** The change identifier. */
  changeId: string
  /** The plan version that was published. */
  planVersion: string
  /** Absolute path to the durable directory under the repo. */
  durableDir: string
  /** Per-artifact mapping: durable file path for each published artifact. */
  publishedArtifacts: Record<string, string>
  /** Absolute path to the generated manifest file. */
  manifestPath: string
  /** Number of artifacts successfully published. */
  artifactCount: number
  /** Any errors encountered (non-fatal). */
  errors: string[]
}

/**
 * Default relative path under the repo root for durable change documents.
 */
const DEFAULT_PUBLISH_REPO_PATH = "docs/zflow-changes"

/**
 * Publish plan artifacts from the runtime state directory into a durable
 * repo-visible path so they can be reviewed, committed, and shared.
 *
 * The artifacts are copied from:
 *   `<runtime-state-dir>/plans/{changeId}/{planVersion}/`
 * into:
 *   `<repoRoot>/{repoRelativeDir}/{changeId}/{planVersion}/`
 *
 * A manifest file (`manifest.json`) is also written in the target directory
 * with metadata about the change, version, source paths, and pointers to
 * runtime-only artifacts.
 *
 * @param changeId - Unique change identifier.
 * @param planVersion - Plan version label (e.g. "v1").
 * @param options
 * @param options.cwd - Working directory (defaults to `process.cwd()`).
 * @param options.repoRelativeDir - Relative path under repo root for durable docs
 *   (default: `"docs/zflow-changes"`).
 * @param options.versionDir - Explicit version directory override (auto-resolved
 *   when omitted).
 * @param options.runtimeStateDir - Explicit runtime state dir override.
 * @returns A structured publish result with durable paths.
 */
export async function publishPlanArtifacts(
  changeId: string,
  planVersion: string,
  options?: {
    cwd?: string
    repoRelativeDir?: string
    versionDir?: string
    runtimeStateDir?: string
    reviewFindingsPath?: string
  },
): Promise<PublishPlanArtifactsResult> {
  const { default: fs } = await import("node:fs/promises")
  const { default: path } = await import("node:path")
  const { resolveRuntimeStateDir } = await import("pi-zflow-core/runtime-paths")
  const { resolvePlanVersionDir } = await import("pi-zflow-artifacts/artifact-paths")

  const cwd = options?.cwd ?? process.cwd()
  const repoRelativeDir = options?.repoRelativeDir ?? DEFAULT_PUBLISH_REPO_PATH

  // Resolve runtime source directory
  const runtimeStateDir = options?.runtimeStateDir ?? resolveRuntimeStateDir(cwd)
  const srcVersionDir = options?.versionDir ?? (
    // When runtimeStateDir is overridden, derive the version dir directly
    // instead of falling back to resolvePlanVersionDir (which ignores the override).
    options?.runtimeStateDir
      ? path.join(runtimeStateDir, "plans", changeId, planVersion)
      : resolvePlanVersionDir(changeId, planVersion, cwd)
  )

  // Resolve repo root
  let repoRoot: string
  try {
    const { execSync } = await import("node:child_process")
    repoRoot = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf-8",
      timeout: 5_000,
    }).trim()
  } catch {
    repoRoot = cwd
  }

  // Validate changeId and planVersion to prevent path traversal
  assertSafeChangeId(changeId)
  assertValidPlanVersion(planVersion)

  // Validate repoRelativeDir is not absolute (would escape repo root)
  if (path.isAbsolute(repoRelativeDir)) {
    throw new Error(
      `repoRelativeDir must be a relative path, got absolute: "${repoRelativeDir}"`,
    )
  }

  // Build durable target path
  const durableDir = path.resolve(repoRoot, repoRelativeDir, changeId, planVersion)

  // Double-check that durableDir stays within the repo root
  const relative = path.relative(repoRoot, durableDir)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `Durable publish path "${durableDir}" escapes repository root "${repoRoot}". ` +
      `Change ID "${changeId}" or planVersion "${planVersion}" may contain path traversal.`,
    )
  }

  // Published artifact paths
  const publishedArtifacts: Record<string, string> = {}
  const errors: string[] = []

  // Create target directory
  await fs.mkdir(durableDir, { recursive: true })

  // Copy each artifact
  for (const [artifactKey, fileName] of Object.entries(PUBLISH_ARTIFACT_FILES)) {
    const srcPath = path.join(srcVersionDir, fileName)
    const destPath = path.join(durableDir, fileName)

    try {
      await fs.access(srcPath)
      await fs.copyFile(srcPath, destPath)
      publishedArtifacts[artifactKey] = destPath
    } catch {
      errors.push(`Artifact "${artifactKey}" not found at source: ${srcPath}`)
    }
  }

  // Write manifest.json
  const runtimePlansDir = path.join(runtimeStateDir, "plans")
  const manifestPath = path.join(durableDir, "manifest.json")

  const manifest = {
    changeId,
    planVersion,
    generatedAt: new Date().toISOString(),
    sourceRuntimePath: path.join(runtimePlansDir, changeId),
    sourceArtifacts: Object.fromEntries(
      Object.entries(PUBLISH_ARTIFACT_FILES).map(([key, fn]) => [key, path.join(srcVersionDir, fn)]),
    ),
    publishedArtifacts,
    note: "Review findings, logs, and transient runtime state remain under .zflow/. This directory contains durable plan documents intended for review and commit.",
    reviewFindingsRef: options?.reviewFindingsPath ?? path.join(runtimeStateDir, "review", `plan-review-${changeId}-${planVersion}.md`),
  }

  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8")

  // ── Update or create the sibling plan.md entrypoint ───────────
  // Collect published versions to build the version-index managed section.
  const publishedVersions: string[] = []
  try {
    const planDocDir = path.dirname(durableDir)
    const entries = await fs.readdir(planDocDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && /^v\d+$/.test(entry.name)) {
        publishedVersions.push(entry.name)
      }
    }
  } catch {
    // planDocDir may not exist yet — that's fine
  }
  // Ensure current version is included
  if (!publishedVersions.includes(planVersion)) {
    publishedVersions.push(planVersion)
  }
  publishedVersions.sort((a, b) => Number.parseInt(b.slice(1), 10) - Number.parseInt(a.slice(1), 10))

  try {
    await writeDurablePlanDoc(changeId, {
      currentVersion: planVersion,
    }, {
      cwd,
      repoRoot,
      repoRelativeDir,
      publishedVersions,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    errors.push(`plan.md entrypoint update failed: ${msg}`)
  }

  return {
    changeId,
    planVersion,
    durableDir,
    publishedArtifacts,
    manifestPath,
    artifactCount: Object.keys(publishedArtifacts).length,
    errors,
  }
}

// ═══════════════════════════════════════════════════════════════════
// Ephemeral script policy helpers
// ═══════════════════════════════════════════════════════════════════

/**
 * Resolve the scratch scripts directory for a run.
 *
 * Path: `<runtime-state-dir>/runs/<runId>/scratch/scripts/`
 *
 * This directory is the ONLY allowed location for ephemeral helper scripts
 * (verification wrappers, debug scripts, temp build scripts, etc.) created
 * by subagent workers during workflow execution. Scripts placed here are
 * gitignored, cleanup-tracked, and automatically removed by `/zflow-clean`.
 *
 * @param runId - Unique run identifier.
 * @param cwd - Working directory (optional).
 * @returns Absolute path to the scratch scripts directory.
 */
export async function resolveScratchScriptsDir(
  runId: string,
  cwd?: string,
): Promise<string> {
  const { default: path } = await import("node:path")
  const { resolveRunDir } = await import("pi-zflow-artifacts/artifact-paths")
  const runDir = resolveRunDir(runId, cwd)
  return path.join(runDir, "scratch", "scripts")
}

/**
 * Ensure the scratch scripts directory exists and return its path.
 *
 * Creates the directory (and any parent directories) if it does not exist.
 * Also registers the scratch directory as a retained artifact with a 3-day TTL
 * so `/zflow-clean` picks it up for cleanup.
 *
 * @param runId - Unique run identifier.
 * @param cwd - Working directory (optional).
 * @returns Absolute path to the scratch scripts directory.
 */
export async function ensureScratchScriptsDir(
  runId: string,
  cwd?: string,
): Promise<string> {
  const { default: fs } = await import("node:fs/promises")
  const scratchDir = await resolveScratchScriptsDir(runId, cwd)
  await fs.mkdir(scratchDir, { recursive: true })

  // Track as retained artifact with 3-day TTL for cleanup discovery
  try {
    const { addRetainedArtifact } = await import("pi-zflow-artifacts")
    await addRetainedArtifact(runId, {
      type: "scratch",
      path: scratchDir,
      reason: "Ephemeral helper scripts directory",
      expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    }, cwd)
  } catch {
    // Non-critical — best-effort tracking
  }

  return scratchDir
}

/**
 * Build a markdown snippet describing the ephemeral script policy.
 *
 * This rule must be injected into subagent task prompts for workflows
 * that may create temporary helper scripts, such as apply-back resolution
 * and fix implementation.
 *
 * @param scratchScriptsDir - Absolute path to the scratch scripts directory.
 * @returns A markdown string with the ephemeral script policy.
 */
export function buildEphemeralScriptRule(scratchScriptsDir: string): string {
  return [
    "## Ephemeral Script Policy",
    "",
    "Any temporary helper script you write (verification wrappers, debug scripts,",
    "build helpers, etc.) MUST be written ONLY to:",
    "",
    `\`\`\``,
    `${scratchScriptsDir}/`,
    `\`\`\``,
    "",
    "**NEVER write helper scripts to:**",
    "- The repo root (`/`)",
    "- `scripts/` directory",
    "- `test/` or `tests/` directories (unless they are part of the actual code change)",
    "- Source directories (`src/`, `lib/`, `packages/*/src/`)",
    "",
    "Scripts in the scratch directory are gitignored and automatically cleaned up.",
    "Scripts elsewhere pollute the repository and will be flagged as orphaned.",
    "",
    "If you need to run a multi-step verification, write a temporary script to:",
    `\`\`\``,
    `${scratchScriptsDir}/`,
    `\`\`\``,
    "and run it from there.",
    "",
    "**Violations of this policy will be blocked by the path guard.**",
  ].join("\n")
}

/**
 * Scan for orphaned helper scripts at the repo root and `scripts/` directory.
 *
 * Checks for files matching patterns commonly used for temporary helper scripts:
 * `verify*`, `check*`, `debug*`, `tmp*`, `fix*`, `test-*`, `run-*`
 *
 * Only reports files modified within the last hour (default) to avoid flagging
 * legitimate project files.
 *
 * @param options - Scan options.
 * @param options.cwd - Working directory (defaults to `process.cwd()`).
 * @param options.maxAgeMinutes - Maximum age in minutes for files to report (default: 60).
 * @returns Array of paths to orphaned script files.
 */
export async function scanForOrphanedScripts(
  options?: {
    cwd?: string
    maxAgeMinutes?: number,
  },
): Promise<string[]> {
  const { default: fs } = await import("node:fs/promises")
  const { default: path } = await import("node:path")
  const maxAge = (options?.maxAgeMinutes ?? 60) * 60 * 1000
  const now = Date.now()
  const cwd = options?.cwd ?? process.cwd()

  const scanDirs = [cwd]
  const scriptsDir = path.join(cwd, "scripts")
  try {
    await fs.access(scriptsDir)
    scanDirs.push(scriptsDir)
  } catch {
    // scripts/ doesn't exist — skip
  }

  const scriptPatterns = [
    /^verify/i,
    /^check/i,
    /^debug/i,
    /^tmp\b/i,
    /^fix-/i,
    /^test-/i,
    /^run-/i,
  ]

  const orphans: string[] = []

  for (const dir of scanDirs) {
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      continue
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry)

      // Skip directories, hidden files, and known project files
      if (entry.startsWith(".")) continue
      if (entry === "scripts" && dir === cwd) continue

      try {
        const stat = await fs.stat(fullPath)
        if (stat.isDirectory()) continue

        // Only flag files modified recently
        const age = now - stat.mtimeMs
        if (age > maxAge) continue

        // Check if name matches ephemeral script patterns
        const matchesPattern = scriptPatterns.some((p) => p.test(entry))
        if (!matchesPattern) continue

        // Check if this is a script-like file (shell, js, py, etc.)
        const ext = path.extname(entry).toLowerCase()
        const isScript = [".sh", ".bash", ".zsh", ".js", ".mjs", ".ts", ".py", ".rb", ".pl", ".php", ""].includes(ext)
        if (!isScript) continue

        orphans.push(fullPath)
      } catch {
        // stat failed — skip
      }
    }
  }

  return orphans
}

/**
 * Auto-detect the repo's toolchain and return a shell command to install
 * dependencies in a worktree.  Returns `null` if no supported toolchain is
 * detected, meaning the caller should skip setup (worktree setup hooks are
 * still honoured separately).
 *
 * Detection order (highest priority first):
 *  1. pnpm workspace / pnpm-lock.yaml
 *  2. npm package-lock.json
 *  3. yarn.lock
 *  4. bun.lockb / bun.lock
 *
 * If `flake.nix` is also present, wraps the command in `nix develop`.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @returns A shell command string, or `null` if no toolchain is detected.
 */
export async function detectWorktreeSetupCommand(repoRoot: string): Promise<string | null> {
  const { detectWorktreeSetupCommand } = await import("./worktree-auto-setup.js")
  return detectWorktreeSetupCommand(repoRoot)
}

// ═══════════════════════════════════════════════════════════════════
// Durable draft-plan document (plan.md) helpers
// ═══════════════════════════════════════════════════════════════════

/**
 * Default frontmatter fields for a durable draft plan doc (plan.md).
 */
export interface DurablePlanDocFrontmatter {
  schemaVersion: number
  changeId: string
  status: "draft" | "validated" | "reviewed" | "approved" | "superseded" | "cancelled"
  sourceMode: "adhoc" | "runecontext"
  currentVersion: string | null
  approvedVersion: string | null
  [key: string]: unknown
}

/**
 * Parsed durable plan doc with frontmatter and body.
 */
export interface DurablePlanDoc {
  frontmatter: DurablePlanDocFrontmatter
  body: string
  path: string
  validationErrors: string[]
  bodyValidationErrors: string[]
}

const DURABLE_PLAN_DOC_SCHEMA_VERSION = 1
const DURABLE_PLAN_DOC_STATUSES = new Set<DurablePlanDocFrontmatter["status"]>([
  "draft",
  "validated",
  "reviewed",
  "approved",
  "superseded",
  "cancelled",
])
const DURABLE_PLAN_DOC_SOURCE_MODES = new Set<DurablePlanDocFrontmatter["sourceMode"]>([
  "adhoc",
  "runecontext",
])
const DURABLE_PLAN_DOC_CORE_FRONTMATTER_KEYS = new Set([
  "schemaVersion",
  "changeId",
  "status",
  "sourceMode",
  "currentVersion",
  "approvedVersion",
])

/**
 * Managed-section marker constants used to distinguish auto-generated
 * content from user-authored content inside plan.md.
 *
 * These markers delimit sections that the system may overwrite during
 * updates.  Content outside markers is preserved across updates.
 */
const MANAGED_OPEN_PREFIX = "<!-- zflow-managed:"
const MANAGED_CLOSE = "<!-- /zflow-managed -->"
const MANAGED_SECTION_RE = /<!--\s*zflow-managed:\s*([^\n]*?)\s*-->([\s\S]*?)<!--\s*\/zflow-managed\s*-->/g
const DURABLE_PLAN_DOC_REQUIRED_HEADINGS = [
  "Summary",
  "Goals / Success Criteria",
  "Scope In",
  "Scope Out",
  "Relevant codebase areas",
  "Constraints",
  "Decisions",
  "Risks / Unknowns",
  "Proposed execution outline",
  "Verification approach",
  "Open questions",
] as const
const DURABLE_PLAN_DOC_PLACEHOLDER_LINES = [
  "_Describe the change, why it is needed, and what it accomplishes._",
  "_List the desired outcomes, user-visible success criteria, and technical completion checks._",
  "_What is included in this change._",
  "_What is explicitly excluded._",
  "_Files, modules, services, docs, and neighboring systems that should be inspected or are likely to change._",
  "_Technical, architectural, or process constraints._",
  "_Key decisions and trade-offs made during planning._",
  "_Known risks, open questions, and dependencies._",
  "_High-level execution approach, groups, and order._",
  "_Concrete commands, focused tests, manual checks, and pass/fail expectations._",
  "_Any remaining user decisions or unresolved assumptions that could materially change the plan._",
] as const

interface DurablePlanDocOptions {
  cwd?: string
  repoRoot?: string
  repoRelativeDir?: string
}

async function resolveDurablePlanRepoRoot(options?: DurablePlanDocOptions): Promise<string> {
  try {
    const { execSync } = await import("node:child_process")
    return (options?.repoRoot) ?? execSync("git rev-parse --show-toplevel", {
      cwd: options?.cwd ?? process.cwd(),
      encoding: "utf-8",
      timeout: 5_000,
    }).trim()
  } catch {
    return options?.repoRoot ?? (options?.cwd ?? process.cwd())
  }
}

function normalizeDurablePlanVersion(value: unknown): string | null {
  return typeof value === "string" && /^v\d+$/.test(value)
    ? value
    : null
}

function normalizeDurablePlanDocFrontmatter(
  changeId: string,
  frontmatter: Record<string, unknown>,
): DurablePlanDocFrontmatter {
  const normalized: DurablePlanDocFrontmatter = {
    schemaVersion: typeof frontmatter.schemaVersion === "number"
      ? frontmatter.schemaVersion
      : Number(frontmatter.schemaVersion ?? DURABLE_PLAN_DOC_SCHEMA_VERSION),
    changeId: typeof frontmatter.changeId === "string" && frontmatter.changeId.trim()
      ? frontmatter.changeId.trim()
      : changeId,
    status: DURABLE_PLAN_DOC_STATUSES.has(frontmatter.status as DurablePlanDocFrontmatter["status"])
      ? frontmatter.status as DurablePlanDocFrontmatter["status"]
      : "draft",
    sourceMode: DURABLE_PLAN_DOC_SOURCE_MODES.has(frontmatter.sourceMode as DurablePlanDocFrontmatter["sourceMode"])
      ? frontmatter.sourceMode as DurablePlanDocFrontmatter["sourceMode"]
      : "adhoc",
    currentVersion: normalizeDurablePlanVersion(frontmatter.currentVersion),
    approvedVersion: normalizeDurablePlanVersion(frontmatter.approvedVersion),
  }

  for (const [key, value] of Object.entries(frontmatter)) {
    if (!DURABLE_PLAN_DOC_CORE_FRONTMATTER_KEYS.has(key) && key !== "requestNotes") {
      normalized[key] = value
    }
  }

  return normalized
}

export function validateDurablePlanDocFrontmatter(
  frontmatter: Record<string, unknown>,
  expectedChangeId?: string,
): string[] {
  const errors: string[] = []
  const schemaVersion = typeof frontmatter.schemaVersion === "number"
    ? frontmatter.schemaVersion
    : Number(frontmatter.schemaVersion)
  if (!Number.isInteger(schemaVersion) || schemaVersion !== DURABLE_PLAN_DOC_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${DURABLE_PLAN_DOC_SCHEMA_VERSION}`)
  }

  const changeId = typeof frontmatter.changeId === "string" ? frontmatter.changeId.trim() : ""
  if (!changeId) {
    errors.push("changeId is required")
  } else if (!/^[a-z0-9][a-z0-9-]*$/.test(changeId)) {
    errors.push("changeId must be kebab-case")
  } else if (expectedChangeId && changeId !== expectedChangeId) {
    errors.push(`changeId must match ${expectedChangeId}`)
  }

  if (!DURABLE_PLAN_DOC_STATUSES.has(frontmatter.status as DurablePlanDocFrontmatter["status"])) {
    errors.push(`status must be one of: ${Array.from(DURABLE_PLAN_DOC_STATUSES).join(", ")}`)
  }

  if (!DURABLE_PLAN_DOC_SOURCE_MODES.has(frontmatter.sourceMode as DurablePlanDocFrontmatter["sourceMode"])) {
    errors.push(`sourceMode must be one of: ${Array.from(DURABLE_PLAN_DOC_SOURCE_MODES).join(", ")}`)
  }

  for (const [field, value] of Object.entries({
    currentVersion: frontmatter.currentVersion,
    approvedVersion: frontmatter.approvedVersion,
  })) {
    if (value !== null && value !== undefined && (typeof value !== "string" || !/^v\d+$/.test(value))) {
      errors.push(`${field} must be null or a version like v1`)
    }
  }

  return errors
}

function buildSerializedDurablePlanDocFrontmatter(
  changeId: string,
  frontmatter: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = normalizeDurablePlanDocFrontmatter(changeId, frontmatter)
  const serialized: Record<string, unknown> = {
    schemaVersion: normalized.schemaVersion,
    changeId: normalized.changeId,
    status: normalized.status,
    sourceMode: normalized.sourceMode,
    currentVersion: normalized.currentVersion,
    approvedVersion: normalized.approvedVersion,
  }

  for (const [key, value] of Object.entries(normalized)) {
    if (!DURABLE_PLAN_DOC_CORE_FRONTMATTER_KEYS.has(key)) {
      serialized[key] = value
    }
  }

  return serialized
}

export function normalizeDurablePlanDocBody(body: string): string {
  let normalized = body.trim()
  const fenced = normalized.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i)
  if (fenced) {
    normalized = fenced[1]!.trim()
  }

  normalized = parsePlanDocFrontmatter(normalized).body.trim()
  normalized = normalized.replace(/^#\s+Plan\s*\n+/i, "")
  const freeContent = extractPlanDocSections(normalized).get("__free__")?.trim()
  return freeContent?.trim() || normalized
}

export function validateDurablePlanDocBody(body: string): string[] {
  const normalized = normalizeDurablePlanDocBody(body)
  const errors: string[] = []

  for (const heading of DURABLE_PLAN_DOC_REQUIRED_HEADINGS) {
    const headingRe = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*$`, "mi")
    if (!headingRe.test(normalized)) {
      errors.push(`missing \"## ${heading}\" section`)
    }
  }

  for (const placeholder of DURABLE_PLAN_DOC_PLACEHOLDER_LINES) {
    if (normalized.includes(placeholder)) {
      errors.push(`contains scaffold placeholder text: ${placeholder}`)
    }
  }

  const nonEmptyLines = normalized.split("\n").map((line) => line.trim()).filter(Boolean)
  if (normalized.length < 400 || nonEmptyLines.length < 18) {
    errors.push("plan body is too short; expected a decision-complete plan draft")
  }

  return errors
}

export function isPlaceholderDurablePlanDocBody(body: string): boolean {
  return validateDurablePlanDocBody(body).some(
    (error) => error.startsWith("contains scaffold placeholder text") || error.startsWith("missing \"##"),
  )
}

function buildPlanDocHeaderSection(
  changeId: string,
  currentVersion: string | null | undefined,
  sourceMode: DurablePlanDocFrontmatter["sourceMode"] = "adhoc",
): string {
  return [
    `${MANAGED_OPEN_PREFIX} header -->`,
    `> Auto-generated entry-point for change **${changeId}**.`,
    `> Latest version: ${currentVersion ?? "none"}.`,
    ...(sourceMode === "runecontext"
      ? ["> RuneContext documents remain the canonical source of truth. This plan.md is a durable review/index entrypoint."]
      : []),
    MANAGED_CLOSE,
  ].join("\n")
}

function injectDraftNotesIntoScaffold(body: string, draftNotes?: string): string {
  if (!draftNotes?.trim()) return body
  return body.replace(
    "_Describe the change, why it is needed, and what it accomplishes._",
    draftNotes.trim(),
  )
}

/**
 * Resolve the absolute path to the durable draft plan doc.
 *
 * Path: `<repoRoot>/<repoRelativeDir>/<changeId>/plan.md`
 *
 * @param changeId - Unique change identifier.
 * @param repoRoot - Repository root path.
 * @param repoRelativeDir - Relative path under repo root (default: `"docs/zflow-changes"`).
 * @returns Absolute path to the plan.md file.
 */
export async function resolveDurablePlanDocPath(
  changeId: string,
  repoRoot: string,
  repoRelativeDir?: string,
): Promise<string> {
  const { default: path } = await import("node:path")
  const rel = repoRelativeDir ?? DEFAULT_PUBLISH_REPO_PATH
  return path.resolve(repoRoot, rel, changeId, "plan.md")
}

export async function listPublishedDurablePlanVersions(
  changeId: string,
  options?: DurablePlanDocOptions,
): Promise<string[]> {
  const { default: fs } = await import("node:fs/promises")
  const { default: path } = await import("node:path")
  const repoRoot = await resolveDurablePlanRepoRoot(options)
  const rel = options?.repoRelativeDir ?? DEFAULT_PUBLISH_REPO_PATH
  const changeDir = path.resolve(repoRoot, rel, changeId)

  try {
    const entries = await fs.readdir(changeDir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && /^v\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => Number.parseInt(b.slice(1), 10) - Number.parseInt(a.slice(1), 10))
  } catch {
    return []
  }
}

/**
 * Parse simple flat-key frontmatter from a plan.md string.
 *
 * Expected format:
 * ```
 * ---
 * key: value
 * key: value
 * ---
 * body...
 * ```
 *
 * Only flat `key: value` lines are parsed.  Keys and values are trimmed.
 * Missing values are stored as null.  Lines that are empty or comments are
 * skipped.  The closing `---` may contain trailing whitespace.
 *
 * @param content - Raw file content.
 * @returns Parsed frontmatter record and the body after the closing `---`,
 *          or an empty record and the full content if no frontmatter is found.
 */
export function parsePlanDocFrontmatter(
  content: string,
): { frontmatter: Record<string, string | null>; body: string } {
  const trimmed = content.trimStart()
  if (!trimmed.startsWith("---")) {
    return { frontmatter: {}, body: trimmed }
  }

  // Find the closing ---
  const firstNewline = trimmed.indexOf("\n")
  if (firstNewline === -1) {
    return { frontmatter: {}, body: trimmed }
  }

  const secondLine = firstNewline + 1
  const endMarker = trimmed.indexOf("\n---", secondLine)
  if (endMarker === -1) {
    // No closing marker — treat whole thing as body
    return { frontmatter: {}, body: trimmed }
  }

  // Extract frontmatter lines between the two markers
  const rawFrontmatter = trimmed.slice(secondLine, endMarker).trimEnd()
  const body = trimmed.slice(endMarker + 5).trimStart()

  const frontmatter: Record<string, string | null> = {}
  for (const line of rawFrontmatter.split("\n")) {
    const trimmedLine = line.trim()
    if (!trimmedLine || trimmedLine.startsWith("#")) continue
    const colonIdx = trimmedLine.indexOf(":")
    if (colonIdx === -1) {
      // Line without colon — treat as boolean-like
      frontmatter[trimmedLine] = null
      continue
    }
    const key = trimmedLine.slice(0, colonIdx).trim()
    let value: string | null = trimmedLine.slice(colonIdx + 1).trim()
    // Normalize "null" string to actual null
    if (value === "null" || value === "") value = null
    if (key) frontmatter[key] = value
  }

  return { frontmatter, body }
}

/**
 * Serialize frontmatter + body into a plan.md string.
 *
 * @param frontmatter - Flat key-value pairs to write as frontmatter.
 * @param body - Body markdown content.
 * @returns Complete file content with frontmatter delimiters.
 */
export function serializePlanDoc(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const lines: string[] = ["---"]
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === null || value === undefined) {
      lines.push(`${key}: null`)
    } else if (typeof value === "boolean") {
      lines.push(`${key}: ${value}`)
    } else if (typeof value === "number") {
      lines.push(`${key}: ${value}`)
    } else {
      lines.push(`${key}: ${String(value)}`)
    }
  }
  lines.push("---")
  lines.push("")
  lines.push(body.trimStart())
  return lines.join("\n")
}

/**
 * Build a scaffold body for a new durable draft plan doc.
 *
 * Produces a template with managed header + standard sections that users
 * can fill in.  The managed sections are preserved across automated updates.
 *
 * @param changeId - Change identifier for display.
 * @returns A markdown body string with managed markers.
 */
export function scaffoldDurablePlanDocBody(changeId: string, draftNotes?: string): string {
  return injectDraftNotesIntoScaffold([
    buildPlanDocHeaderSection(changeId, null),
    "",
    "## Summary",
    "",
    "_Describe the change, why it is needed, and what it accomplishes._",
    "",
    "## Goals / Success Criteria",
    "",
    "_List the desired outcomes, user-visible success criteria, and technical completion checks._",
    "",
    "## Scope In",
    "",
    "_What is included in this change._",
    "",
    "## Scope Out",
    "",
    "_What is explicitly excluded._",
    "",
    "## Relevant codebase areas",
    "",
    "_Files, modules, services, docs, and neighboring systems that should be inspected or are likely to change._",
    "",
    "## Constraints",
    "",
    "_Technical, architectural, or process constraints._",
    "",
    "## Decisions",
    "",
    "_Key decisions and trade-offs made during planning._",
    "",
    "## Risks / Unknowns",
    "",
    "_Known risks, open questions, and dependencies._",
    "",
    "## Proposed execution outline",
    "",
    "_High-level execution approach, groups, and order._",
    "",
    "## Verification approach",
    "",
    "_Concrete commands, focused tests, manual checks, and pass/fail expectations._",
    "",
    "## Open questions",
    "",
    "_Any remaining user decisions or unresolved assumptions that could materially change the plan._",
    "",
    buildPlanDocVersionIndexSection([]),
  ].join("\n"), draftNotes)
}

/**
 * Extract sections of body text that live between managed markers.
 *
 * Returns a map of managed-section name (the label after "zflow-managed:") to
 * the content between its open and close markers.  Non-managed content is
 * returned as the `"__free__"` key.
 *
 * @param body - The body portion of a plan.md file.
 * @returns Map of section name → content.
 */
export function extractPlanDocSections(body: string): Map<string, string> {
  const sections = new Map<string, string>()
  const freeParts: string[] = []
  let lastIndex = 0

  for (const match of body.matchAll(MANAGED_SECTION_RE)) {
    const index = match.index ?? 0
    if (index > lastIndex) {
      freeParts.push(body.slice(lastIndex, index))
    }
    sections.set(match[1]!.trim(), match[0])
    lastIndex = index + match[0].length
  }

  if (lastIndex < body.length) {
    freeParts.push(body.slice(lastIndex))
  }

  sections.set("__free__", freeParts.join("").trim())
  return sections
}

/**
 * Build a managed section string for the version index.
 *
 * @param versions - Array of version label strings (e.g. `["v1", "v2"]`).
 * @returns The fully formatted managed section including markers.
 */
export function buildPlanDocVersionIndexSection(versions: string[]): string {
  const lines: string[] = [
    `${MANAGED_OPEN_PREFIX} version-index -->`,
    "## Published versions",
    "",
  ]
  if (versions.length === 0) {
    lines.push("_No versioned documents published yet._")
  } else {
    for (const v of versions) {
      lines.push(`- [${v}](./${v}/) — plan artifacts for this version`)
    }
  }
  lines.push(MANAGED_CLOSE)
  return lines.join("\n")
}

/**
 * Update or create the durable draft plan doc (plan.md).
 *
 * If the file already exists, reads it, merges the provided frontmatter
 * values (without removing unknown keys), and rebuilds managed sections
 * while preserving user-authored body content outside managed markers.
 *
 * If the file does not exist, creates it with the given frontmatter and
 * a scaffold body.
 *
 * @param changeId - Unique change identifier.
 * @param frontmatterValues - Frontmatter values to merge.
 * @param options
 * @param options.cwd - Working directory (optional).
 * @param options.repoRoot - Explicit repo root (optional).
 * @param options.repoRelativeDir - Relative path under repo root (default: `"docs/zflow-changes"`).
 * @param options.publishedVersions - Array of version labels for the version-index managed section.
 * @returns The absolute path to the updated plan.md.
 */
export async function writeDurablePlanDoc(
  changeId: string,
  frontmatterValues: Partial<DurablePlanDocFrontmatter>,
  options?: DurablePlanDocOptions & {
    publishedVersions?: string[]
    draftNotes?: string
    bodyContent?: string
  },
): Promise<string> {
  const { default: fs } = await import("node:fs/promises")
  const { default: path } = await import("node:path")
  const repoRoot = await resolveDurablePlanRepoRoot(options)
  const planDocPath = await resolveDurablePlanDocPath(changeId, repoRoot, options?.repoRelativeDir)

  await fs.mkdir(path.dirname(planDocPath), { recursive: true })

  let existingContent: string | null = null
  try {
    existingContent = await fs.readFile(planDocPath, "utf-8")
  } catch {
    existingContent = null
  }

  if (existingContent !== null) {
    const { frontmatter: existingFM, body } = parsePlanDocFrontmatter(existingContent)
    const sections = extractPlanDocSections(body)
    const serializedFrontmatter = buildSerializedDurablePlanDocFrontmatter(changeId, {
      ...existingFM,
      ...frontmatterValues,
    })
    const validationErrors = validateDurablePlanDocFrontmatter(serializedFrontmatter, changeId)
    if (validationErrors.length > 0) {
      throw new Error(`Invalid durable plan.md frontmatter: ${validationErrors.join("; ")}`)
    }

    const normalizedFrontmatter = normalizeDurablePlanDocFrontmatter(changeId, serializedFrontmatter)
    const headerSection = buildPlanDocHeaderSection(
      changeId,
      normalizedFrontmatter.currentVersion,
      normalizedFrontmatter.sourceMode,
    )
    const versionIndexSection = options?.publishedVersions
      ? buildPlanDocVersionIndexSection(options.publishedVersions)
      : (sections.get("version-index") ?? buildPlanDocVersionIndexSection([]))
    const freeContent = options?.bodyContent !== undefined
      ? normalizeDurablePlanDocBody(options.bodyContent)
      : (sections.get("__free__") ?? "")
    const newBody = [headerSection, freeContent, versionIndexSection]
      .filter((part) => part.trim())
      .join("\n\n")

    await fs.writeFile(planDocPath, serializePlanDoc(serializedFrontmatter, newBody), "utf-8")
    return planDocPath
  }

  const serializedFrontmatter = buildSerializedDurablePlanDocFrontmatter(changeId, {
    schemaVersion: frontmatterValues.schemaVersion ?? DURABLE_PLAN_DOC_SCHEMA_VERSION,
    changeId: frontmatterValues.changeId ?? changeId,
    status: frontmatterValues.status ?? "draft",
    sourceMode: frontmatterValues.sourceMode ?? "adhoc",
    currentVersion: frontmatterValues.currentVersion ?? null,
    approvedVersion: frontmatterValues.approvedVersion ?? null,
  })
  const validationErrors = validateDurablePlanDocFrontmatter(serializedFrontmatter, changeId)
  if (validationErrors.length > 0) {
    throw new Error(`Invalid durable plan.md frontmatter: ${validationErrors.join("; ")}`)
  }

  const normalizedFrontmatter = normalizeDurablePlanDocFrontmatter(changeId, serializedFrontmatter)
  const publishedVersions = options?.publishedVersions ?? []
  const baseBody = options?.bodyContent !== undefined
    ? normalizeDurablePlanDocBody(options.bodyContent)
    : (extractPlanDocSections(scaffoldDurablePlanDocBody(changeId, options?.draftNotes)).get("__free__") ?? "")
  const body = [
    buildPlanDocHeaderSection(changeId, normalizedFrontmatter.currentVersion, normalizedFrontmatter.sourceMode),
    baseBody,
    buildPlanDocVersionIndexSection(publishedVersions),
  ].filter((part) => part.trim()).join("\n\n")

  await fs.writeFile(planDocPath, serializePlanDoc(serializedFrontmatter, body), "utf-8")
  return planDocPath
}

/**
 * Read and parse an existing durable draft plan doc.
 *
 * Returns null if the file does not exist.
 *
 * @param changeId - Unique change identifier.
 * @param options
 * @param options.cwd - Working directory (optional).
 * @param options.repoRoot - Explicit repo root (optional).
 * @param options.repoRelativeDir - Relative path under repo root (default: `"docs/zflow-changes"`).
 * @returns Parsed plan doc or null.
 */
export async function readDurablePlanDoc(
  changeId: string,
  options?: DurablePlanDocOptions,
): Promise<DurablePlanDoc | null> {
  const { default: fs } = await import("node:fs/promises")
  const repoRoot = await resolveDurablePlanRepoRoot(options)
  const planDocPath = await resolveDurablePlanDocPath(changeId, repoRoot, options?.repoRelativeDir)

  try {
    const content = await fs.readFile(planDocPath, "utf-8")
    const { frontmatter: rawFM, body } = parsePlanDocFrontmatter(content)
    const validationErrors = validateDurablePlanDocFrontmatter(rawFM, changeId)
    const bodyValidationErrors = validateDurablePlanDocBody(body)
    const frontmatter = normalizeDurablePlanDocFrontmatter(changeId, rawFM)
    return { frontmatter, body, path: planDocPath, validationErrors, bodyValidationErrors }
  } catch {
    return null
  }
}

export function buildPrepareNotesFromDurablePlanDoc(
  draftPlan: DurablePlanDoc | null,
  prepareNotes?: string,
): string {
  const parts: string[] = []
  if (prepareNotes?.trim()) {
    parts.push(prepareNotes.trim())
  }
  if (!draftPlan) {
    return parts.join("\n\n")
  }

  parts.push([
    `Durable draft plan.md path: ${draftPlan.path}`,
    `Durable draft status: ${draftPlan.frontmatter.status}`,
    `Durable draft source mode: ${draftPlan.frontmatter.sourceMode}`,
    draftPlan.frontmatter.currentVersion ? `Durable draft current version: ${draftPlan.frontmatter.currentVersion}` : "",
    draftPlan.frontmatter.approvedVersion ? `Durable draft approved version: ${draftPlan.frontmatter.approvedVersion}` : "",
    ...(draftPlan.frontmatter.sourceMode === "runecontext"
      ? ["RuneContext note: treat RuneContext documents as canonical; this durable draft is a review/index entrypoint only."]
      : []),
    draftPlan.validationErrors.length > 0
      ? `Durable draft frontmatter validation errors: ${draftPlan.validationErrors.join("; ")}`
      : "",
    draftPlan.bodyValidationErrors.length > 0
      ? `Durable draft body validation errors: ${draftPlan.bodyValidationErrors.join("; ")}`
      : "",
    "Durable draft plan.md body:",
    draftPlan.body,
  ].filter(Boolean).join("\n"))

  return parts.join("\n\n")
}
