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
