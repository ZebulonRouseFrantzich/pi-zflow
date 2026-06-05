/**
 * pi-zflow-change-workflows extension entrypoint
 *
 * Phase 7 implementation:
 * - Path resolution helpers integrated from pi-zflow-artifacts
 * - `resolveAllPaths` convenience helper for workflow commands
 * - Registers `/zflow-change-plan`, `/zflow-change-prepare`,
 *   `/zflow-change-implement`, `/zflow-change-audit`, `/zflow-change-fix`, and `/zflow-clean`
 * - Wires state-driven resume, HITL gates, handoff, prompt reminders,
 *   verification/review sequencing, cleanup, and path-guard enforcement
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

import {
  resolveRuntimeStateDir,
  resolveGitDir,
} from "pi-zflow-core/runtime-paths"

import { getZflowRegistry } from "pi-zflow-core/registry"
import { PI_ZFLOW_CHANGE_WORKFLOWS_VERSION, inferTaskRepoRoot } from "pi-zflow-core"
import type { CapabilityClaim } from "pi-zflow-core/registry"

import {
  resolveStateIndexPath,
  resolvePlanStatePath,
  resolvePlanVersionDir,
  resolvePlanArtifactPath,
  resolveChangeDir,
  resolveRunStatePath,
  resolveRunDir,
  resolveReviewDir,
  resolveCodeReviewFindingsPath,
  resolveFailureLogPath,
  resolveRepoMapPath,
  resolveReconnaissancePath,
} from "pi-zflow-artifacts/artifact-paths"

// ── Extracted activation / command helpers ─────────────────────

import { ensureWorkflowIntercomTarget } from "./activation/path-helpers.js"

export {
  resolveAllPaths,
  resolvePlanPaths,
  resolveRunPaths,
  buildWorkflowIntercomSessionName,
  ensureWorkflowIntercomTarget,
} from "./activation/path-helpers.js"

export type {
  AllWorkflowPaths,
} from "./activation/path-helpers.js"

import {
  setActiveWorkflowMode,
  getActiveWorkflowMode,
  isWorkflowToolGuardActive,
  addReminder,
  removeReminder,
  getActiveReminders,
  clearReminders,
  resetWorkflowState,
} from "./activation/workflow-state.js"

export {
  setActiveWorkflowMode,
  getActiveWorkflowMode,
  isWorkflowToolGuardActive,
  addReminder,
  removeReminder,
  getActiveReminders,
  clearReminders,
  resetWorkflowState,
} from "./activation/workflow-state.js"

import type { InterviewableContext } from "./interview/structured-interview.js"
import { runStructuredInterview } from "./interview/structured-interview.js"

export type { InterviewableContext } from "./interview/structured-interview.js"

import {
  promptForChangePlanInput,
  deriveChangePlanId,
  parseChangePlanArgs,
  parseChangePrepareArgs,
  extractChangePlanReference,
} from "./commands/args.js"

function isRuneContextReference(referencePath: string | null | undefined): boolean {
  if (!referencePath) return false
  const normalized = referencePath
    .trim()
    .replace(/^@+/, "")
    .replace(/\\/g, "/")
    .toLowerCase()
  if (!normalized) return false
  return normalized.split("/").some((segment) =>
    segment === "runecontext" ||
    segment === ".runecontext" ||
    segment === "runectx" ||
    segment === "rune-context"
  )
}

export {
  isAdHocPlanModeActive,
  shouldForkImplementationSessionAfterPrepare,
  deriveChangePlanId,
  parseChangePlanArgs,
  parseChangePrepareArgs,
  extractChangePlanReference,
} from "./commands/args.js"

export type {
  ParsedChangePlanArgs,
  ParsedChangePrepareArgs,
} from "./commands/args.js"

import {
  formatElapsed,
  detectWorkflowAttentionSignal,
  detectIncomingWorkflowAttention,
  registerWorkflowProgressRenderer,
  createWorkflowProgressIndicator,
  buildWorkflowFinalNextStepsLine,
} from "./activation/progress-renderer.js"
import {
  acceptAlreadyImplementedEvidenceResult,
  acceptImplementationNoopResult,
} from "./orchestration/implementation/noop-success.js"
import type {
  WorkflowSubagentSnapshot,
  SessionMessageLike,
  SessionEntryLike,
  WorkflowAttentionSignalInput,
} from "./activation/progress-renderer.js"

export {
  detectWorkflowAttentionSignal,
  detectIncomingWorkflowAttention,
} from "./activation/progress-renderer.js"

export type {
  SessionMessageLike,
  SessionEntryLike,
  WorkflowAttentionSignalInput,
} from "./activation/progress-renderer.js"

// ── State-index lifecycle helpers ─────────────────────────────────

import { loadStateIndex, listStateIndexEntries } from "pi-zflow-artifacts/state-index"
import type { StateIndexEntry } from "pi-zflow-artifacts/state-index"

import {
  discoverUnfinishedWork,
  promptResumeChoices,
  checkUnfinishedOnEntry,
  runChangePlanWorkflow,
  runChangePrepareWorkflow,
  resolveProfileIfAvailable,
  buildRepoMap,
  buildReconnaissance,
  advancePlanLifecycle,
  runPlanValidation,
  runPlanReview,
  approvePlanVersion,
  buildHandoffContext,
  updatePlanState,
  bumpPlanVersion,
  markPlanVersionState,
  buildPlanApprovalQuestions,
  buildImplementationGateQuestions,
  parseInterviewResponse,
  runChangeAuditWorkflow,
  runChangeFixWorkflow,
  parseReviewFindings,
  assertFindingsMatchChange,
  buildFixSelectionQuestions,
  buildFixPlan,
  runCleanWorkflow,
  detectResumeContext,
  resumeWorkflow,
  abandonWorkflow,
  buildResumePrompt,
  runChangeImplementWorkflow,
  recordImplementationNextSteps,
  finalizeVerification,
  runBoundedFixLoop,
  finalizeCodeReview,
  completeWorkflow,
  runImplementationPostStartSequence,
  buildImplementationHandoff,
  serializeHandoff,
  deserializeHandoff,
  buildHandoffPromptPrefix,
  canForkSession,
  forkImplementationSessionIfAvailable,
  resolvePendingHandoff,
  clearPendingHandoff,
  handlePlanDrift,
  createPlanAmendment,
  buildDriftDetectedReminder,
  buildCodeReviewInputFromContext,
  publishPlanArtifacts,
  deriveSemanticChangeId,
  writeDurablePlanDoc,
  listPublishedDurablePlanVersions,
  resolveChangeImplementTarget,
  applyPatchesWithLedger,
  buildSubagentResolutionPrompt,
  formatApplyBackFailureMessage,
  type PublishPlanArtifactsResult,
} from "./orchestration.js"

import {
  validateAllPlanArtifacts,
  validateSingleArtifact,
  runArtifactRepair,
} from "./plan-artifact-validator.js"

import type {
  ArtifactValidationResult,
  AllArtifactsValidationResult,
  ArtifactRepairResult,
} from "./plan-artifact-validator.js"

import {
  reconcileResumeState,
  findBestResumeRun,
} from "./resume-reconciler.js"
import type {
  ResumeReconciliation,
  GroupResumeStatus,
} from "./resume-reconciler.js"

import {
  loadFragment,
  buildReminderInjection,
  buildModeInjection,
  fragmentExists,
} from "./prompt-fragments.js"

import type {
  ReminderId,
  ModeFragment,
} from "./prompt-fragments.js"

import type {
  PrepareWorkflowOptions,
  PrepareWorkflowResult,
  ImplementationHandoff,
  ForkSessionResult,
  ImplementWorkflowOptions,
  ImplementWorkflowResult,
  UnfinishedOnEntryResult,
  CodeReviewInputContext,
  AuditWorkflowOptions,
  AuditWorkflowResult,
  FixWorkflowOptions,
  FixWorkflowResult,
  ParsedFinding,
  FixOrchestratorConfig,
  CleanWorkflowOptions,
  CleanWorkflowResult,
  ResumeContext,
  DriftResolution,
} from "./orchestration.js"

import {
  resolveVerificationCommand,
  runVerification,
  appendFailureLog,
  runVerificationFixLoop,
} from "./verification.js"

import {
  readFailureLog,
  findRelevantFailures,
  appendFailureEntry,
  formatFailureLogEntries,
  parseFailureLog,
} from "./failure-log.js"

import type { FailureLogEntry } from "./failure-log.js"

// ── Path guard helpers ────────────────────────────────────────────

import {
  guardWrite,
  guardBashCommand,
  isGitWriteCommand,
  buildToolDeniedReminder,
} from "./path-guard.js"

import type {
  GuardResult,
  GuardIntent,
  GuardOptions,
  PostStartSequenceOptions,
  PostStartSequenceResult,
} from "./path-guard.js"

import type {
  VerificationResult,
  FixLoopOptions,
  FixLoopResult,
  FixAttempt,
} from "./verification.js"

import type { AgentDispatchProgress, DispatchService, DispatchWorktreeSetupHook } from "pi-zflow-core/dispatch-service"
import { DISPATCH_SERVICE_CAPABILITY } from "pi-zflow-core/dispatch-service"
import {
  buildFixWorkerWorktreeStrategy,
  extractFixVerificationCommand,
  mergeSuccessfulFixResult,
  selectCanonicalGroupPatchPath,
} from "./fix-dispatch.js"

export {
  discoverUnfinishedWork,
  promptResumeChoices,
  checkUnfinishedOnEntry,
  runChangePrepareWorkflow,
  resolveProfileIfAvailable,
  buildRepoMap,
  buildReconnaissance,
  advancePlanLifecycle,
  runPlanValidation,
  runPlanReview,
  approvePlanVersion,
  buildHandoffContext,
  updatePlanState,
  bumpPlanVersion,
  markPlanVersionState,
  runChangeImplementWorkflow,
  recordImplementationNextSteps,
  finalizeVerification,
  runBoundedFixLoop,
  finalizeCodeReview,
  completeWorkflow,
  runImplementationPostStartSequence,
  loadFragment,
  buildReminderInjection,
  buildModeInjection,
  fragmentExists,
  buildImplementationHandoff,
  serializeHandoff,
  deserializeHandoff,
  buildHandoffPromptPrefix,
  canForkSession,
  resolveVerificationCommand,
  runVerification,
  appendFailureLog,
  runVerificationFixLoop,
  detectResumeContext,
  resumeWorkflow,
  abandonWorkflow,
  buildResumePrompt,
  handlePlanDrift,
  createPlanAmendment,
  buildDriftDetectedReminder,
  buildCodeReviewInputFromContext,
  runChangeAuditWorkflow,
  runChangeFixWorkflow,
  runCleanWorkflow,
  readFailureLog,
  findRelevantFailures,
  appendFailureEntry,
  formatFailureLogEntries,
  parseFailureLog,
  buildPlanApprovalQuestions,
  buildImplementationGateQuestions,
  parseInterviewResponse,
  runStructuredInterview,
  publishPlanArtifacts,
  deriveSemanticChangeId,
  resolveChangeImplementTarget,
  // Plan artifact validator
  validateAllPlanArtifacts,
  validateSingleArtifact,
  runArtifactRepair,
}

export type {
  PublishPlanArtifactsResult,
  StateIndexEntry,
  ReminderId,
  ModeFragment,
  PrepareWorkflowOptions,
  PrepareWorkflowResult,
  ImplementationHandoff,
  ForkSessionResult,
  ImplementWorkflowOptions,
  ImplementWorkflowResult,
  VerificationResult,
  FixLoopOptions,
  FixLoopResult,
  FixAttempt,
  DriftResolution,
  CodeReviewInputContext,
  AuditWorkflowOptions,
  AuditWorkflowResult,
  FixWorkflowOptions,
  FixWorkflowResult,
  CleanWorkflowOptions,
  CleanWorkflowResult,
  FailureLogEntry,
  ResumeContext,
  GuardResult,
  GuardIntent,
  GuardOptions,
  ArtifactValidationResult,
  AllArtifactsValidationResult,
  ArtifactRepairResult,
}

/**
 * Format plan inspection paths for the prepare approval gate.
 */
function formatPlanInspectionPaths(input: {
  changeId: string
  planVersion: string
  planStatePath: string
  artifactPaths: Record<string, string>
  reviewFindingsPath?: string
  durableDir?: string
  publishedArtifacts?: Record<string, string>
  publishErrors?: string[]
}): string {
  const durable = input.durableDir && input.publishedArtifacts
    ? Object.entries(input.publishedArtifacts).length > 0
    : false

  const sections: string[] = []

  if (durable && input.publishedArtifacts) {
    sections.push(
      `📂 Repo-visible change documents for "${input.changeId}" ${input.planVersion}:`,
      `  - directory: ${input.durableDir}`,
    )
    for (const [key, filePath] of Object.entries(input.publishedArtifacts)) {
      sections.push(`  - ${key}: ${filePath}`)
    }
    sections.push("")
  }

  sections.push(`📌 Runtime plan artifacts for "${input.changeId}" ${input.planVersion}:`)
  if (input.planStatePath) sections.push(`  - plan state: ${input.planStatePath}`)
  for (const key of ["design", "executionGroups", "standards", "verification", "implementationTasks"] as const) {
    if (input.artifactPaths[key]) sections.push(`  - ${key}: ${input.artifactPaths[key]}`)
  }
  if (input.reviewFindingsPath) sections.push(`  - review findings: ${input.reviewFindingsPath}`)

  if (input.publishErrors && input.publishErrors.length > 0) {
    sections.push("")
    sections.push("⚠️  Publishing warnings:")
    for (const err of input.publishErrors) {
      sections.push(`  - ${err}`)
    }
  }

  sections.push(
    "",
    `Review the changes in the repo-visible directory before approving.`,
    `If you need time, choose "Inspect Artifacts" or "Cancel"; the plan remains on disk and can be revisited later.`,
  )

  return sections.join("\n")
}

// ═══════════════════════════════════════════════════════════════════
// Dispatch service helpers
// ═══════════════════════════════════════════════════════════════════

const IMPLEMENT_GROUP_MAX_RETRIES = 1
const IMPLEMENT_RATE_LIMIT_MAX_RETRIES = 3
const IMPLEMENT_RATE_LIMIT_DEFAULT_WAIT_MS = 60 * 1000
const DEFAULT_IMPLEMENT_CONCURRENCY = 2

// ── Fix loop bounds ──────────────────────────────────────────────
/** Maximum fix attempts per group. */
const MAX_FIX_ATTEMPTS_PER_GROUP = 2
/** Maximum total time spent fixing a single group (15 minutes). */
const MAX_TOTAL_FIX_TIME_MS = 15 * 60 * 1000

function resolveImplementConcurrency(): number {
  const raw = process.env.ZFLOW_IMPLEMENT_CONCURRENCY
  if (!raw) return DEFAULT_IMPLEMENT_CONCURRENCY
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_IMPLEMENT_CONCURRENCY
  return parsed
}

type DispatchGroupResult = Awaited<ReturnType<DispatchService["runParallel"]>>["results"][number]

// ── Group status ledger types and helpers ─────────────────────────

/**
 * Status for a single group in a partial/resumable run.
 */
export type GroupLedgerStatus =
  | "queued"
  | "ready"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "retrying"
  | "pending"
  | "applied"
  | "skipped"

/**
 * Semantic coupling metadata for a group.
 *
 * Describes how this group relates to other groups so users/automation
 * can assess whether applying successful groups independently is safe.
 */
export interface SemanticCoupling {
  /** Groups that must complete before this one. */
  dependsOnGroups: string[]
  /** Groups that this group blocks. */
  blocksGroups: string[]
  /** Files shared with other groups (potential conflict points). */
  sharedFiles: string[]
  /** Explanatory notes, e.g. "Coupling inferred from plan dependencies and file overlap. Not proof of independence." */
  notes: string[]
}

/**
 * Per-group entry in the durable group status ledger.
 *
 * Embedded in run.json metadata (`groupLedger` key). Updated
 * throughout the implementation workflow lifecycle.
 */
export interface GroupStatusEntry {
  /** Group identifier (e.g. "group-1"). */
  groupId: string
  /** Current status. */
  status: GroupLedgerStatus
  /** Agent assigned to this group. */
  agent: string
  /** Task prompt text for the group. */
  taskPrompt: string
  /** Files this group claims. */
  files: string[]
  /** Group dependencies from plan. */
  dependencies: string[]
  /** Semantic coupling inferred from plan metadata. */
  semanticCoupling: SemanticCoupling
  /** Result of scoped verification (if known). */
  scopedVerification?: {
    status: "pass" | "fail" | "skipped" | "missing"
    command?: string
    output?: string
    outputPath?: string
    classification?: "environment" | "command-misconfigured" | "implementation"
    attempts?: Array<{
      cwd?: string
      command: string
      status: "pass" | "fail"
      output?: string
      classification?: "environment" | "command-misconfigured" | "implementation"
    }>
  }
  /** Path to the patch artifact (if produced and captured). */
  patchPath?: string
  /** Path to preserved worker evidence accepted in lieu of a patch. */
  implementationEvidencePath?: string
  /** How this group was accepted/completed. */
  completionMode?: "patch" | "noop-evidence" | "worker-evidence"
  /** Absolute path to the worktree (if one was created). */
  worktreePath?: string
  /** Files changed by this group (if captured). */
  changedFiles?: string[]
  /** Number of retry attempts so far. */
  retryCount: number
  /** Last dispatch command/tool observed for this group. */
  lastCommand?: string
  /** Current tool name, when known. */
  currentTool?: string
  /** Resolved model used for this group, when known. */
  model?: string
  /** Resolved thinking level used for this group, when known. */
  thinking?: string
  /** ISO timestamp when this group first entered running state. */
  startedAt?: string
  /** ISO timestamp when live progress was last observed. */
  lastProgressAt?: string
  /** Number of rate-limit retries consumed so far. */
  rateLimitRetryCount?: number
  /** Error message if status is "failed". */
  error?: string
  /** Group IDs that caused this group to be blocked (when status is "blocked"). */
  blockedBy?: string[]
  /** Categorization of failure for retry policy. */
  failureKind?: "retryable" | "blocker"
  /** Fix-loop state: number of fix attempts made so far. */
  fixAttempts?: number
  /** Fix-loop state: classification from the last fix attempt. */
  fixClassification?: string
  /** Fix-loop state: result of the last fix attempt ("succeeded" | "failed" | "needs-user-decision"). */
  fixResult?: string
  /** Fix-loop state: path to the fix patch (if separate from the original). */
  fixPatchPath?: string
  /** Whether this group's patch has been applied back to the primary. */
  appliedToPrimary: boolean
  /** ISO timestamp of last state change. */
  updatedAt: string
}

/**
 * Durable group status ledger key in run.json metadata.
 */
const GROUP_LEDGER_META_KEY = "groupLedger" as const

/**
 * Infer semantic coupling for a group from execution group data.
 *
 * Computes dependencies (explicit), reverse dependencies (groups that depend on this one),
 * and shared files (files owned by this group that also appear in other groups).
 */
function inferSemanticCoupling(
  groupId: string,
  allGroups: ReadonlyArray<{ id: string; files: string[]; dependencies: string[] }>,
): SemanticCoupling {
  const group = allGroups.find((g) => g.id === groupId)
  const dependsOnGroups = group?.dependencies ?? []

  // Groups that list this group as a dependency
  const blocksGroups = allGroups
    .filter((g) => g.dependencies.includes(groupId))
    .map((g) => g.id)

  // Shared files: files this group owns that also appear in other groups
  const groupFiles = new Set(group?.files ?? [])
  const sharedFiles = new Set<string>()
  for (const other of allGroups) {
    if (other.id === groupId) continue
    for (const file of other.files) {
      if (groupFiles.has(file)) sharedFiles.add(file)
    }
  }

  const notes: string[] = []
  if (dependsOnGroups.length > 0 || blocksGroups.length > 0) {
    notes.push("Dependency relationships are defined in the execution plan.")
  }
  if (sharedFiles.size > 0) {
    notes.push(`Shared files with other groups: ${[...sharedFiles].join(", ")}.`)
  }
  notes.push("Coupling inferred from plan dependencies and file overlap. Not proof of independence.")

  return {
    dependsOnGroups,
    blocksGroups,
    sharedFiles: [...sharedFiles],
    notes,
  }
}

/**
 * Build a durable group status ledger from execution group metadata.
 *
 * Creates the initial state and infers semantic coupling for every group.
 * If an existing run.json exists (for resume), preserves previous
 * non-failed group states.
 */
function buildGroupLedger(
  groups: ReadonlyArray<{
    id: string
    files: string[]
    dependencies: string[]
    agent?: string
    taskPrompt?: string
    scopedVerification?: string
  }>,
  existingLedger?: Record<string, GroupStatusEntry>,
): Record<string, GroupStatusEntry> {
  const ledger: Record<string, GroupStatusEntry> = {}

  for (const group of groups) {
    const existing = existingLedger?.[group.id]
    const newStatus: GroupLedgerStatus = existing
      ? existing.status === "succeeded" || existing.status === "applied" || existing.status === "skipped"
        ? existing.status
        : "queued"
      : "queued"

    ledger[group.id] = {
      groupId: group.id,
      status: newStatus,
      agent: group.agent ?? "zflow.implement-routine",
      taskPrompt: group.taskPrompt ?? "",
      files: [...group.files],
      dependencies: [...group.dependencies],
      semanticCoupling: inferSemanticCoupling(group.id, groups),
      scopedVerification: existing?.scopedVerification,
      patchPath: existing?.patchPath,
      implementationEvidencePath: existing?.implementationEvidencePath,
      completionMode: existing?.completionMode,
      worktreePath: existing?.worktreePath,
      changedFiles: existing?.changedFiles,
      retryCount: existing?.retryCount ?? 0,
      error: existing?.error,
      failureKind: existing?.failureKind,
      appliedToPrimary: existing?.appliedToPrimary ?? false,
      updatedAt: new Date().toISOString(),
    }
  }

  return ledger
}

/**
 * Update the group ledger embedded in run.json metadata for a run.
 *
 * Reads the current run, merges the updates into the ledger,
 * and writes back with refreshed updatedAt.
 */
async function updateGroupLedger(
  runId: string,
  groupId: string,
  updates: Partial<Omit<GroupStatusEntry, "groupId">>,
  cwd?: string,
): Promise<void> {
  const { readRun, updateRun } = await import("pi-zflow-artifacts")
  const run = await readRun(runId, cwd)
  const existingLedger = (run.metadata?.[GROUP_LEDGER_META_KEY] ?? {}) as Record<string, GroupStatusEntry>
  const existing = existingLedger[groupId] ?? {} as GroupStatusEntry
  existingLedger[groupId] = {
    ...existing,
    ...updates,
    groupId,
    updatedAt: new Date().toISOString(),
  } as GroupStatusEntry
  await updateRun(runId, {
    metadata: {
      ...(run.metadata ?? {}),
      [GROUP_LEDGER_META_KEY]: existingLedger,
    },
  } as any, cwd)
}

/**
 * Attempt to fix a failed group by dispatching a targeted fix worker.
 *
 * The fix worker runs in a fresh isolated worktree rooted at the same base
 * commit as the original group. When it succeeds, its patch becomes the
 * canonical patch for downstream lineage/apply-back while the original failed
 * patch remains available only for diagnostics.
 *
 * @param groupId - The failing group's ID.
 * @param taskPrompt - The group's task description.
 * @param files - Allowed file paths for this group.
 * @param agent - The agent to use for the fix worker.
 * @param failedResult - The failed dispatch result (contains error, verification output, patch path).
 * @param dispatchService - The dispatch service.
 * @param options - Context: runId, cwd, repoRoot, changeId, planVersion, worktreeResultsDir, onSubagentUpdate.
 * @returns Object with fix outcome: whether fixed, canonical fix patch path, classification, error.
 */
