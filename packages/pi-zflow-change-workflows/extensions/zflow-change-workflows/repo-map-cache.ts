/**
 * repo-map-cache.ts — Caching and freshness checks for repo-map.md
 *
 * Repository maps are expensive to regenerate (multiple git commands, file reads).
 * This module provides caching so the map is reused as long as the repo structure
 * hasn't changed significantly.
 *
 * Cache freshness is determined by comparing a structural hash of the repository
 * (branch, HEAD SHA, top-level structure) against the hash stored when the map
 * was last generated.
 *
 * ## Usage
 *
 * ```ts
 * import { isRepoMapFresh, writeRepoMapCache, computeRepoStructureHash }
 *   from "./repo-map-cache.js"
 *
 * const { fresh } = await isRepoMapFresh(cwd)
 * if (!fresh) {
 *   const result = await buildRepoMap(cwd)
 *   await writeRepoMapCache({
 *     hash: await computeRepoStructureHash(cwd),
 *     generatedAt: new Date().toISOString(),
 *     entryCount: result.entries,
 *     path: result.path,
 *   }, cwd)
 * }
 * ```
 *
 * @module pi-zflow-change-workflows/repo-map-cache
 */

import * as crypto from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { resolveRuntimeStateDir } from "pi-zflow-core/runtime-paths"

// ── Types ───────────────────────────────────────────────────────

/**
 * Cache metadata stored alongside the repo-map.md file.
 */
export interface RepoMapCacheData {
  /** Structural hash of the repository when the map was generated. */
  hash: string
  /** ISO-8601 timestamp of when the map was generated. */
  generatedAt: string
  /** Number of top-level entries in the map at generation time. */
  entryCount: number
  /** Absolute path to the repo-map.md file. */
  path: string
}

/**
 * Result of a freshness check.
 */
export interface FreshnessResult {
  /** Whether the cached repo map is still fresh. */
  fresh: boolean
  /** Human-readable explanation of the result. */
  reason: string
}

// ── Cache file path ────────────────────────────────────────────

/**
 * Get the path to the repo-map cache metadata file.
 *
 * The cache metadata is stored as a JSON file alongside the repo-map.md
 * in the runtime state directory.
 *
 * @param cwd - Working directory (optional, for resolving runtime state dir).
 * @returns Absolute path to the cache metadata file.
 */
export function getRepoMapCachePath(cwd?: string): string {
  const runtimeStateDir = resolveRuntimeStateDir(cwd)
  return path.join(runtimeStateDir, ".repo-map-cache.json")
}

// ── Cache read/write ───────────────────────────────────────────

/**
 * Read the repo-map cache metadata file.
 *
 * Returns `null` if the cache file does not exist or is corrupt.
 *
 * @param cwd - Working directory (optional).
 * @returns Parsed cache data, or `null` if unavailable.
 */
export async function readRepoMapCache(cwd?: string): Promise<RepoMapCacheData | null> {
  const cachePath = getRepoMapCachePath(cwd)

  try {
    const content = await fs.readFile(cachePath, "utf-8")
    const parsed = JSON.parse(content)

    // Validate required fields
    if (
      typeof parsed.hash === "string" &&
      typeof parsed.generatedAt === "string" &&
      typeof parsed.entryCount === "number" &&
      typeof parsed.path === "string"
    ) {
      return parsed as RepoMapCacheData
    }

    return null
  } catch {
    // File doesn't exist or is unreadable
    return null
  }
}

/**
 * Write the repo-map cache metadata file.
 *
 * Creates the runtime state directory if it does not exist.
 *
 * @param data - Cache data to persist.
 * @param cwd - Working directory (optional).
 */
export async function writeRepoMapCache(
  data: RepoMapCacheData,
  cwd?: string,
): Promise<void> {
  const cachePath = getRepoMapCachePath(cwd)
  const runtimeStateDir = resolveRuntimeStateDir(cwd)

  await fs.mkdir(runtimeStateDir, { recursive: true })
  await fs.writeFile(cachePath, JSON.stringify(data, null, 2), "utf-8")
}

// ── Structural hash computation ─────────────────────────────────

/**
 * Compute a hash of the current repository structure.
 *
 * Combines branch name, HEAD SHA, and top-level file/directory listing
 * into a single digest. The hash changes when:
 * - The branch changes
 * - New commits land (HEAD SHA changes)
 * - Top-level structure changes (files added/removed)
 *
 * @param cwd - Working directory (optional).
 * @returns A hex string hash of the repository structure.
 */
export function computeRepoStructureHash(cwd?: string): string {
  let branch = ""
  let headSha = ""
  let topLevelEntries: string[] = []

  try {
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      cwd,
    }).trim()

    branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      cwd: repoRoot,
    }).trim()

    headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      cwd: repoRoot,
    }).trim()

    const lsTree = execFileSync("git", ["ls-tree", "--name-only", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      cwd: repoRoot,
    }).trim()

    topLevelEntries = lsTree ? lsTree.split("\n").filter(Boolean) : []
  } catch {
    // Not in a git repo — hash will be unique per call (always stale)
    const ts = Date.now().toString()
    return crypto.createHash("sha256").update(`no-git-${ts}`).digest("hex")
  }

  // Build a canonical string of all structural components
  const canonical = [
    `branch=${branch}`,
    `head=${headSha}`,
    ...topLevelEntries.sort(),
  ].join("\n")

  return crypto.createHash("sha256").update(canonical).digest("hex")
}

// ── Freshness check ─────────────────────────────────────────────

/**
 * Check whether the cached repo-map.md is still fresh.
 *
 * Freshness is determined by:
 * 1. The cache metadata file must exist
 * 2. The repo-map.md file must exist on disk
 * 3. The current structure hash must match the cached hash
 *
 * @param cwd - Working directory (optional).
 * @returns A `FreshnessResult` with a boolean and explanation.
 */
export async function isRepoMapFresh(cwd?: string): Promise<FreshnessResult> {
  const cacheData = await readRepoMapCache(cwd)

  if (!cacheData) {
    return { fresh: false, reason: "No repo-map cache metadata found" }
  }

  // Check that the repo-map.md file still exists
  try {
    await fs.access(cacheData.path)
  } catch {
    return {
      fresh: false,
      reason: `Cached repo-map.md not found at ${cacheData.path}`,
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
