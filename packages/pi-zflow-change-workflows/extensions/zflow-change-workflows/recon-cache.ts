/**
 * recon-cache.ts — Caching and freshness checks for reconnaissance.md
 *
 * Reconnaissance output is expensive to regenerate (multiple git commands,
 * file reads, package analysis, failure-log parsing). This module provides
 * caching so the recon is reused when the repo structure and change path
 * haven't changed significantly.
 *
 * Cache freshness is determined by comparing a structural hash of the
 * repository (branch, HEAD SHA, top-level structure) against the hash
 * stored when the recon was last generated, and verifying the change path
 * (if any) matches.
 *
 * ## Usage
 *
 * ```ts
 * import { isReconFresh, writeReconCache }
 *   from "./recon-cache.js"
 *
 * const { fresh } = await isReconFresh(changePath, cwd)
 * if (!fresh) {
 *   const result = await buildReconnaissance(cwd, changePath)
 *   await writeReconCache({
 *     hash: computeRepoStructureHash(cwd),
 *     generatedAt: new Date().toISOString(),
 *     changePath: changePath ?? null,
 *     path: result.path,
 *   }, cwd)
 * }
 * ```
 *
 * @module pi-zflow-change-workflows/recon-cache
 */

import * as crypto from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { resolveRuntimeStateDir } from "pi-zflow-core/runtime-paths"
import { computeRepoStructureHash } from "./repo-map-cache.js"

// Re-export for consumers that need hash computation alongside cache operations
export { computeRepoStructureHash }

// ── Types ───────────────────────────────────────────────────────

/**
 * Cache metadata stored alongside the reconnaissance.md file.
 */
export interface ReconCacheData {
  /** Structural hash of the repository when the recon was generated. */
  hash: string
  /** ISO-8601 timestamp of when the recon was generated. */
  generatedAt: string
  /** The change path used during generation (null if auto-generated). */
  changePath: string | null
  /** Absolute path to the reconnaissance.md file. */
  path: string
}

/**
 * Result of a freshness check.
 */
export interface FreshnessResult {
  /** Whether the cached reconnaissance is still fresh. */
  fresh: boolean
  /** Human-readable explanation of the result. */
  reason: string
}

// ── Cache file path ────────────────────────────────────────────

/**
 * Get the path to the reconnaissance cache metadata file.
 *
 * The cache metadata is stored as a JSON file alongside the reconnaissance.md
 * in the runtime state directory.
 *
 * @param cwd - Working directory (optional, for resolving runtime state dir).
 * @returns Absolute path to the cache metadata file.
 */
export function getReconCachePath(cwd?: string): string {
  const runtimeStateDir = resolveRuntimeStateDir(cwd)
  return path.join(runtimeStateDir, ".recon-cache.json")
}

// ── Cache read/write ───────────────────────────────────────────

/**
 * Read the reconnaissance cache metadata file.
 *
 * Returns `null` if the cache file does not exist or is corrupt.
 *
 * @param cwd - Working directory (optional).
 * @returns Parsed cache data, or `null` if unavailable.
 */
export async function readReconCache(cwd?: string): Promise<ReconCacheData | null> {
  const cachePath = getReconCachePath(cwd)

  try {
    const content = await fs.readFile(cachePath, "utf-8")
    const parsed = JSON.parse(content)

    // Validate required fields
    if (
      typeof parsed.hash === "string" &&
      typeof parsed.generatedAt === "string" &&
      (parsed.changePath === null || typeof parsed.changePath === "string") &&
      typeof parsed.path === "string"
    ) {
      return parsed as ReconCacheData
    }

    return null
  } catch {
    // File doesn't exist or is unreadable
    return null
  }
}

/**
 * Write the reconnaissance cache metadata file.
 *
 * Creates the runtime state directory if it does not exist.
 *
 * @param data - Cache data to persist.
 * @param cwd - Working directory (optional).
 */
export async function writeReconCache(
  data: ReconCacheData,
  cwd?: string,
): Promise<void> {
  const cachePath = getReconCachePath(cwd)
  const runtimeStateDir = resolveRuntimeStateDir(cwd)

  await fs.mkdir(runtimeStateDir, { recursive: true })
  await fs.writeFile(cachePath, JSON.stringify(data, null, 2), "utf-8")
}

// ── Freshness check ─────────────────────────────────────────────

/**
 * Check whether the cached reconnaissance.md is still fresh.
 *
 * Freshness is determined by:
 * 1. The cache metadata file must exist
 * 2. The reconnaissance.md file must exist on disk
 * 3. The change path (if provided) must match the cached change path
 * 4. The current structure hash must match the cached hash
 *
 * @param changePath - The current change path (optional). If provided and
 *   different from the cached change path, the cache is considered stale.
 * @param cwd - Working directory (optional).
 * @returns A `FreshnessResult` with a boolean and explanation.
 */
export async function isReconFresh(
  changePath?: string,
  cwd?: string,
): Promise<FreshnessResult> {
  const cacheData = await readReconCache(cwd)

  if (!cacheData) {
    return { fresh: false, reason: "No reconnaissance cache metadata found" }
  }

  // Check that the reconnaissance.md file still exists
  try {
    await fs.access(cacheData.path)
  } catch {
    return {
      fresh: false,
      reason: `Cached reconnaissance.md not found at ${cacheData.path}`,
    }
  }

  // Check change path match (if provided)
  if (changePath !== undefined && changePath !== null) {
    const normalizedProvided = path.normalize(changePath)
    const normalizedCached = cacheData.changePath !== null
      ? path.normalize(cacheData.changePath)
      : null

    if (normalizedCached === null || normalizedProvided !== normalizedCached) {
      return {
        fresh: false,
        reason: `Change path mismatch: cached="${cacheData.changePath}", current="${changePath}"`,
      }
    }
  }

  // Compute current structural hash
  const currentHash = computeRepoStructureHash(cwd)

  if (currentHash === cacheData.hash) {
    return {
      fresh: true,
      reason: "Repository structure unchanged since last generation",
    }
  }

  return {
    fresh: false,
    reason: "Repository structure hash mismatch (branch, HEAD, or top-level layout changed)",
  }
}