async function attemptGroupFix(
  groupId: string,
  taskPrompt: string,
  files: string[],
  agent: string,
  failedResult: DispatchGroupResult,
  dispatchService: DispatchService,
  options: {
    runId: string
    cwd?: string
    repoRoot: string
    changeId: string
    planVersion: string
    worktreeResultsDir: string
    worktreeSetupHook?: DispatchWorktreeSetupHook
    onSubagentUpdate?: (id: string, update: Partial<Omit<WorkflowSubagentSnapshot, "id" | "startedAt">>) => void
    onWorkflowUpdate?: (message: string) => void
    implementModel: { dispatchModel?: string }
  },
): Promise<{
  fixed: boolean
  fixPatchPath?: string
  fixClassification: string
  error?: string
  verificationCommand?: string
  verificationOutput?: string
  verificationOutputPath?: string
  dispatchResult?: DispatchGroupResult
}> {
  const { default: fs } = await import("node:fs/promises")
  const { default: path } = await import("node:path")

  const fixOutputPath = path.join(options.worktreeResultsDir, `${groupId}-fix-result.md`)
  const fixVerificationPath = path.join(options.worktreeResultsDir, `${groupId}-fix-verification.txt`)

  // Read the original patch content to include in the fix prompt
  let originalPatchContent = ""
  if (failedResult.patchPath) {
    try {
      originalPatchContent = await fs.readFile(failedResult.patchPath, "utf-8")
    } catch {
      // Patch may not exist if the group had no changes
    }
  }

  const verificationCmd = extractFixVerificationCommand(failedResult)
  const verificationOutput = failedResult.verification?.output ?? failedResult.error ?? "(not captured)"
  const errorHint = failedResult.error ?? ""

  // Build fix prompt
  const fixPrompt = [
    `# Fix: ${groupId} — ${taskPrompt}`,
    "",
    "## Original group failure",
    verificationCmd
      ? "The dispatch service reported that the worker did not pass scoped verification."
      : "The dispatch service reported that the worker failed before a scoped verification command could be confirmed.",
    "",
    "## Context",
    "",
    `**Group:** ${groupId}`,
    `**Agent:** ${agent}`,
    `**Allowed files:** ${files.join(", ")}`,
    "",
    ...(verificationCmd ? [
      "## Verification command that failed",
      "```bash",
      verificationCmd,
      "```",
      "",
    ] : [
      "## Verification command",
      "No scoped verification command was captured for the original failure.",
      "",
    ]),
    "## Failure output",
    "```",
    verificationOutput.slice(0, 10000),
    "```",
    "",
    ...(errorHint ? [
      "## Error hint",
      errorHint,
      "",
    ] : []),
    ...(originalPatchContent ? [
      "## Original patch (the previous implementation attempt)",
      "",
      "The following patch was produced by the original implementation but did not complete successfully.",
      "```diff",
      originalPatchContent.slice(0, 15000),
      "```",
      "",
    ] : []),
    "## Your task",
    "",
    verificationCmd
      ? "Fix the implementation so this group's changes pass the scoped verification command."
      : "Fix the implementation failure within the allowed files. If you can infer the relevant scoped verification command from project context, run it yourself before finishing.",
    "",
    "## Rules",
    "",
    "1. Stay within the allowed files unless drift criteria require escalation.",
    "2. If the original patch contains changes that are valid, reapply them in your implementation.",
    "3. Focus on the concrete failure mode — patch syntax errors, missing config, incompatible CLI flags, invalid file formats, etc.",
    ...(verificationCmd ? [
      "4. After making your changes, run the verification command yourself:",
      "   ```bash",
      verificationCmd,
      "   ```",
      "5. If verification passes, you're done. Report what you fixed.",
      "6. If verification still fails, fix the remaining issues and retry verification.",
      "7. If you cannot fix within the allowed files, report why and suggest scope expansion.",
    ] : [
      "4. Run the most relevant scoped verification you can determine from the group's context before finishing.",
      "5. If you cannot determine a reliable verification command, state that clearly in the summary.",
      "6. If you cannot fix within the allowed files, report why and suggest scope expansion.",
    ]),
    "",
    "## Report format",
    "",
    "End your response with a summary:",
    "- **Changes made**: (list of files changed and what was fixed)",
    "- **Verification result**: passed / failed / not-confirmed",
    "- **Classification**: fixable-within-group / requires-prerequisite-change / needs-user-decision",
    "",
  ].join("\n")

  options?.onSubagentUpdate?.(groupId, {
    agent,
    title: `fix: ${groupId}`,
    status: "fixing",
    lastCommand: "dispatching fix worker...",
  })

  try {
    const { detectWorktreeSetupCommand } = await import("./orchestration.js")
    const fixWorktreeSetupCommand = await detectWorktreeSetupCommand(options.repoRoot)
    const fixResult = await dispatchService.runParallel({
      tasks: [{
        agent,
        groupId,
        task: fixPrompt,
        model: options.implementModel.dispatchModel,
        output: fixOutputPath,
        outputMode: "file-only" as const,
        claimedFiles: files,
        worktreeStrategy: buildFixWorkerWorktreeStrategy(failedResult),
        scopedVerification: verificationCmd,
        worktreeSetupCommand: fixWorktreeSetupCommand,
        onUpdate: (progress) => {
          const recentOutput = Array.isArray(progress.recentOutput) ? progress.recentOutput : []
          options?.onSubagentUpdate?.(groupId, {
            agent,
            title: `fix: ${groupId}`,
            status: "fixing",
            lastCommand: progress.currentTool
              ? `${progress.currentTool}${progress.currentToolArgs ? ` ${progress.currentToolArgs}` : ""}`
              : recentOutput[recentOutput.length - 1] ?? "fixing...",
          })
        },
      }],
      cwd: options.cwd,
      concurrency: 1,
      worktree: true,
      worktreeSetupHook: options.worktreeSetupHook,
      maxOutput: { lines: 5000, bytes: 500_000 },
    })

    const fixTaskResult = fixResult.results[0]
    if (!fixTaskResult) {
      return { fixed: false, fixClassification: "fix-worker-error", error: "Fix worker produced no result" }
    }

    let verificationOutputPath: string | undefined
    if (fixTaskResult.verification?.output) {
      verificationOutputPath = fixVerificationPath
      await fs.writeFile(fixVerificationPath, fixTaskResult.verification.output, "utf-8").catch(() => {})
    }

    const fixPassed = fixTaskResult.ok && fixTaskResult.verification?.status !== "fail" && fixTaskResult.verification?.status !== "failed"
    const fixVerificationStatus = fixTaskResult.verification?.status

    if (fixPassed) {
      options?.onSubagentUpdate?.(groupId, {
        agent,
        title: `fix: ${groupId}`,
        status: "completed",
        lastCommand: "fix succeeded",
      })
      return {
        fixed: true,
        fixPatchPath: fixTaskResult.patchPath,
        fixClassification: "fixable-within-group",
        verificationCommand: verificationCmd,
        verificationOutput: fixTaskResult.verification?.output,
        verificationOutputPath,
        dispatchResult: fixTaskResult,
      }
    }

    const fixError = fixTaskResult.error
      ? `Fix worker error: ${fixTaskResult.error}`
      : fixVerificationStatus === "fail" || fixVerificationStatus === "failed"
        ? `Fix verification failed: ${verificationCmd ?? "(not captured)"}`
        : "Fix worker failed without error"

    const workerOutput = fixTaskResult.rawOutput ?? ""
    let classification = "fixable-within-group"
    const lower = workerOutput.toLowerCase()
    if (lower.includes("needs-user-decision") || lower.includes("needs_user_decision") || lower.includes("requires user")) {
      classification = "needs-user-decision"
    } else if (lower.includes("requires-prerequisite-change") || lower.includes("requires prerequisite") || lower.includes("scope expansion")) {
      classification = "requires-prerequisite-change"
    }

    return {
      fixed: false,
      fixClassification: classification,
      error: fixError,
      verificationCommand: verificationCmd,
      verificationOutput: fixTaskResult.verification?.output,
      verificationOutputPath,
      dispatchResult: fixTaskResult,
    }
  } catch (err) {
    return {
      fixed: false,
      fixClassification: "fix-worker-error",
      error: `Fix worker crashed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Write a human-readable group status summary artifact.
 *
 * Path: `<run-dir>/group-status-summary.md`
 */
async function writeGroupStatusSummary(
  runId: string,
  changeId: string,
  cwd?: string,
): Promise<string> {
  const { default: fs } = await import("node:fs/promises")
  const { default: path } = await import("node:path")
  const { readRun } = await import("pi-zflow-artifacts")
  const { resolveRunDir } = await import("pi-zflow-artifacts/artifact-paths")

  const run = await readRun(runId, cwd)
  const ledger = (run.metadata?.[GROUP_LEDGER_META_KEY] ?? {}) as Record<string, GroupStatusEntry>
  const dispatchProgress = (run.metadata?.dispatchProgress ?? {}) as Record<string, unknown>
  const entries = Object.values(ledger)

  const lines: string[] = []
  const succeeded = entries.filter((e) => e.status === "succeeded" || e.status === "applied")
  const failed = entries.filter((e) => e.status === "failed")
  const blocked = entries.filter((e) => e.status === "blocked")
  const running_ = entries.filter((e) => e.status === "running" || e.status === "retrying")
  const pending_ = entries.filter((e) => e.status === "queued" || e.status === "pending")

  lines.push(`# Group Status Summary — ${changeId}\n`)
  lines.push(`Run: ${runId}`)
  lines.push(`Phase: ${run.phase}`)
  lines.push(`Generated: ${new Date().toISOString()}\n`)

  lines.push(`## Overview`)
  lines.push(`- Total groups: ${entries.length}`)
  lines.push(`- Succeeded: ${succeeded.length}`)
  lines.push(`- Failed: ${failed.length}`)
  lines.push(`- Blocked: ${blocked.length}`)
  lines.push(`- In progress: ${running_.length}`)
  lines.push(`- Pending: ${pending_.length}`)
  if (dispatchProgress["activeWave"] !== undefined) {
    lines.push(`- Active wave: ${String(dispatchProgress["activeWave"])}`)
  }
  if (dispatchProgress["heartbeatCount"] !== undefined) {
    lines.push(`- Heartbeats: ${String(dispatchProgress["heartbeatCount"])}`)
  }
  if (typeof dispatchProgress["elapsedSeconds"] === "number") {
    lines.push(`- Elapsed seconds: ${dispatchProgress["elapsedSeconds"]}`)
  }
  if (typeof dispatchProgress["lastWorkflowUpdate"] === "string" && dispatchProgress["lastWorkflowUpdate"].trim().length > 0) {
    lines.push(`- Last workflow update: ${dispatchProgress["lastWorkflowUpdate"]}`)
  }
  lines.push("")

  if (succeeded.length > 0) {
    lines.push(`## Succeeded Groups`)
    for (const g of succeeded) {
      lines.push(`- **${g.groupId}** — ${g.agent}`)
      lines.push(`  - Files: ${g.files.join(", ")}`)
      lines.push(`  - Patch: ${g.patchPath ?? "(no patch)"}`)
      if (g.completionMode) {
        lines.push(`  - Completion mode: ${g.completionMode}`)
      }
      if (g.implementationEvidencePath) {
        lines.push(`  - Evidence: ${g.implementationEvidencePath}`)
      }
      if (g.lastCommand) {
        lines.push(`  - Last command: ${g.lastCommand}`)
      }
      if (g.rateLimitRetryCount) {
        lines.push(`  - Rate-limit retries: ${g.rateLimitRetryCount}`)
      }
      if (g.semanticCoupling.notes.length > 0) {
        for (const note of g.semanticCoupling.notes) {
          lines.push(`  - Note: ${note}`)
        }
      }
    }
    lines.push("")
  }

  if (failed.length > 0) {
    lines.push(`## Failed Groups`)
    for (const g of failed) {
      lines.push(`- **${g.groupId}** — ${g.agent}`)
      lines.push(`  - Error: ${g.error ?? "(unknown)"}`)
      lines.push(`  - Failure kind: ${g.failureKind ?? "unknown"}`)
      lines.push(`  - Retry count: ${g.retryCount}`)
      // Show verification output snippet when available
      const scopedVer = g.scopedVerification as { output?: string; command?: string; outputPath?: string } | undefined
      if (scopedVer?.command) {
        lines.push(`  - Verification command: \`${scopedVer.command}\``)
      }
      if ((scopedVer as { classification?: string } | undefined)?.classification) {
        lines.push(`  - Verification classification: ${(scopedVer as { classification?: string }).classification}`)
      }
      if (scopedVer?.output) {
        // Trim to last 5 lines or first 500 chars, whichever is smaller
        const tail = scopedVer.output.split("\n").slice(-5).join("\n")
        const snippet = tail.length > 500 ? tail.slice(0, 500) + "..." : tail
        if (snippet.trim()) {
          lines.push(`  - Verification output:`)
          lines.push("```")
          lines.push(snippet)
          lines.push("```")
        }
      }
      if (scopedVer?.outputPath) {
        lines.push(`  - Verification output file: ${scopedVer.outputPath}`)
      }
      if (g.lastCommand) {
        lines.push(`  - Last command: ${g.lastCommand}`)
      }
      if (g.lastProgressAt) {
        lines.push(`  - Last progress at: ${g.lastProgressAt}`)
      }
      if (g.rateLimitRetryCount) {
        lines.push(`  - Rate-limit retries: ${g.rateLimitRetryCount}`)
      }
      if (g.semanticCoupling.notes.length > 0) {
        for (const note of g.semanticCoupling.notes) {
          lines.push(`  - Note: ${note}`)
        }
      }
    }
    lines.push("")
  }

  if (blocked.length > 0) {
    lines.push(`## Blocked Groups`)
    for (const g of blocked) {
      lines.push(`- **${g.groupId}** — ${g.agent}`)
      lines.push(`  - Blocked by: ${g.blockedBy?.join(", ") ?? "(unknown)"}`)
      lines.push(`  - Status: ${g.status}`)
      if (g.semanticCoupling.notes.length > 0) {
        for (const note of g.semanticCoupling.notes) {
          lines.push(`  - Note: ${note}`)
        }
      }
    }
    lines.push("")
  }

  if (running_.length > 0) {
    lines.push(`## Running Groups`)
    for (const g of running_) {
      lines.push(`- **${g.groupId}** — ${g.agent}`)
      lines.push(`  - Status: ${g.status}`)
      if (g.lastCommand) lines.push(`  - Last command: ${g.lastCommand}`)
      if (g.lastProgressAt) lines.push(`  - Last progress at: ${g.lastProgressAt}`)
      if (g.rateLimitRetryCount) lines.push(`  - Rate-limit retries: ${g.rateLimitRetryCount}`)
    }
    lines.push("")
  }

  if (pending_.length > 0) {
    lines.push(`## Pending Groups`)
    for (const g of pending_) {
      lines.push(`- **${g.groupId}** — ${g.agent}`)
      lines.push(`  - Status: ${g.status}`)
      if (g.lastCommand) lines.push(`  - Last command: ${g.lastCommand}`)
    }
    lines.push("")
  }

  lines.push(`## Next Steps\n`)
  if (failed.length > 0) {
    lines.push(`1. Inspect failed groups: /zflow-change-audit ${changeId}`)
    lines.push(`2. Resume failed groups: /zflow-change-implement ${changeId} --resume --failed-only`)
    lines.push(`3. Apply successful groups' patches: /zflow-change-implement ${changeId} --apply-successful`)
  } else if (entries.every((e) => e.status === "succeeded" || e.status === "applied")) {
    lines.push("All groups completed. Run final verification and code review.")
  } else {
    lines.push(`1. Resume: /zflow-change-implement ${changeId} --resume`)
  }

  const summary = lines.join("\n")
  const runDir = resolveRunDir(runId, cwd)
  const summaryPath = path.join(runDir, "group-status-summary.md")
  await fs.writeFile(summaryPath, summary, "utf-8")
  return summaryPath
}

interface FailedGroupDecision {
  groupId: string
  agent: string
  attempt: number
  decision: "retry" | "blocker"
  reason: string
  error?: string
}

// ── Partial/resume run helpers ────────────────────────────────────

/**
 * Find the latest partial or unfinished run for a change.
 *
 * Prioritises runs with phase "partial", then "executing".
 * Returns null if no unfinished run is found.
 */
async function findLatestPartialRun(
  changeId: string,
  cwd?: string,
): Promise<{ runId: string; run: Record<string, unknown> } | null> {
  const { getChangeLifecycle } = await import("pi-zflow-artifacts/state-index")
  const { readRun } = await import("pi-zflow-artifacts")

  const cl = await getChangeLifecycle(changeId, cwd)
  if (!cl || cl.unfinishedRuns.length === 0) return null

  const runIds = cl.unfinishedRuns.slice().reverse()
  for (const runId of runIds) {
    try {
      const run = await readRun(runId, cwd)
      const phase = (run as Record<string, unknown>).phase as string ?? ""
      if (phase === "partial" || phase === "executing") {
        return { runId, run: run as unknown as Record<string, unknown> }
      }
    } catch {
      continue
    }
  }

  return null
}

/**
 * Read the group ledger from a run's metadata.
 */
async function getGroupLedger(
  runId: string,
  cwd?: string,
): Promise<Record<string, GroupStatusEntry>> {
  const { readRun } = await import("pi-zflow-artifacts")
  const run = await readRun(runId, cwd)
  return (run.metadata?.[GROUP_LEDGER_META_KEY] ?? {}) as Record<string, GroupStatusEntry>
}

/**
 * Filter group ledger entries that need to be resumed (failed/pending/queued/retrying).
 */
function getResumableGroupIds(ledger: Record<string, GroupStatusEntry>): string[] {
  return Object.values(ledger)
    .filter((e) => e.status === "failed" || e.status === "pending" || e.status === "queued" || e.status === "retrying")
    .map((e) => e.groupId)
}

/**
 * Check whether a group is eligible for safe apply-back.
 *
 * Conditions:
 * - status must be "succeeded"
 * - appliedToPrimary must be false
 * - scopedVerification must exist and be "pass"
 * - patchPath must exist
 *
 * When `checkCoupling` is true (default), also reject if:
 * - sharedFiles includes any file from another group
 * - any dependency is not succeeded/applied
 */
function checkApplyEligibility(
  entry: GroupStatusEntry,
  ledger: Record<string, GroupStatusEntry>,
  checkCoupling: boolean,
): { ok: boolean; reason?: string } {
  if (entry.status !== "succeeded") {
    return { ok: false, reason: `Status is "${entry.status}", not "succeeded"` }
  }
  if (entry.appliedToPrimary) {
    return { ok: false, reason: "Already applied to primary" }
  }
  if (!entry.scopedVerification || entry.scopedVerification.status !== "pass") {
    return { ok: false, reason: "Scoped verification did not pass or is missing" }
  }
  if (!entry.patchPath) {
    return { ok: false, reason: "No patch artifact available" }
  }

  if (checkCoupling) {
    if (entry.semanticCoupling.sharedFiles.length > 0) {
      return { ok: false, reason: `Has shared files: ${entry.semanticCoupling.sharedFiles.join(", ")}` }
    }
    for (const depId of entry.dependencies) {
      const dep = ledger[depId]
      if (dep && dep.status !== "applied" && !dep.appliedToPrimary && dep.status !== "skipped") {
        return { ok: false, reason: `Dependency "${depId}" has status "${dep.status}", not applied/skipped` }
      }
    }
  }

  return { ok: true }
}

/**
 * Apply patches from successful groups back to the primary worktree.
 *
 * Returns list of groupIds that were applied.
 */
async function applySuccessfulGroupPatches(
  runId: string,
  changeId: string,
  cwd: string | undefined,
  forceCoupling: boolean,
  onProgress?: (message: string) => void,
): Promise<{ applied: string[]; errors: string[]; summaryPath: string }> {
  const { default: fs } = await import("node:fs/promises")
  const { applyPatchesWithLedger } = await import("./orchestration.js")

  const ledger = await getGroupLedger(runId, cwd)
  const entries = Object.values(ledger)
    .sort((a, b) => a.dependencies.length - b.dependencies.length || a.groupId.localeCompare(b.groupId))

  const applied: string[] = []
  const errors: string[] = []

  // Use existing eligibility checks to build the list of groups to apply
  const eligibleGroups: string[] = []
  for (const entry of entries) {
    if (entry.appliedToPrimary) {
      if (entry.patchPath) {
        try {
          await fs.access(entry.patchPath)
        } catch {
          errors.push(`Group "${entry.groupId}" marked applied but patch missing at "${entry.patchPath}"`)
        }
      }
      continue
    }

    const eligibility = checkApplyEligibility(entry, ledger, !forceCoupling)
    if (!eligibility.ok) {
      errors.push(`Group "${entry.groupId}": ${eligibility.reason}`)
      continue
    }

    eligibleGroups.push(entry.groupId)
  }

  if (eligibleGroups.length === 0) {
    onProgress?.("No groups eligible for apply-back.")
    const { readRun, updateRun } = await import("pi-zflow-artifacts")
    const run = await readRun(runId, cwd)
    await updateRun(runId, {
      phase: "partial",
      metadata: {
        ...(run.metadata ?? {}),
        applySuccessfulResult: {
          applied: 0,
          errors: errors.length,
        },
      },
    } as any, cwd)
    const summaryPath = await writeGroupStatusSummary(runId, changeId, cwd).catch(() => "")
    return { applied, errors, summaryPath }
  }

  // Delegate to the smart apply-back cascade
  onProgress?.(`${eligibleGroups.length} group(s) eligible. Running smart apply-back cascade...`)

  const cascadeResult = await applyPatchesWithLedger(runId, cwd, {
    applyOnly: eligibleGroups,
    onProgress,
  })

  // Map cascade result back to the old return format
  if (cascadeResult.success) {
    // All eligible groups were applied
    for (const gid of eligibleGroups) {
      applied.push(gid)
      await updateGroupLedger(runId, gid, {
        status: "applied",
        appliedToPrimary: true,
      }, cwd)
    }
  } else {
    // Cascade failed — determine which groups failed
    const ledgerAfter = await getGroupLedger(runId, cwd)
    for (const gid of eligibleGroups) {
      const entry = ledgerAfter[gid]
      if (entry?.appliedToPrimary) {
        applied.push(gid)
      } else {
        errors.push(`Group "${gid}" apply-back failed via cascade: ${cascadeResult.error ?? "Unknown error"}`)
      }
    }
  }

  const { readRun, updateRun } = await import("pi-zflow-artifacts")
  const run = await readRun(runId, cwd)
  await updateRun(runId, {
    phase: cascadeResult.success ? "completed" : "partial",
    metadata: {
      ...(run.metadata ?? {}),
      applySuccessfulResult: {
        applied: applied.length,
        errors: errors.length,
      },
      strategiesAttempted: cascadeResult.strategiesAttempted,
      successfulStrategy: cascadeResult.successfulStrategy,
      subagentAvailable: cascadeResult.subagentAvailable,
    },
  } as any, cwd)

  const summaryPath = await writeGroupStatusSummary(runId, changeId, cwd).catch(() => "")
  onProgress?.(`Applied ${applied.length} group(s). ${errors.length} error(s). Cascade strategy: ${cascadeResult.successfulStrategy ?? "none"}.`)

  return { applied, errors, summaryPath }
}

/**
 * Resume a partial run by dispatching only the failed/pending/queued groups.
 *
 * Returns the updated ledger after dispatch.
 */
async function resumeWorktreeDispatch(
  runId: string,
  changeId: string,
  planVersion: string,
  dispatchService: DispatchService,
  options?: {
    cwd?: string
    force?: boolean
    orchestratorTarget?: string
    targetGroupIds?: string[]
    onWorkflowUpdate?: (message: string) => void
    onSubagentUpdate?: (id: string, update: Partial<Omit<WorkflowSubagentSnapshot, "id" | "startedAt">>) => void
    onRateLimitNotice?: (message: string) => void
    sleep?: (ms: number) => Promise<void>
    progressPersistIntervalMs?: number
  },
): Promise<void> {
  const { default: fs } = await import("node:fs/promises")
  const { default: path } = await import("node:path")
  const { parseExecutionGroupsMd } = await import("./orchestration.js")
  const {
    prepareWorktreeImplementationRun,
    finalizeWorktreeImplementationRun,
  } = await import("./orchestration.js")
  const { captureGroupResult } = await import("./group-result.js")
  const {
    dispatchParallelWithRateLimitRetries,
    isRateLimitDispatchError,
  } = await import("./orchestration/implementation/rate-limit.js")
  const {
    persistImplementationDispatchSnapshot,
  } = await import("./orchestration/implementation/live-progress.js")
  const { readRun, updateRun } = await import("pi-zflow-artifacts")

  const cwd = options?.cwd ?? process.cwd()
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const execFileAsync = promisify(execFile)
  const { stdout: repoRootRaw } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd })
  const repoRoot = repoRootRaw.trim()
  const { resolveDispatchWorktreeSetup } = await import("./worktree-setup.js")
  const worktreeSetupResolution = await resolveDispatchWorktreeSetup(repoRoot)
  if (!worktreeSetupResolution.ok) {
    throw new Error(worktreeSetupResolution.message ?? "worktree setup requirements were not satisfied")
  }

  // Read existing execution groups from plan artifact
  const executionGroupsArtifactPath = resolvePlanArtifactPath(changeId, planVersion, "execution-groups", cwd)
  let executionGroupsMd = ""
  try {
    executionGroupsMd = await fs.readFile(executionGroupsArtifactPath, "utf-8")
  } catch {
    throw new Error(`Cannot read execution-groups.md at: ${executionGroupsArtifactPath}`)
  }
  const allGroups = parseExecutionGroupsMd(executionGroupsMd)

  // ── Read the existing run and ledger ───────────────────────────
  const run = await readRun(runId, cwd)
  const existingLedger = (run.metadata?.[GROUP_LEDGER_META_KEY] ?? {}) as Record<string, GroupStatusEntry>

  // Filter groups to only those explicitly targeted for rerun, falling back
  // to the ledger-derived resumable set when no target override is supplied.
  const resumableGroupIds = new Set(options?.targetGroupIds?.length
    ? options.targetGroupIds
    : getResumableGroupIds(existingLedger))
  if (resumableGroupIds.size === 0) {
    throw new Error("No groups found to resume. All groups are already succeeded/applied/skipped.")
  }

  const resumeGroups = allGroups.filter((g) => resumableGroupIds.has(g.id))
  if (resumeGroups.length === 0) {
    throw new Error(
      `Resumable groups (${[...resumableGroupIds].join(", ")}) not found in execution plan. ` +
      "The plan may have changed since the original run.",
    )
  }

  // ── Prepare task plan for only the resumable groups ────────────
  const planArtifactPaths = {
    design: resolvePlanArtifactPath(changeId, planVersion, "design", cwd),
    executionGroups: executionGroupsArtifactPath,
    standards: resolvePlanArtifactPath(changeId, planVersion, "standards", cwd),
    verification: resolvePlanArtifactPath(changeId, planVersion, "verification", cwd),
  }

  const runPlan = await prepareWorktreeImplementationRun(
    changeId,
    planVersion,
    resumeGroups,
    planArtifactPaths,
    {
      cwd,
      repoRoot,
      runId,
      force: options?.force,
      orchestratorTarget: options?.orchestratorTarget,
    },
  )

  // Mark the resumed run active again before dispatching any workers.
  try {
    const { updateStateIndexEntry, getChangeLifecycle, upsertChangeLifecycle } = await import("pi-zflow-artifacts/state-index")
    await updateRun(runId, {
      phase: "executing",
      metadata: {
        ...(run.metadata ?? {}),
        resumedAt: new Date().toISOString(),
      },
    } as any, cwd)
    await updateStateIndexEntry(runId, { status: "executing" }, cwd)
    const lifecycle = await getChangeLifecycle(changeId, cwd)
    if (lifecycle) {
      await upsertChangeLifecycle({
        ...lifecycle,
        lastPhase: "executing",
      }, cwd)
    }
  } catch {
    // Best-effort; resume can proceed even if lifecycle metadata could not be refreshed.
  }

  // ── Reuse the existing worktree-results dir ────────────────────
  const { resolveRunDir } = await import("pi-zflow-artifacts/artifact-paths")
  const runDir = resolveRunDir(runId, cwd)
  const worktreeResultsDir = path.join(runDir, "worktree-results")
  await fs.mkdir(worktreeResultsDir, { recursive: true })

  const readExistingWorkerEvidence = async (groupId: string): Promise<{ path?: string; content?: string }> => {
    const candidates = [
      path.join(worktreeResultsDir, `${groupId}-resume-result.md`),
      path.join(worktreeResultsDir, `${groupId}-result.md`),
    ]
    for (const candidate of candidates) {
      try {
        const content = await fs.readFile(candidate, "utf-8")
        if (content.trim()) return { path: candidate, content }
      } catch {
        // Ignore missing historical worker outputs.
      }
    }
    return {}
  }

  const implementModel = await resolveWorkflowModel("zflow.implement-routine")
  const sleep = options?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const progressPersistIntervalMs = Math.max(1000, options?.progressPersistIntervalMs ?? 5000)
  const dispatchStartedAt = new Date().toISOString()
  const pendingGroupProgress = new Map<string, Record<string, unknown>>()
  let pendingDispatchProgress: Record<string, unknown> = {
    dispatchStartedAt,
    totalGroups: runPlan.tasks.length,
    completedGroups: 0,
    status: "running",
  }
  let liveProgressDirty = false
  let lastLiveProgressFlushAt = 0
  let liveProgressFlushPromise: Promise<void> = Promise.resolve()

  const markGroupProgress = (groupId: string, partial: Record<string, unknown>): void => {
    pendingGroupProgress.set(groupId, {
      ...(pendingGroupProgress.get(groupId) ?? {}),
      ...partial,
    })
    liveProgressDirty = true
  }

  const markDispatchProgress = (partial: Record<string, unknown>): void => {
    pendingDispatchProgress = {
      ...pendingDispatchProgress,
      ...partial,
    }
    liveProgressDirty = true
  }

  const flushLiveProgress = async (force = false): Promise<void> => {
    if (!liveProgressDirty) return liveProgressFlushPromise
    const now = Date.now()
    if (!force && now - lastLiveProgressFlushAt < progressPersistIntervalMs) {
      return liveProgressFlushPromise
    }
    lastLiveProgressFlushAt = now

    const groupUpdates = Object.fromEntries(pendingGroupProgress.entries())
    pendingGroupProgress.clear()
    const dispatchProgress = { ...pendingDispatchProgress }
    liveProgressDirty = false

    liveProgressFlushPromise = liveProgressFlushPromise
      .then(() => persistImplementationDispatchSnapshot(runId, {
        groupUpdates,
        dispatchProgress,
      }, cwd))
      .catch(() => {})

    return liveProgressFlushPromise
  }

  const emitWorkflowUpdate = (message: string, partial: Record<string, unknown> = {}): void => {
    options?.onWorkflowUpdate?.(message)
    markDispatchProgress({
      lastWorkflowUpdate: message,
      ...partial,
    })
    void flushLiveProgress()
  }

  const { detectWorktreeSetupCommand } = await import("./orchestration.js")
  const tasks = await Promise.all(runPlan.tasks.map(async (t, taskIndex) => {
    const taskRepoRoot = inferTaskRepoRoot(repoRoot, { claimedFiles: t.claimedFiles })
    const worktreeSetupCommand = await detectWorktreeSetupCommand(taskRepoRoot)
    const planGroup = runPlan.groups[taskIndex] as unknown as {
      id: string
      files: string[]
      dependencies: string[]
      parallelizable: boolean
    }
    const lineage = t.worktreeStrategy?.baseStrategy === "dependency-lineage"
      ? await materializeDependencyLineageRef(
          runId,
          repoRoot,
          planGroup,
          runPlan.groups as Array<{ id: string; files: string[]; dependencies: string[]; parallelizable: boolean }>,
          cwd,
        )
      : null

    return {
      agent: t.agent,
      groupId: t.groupId,
      task: t.task,
      cwd: taskRepoRoot,
      model: implementModel.dispatchModel,
      output: path.join(worktreeResultsDir, `${t.groupId}-resume-result.md`),
      outputMode: "file-only" as const,
      scopedVerification: t.scopedVerification,
      worktreeSetupCommand,
      claimedFiles: t.claimedFiles,
      dependencies: t.dependencies,
      worktreeStrategy: lineage
        ? {
            ...t.worktreeStrategy,
            baseStrategy: "dependency-lineage" as const,
            baseRef: lineage.ref,
          }
        : t.worktreeStrategy,
      onUpdate: (progress: AgentDispatchProgress) => {
        const recentTools = Array.isArray(progress.recentTools) ? progress.recentTools : []
        const recentTool = recentTools[recentTools.length - 1]
        const recentOutput = Array.isArray(progress.recentOutput) ? progress.recentOutput : []
        const lastCommand = progress.currentTool
          ? `${progress.currentTool}${progress.currentToolArgs ? ` ${progress.currentToolArgs}` : ""}`
          : recentTool?.tool
            ? `${recentTool.tool}${recentTool.args ? ` ${recentTool.args}` : ""}`
            : recentOutput[recentOutput.length - 1] ?? "resume dispatching..."
        options?.onSubagentUpdate?.(t.groupId, {
          agent: t.agent,
          title: runPlan.groups[taskIndex]?.taskPrompt ?? undefined,
          model: implementModel.model ?? "unavailable",
          thinking: implementModel.thinking ?? "unavailable",
          status: progress.status ?? "running",
          lastCommand,
        })
        markGroupProgress(t.groupId, {
          status: progress.status ?? "running",
          agent: t.agent,
          taskPrompt: runPlan.groups[taskIndex]?.taskPrompt ?? "",
          model: implementModel.model ?? "unavailable",
          thinking: implementModel.thinking ?? "unavailable",
          currentTool: progress.currentTool,
          lastCommand,
          lastProgressAt: new Date().toISOString(),
        })
        void flushLiveProgress()
      },
    }
  }))

  const WORKTREE_DISPATCH_CONCURRENCY = resolveImplementConcurrency()
  const MAX_OUTPUT_LINES = 5000
  const MAX_OUTPUT_BYTES = 500_000

  for (let taskIdx = 0; taskIdx < runPlan.tasks.length; taskIdx++) {
    const task = runPlan.tasks[taskIdx]!
    options?.onSubagentUpdate?.(task.groupId, {
      agent: task.agent,
      title: runPlan.groups[taskIdx]?.taskPrompt ?? undefined,
      model: implementModel.model ?? "unavailable",
      thinking: implementModel.thinking ?? "unavailable",
      status: "running",
      lastCommand: "resume dispatching...",
    })
    await updateGroupLedger(runId, task.groupId, {
      status: "running",
      agent: task.agent,
      model: implementModel.model ?? "unavailable",
      thinking: implementModel.thinking ?? "unavailable",
      startedAt: new Date().toISOString(),
      lastCommand: "resume dispatching...",
      error: undefined,
      failureKind: undefined,
    }, cwd).catch(() => {})
    markGroupProgress(task.groupId, {
      status: "running",
      agent: task.agent,
      taskPrompt: runPlan.groups[taskIdx]?.taskPrompt ?? "",
      model: implementModel.model ?? "unavailable",
      thinking: implementModel.thinking ?? "unavailable",
      startedAt: new Date().toISOString(),
      lastCommand: "resume dispatching...",
      lastProgressAt: new Date().toISOString(),
    })
  }

  await flushLiveProgress(true)

  // ── Dispatch ──────────────────────────────────────────────────

  // ── Dispatch with heartbeat ──────────────────────────────────
  // The dispatch blocks until all worktree tasks complete. Emit periodic
  // heartbeat progress so the indicator doesn't appear frozen.
  let heartbeatCount = 0
  const dispatchStartTime = Date.now()
  const heartbeat = setInterval(() => {
    heartbeatCount++
    const elapsed = Math.round((Date.now() - dispatchStartTime) / 1000)
    const runningCount = runPlan.tasks.length
    emitWorkflowUpdate(
      `⏳ Workers running: ${runningCount} group(s) dispatched, ` +
      `${heartbeatCount} heartbeat(s), ${elapsed}s elapsed`,
      {
        activeWave: 1,
        heartbeatCount,
        totalGroups: runPlan.tasks.length,
        dispatchedGroups: runPlan.tasks.map((task) => task.groupId),
        completedGroups: 0,
        elapsedSeconds: elapsed,
        status: "running",
      },
    )
  }, 10000)
  heartbeat.unref?.()

  let dispatchResult
  try {
    dispatchResult = await dispatchParallelWithRateLimitRetries({
      dispatchService,
      maxRetries: IMPLEMENT_RATE_LIMIT_MAX_RETRIES,
      defaultWaitMs: IMPLEMENT_RATE_LIMIT_DEFAULT_WAIT_MS,
      sleep,
      onRateLimitNotice: async (notice) => {
        const retryMessage = `${notice.message} ${notice.error ?? ""}`.trim()
        emitWorkflowUpdate(retryMessage, {
          activeWave: 1,
          heartbeatCount,
          totalGroups: runPlan.tasks.length,
          dispatchedGroups: runPlan.tasks.map((task) => task.groupId),
          completedGroups: 0,
          elapsedSeconds: Math.round((Date.now() - dispatchStartTime) / 1000),
          status: "retrying",
        })
        options?.onRateLimitNotice?.(retryMessage)
        options?.onSubagentUpdate?.(notice.groupId, {
          agent: notice.task.agent,
          title: runPlan.groups.find((group) => group.id === notice.groupId)?.taskPrompt ?? undefined,
          model: implementModel.model ?? "unavailable",
          thinking: implementModel.thinking ?? "unavailable",
          status: "running",
          lastCommand: retryMessage,
        })
        markGroupProgress(notice.groupId, {
          status: "retrying",
          agent: notice.task.agent,
          model: implementModel.model ?? "unavailable",
          thinking: implementModel.thinking ?? "unavailable",
          lastCommand: retryMessage,
          lastProgressAt: new Date().toISOString(),
          retryCount: notice.attempt,
          rateLimitRetryCount: notice.attempt,
          failureKind: "retryable",
        })
        await flushLiveProgress(true)
      },
      input: {
        tasks,
        cwd,
        concurrency: WORKTREE_DISPATCH_CONCURRENCY,
        worktree: true,
        worktreeSetupHook: worktreeSetupResolution.hook,
        maxOutput: { lines: MAX_OUTPUT_LINES, bytes: MAX_OUTPUT_BYTES },
      },
    })
  } finally {
    clearInterval(heartbeat)
    await flushLiveProgress(true)
  }

  // ── Collect results and update ledger ─────────────────────────
  const newResults: Array<DispatchGroupResult> = [...dispatchResult.results]
  const groupResults: any[] = []
  const resumeFailures: string[] = []

  for (let idx = 0; idx < newResults.length; idx++) {
    const r = newResults[idx]!
    const group = resumeGroups[idx]
    if (!group) continue

    const rateLimitRetryCount = dispatchResult.retryCounts?.[group.id] ?? 0
    const verification = normalizeDispatchVerification(r.verification)
    const existingEvidence = await readExistingWorkerEvidence(group.id)
    const rawOutput = (!r.rawOutput || !r.rawOutput.trim()) && r.outputPath
      ? await fs.readFile(r.outputPath, "utf-8").catch(() => r.rawOutput)
      : (r.rawOutput?.trim() ? r.rawOutput : existingEvidence.content)
    const acceptedNoop = acceptImplementationNoopResult({
      ok: r.ok,
      error: r.error,
      rawOutput,
      verification,
    })
    const acceptedExistingEvidence = acceptAlreadyImplementedEvidenceResult({
      ok: r.ok,
      error: r.error,
      rawOutput,
      verification,
    })
    const acceptedResult = acceptedNoop.accepted ? acceptedNoop : acceptedExistingEvidence
    const effectiveVerification = acceptedResult.accepted && verification?.status === "fail"
      ? {
          ...verification,
          status: "pass" as const,
          output: verification.output ?? acceptedResult.reason,
        }
      : verification
    const resultForWorkflow = acceptedResult.accepted
      ? {
          ...r,
          ok: true,
          error: undefined,
          patchPath: undefined,
          worktreePath: undefined,
          changedFiles: group.files,
          verification: effectiveVerification,
        }
      : r

    if (!resultForWorkflow.ok) {
      const failureMessage = resultForWorkflow.error ?? "unknown error"
      resumeFailures.push(`${group.id}: ${failureMessage}`)
      await updateGroupLedger(runId, group.id, {
        status: "failed",
        error: failureMessage,
        failureKind: isRateLimitDispatchError(failureMessage) ? "retryable" : "blocker",
        retryCount: ((existingLedger[group.id]?.retryCount ?? 0) + 1),
        rateLimitRetryCount,
        lastCommand: failureMessage,
        lastProgressAt: new Date().toISOString(),
      }, cwd).catch(() => {})
      options?.onSubagentUpdate?.(group.id, {
        agent: resultForWorkflow.agent ?? group.agent,
        title: group.taskPrompt ?? undefined,
        model: implementModel.model ?? "unavailable",
        thinking: implementModel.thinking ?? "unavailable",
        status: "failed",
        finishedAt: Date.now(),
        lastCommand: failureMessage,
      })
      markGroupProgress(group.id, {
        status: "failed",
        agent: resultForWorkflow.agent ?? group.agent,
        taskPrompt: group.taskPrompt ?? "",
        model: implementModel.model ?? "unavailable",
        thinking: implementModel.thinking ?? "unavailable",
        lastCommand: failureMessage,
        lastProgressAt: new Date().toISOString(),
        rateLimitRetryCount,
        failureKind: isRateLimitDispatchError(failureMessage) ? "retryable" : "blocker",
      })
      continue
    }

    // If the bridge explicitly reported failed scoped verification, fail the group.
    // Missing verification (bridge no longer runs it) = deferred to final verification.
    if (effectiveVerification && effectiveVerification.status === "fail" && !acceptedResult.accepted) {
      resumeFailures.push(`${group.id}: scoped verification failed`)
      await updateGroupLedger(runId, group.id, {
        status: "failed",
        error: "scoped verification failed",
        failureKind: "blocker",
        scopedVerification: verification,
        rateLimitRetryCount,
        lastCommand: "scoped verification failed",
        lastProgressAt: new Date().toISOString(),
      }, cwd).catch(() => {})
      options?.onSubagentUpdate?.(group.id, {
        agent: r.agent ?? group.agent,
        title: group.taskPrompt ?? undefined,
        model: implementModel.model ?? "unavailable",
        thinking: implementModel.thinking ?? "unavailable",
        status: "failed",
        finishedAt: Date.now(),
        lastCommand: "scoped verification failed",
      })
      markGroupProgress(group.id, {
        status: "failed",
        agent: r.agent ?? group.agent,
        taskPrompt: group.taskPrompt ?? "",
        model: implementModel.model ?? "unavailable",
        thinking: implementModel.thinking ?? "unavailable",
        lastCommand: "scoped verification failed",
        lastProgressAt: new Date().toISOString(),
      })
      continue
    }

    // Group succeeded
    const scopedVerification = effectiveVerification ?? {
      status: "skipped" as const,
      command: undefined,
      output: "Scoped verification deferred to the final verification phase.",
    }
    const successMessage = acceptedResult.accepted
      ? (acceptedResult.reason ?? "Implementation already present; scoped verification passed without additional edits.")
      : "agent complete; scoped verification deferred to final verification"

    if (acceptedResult.accepted) {
      const completionMode = acceptedNoop.accepted ? "noop-evidence" : "worker-evidence"
      await updateGroupLedger(runId, group.id, {
        status: "applied",
        appliedToPrimary: true,
        agent: resultForWorkflow.agent ?? "zflow.implement-routine",
        error: undefined,
        failureKind: undefined,
        patchPath: undefined,
        implementationEvidencePath: r.outputPath ?? existingEvidence.path,
        completionMode,
        changedFiles: resultForWorkflow.changedFiles ?? group.files,
        scopedVerification: {
          status: scopedVerification.status,
          command: scopedVerification.command,
          output: scopedVerification.output,
          classification: scopedVerification.classification,
          attempts: scopedVerification.attempts,
        },
        rateLimitRetryCount,
        lastCommand: successMessage,
        lastProgressAt: new Date().toISOString(),
      }, cwd).catch(() => {})
      options?.onSubagentUpdate?.(group.id, {
        agent: resultForWorkflow.agent ?? group.agent,
        title: group.taskPrompt ?? undefined,
        model: implementModel.model ?? "unavailable",
        thinking: implementModel.thinking ?? "unavailable",
        status: "completed",
        finishedAt: Date.now(),
        lastCommand: successMessage,
      })
      markGroupProgress(group.id, {
        status: "applied",
        agent: resultForWorkflow.agent ?? group.agent,
        taskPrompt: group.taskPrompt ?? "",
        model: implementModel.model ?? "unavailable",
        thinking: implementModel.thinking ?? "unavailable",
        lastCommand: successMessage,
        lastProgressAt: new Date().toISOString(),
        rateLimitRetryCount,
      })
      continue
    }

    await updateGroupLedger(runId, group.id, {
      status: "succeeded",
      agent: resultForWorkflow.agent ?? "zflow.implement-routine",
      error: undefined,
      failureKind: undefined,
      patchPath: resultForWorkflow.patchPath,
      completionMode: resultForWorkflow.patchPath ? "patch" : undefined,
      changedFiles: resultForWorkflow.changedFiles ?? group.files,
      scopedVerification: {
        status: scopedVerification.status,
        command: scopedVerification.command,
        output: scopedVerification.output,
        classification: scopedVerification.classification,
        attempts: scopedVerification.attempts,
      },
      rateLimitRetryCount,
      lastCommand: successMessage,
      lastProgressAt: new Date().toISOString(),
    }, cwd).catch(() => {})
    options?.onSubagentUpdate?.(group.id, {
      agent: resultForWorkflow.agent ?? group.agent,
      title: group.taskPrompt ?? undefined,
      model: implementModel.model ?? "unavailable",
      thinking: implementModel.thinking ?? "unavailable",
      status: "completed",
      finishedAt: Date.now(),
      lastCommand: successMessage,
    })
    markGroupProgress(group.id, {
      status: "succeeded",
      agent: resultForWorkflow.agent ?? group.agent,
      taskPrompt: group.taskPrompt ?? "",
      model: implementModel.model ?? "unavailable",
      thinking: implementModel.thinking ?? "unavailable",
      lastCommand: successMessage,
      lastProgressAt: new Date().toISOString(),
      rateLimitRetryCount,
    })

    // Collect group result for apply-back later
    if (resultForWorkflow.patchPath) {
      const patchesDir = path.join(runDir, "patches")
      await fs.mkdir(patchesDir, { recursive: true })
      const destPatchPath = path.join(patchesDir, `${group.id}.patch`)
      if (path.resolve(resultForWorkflow.patchPath) !== path.resolve(destPatchPath)) {
        await fs.copyFile(resultForWorkflow.patchPath, destPatchPath)
      }
      groupResults.push({
        groupId: group.id,
        agent: resultForWorkflow.agent ?? "zflow.implement-routine",
        worktreePath: resultForWorkflow.worktreePath ?? "(patch-based)",
        baseCommit: resultForWorkflow.baseCommit ?? run.head as string,
        headCommit: resultForWorkflow.headCommit ?? run.head as string,
        changedFiles: resultForWorkflow.changedFiles ?? group.files,
        uncommittedChanges: [],
        patchPath: destPatchPath,
        verification: scopedVerification,
        retained: false,
      })
      await updateGroupLedger(runId, group.id, {
        patchPath: destPatchPath,
        changedFiles: resultForWorkflow.changedFiles ?? group.files,
      }, cwd).catch(() => {})
    } else if (resultForWorkflow.worktreePath) {
      const captured = await captureGroupResult({
        groupId: group.id,
        agent: resultForWorkflow.agent ?? group.agent ?? "zflow.implement-routine",
        worktreePath: resultForWorkflow.worktreePath,
        runId,
        repoRoot,
        baseCommit: resultForWorkflow.baseCommit,
        headCommit: resultForWorkflow.headCommit,
        scopedFiles: group.files,
        verification: scopedVerification,
        cwd,
      })
      groupResults.push(captured)
      await updateGroupLedger(runId, group.id, {
        patchPath: captured.patchPath,
        worktreePath: captured.worktreePath,
        changedFiles: captured.changedFiles,
      }, cwd).catch(() => {})
    }
  }

  // ── Finalize — check if all groups are now complete ───────────
  await flushLiveProgress(true)

  const updatedLedger = await getGroupLedger(runId, cwd)
  const allSucceeded = Object.values(updatedLedger).every((e) =>
    e.status === "succeeded" || e.status === "applied" || e.status === "skipped"
  )

  if (resumeFailures.length > 0) {
    // Some resume groups still failed — update phase to partial
    emitWorkflowUpdate(`Resume dispatch failed: ${resumeFailures.join("; ")}`, {
      status: "failed",
      completedGroups: 0,
      elapsedSeconds: Math.round((Date.now() - dispatchStartTime) / 1000),
    })
    await updateRun(runId, {
      phase: "partial",
      metadata: {
        ...((await readRun(runId, cwd)).metadata ?? {}),
        partialRunNote: `${resumeFailures.length} resumed group(s) failed. Successful groups preserved.`,
      },
    } as any, cwd).catch(() => {})
    try {
      const { updateStateIndexEntry, getChangeLifecycle, upsertChangeLifecycle } = await import("pi-zflow-artifacts/state-index")
      await updateStateIndexEntry(runId, { status: "partial" }, cwd)
      const lifecycle = await getChangeLifecycle(changeId, cwd)
      if (lifecycle) {
        await upsertChangeLifecycle({
          ...lifecycle,
          lastPhase: "partial",
        }, cwd)
      }
    } catch {
      // Best-effort
    }
    await writeGroupStatusSummary(runId, changeId, cwd).catch(() => "")
    throw new Error(
      `Resume: ${resumeFailures.length} group(s) still failed: ${resumeFailures.join("; ")}`,
    )
  }

  if (allSucceeded) {
    emitWorkflowUpdate("Resume dispatch complete; applying successful group patches.", {
      status: "completed",
      completedGroups: runPlan.tasks.length,
      elapsedSeconds: Math.round((Date.now() - dispatchStartTime) / 1000),
    })
    const applyResult = await applySuccessfulGroupPatches(runId, changeId, cwd, false)
    const finalLedger = await getGroupLedger(runId, cwd)
    const allApplied = Object.values(finalLedger).every((e) => e.status === "applied" || e.status === "skipped")
    if (!allApplied) {
      throw new Error(
        `Resume completed, but not all successful groups could be applied safely. ` +
        `Applied ${applyResult.applied.length}; ${applyResult.errors.length} issue(s). ` +
        `Use /zflow-change-implement ${changeId} --apply-successful to inspect/apply, or --force-apply-successful to bypass semantic-coupling checks.`,
      )
    }
    return
  }

  emitWorkflowUpdate("Resume rerun groups completed; continuing with newly eligible downstream groups.", {
    status: "running",
    completedGroups: Object.values(await getGroupLedger(runId, cwd)).filter((entry) =>
      entry.status === "succeeded" || entry.status === "applied" || entry.status === "skipped",
    ).length,
    elapsedSeconds: Math.round((Date.now() - dispatchStartTime) / 1000),
  })

  await runWorktreeDispatchAndFinalize(
    runId,
    changeId,
    planVersion,
    dispatchService,
    {
      cwd,
      force: options?.force,
      orchestratorTarget: options?.orchestratorTarget,
      onWorkflowUpdate: options?.onWorkflowUpdate,
      onSubagentUpdate: options?.onSubagentUpdate,
      onRateLimitNotice: options?.onRateLimitNotice,
      sleep: options?.sleep,
      progressPersistIntervalMs: options?.progressPersistIntervalMs,
    },
  )
}

