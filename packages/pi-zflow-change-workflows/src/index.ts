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
