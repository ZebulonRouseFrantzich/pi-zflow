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
} from "./extensions/zflow-change-workflows/orchestration.js"

export type {
  SubagentLaunchPlan,
  WorkflowExecutionPlan,
  WorkflowStep,
  ReviewSwarmConfig,
} from "./extensions/zflow-change-workflows/orchestration.js"

// Git preflight (Phase 5 — clean-tree and untracked-overlap checks)
export {
  gitPorcelain,
  getCurrentBranch,
  getHeadSha,
  assertCleanPrimaryTree,
  resolveRepoRoot,
} from "./extensions/zflow-change-workflows/git-preflight.js"

export type {
  GitPorcelainResult,
  GitPreflightResult,
} from "./extensions/zflow-change-workflows/git-preflight.js"

// File ownership validation (Phase 5 — parallel write conflict detection)
export {
  detectOwnershipConflicts,
  validateOwnershipAndDependencies,
  topoSortGroups,
} from "./extensions/zflow-change-workflows/ownership-validator.js"

export type {
  ExecutionGroup,
  OwnershipConflict,
  OwnershipValidationResult,
} from "./extensions/zflow-change-workflows/ownership-validator.js"

// Worktree dispatch (Phase 5 — per-group isolated worktree launch)
export {
  buildWorkerTask,
  buildWorktreeDispatchPlan,
} from "./extensions/zflow-change-workflows/orchestration.js"

export type {
  WorktreeGroupTask,
  WorktreeDispatchConfig,
  DispatchExecutionGroup,
} from "./extensions/zflow-change-workflows/orchestration.js"