function classifyFailedGroup(
  groupId: string,
  result: DispatchGroupResult,
  attempt: number,
  maxRetries: number = IMPLEMENT_GROUP_MAX_RETRIES,
): FailedGroupDecision {
  const error = result.error ?? "unknown error"
  const normalized = error.toLowerCase()
  const retryBudgetRemaining = attempt < maxRetries

  const blockerPatterns = [
    "unknown agent",
    "no agents discovered",
    "scoped verification failed",
    "verification failed",
    "path guard",
    "permission denied",
    "not a git repository",
  ]

  if (blockerPatterns.some((pattern) => normalized.includes(pattern))) {
    return {
      groupId,
      agent: result.agent,
      attempt,
      decision: "blocker",
      reason: "Failure is deterministic or requires user/code changes before retry.",
      error,
    }
  }

  if (!retryBudgetRemaining) {
    return {
      groupId,
      agent: result.agent,
      attempt,
      decision: "blocker",
      reason: `Retry budget exhausted after ${maxRetries} retry attempt(s).`,
      error,
    }
  }

  return {
    groupId,
    agent: result.agent,
    attempt,
    decision: "retry",
    reason: "Failure may be transient; one bounded retry is allowed.",
    error,
  }
}

async function recordDispatchFailurePolicy(
  runId: string,
  cwd: string | undefined,
  decisions: FailedGroupDecision[],
  reportPath: string,
  phase: "failed" | "partial" = "failed",
): Promise<void> {
  const { readRun, updateRun } = await import("pi-zflow-artifacts")
  const run = await readRun(runId, cwd)
  await updateRun(runId, {
    phase,
    metadata: {
      ...(run.metadata ?? {}),
      dispatchFailurePolicy: {
        maxRetries: IMPLEMENT_GROUP_MAX_RETRIES,
        reportPath,
        decisions,
      },
    },
  } as any, cwd)
}

function normalizeDispatchVerification(
  verification: DispatchGroupResult["verification"],
) {
  if (!verification) return undefined
  const status = verification.status === "passed"
    ? "pass"
    : verification.status === "failed"
      ? "fail"
      : verification.status
  return {
    status,
    command: verification.command,
    output: verification.output,
    classification: verification.classification,
    attempts: verification.attempts,
  }
}

function collectDependencyClosure(
  groups: ReadonlyArray<{ id: string; dependencies: string[] }>,
  targetId: string,
): string[] {
  const byId = new Map(groups.map((group) => [group.id, group]))
  const closure = new Set<string>()
  const stack = [...(byId.get(targetId)?.dependencies ?? [])]

  while (stack.length > 0) {
    const next = stack.pop()!
    if (closure.has(next)) continue
    closure.add(next)
    const group = byId.get(next)
    if (group) {
      for (const dep of group.dependencies) {
        if (!closure.has(dep)) stack.push(dep)
      }
    }
  }

  return [...closure]
}

async function materializeDependencyLineageRef(
  runId: string,
  repoRoot: string,
  targetGroup: { id: string; dependencies: string[] },
  allGroups: Array<{ id: string; files: string[]; dependencies: string[]; parallelizable: boolean }>,
  cwd?: string,
): Promise<{ ref: string; headCommit: string; dependencyGroupIds: string[]; worktreePath: string } | null> {
  const dependencyGroupIds = collectDependencyClosure(allGroups, targetGroup.id)
  if (dependencyGroupIds.length === 0) return null

  const { readRun, updateRun } = await import("pi-zflow-artifacts")
  const { resolveRunDir } = await import("pi-zflow-artifacts/artifact-paths")
  const { default: path } = await import("node:path")
  const run = await readRun(runId, cwd)
  const existing = (run.lineageRefs ?? []).find((entry) => entry.groupId === targetGroup.id && entry.status === "materialized")

  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const execFileAsync = promisify(execFile)

  if (existing) {
    try {
      await execFileAsync("git", ["rev-parse", "--verify", existing.ref], { cwd: repoRoot })
      return {
        ref: existing.ref,
        headCommit: existing.headCommit ?? existing.baseCommit,
        dependencyGroupIds: existing.dependencyGroupIds,
        worktreePath: existing.worktreePath ?? path.join(resolveRunDir(runId, cwd), `lineage-${targetGroup.id}`),
      }
    } catch {
      // Rebuild stale lineage refs.
    }
  }

  const dependencyGroups = allGroups.filter((group) => dependencyGroupIds.includes(group.id))
  if (dependencyGroups.length === 0) return null

  const patchesDir = path.join(resolveRunDir(runId, cwd), "patches")
  const ledger = await getGroupLedger(runId, cwd)
  const patchMap = new Map<string, string>()
  for (const dependencyGroupId of dependencyGroupIds) {
    const ledgerPatchPath = selectCanonicalGroupPatchPath(ledger[dependencyGroupId])
    const patchPath = ledgerPatchPath ?? path.join(patchesDir, `${dependencyGroupId}.patch`)
    try {
      await import("node:fs/promises").then((fs) => fs.access(patchPath))
      patchMap.set(dependencyGroupId, patchPath)
    } catch {
      throw new Error(
        `Cannot materialize dependency lineage for ${targetGroup.id}: missing patch artifact for dependency ${dependencyGroupId}.`,
      )
    }
  }

  const { runIntegrationMerge } = await import("./integration-merge-strategy.js")
  const lineageResult = await runIntegrationMerge({
    runId: `${runId}-lineage-${targetGroup.id}`,
    repoRoot,
    snapshot: run.preApplySnapshot ?? {
      head: run.head,
      indexState: "clean",
      recoveryRef: `refs/zflow/recovery/${runId}`,
    },
    groups: dependencyGroups,
    patches: patchMap,
    cwd,
  })

  if (!lineageResult.success || !lineageResult.integrationWorktreePath) {
    throw new Error(
      lineageResult.error ??
      `Failed to materialize dependency lineage for ${targetGroup.id}.`,
    )
  }

  const { stdout: headCommitRaw } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: lineageResult.integrationWorktreePath,
  })
  const headCommit = headCommitRaw.trim()
  const ref = `refs/zflow/lineage/${runId}/${targetGroup.id}`
  await execFileAsync("git", ["update-ref", ref, headCommit], { cwd: repoRoot })

  const lineageEntry = {
    id: `lineage-${targetGroup.id}`,
    groupId: targetGroup.id,
    dependencyGroupIds,
    ref,
    baseCommit: run.head,
    headCommit,
    worktreePath: lineageResult.integrationWorktreePath,
    status: "materialized" as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  const nextLineageRefs = [
    ...(run.lineageRefs ?? []).filter((entry) => entry.groupId !== targetGroup.id),
    lineageEntry,
  ]
  const nextRetainedArtifacts = [
    ...(run.retainedArtifacts ?? []),
  ]
  if (!nextRetainedArtifacts.some((artifact) => artifact.path === lineageResult.integrationWorktreePath)) {
    nextRetainedArtifacts.push({
      type: "worktree",
      path: lineageResult.integrationWorktreePath,
      reason: `dependency-lineage materialization for ${targetGroup.id}`,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    })
  }
  if (lineageResult.consolidatedPatchPath && !nextRetainedArtifacts.some((artifact) => artifact.path === lineageResult.consolidatedPatchPath)) {
    nextRetainedArtifacts.push({
      type: "patch",
      path: lineageResult.consolidatedPatchPath,
      reason: `dependency-lineage consolidated patch for ${targetGroup.id}`,
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
    })
  }
  await updateRun(runId, {
    lineageRefs: nextLineageRefs,
    retainedArtifacts: nextRetainedArtifacts,
  }, cwd)

  return {
    ref,
    headCommit,
    dependencyGroupIds,
    worktreePath: lineageResult.integrationWorktreePath,
  }
}

/**
 * Try to discover and return a dispatch service from the zflow registry.
 *
 * Searches for a service exposing dispatch-like methods from any capability.
 * Returns null if no service is found.
 */
async function tryGetDispatchServiceViaRegistry(): Promise<DispatchService | null> {
  try {
    const reg = getZflowRegistry()
    // Check directly via the dedicated capability first
    if (reg.has(DISPATCH_SERVICE_CAPABILITY)) {
      const svc = reg.optional<DispatchService>(DISPATCH_SERVICE_CAPABILITY)
      if (svc && typeof svc.runAgent === "function" && typeof svc.runParallel === "function") {
        return svc
      }
    }

    // Fallback: search all capabilities for a dispatch-like service
    const capabilities = reg.getCapabilities()
    for (const [, registered] of capabilities) {
      if (registered.service === undefined) continue
      const svc = registered.service as Record<string, unknown>
      if (typeof svc.runAgent === "function" && typeof svc.runParallel === "function") {
        return svc as unknown as DispatchService
      }
    }

    return null
  } catch {
    return null
  }
}

/**
 * Run worktree dispatch using the provided dispatch service, then finalize.
 *
 * Reads execution-groups.md, calls prepareWorktreeImplementationRun(),
 * dispatches via dispatchService.runParallel({ worktree: true, ... }),
 * collects GroupResults, and calls finalizeWorktreeImplementationRun().
 */
