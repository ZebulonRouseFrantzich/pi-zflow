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

import {
  migrateLegacyChangeArtifactsIfPresent,
} from "./orchestration/implementation/workflow.js"

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