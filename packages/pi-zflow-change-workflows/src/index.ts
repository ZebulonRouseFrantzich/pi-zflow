/**
 * pi-zflow-change-workflows
 *
 * Formal artifact-first orchestration, plan lifecycle,
 * implementation workflow, verification/fix loops,
 * apply-back orchestration, cleanup UX, and /zflow-change-* commands.
 */
export const PACKAGE_VERSION = "0.1.0" as const

// Orchestration wiring (Phase 4 — subagent launch, workflow execution plans)
export {
  buildSubagentLaunchPlan,
  buildAllSubagentLaunchPlans,
  buildWorkflowExecutionPlan,
  createSwarmManifest,
  getReviewersForTier,
  getPlanReviewersForTier,
  getOutputRoute,
} from "../extensions/zflow-change-workflows/orchestration.js"

export type {
  SubagentLaunchPlan,
  WorkflowExecutionPlan,
  WorkflowStep,
  ReviewSwarmConfig,
} from "../extensions/zflow-change-workflows/orchestration.js"

// Git preflight (Phase 5 — clean-tree and untracked-overlap checks)
export {
  gitPorcelain,
  getCurrentBranch,
  getHeadSha,
  assertCleanPrimaryTree,
  resolveRepoRoot,
} from "../extensions/zflow-change-workflows/git-preflight.js"

export type {
  GitPorcelainResult,
  GitPreflightResult,
} from "../extensions/zflow-change-workflows/git-preflight.js"

// Ownership validator (Phase 5 — file ownership and dependency validation)
export {
  detectOwnershipConflicts,
  validateOwnershipAndDependencies,
  topoSortGroups,
} from "../extensions/zflow-change-workflows/ownership-validator.js"

export type {
  ExecutionGroup,
  OwnershipConflict,
  OwnershipValidationResult,
} from "../extensions/zflow-change-workflows/ownership-validator.js"

// Run state helpers are exported from pi-zflow-artifacts/run-state

// Deviations (Phase 5 — Plan Drift Protocol, deviation reports, summaries)
export {
  formatDeviationReport,
  writeDeviationReport,
  readDeviationReports,
  synthesizeDeviationSummary,
  writeDeviationSummary,
  resolveDeviationReportPath,
  resolveDeviationSummaryPath,
  determineRecommendation,
} from "../extensions/zflow-change-workflows/deviations.js"

export type {
  DeviationReport,
  DeviationSummary,
  DeviationStatus,
} from "../extensions/zflow-change-workflows/deviations.js"

// Worktree dispatch (Phase 5 — per-group isolated worktree launch)
export {
  buildWorkerTask,
  buildWorktreeDispatchPlan,
  prepareWorktreeImplementationRun,
  finalizeWorktreeImplementationRun,
  signalDriftDetected,
  listRetainedArtifacts,
} from "../extensions/zflow-change-workflows/orchestration.js"

export type {
  WorktreeGroupTask,
  WorktreeDispatchConfig,
  DispatchExecutionGroup,
  WorktreeImplementationRunPlan,
} from "../extensions/zflow-change-workflows/orchestration.js"

// State-index lifecycle (Phase 7 — unfinished-run discovery)
export {
  discoverUnfinishedWork,
  promptResumeChoices,
} from "../extensions/zflow-change-workflows/orchestration.js"

// Formal prepare workflow (Phase 7 — /zflow-change-prepare orchestration)
export {
  runChangePrepareWorkflow,
  updatePlanState,
  bumpPlanVersion,
  markPlanVersionState,
} from "../extensions/zflow-change-workflows/orchestration.js"

export type {
  PrepareWorkflowOptions,
  PrepareWorkflowResult,
} from "../extensions/zflow-change-workflows/orchestration.js"

export type {
  StateIndexEntry,
} from "pi-zflow-artifacts/state-index"

// Worktree setup hook (Phase 5 — fail-fast hook integration)
export {
  repoNeedsWorktreeSetup,
  getRepoWorktreeSetupConfig,
  assertWorktreeSetupReady,
} from "../extensions/zflow-change-workflows/worktree-setup.js"

export type {
  WorktreeSetupResult,
} from "../extensions/zflow-change-workflows/worktree-setup.js"

// Group result capture (Phase 5 — worktree output and patch artifacts)
export {
  captureGroupResult,
  getGroupResult,
  listGroupResults,
} from "../extensions/zflow-change-workflows/group-result.js"

export type {
  GroupResult,
  GroupVerificationResult,
  CaptureGroupResultOptions,
} from "../extensions/zflow-change-workflows/group-result.js"

// Apply-back (Phase 5 — topological ordering, atomic patch replay, rollback)
export {
  executeApplyBack,
  PatchReplayStrategy,
  getApplyBackStatus,
  recoverFromApplyBack,
} from "../extensions/zflow-change-workflows/apply-back.js"

export type {
  ApplyBackStrategy,
  ApplyBackResult,
  ApplyBackOptions,
  RecoveryOptions,
} from "../extensions/zflow-change-workflows/apply-back.js"

// Prompt fragment loading (Phase 7 — mode-fragment and runtime-reminder injection)
export {
  loadFragment,
  buildReminderInjection,
  buildModeInjection,
  fragmentExists,
} from "../extensions/zflow-change-workflows/prompt-fragments.js"

export type {
  ReminderId,
  ModeFragment,
} from "../extensions/zflow-change-workflows/prompt-fragments.js"