async function runWorktreeDispatchAndFinalize(
  runId: string,
  changeId: string,
  planVersion: string,
  dispatchService: DispatchService,
  options?: {
    cwd?: string
    force?: boolean
    orchestratorTarget?: string
    onWorkflowUpdate?: (message: string) => void
    onSubagentUpdate?: (id: string, update: Partial<Omit<WorkflowSubagentSnapshot, "id" | "startedAt">>) => void
    onRateLimitNotice?: (message: string) => void
    sleep?: (ms: number) => Promise<void>
    progressPersistIntervalMs?: number
  },
): Promise<void> {
  const { default: fs } = await import("node:fs/promises")
  const { default: path } = await import("node:path")
  const { parseExecutionGroupsMd } = await import("./orchestration.js")
  const {
    prepareWorktreeImplementationRun,
    finalizeWorktreeImplementationRun,
  } = await import("./orchestration.js")
  const { captureGroupResult } = await import("./group-result.js")
  const {
    dispatchParallelWithRateLimitRetries,
    isRateLimitDispatchError,
  } = await import("./orchestration/implementation/rate-limit.js")
  const {
    persistImplementationDispatchSnapshot,
  } = await import("./orchestration/implementation/live-progress.js")
  const { readRun, updateRun } = await import("pi-zflow-artifacts")

  const cwd = options?.cwd ?? process.cwd()
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const execFileAsync = promisify(execFile)
  const { stdout: repoRootRaw } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd })
  const repoRoot = repoRootRaw.trim()
  const { resolveDispatchWorktreeSetup } = await import("./worktree-setup.js")
  const worktreeSetupResolution = await resolveDispatchWorktreeSetup(repoRoot)
  if (!worktreeSetupResolution.ok) {
    throw new Error(worktreeSetupResolution.message ?? "worktree setup requirements were not satisfied")
  }

  // Read execution groups from the approved plan artifact
  const executionGroupsArtifactPath = resolvePlanArtifactPath(changeId, planVersion, "execution-groups", cwd)
  let executionGroupsMd = ""
  try {
    executionGroupsMd = await fs.readFile(executionGroupsArtifactPath, "utf-8")
  } catch {
    throw new Error(
      `Cannot read execution-groups.md at: ${executionGroupsArtifactPath}\n` +
      "Run /zflow-change-prepare to create plan artifacts first.",
    )
  }

  const groups = parseExecutionGroupsMd(executionGroupsMd)
  const {
    normalizeImplementationAgentName,
    resolveImplementationAgentGuidance,
  } = await import("./orchestration/implementation-agents.js")
  const implementationAgentGuidance = await resolveImplementationAgentGuidance(cwd)
  const normalizedGroups = groups.map((group) => {
    const resolution = normalizeImplementationAgentName(group.agent, implementationAgentGuidance)
    if (resolution.reason === "role-label" || resolution.changed) {
      options?.onWorkflowUpdate?.(
        `Normalizing ${group.id} agent from ${group.agent} to ${resolution.resolved}` +
        `${resolution.roleLabel ? ` (role label: ${resolution.roleLabel})` : ""}.`,
      )
    }
    return {
      ...group,
      agent: resolution.resolved,
    }
  })

  if (normalizedGroups.length === 0) {
    const preview = executionGroupsMd.slice(0, 500).trim()
    const previewHint = preview.length > 0
      ? `\n\nFile content preview (first 500 chars):\n\`\`\`markdown\n${preview}${executionGroupsMd.length > 500 ? "\n…(truncated)" : ""}\n\`\`\``
      : "\n\n(File is empty)"
    const formatHint =
      `\n\nExpected format — each group must start with a heading like:\n` +
      `  ## Group 1: descriptive name\n` +
      `  ## G1 — descriptive name\n` +
      `  ## Execution Group 1: descriptive name\n\n` +
      `Followed by:\n` +
      `  **Files:** path/to/file.ts, another/file.ts\n` +
      `  **Agent:** ${implementationAgentGuidance.defaultAgent}\n` +
      `  **Scoped verification:** the verification command for this group`
    throw new Error(
      `No execution groups found in ${executionGroupsArtifactPath}. ` +
      "The approved plan must contain at least one implementation group." +
      previewHint +
      formatHint,
    )
  }

  const missingScopedVerification = normalizedGroups.filter((g) => !g.scopedVerification)
  if (missingScopedVerification.length > 0) {
    throw new Error(
      "Cannot dispatch implementation: every execution group must define scoped verification. " +
      `Missing: ${missingScopedVerification.map((g) => g.id).join(", ")}`,
    )
  }

  // Prepare the worktree implementation run — this runs clean-tree preflight,
  // ownership/dependency validation, and builds task descriptors.
  const planArtifactPaths = {
    design: resolvePlanArtifactPath(changeId, planVersion, "design", cwd),
    executionGroups: executionGroupsArtifactPath,
    standards: resolvePlanArtifactPath(changeId, planVersion, "standards", cwd),
    verification: resolvePlanArtifactPath(changeId, planVersion, "verification", cwd),
  }

  const runPlan = await prepareWorktreeImplementationRun(
    changeId,
    planVersion,
    normalizedGroups,
    planArtifactPaths,
    {
      cwd,
      repoRoot,
      runId,
      force: options?.force,
      orchestratorTarget: options?.orchestratorTarget,
    },
  )

  // ── Initialize durable group status ledger ────────────────────
  const runBefore = await readRun(runId, cwd)
  const existingLedger = runBefore?.metadata?.[GROUP_LEDGER_META_KEY] as Record<string, GroupStatusEntry> | undefined
  const ledger = buildGroupLedger(normalizedGroups, existingLedger)
  await updateRun(runId, {
    metadata: {
      ...(runBefore?.metadata ?? {}),
      [GROUP_LEDGER_META_KEY]: ledger,
    },
  } as any, cwd)

  // ── Build dependency graph for wave dispatch ────────────────
  // Groups are dispatched in waves: only groups whose dependencies
  // have all succeeded are eligible for the current wave. Failed groups
  // cause dependents to be marked "blocked" rather than running.
  const depGraph = new Map<string, string[]>()
  const reverseDepGraph = new Map<string, string[]>()
  const allGroupIds: string[] = []

  for (const group of runPlan.groups) {
    allGroupIds.push(group.id)
    depGraph.set(group.id, group.dependencies.filter(d => d !== "none" && d !== ""))
    // Build reverse deps
    for (const dep of group.dependencies) {
      if (dep === "none" || dep === "") continue
      if (!reverseDepGraph.has(dep)) reverseDepGraph.set(dep, [])
      reverseDepGraph.get(dep)!.push(group.id)
    }
  }

  /**
   * Walk the reverse dependency graph to find all groups transitively
   * blocked by a failed group, and mark them as blocked in the ledger.
   */
  const markDependentsBlocked = async (failedGroupId: string): Promise<void> => {
    const visited = new Set<string>()
    const queue = [failedGroupId]
    while (queue.length > 0) {
      const current = queue.shift()!
      const dependents = reverseDepGraph.get(current)
      if (!dependents) continue
      for (const depId of dependents) {
        if (visited.has(depId)) continue
        visited.add(depId)
        // Only block groups that haven't already succeeded or started
        const existing = (await readRun(runId, cwd).catch(() => null))
          ?.metadata?.[GROUP_LEDGER_META_KEY] as Record<string, GroupStatusEntry> | undefined
        const currentStatus = existing?.[depId]?.status
        if (currentStatus === "succeeded" || currentStatus === "applied" || currentStatus === "running") continue
        await updateGroupLedger(runId, depId, {
          status: "blocked",
          blockedBy: [...(existing?.[depId]?.blockedBy ?? []), failedGroupId],
          failureKind: "blocker",
        }, cwd).catch(() => {})
        options?.onSubagentUpdate?.(depId, {
          status: "blocked",
          lastCommand: `blocked by ${failedGroupId}`,
        })
        queue.push(depId)
      }
    }
  }

  /**
   * Get group IDs that are ready for dispatch in the current wave.
   * Ready = status is "ready" or explicitly moved to ready state,
   * and all their dependencies have status "succeeded" or "applied".
   */
  const getReadyGroupIds = async (): Promise<string[]> => {
    const run = await readRun(runId, cwd).catch(() => null)
    if (!run) return []
    const ledger = (run.metadata?.[GROUP_LEDGER_META_KEY] ?? {}) as Record<string, GroupStatusEntry>
    return allGroupIds.filter(gid => {
      const entry = ledger[gid]
      if (!entry) return false
      // Already processed or blocked
      if (entry.status === "succeeded" || entry.status === "applied" ||
          entry.status === "running" || entry.status === "failed" ||
          entry.status === "blocked" || entry.status === "skipped") return false
      // Check dependencies
      const deps = depGraph.get(gid)
      if (!deps || deps.length === 0) return true
      return deps.every(d => {
        const depEntry = ledger[d]
        return depEntry?.status === "succeeded" || depEntry?.status === "applied"
      })
    })
  }

  // Dispatch via the dispatch service with worktree: true. Keep worker output
  // under runtime state so repo roots are not polluted with worktree-results/.
  const runDir = resolveRunDir(runId, cwd)
  const worktreeResultsDir = path.join(runDir, "worktree-results")
  await fs.mkdir(worktreeResultsDir, { recursive: true })
  const readExistingWorkerEvidence = async (groupId: string): Promise<{ path?: string; content?: string }> => {
    const candidates = [
      path.join(worktreeResultsDir, `${groupId}-result.md`),
      path.join(worktreeResultsDir, `${groupId}-resume-result.md`),
    ]
    for (const candidate of candidates) {
      try {
        const content = await fs.readFile(candidate, "utf-8")
        if (content.trim()) return { path: candidate, content }
      } catch {
        // Ignore missing historical worker outputs.
      }
    }
    return {}
  }
  const implementModel = await resolveWorkflowModel("zflow.implement-routine")
  const sleep = options?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const progressPersistIntervalMs = Math.max(1000, options?.progressPersistIntervalMs ?? 5000)
  const dispatchStartedAt = new Date().toISOString()
  const pendingGroupProgress = new Map<string, Record<string, unknown>>()
  let pendingDispatchProgress: Record<string, unknown> = {
    dispatchStartedAt,
    totalGroups: allGroupIds.length,
    completedGroups: 0,
    status: "running",
  }
  let liveProgressDirty = false
  let lastLiveProgressFlushAt = 0
  let liveProgressFlushPromise: Promise<void> = Promise.resolve()

  const markGroupProgress = (groupId: string, partial: Record<string, unknown>): void => {
    pendingGroupProgress.set(groupId, {
      ...(pendingGroupProgress.get(groupId) ?? {}),
      ...partial,
    })
    liveProgressDirty = true
  }

  const markDispatchProgress = (partial: Record<string, unknown>): void => {
    pendingDispatchProgress = {
      ...pendingDispatchProgress,
      ...partial,
    }
    liveProgressDirty = true
  }

  const flushLiveProgress = async (force = false): Promise<void> => {
    if (!liveProgressDirty) return liveProgressFlushPromise
    const now = Date.now()
    if (!force && now - lastLiveProgressFlushAt < progressPersistIntervalMs) {
      return liveProgressFlushPromise
    }
    lastLiveProgressFlushAt = now

    const groupUpdates = Object.fromEntries(pendingGroupProgress.entries())
    pendingGroupProgress.clear()
    const dispatchProgress = { ...pendingDispatchProgress }
    liveProgressDirty = false

    liveProgressFlushPromise = liveProgressFlushPromise
      .then(() => persistImplementationDispatchSnapshot(runId, {
        groupUpdates,
        dispatchProgress,
      }, cwd))
      .catch(() => {})

    return liveProgressFlushPromise
  }

  const emitWorkflowUpdate = (message: string, partial: Record<string, unknown> = {}): void => {
    options?.onWorkflowUpdate?.(message)
    markDispatchProgress({
      lastWorkflowUpdate: message,
      ...partial,
    })
    void flushLiveProgress()
  }

  // Auto-detect worktree setup command (pnpm install, npm ci, etc.)
  const { detectWorktreeSetupCommand } = await import("./orchestration.js")

  // Build the full tasks array once. Each wave will select a subset by index.
  const tasks = await Promise.all(runPlan.tasks.map(async (t, taskIdx) => {
    const taskRepoRoot = inferTaskRepoRoot(repoRoot, { claimedFiles: t.claimedFiles })
    const worktreeSetupCommand = await detectWorktreeSetupCommand(taskRepoRoot)

    return {
      agent: t.agent,
      groupId: t.groupId,
      task: t.task,
      cwd: taskRepoRoot,
      model: implementModel.dispatchModel,
      output: path.join(worktreeResultsDir, `${t.groupId}-result.md`),
      outputMode: "file-only" as const,
      scopedVerification: t.scopedVerification,
      worktreeSetupCommand,
      claimedFiles: t.claimedFiles,
      dependencies: t.dependencies,
      worktreeStrategy: t.worktreeStrategy,
      onUpdate: (progress: AgentDispatchProgress) => {
      const recentTools = Array.isArray(progress.recentTools) ? progress.recentTools : []
      const recentTool = recentTools[recentTools.length - 1]
      const recentOutput = Array.isArray(progress.recentOutput) ? progress.recentOutput : []
      const lastCommand = progress.currentTool
        ? `${progress.currentTool}${progress.currentToolArgs ? ` ${progress.currentToolArgs}` : ""}`
        : recentTool?.tool
          ? `${recentTool.tool}${recentTool.args ? ` ${recentTool.args}` : ""}`
          : recentOutput[recentOutput.length - 1] ?? "running"
      options?.onSubagentUpdate?.(t.groupId, {
        agent: t.agent,
        title: runPlan.groups[taskIdx]?.taskPrompt ?? undefined,
        model: implementModel.model ?? "unavailable",
        thinking: implementModel.thinking ?? "unavailable",
        status: progress.status ?? "running",
        lastCommand,
      })
      markGroupProgress(t.groupId, {
        status: progress.status ?? "running",
        agent: t.agent,
        taskPrompt: runPlan.groups[taskIdx]?.taskPrompt ?? "",
        model: implementModel.model ?? "unavailable",
        thinking: implementModel.thinking ?? "unavailable",
        currentTool: progress.currentTool,
        lastCommand,
        lastProgressAt: new Date().toISOString(),
      })
      void flushLiveProgress()
    },
    }
  }))

  // Map groupId → task index for fast lookup
  const groupIdToTaskIndex = new Map<string, number>()
  for (let i = 0; i < runPlan.tasks.length; i++) {
    groupIdToTaskIndex.set(runPlan.tasks[i]!.groupId, i)
  }

  const WORKTREE_DISPATCH_CONCURRENCY = resolveImplementConcurrency()
  const MAX_OUTPUT_LINES = 5000
  const MAX_OUTPUT_BYTES = 500_000

  // Leave groups in queued/pending state until their dependencies are
  // satisfied and they are actually selected for a dispatch wave. This keeps
  // partial-run metadata honest so resume analysis does not mistake downstream
  // untouched groups for directly rerunnable work.

  // ── Wave dispatch loop ──────────────────────────────────────
  // Dispatch groups in dependency-order waves. Each wave runs the
  // eligible groups in parallel (subject to concurrency limit).
  const allResults: Array<{ groupId: string; result: DispatchGroupResult; index: number }> = []
  const decisions: FailedGroupDecision[] = []
  let waveIndex = 0
  const dispatchStartTime = Date.now()
  let waveHeartbeat: ReturnType<typeof setInterval> | undefined

  while (true) {
    const readyGroupIds = await getReadyGroupIds()
    if (readyGroupIds.length === 0) break

    waveIndex++
    emitWorkflowUpdate(`Wave ${waveIndex}: dispatching ${readyGroupIds.length} group(s) (${waveIndex === 1 ? "initial" : "dependency"} wave)`, {
      activeWave: waveIndex,
      dispatchedGroups: readyGroupIds,
      completedGroups: allResults.length,
      elapsedSeconds: Math.round((Date.now() - Date.parse(dispatchStartedAt)) / 1000),
    })

    // Build task subset for this wave
    const waveTaskIndices = readyGroupIds.map(gid => {
      const idx = groupIdToTaskIndex.get(gid)
      if (idx === undefined) throw new Error(`Group ${gid} not found in task list`)
      return idx
    })
    const waveTasks = await Promise.all(waveTaskIndices.map(async (idx) => {
      const baseTask = tasks[idx]!
      const planGroup = runPlan.groups[idx] as unknown as {
        id: string
        files: string[]
        dependencies: string[]
        parallelizable: boolean
        baseStrategy?: "head" | "dependency-lineage"
      }
      if (baseTask.worktreeStrategy?.baseStrategy !== "dependency-lineage") {
        return baseTask
      }

      const lineage = await materializeDependencyLineageRef(
        runId,
        repoRoot,
        planGroup,
        runPlan.groups as Array<{ id: string; files: string[]; dependencies: string[]; parallelizable: boolean }>,
        cwd,
      )
      if (!lineage) return baseTask

      return {
        ...baseTask,
        worktreeStrategy: {
          ...baseTask.worktreeStrategy,
          baseStrategy: "dependency-lineage",
          baseRef: lineage.ref,
        },
      }
    }))

    // Mark wave groups as running
    for (const gid of readyGroupIds) {
      const idx = groupIdToTaskIndex.get(gid)!
      const task = runPlan.tasks[idx]!
      options?.onSubagentUpdate?.(gid, {
        agent: task.agent,
        title: runPlan.groups[idx]?.taskPrompt ?? undefined,
        model: implementModel.model ?? "unavailable",
        thinking: implementModel.thinking ?? "unavailable",
        status: "running",
        lastCommand: "starting worktree dispatch...",
      })
      await updateGroupLedger(runId, gid, {
        status: "running",
        agent: task.agent,
        model: implementModel.model ?? "unavailable",
        thinking: implementModel.thinking ?? "unavailable",
        startedAt: new Date().toISOString(),
        lastCommand: "starting worktree dispatch...",
        error: undefined,
        failureKind: undefined,
      }, cwd).catch(() => {})
      markGroupProgress(gid, {
        status: "running",
        agent: task.agent,
        taskPrompt: runPlan.groups[idx]?.taskPrompt ?? "",
        model: implementModel.model ?? "unavailable",
        thinking: implementModel.thinking ?? "unavailable",
        startedAt: new Date().toISOString(),
        lastCommand: "starting worktree dispatch...",
        lastProgressAt: new Date().toISOString(),
      })
    }

    await flushLiveProgress(true)

    // Dispatch this wave
    const dispatchStartMs = Date.now()
    let dispatchResult: Awaited<ReturnType<DispatchService["runParallel"]>>

    // Heartbeat for this wave
    let waveHeartbeatCount = 0
    waveHeartbeat = setInterval(() => {
      waveHeartbeatCount++
      const elapsed = Math.round((Date.now() - dispatchStartTime) / 1000)
      const ready = readyGroupIds.length
      const done = allResults.length
      const total = allGroupIds.length
      emitWorkflowUpdate(
        `Wave ${waveIndex}: ${ready} group(s) dispatched, ${done}/${total} complete, ${waveHeartbeatCount} heartbeat(s), ${elapsed}s elapsed`,
        {
          activeWave: waveIndex,
          heartbeatCount: waveHeartbeatCount,
          dispatchedGroups: readyGroupIds,
          completedGroups: done,
          elapsedSeconds: elapsed,
          status: "running",
        },
      )
    }, 10000)
    waveHeartbeat.unref?.()

    try {
      dispatchResult = await dispatchParallelWithRateLimitRetries({
        dispatchService,
        maxRetries: IMPLEMENT_RATE_LIMIT_MAX_RETRIES,
        defaultWaitMs: IMPLEMENT_RATE_LIMIT_DEFAULT_WAIT_MS,
        input: {
          tasks: waveTasks,
          cwd,
          concurrency: Math.min(WORKTREE_DISPATCH_CONCURRENCY, waveTasks.length),
          worktree: true,
          worktreeSetupHook: worktreeSetupResolution.hook,
          maxOutput: { lines: MAX_OUTPUT_LINES, bytes: MAX_OUTPUT_BYTES },
        },
        sleep,
        onRateLimitNotice: async (notice) => {
          const retryMessage = `${notice.message} ${notice.error ?? ""}`.trim()
          emitWorkflowUpdate(retryMessage, {
            status: "retrying",
            activeWave: waveIndex,
            heartbeatCount: waveHeartbeatCount,
            dispatchedGroups: readyGroupIds,
            completedGroups: allResults.length,
            elapsedSeconds: Math.round((Date.now() - Date.parse(dispatchStartedAt)) / 1000),
          })
          options?.onRateLimitNotice?.(retryMessage)
          options?.onSubagentUpdate?.(notice.groupId, {
            agent: notice.task.agent,
            title: runPlan.groups[groupIdToTaskIndex.get(notice.groupId) ?? 0]?.taskPrompt ?? undefined,
            model: implementModel.model ?? "unavailable",
            thinking: implementModel.thinking ?? "unavailable",
            status: "running",
            lastCommand: retryMessage,
          })
          markGroupProgress(notice.groupId, {
            status: "retrying",
            agent: notice.task.agent,
            model: implementModel.model ?? "unavailable",
            thinking: implementModel.thinking ?? "unavailable",
            lastCommand: retryMessage,
            lastProgressAt: new Date().toISOString(),
            retryCount: notice.attempt,
            rateLimitRetryCount: notice.attempt,
            failureKind: "retryable",
          })
          await flushLiveProgress(true)
        },
      })
    } finally {
      clearInterval(waveHeartbeat)
      waveHeartbeat = undefined
      await flushLiveProgress(true)
    }

    // Process wave results
    const waveElapsed = Math.round((Date.now() - dispatchStartMs) / 1000)
    emitWorkflowUpdate(`Wave ${waveIndex} completed in ${waveElapsed}s: ${dispatchResult.results.filter(r => r.ok).length} succeeded, ${dispatchResult.results.filter(r => !r.ok).length} failed`, {
      activeWave: waveIndex,
      completedGroups: allResults.length,
      elapsedSeconds: Math.round((Date.now() - Date.parse(dispatchStartedAt)) / 1000),
    })

    for (let i = 0; i < dispatchResult.results.length; i++) {
      const r = dispatchResult.results[i]!
      const gid = readyGroupIds[i]
      const idx = waveTaskIndices[i]
      const group = runPlan.groups[idx]
      if (!gid || idx === undefined) continue

      const verification = normalizeDispatchVerification(r.verification)
      const existingEvidence = await readExistingWorkerEvidence(gid)
      const rawOutput = (!r.rawOutput || !r.rawOutput.trim()) && r.outputPath
        ? await fs.readFile(r.outputPath, "utf-8").catch(() => r.rawOutput)
        : (r.rawOutput?.trim() ? r.rawOutput : existingEvidence.content)
      const acceptedNoop = acceptImplementationNoopResult({
        ok: r.ok,
        error: r.error,
        rawOutput,
        verification,
      })
      const acceptedExistingEvidence = acceptAlreadyImplementedEvidenceResult({
        ok: r.ok,
        error: r.error,
        rawOutput,
        verification,
      })
      const acceptedResult = acceptedNoop.accepted ? acceptedNoop : acceptedExistingEvidence
      const effectiveVerification = acceptedResult.accepted && verification?.status === "fail"
        ? {
            ...verification,
            status: "pass" as const,
            output: verification.output ?? acceptedResult.reason,
          }
        : verification
      const resultForWorkflow = acceptedResult.accepted
        ? {
            ...r,
            ok: true,
            error: undefined,
            patchPath: undefined,
            worktreePath: undefined,
            changedFiles: group?.files ?? r.changedFiles,
            verification: effectiveVerification,
          }
        : r
      const dispatchFailed = !resultForWorkflow.ok || (effectiveVerification?.status === "fail" && !acceptedResult.accepted)
      const rateLimitRetryCount = dispatchResult.retryCounts?.[gid] ?? 0
      allResults.push({ groupId: gid, result: resultForWorkflow, index: idx })

      if (!dispatchFailed) {
        const successMessage = acceptedResult.accepted
          ? (acceptedResult.reason ?? "implementation already present; verification passed")
          : effectiveVerification?.status === "pass"
            ? "agent complete; scoped verification passed"
            : "agent complete; scoped verification deferred to final verification"
        options?.onSubagentUpdate?.(gid, {
          agent: resultForWorkflow.agent ?? tasks[idx]?.agent,
          title: group?.taskPrompt ?? undefined,
          status: "completed",
          finishedAt: Date.now(),
          lastCommand: successMessage,
        })
        await updateGroupLedger(runId, gid, {
          status: acceptedResult.accepted ? "applied" : "succeeded",
          appliedToPrimary: acceptedResult.accepted ? true : undefined,
          agent: resultForWorkflow.agent ?? "zflow.implement-routine",
          error: undefined,
          failureKind: undefined,
          patchPath: acceptedResult.accepted ? undefined : resultForWorkflow.patchPath,
          implementationEvidencePath: acceptedResult.accepted ? (r.outputPath ?? existingEvidence.path) : undefined,
          completionMode: acceptedResult.accepted ? (acceptedNoop.accepted ? "noop-evidence" : "worker-evidence") : (resultForWorkflow.patchPath ? "patch" : undefined),
          changedFiles: resultForWorkflow.changedFiles ?? group?.files,
          scopedVerification: effectiveVerification,
          retryCount: rateLimitRetryCount,
          rateLimitRetryCount,
          lastCommand: successMessage,
          lastProgressAt: new Date().toISOString(),
        }, cwd).catch(() => {})
        continue
      }

      const currentFixAttempts = (await readRun(runId, cwd).catch(() => null))
        ?.metadata?.[GROUP_LEDGER_META_KEY]?.[gid]?.fixAttempts ?? 0

      const fixShouldRun = currentFixAttempts < MAX_FIX_ATTEMPTS_PER_GROUP &&
        group && group.files && group.files.length > 0

      if (fixShouldRun) {
        emitWorkflowUpdate(`Attempting fix for ${gid} (attempt ${currentFixAttempts + 1}/${MAX_FIX_ATTEMPTS_PER_GROUP})`)
        await updateGroupLedger(runId, gid, {
          status: "retrying",
          fixAttempts: currentFixAttempts + 1,
        }, cwd).catch(() => {})

        const fixResult = await attemptGroupFix(
          gid,
          group?.taskPrompt ?? "",
          group?.files ?? [],
          r.agent ?? "zflow.implement-routine",
          verification ? { ...r, verification } : r,
          dispatchService,
          {
            runId,
            cwd,
            repoRoot,
            changeId,
            planVersion,
            worktreeResultsDir,
            worktreeSetupHook: worktreeSetupResolution.hook,
            onSubagentUpdate: options?.onSubagentUpdate,
            onWorkflowUpdate: options?.onWorkflowUpdate,
            implementModel,
          },
        )

        if (fixResult.fixed) {
          const mergedResult = mergeSuccessfulFixResult(r, fixResult.dispatchResult)
          const mergedVerification = normalizeDispatchVerification(mergedResult.verification)
          const resultEntry = allResults.find((entry) => entry.groupId === gid)
          if (resultEntry) {
            resultEntry.result = mergedResult
          }
          options?.onSubagentUpdate?.(gid, {
            agent: mergedResult.agent ?? tasks[idx]?.agent,
            title: `fix: ${gid} (attempt ${currentFixAttempts + 1})`,
            status: "completed",
            finishedAt: Date.now(),
            lastCommand: `fix succeeded${fixResult.fixPatchPath ? `; fix patch: ${fixResult.fixPatchPath}` : ""}`,
          })
          await updateGroupLedger(runId, gid, {
            status: "succeeded",
            agent: mergedResult.agent ?? "zflow.implement-routine",
            error: undefined,
            failureKind: undefined,
            patchPath: fixResult.fixPatchPath ?? mergedResult.patchPath,
            changedFiles: mergedResult.changedFiles ?? group?.files,
            scopedVerification: mergedVerification
              ? {
                  ...mergedVerification,
                  outputPath: fixResult.verificationOutputPath,
                }
              : undefined,
            fixResult: "succeeded",
            fixClassification: fixResult.fixClassification,
            fixPatchPath: fixResult.fixPatchPath,
          }, cwd).catch(() => {})
          continue
        }

        emitWorkflowUpdate(`Fix attempt ${currentFixAttempts + 1} for ${gid} failed: ${fixResult.error ?? "unknown fix failure"}`)
      }

      const failureReason = verification?.status === "fail"
        ? `${gid}: scoped verification failed`
        : r.error ?? "Group dispatch failed"
      const failureKind = isRateLimitDispatchError(failureReason) ? "retryable" : "blocker"
      decisions.push({
        groupId: gid,
        agent: r.agent ?? "zflow.implement-routine",
        attempt: currentFixAttempts,
        decision: "blocker",
        reason: failureReason,
        error: failureReason,
      })
      options?.onSubagentUpdate?.(tasks[idx]?.groupId ?? gid, {
        agent: r.agent ?? tasks[idx]?.agent,
        title: group?.taskPrompt ?? undefined,
        status: "failed",
        finishedAt: Date.now(),
        lastCommand: failureReason,
      })
      await updateGroupLedger(runId, gid, {
        status: "failed",
        error: failureReason,
        failureKind,
        scopedVerification: verification,
        fixAttempts: currentFixAttempts,
        fixResult: fixShouldRun ? "failed" : undefined,
        retryCount: rateLimitRetryCount,
        rateLimitRetryCount,
        lastCommand: failureReason,
        lastProgressAt: new Date().toISOString(),
      }, cwd).catch(() => {})
      await markDependentsBlocked(gid)
    }
  }

  emitWorkflowUpdate(`All waves complete. ${allResults.filter(r => r.result.ok).length}/${allGroupIds.length} groups succeeded. Checking for blockers...`, {
    activeWave: waveIndex,
    completedGroups: allResults.filter((entry) => entry.result.ok).length,
    elapsedSeconds: Math.round((Date.now() - Date.parse(dispatchStartedAt)) / 1000),
  })

  // ── Check for blocked/failed groups after all waves ─────────
  const finalRun = await readRun(runId, cwd).catch(() => null)
  const finalLedger = (finalRun?.metadata?.[GROUP_LEDGER_META_KEY] ?? {}) as Record<string, GroupStatusEntry>
  const finalBlocked = Object.values(finalLedger).filter(e => e.status === "blocked")
  const finalFailed = Object.values(finalLedger).filter(e => e.status === "failed")

  // ── Store verification output files for all groups ──────────
  for (const entry of allResults) {
    if (entry.result.verification?.output) {
      const verPath = path.join(worktreeResultsDir, `${entry.groupId}-verification.txt`)
      try {
        await fs.writeFile(verPath, entry.result.verification.output, "utf-8")
      } catch {
        // Best-effort
      }
    }
  }

  // If there are blockers, write failure report and throw
  if (finalFailed.length > 0 || finalBlocked.length > 0) {
    markDispatchProgress({
      status: "failed",
      completedGroups: allResults.filter((entry) => entry.result.ok).length,
      elapsedSeconds: Math.round((Date.now() - Date.parse(dispatchStartedAt)) / 1000),
    })
    await flushLiveProgress(true)
    const reportPath = path.join(worktreeResultsDir, "failure-report.json")
    await fs.writeFile(reportPath, JSON.stringify({
      decisions,
      allResults: allResults.map(r => ({
        agent: r.result.agent,
        ok: r.result.ok,
        error: r.result.error,
        verificationCommand: r.result.verification?.command,
        verificationOutputPath: r.result.verification?.output
          ? path.join(worktreeResultsDir, `${r.groupId}-verification.txt`)
          : undefined,
        verificationExitCode: r.result.verification?.status === "fail" ? 1 : r.result.verification?.status === "pass" ? 0 : undefined,
      })),
      blockedGroups: finalBlocked.map(g => ({ groupId: g.groupId, blockedBy: g.blockedBy })),
    }, null, 2))

    const summaryPath = await writeGroupStatusSummary(runId, changeId, cwd).catch(() => reportPath)
    await updateRun(runId, {
      phase: "partial",
      metadata: {
        ...(finalRun?.metadata ?? {}),
        partialRunNote: `${finalFailed.length} group(s) failed, ${finalBlocked.length} group(s) blocked. Successful groups preserved.`,
        groupStatusSummaryPath: summaryPath,
      },
    } as any, cwd)

    const errorParts: string[] = []
    if (finalFailed.length > 0) {
      errorParts.push(`${finalFailed.length} group(s) failed: ${finalFailed.map(g => `${g.groupId}: ${g.error ?? "unknown"}`).join("; ")}`)
    }
    if (finalBlocked.length > 0) {
      errorParts.push(`${finalBlocked.length} group(s) blocked by failed dependencies: ${finalBlocked.map(g => `${g.groupId} (blocked by ${g.blockedBy?.join(", ") ?? "unknown"})`).join("; ")}`)
    }

    await recordDispatchFailurePolicy(runId, cwd, decisions, reportPath, "partial")
    throw new Error(
      `Implementation dispatch failed:\n` +
      errorParts.join("\n") +
      `\nFailure report: ${reportPath}` +
      `\nGroup status summary: ${summaryPath}`,
    )
  }

  // ── All groups succeeded — collect worktree results ────────
  emitWorkflowUpdate("All subagents finished; collecting worker results. Scoped verification is deferred to the final verification phase.", {
    status: "running",
  })

  // Collect group results from dispatch outputs
  const groupResults = []
  const postDispatchFailures: string[] = []
  const patchesDir = path.join(runDir, "patches")
  await fs.mkdir(patchesDir, { recursive: true })

  for (const entry of allResults) {
    const { result: r, index: idx, groupId } = entry
    const group = runPlan.groups.find(g => g.id === groupId)
    if (!group) continue

    if (!r.ok) {
      continue
    }

    let resultToCapture = r
    let verification = normalizeDispatchVerification(resultToCapture.verification)

    // If the bridge explicitly reported failed scoped verification, attempt fix loop.
    // Missing verification (bridge no longer runs it) = deferred to final verification, not a blocker.
    if (verification && verification.status === "fail") {
      const currentFixAttempts = (await readRun(runId, cwd).catch(() => null))
        ?.metadata?.[GROUP_LEDGER_META_KEY]?.[group.id]?.fixAttempts ?? 0

      const fixShouldRun = currentFixAttempts < MAX_FIX_ATTEMPTS_PER_GROUP
      if (fixShouldRun) {
        emitWorkflowUpdate(`Attempting fix for ${group.id} (attempt ${currentFixAttempts + 1}/${MAX_FIX_ATTEMPTS_PER_GROUP})`)
        await updateGroupLedger(runId, group.id, {
          status: "retrying",
          fixAttempts: currentFixAttempts + 1,
        }, cwd).catch(() => {})

        const fixResult = await attemptGroupFix(
          group.id,
          group?.taskPrompt ?? "",
          group?.files ?? [],
          resultToCapture.agent ?? "zflow.implement-routine",
          resultToCapture,
          dispatchService,
          {
            runId,
            cwd,
            repoRoot,
            changeId,
            planVersion,
            worktreeResultsDir,
            worktreeSetupHook: worktreeSetupResolution.hook,
            onSubagentUpdate: options?.onSubagentUpdate,
            onWorkflowUpdate: options?.onWorkflowUpdate,
            implementModel,
          },
        )

        if (fixResult.fixed) {
          resultToCapture = mergeSuccessfulFixResult(resultToCapture, fixResult.dispatchResult)
          verification = normalizeDispatchVerification(resultToCapture.verification)
          options?.onSubagentUpdate?.(group.id, {
            agent: resultToCapture.agent ?? tasks[idx]?.agent,
            title: `fix: ${group.id} (attempt ${currentFixAttempts + 1})`,
            status: "completed",
            finishedAt: Date.now(),
            lastCommand: "fix succeeded via post-dispatch fix",
          })
          await updateGroupLedger(runId, group.id, {
            status: "succeeded",
            agent: resultToCapture.agent ?? "zflow.implement-routine",
            error: undefined,
            failureKind: undefined,
            patchPath: fixResult.fixPatchPath ?? resultToCapture.patchPath,
            changedFiles: resultToCapture.changedFiles ?? group.files,
            scopedVerification: verification
              ? {
                  ...verification,
                  outputPath: fixResult.verificationOutputPath,
                }
              : undefined,
            fixResult: "succeeded",
            fixClassification: fixResult.fixClassification,
            fixPatchPath: fixResult.fixPatchPath,
          }, cwd).catch(() => {})
        } else {
          emitWorkflowUpdate(`Fix attempt ${currentFixAttempts + 1} for ${group.id} failed: ${fixResult.error ?? "unknown"}`)
        }
      }

      if (verification?.status === "fail") {
        const failure = `${group.id}: scoped verification failed`
        postDispatchFailures.push(failure)
        options?.onSubagentUpdate?.(group.id, {
          status: "failed",
          finishedAt: Date.now(),
          lastCommand: failure,
        })
        await updateGroupLedger(runId, group.id, {
          status: "failed",
          error: failure,
          failureKind: "blocker",
          scopedVerification: verification,
          fixAttempts: currentFixAttempts,
          fixResult: currentFixAttempts > 0 ? "failed" : undefined,
        }, cwd).catch(() => {})
        continue
      }
    }

    const scopedVerification = verification ?? {
      status: "skipped" as const,
      command: undefined,
      output: "Scoped verification deferred to the final verification phase.",
    }

    if (resultToCapture.worktreePath) {
      groupResults.push(await captureGroupResult({
        groupId: group.id,
        agent: tasks[idx]?.agent ?? group.agent ?? "unknown",
        worktreePath: resultToCapture.worktreePath,
        runId,
        repoRoot,
        baseCommit: resultToCapture.baseCommit,
        headCommit: resultToCapture.headCommit,
        scopedFiles: group.files,
        verification: scopedVerification,
        cwd,
      }))
      await updateGroupLedger(runId, group.id, {
        worktreePath: resultToCapture.worktreePath,
        changedFiles: resultToCapture.changedFiles ?? group.files,
        scopedVerification,
      }, cwd).catch(() => {})
      continue
    }

    if (resultToCapture.verification?.output) {
      const verPath = path.join(worktreeResultsDir, `${group.id}-verification.txt`)
      await fs.writeFile(verPath, resultToCapture.verification.output, "utf-8").catch(() => {})
      scopedVerification.outputPath = verPath
    }

    if (resultToCapture.patchPath) {
      const destPatchPath = path.join(patchesDir, `${group.id}.patch`)
      if (path.resolve(resultToCapture.patchPath) !== path.resolve(destPatchPath)) {
        await fs.copyFile(resultToCapture.patchPath, destPatchPath)
      }

      const run = await readRun(runId, cwd)
      const groupMeta = {
        groupId: group.id,
        agent: tasks[idx]?.agent ?? group.agent ?? "unknown",
        worktreePath: resultToCapture.worktreePath ?? "(provided patch)",
        baseCommit: resultToCapture.baseCommit ?? run.head,
        headCommit: resultToCapture.headCommit ?? run.head,
        changedFiles: resultToCapture.changedFiles ?? group.files,
        uncommittedChanges: [],
        patchPath: destPatchPath,
        scopedVerification: {
          status: scopedVerification.status,
          command: scopedVerification.command,
          output: scopedVerification.output,
          outputPath: scopedVerification.outputPath,
        },
        retained: false,
      }
      const existingIndex = run.groups.findIndex((g) => g.groupId === group.id)
      if (existingIndex >= 0) run.groups[existingIndex] = groupMeta
      else run.groups.push(groupMeta)
      await updateRun(runId, { groups: run.groups }, cwd)
      groupResults.push({
        groupId: group.id,
        agent: groupMeta.agent,
        worktreePath: groupMeta.worktreePath,
        baseCommit: groupMeta.baseCommit,
        headCommit: groupMeta.headCommit,
        changedFiles: groupMeta.changedFiles,
        uncommittedChanges: [],
        patchPath: destPatchPath,
        verification: scopedVerification,
        retained: false,
      })
      await updateGroupLedger(runId, group.id, {
        patchPath: destPatchPath,
        changedFiles: resultToCapture.changedFiles ?? group.files,
        scopedVerification,
      }, cwd).catch(() => {})
      continue
    }

    const run = await readRun(runId, cwd)
    const groupMeta = {
      groupId: group.id,
      agent: tasks[idx]?.agent ?? group.agent ?? "unknown",
      worktreePath: "(in-place — no worktree isolation)",
      baseCommit: resultToCapture.baseCommit ?? run.head,
      headCommit: resultToCapture.headCommit ?? run.head,
      changedFiles: resultToCapture.changedFiles ?? group.files,
      uncommittedChanges: [],
      patchPath: undefined as string | undefined,
      scopedVerification: {
        status: scopedVerification.status,
        command: scopedVerification.command,
        output: scopedVerification.output,
        outputPath: scopedVerification.outputPath,
      },
      retained: false,
    }
    const existingIndex = run.groups.findIndex((g) => g.groupId === group.id)
    if (existingIndex >= 0) run.groups[existingIndex] = groupMeta
    else run.groups.push(groupMeta)
    await updateRun(runId, { groups: run.groups }, cwd)
    await updateGroupLedger(runId, group.id, {
      changedFiles: resultToCapture.changedFiles ?? group.files,
      scopedVerification,
    }, cwd).catch(() => {})
    groupResults.push({
      groupId: group.id,
      agent: groupMeta.agent,
      worktreePath: groupMeta.worktreePath,
      baseCommit: groupMeta.baseCommit,
      headCommit: groupMeta.headCommit,
      changedFiles: groupMeta.changedFiles,
      uncommittedChanges: [],
      patchPath: undefined,
      verification: scopedVerification,
      retained: false,
    })
  }

  if (postDispatchFailures.length > 0) {
    const reportPath = path.join(worktreeResultsDir, "post-dispatch-failure-report.json")
    await fs.writeFile(reportPath, JSON.stringify({ failures: postDispatchFailures }, null, 2), "utf-8")
    // Write group-status-summary and update phase to partial
    const summaryPath = await writeGroupStatusSummary(runId, changeId, cwd).catch(() => reportPath)
    await updateRun(runId, {
      phase: "partial",
      metadata: {
        ...((await readRun(runId, cwd)).metadata ?? {}),
        partialRunNote: `${postDispatchFailures.length} group(s) failed post-dispatch validation. Successful groups preserved. Use --resume to retry failed groups.`,
        groupStatusSummaryPath: summaryPath,
      },
    } as any, cwd)
    await recordDispatchFailurePolicy(runId, cwd, postDispatchFailures.map((failure) => ({
      groupId: failure.split(":", 1)[0] ?? "unknown",
      agent: "zflow.implement-routine",
      attempt: 0,
      decision: "blocker" as const,
      reason: failure,
      error: failure,
    })), reportPath, "partial")
    throw new Error(
      `${postDispatchFailures.length} group(s) failed post-dispatch validation: ` +
      postDispatchFailures.join("; ") +
      `\nFailure report: ${reportPath}` +
      `\nGroup status summary: ${summaryPath}`,
    )
  }

  emitWorkflowUpdate("Applying completed group patches back to the primary worktree", {
    status: "running",
  })

  // Finalize: apply patches back, check deviations
  await finalizeWorktreeImplementationRun(
    runId,
    groupResults,
    {
      cwd,
      changeId,
      planVersion,
      executionGroups: runPlan.groups,
    },
  )

  for (const result of groupResults) {
    await updateGroupLedger(runId, result.groupId, {
      status: "applied",
      appliedToPrimary: true,
      patchPath: result.patchPath,
      worktreePath: result.worktreePath,
      changedFiles: result.changedFiles,
      scopedVerification: {
        status: result.verification.status,
        command: result.verification.command,
        output: result.verification.output,
      },
    }, cwd).catch(() => {})
  }
  await writeGroupStatusSummary(runId, changeId, cwd).catch(() => "")

  emitWorkflowUpdate("Apply-back complete; dispatch artifacts are ready for final verification", {
    status: "completed",
    completedGroups: allGroupIds.length,
    elapsedSeconds: Math.round((Date.now() - Date.parse(dispatchStartedAt)) / 1000),
  })

  markDispatchProgress({
    status: "completed",
    completedGroups: allGroupIds.length,
    elapsedSeconds: Math.round((Date.now() - Date.parse(dispatchStartedAt)) / 1000),
  })
  await flushLiveProgress(true)

  console.info(
    `[zflow] Worktree dispatch completed via "${dispatchService.name}". ` +
    `${allResults.filter(r => r.result.ok).length}/${allGroupIds.length} groups succeeded.`,
  )
}

