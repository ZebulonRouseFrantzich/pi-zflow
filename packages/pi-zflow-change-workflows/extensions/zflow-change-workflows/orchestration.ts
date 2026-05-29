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
import { readRun, updateRun, setRunPhase, addRetainedArtifact, createRun, createRecoveryRef, removeRecoveryRef, assertValidPlanVersion } from "pi-zflow-artifacts"
import type { RunPhase, RetainedArtifact, RunJson } from "pi-zflow-artifacts"
import { resolveRunDir, resolveRunStatePath, resolvePlanVersionDir, resolvePlanStatePath, resolvePlanArtifactPath } from "pi-zflow-artifacts/artifact-paths"
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
import { type TaskWorktreeStrategy } from "pi-zflow-core/dispatch-service"
import {
  resolveVerificationCommand,
  runVerification,
  appendFailureLog,
  runVerificationFixLoop,
} from "./verification.js"
import type { VerificationResult, FixLoopResult, FixLoopOptions } from "./verification.js"

// ── Extracted orchestration modules ─────────────────────────────

import {
  parseExecutionGroupsMd,
  coalesceConnectedGroups,
} from "./orchestration/execution-groups.js"
import type { DispatchExecutionGroup } from "./orchestration/execution-groups.js"

import { buildWorkerTask } from "./orchestration/worktree-task.js"
import type {
  WorktreeGroupTask,
  WorktreeDispatchConfig,
} from "./orchestration/worktree-task.js"

import { abandonWorkflow } from "./orchestration/resume.js"
import { discoverUnfinishedWork } from "./orchestration/lifecycle/unfinished-work.js"

export {
  parseExecutionGroupsMd,
  coalesceConnectedGroups,
} from "./orchestration/execution-groups.js"

export type {
  DispatchExecutionGroup,
} from "./orchestration/execution-groups.js"

export {
  buildSubagentLaunchPlan,
  buildAllSubagentLaunchPlans,
  injectAgentGuidanceFragments,
  buildWorkflowExecutionPlan,
} from "./orchestration/launch-plan.js"

export type {
  SubagentLaunchPlan,
  WorkflowExecutionPlan,
  WorkflowStep,
  ReviewSwarmConfig,
} from "./orchestration/launch-plan.js"

export {
  createSwarmManifest,
  getReviewersForTier,
  getPlanReviewersForTier,
} from "./orchestration/review-manifest.js"

export {
  buildWorkerTask,
} from "./orchestration/worktree-task.js"

export type {
  WorktreeGroupTask,
  WorktreeDispatchConfig,
} from "./orchestration/worktree-task.js"

export {
  detectResumeContext,
  resumeWorkflow,
  abandonWorkflow,
  buildResumePrompt,
} from "./orchestration/resume.js"

export type {
  ResumeContext,
} from "./orchestration/resume.js"

export {
  deriveSemanticChangeId,
} from "./orchestration/change-id.js"

export {
  discoverUnfinishedWork,
  promptResumeChoices,
  checkUnfinishedOnEntry,
} from "./orchestration/lifecycle/unfinished-work.js"

export type {
  UnfinishedOnEntryResult,
} from "./orchestration/lifecycle/unfinished-work.js"

export {
  runPrepareAgentsIfAvailable,
} from "./orchestration/prepare/agent-dispatch.js"

export type {
  PrepareAgentDispatchResult,
} from "./orchestration/prepare/agent-dispatch.js"

export {
  ensureImplementationTasksArtifact,
} from "./orchestration/prepare/implementation-tasks.js"

export {
  resolveProfileIfAvailable,
  runChangePrepareWorkflow,
} from "./orchestration/prepare/workflow.js"

export type {
  PrepareWorkflowOptions,
  PrepareWorkflowResult,
} from "./orchestration/prepare/workflow.js"

import {
  buildImplementationGateQuestions,
  updatePlanState,
} from "./orchestration/planning/plan-lifecycle.js"
import {
  writeDurablePlanDoc,
  DEFAULT_PUBLISH_REPO_PATH,
} from "./orchestration/planning/durable-plan-doc.js"

