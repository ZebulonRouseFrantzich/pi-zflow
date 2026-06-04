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
import { assertValidPlanVersion } from "pi-zflow-artifacts"
import { resolvePlanVersionDir, resolvePlanStatePath } from "pi-zflow-artifacts/artifact-paths"
import { assertSafeChangeId } from "pi-zflow-core/ids"

// ── Extracted orchestration modules ─────────────────────────────

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
  buildWorktreeDispatchPlan,
  signalDriftDetected,
  listRetainedArtifacts,
} from "./orchestration/worktree/dispatch-plan.js"

export {
  prepareWorktreeImplementationRun,
  finalizeWorktreeImplementationRun,
  applyPatchesWithLedger,
} from "./orchestration/worktree/run.js"

export type {
  WorktreeImplementationRunPlan,
} from "./orchestration/worktree/run.js"

export {
  buildCodeReviewInputFromContext,
  finalizeCodeReview,
} from "./orchestration/review/code-review.js"

export type {
  CodeReviewInputContext,
  ReviewerProgressCallback,
} from "./orchestration/review/code-review.js"

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
  completeWorkflow,
  runImplementationPostStartSequence,
  scanForOrphanedScripts,
} from "./orchestration/implementation/post-start.js"

export type {
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
  runDirectFixWorkflow,
  isNoEditFailure,
  parseZflowFixResultEnvelope,
  buildDirectFixBatches,
  buildFixOrchestratorTaskPrompt,
  resolveFixOrchestratorConfig,
} from "./orchestration/fix/workflow.js"

export type {
  AuditWorkflowOptions,
  AuditWorkflowResult,
  DirectFixBatch,
  DirectFixFindingOutcome,
  DirectFixWorkflowOptions,
  DirectFixWorkflowResult,
  ZflowFixFindingResult,
  ZflowFixResultEnvelope,
  FixOrchestratorConfig,
  FixWorkflowOptions,
  FixWorkflowResult,
} from "./orchestration/fix/workflow.js"

export {
  assertFindingsMatchChange,
  normalizeFindingsSource,
  parseReviewFindings,
  buildFixSelectionQuestions,
  buildFixPlan,
} from "./orchestration/fix/findings.js"

export type {
  ParsedFinding,
  ReviewFindingsMetadata,
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
