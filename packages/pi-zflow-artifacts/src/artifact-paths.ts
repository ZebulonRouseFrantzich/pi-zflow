/**
 * Artifact-specific path builders and cleanup metadata helpers.
 *
 * These resolvers build on the shared runtime path resolvers from
 * `pi-zflow-core/runtime-paths` to construct paths for plans, runs,
 * reviews, and other pi-zflow artifacts.
 *
 * @module pi-zflow-artifacts/artifact-paths
 */

import * as path from "node:path"
import { resolveRuntimeStateDir, resolveUserStateDir } from "pi-zflow-core/runtime-paths"

// ---------------------------------------------------------------------------
// Plan artifact paths
// ---------------------------------------------------------------------------

/**
 * Resolve the root directory for all artifacts of a given change.
 *
 * Path: `<runtime-state-dir>/plans/{changeId}/
 *
 * @param changeId - Unique identifier for the change (e.g. "ch42" or "feat-auth")
 * @param cwd - Working directory (optional, defaults to `process.cwd()`)
 */
export function resolveChangeDir(changeId: string, cwd?: string): string {
  return path.join(resolveRuntimeStateDir(cwd), "plans", changeId)
}

/**
 * Resolve the directory for a specific plan version's artifacts.
 *
 * Path: `<runtime-state-dir>/plans/{changeId}/v{version}/
 *
 * @param changeId - Unique identifier for the change
 * @param version - Version string (e.g. "1", "2", "3")
 * @param cwd - Working directory (optional)
 */
export function resolvePlanDir(
  changeId: string,
  version: string,
  cwd?: string,
): string {
  return path.join(resolveChangeDir(changeId, cwd), `v${version}`)
}

/**
 * Resolve the path to a single plan artifact file.
 *
 * This is the destination path used by the `zflow_write_plan_artifact` tool.
 * The path is enforced to stay under `<runtime-state-dir>/plans/{changeId}/v{version}/`.
 *
 * Contract (see README.md for full details):
 * - `changeId` must be a safe kebab-case identifier (validated by `assertSafeChangeId()`).
 * - `planVersion` must match `/^v\d+$/` (e.g. "v1", "v2").
 * - `artifact` must be one of: "design", "execution-groups", "standards", "verification".
 * - The result is always `<resolvePlanDir(changeId, planVersion, cwd)>/{artifact}.md`.
 *
 * @param changeId - Resolved safe change identifier (kebab-case)
 * @param planVersion - Version label starting with "v" (e.g. "v1")
 * @param artifact - Artifact kind: "design" | "execution-groups" | "standards" | "verification"
 * @param cwd - Working directory (optional)
 */
export function resolvePlanArtifactPath(
  changeId: string,
  planVersion: string,
  artifact: "design" | "execution-groups" | "standards" | "verification",
  cwd?: string,
): string {
  return path.join(resolvePlanDir(changeId, planVersion.replace(/^v/, ""), cwd), `${artifact}.md`)
}

/**
 * Resolve the deviations directory for a specific plan version.
 *
 * Path: `<runtime-state-dir>/plans/{changeId}/deviations/{planVersion}/
 *
 * @param changeId - Unique identifier for the change
 * @param planVersion - The plan version that the deviation refers to
 * @param cwd - Working directory (optional)
 */
export function resolveDeviationDir(
  changeId: string,
  planVersion: string,
  cwd?: string,
): string {
  return path.join(resolveRuntimeStateDir(cwd), "plans", changeId, "deviations", planVersion)
}

/**
 * Resolve the directory for a specific plan version, accepting "v{n}" format.
 *
 * This is a convenience wrapper around resolvePlanDir that accepts
 * the version label in the canonical "v1", "v2" format used by the
 * plan artifact system. Internally it strips the "v" prefix before
 * delegating to resolvePlanDir.
 *
 * Path: `<runtime-state-dir>/plans/{changeId}/v{version}/
 *
 * @param changeId - Unique identifier for the change
 * @param planVersion - Version label starting with "v" (e.g. "v1", "v2")
 * @param cwd - Working directory (optional)
 */
export function resolvePlanVersionDir(
  changeId: string,
  planVersion: string,
  cwd?: string,
): string {
  return resolvePlanDir(changeId, planVersion.replace(/^v/, ""), cwd)
}

