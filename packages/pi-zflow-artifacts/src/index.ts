/**
 * pi-zflow-artifacts
 *
 * Runtime state path resolution, plan/run/review artifact helpers,
 * atomic writes, cleanup metadata helpers, and the zflow_write_plan_artifact tool.
 */
export const PACKAGE_VERSION = "0.1.0" as const

// Re-export artifact path builders
// These are also importable directly from "pi-zflow-artifacts/artifact-paths"
export {
  resolveChangeDir,
  resolvePlanDir,
  resolveDeviationDir,
  resolvePlanStatePath,
  resolveRunDir,
  resolveRunStatePath,
  resolveReviewDir,
  resolveCodeReviewFindingsPath,
  resolvePrReviewPath,
  resolveStateIndexPath,
  resolveRepoMapPath,
  resolveReconnaissancePath,
  resolveFailureLogPath,
  resolveActiveProfilePath,
  resolveInstallManifestPath,
} from "./artifact-paths.js"

export type { ArtifactCleanupMeta } from "./artifact-paths.js"

// Re-export state index helpers (Phase 2+ implementation)
// Also importable directly from "pi-zflow-artifacts/state-index"
export {} from "./state-index.js"

// Re-export plan state helpers (Phase 2+ implementation)
// Also importable directly from "pi-zflow-artifacts/plan-state"
export {} from "./plan-state.js"

// Re-export run state helpers
// Also importable directly from "pi-zflow-artifacts/run-state"
export {
  createRun,
  readRun,
  updateRun,
  addGroupToRun,
  addRetainedArtifact,
  setRunPhase,
  createRecoveryRef,
  removeRecoveryRef,
  resetToPreApplySnapshot,
} from "./run-state.js"

export type {
  RunPhase,
  RunJson,
  PreApplySnapshot,
  ApplyBackStatus,
  VerificationStatus,
  GroupRunMetadata,
  RetainedArtifact,
} from "./run-state.js"

// Re-export cleanup metadata helpers (Phase 7+ implementation)
// Also importable directly from "pi-zflow-artifacts/cleanup-metadata"
export {} from "./cleanup-metadata.js"

// Re-export plan artifact write tool (Phase 2+ implementation)
// Also importable directly from "pi-zflow-artifacts/write-plan-artifact"
export {} from "./write-plan-artifact.js"