// Profile preflight helper
// ═══════════════════════════════════════════════════════════════════

/**
 * Attempt to resolve the active profile via the registry's profile
 * service.  This is the first step in both prepare and implement
 * workflows (Phase 7, Profile.ensureResolved()).
 *
 * @returns true if profile was resolved, false if no service is
 *          available (workflow may proceed advisory-only).
 * @throws never — errors are reported via ui and return false.
 */
async function ensureProfileResolved(ctx: InterviewableContext): Promise<boolean> {
  const notify = ctx.ui?.notify ?? (() => {})
  const reg = getZflowRegistry()
  if (reg.has("profiles")) {
    const profileService = reg.optional<{ ensureResolved?: (...args: unknown[]) => Promise<unknown> }>("profiles")
    if (profileService && typeof profileService.ensureResolved === "function") {
      try {
        // Convert the Pi model registry if available, so lane-health preflight
        // can check real model availability and authentication.
        let options: Record<string, unknown> = {}
        if (ctx.cwd) {
          options.repoRoot = ctx.cwd
        }
        if (ctx.modelRegistry) {
          const { createPiModelRegistryAdapter } = await import("pi-zflow-profiles")
          options.registry = createPiModelRegistryAdapter(ctx.modelRegistry)
        }
        await profileService.ensureResolved(undefined, options)
        notify("✅ Profile resolved.", "info")
        return true
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        notify(
          `⚠️ Profile service available but ensureResolved() failed: ${message}. ` +
          "Proceeding without explicit profile — verification command detection may be used.",
          "warning",
        )
        // Advisory-only; workflow may still proceed.
        return false
      }
    }
  }
  notify(
    "ℹ️ No profile service found in registry. Proceeding without explicit profile. " +
    (ctx.modelRegistry
      ? "Run /zflow-profile default to resolve a profile with lane-health checks."
      : "Run a profile setup command first or configure via pi-zflow-profiles. ") +
    "Verification will fall back to auto-detection.",
    "info",
  )
  return false
}

const THINKING_SUFFIX_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"])

function isUsableWorkflowModel(model: string | null | undefined): model is string {
  if (!model) return false
  const normalized = model.trim().toLowerCase()
  if (!normalized) return false
  return normalized !== "placeholder" && !normalized.startsWith("placeholder:")
}

function applyProfileThinkingSuffix(model: string | undefined, thinking: string | undefined): string | undefined {
  if (!isUsableWorkflowModel(model) || !thinking || thinking === "off") return model
  const colonIdx = model.lastIndexOf(":")
  if (colonIdx !== -1 && THINKING_SUFFIX_LEVELS.has(model.slice(colonIdx + 1))) return model
  return `${model}:${thinking}`
}

async function resolveWorkflowModel(agentName: string): Promise<{ model?: string; thinking?: string; dispatchModel?: string }> {
  try {
    const { getResolvedAgentBinding, getResolvedLane } = await import("pi-zflow-profiles")
    const binding = await getResolvedAgentBinding(agentName)
    const lane = binding?.lane ? await getResolvedLane(binding.lane) : null
    const bindingModel = binding?.resolvedModel ?? undefined
    const laneModel = lane?.model ?? undefined
    const model = isUsableWorkflowModel(bindingModel)
      ? bindingModel
      : isUsableWorkflowModel(laneModel)
        ? laneModel
        : undefined
    const thinking = lane?.thinking ?? undefined
    return {
      model,
      thinking,
      dispatchModel: applyProfileThinkingSuffix(model, thinking),
    }
  } catch {
    return {}
  }
}

// ── Transport error classification ──────────────────────────────────

const TRANSPORT_ERROR_PATTERNS: RegExp[] = [
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

export function isTransportDispatchError(error: string | undefined): boolean {
  if (!error) return false
  return TRANSPORT_ERROR_PATTERNS.some((pattern) => pattern.test(error))
}

// ── Resolver worktree inspection ──────────────────────────────────

interface ResolverWorktreeSnapshot {
  unmergedFiles: string[]
  hasConflictMarkers: boolean
  conflictDetails: string
  hasUncommittedChanges: boolean
  summary: string
}

export async function inspectResolverWorktreeState(
  wtPath: string,
): Promise<ResolverWorktreeSnapshot> {
  const { execFileSync } = await import("node:child_process")

  const gitCmd = (args: string[], allowExitCodeOne = false): string => {
    try {
      return execFileSync("git", args, {
        cwd: wtPath,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
        encoding: "utf-8",
      }).trim()
    } catch (err) {
      const e = err as { status?: unknown; code?: unknown }
      const exitCode = e.status ?? e.code
      if (allowExitCodeOne && (exitCode === 1 || exitCode === 128)) return ""
      throw err
    }
  }

  const unmergedOut = gitCmd(["diff", "--name-only", "--diff-filter=U"])
  const unmergedFiles = unmergedOut ? unmergedOut.split("\n").filter(Boolean) : []

  const conflictGrep = gitCmd(
    ["grep", "-n", "-E", "^(<<<<<<<|=======|>>>>>>>)", "--", "."],
    true,
  )
  const hasConflictMarkers = conflictGrep.length > 0

  const statusOut = gitCmd(["status", "--porcelain"])
  const hasUncommittedChanges = statusOut.length > 0

  const parts: string[] = []
  if (unmergedFiles.length > 0) {
    const list = unmergedFiles.slice(0, 5).join(", ")
    parts.push(`${unmergedFiles.length} unmerged: ${list}${unmergedFiles.length > 5 ? ` +${unmergedFiles.length - 5}` : ""}`)
  } else {
    parts.push("no unmerged files")
  }
  if (hasConflictMarkers) {
    const count = conflictGrep.split("\n").length
    parts.push(`${count} conflict markers`)
  } else {
    parts.push("no conflict markers")
  }
  if (hasUncommittedChanges) {
    const count = statusOut.split("\n").filter(Boolean).length
    parts.push(`${count} uncommitted changes`)
  } else {
    parts.push("no uncommitted changes")
  }

  return { unmergedFiles, hasConflictMarkers, conflictDetails: conflictGrep, hasUncommittedChanges, summary: parts.join("; ") }
}

// ── Resolver worktree observer ─────────────────────────────────────

interface ResolverWorktreeObserver {
  stop: () => void
  /** Currently accumulated log lines (shared reference for heartbeat). */
  readonly currentLogs: string[]
  /** Most recently sampled status string (for heartbeat messages). */
  lastStatusSummary: string
  /** Timestamp of last filesystem activity observed. */
  lastActivityAt: number
}

async function startResolverWorktreeObserver(
  integrationWorktreePath: string,
  runDir: string,
  progress: {
    onSubagent?: (id: string, update: Partial<Omit<WorkflowSubagentSnapshot, "id">>) => void
    onPhase?: (id: string, title: string, message: string, status?: "running" | "completed" | "failed") => void
  },
  subagentId: string,
  intervalMs: number = 15_000,
): Promise<ResolverWorktreeObserver> {
  const { execFileSync } = await import("node:child_process")
  const path = await import("node:path")
  const fs = await import("node:fs")
  const logs: string[] = []
  let stopped = false
  let prevHead = ""
  let prevUnmergedSignature = ""
  let prevStatusSignature = ""
  let prevConflictCounts = ""
  let lastActivityAt = Date.now()
  let lastStatusSummary = "observer starting"
  const liveLogPath = path.join(runDir, "subagent-resolution-live.log")

  const gitOutput = (args: string[], allowExitCodeOne = false): string => {
    try {
      return execFileSync("git", args, {
        cwd: integrationWorktreePath,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
        encoding: "utf-8",
      }).trim()
    } catch (err) {
      const maybeCode = (err as { status?: unknown; code?: unknown }).status ?? (err as { code?: unknown }).code
      if (allowExitCodeOne && maybeCode === 1) return ""
      throw err
    }
  }

  const writeLog = (msg: string): void => {
    const ts = new Date().toISOString()
    const line = `[${ts}] ${msg}`
    logs.push(msg)
    if (logs.length > 20) logs.splice(0, logs.length - 20)
    try {
      fs.appendFileSync(liveLogPath, line + "\n", "utf-8")
    } catch {
      // best-effort
    }
  }

  const flushProgress = (events: string[]): void => {
    if (events.length > 0) {
      progress.onSubagent?.(subagentId, { logs: events })
    }
  }

  const tick = (): void => {
    if (stopped) return
    try {
      const gitDir = path.join(integrationWorktreePath, ".git")
      if (!fs.existsSync(gitDir)) {
        // worktree may have been cleaned up
        return
      }

      // --- Sample worktree state ---
      const statusOut = gitOutput(["status", "--porcelain"])

      const headOut = gitOutput(["rev-parse", "--short", "HEAD"])

      const headShort = headOut

      const unmergedOut = gitOutput(["diff", "--name-only", "--diff-filter=U"])

      const unmergedFiles = unmergedOut ? unmergedOut.split("\n").filter(Boolean) : []

      // Conflict markers in modified files
      const conflictGrep = gitOutput(["grep", "-c", "-E", "^(<<<<<<<|=======|>>>>>>>)", "--", "."], true)

      const statusSignature = statusOut ? statusOut.split("\n").sort().join("\n") : ""

      // --- Detect changes ---
      const events: string[] = []

      // HEAD change
      if (headShort && headShort !== prevHead) {
        const logLine = gitOutput(["log", "-1", "--oneline"])
        events.push(`new commit: ${logLine}`)
        prevHead = headShort
        lastActivityAt = Date.now()
      }

      // Unmerged file changes
      const unmergedSignature = unmergedOut || ""
      if (unmergedSignature !== prevUnmergedSignature) {
        if (unmergedFiles.length > 0) {
          const unmergedStr = unmergedFiles.join(", ")
          const truncated = unmergedStr.length > 120 ? unmergedStr.slice(0, 117) + "..." : unmergedStr
          events.push(`unmerged: ${truncated}`)
          lastActivityAt = Date.now()
        } else if (prevUnmergedSignature) {
          events.push("all unmerged files resolved")
          lastActivityAt = Date.now()
        }
        prevUnmergedSignature = unmergedSignature
      }

      // Conflict marker count changes
      const conflictCounts = conflictGrep
      if (conflictCounts && conflictCounts !== prevConflictCounts) {
        const markerFiles = conflictCounts.split("\n").filter(Boolean)
        const markerFileNames = markerFiles.map((l: string) => l.split(":")[0]).filter(Boolean)
        if (markerFileNames.length > 0) {
          events.push(`conflict markers in: ${markerFileNames.join(", ")}`)
          lastActivityAt = Date.now()
        } else {
          events.push("conflict markers removed from tracked files")
          lastActivityAt = Date.now()
        }
        prevConflictCounts = conflictCounts
      } else if (!conflictCounts && prevConflictCounts) {
        events.push("conflict markers removed from tracked files")
        prevConflictCounts = ""
        lastActivityAt = Date.now()
      }

      // Status changes (modified files)
      if (statusSignature && statusSignature !== prevStatusSignature) {
        const modifiedFiles = statusOut.split("\n")
          .filter((l: string) => l.trim())
          .map((l: string) => l.slice(3).trim())
          .filter(Boolean)
        if (modifiedFiles.length > 0) {
          const fileList = modifiedFiles.slice(0, 5).join(", ")
          events.push(`modified: ${fileList}${modifiedFiles.length > 5 ? ` +${modifiedFiles.length - 5} more` : ""}`)
          lastActivityAt = Date.now()
        }
        prevStatusSignature = statusSignature
      }

      // Update lastStatusSummary for heartbeat
      if (events.length > 0) {
        lastStatusSummary = events[events.length - 1]
      } else {
        const idleSeconds = Math.floor((Date.now() - lastActivityAt) / 1000)
        if (idleSeconds > 30) {
          lastStatusSummary = `idle ${idleSeconds}s; no filesystem changes`
        } else {
          lastStatusSummary = `no new changes since last check`
        }
      }

      // Emit log events
      for (const event of events) {
        writeLog(event)
      }
      if (events.length > 0) {
        flushProgress(events)
      }
    } catch {
      // git command may fail if worktree is in conflict state or cleaned up
    }
  }

  // Initial sample
  tick()

  const interval = setInterval(tick, intervalMs)

  const observer: ResolverWorktreeObserver = {
    stop: () => {
      stopped = true
      clearInterval(interval)
    },
    get currentLogs(): string[] {
      return logs
    },
    get lastStatusSummary(): string {
      return lastStatusSummary
    },
    get lastActivityAt(): number {
      return lastActivityAt
    },
  }
  return observer
}

// ── Coverage repair helpers ─────────────────────────────────────────

async function autoRestoreSimpleAdditions(
  missingFiles: string[],
  groups: Array<{ groupId: string }>,
  patchesDir: string,
  integrationWorktreePath: string,
): Promise<number> {
  const { execFileSync } = await import("node:child_process")
  const fs = await import("node:fs")
  const path = await import("node:path")

  let restored = 0
  for (const file of missingFiles) {
    // Skip files that already exist — `git apply` on an existing file
    // can produce conflict markers instead of a clean restore.
    const targetPath = path.join(integrationWorktreePath, file)
    if (fs.existsSync(targetPath)) continue

    for (const group of groups) {
      const patchPath = path.join(patchesDir, `${group.groupId}.patch`)
      if (!fs.existsSync(patchPath)) continue

      const content = fs.readFileSync(patchPath, "utf-8")
      if (!content.includes(`diff --git a/${file} `)) continue

      // Extract single-file patch from the group's patch file
      const lines = content.split("\n")
      const start = lines.findIndex((l: string) => l.startsWith(`diff --git a/${file} `))
      if (start < 0) continue
      let end = start + 1
      for (; end < lines.length; end++) {
        if (lines[end].startsWith("diff --git ") && end > start + 1) break
      }

      // Reconstruct added file content from the patch hunks.
      // For brand-new files, only '+' and ' ' (context) lines matter.
      const patchLines = lines.slice(start, end)
      const newFileLines: string[] = []
      let inHunk = false
      for (const pl of patchLines) {
        if (pl.startsWith("@@")) { inHunk = true; continue }
        if (pl.startsWith("diff --git")) continue
        if (!inHunk) continue
        if (pl.startsWith("+")) { newFileLines.push(pl.slice(1)) }
        else if (pl.startsWith(" ")) { newFileLines.push(pl.slice(1)) }
        // Skip '-' lines — brand-new files have no removals.
      }

      if (newFileLines.length > 0) {
        const dir = path.dirname(targetPath)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(targetPath, newFileLines.join("\n") + "\n", "utf-8")
        try {
          execFileSync("git", ["add", targetPath], {
            cwd: integrationWorktreePath,
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 10_000,
          })
        } catch { /* best-effort staging */ }
        restored++
        break
      }
    }
  }
  return restored
}

async function buildCoverageRepairPrompt(
  failedGroups: Array<{ groupId: string; summary: string; missingHunks: Array<{ file: string; kind: string }> }>,
): Promise<string> {
  const parts: string[] = [
    "Repair coverage gaps in the integration worktree.",
    "",
    "The following groups have missing changes:",
    "",
  ]
  for (const g of failedGroups) {
    parts.push(`### ${g.groupId}`)
    parts.push(g.summary)
    parts.push("")
  }
  parts.push(
    "Instructions:",
    "- For each missing file, add the missing content from the original intent.",
    "- Preserve existing changes; do NOT remove any code.",
    "- For add-type hunks, create the file with its intended content.",
    "- For modify-type hunks, ensure the changes exist in the target files.",
    "- After completing, run: git add -A && git commit -m \"zflow: coverage repair\"",
  )
  return parts.join("\n")
}

// ── Marker-free unmerged finalization ────────────────────────────────

interface FinalizeResult {
  recovered: boolean
  committed: boolean
  unmergedFiles: string[]
  markerDetails: string
}

export async function finalizeMarkerFreeResolution(
  integrationWorktreePath: string,
  groupId: string,
  commitMessage?: string,
): Promise<FinalizeResult> {
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const execFileAsync = promisify(execFile)

  const markerCheck = await execFileAsync("git", [
    "grep", "-n", "-E", "^(<<<<<<<|=======|>>>>>>>)", "--", ".",
  ], { cwd: integrationWorktreePath })
    .then((r) => r.stdout.trim())
    .catch((err) => {
      const e = err as { code?: number }
      if (e.code === 1) return ""
      throw err
    })

  const unmergedOut = await execFileAsync("git", ["diff", "--name-only", "--diff-filter=U"], {
    cwd: integrationWorktreePath,
  }).then((r) => r.stdout.trim())
  const unmergedFiles = unmergedOut ? unmergedOut.split("\n").filter(Boolean) : []

  if (markerCheck) {
    return { recovered: false, committed: false, unmergedFiles, markerDetails: markerCheck }
  }

  if (unmergedFiles.length === 0) {
    return { recovered: true, committed: false, unmergedFiles: [], markerDetails: "" }
  }

  // Markers resolved but index still unmerged — stage and commit
  await execFileAsync("git", ["add", "-A"], { cwd: integrationWorktreePath, timeout: 30_000 })
  const msg = commitMessage ?? `zflow: integrate group ${groupId} with resolution`
  await execFileAsync("git", ["commit", "--allow-empty", "-m", msg], {
    cwd: integrationWorktreePath,
    timeout: 30_000,
  })

  return { recovered: true, committed: true, unmergedFiles, markerDetails: "" }
}

// ── Integration continuation helpers ────────────────────────────────

interface RemainingGroupBranch {
  groupId: string
  branchName: string
}

const GROUP_BRANCH_PREFIX = "zflow/run/"

async function findRemainingGroupBranches(
  integrationWorktreePath: string,
  groups: Array<{ groupId: string }>,
  runId: string,
): Promise<RemainingGroupBranch[]> {
  const { execFileSync } = await import("node:child_process")

  const gitOutput = (args: string[], allowExitCodeOne = false): string => {
    try {
      return execFileSync("git", args, {
        cwd: integrationWorktreePath,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
        encoding: "utf-8",
      }).trim()
    } catch (err) {
      const e = err as { status?: unknown; code?: unknown }
      const code = e.status ?? e.code
      if (allowExitCodeOne && (code === 1 || code === 128)) return ""
      throw err
    }
  }

  const branchList = gitOutput(["branch", "--list", `${GROUP_BRANCH_PREFIX}${runId}/group-*`])
  if (!branchList) return []

  const allGroupBranches = branchList.split("\n")
    .map((b) => b.replace(/^\*?\s+/, "").trim())
    .filter(Boolean)

  // Always return ALL group branches in topological order.  Rely on
  // `git merge` itself to skip already-merged branches (it exits 0 with
  // "Already up to date").  This avoids false negatives from `merge-base
  // --is-ancestor` when a prior partial merge made branches ancestors
  // without incorporating all their content.
  const remaining: RemainingGroupBranch[] = []
  for (const group of groups) {
    const branchSuffix = `/${group.groupId}`
    const branchName = allGroupBranches.find((b) => b.endsWith(branchSuffix))
    if (!branchName) continue
    remaining.push({ groupId: group.groupId, branchName })
  }
  return remaining
}

async function buildFocusedResolutionPrompt(
  groupId: string,
  unmergedFiles: string[],
  integrationWorktreePath: string,
): Promise<string> {
  const { execFileSync } = await import("node:child_process")

  const conflictDiff = (() => {
    try {
      return execFileSync("git", ["diff"], {
        cwd: integrationWorktreePath,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
        encoding: "utf-8",
      }).trim()
    } catch {
      return ""
    }
  })()

  const shortDiff = conflictDiff.length > 12_000
    ? conflictDiff.slice(0, 12_000) + "\n\n[...diff truncated...]"
    : conflictDiff

  return [
    `Role: apply-back-resolver`,
    "",
    `Resolve the merge conflict for group "${groupId}".`,
    "",
    `Conflicted files:`,
    ...unmergedFiles.map((f) => `  - ${f}`),
    "",
    "Conflict diff:",
    "```",
    shortDiff,
    "```",
    "",
    "Instructions:",
    "- Resolve EVERY conflict marker in the conflicted files.",
    "- Preserve both sides' intended changes.",
    `- After resolving, run: git add -A && git commit -m "zflow: integrate group ${groupId} with resolution"`,
    "- Do NOT apply changes to the primary worktree.",
    "- The parent will continue merging remaining groups.",
  ].join("\n")
}

async function resolveApplyBackWithSubagent(
  runId: string,
  ctx: InterviewableContext,
  progress?: {
    onProgress?: (message: string) => void
    onPhase?: (id: string, title: string, message: string, status?: "running" | "completed" | "failed") => void
    onSubagent?: (id: string, update: Partial<Omit<WorkflowSubagentSnapshot, "id" | "startedAt">>) => void
  },
): Promise<void> {
  const { default: fs } = await import("node:fs/promises")
  const { default: path } = await import("node:path")
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const execFileAsync = promisify(execFile)
  const { readRun, updateRun } = await import("pi-zflow-artifacts")
  const { generateCoverageReport } = await import("./coverage-verifier.js")

  const cwd = ctx.cwd ?? process.cwd()
  const run = await readRun(runId, cwd)
  const runDir = resolveRunDir(runId, cwd)
  const integrationWorktreePath = path.join(runDir, "integration-worktree")
  const promptPath = path.join(runDir, "subagent-resolution-prompt.md")
  const resultPath = path.join(runDir, "subagent-resolution-result.md")
  const resolvedPatchPath = path.join(runDir, "patches", "_subagent-resolved.patch")
  const baseCommit = run.preApplySnapshot?.head ?? run.head

  progress?.onPhase?.("prepare", "Prepare Resolution", "Inspecting preserved apply-back artifacts", "running")
  await fs.access(integrationWorktreePath).catch(() => {
    progress?.onPhase?.("prepare", "Prepare Resolution", "Integration worktree is missing", "failed")
    throw new Error(
      `Integration worktree not found at ${integrationWorktreePath}. ` +
      "Run /zflow-change-implement --resume first so the smart cascade can preserve an integration worktree.",
    )
  })

  // ── Clean up any stale merge/rebase/cherry-pick state ──────────
  await execFileAsync("git", ["merge", "--abort"], { cwd: integrationWorktreePath }).catch(() => {})
  await execFileAsync("git", ["cherry-pick", "--abort"], { cwd: integrationWorktreePath }).catch(() => {})
  await execFileAsync("git", ["rebase", "--abort"], { cwd: integrationWorktreePath }).catch(() => {})

  const findConflictMarkers = async (): Promise<string> => execFileAsync("git", [
    "grep", "-E", "^(<<<<<<<|=======|>>>>>>>)", "--", ".",
  ], { cwd: integrationWorktreePath }).then((r) => r.stdout.trim()).catch(() => "")

  // If a previous zflow-generated repair committed literal conflict markers,
  // roll it back deterministically before involving a model.  This is safe only
  // for clean worktrees and known machine-generated commits.
  let rolledBackMarkerCommits = 0
  for (let i = 0; i < 5; i++) {
    const markerCheck = await findConflictMarkers()
    if (!markerCheck) break
    const status = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: integrationWorktreePath,
    }).then((r) => r.stdout.trim()).catch(() => "")
    if (status) break
    const headSubject = await execFileAsync("git", ["log", "-1", "--format=%s"], {
      cwd: integrationWorktreePath,
    }).then((r) => r.stdout.trim()).catch(() => "")
    const rollbackable = /^zflow: (auto-restored .*missing file|snapshot pre-continuation|coverage repair)/.test(headSubject)
    if (!rollbackable) break
    progress?.onPhase?.("prepare", "Prepare Resolution",
      `Rolling back zflow-generated marker commit: ${headSubject}`, "running")
    await execFileAsync("git", ["reset", "--hard", "HEAD~1"], { cwd: integrationWorktreePath })
    rolledBackMarkerCommits++
  }
  if (rolledBackMarkerCommits > 0) {
    progress?.onPhase?.("prepare", "Prepare Resolution",
      `Rolled back ${rolledBackMarkerCommits} zflow-generated marker commit(s)`, "running")
  }

  // If conflict markers remain from a prior failed run, resolve them first
  const preMarkerCheck = await findConflictMarkers()
  if (preMarkerCheck) {
    progress?.onPhase?.("prepare", "Prepare Resolution",
      "Conflict markers found from prior run; dispatching cleanup resolver", "running")
    const cleanupService = await tryGetDispatchServiceViaRegistry()
    const cleanupModel = await resolveWorkflowModel("zflow.implement-hard")
    if (cleanupService && cleanupModel.dispatchModel) {
      const { ensureScratchScriptsDir, buildEphemeralScriptRule } = await import("./orchestration.js")
      const scratchScriptsDir = await ensureScratchScriptsDir(runId, cwd)
      const scriptRule = buildEphemeralScriptRule(scratchScriptsDir)
      const cleanupTask = [
        scriptRule,
        "",
        "Role: apply-back-resolver",
        "",
        "Resolve existing conflict markers in this integration worktree.",
        "",
        "The worktree has leftover conflict markers from a previous failed merge.",
        "Resolve EVERY conflict marker in the conflicted files.",
        "Preserve both sides' intended changes.",
        "After resolving, run: git add -A && git commit -m \"zflow: resolve stale conflict markers\"",
        "Do NOT apply changes to the primary worktree.",
      ].join("\n")
      const cleanupResult = await cleanupService.runAgent({
        agent: "zflow.implement-hard",
        task: cleanupTask,
        cwd: integrationWorktreePath,
        model: cleanupModel.dispatchModel,
        output: path.join(runDir, "subagent-resolution-cleanup.md"),
        outputMode: "file-only",
        context: "fresh",
        maxOutput: { lines: 5000, bytes: 500_000 },
      })
      if (!cleanupResult.ok) {
        progress?.onPhase?.("prepare", "Prepare Resolution",
          "Cleanup resolver failed; worktree has unresolved conflict markers", "failed")
        throw new Error(`Could not resolve stale conflict markers: ${cleanupResult.error ?? "unknown error"}`)
      }
      const remainingMarkers = await findConflictMarkers()
      if (remainingMarkers) {
        progress?.onPhase?.("prepare", "Prepare Resolution",
          "Cleanup resolver returned but conflict markers remain", "failed")
        throw new Error(`Cleanup resolver left conflict markers:\n${remainingMarkers}`)
      }
      progress?.onPhase?.("prepare", "Prepare Resolution",
        "Stale conflict markers resolved", "completed")
    }
  }

  const groups = run.groups.map((g) => ({
    groupId: g.groupId,
    files: g.changedFiles ?? [],
    taskPrompt: undefined,
  }))

  const dispatchService = await tryGetDispatchServiceViaRegistry()
  if (!dispatchService) {
    progress?.onPhase?.("resolver", "Resolver Subagent", "No dispatch service available", "failed")
    throw new Error("No zflow dispatch service is available. Install/enable pi-subagents and retry.")
  }

  const model = await resolveWorkflowModel("zflow.implement-hard")
  if (!model.dispatchModel) {
    progress?.onPhase?.("resolver", "Resolver Subagent", "No usable model resolved for resolver", "failed")
    throw new Error(
      "No usable model resolved for zflow.implement-hard. " +
      "Run /zflow-profile validate or switch to a profile with a non-placeholder implementation model.",
    )
  }
  ctx.ui?.notify?.(`🤖 Dispatching apply-back resolver subagent for run ${runId}...`, "info")
  progress?.onPhase?.("resolver", "Resolver Subagent", "Continuing integration merge", "running")
  progress?.onSubagent?.("apply-back-resolver", {
    agent: "zflow.implement-hard",
    title: "Apply-back resolver",
    model: model.model,
    thinking: model.thinking,
    status: "running",
    lastCommand: "continuing integration merge",
  })

  // Start the worktree observer for live progress visibility
  let observer: ResolverWorktreeObserver | undefined
  try {
    observer = await startResolverWorktreeObserver(
      integrationWorktreePath,
      runDir,
      {
        onSubagent: progress?.onSubagent,
        onPhase: progress?.onPhase,
      },
      "apply-back-resolver",
      15_000,
    )
  } catch {
    // observer is best-effort; non-fatal if it fails to start
  }

  const resolverStartedAt = Date.now()
  const heartbeat = setInterval(() => {
    const elapsed = formatElapsed(Date.now() - resolverStartedAt)
    let lastCommand: string
    if (observer && observer.lastStatusSummary) {
      lastCommand = observer.lastStatusSummary
    } else {
      lastCommand = "still running; backend may not stream tool-level progress"
    }
    const message = `Resolver subagent still running (${elapsed}); ${lastCommand}`
    progress?.onPhase?.("resolver", "Resolver Subagent", message, "running")
    progress?.onSubagent?.("apply-back-resolver", {
      agent: "zflow.implement-hard",
      title: "Apply-back resolver",
      model: model.model,
      thinking: model.thinking,
      status: "running",
      lastCommand,
    })
  }, 30_000)

  // ── Integration continuation loop ─────────────────────────────
  let dispatchResult: Awaited<ReturnType<DispatchService["runAgent"]>>
  let finalDispatchOk = true
  let conflictResolutionCount = 0
  const MAX_CONFLICT_RESOLUTIONS = 3
  let groupsMerged = 0
  const totalGroups = groups.length

  // Commit any uncommitted changes already in the integration worktree.
  // Skip if unmerged files exist (cleanup resolver should handle those first).
  const preStatus = await execFileAsync("git", ["status", "--porcelain"], {
    cwd: integrationWorktreePath,
  }).then((r) => r.stdout.trim()).catch(() => "")
  const preUnmerged = await execFileAsync("git", ["diff", "--name-only", "--diff-filter=U"], {
    cwd: integrationWorktreePath,
  }).then((r) => r.stdout.trim()).catch(() => "")
  if (preStatus && !preUnmerged) {
    await execFileAsync("git", ["add", "-A"], { cwd: integrationWorktreePath }).catch(() => {})
    await execFileAsync("git", ["commit", "--allow-empty", "-m", `zflow: snapshot pre-continuation for run ${runId}`], {
      cwd: integrationWorktreePath,
    }).catch(() => {})
  }

  try {
    while (true) {
      // Find remaining group branches
      const remaining = await findRemainingGroupBranches(integrationWorktreePath, groups, runId)
      if (remaining.length === 0) break

      const plannedTotal = groupsMerged + remaining.length
      progress?.onPhase?.("continue", "Continue Integration",
        `Merging ${remaining.length} remaining group branch(es); ${groupsMerged}/${totalGroups} already merged`, "running")

      for (const branch of remaining) {
        // Try to merge the group branch into integration
        let mergeOk = false
        try {
          await execFileAsync("git", ["merge", "--no-edit", branch.branchName], {
            cwd: integrationWorktreePath,
            timeout: 60_000,
          })
          mergeOk = true
        } catch {
          mergeOk = false
        }

        // Check for unmerged files (conflict)
        const unmergedOut = await execFileAsync("git", ["diff", "--name-only", "--diff-filter=U"], {
          cwd: integrationWorktreePath,
        }).then((r) => r.stdout.trim()).catch(() => "")

        if (mergeOk && !unmergedOut) {
          groupsMerged++
          progress?.onPhase?.("continue", "Continue Integration",
            `Merged group ${branch.groupId} automatically (${groupsMerged}/${totalGroups})`, "running")
          continue
        }

        // Merge failed. Abort if not a real conflict.
        if (!unmergedOut) {
          try { await execFileAsync("git", ["merge", "--abort"], { cwd: integrationWorktreePath }) } catch { /* ok */ }
          throw new Error(`Failed to merge group ${branch.groupId}: non-conflict merge failure.`)
        }

        const unmergedFiles = unmergedOut.split("\n").filter(Boolean)

        // ── Dispatch focused resolver for this conflict ──────
        conflictResolutionCount++
        if (conflictResolutionCount > MAX_CONFLICT_RESOLUTIONS) {
          throw new Error(
            `Max conflict resolution attempts reached (${MAX_CONFLICT_RESOLUTIONS}). ` +
            `Remaining: ${remaining.map((r) => r.groupId).join(", ")}. ` +
            "Run the command again to continue."
          )
        }

        progress?.onPhase?.("continue", "Continue Integration",
          `Resolving conflict for group ${branch.groupId} (attempt ${conflictResolutionCount}/${MAX_CONFLICT_RESOLUTIONS})`, "running")

        const { ensureScratchScriptsDir, buildEphemeralScriptRule } = await import("./orchestration.js")
        const scratchScriptsDir = await ensureScratchScriptsDir(runId, cwd)
        const scriptRule = buildEphemeralScriptRule(scratchScriptsDir)
        const focusedTask = `${scriptRule}\n\n${await buildFocusedResolutionPrompt(branch.groupId, unmergedFiles, integrationWorktreePath)}`
        const focusedPromptPath = path.join(runDir,
          `subagent-resolution-prompt-group-${branch.groupId}.md`)
        await fs.writeFile(focusedPromptPath, focusedTask, "utf-8")

        const onUpdate = (agentProgress: AgentDispatchProgress) => {
          progress?.onSubagent?.("apply-back-resolver", {
            agent: agentProgress.agent,
            title: "Apply-back resolver",
            model: model.model,
            thinking: model.thinking,
            status: agentProgress.status ?? "running",
            lastCommand: agentProgress.currentTool
              ? `${agentProgress.currentTool}${agentProgress.currentToolArgs ? ` ${agentProgress.currentToolArgs}` : ""}`
              : agentProgress.recentOutput?.[agentProgress.recentOutput.length - 1]
              ?? `resolving ${branch.groupId} conflict...`,
          })
        }

        // Per-group result artifact path so each focused run writes independently.
        const focusedResultPath = path.join(runDir,
          `subagent-resolution-result-group-${branch.groupId}.md`)

        try {
          dispatchResult = await dispatchService.runAgent({
            agent: "zflow.implement-hard",
            task: focusedTask,
            cwd: integrationWorktreePath,
            model: model.dispatchModel,
            output: focusedResultPath,
            outputMode: "file-only",
            context: "fresh",
            maxOutput: { lines: 5000, bytes: 500_000 },
            onUpdate,
          })
        } catch (dispatchErr) {
          dispatchResult = { ok: false, rawOutput: "", error: String(dispatchErr) }
        }

        // Check transport error — resolver may have resolved markers before the
        // transport died.  If markers are gone, stage/commit the unmerged files.
        if (!dispatchResult.ok && isTransportDispatchError(dispatchResult.error)) {
          const finalizeResult = await finalizeMarkerFreeResolution(
            integrationWorktreePath,
            branch.groupId,
            `zflow: integrate group ${branch.groupId} with resolution`,
          ).catch(() => ({ recovered: false, committed: false, unmergedFiles: [], markerDetails: "inspection failed" }) as FinalizeResult)

          if (finalizeResult.recovered) {
            groupsMerged++
            const statusMsg = finalizeResult.committed
              ? `Transport error but staged and committed marker-free resolution for group ${branch.groupId} (${groupsMerged}/${totalGroups})`
              : `Transport error but marker-free resolution already finalized for group ${branch.groupId} (${groupsMerged}/${totalGroups})`
            progress?.onPhase?.("continue", "Continue Integration", statusMsg, "running")
            progress?.onSubagent?.("apply-back-resolver", {
              agent: "zflow.implement-hard",
              title: "Apply-back resolver",
              model: model.model,
              thinking: model.thinking,
              status: "completed",
              lastCommand: finalizeResult.committed
                ? `staged and committed marker-free resolution for group ${branch.groupId}`
                : `marker-free resolution already finalized for group ${branch.groupId}`,
              finishedAt: Date.now(),
            })
            continue
          }
        }

        // Verify resolver result
        if (!dispatchResult.ok) {
          finalDispatchOk = false
          throw new Error(
            `Resolver failed for group ${branch.groupId}: ${dispatchResult.error ?? "unknown error"}`
          )
        }

        // Finalize: stage/commit if markers are gone but index is unmerged
        const finalizeResult = await finalizeMarkerFreeResolution(
          integrationWorktreePath,
          branch.groupId,
          `zflow: integrate group ${branch.groupId} with resolution`,
        )
        if (finalizeResult.markerDetails) {
          throw new Error(
            `Conflict markers remain after resolver for group ${branch.groupId}:\n${finalizeResult.markerDetails}`
          )
        }

        groupsMerged++
        const statusMsg = finalizeResult.committed
          ? `Staged and committed marker-free resolution for group ${branch.groupId} (${groupsMerged}/${totalGroups})`
          : `Resolved and merged group ${branch.groupId} (${groupsMerged}/${totalGroups})`
        progress?.onPhase?.("continue", "Continue Integration", statusMsg, "running")
      }

      // After processing all remaining, re-check if more appeared
      if (groupsMerged >= totalGroups) break
    }
  } finally {
    clearInterval(heartbeat)
    observer?.stop()
  }

  // ── Commit any remaining changes and capture the resolved patch ──
  progress?.onPhase?.("continue", "Continue Integration",
    `Integration complete: ${groupsMerged}/${totalGroups} groups merged`, "completed")

  if (!finalDispatchOk) {
    progress?.onPhase?.("resolver", "Resolver Subagent", dispatchResult?.error ?? "Resolver subagent failed", "failed")
    progress?.onSubagent?.("apply-back-resolver", {
      agent: "zflow.implement-hard",
      status: "failed",
      finishedAt: Date.now(),
      lastCommand: dispatchResult?.error ?? "resolver subagent failed",
    })
    await updateRun(runId, {
      metadata: {
        ...(run.metadata ?? {}),
        subagentResolutionAttempted: true,
        subagentResolutionError: dispatchResult?.error ?? "resolver subagent failed",
        subagentResolutionConflictResolutions: conflictResolutionCount,
        subagentResolutionGroupsMerged: groupsMerged,
        subagentResolutionGroupsTotal: totalGroups,
      },
    } as any, cwd)
    throw new Error(dispatchResult?.error ?? "Resolver subagent failed")
  }

  progress?.onPhase?.("resolver", "Resolver Subagent",
    `Integration complete; ${groupsMerged}/${totalGroups} groups merged, ${conflictResolutionCount} conflicts resolved`, "completed")
  progress?.onSubagent?.("apply-back-resolver", {
    agent: "zflow.implement-hard",
    title: "Apply-back resolver",
    model: model.model,
    thinking: model.thinking,
    status: "completed",
    finishedAt: Date.now(),
    lastCommand: `integration complete; ${groupsMerged}/${totalGroups} groups merged`,
  })

  progress?.onPhase?.("verify", "Verify Resolution", "Checking for conflict markers", "running")
  const grepResult = await execFileAsync("git", ["grep", "-n", "^<<<<<<< \\|^=======\\|^>>>>>>> ", "--", "."], {
    cwd: integrationWorktreePath,
  }).then((r) => r.stdout.trim()).catch((err: unknown) => {
    const e = err as { code?: number }
    if (e.code === 1) return ""
    throw err
  })
  if (grepResult) {
    await updateRun(runId, {
      metadata: {
        ...(run.metadata ?? {}),
        subagentResolutionAttempted: true,
        subagentResolutionError: "conflict markers remain",
        subagentResolutionRemainingConflicts: grepResult,
      },
    } as any, cwd)
    progress?.onPhase?.("verify", "Verify Resolution", "Conflict markers remain", "failed")
    throw new Error(`Resolver left conflict markers:\n${grepResult}`)
  }

  const statusBeforeCommit = await execFileAsync("git", ["status", "--porcelain"], {
    cwd: integrationWorktreePath,
  }).then((r) => r.stdout.trim())
  if (statusBeforeCommit) {
    await execFileAsync("git", ["add", "-A"], { cwd: integrationWorktreePath })
    await execFileAsync("git", ["commit", "--allow-empty", "-m", `zflow: subagent resolution for run ${runId}`], {
      cwd: integrationWorktreePath,
    })
  }

  const resolvedDiff = await execFileAsync("git", ["diff", "--binary", baseCommit, "HEAD"], {
    cwd: integrationWorktreePath,
    maxBuffer: 20 * 1024 * 1024,
  }).then((r) => r.stdout)
  if (!resolvedDiff.trim()) {
    progress?.onPhase?.("verify", "Verify Resolution", "Resolver produced no diff", "failed")
    throw new Error("Resolver produced no diff from the integration worktree.")
  }
  await fs.mkdir(path.dirname(resolvedPatchPath), { recursive: true })
  await fs.writeFile(resolvedPatchPath, resolvedDiff, "utf-8")

  const coverageInputs = run.groups
    .map((g) => ({ groupId: g.groupId, patchPath: path.join(runDir, "patches", `${g.groupId}.patch`) }))
  progress?.onPhase?.("verify", "Verify Resolution", "Running no-lost-code coverage verification", "running")
  let coverageReport = await generateCoverageReport(coverageInputs, integrationWorktreePath, baseCommit)
  await fs.writeFile(
    path.join(runDir, "subagent-resolution-coverage.json"),
    JSON.stringify(coverageReport, null, 2),
    "utf-8",
  )
  if (!coverageReport.allCovered) {
    // ── Auto-restore simple missing additions ────────────────
    const allMissingFiles = coverageReport.groups
      .filter((g) => !g.covered)
      .flatMap((g) => g.missingHunks.map((h) => h.file))
    if (allMissingFiles.length > 0) {
      progress?.onPhase?.("repair", "Coverage Repair",
        `Auto-restoring simple missing files`, "running")
      const patchesDir = path.join(runDir, "patches")
      const groupsInput = run.groups.map((g) => ({ groupId: g.groupId }))
      const restored = await autoRestoreSimpleAdditions(allMissingFiles, groupsInput, patchesDir, integrationWorktreePath)
      if (restored > 0) {
        await execFileAsync("git", ["add", "-A"], { cwd: integrationWorktreePath })
        await execFileAsync("git", ["commit", "--allow-empty",
          "-m", `zflow: auto-restored ${restored} missing file(s)`],
          { cwd: integrationWorktreePath })
        const repairCoverage = await generateCoverageReport(coverageInputs, integrationWorktreePath, baseCommit)
        Object.assign(coverageReport, repairCoverage)
        await fs.writeFile(
          path.join(runDir, "subagent-resolution-coverage.json"),
          JSON.stringify(coverageReport, null, 2),
          "utf-8",
        )
        if (coverageReport.allCovered) {
          progress?.onPhase?.("repair", "Coverage Repair",
            `Auto-restored ${restored} file(s); coverage now complete`, "completed")
        } else {
          progress?.onPhase?.("repair", "Coverage Repair",
            `Auto-restored ${restored} file(s); ${coverageReport.groups.filter((g) => !g.covered).length} group(s) still incomplete`, "running")
        }
      }
    }
    // If auto-restore fully repaired coverage, skip the failure path
    if (!coverageReport.allCovered) {
      const failedGroups = coverageReport.groups
        .filter((g) => !g.covered)
        .map((g) => g.groupId)
      const missingFiles = coverageReport.groups
        .flatMap((g) => g.missingHunks.map((h) => h.file))
      await updateRun(runId, {
        metadata: {
          ...(run.metadata ?? {}),
          subagentResolutionAttempted: true,
          subagentResolutionError: "coverage verification failed",
          subagentResolutionCoverageFailed: true,
          subagentResolutionCoverageSummary: coverageReport.summary,
          subagentResolutionRepairable: true,
          subagentResolutionMissingGroups: failedGroups.join(", "),
          subagentResolutionMissingFiles: missingFiles.join(", "),
          subagentResolutionConflictResolutions: conflictResolutionCount,
          subagentResolutionGroupsMerged: groupsMerged,
          subagentResolutionGroupsTotal: totalGroups,
          subagentResolvedPatchPath: resolvedPatchPath,
        },
      } as any, cwd)
      progress?.onPhase?.("verify", "Verify Resolution",
        `Coverage incomplete: ${failedGroups.length} groups need repair`, "failed")
      throw new Error(
        `Coverage repair needed after integration: ${failedGroups.length}/${totalGroups} groups incomplete.\n` +
        `Missing groups: ${failedGroups.join(", ")}.\n` +
        `Resolved patch preserved at ${resolvedPatchPath}.\n` +
        `Run /zflow-resolve-apply-back ${runId} again to continue coverage repair.`
      )
    }
  }
  progress?.onPhase?.("verify", "Verify Resolution", "Coverage verified; all group changes preserved", "completed")

  progress?.onPhase?.("apply", "Apply Resolved Patch", "Checking primary worktree cleanliness", "running")
  const primaryStatus = await execFileAsync("git", ["status", "--porcelain"], {
    cwd: run.repoRoot,
  }).then((r) => r.stdout.trim())
  if (primaryStatus) {
    progress?.onPhase?.("apply", "Apply Resolved Patch", "Primary worktree is not clean", "failed")
    throw new Error(
      "Primary worktree is not clean; refusing to apply resolved patch. " +
      `Resolved patch is preserved at ${resolvedPatchPath}.`,
    )
  }

  progress?.onPhase?.("apply", "Apply Resolved Patch", "Applying verified resolved patch", "running")
  await execFileAsync("git", ["apply", "--3way", "--index", "--binary", resolvedPatchPath], {
    cwd: run.repoRoot,
    timeout: 60_000,
    maxBuffer: 20 * 1024 * 1024,
  })

  const latestRun = await readRun(runId, cwd)
  const ledger = { ...((latestRun.metadata?.groupLedger ?? {}) as Record<string, Record<string, unknown>>) }
  for (const group of run.groups) {
    ledger[group.groupId] = {
      ...(ledger[group.groupId] ?? {}),
      groupId: group.groupId,
      status: "applied",
      appliedToPrimary: true,
      patchPath: path.join(runDir, "patches", `${group.groupId}.patch`),
      updatedAt: new Date().toISOString(),
    }
  }

  await updateRun(runId, {
    phase: "partial",
    applyBack: {
      status: "completed",
      startedAt: latestRun.applyBack?.startedAt,
      completedAt: new Date().toISOString(),
    },
    metadata: {
      ...(latestRun.metadata ?? {}),
      groupLedger: ledger,
      subagentResolutionAttempted: true,
      subagentResolutionSucceeded: true,
      subagentResolvedPatchPath: resolvedPatchPath,
      subagentResolutionCoverageSummary: coverageReport.summary,
    },
  } as any, cwd)

  progress?.onPhase?.("apply", "Apply Resolved Patch", "Verified patch applied to primary worktree", "completed")
  ctx.ui?.notify?.(
    `✅ Subagent resolved apply-back and applied the verified patch.\n` +
    `Resolved patch: ${resolvedPatchPath}\n` +
    "Next: run /zflow-change-implement <change> --resume to continue final verification and review.",
    "info",
  )
}