/**
 * Resolve the path to a plan-state.json file.
 *
 * Path: `<runtime-state-dir>/plans/{changeId}/plan-state.json
 */
export function resolvePlanStatePath(changeId: string, cwd?: string): string {
  return path.join(resolveChangeDir(changeId, cwd), "plan-state.json")
}

// ---------------------------------------------------------------------------
// Run artifact paths
// ---------------------------------------------------------------------------

/**
 * Resolve the root directory for all artifacts of a given run.
 *
 * Path: `<runtime-state-dir>/runs/{runId}/
 *
 * @param runId - Unique identifier for the run
 * @param cwd - Working directory (optional)
 */
export function resolveRunDir(runId: string, cwd?: string): string {
  return path.join(resolveRuntimeStateDir(cwd), "runs", runId)
}

/**
 * Resolve the path to a run.json file.
 *
 * Path: `<runtime-state-dir>/runs/{runId}/run.json
 */
export function resolveRunStatePath(runId: string, cwd?: string): string {
  return path.join(resolveRunDir(runId, cwd), "run.json")
}

// ---------------------------------------------------------------------------
// Review artifact paths
// ---------------------------------------------------------------------------

/**
 * Resolve the review directory.
 *
 * Path: `<runtime-state-dir>/review/
 */
export function resolveReviewDir(cwd?: string): string {
  return path.join(resolveRuntimeStateDir(cwd), "review")
}

/**
 * Resolve the code-review-findings.md path.
 *
 * Path: `<runtime-state-dir>/review/code-review-findings.md
 */
export function resolveCodeReviewFindingsPath(cwd?: string): string {
  return path.join(resolveReviewDir(cwd), "code-review-findings.md")
}

/**
 * Resolve a PR review file path.
 *
 * Path: `<runtime-state-dir>/review/pr-review-{id}.md
 */
export function resolvePrReviewPath(id: string, cwd?: string): string {
  return path.join(resolveReviewDir(cwd), `pr-review-${id}.md`)
}

// ---------------------------------------------------------------------------
// Top-level state and log files
// ---------------------------------------------------------------------------

/**
 * Resolve the path to the state index file.
 *
 * Path: `<runtime-state-dir>/state-index.json
 */
export function resolveStateIndexPath(cwd?: string): string {
  return path.join(resolveRuntimeStateDir(cwd), "state-index.json")
}

/**
 * Resolve the path to the repo map file.
 *
 * Path: `<runtime-state-dir>/repo-map.md
 */
export function resolveRepoMapPath(cwd?: string): string {
  return path.join(resolveRuntimeStateDir(cwd), "repo-map.md")
}

/**
 * Resolve the path to the reconnaissance file.
 *
 * Path: `<runtime-state-dir>/reconnaissance.md
 */
export function resolveReconnaissancePath(cwd?: string): string {
  return path.join(resolveRuntimeStateDir(cwd), "reconnaissance.md")
}

/**
 * Resolve the path to the failure log file.
 *
 * Path: `<runtime-state-dir>/failure-log.md
 */
export function resolveFailureLogPath(cwd?: string): string {
  return path.join(resolveRuntimeStateDir(cwd), "failure-log.md")
}

// ---------------------------------------------------------------------------
// User-level state paths
// ---------------------------------------------------------------------------

/**
 * Resolve the path to the active-profile.json file.
 *
 * Path: `<user-state-dir>/active-profile.json
 */
export function resolveActiveProfilePath(): string {
  return path.join(resolveUserStateDir(), "active-profile.json")
}

/**
 * Resolve the path to the install-manifest.json file.
 *
 * Path: `<user-state-dir>/install-manifest.json
 */
export function resolveInstallManifestPath(): string {
  return path.join(resolveUserStateDir(), "install-manifest.json")
}

// ---------------------------------------------------------------------------
// Cleanup metadata
// ---------------------------------------------------------------------------

/**
 * Metadata structure for artifact cleanup decisions.
 */
export interface ArtifactCleanupMeta {
  /** Absolute path to the artifact or directory */
  path: string
  /** Last modified timestamp (ms since epoch) */
  mtime: number
  /** Size in bytes */
  size: number
  /** Whether this is a failed/interrupted worktree */
  isFailedWorktree: boolean
  /** Human-readable description for dry-run output */
  description: string
}
