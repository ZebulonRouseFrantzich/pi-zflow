/**
 * plan-state.ts — Plan state transitions and persistence.
 *
 * **Phase 1 placeholder.**
 * The full plan-state implementation will be part of Phase 2+ when
 * `/zflow-change-prepare` and `/zflow-change-implement` are built.
 *
 * TODO(phase-2): Implement plan state management.
 *   - States: draft → proposed → approved → implementing → implemented → verified
 *   - Deviations: deviating → deviation-resolved → re-implementing
 *   - Persist to `<runtime-state-dir>/plans/{changeId}/plan-state.json`
 *   - Enforce valid state transitions with clear error messages
 *   - Emit zflow:planModeChanged / zflow:planApproved events
 *
 * @module pi-zflow-artifacts/plan-state
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { resolvePlanStatePath } from "./artifact-paths.js"

/**
 * Compute the SHA-256 hex digest of a string.
 *
 * @param content - The content to hash.
 * @returns Hex-encoded SHA-256 digest.
 */
export function computeContentHash(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex")
}

/**
 * Validate that a planVersion string matches the expected format.
 *
 * @param planVersion - Version label (e.g. "v1", "v2").
 * @throws Error if the version is not valid.
 */
export function assertValidPlanVersion(planVersion: string): void {
  if (!/^v\d+$/.test(planVersion)) {
    throw new Error(
      `Invalid planVersion: "${planVersion}". Plan version must match /^v\\d+$/ (e.g. "v1", "v2").`,
    )
  }
}

/**
 * Validate that an artifact type is one of the four approved kinds.
 *
 * @param artifact - Artifact type string.
 * @throws Error if the artifact type is not recognized.
 */
export function assertValidArtifactType(
  artifact: string,
): asserts artifact is "design" | "execution-groups" | "standards" | "verification" {
  const allowed = ["design", "execution-groups", "standards", "verification"] as const
  if (!(allowed as readonly string[]).includes(artifact)) {
    throw new Error(
      `Invalid artifact type: "${artifact}". Must be one of: ${allowed.join(", ")}`,
    )
  }
}

/**
 * Record artifact write metadata (hash + mtime) in plan-state.json.
 *
 * Reads the existing plan-state.json (if any), updates the artifact entry
 * under the version's `artifacts` map, and writes it back atomically.
 * If plan-state.json does not yet exist, it is created with a minimal
 * structure.
 *
 * @param changeId - The change identifier (kebab-case).
 * @param planVersion - The plan version label (e.g. "v1").
 * @param artifact - The artifact type.
 * @param hash - SHA-256 hex digest of the artifact content.
 * @param cwd - Working directory (optional, for runtime state resolution).
 */
export async function recordArtifactMetadata(
  changeId: string,
  planVersion: string,
  artifact: "design" | "execution-groups" | "standards" | "verification",
  hash: string,
  cwd?: string,
): Promise<void> {
  const planStatePath = resolvePlanStatePath(changeId, cwd)
  const now = Date.now()

  let planState: Record<string, unknown>
  try {
    const raw = await fs.readFile(planStatePath, "utf-8")
    planState = JSON.parse(raw)
  } catch {
    // File doesn't exist yet -- create a minimal structure
    planState = {
      changeId,
      currentVersion: planVersion,
      approvedVersion: null,
      lifecycleState: "draft",
      versions: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  }

  // Ensure the versions map exists
  if (!planState.versions || typeof planState.versions !== "object") {
    planState.versions = {}
  }
  const versions = planState.versions as Record<string, unknown>

  // Ensure the version entry exists
  if (!versions[planVersion] || typeof versions[planVersion] !== "object") {
    versions[planVersion] = {
      state: "draft",
      createdAt: new Date().toISOString(),
      artifacts: {},
    }
  }

  const versionEntry = versions[planVersion] as Record<string, unknown>
  if (!versionEntry.artifacts || typeof versionEntry.artifacts !== "object") {
    versionEntry.artifacts = {}
  }

  const artifacts = versionEntry.artifacts as Record<string, unknown>
  artifacts[artifact] = { hash, mtime: now }

  planState.updatedAt = new Date().toISOString()

  // Create parent directory and write atomically
  await fs.mkdir(path.dirname(planStatePath), { recursive: true })
  const tmpPath = planStatePath + ".tmp"
  await fs.writeFile(tmpPath, JSON.stringify(planState, null, 2), "utf-8")
  await fs.rename(tmpPath, planStatePath)
}