// ── Extension activation ────────────────────────────────────────

const CHANGE_WORKFLOWS_CAPABILITY = "change-workflows" as const

export default function activateZflowChangeWorkflowsExtension(pi: ExtensionAPI): void {
  const registry = getZflowRegistry()

  // ── Capability claim (guards against duplicate loads) ──────────
  const claim: CapabilityClaim = {
    capability: CHANGE_WORKFLOWS_CAPABILITY,
    version: PI_ZFLOW_CHANGE_WORKFLOWS_VERSION,
    provider: "pi-zflow-change-workflows",
    sourcePath: import.meta.url,
    compatibilityMode: "compatible",
  }

  const registered = registry.claim(claim)

  // If claim returns null, an incompatible provider already owns this
  // capability — do not register anything.
  if (!registered) {
    return
  }

  // If the capability already has a service, another compatible
  // instance already initialised fully. No-op to avoid duplicate
  // command registration.
  if (registered.service !== undefined) {
    return
  }

  // Provide a minimal service marker so duplicate loads see service !== undefined
  registry.provide(CHANGE_WORKFLOWS_CAPABILITY, { activated: true })
  registerWorkflowProgressRenderer(pi)

  // ── Agent setup check ─────────────────────────────────────────
  // Check if the zflow-agents capability is available via registry.
  // If not, emit a one-time warning that setup hasn't been run yet.
  let agentsSetupChecked = false
  try {
    if (registry.has("agents")) {
      agentsSetupChecked = true
    }
  } catch {
    // Registry not available — skip check
  }

  // ── Tool call interception: path guard ───────────────────────
  // Intercept write/edit tool calls to enforce path guard policy.
  // Intercept bash commands to block destructive operations when
  // inappropriate (e.g. planning mode).
  const homeDir = typeof process !== "undefined"
    ? (process.env.HOME || process.env.USERPROFILE || "/home/user")
    : "/home/user"

  // Guard intent tracking: updated in before_agent_start by inspecting
  // the system prompt for known agent roles.  Each role receives distinct
  // path guard privileges:
  //   fix-orchestrator  → elevated (may restructure files per fix plan)
  //   fix-worker        → restricted (scratch/ only)
  //   apply-back-resolver → restricted (integration worktree only)
  //   write             → standard (project root allowlist)
  let currentGuardIntent: GuardIntent = "write"

  pi.on("tool_call", async (event, ctx) => {
    const { isToolCallEventType } = await import("@earendil-works/pi-coding-agent")

    if (!isWorkflowToolGuardActive()) {
      return {}
    }

    // ── Guard "write" and "edit" tool calls ───────────────────
    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      // Determine the target path from the tool input
      let targetPath = ""
      if (isToolCallEventType("write", event)) {
        targetPath = event.input.path ?? ""
      } else if (isToolCallEventType("edit", event)) {
        targetPath = event.input.path ?? ""
      }

      if (!targetPath) return // no path to check

      // Resolve project root
      let projectRoot = process.cwd()
      try {
        const { execSync } = await import("node:child_process")
        projectRoot = execSync("git rev-parse --show-toplevel", {
          cwd: process.cwd(),
          encoding: "utf-8",
          timeout: 5_000,
        }).trim()
      } catch {
        // Not in a git repo — use cwd as project root
      }

      const { loadRepoZflowConfig } = await import("./repo-config.js")
      const repoConfig = await loadRepoZflowConfig(projectRoot)
      const options: GuardOptions = {
        projectRoot,
        runtimeStateDir: resolveRuntimeStateDir(process.cwd()),
        bashPolicy: repoConfig.config.bashGuard,
      }

      const result = guardWrite(targetPath, { ...options, intent: currentGuardIntent })

      if (!result.allowed) {
        const reminder = buildToolDeniedReminder(result)
        return { block: true, reason: reminder }
      }
    }

    // ── Guard "bash" tool calls ───────────────────────────────
    if (isToolCallEventType("bash", event)) {
      const command = event.input.command ?? ""

      // Resolve project root
      let projectRoot = process.cwd()
      try {
        const { execSync } = await import("node:child_process")
        projectRoot = execSync("git rev-parse --show-toplevel", {
          cwd: process.cwd(),
          encoding: "utf-8",
          timeout: 5_000,
        }).trim()
      } catch {
        // Not in a git repo — use cwd as project root
      }

      const { loadRepoZflowConfig } = await import("./repo-config.js")
      const repoConfig = await loadRepoZflowConfig(projectRoot)
      const options: GuardOptions = {
        projectRoot,
        runtimeStateDir: resolveRuntimeStateDir(process.cwd()),
        bashPolicy: repoConfig.config.bashGuard,
      }

      const result = guardBashCommand(command, { ...options, intent: currentGuardIntent })

      if (!result.allowed) {
        const reminder = buildToolDeniedReminder(result)
        return { block: true, reason: reminder }
      }
    }
  })

  // ── before_agent_start hook: inject mode fragments and reminders ──

  pi.on("before_agent_start", async (event) => {
    // Track which agent is starting — used by tool_call guards to apply
    // intent-specific rules (e.g. fix-orchestrator gets elevated privileges).
    // Check the full system prompt (agent definition + task) for role markers.
    const sp = event.systemPrompt
    if (sp.includes("zflow.fix-orchestrator")) {
      currentGuardIntent = "fix-orchestrator"
    } else if (sp.includes("fix-worker") || sp.includes("zflow.fix-worker")) {
      currentGuardIntent = "fix-worker"
    } else if (sp.includes("apply-back-resolver") || sp.includes("role: apply-back-resolver")) {
      currentGuardIntent = "apply-back-resolver"
    } else {
      currentGuardIntent = "write"
    }

    const mode = getActiveWorkflowMode()
    const reminders = getActiveReminders()
    if (!mode && reminders.length === 0) {
      return // nothing to inject
    }

    let injections: string[] = []

    // Inject the current mode fragment (e.g. change-prepare, change-implement)
    if (mode) {
      const modeText = await buildModeInjection(mode)
      if (modeText) {
        injections.push(modeText)
      }
    }

    // Inject active runtime reminders
    if (reminders.length > 0) {
      const reminderText = await buildReminderInjection(reminders)
      if (reminderText) {
        injections.push(reminderText)
      }
    }

    if (injections.length === 0) {
      return
    }

    // Append injections to the system prompt
    return {
      systemPrompt: event.systemPrompt + "\n\n" + injections.join("\n\n"),
    }
  })

  // ── Command: /zflow-clean ─────────────────────────────────────

  pi.registerCommand("zflow-clean", {
    description: "Clean stale runtime artifacts, orphaned worktrees, and expired metadata",
    handler: async (args: string, ctx: InterviewableContext): Promise<void> => {
      // Parse arguments
      const parts = args.trim().split(/\s+/)
      const options: CleanWorkflowOptions = {}
      let targetInput = ""
      for (let i = 0; i < parts.length; i++) {
        if (!parts[i]) continue
        switch (parts[i]) {
          case "--dry-run":
            options.dryRun = true
            break
          case "--abandon":
            options.abandonUnfinished = true
            break
          case "--orphans":
            options.orphans = true
            break
          case "--older-than":
            i++
            if (i < parts.length) {
              options.olderThan = parseInt(parts[i], 10)
              if (isNaN(options.olderThan)) {
                ctx.ui.notify(`Invalid --older-than value: ${parts[i]}`, "error")
                return
              }
            }
            break
          default:
            if (parts[i].startsWith("--")) {
              ctx.ui.notify(`Unknown option: ${parts[i]}`, "warning")
            } else {
              targetInput = targetInput ? `${targetInput} ${parts[i]}` : parts[i]
            }
            break
        }
      }

      if (targetInput) {
        const target = await resolveChangeImplementTarget(targetInput)
        options.changeId = target.changeId
        options.abandonUnfinished = true
        if (target.manifestPath && target.durableChangeId && target.durableChangeId !== target.changeId) {
          ctx.ui.notify(
            `🧹 Resolved durable change docs "${target.durableChangeId}" to runtime plan "${target.changeId}" for cleanup.`,
            "info",
          )
        }
      }

      const cleanProgress = createWorkflowProgressIndicator(pi, ctx, targetInput || "all", {
        command: "zflow-clean",
        model: undefined,
        initialMessage: options.dryRun ? "Dry-run cleanup preview" : "Running cleanup",
        statusId: "zflow-clean",
        widgetId: "zflow-clean-progress",
      })

      try {
        const result = await runCleanWorkflow(options)

        cleanProgress.update(result.summary)
        if (result.abandonedRuns.length > 0) {
          cleanProgress.update(
            `${options.dryRun ? "Would abandon" : "Abandoned"} ${result.abandonedRuns.length} unfinished run(s): ${result.abandonedRuns.join(", ")}`,
          )
        } else if (options.changeId && options.abandonUnfinished) {
          cleanProgress.update(`No unfinished runs found for change "${options.changeId}".`)
        }

        cleanProgress.stop(
          options.dryRun
            ? `Preview: ${result.cleaned} artifact(s) would be cleaned, ${result.kept} kept.`
            : result.errors.length > 0
              ? `Cleaned ${result.cleaned} artifact(s). ${result.errors.length} error(s) occurred.`
              : `Cleaned ${result.cleaned} artifact(s).`,
        )
      } catch (err: unknown) {
        cleanProgress.stop(
          `Cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
          "failed",
        )
      }
    },
  })

  // ── Command: /zflow-change-plan ───────────────────────────────

  pi.registerCommand("zflow-change-plan", {
    description: "Create or update the durable plan.md entrypoint for a change",
    handler: async (args: string, ctx: InterviewableContext): Promise<void> => {
      let parsedArgs = parseChangePlanArgs(args)
      let changeDescription = parsedArgs.explicitReference
        ? parsedArgs.notes.trim()
        : (parsedArgs.notes || parsedArgs.changeSeed).trim()

      if (!parsedArgs.changeSeed || !changeDescription) {
        const prompted = await promptForChangePlanInput(ctx)
        if (!prompted?.changeDescription) {
          ctx.ui.notify(
            "Usage: /zflow-change-plan <description|change-id|path> [-- notes]",
            "warning",
          )
          return
        }

        if (prompted.preferredChangeId) {
          parsedArgs = {
            changeSeed: prompted.preferredChangeId,
            notes: prompted.changeDescription,
            explicitReference: true,
          }
        } else if (parsedArgs.explicitReference && parsedArgs.changeSeed) {
          parsedArgs = {
            changeSeed: parsedArgs.changeSeed,
            notes: prompted.changeDescription,
            explicitReference: true,
          }
        } else {
          parsedArgs = {
            changeSeed: prompted.changeDescription,
            notes: prompted.changeDescription,
            explicitReference: false,
          }
        }
        changeDescription = prompted.changeDescription
      }

      const referencedPath = parsedArgs.explicitReference
        ? parsedArgs.changeSeed
        : extractChangePlanReference(changeDescription)

      const progress = createWorkflowProgressIndicator(pi, ctx, parsedArgs.changeSeed, {
        command: "zflow-change-plan",
        initialMessage: "Collecting change context and drafting a detailed durable plan.md",
      })

      try {
        progress.updatePhaseCard(
          "resolve-change-plan-input",
          "Resolve change input",
          "Deriving durable change id from command input",
          "running",
        )

        const changeId = deriveChangePlanId(parsedArgs.changeSeed, parsedArgs.explicitReference)
        if (!changeId) {
          progress.updatePhaseCard(
            "resolve-change-plan-input",
            "Resolve change input",
            `Could not derive a semantic changeId from: ${parsedArgs.changeSeed}`,
            "failed",
          )
          progress.stop("zflow-change-plan failed", "failed")
          ctx.ui.notify(
            `Could not derive a semantic changeId from: ${parsedArgs.changeSeed}`,
            "warning",
          )
          return
        }

        progress.updatePhaseCard(
          "resolve-change-plan-input",
          "Resolve change input",
          `Derived changeId: ${changeId}`,
          "completed",
        )
        progress.updatePhaseCard(
          "draft-durable-plan",
          "Draft durable plan",
          `Building detailed docs/zflow-changes/${changeId}/plan.md`,
          "running",
        )

        const result = await runChangePlanWorkflow({
          cwd: ctx.cwd,
          changeId,
          changeSeed: parsedArgs.changeSeed,
          changeDescription,
          changeReferencePath: referencedPath ?? undefined,
          explicitReference: parsedArgs.explicitReference,
          sourceMode: referencedPath && isRuneContextReference(referencedPath)
            ? "runecontext"
            : "adhoc",
          onProgress: (message) => progress.update(message),
          onAgentProgress: (agentProgress) => {
            progress.updateSubagent("change-plan-drafter", {
              agent: "planner",
              title: "Draft durable plan.md",
              status: "running",
              lastCommand: agentProgress.currentTool
                ? `${agentProgress.currentTool}${agentProgress.currentToolArgs ? ` ${agentProgress.currentToolArgs}` : ""}`
                : agentProgress.recentTools?.at(-1)?.tool,
            })
            progress.update(`planner: ${agentProgress.status ?? "running"}`)
          },
        })

        progress.updateSubagent("change-plan-drafter", {
          agent: "planner",
          title: "Draft durable plan.md",
          status: "completed",
        })
        progress.updatePhaseCard(
          "draft-durable-plan",
          "Draft durable plan",
          `${result.existingPlanUpdated ? "Updated" : "Created"} ${result.planDocPath}`,
          "completed",
        )
        progress.stop("zflow-change-plan finished", "completed")

        ctx.ui.notify(
          `${result.existingPlanUpdated ? "📝 Updated" : "📝 Created"} durable plan entrypoint for \"${changeId}\".`,
          "info",
        )
        ctx.ui.notify(`Plan entrypoint: ${result.planDocPath}`, "info")
        if (!parsedArgs.explicitReference) {
          ctx.ui.notify(`Derived changeId: ${changeId}`, "info")
        }
        ctx.ui.notify(
          `Review and refine ${result.planDocPath}, then run /zflow-change-prepare ${changeId} to generate versioned change docs.`,
          "info",
        )
      } catch (error) {
        progress.updateSubagent("change-plan-drafter", {
          agent: "planner",
          title: "Draft durable plan.md",
          status: "failed",
        })
        progress.stop("zflow-change-plan failed", "failed")
        throw error
      }
    },
  })

  // ── Command: /zflow-change-prepare ────────────────────────────

  pi.registerCommand("zflow-change-prepare", {
    description: "Run the formal change preparation workflow for a given change path or RuneContext",
    handler: async (args: string, ctx: InterviewableContext): Promise<void> => {
      const parsedArgs = parseChangePrepareArgs(args)
      const changePath = parsedArgs.changePath
      if (!changePath) {
        ctx.ui.notify("Usage: /zflow-change-prepare <change-id|change-folder|plan-file>", "warning")
        return
      }

      // Step 0: Profile preflight (Phase 7 — Profile.ensureResolved() is step 1)
      await ensureProfileResolved(ctx)

      // Set active workflow mode so before_agent_start injects the change-prepare fragment
      setActiveWorkflowMode("change-prepare")
      const cleanupMode = () => { resetWorkflowState() }

      // Derive the semantic change ID used by the prepare workflow.
      const pathSlug = deriveSemanticChangeId(changePath)

      // Check for unfinished work via checkUnfinishedOnEntry if we can derive changeId
      if (pathSlug) {
        const unfinishedCheck = await checkUnfinishedOnEntry(pathSlug, ctx.cwd)
        if (unfinishedCheck.hasUnfinishedWork) {
          const choices = unfinishedCheck.choices.map(
            (c) => `  - ${c.action}: ${c.description}`,
          ).join("\n")
          ctx.ui.notify(
            `⚠️ Unfinished work detected for change matching "${pathSlug}".\n\n` +
            `Last phase: ${unfinishedCheck.lastPhase}\n` +
            `Unfinished runs: ${unfinishedCheck.unfinishedRunIds.join(", ")}\n` +
            `\nAvailable options:\n${choices}\n\n` +
            "Use /zflow-clean or manually resolve before retrying, or proceed with a different change path.",
            "warning",
          )
          cleanupMode()
          return
        }
      }

      const workflowModel = await resolveWorkflowModel("zflow.planner-frontier")
      ctx.ui.notify(`📋 Preparing change plan for "${changePath}"...`)
      const progress = createWorkflowProgressIndicator(pi, ctx, changePath, {
        command: "zflow-change-prepare",
        model: workflowModel.model ?? "unavailable",
        thinking: workflowModel.thinking ?? "unavailable",
        initialMessage: "Initializing change preparation",
        statusId: "zflow-prepare",
      })

      try {
        // Step 1: Run the initial prepare workflow (creates plan state, version dir, etc.)
        const result = await runChangePrepareWorkflow({
          changePath,
          cwd: ctx.cwd,
          forceAdHoc: parsedArgs.forceAdHoc,
          prepareNotes: parsedArgs.notes,
          onProgress: (message, type) => {
            progress.update(message)
            ctx.ui.notify(message, type)
          },
        })

        ctx.ui.notify(
          `✅ Phase 1 complete: Plan created for change "${result.changeId}" (${result.planVersion}).`,
          "info",
        )
        ctx.ui.notify(
          `   Plan state at: ${result.planStatePath}`,
          "info",
        )

        if (!result.agentDispatchResult.dispatched) {
          const status = result.agentDispatchResult.agentDispatchStatus
          const error = result.agentDispatchResult.error
          ctx.ui.notify(
            `⚠️ Planner agent dispatch did not complete (${status}).\n` +
            (error ? `Reason: ${error}\n` : "") +
            `Plan artifacts were not generated, so validation/review/approval will not run.`,
            "warning",
          )
          return
        }

        ctx.ui.notify(
          `✅ Planner agent completed via ${result.agentDispatchResult.serviceName}.` +
          `${result.agentDispatchResult.methodUsed}.`,
          "info",
        )

        // Check if RuneContext was detected as canonical — notify the user
        const planStateRuneContext = (result.initialPlanState as Record<string, unknown>)?.runeContext as Record<string, unknown> | undefined
        if (planStateRuneContext && (planStateRuneContext as Record<string, unknown>).canonical === true) {
          const docs = (planStateRuneContext as Record<string, unknown>).canonicalDocs as string[] | undefined
          ctx.ui.notify(
            `📋 RuneContext detected for "${changePath}".\n` +
            `   Canonical RuneContext docs will be used as the requirements source.\n` +
            (docs && docs.length > 0 ? `   Available docs: ${docs.join(", ")}` : ""),
            "info",
          )
        }

        // Step 2a: Validate plan artifacts (format contract check)
        ctx.ui.notify(`🔍 Validating plan artifacts for "${result.changeId}" ${result.planVersion}...`, "info")
        const validation = await runPlanValidation(result.changeId, result.planVersion, ctx.cwd)
        if (validation.pass) {
          await advancePlanLifecycle(result.changeId, "validated", ctx.cwd)
          ctx.ui.notify(`✅ Plan validation passed for "${result.changeId}" ${result.planVersion}.`, "info")
        } else {
          ctx.ui.notify(
            `⚠️ Plan validation found issues:\n${validation.issues.map((i) => `  - ${i}`).join("\n")}`,
            "warning",
          )
          ctx.ui.notify(
            `Plan artifacts need attention before review or approval.\n` +
            `The planner must produce complete artifacts at:\n` +
            `  - design: ${result.artifactPaths.design}\n` +
            `  - execution-groups: ${result.artifactPaths.executionGroups}\n` +
            `  - standards: ${result.artifactPaths.standards}\n` +
            `  - verification: ${result.artifactPaths.verification}\n` +
            `  - implementation-tasks: ${result.artifactPaths.implementationTasks}\n\n` +
            `No approval prompt will be shown until validation passes.`,
            "warning",
          )
          return
        }

        // Step 2b: Run detailed artifact format validation
        ctx.ui.notify(`🔍 Checking artifact format contracts for "${result.changeId}"...`, "info")
        const formatValidation = await validateAllPlanArtifacts(result.changeId, result.planVersion, ctx.cwd)
        if (!formatValidation.valid) {
          const details = formatValidation.results
            .filter((r) => !r.valid)
            .map((r) => `  - **${r.artifact}**: ${r.issues.join("; ")}`)
            .join("\n")
          ctx.ui.notify(
            `⚠️ Format validation failed for "${result.changeId}":\n${details}\n\n` +
            `Plan approval requires all artifacts to pass format validation. ` +
            `The planner attempted repair during preparation. Review the errors above ` +
            `and either rerun /zflow-change-prepare or manually fix the artifacts.`,
            "warning",
          )
          return
        }
        ctx.ui.notify(`✅ All format contracts pass for "${result.changeId}".`, "info")

        // Step 3: Run plan review
        ctx.ui.notify(`📋 Running plan review for "${result.changeId}" ${result.planVersion}...`, "info")
        const reviewResult = await runPlanReview(result.changeId, result.planVersion, ctx.cwd)
        if (reviewResult.pass) {
          await advancePlanLifecycle(result.changeId, "reviewed", ctx.cwd)
          ctx.ui.notify(`✅ Plan review passed for "${result.changeId}".`, "info")
        } else {
          ctx.ui.notify(
            `⚠️ Plan review found issues: ${reviewResult.summary}`,
            "warning",
          )
        }

        // Step 4: Publish durable plan artifacts to repo-visible path
        ctx.ui.notify(`📤 Publishing durable plan artifacts for "${result.changeId}"...`, "info")
        const publishResult = await publishPlanArtifacts(
          result.changeId,
          result.planVersion,
          {
            cwd: ctx.cwd,
            reviewFindingsPath: reviewResult.reviewFindingsPath,
          },
        )

        if (publishResult.artifactCount < 5) {
          const missing = Object.keys(publishResult.publishedArtifacts).length
          ctx.ui.notify(
            `⚠️  Durable publish completed with errors: ${missing}/5 artifacts published.\n` +
            publishResult.errors.map((e) => `  - ${e}`).join("\n"),
            "warning",
          )
          ctx.ui.notify(
            `Cannot proceed to approval — not all five required plan artifacts were published.\n` +
            `Check planner output and runtime artifact paths:\n` +
            `  - design: ${result.artifactPaths.design}\n` +
            `  - execution-groups: ${result.artifactPaths.executionGroups}\n` +
            `  - standards: ${result.artifactPaths.standards}\n` +
            `  - verification: ${result.artifactPaths.verification}\n` +
            `  - implementation-tasks: ${result.artifactPaths.implementationTasks}`,
            "warning",
          )
          if (publishResult.errors.length > 0) {
            ctx.ui.notify(
              `Publishing errors:\n${publishResult.errors.join("\n")}`,
              "error",
            )
          }
          return
        }

        const durableVersions = await listPublishedDurablePlanVersions(result.changeId, { cwd: ctx.cwd })
        await writeDurablePlanDoc(
          result.changeId,
          {
            status: reviewResult.pass ? "reviewed" : "validated",
            currentVersion: result.planVersion,
          },
          {
            cwd: ctx.cwd,
            publishedVersions: durableVersions,
          },
        )

        ctx.ui.notify(
          `✅ Durable plan artifacts published to: ${publishResult.durableDir}`,
          "info",
        )

        const inspectionSummary = formatPlanInspectionPaths({
          changeId: result.changeId,
          planVersion: result.planVersion,
          planStatePath: result.planStatePath,
          artifactPaths: result.artifactPaths,
          reviewFindingsPath: reviewResult.reviewFindingsPath,
          durableDir: publishResult.durableDir,
          publishedArtifacts: publishResult.publishedArtifacts,
          publishErrors: publishResult.errors.length > 0 ? publishResult.errors : undefined,
        })
        ctx.ui.notify(inspectionSummary, "info")

        // Step 5: Run structured interview for plan approval
        const approvalQuestions = buildPlanApprovalQuestions(
          result.changeId,
          result.planVersion,
          `Change path: ${changePath}\nReview status: ${reviewResult.pass ? "passed" : "needs attention"}\nValidation: ${validation.pass ? "passed" : "has issues"}\n\nDurable plan docs published to: ${publishResult.durableDir}\n\n${inspectionSummary}`,
        )

        let interviewResult: { decision: string; revisionNotes?: string; selectedFindings?: string[] } | null = null
        while (true) {
          interviewResult = await runStructuredInterview(
            ctx,
            approvalQuestions,
            `Plan "${result.changeId}" version ${result.planVersion} is ready. ` +
            `Review the durable docs at ${publishResult.durableDir} then use the interactive UI to inspect, approve, request revisions, or cancel.`,
          )

          if (!interviewResult) {
            // No usable UI at all — log paths for manual inspection
            ctx.ui.notify(
              `📌 Plan "${result.changeId}" version ${result.planVersion} is ready for review.\n` +
              `Repo-visible change documents:\n` +
              Object.entries(publishResult.publishedArtifacts).map(([k, v]) => `  - ${k}: ${v}`).join("\n") +
              `\n\nRuntime artifacts:\n` +
              `  - design: ${result.artifactPaths.design}\n` +
              `  - execution-groups: ${result.artifactPaths.executionGroups}\n` +
              `  - standards: ${result.artifactPaths.standards}\n` +
              `  - verification: ${result.artifactPaths.verification}\n` +
              `  - implementation-tasks: ${result.artifactPaths.implementationTasks}\n\n` +
              `Use /zflow-change-audit ${result.changeId} to inspect.`,
              "info",
            )
            return
          }

          if (interviewResult.decision !== "inspect") break
          ctx.ui.notify(
            `${inspectionSummary}\n\nReview the files, then return to the decision prompt to approve, request revisions, or cancel.`,
            "info",
          )
        }

        switch (interviewResult.decision) {
          case "approve": {
            await approvePlanVersion(result.changeId, result.planVersion, ctx.cwd)
            await writeDurablePlanDoc(
              result.changeId,
              {
                status: "approved",
                currentVersion: result.planVersion,
                approvedVersion: result.planVersion,
              },
              {
                cwd: ctx.cwd,
                publishedVersions: await listPublishedDurablePlanVersions(result.changeId, { cwd: ctx.cwd }),
              },
            )
            ctx.ui.notify(
              `✅ Plan "${result.changeId}" version ${result.planVersion} approved.`,
              "info",
            )

            // Implementation is never forked from prepare — always manual.
            ctx.ui.notify(
              `📌 Plan artifacts are ready for change "${result.changeId}" v${result.planVersion}:\n` +
              `    - design: ${result.artifactPaths.design}\n` +
              `    - execution-groups: ${result.artifactPaths.executionGroups}\n` +
              `    - standards: ${result.artifactPaths.standards}\n` +
              `    - verification: ${result.artifactPaths.verification}\n` +
              `    - implementation-tasks: ${result.artifactPaths.implementationTasks}\n\n` +
              `  When you are ready to implement, run:\n` +
              `    /zflow-change-implement ${result.changeId}`,
              "info",
            )
            break
          }
          case "revise": {
            await bumpPlanVersion(result.changeId, ctx.cwd)
            await advancePlanLifecycle(result.changeId, "draft", ctx.cwd)
            await writeDurablePlanDoc(
              result.changeId,
              {
                status: "draft",
                currentVersion: result.planVersion,
              },
              {
                cwd: ctx.cwd,
                publishedVersions: await listPublishedDurablePlanVersions(result.changeId, { cwd: ctx.cwd }),
              },
            )
            ctx.ui.notify(
              `📝 Revision requested for "${result.changeId}". ` +
              (interviewResult.revisionNotes
                ? `Notes: ${interviewResult.revisionNotes}`
                : "A new plan version will be created."),
              "info",
            )
            break
          }
          case "cancel": {
            await updatePlanState(result.changeId, {
              lifecycleState: "cancelled",
            }, ctx.cwd)
            await writeDurablePlanDoc(
              result.changeId,
              {
                status: "cancelled",
                currentVersion: result.planVersion,
              },
              {
                cwd: ctx.cwd,
                publishedVersions: await listPublishedDurablePlanVersions(result.changeId, { cwd: ctx.cwd }),
              },
            )
            ctx.ui.notify(
              `🛑 Plan "${result.changeId}" version ${result.planVersion} cancelled by user.`,
              "warning",
            )
            break
          }
          case "inspect": {
            ctx.ui.notify(
              `${inspectionSummary}\n\n` +
              `When ready, rerun /zflow-change-prepare ${changePath} or use /zflow-change-audit ${result.changeId} to inspect without approval.`,
              "info",
            )
            break
          }
          default: {
            // "inspect" or unknown — log paths for manual review
            ctx.ui.notify(
              `📌 Plan "${result.changeId}" version ${result.planVersion} is ready for review.\n` +
              `Decision: ${interviewResult.decision}. Use /zflow-change-audit ${result.changeId} to inspect.`,
              "info",
            )
            break
          }
        }
      } catch (err: unknown) {
        progress.stop(
          `Change preparation failed: ${err instanceof Error ? err.message : String(err)}`,
          "failed",
        )
        ctx.ui.notify(
          `Change preparation failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        )
      } finally {
        progress.stop("zflow-change-prepare finished")
        // Clear mode and reminders regardless of outcome
        resetWorkflowState()
      }
    },
  })

  // ── Command: /zflow-resolve-apply-back ────────────────────────

  pi.registerCommand("zflow-resolve-apply-back", {
    description: "Resolve a failed apply-back using a subagent and preserved integration worktree",
    handler: async (args: string, ctx: InterviewableContext): Promise<void> => {
      setActiveWorkflowMode("change-implement")
      const cleanupMode = (): void => { resetWorkflowState() }

      const runId = args.trim().split(/\s+/).filter(Boolean)[0]
      if (!runId) {
        ctx.ui?.notify?.(
          "Usage: /zflow-resolve-apply-back <run-id>\n\n" +
          "Runs a resolver subagent in the preserved integration worktree, verifies coverage, " +
          "and applies the verified consolidated patch to the primary worktree.",
          "warning",
        )
        cleanupMode()
        return
      }

      const model = await resolveWorkflowModel("zflow.implement-hard")
      const progress = createWorkflowProgressIndicator(pi, ctx, runId, {
        command: "zflow-resolve-apply-back",
        model: model.model ?? "resolved",
        thinking: model.thinking ?? "unavailable",
        initialMessage: "Preparing apply-back resolver",
        statusId: "zflow-resolve-apply-back",
        widgetId: "zflow-resolve-apply-back-progress",
      })
      progress.updatePhaseCard("prepare", "Prepare Resolution", "Loading run artifacts", "running")

      try {
        await resolveApplyBackWithSubagent(runId, ctx, {
          onProgress: (message) => progress.update(message),
          onPhase: (id, title, message, status = "running") => progress.updatePhaseCard(id, title, message, status),
          onSubagent: (id, update) => progress.updateSubagent(id, update),
        })
        progress.updatePhaseCard("complete", "Resolution Complete", "Apply-back resolution completed", "completed")
        progress.stop("Apply-back resolution complete", "completed")
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        progress.updatePhaseCard("complete", "Resolution Needs Attention", message, "failed")
        progress.stop("Apply-back resolution failed", "failed")
        ctx.ui?.notify?.(
          `Apply-back subagent resolution failed: ${message}`,
          "error",
        )
      } finally {
        cleanupMode()
      }
    },
  })

  // ── Command: /zflow-change-implement ──────────────────────────

  pi.registerCommand("zflow-change-implement", {
    description: "Execute the approved plan for a change — worktree dispatch, verification, review",
    handler: async (args: string, ctx: InterviewableContext): Promise<void> => {
      // Parse flags from args
      const parts = args.trim().split(/\s+/)
      const force = parts.includes("--force")
      const manualDispatchComplete = parts.includes("--manual-dispatch-complete")
      const abandonUnfinished = parts.includes("--abandon") || parts.includes("--abandon-unfinished")
      const resumeEnabled = parts.includes("--resume")
      const failedOnly = parts.includes("--failed-only")
      const applySuccessful = parts.includes("--apply-successful")
      const forceApplySuccessful = parts.includes("--force-apply-successful")
      const changeInput = parts.filter(p => !p.startsWith("--")).join(" ")

      const usageText =
        "Usage: /zflow-change-implement <change-id-or-docs-path> [options]\n\n" +
        "  <change-id-or-docs-path>       Runtime change ID, or docs/zflow-changes/<id>/[version/] path.\n\n" +
        "  Options:\n" +
        "  --force                       Proceed even if the primary worktree has uncommitted changes.\n" +
        "  --abandon                     Mark unfinished runs for this change abandoned, then start fresh.\n" +
        "  --manual-dispatch-complete    Skip worktree dispatch and proceed directly to verification.\n" +
        "  --resume                      Resume latest unfinished/partial run, dispatching only failed/pending groups.\n" +
        "  --failed-only                 Same as --resume; only retry groups that failed in a partial run.\n" +
        "  --apply-successful            Apply successful group patches despite failed groups (safe check).\n" +
        "  --force-apply-successful       Force apply successful patches even if overlaps exist.\n\n" +
        "  Partial run flags (--resume, --failed-only, --apply-successful, --force-apply-successful)\n" +
        "  use the durable group ledger tracked throughout the implementation lifecycle.\n" +
        "  Inspect status with: /zflow-change-audit <change-id>"

      if (!changeInput) {
        ctx.ui.notify(usageText, "warning")
        return
      }

      // ── Parse partial-run flags ───────────────────────────────
      const useResume = resumeEnabled || failedOnly
      const useApplySuccessful = applySuccessful || forceApplySuccessful
      const useForceApplySuccessful = forceApplySuccessful

      if (useResume || useApplySuccessful) {
        // ── Partial/Resume apply path ────────────────────────────
        const implementTarget = await resolveChangeImplementTarget(changeInput)
        const changeId = implementTarget.changeId

        await ensureProfileResolved(ctx)
        setActiveWorkflowMode("change-implement")
        const cleanupMode = (): void => { resetWorkflowState() }

        const partialRunId = await findBestResumeRun(changeId, ctx.cwd)
        if (!partialRunId) {
          ctx.ui.notify(
            `No unfinished run found for change "${changeId}". ` +
            "Starting a full implementation run.\n" +
            usageText,
            "warning",
          )
        }

        if (useApplySuccessful) {
          // ── Apply successful groups path ────────────────────────
          if (!partialRunId) {
            ctx.ui.notify(`No previous run found for "${changeId}". Nothing to apply.`, "error")
            cleanupMode()
            return
          }

          ctx.ui.notify(
            `📋 Applying successful group patches from run "${partialRunId}"...`,
            "info",
          )

          // Read the run to get planVersion for reconciler
          const { default: runStateFs } = await import("node:fs/promises")
          const { readRun } = await import("pi-zflow-artifacts")
          let runData: Record<string, unknown>
          try {
            runData = await readRun(partialRunId, ctx.cwd) as unknown as Record<string, unknown>
          } catch {
            ctx.ui.notify(`Cannot read run "${partialRunId}".`, "error")
            cleanupMode()
            return
          }
          const planVersion = (runData.planVersion as string) ?? "v1"

          // Run reconciliation to find which patches are reusable
          const reconciliation = await reconcileResumeState(partialRunId, changeId, planVersion, ctx.cwd)
          if (!reconciliation.hasPreviousRun) {
            ctx.ui.notify(`No previous run data found for "${partialRunId}".`, "error")
            cleanupMode()
            return
          }

          ctx.ui.notify(
            `📋 Apply-back analysis: ${reconciliation.reusableGroups.length} group(s) reusable, ` +
            `${reconciliation.groupsNeedingRerun.length} need rerun. Applying via smart cascade...`,
            "info",
          )

          try {
            // Use the smart cascade via applyPatchesWithLedger
            const cascadeResult = await applyPatchesWithLedger(partialRunId, ctx.cwd, {
              applyAll: true,
              onProgress: (msg) => ctx.ui.notify(msg, "info"),
            })

            if (cascadeResult.success) {
              ctx.ui.notify(
                `✅ Applied all patches successfully via "${cascadeResult.successfulStrategy ?? "patch-replay"}" strategy.`,
                "info",
              )
              // Update ledger for applied groups
              for (const g of reconciliation.reusableGroups) {
                await updateGroupLedger(partialRunId, g.groupId, {
                  status: "applied",
                  appliedToPrimary: true,
                }, ctx.cwd).catch(() => {})
              }
            } else {
              const failureMsg = await formatApplyBackFailureMessage(
                partialRunId,
                changeInput,
                cascadeResult.error ?? "Apply-back could not be automatically verified",
                ctx.cwd,
                {
                  patchesDir: path.join(resolveRunDir(partialRunId, ctx.cwd), "patches"),
                  integrationWorktreePath: cascadeResult.integrationWorktreePath,
                  strategiesAttempted: cascadeResult.strategiesAttempted,
                },
              )
              ctx.ui.notify(failureMsg, "warning")
              if (cascadeResult.subagentAvailable) {
                const runDir = resolveRunDir(partialRunId, ctx.cwd)
                const resolutionPrompt = await buildSubagentResolutionPrompt(
                  partialRunId,
                  changeId,
                  reconciliation.reusableGroups.map((g) => ({
                    id: g.groupId,
                    files: [],
                    taskPrompt: "",
                  })),
                  ctx.cwd,
                )
                await import("node:fs/promises").then((fs2) =>
                  fs2.writeFile(
                    path.join(runDir, "subagent-resolution-prompt.md"),
                    resolutionPrompt,
                    "utf-8",
                  )
                )
                ctx.ui.notify(
                  `🤖 Subagent resolution prompt written to: ${path.join(runDir, "subagent-resolution-prompt.md")}\n` +
                  `  Then run: /zflow-resolve-apply-back ${partialRunId}`,
                  "info",
                )
              }
            }

            // Check if all groups are now applied
            const updatedLedger = await getGroupLedger(partialRunId, ctx.cwd)
            const allDone = Object.values(updatedLedger).every((e) =>
              e.status === "applied" || e.status === "skipped"
            )
            if (allDone) {
              ctx.ui.notify(
                "✅ All groups applied. To run final verification and code review:\n" +
                `  /zflow-change-implement ${changeInput} --manual-dispatch-complete`,
                "info",
              )
            }
          } catch (err: unknown) {
            ctx.ui.notify(
              `Apply failed: ${err instanceof Error ? err.message : String(err)}`,
              "error",
            )
          }

          cleanupMode()
          return
        }

        // ── Resume path (smart reconciler) ──────────────────────
        // partialRunId is already set via findBestResumeRun above
        if (partialRunId) {
          // Read the run to get metadata
          const { readRun } = await import("pi-zflow-artifacts")
          let runData: Record<string, unknown>
          try {
            runData = await readRun(partialRunId, ctx.cwd) as unknown as Record<string, unknown>
          } catch {
            ctx.ui.notify(
              `Cannot read run "${partialRunId}". Cannot resume.`,
              "error",
            )
            cleanupMode()
            return
          }

          const planVersion = (runData.planVersion as string) ?? "v1"
          const resumeChangeId = (runData.changeId as string) ?? changeId

          // Run reconciliation to understand what can be reused
          const reconciliation = await reconcileResumeState(
            partialRunId,
            resumeChangeId,
            planVersion,
            ctx.cwd,
          )

          if (!reconciliation.hasPreviousRun) {
            ctx.ui.notify(
              `No previous run data found for "${partialRunId}". Starting fresh.`,
              "warning",
            )
            // Fall through to full dispatch below
          } else {
            // Show reconciliation summary
            ctx.ui.notify(
              `📋 Resume analysis:\n` +
              `  - Found previous run: ${partialRunId}\n` +
              `  - ${reconciliation.reusableGroups.length} group(s) with reusable patches\n` +
              `  - ${reconciliation.groupsNeedingRerun.length} group(s) need rerun\n` +
              `  - ${reconciliation.alreadyAppliedGroups.length} group(s) already applied\n` +
              `  - Apply-back needed: ${reconciliation.applyBackNeeded}\n` +
              `  - Recommended next step: ${reconciliation.recommendedNextStep}\n` +
              reconciliation.summary,
              "info",
            )

            // ── Step 1: Rerun groups that need it ────────────────
            if (reconciliation.groupsNeedingRerun.length > 0) {
              const dispatchService = await tryGetDispatchServiceViaRegistry().catch(() => null)
              if (!dispatchService) {
                ctx.ui.notify(
                  "⚠️ Groups need rerun but no dispatch service available.\n" +
                  "Use --apply-successful to apply existing patches only, or install pi-subagents.",
                  "error",
                )
                cleanupMode()
                return
              }

              const implementModel = await resolveWorkflowModel("zflow.implement-routine")
              const implProgress = createWorkflowProgressIndicator(pi, ctx, changeInput, {
                command: "zflow-change-implement",
                model: implementModel.model ?? "unavailable",
                thinking: implementModel.thinking ?? "unavailable",
                initialMessage: "Resuming with rerun for failed groups",
                statusId: "zflow-implement",
                widgetId: "zflow-implement-progress",
              })

              try {
                implProgress.update(
                  `Rerunning ${reconciliation.groupsNeedingRerun.length} failed/pending group(s) in "${partialRunId}"`,
                )

                const workflowIntercomTarget = ensureWorkflowIntercomTarget(pi, ctx, "implement", resumeChangeId)
                await resumeWorktreeDispatch(
                  partialRunId,
                  resumeChangeId,
                  planVersion,
                  dispatchService,
                  {
                    cwd: ctx.cwd,
                    force,
                    orchestratorTarget: workflowIntercomTarget,
                    targetGroupIds: reconciliation.groupsNeedingRerun.map((group) => group.groupId),
                    onWorkflowUpdate: (message) => implProgress.update(message),
                    onSubagentUpdate: (id, update) => implProgress.updateSubagent(id, update),
                    onRateLimitNotice: (message) => ctx.ui.notify(message, "warning"),
                  },
                )

                implProgress.update("Resume dispatch complete")
                implProgress.stop("Resume dispatch complete")
              } catch (err: unknown) {
                implProgress.stop(
                  `Resume dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
                  "failed",
                )
                cleanupMode()
                return
              }
            }

            // ── Step 2: Apply patches via smart cascade ──────────
            if (reconciliation.applyBackNeeded) {
              ctx.ui.notify(
                "📋 Running smart apply-back cascade...",
                "info",
              )

              const cascadeResult = await applyPatchesWithLedger(partialRunId, ctx.cwd, {
                applyAll: true,
                onProgress: (msg) => ctx.ui.notify(msg, "info"),
              })

              if (cascadeResult.success) {
                ctx.ui.notify(
                  `✅ Apply-back completed: ${cascadeResult.groupsApplied} group(s) applied ` +
                  `via "${cascadeResult.successfulStrategy ?? "patch-replay"}" strategy.`,
                  "info",
                )

                // Mark reusable+applied groups
                for (const g of reconciliation.reusableGroups) {
                  if (!g.alreadyApplied) {
                    await updateGroupLedger(partialRunId, g.groupId, {
                      status: "applied",
                      appliedToPrimary: true,
                    }, ctx.cwd).catch(() => {})
                  }
                }

                // ── Step 3: Post-start sequence (verification, review) ──
                const postStartModel = await resolveWorkflowModel("zflow.implement-routine")
                const implProgress = createWorkflowProgressIndicator(pi, ctx, changeInput, {
                  command: "zflow-change-implement",
                  model: postStartModel.model ?? "unavailable",
                  thinking: postStartModel.thinking ?? "unavailable",
                  initialMessage: "Continuing to final verification and review",
                  statusId: "zflow-implement",
                  widgetId: "zflow-implement-progress",
                })

                const updatePostImplementationCard = (message: string): void => {
                  const normalized = message.toLowerCase()
                  if (normalized.includes("verification skipped") || normalized.includes("skipped —") || normalized.includes("gating")) {
                    implProgress.updatePhaseCard("post-implementation", "Post Implementation", "Verification skipped — needs review", "failed")
                    implProgress.updatePhaseCard("code-review", "Code Review", "Verification skipped; code review blocked", "failed")
                    return
                  }
                  if (normalized.includes("running code review")) {
                    implProgress.updatePhaseCard("post-implementation", "Post Implementation", "Verification complete", "completed")
                    implProgress.updatePhaseCard("code-review", "Code Review", message, "running")
                    return
                  }
                  if (normalized.includes("code review passed")) {
                    implProgress.updatePhaseCard("code-review", "Code Review", message, "completed")
                    implProgress.updatePhaseCard("post-code-review", "Post Code Review", "Preparing final workflow completion", "running")
                    return
                  }
                  if (normalized.includes("code review found") || normalized.includes("review failed")) {
                    implProgress.updatePhaseCard("code-review", "Code Review", message, "failed")
                    implProgress.updatePhaseCard("post-code-review", "Post Code Review", "Review failed; preparing next steps", "failed")
                    return
                  }
                  if (normalized.includes("persisting completed") || normalized.includes("workflow completion persisted")) {
                    implProgress.updatePhaseCard("post-code-review", "Post Code Review", message, normalized.includes("persisted") ? "completed" : "running")
                    return
                  }
                  const postStatus = normalized.includes("final verification passed") ? "completed" : "running"
                  implProgress.updatePhaseCard("post-implementation", "Post Implementation", message, postStatus)
                  if (normalized.includes("final verification passed")) {
                    implProgress.updatePhaseCard("code-review", "Code Review", "Waiting for code review to start", "running")
                  }
                }

                updatePostImplementationCard("Starting final verification, review, and completion")
                const onReviewerUpdate = (reviewerUpdate: {
                  reviewerName: string; agentName: string
                  status: "queued" | "running" | "completed" | "failed"
                  model?: string; thinking?: string
                  currentTool?: string; lastCommand?: string
                }): void => {
                  implProgress.updateReviewer(reviewerUpdate.reviewerName, reviewerUpdate)
                }
                const postResult = await runImplementationPostStartSequence(
                  partialRunId,
                  {
                    skipDispatchWait: false,
                    onProgress: updatePostImplementationCard,
                    onReviewerUpdate,
                  },
                )

                const finalCardStatus = postResult.status === "completed" ? "completed" : "failed"
                const finalCardTitle = postResult.status === "completed" ? "Workflow Complete" : "Workflow Needs Attention"
                implProgress.updatePhaseCard("workflow-complete", finalCardTitle, `Phase: ${postResult.phase}, status: ${postResult.status}`, finalCardStatus)
                implProgress.updatePhaseCard("workflow-complete", finalCardTitle, buildWorkflowFinalNextStepsLine(postResult, changeInput), finalCardStatus)
                implProgress.stop(finalCardTitle)
              } else {
                // Apply-back failed — use centralized formatter
                const failureMsg = await formatApplyBackFailureMessage(
                  partialRunId,
                  changeInput,
                  cascadeResult.error ?? "Apply-back could not be automatically verified",
                  ctx.cwd,
                  {
                    patchesDir: path.join(resolveRunDir(partialRunId, ctx.cwd), "patches"),
                    integrationWorktreePath: cascadeResult.integrationWorktreePath,
                    strategiesAttempted: cascadeResult.strategiesAttempted,
                  },
                )
                ctx.ui.notify(failureMsg, "warning")

                // Write subagent resolution prompt
                try {
                  const runDir = resolveRunDir(partialRunId, ctx.cwd)
                  const resolutionPrompt = await buildSubagentResolutionPrompt(
                    partialRunId,
                    resumeChangeId,
                    [...reconciliation.reusableGroups, ...reconciliation.groupsNeedingRerun].map((g) => ({
                      id: g.groupId,
                      files: [],
                      taskPrompt: "",
                    })),
                    ctx.cwd,
                  )
                  const { default: fs3 } = await import("node:fs/promises")
                  await fs3.writeFile(
                    path.join(runDir, "subagent-resolution-prompt.md"),
                    resolutionPrompt,
                    "utf-8",
                  )
                  ctx.ui.notify(
                    `🤖 Subagent resolution prompt written to: ${path.join(runDir, "subagent-resolution-prompt.md")}`,
                    "info",
                  )
                } catch {
                  // Best-effort
                }

                // Update run metadata
                try {
                  const curRun = await readRun(partialRunId, ctx.cwd)
                  await import("pi-zflow-artifacts").then(({ updateRun }) =>
                    updateRun(partialRunId, {
                      metadata: {
                        ...(curRun.metadata ?? {}),
                        subagentResolutionAvailable: true,
                        resolutionPromptPath: path.join(resolveRunDir(partialRunId, ctx.cwd), "subagent-resolution-prompt.md"),
                      },
                    } as any, ctx.cwd)
                  )
                } catch {
                  // Best-effort
                }
              }
            } else if (reconciliation.verificationNeeded) {
              // All groups applied — just continue to verification/review
              const postStartModel = await resolveWorkflowModel("zflow.implement-routine")
              const implProgress = createWorkflowProgressIndicator(pi, ctx, changeInput, {
                command: "zflow-change-implement",
                model: postStartModel.model ?? "unavailable",
                thinking: postStartModel.thinking ?? "unavailable",
                initialMessage: "Continuing to verification and review",
                statusId: "zflow-implement",
                widgetId: "zflow-implement-progress",
              })
              const updatePostImplementationCard = (message: string): void => {
                const normalized = message.toLowerCase()
                if (normalized.includes("verification skipped") || normalized.includes("skipped —") || normalized.includes("gating")) {
                  implProgress.updatePhaseCard("post-implementation", "Post Implementation", "Verification skipped — needs review", "failed")
                  implProgress.updatePhaseCard("code-review", "Code Review", "Verification skipped; code review blocked", "failed")
                  return
                }
                if (normalized.includes("running code review")) {
                  implProgress.updatePhaseCard("post-implementation", "Post Implementation", "Verification complete", "completed")
                  implProgress.updatePhaseCard("code-review", "Code Review", message, "running")
                  return
                }
                if (normalized.includes("code review passed")) {
                  implProgress.updatePhaseCard("code-review", "Code Review", message, "completed")
                  implProgress.updatePhaseCard("post-code-review", "Post Code Review", "Preparing final workflow completion", "running")
                  return
                }
                if (normalized.includes("code review found") || normalized.includes("review failed")) {
                  implProgress.updatePhaseCard("code-review", "Code Review", message, "failed")
                  implProgress.updatePhaseCard("post-code-review", "Post Code Review", "Review failed; preparing next steps", "failed")
                  return
                }
                if (normalized.includes("persisting completed") || normalized.includes("workflow completion persisted")) {
                  implProgress.updatePhaseCard("post-code-review", "Post Code Review", message, normalized.includes("persisted") ? "completed" : "running")
                  return
                }
                const postStatus = normalized.includes("final verification passed") ? "completed" : "running"
                implProgress.updatePhaseCard("post-implementation", "Post Implementation", message, postStatus)
                if (normalized.includes("final verification passed")) {
                  implProgress.updatePhaseCard("code-review", "Code Review", "Waiting for code review to start", "running")
                }
              }
              updatePostImplementationCard("Starting final verification, review, and completion")
              const onReviewerUpdate = (reviewerUpdate: {
                reviewerName: string; agentName: string
                status: "queued" | "running" | "completed" | "failed"
                model?: string; thinking?: string
                currentTool?: string; lastCommand?: string
              }): void => {
                implProgress.updateReviewer(reviewerUpdate.reviewerName, reviewerUpdate)
              }
              const postResult = await runImplementationPostStartSequence(
                partialRunId,
                { skipDispatchWait: false, onProgress: updatePostImplementationCard, onReviewerUpdate },
              )
              const finalCardStatus = postResult.status === "completed" ? "completed" : "failed"
              const finalCardTitle = postResult.status === "completed" ? "Workflow Complete" : "Workflow Needs Attention"
              implProgress.updatePhaseCard("workflow-complete", finalCardTitle, `Phase: ${postResult.phase}, status: ${postResult.status}`, finalCardStatus)
              implProgress.updatePhaseCard("workflow-complete", finalCardTitle, buildWorkflowFinalNextStepsLine(postResult, changeInput), finalCardStatus)
              implProgress.stop(finalCardTitle)
            } else if (reconciliation.reviewNeeded) {
              // ── Review-only continuation ──────────────────────────
              // Verification is already current — skip directly to code review.
              // Persist a durable breadcrumb before starting so we don't get
              // stuck in "executing" if the process exits unexpectedly.
              try {
                const { default: startFs } = await import("node:fs/promises")
                const { readRun, updateRun } = await import("pi-zflow-artifacts")
                const curRun = await readRun(partialRunId, ctx.cwd)
                await updateRun(partialRunId, {
                  metadata: {
                    ...(curRun.metadata ?? {}),
                    reviewStartedAt: new Date().toISOString(),
                  },
                } as any, ctx.cwd)
              } catch {
                // Best-effort — continue anyway
              }

              const reviewModel = await resolveWorkflowModel("zflow.implement-routine")
              const reviewProgress = createWorkflowProgressIndicator(pi, ctx, changeInput, {
                command: "zflow-change-implement",
                model: reviewModel.model ?? "unavailable",
                thinking: reviewModel.thinking ?? "unavailable",
                initialMessage: "Verification is up-to-date. Running code review...",
                statusId: "zflow-implement",
                widgetId: "zflow-implement-progress",
              })
              const updateReviewCard = (message: string): void => {
                const normalized = message.toLowerCase()
                if (normalized.includes("code review passed")) {
                  reviewProgress.updatePhaseCard("code-review", "Code Review", message, "completed")
                  reviewProgress.updatePhaseCard("post-code-review", "Post Code Review", "Preparing final workflow completion", "running")
                  return
                }
                if (normalized.includes("code review found") || normalized.includes("review failed")) {
                  reviewProgress.updatePhaseCard("code-review", "Code Review", message, "failed")
                  reviewProgress.updatePhaseCard("post-code-review", "Post Code Review", "Review failed; preparing next steps", "failed")
                  return
                }
                if (normalized.includes("persisting completed") || normalized.includes("workflow completion persisted")) {
                  reviewProgress.updatePhaseCard("post-code-review", "Post Code Review", message, normalized.includes("persisted") ? "completed" : "running")
                  return
                }
                reviewProgress.updatePhaseCard("code-review", "Code Review", message, "running")
              }
              updateReviewCard("Starting code review on applied implementation")
              const onReviewerUpdate = (reviewerUpdate: {
                reviewerName: string; agentName: string
                status: "queued" | "running" | "completed" | "failed"
                model?: string; thinking?: string
                currentTool?: string; lastCommand?: string
              }): void => {
                reviewProgress.updateReviewer(reviewerUpdate.reviewerName, reviewerUpdate)
              }

              try {
                const reviewResult = await finalizeCodeReview(partialRunId, ctx.cwd, onReviewerUpdate)

                if (reviewResult.pass) {
                  updateReviewCard("✅ Code review passed. Completing workflow...")
                  await completeWorkflow(resumeChangeId, partialRunId, ctx.cwd)
                  updateReviewCard("Workflow completion persisted")
                  ctx.ui.notify(
                    `✅ Workflow completed for change "${resumeChangeId}".`,
                    "info",
                  )
                  reviewProgress.updatePhaseCard("workflow-complete", "Workflow Complete", "Completed", "completed")
                  reviewProgress.stop("Workflow Complete")
                } else {
                  updateReviewCard(`⚠️ Code review found issues`)
                  const reviewRecoveryLine = reviewResult.infrastructureFailure
                    ? `  ${reviewResult.recoveryHint ?? "Run /zflow-setup-agents or /zflow-update-agents, then resume the workflow."}`
                    : "  Use /zflow-change-fix to address findings, then resume."
                  ctx.ui.notify(
                    `⚠️ Code review found issues: ${reviewResult.summary}\n` +
                    (reviewResult.findingsPath
                      ? `  Review findings: ${reviewResult.findingsPath}\n`
                      : "") +
                    reviewRecoveryLine,
                    "warning",
                  )

                  // Mark phase as review-failed and keep lifecycle/index in sync
                  const { setRunPhase } = await import("pi-zflow-artifacts")
                  await setRunPhase(partialRunId, "review-failed", ctx.cwd).catch(() => {})
                  try {
                    const { updateStateIndexEntry, getChangeLifecycle, upsertChangeLifecycle } = await import("pi-zflow-artifacts/state-index")
                    await updateStateIndexEntry(partialRunId, { status: "review-failed" }, ctx.cwd)
                    const lifecycle = await getChangeLifecycle(resumeChangeId, ctx.cwd)
                    if (lifecycle) {
                      await upsertChangeLifecycle({
                        ...lifecycle,
                        lastPhase: "review-failed",
                      }, ctx.cwd)
                    }
                  } catch {
                    // Best-effort state sync
                  }
                  reviewProgress.updatePhaseCard(
                    "workflow-complete",
                    "Workflow Needs Attention",
                    reviewResult.infrastructureFailure
                      ? "Review infrastructure failed; setup agents/config and resume"
                      : "Review failed; use /zflow-change-fix",
                    "failed",
                  )
                  reviewProgress.stop("Review found issues")
                }
              } catch (err: unknown) {
                updateReviewCard("Code review encountered an error")
                ctx.ui.notify(
                  `Code review failed: ${err instanceof Error ? err.message : String(err)}`,
                  "error",
                )
                reviewProgress.updatePhaseCard("workflow-complete", "Workflow Needs Attention", "Code review error; inspect logs", "failed")
                reviewProgress.stop("Code review failed")
              }
            }

            cleanupMode()
            return
          }
        }

        // No partial run found — fall through to full dispatch
      }

      const implementTarget = await resolveChangeImplementTarget(changeInput)
      const changeId = implementTarget.changeId
      if (implementTarget.manifestPath && implementTarget.durableChangeId && implementTarget.durableChangeId !== changeId) {
        ctx.ui.notify(
          `📋 Resolved durable change docs "${implementTarget.durableChangeId}" to runtime plan "${changeId}".`,
          "info",
        )
      }

      // Step 0: Profile preflight (Phase 7 — Profile.ensureResolved() is step 1)
      await ensureProfileResolved(ctx)

      // Set active workflow mode so before_agent_start injects change-implement fragment
      setActiveWorkflowMode("change-implement")
      const cleanupMode = (): void => { resetWorkflowState() }

      // Check for unfinished work on this change (non-resume path)
      const unfinishedCheck = await checkUnfinishedOnEntry(changeId, ctx.cwd)
      if (unfinishedCheck.hasUnfinishedWork) {
        if (abandonUnfinished) {
          const cleanResult = await runCleanWorkflow({
            cwd: ctx.cwd,
            changeId,
            abandonUnfinished: true,
          })
          ctx.ui.notify(
            `🧹 Abandoned ${cleanResult.abandonedRuns.length} unfinished run(s) for "${changeId}": ` +
            `${cleanResult.abandonedRuns.join(", ") || "none"}. Starting fresh...`,
            "info",
          )
        } else {
          const choices = unfinishedCheck.choices.map(
            (c) => `  - ${c.action}: ${c.description}`,
          ).join("\n")
          ctx.ui.notify(
            `⚠️ Unfinished work detected for change "${changeId}".\n\n` +
            `Last phase: ${unfinishedCheck.lastPhase}\n` +
            `Unfinished runs: ${unfinishedCheck.unfinishedRunIds.join(", ")}\n` +
            (unfinishedCheck.retainedWorktrees.length > 0
              ? `Retained worktrees: ${unfinishedCheck.retainedWorktrees.join(", ")}\n`
              : "") +
            `\nAvailable options:\n${choices}\n\n` +
            `To start fresh now, run:\n  /zflow-change-implement ${changeInput} --abandon\n\n` +
            `Or clean separately with:\n  /zflow-clean ${changeInput}`,
            "warning",
          )
          cleanupMode()
          return
        }
      }

      // ── Detect and load pending handoff artifacts ──────────────
      const existingHandoff = await resolvePendingHandoff(changeId)
      if (existingHandoff) {
        ctx.ui.notify(
          `📋 Loaded handoff artifact for "${changeId}" v${existingHandoff.approvedVersion}.`,
          "info",
        )
        await clearPendingHandoff(changeId)
      }

      // ── Check for dispatch service availability ───────────────
      const dispatchService = await tryGetDispatchServiceViaRegistry()
      const hasDispatch = dispatchService !== null

      if (!hasDispatch && !manualDispatchComplete) {
        ctx.ui.notify(
          "⚠️ No dispatch service available for worktree isolation.\n\n" +
          "To implement changes, you need one of:\n" +
          "  1. Install and configure pi-subagents (provides the `subagent` tool).\n" +
          "     Install: `npm install -g pi-subagents`\n" +
          "  2. Register a pi-subagents bridge extension.\n" +
          "  3. Run with --manual-dispatch-complete if you are applying changes manually.\n\n" +
          "Without a dispatch service, the workflow cannot dispatch workers to isolated worktrees " +
          "or apply patches back atomically. Aborting.",
          "error",
        )
        return
      }

      if (hasDispatch) {
        ctx.ui.notify(`🔄 Dispatch service detected: ${dispatchService!.name}`, "info")
      }

      if (manualDispatchComplete) {
        ctx.ui.notify(
          "⚠️ --manual-dispatch-complete: Skipping worktree dispatch. Proceeding to verification.\n" +
          "You are responsible for ensuring changes are correctly applied to the primary worktree.",
          "warning",
        )
      }

      const implementModel = await resolveWorkflowModel("zflow.implement-routine")
      const implProgress = createWorkflowProgressIndicator(pi, ctx, changeInput, {
        command: "zflow-change-implement",
        model: implementModel.model ?? "unavailable",
        thinking: implementModel.thinking ?? "unavailable",
        initialMessage: "Starting implementation workflow",
        statusId: "zflow-implement",
        widgetId: "zflow-implement-progress",
      })
      const updatePostImplementationCard = (message: string): void => {
        const normalized = message.toLowerCase()

        // When verification is skipped (gating), mark Post Implementation terminal
        // and return early — no code review should start in this state.
        if (normalized.includes("verification skipped") || normalized.includes("skipped —") || normalized.includes("gating")) {
          implProgress.updatePhaseCard("post-implementation", "Post Implementation", "Verification skipped — needs review", "failed")
          implProgress.updatePhaseCard("code-review", "Code Review", "Verification skipped; code review blocked", "failed")
          return
        }

        if (normalized.includes("running code review")) {
          // Code review is starting — Post Implementation must already be in a
          // terminal state (completed or failed). Transition it now in case
          // earlier messages did not set the final card state.
          implProgress.updatePhaseCard("post-implementation", "Post Implementation", "Verification complete", "completed")
          implProgress.updatePhaseCard("code-review", "Code Review", message, "running")
          return
        }
        if (normalized.includes("code review passed")) {
          implProgress.updatePhaseCard("code-review", "Code Review", message, "completed")
          implProgress.updatePhaseCard("post-code-review", "Post Code Review", "Preparing final workflow completion", "running")
          return
        }
        if (normalized.includes("code review found") || normalized.includes("review failed")) {
          implProgress.updatePhaseCard("code-review", "Code Review", message, "failed")
          implProgress.updatePhaseCard("post-code-review", "Post Code Review", "Review failed; preparing next steps", "failed")
          return
        }
        if (normalized.includes("persisting completed") || normalized.includes("workflow completion persisted")) {
          implProgress.updatePhaseCard("post-code-review", "Post Code Review", message, normalized.includes("persisted") ? "completed" : "running")
          return
        }
        const postStatus = normalized.includes("final verification passed") ? "completed" : "running"
        implProgress.updatePhaseCard("post-implementation", "Post Implementation", message, postStatus)
        if (normalized.includes("final verification passed")) {
          implProgress.updatePhaseCard("code-review", "Code Review", "Waiting for code review to start", "running")
        }
      }

      try {
        addReminder("approved-plan-loaded")
        const workflowIntercomTarget = ensureWorkflowIntercomTarget(pi, ctx, "implement", changeId)
        implProgress.update("Creating run state and parsing execution plan")

        // ── Phase 2: Run the create-run workflow ──────────────────
        const result = await runChangeImplementWorkflow({
          changeId,
          force,
        })

        if (force) {
          implProgress.update("Forcing dirty worktree — changes may conflict")
        }

        implProgress.update(`Run created: ${result.runId}, version ${result.planVersion}`)
        removeReminder("approved-plan-loaded")

        // ── Phase 3: Parse execution groups and dispatch ─────────
        if (!manualDispatchComplete && hasDispatch) {
          implProgress.update(`Dispatching ${result.changeId} via ${dispatchService!.name}`)
          await runWorktreeDispatchAndFinalize(result.runId, result.changeId, result.planVersion, dispatchService!, {
            cwd: undefined,
            force,
            orchestratorTarget: workflowIntercomTarget,
            onWorkflowUpdate: updatePostImplementationCard,
            onSubagentUpdate: (id, update) => implProgress.updateSubagent(id, update),
            onRateLimitNotice: (message) => ctx.ui.notify(message, "warning"),
          })

          // 3a. Check apply-back status after dispatch. If apply-back conflicted
          //     or failed, stop the workflow here — do not proceed to verification,
          //     review, or completion. Patches are preserved in the run directory.
          const { readRun } = await import("pi-zflow-artifacts")
          const { default: pathModule } = await import("node:path")
          const dispatchRun = await readRun(result.runId, ctx.cwd)
          if (dispatchRun.applyBack.status === "conflicted" || dispatchRun.applyBack.status === "rolled-back" || dispatchRun.applyBack.status === "failed") {
            const runDir = resolveRunDir(result.runId, ctx.cwd)
            const errorMsg = `Apply-back ${dispatchRun.applyBack.status}: ${dispatchRun.applyBack.error ?? "unknown error"}`
            const failureMsg = await formatApplyBackFailureMessage(
              result.runId,
              changeInput,
              errorMsg,
              ctx.cwd,
              {
                patchesDir: pathModule.join(runDir, "patches"),
                integrationWorktreePath: dispatchRun.applyBack.integrationWorktreePath as string | undefined,
                strategiesAttempted: (dispatchRun.metadata as any)?.strategiesAttempted ?? undefined,
              },
            )
            implProgress.updatePhaseCard("post-implementation", "Post Implementation", `Apply-back ${dispatchRun.applyBack.status}`, "failed")
            implProgress.updatePhaseCard("workflow-complete", "Workflow Needs Attention", failureMsg, "failed")
            implProgress.stop("Apply-back failed.")
            ctx.ui.notify(failureMsg, "error")
            return
          }
        }

        // ── Phase 4: Post-start sequence (verification, review, complete) ──
        updatePostImplementationCard("Starting post-start sequence: final verification, review, and completion")
        const onReviewerUpdate = (reviewerUpdate: {
          reviewerName: string
          agentName: string
          status: "queued" | "running" | "completed" | "failed"
          model?: string
          thinking?: string
          currentTool?: string
          lastCommand?: string
        }): void => {
          implProgress.updateReviewer(reviewerUpdate.reviewerName, reviewerUpdate)
        }
        const postResult = await runImplementationPostStartSequence(
          result.runId,
          {
            skipDispatchWait: manualDispatchComplete,
            onProgress: updatePostImplementationCard,
            onReviewerUpdate,
          },
        )

        // Avoid duplicating verification status messages already shown via phase cards.
        // Top-level recent-message bullets are suppressed when phase cards are present
        // (see render), so we only set a concise stop message.

        const finalCardStatus = postResult.status === "completed"
          ? "completed"
          : postResult.status === "failed"
            ? "failed"
            : "running"
        const finalCardTitle = postResult.status === "completed" ? "Workflow Complete" : "Workflow Needs Attention"
        const nextStepsLine = buildWorkflowFinalNextStepsLine(postResult, changeInput)

        // Update the Workflow Complete / Workflow Needs Attention card with both lines
        implProgress.updatePhaseCard(
          "workflow-complete",
          finalCardTitle,
          `Phase: ${postResult.phase}, status: ${postResult.status}`,
          finalCardStatus,
        )
        implProgress.updatePhaseCard(
          "workflow-complete",
          finalCardTitle,
          nextStepsLine,
          finalCardStatus,
        )

        implProgress.stop(finalCardTitle)
      } catch (err: unknown) {
        implProgress.stop(
          `Implementation failed: ${err instanceof Error ? err.message : String(err)}`,
          "failed",
        )
      } finally {
        resetWorkflowState()
      }
    },
  })

  // ── Command: /zflow-change-audit ──────────────────────────────

  pi.registerCommand("zflow-change-audit", {
    description: "Audit an approved plan's verification status and deviation reports",
    handler: async (args: string, ctx: InterviewableContext): Promise<void> => {
      const changeId = args.trim()
      if (!changeId) {
        ctx.ui.notify("Usage: /zflow-change-audit <change-id>", "warning")
        return
      }

      const auditProgress = createWorkflowProgressIndicator(pi, ctx, changeId, {
        command: "zflow-change-audit",
        model: undefined,
        initialMessage: "Auditing change status",
        statusId: "zflow-audit",
        widgetId: "zflow-audit-progress",
      })

      try {
        auditProgress.update("Reading plan state and run metadata")
        const result = await runChangeAuditWorkflow({
          changeId,
        })

        auditProgress.update(result.summary)

        // Emit recommended actions
        for (const action of result.recommendedActions) {
          auditProgress.update(`→ ${action}`)
        }

        const status = result.status
        if (status === "approved" || status === "executing") {
          auditProgress.update(
            `Tip: Run /zflow-review-code ${changeId} to (re-)run code review, ` +
            `or /zflow-change-implement ${changeId} if not yet executed.`,
          )
        }

        // Structured gate when verification failed
        if (result.verificationStatus === "failed") {
          const gateQuestions = buildImplementationGateQuestions(
            changeId,
            "verification-failure",
            `Verification failed for change "${changeId}" (${result.planVersion}).\n${result.summary}`,
          )

          const gateResult = await runStructuredInterview(
            ctx,
            gateQuestions,
            `Verification failed for "${changeId}". Choose how to proceed: auto-fix loop, manual review, or skip.`,
          )

          if (gateResult) {
            switch (gateResult.decision) {
              case "continue": {
                auditProgress.update("→ Run /zflow-change-fix to start the auto-fix loop.")
                break
              }
              case "approve": {
                auditProgress.update("→ Verification skipped. Review will be advisory.")
                break
              }
              default: {
                auditProgress.update("→ Manual review chosen. Use /zflow-change-fix when ready.")
                break
              }
            }
          }
        }

        auditProgress.stop("Audit complete.")
      } catch (err: unknown) {
        auditProgress.stop(
          `Audit failed: ${err instanceof Error ? err.message : String(err)}`,
          "failed",
        )
      }
    },
  })

  // ── Command: /zflow-change-fix ────────────────────────────────

  pi.registerCommand("zflow-change-fix", {
    description: "Apply fixes for code-review or verification failures. Loads findings, selects fixes, applies them, and verifies.",
    handler: async (args: string, ctx: InterviewableContext): Promise<void> => {
      setActiveWorkflowMode("change-implement")
      const cleanupMode = (): void => { resetWorkflowState() }

      const parts = args.trim().split(/\s+/)
      const applyMode = parts.includes("--apply")
      const planOnly = parts.includes("--plan-only")
      const changeInput = parts.filter(p => !p.startsWith("--")).join(" ")

      if (!changeInput) {
        ctx.ui.notify(
          "Usage: /zflow-change-fix <change-id>\n\n" +
          "  Loads review findings, presents fix options, applies fixes, and verifies.",
          "warning",
        )
        cleanupMode()
        return
      }

      const implementTarget = await resolveChangeImplementTarget(changeInput)
      const changeId = implementTarget.changeId

      const fixModel = await resolveWorkflowModel("zflow.implement-routine")
      const fixProgress = createWorkflowProgressIndicator(pi, ctx, changeInput, {
        command: "zflow-change-fix",
        model: fixModel.model ?? "unavailable",
        thinking: fixModel.thinking ?? "unavailable",
        initialMessage: applyMode ? "Applying fix plan" : "Running fix workflow",
        statusId: "zflow-fix",
        widgetId: "zflow-fix-progress",
      })

      try {
        // ═══ Phase 1: Load findings ═══════════════════════════════
        fixProgress.updatePhaseCard("review-findings", "Review Findings",
          "Loading review findings and plan state...", "running")

        const {
          parseReviewFindings,
          assertFindingsMatchChange,
          buildFixSelectionQuestions,
          buildFixPlan,
        } = await import("./orchestration.js")
        const { findings, rawPath, metadata } = await parseReviewFindings(ctx.cwd)

        try {
          assertFindingsMatchChange(changeId, metadata, rawPath)
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          fixProgress.updatePhaseCard("review-findings", "Review Findings",
            msg, "failed")
          ctx.ui.notify(msg, "error")
          fixProgress.stop("Findings mismatch — cannot fix", "failed")
          return
        }

        if (findings.length === 0) {
          fixProgress.updatePhaseCard("review-findings", "Review Findings",
            "No review findings found. Run /zflow-review-code first.", "failed")
          fixProgress.stop("No findings to fix", "failed")
          return
        }

        const crit = findings.filter(f => f.severity === "critical").length
        const maj = findings.filter(f => f.severity === "major").length
        const min = findings.filter(f => f.severity === "minor").length
        const nits = findings.filter(f => f.severity === "nit").length

        fixProgress.updatePhaseCard("review-findings", "Review Findings",
          `Found ${findings.length} finding(s) — ${crit} critical, ${maj} major, ${min} minor, ${nits} nits.`, "completed")

        // Hoisted variable for tracking which findings the user selected
        // (populated in the interview phase below, consumed by dispatch).
        let selectedFindingIndices: number[] | undefined

        // ═══ Phase 2: Fix Selection Interview ═════════════════════
        fixProgress.updatePhaseCard("fix-selection", "Fix Selection",
          "Awaiting fix selection...", "running")

        if (planOnly) {
          // Legacy plan-only — selectedFindingIndices is undefined since
          // no interview was shown, so all findings are used.
          const planResult = await runChangeFixWorkflow({ changeId })
          fixProgress.update(planResult.fixPlan)
          fixProgress.stop("Fix plan ready (plan-only)", "completed")
          return
        }

        if (!applyMode) {
          const questionsJson = buildFixSelectionQuestions(changeId, findings)
          const gateResult = await runStructuredInterview(
            ctx, questionsJson,
            `Found ${findings.length} finding(s) for "${changeId}". Choose how to proceed.`,
          )

          if (!gateResult || gateResult.decision === "cancel") {
            fixProgress.updatePhaseCard("fix-selection", "Fix Selection",
              "Cancelled by user.", "failed")
            fixProgress.stop("Fix cancelled", "completed")
            return
          }

          let selectedFindings: ParsedFinding[]
          if (gateResult.decision === "continue" || gateResult.decision === "approve" ||
              gateResult.decision === "Fix All") {
            selectedFindings = findings
          } else if (gateResult.selectedFindings && gateResult.selectedFindings.length > 0) {
            // Parse selected finding IDs from the interview response.
            // The multi-select returns labels like "[CRITICAL] finding-1: title (file.ts)"
            // Extract the finding-* ID from each entry.
            const selectedIds = new Set<string>()
            for (const entry of gateResult.selectedFindings) {
              const idMatch = entry.match(/finding-\d+/)
              if (idMatch) {
                selectedIds.add(idMatch[0])
              } else {
                // Fallback: treat the entry itself as a finding ID
                selectedIds.add(entry)
              }
            }
            selectedFindings = findings.filter(f => selectedIds.has(f.findingId))
            selectedFindingIndices = findings.reduce<number[]>((acc, f, i) => {
              if (selectedIds.has(f.findingId)) acc.push(i)
              return acc
            }, [])
          } else {
            selectedFindings = findings
          }

          if (selectedFindings.length === 0) {
            fixProgress.updatePhaseCard("fix-selection", "Fix Selection",
              "No findings selected. Exiting.", "failed")
            fixProgress.stop("No fixes selected", "completed")
            return
          }

          const fixPlan = await buildFixPlan(changeId, selectedFindings, ctx.cwd)
          try {
            const { default: fs3 } = await import("node:fs/promises")
            const fixPlanDir = resolveChangeDir(changeId, ctx.cwd)
            await fs3.mkdir(fixPlanDir, { recursive: true })
            await fs3.writeFile(`${fixPlanDir}/fix-plan-latest.md`, fixPlan, "utf-8")
          } catch { /* best effort */ }

          fixProgress.updatePhaseCard("fix-selection", "Fix Selection",
            `Selected ${selectedFindings.length} finding(s). Proceeding to apply...`, "completed")
        }

        // ═══ Phase 3: Direct fix orchestration ═════════════════════
        fixProgress.updatePhaseCard("fix-orchestrator", "Fix Orchestration",
          `Model: ${fixModel.model ?? "unavailable"}. Planning direct worker batches...`, "running")

        const planResult = await runChangeFixWorkflow({
          changeId,
          ...(selectedFindingIndices ? { findingIndices: selectedFindingIndices } : {}),
        })
        const dispatchService = await tryGetDispatchServiceViaRegistry().catch(() => null)

        if (!dispatchService) {
          ctx.ui.notify("⚠️ No dispatch service available to apply fixes.", "error")
          fixProgress.updatePhaseCard("fix-orchestrator", "Fix Orchestration",
            "No dispatch service.", "failed")
          fixProgress.stop("Cannot apply fixes", "failed")
          return
        }

        fixProgress.updatePhaseCard("fix-orchestrator", "Fix Orchestration",
          `Dispatching direct fix workers via ${dispatchService.name}.`, "running")

        try {
          const { runDirectFixWorkflow } = await import("./orchestration.js")
          const directResult = await runDirectFixWorkflow({
            changeId,
            fixResult: planResult,
            dispatchService,
            cwd: ctx.cwd,
            workerAgent: "zflow.implement-routine",
            workerModel: fixModel.dispatchModel ?? fixModel.model,
            workerThinking: fixModel.thinking,
            onBatchStart: async (batch) => {
              fixProgress.updatePhaseCard(
                "fix-workers",
                "Fix Workers",
                `Starting ${batch.batchId} (${batch.findings.length} finding(s)) for ${batch.files.join(", ") || "unscoped findings"}.`,
                "running",
              )
              fixProgress.updateSubagent(batch.batchId, {
                agent: batch.workerAgent,
                title: `Fix Worker — ${batch.fileKey}`,
                model: fixModel.model ?? "unavailable",
                thinking: fixModel.thinking ?? "unavailable",
                status: "running",
                startedAt: Date.now(),
                lastCommand: `Starting ${batch.findings.map((finding) => finding.findingId).join(", ")}`,
              })
            },
            onBatchUpdate: async (batch, progress) => {
              const currentTool = progress.currentTool
              const args = progress.currentToolArgs ? ` ${progress.currentToolArgs}` : ""
              fixProgress.updateSubagent(batch.batchId, {
                lastCommand: currentTool
                  ? `${currentTool}${args}`
                  : progress.recentOutput?.[progress.recentOutput.length - 1] ?? `Processing ${batch.batchId}`,
              })
            },
            onBatchComplete: async (batch, result) => {
              fixProgress.updateSubagent(batch.batchId, {
                status: result.ok ? "completed" : "failed",
                finishedAt: Date.now(),
                lastCommand: result.ok
                  ? `Completed ${batch.findings.map((finding) => finding.findingId).join(", ")}`
                  : (result.error ?? "worker failed"),
              })
            },
          })

          const fixedCount = directResult.fixed.length
          const unresolvedCount = directResult.unresolved.length
          const satisfactionSummary = `Fixed: ${fixedCount}, Unresolved: ${unresolvedCount}. Full report: ${directResult.reportPath}`

          fixProgress.updatePhaseCard("fix-orchestrator", "Fix Orchestration",
            `Direct orchestration dispatched ${directResult.batchCount} worker batch(es).`, "completed")
          fixProgress.updatePhaseCard("fix-workers", "Fix Workers",
            satisfactionSummary, unresolvedCount > 0 ? "failed" : "completed")
          fixProgress.updatePhaseCard("verification", "Verification",
            directResult.verificationCommand
              ? `Verify: \`${directResult.verificationCommand}\``
              : "Re-verify manually.", "completed")
          fixProgress.updatePhaseCard("workflow-complete", unresolvedCount > 0 ? "Workflow Needs Attention" : "Workflow Complete",
            satisfactionSummary, unresolvedCount > 0 ? "failed" : "completed")
          fixProgress.stop(unresolvedCount > 0 ? "Fix workflow complete — some findings unresolved" : "Fix workflow completed")
        } catch (dispatchErr: unknown) {
          const msg = dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr)
          fixProgress.updatePhaseCard("fix-orchestrator", "Fix Orchestration",
            `Error: ${msg}`, "failed")
          fixProgress.updatePhaseCard("fix-workers", "Fix Workers", `Error: ${msg}`, "failed")
          fixProgress.updatePhaseCard("workflow-complete", "Workflow Needs Attention",
            `Direct fix dispatch failed: ${msg}`, "failed")
          fixProgress.stop("Fix failed", "failed")
        }
      } catch (err: unknown) {
        fixProgress.stop(
          `Fix workflow failed: ${err instanceof Error ? err.message : String(err)}`,
          "failed",
        )
      } finally {
        cleanupMode()
      }
    },
  })
}