export {
  buildRepoMap,
  buildReconnaissance,
} from "./orchestration/planning/repo-analysis.js"

export {
  runChangePlanWorkflow,
} from "./orchestration/planning/change-plan.js"

export type {
  ChangePlanWorkflowOptions,
  ChangePlanWorkflowResult,
} from "./orchestration/planning/change-plan.js"

export {
  updatePlanState,
  advancePlanLifecycle,
  runPlanValidation,
  runPlanReview,
  approvePlanVersion,
  buildHandoffContext,
  buildPlanApprovalQuestions,
  buildImplementationGateQuestions,
  parseInterviewResponse,
} from "./orchestration/planning/plan-lifecycle.js"

export {
  resolveDurablePlanDocPath,
  listPublishedDurablePlanVersions,
  parsePlanDocFrontmatter,
  serializePlanDoc,
  scaffoldDurablePlanDocBody,
  extractPlanDocSections,
  buildPlanDocVersionIndexSection,
  writeDurablePlanDoc,
  readDurablePlanDoc,
  validateDurablePlanDocFrontmatter,
  validateDurablePlanDocBody,
  normalizeDurablePlanDocBody,
  isPlaceholderDurablePlanDocBody,
  buildPrepareNotesFromDurablePlanDoc,
} from "./orchestration/planning/durable-plan-doc.js"

export type {
  DurablePlanDocFrontmatter,
  DurablePlanDoc,
} from "./orchestration/planning/durable-plan-doc.js"

export {
  buildImplementationHandoff,
  serializeHandoff,
  deserializeHandoff,
  buildHandoffPromptPrefix,
  canForkSession,
  forkImplementationSessionIfAvailable,
  resolvePendingHandoff,
  clearPendingHandoff,
} from "./orchestration/implementation/handoff.js"

export type {
  ImplementationHandoff,
  ForkSessionResult,
} from "./orchestration/implementation/handoff.js"

export {
  resolveChangeImplementTarget,
  runChangeImplementWorkflow,
  recordImplementationNextSteps,
} from "./orchestration/implementation/workflow.js"

export type {
  ChangeImplementTarget,
  ImplementWorkflowOptions,
  ImplementWorkflowResult,
} from "./orchestration/implementation/workflow.js"

export {
  buildSubagentResolutionPrompt,
  requestSubagentResolution,
} from "./orchestration/implementation/subagent-resolution.js"

export type {
  SubagentResolutionOptions,
  SubagentResolutionResult,
} from "./orchestration/implementation/subagent-resolution.js"

export {
  formatApplyBackFailureMessage,
  finalizeVerification,
  runBoundedFixLoop,
  finalizeCodeReview,
  completeWorkflow,
  runImplementationPostStartSequence,
  scanForOrphanedScripts,
} from "./orchestration/implementation/post-start.js"

export type {
  ReviewerProgressCallback,
  PostStartSequenceOptions,
  PostStartSequenceResult,
} from "./orchestration/implementation/post-start.js"

export {
  resolveScratchScriptsDir,
  ensureScratchScriptsDir,
  buildEphemeralScriptRule,
} from "./orchestration/scratch-scripts.js"

export {
  runChangeAuditWorkflow,
  runChangeFixWorkflow,
  buildFixOrchestratorTaskPrompt,
  resolveFixOrchestratorConfig,
} from "./orchestration/fix/workflow.js"

export type {
  AuditWorkflowOptions,
  AuditWorkflowResult,
  FixOrchestratorConfig,
  FixWorkflowOptions,
  FixWorkflowResult,
} from "./orchestration/fix/workflow.js"

export {
  parseReviewFindings,
  buildFixSelectionQuestions,
  buildFixPlan,
} from "./orchestration/fix/findings.js"

export type {
  ParsedFinding,
} from "./orchestration/fix/findings.js"

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

// ═══════════════════════════════════════════════════════════════════
// Phase 7 — Formal workflow orchestration
// ═══════════════════════════════════════════════════════════════════

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