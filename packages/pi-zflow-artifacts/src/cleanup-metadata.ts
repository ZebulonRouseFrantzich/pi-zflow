/**
 * cleanup-metadata.ts — Artifact cleanup metadata helpers.
 *
 * Implements TTL-based artifact scanning, cleanup, and dry-run preview
 * for the `/zflow-clean` command. Integrated with pi-zflow-core's
 * DEFAULT_STALE_ARTIFACT_TTL_DAYS and DEFAULT_FAILED_WORKTREE_RETENTION_DAYS.
 *
 * ## Usage
 *
 * ```ts
 * import { scanForCleanup, cleanupArtifacts, formatCleanupSummary } from "pi-zflow-artifacts/cleanup-metadata"
 *
 * const candidates = await scanForCleanup(runtimeStateDir)
 * const result = await cleanupArtifacts(candidates, { dryRun: true })
 * console.log(formatCleanupSummary(candidates))
 * ```
 *
 * @module pi-zflow-artifacts/cleanup-metadata
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import {
  resolveRuntimeStateDir,
  DEFAULT_STALE_ARTIFACT_TTL_DAYS,
  DEFAULT_FAILED_WORKTREE_RETENTION_DAYS,
} from "pi-zflow-core/runtime-paths"
import type { ArtifactCleanupMeta } from "./artifact-paths.js"

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/**
 * Options for the cleanup scanner.
 */
export interface ScanOptions {
  /** Override TTL for stale artifacts in days (default: 14). */
  staleDays?: number
  /** Override retention for failed worktrees in days (default: 7). */
  failedWorktreeDays?: number
}

/**
 * Scan a runtime state directory for cleanup candidates.
 *
 * Iterates over the immediate children of the given directory and checks
 * their age against TTL policies. Failed/interrupted worktrees are
 * detected heuristically by path name patterns.
 *
 * @param dir - The directory to scan (typically `<runtime-state-dir>`).
 * @param options - Scan options (TTL overrides).
 * @returns Array of cleanup candidates that exceed their TTL.
 */
export async function scanForCleanup(
  dir: string,
  options?: ScanOptions,
): Promise<ArtifactCleanupMeta[]> {
  const staleDays = options?.staleDays ?? DEFAULT_STALE_ARTIFACT_TTL_DAYS
  const failedDays = options?.failedWorktreeDays ?? DEFAULT_FAILED_WORKTREE_RETENTION_DAYS
  const now = Date.now()
  const results: ArtifactCleanupMeta[] = []

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)

      try {
        const stat = await fs.stat(fullPath)
        const ageDays = (now - stat.mtimeMs) / (1000 * 60 * 60 * 24)

        // Heuristic: detect failed/interrupted worktrees by name patterns
        const isFailedWorktree =
          entry.name.includes("failed") ||
          entry.name.includes("conflict") ||
          entry.name.includes("error") ||
          entry.name.includes("interrupted")

        const maxAge = isFailedWorktree ? failedDays : staleDays

        if (ageDays > maxAge) {
          results.push({
            path: fullPath,
            mtime: stat.mtimeMs,
            size: stat.size,
            isFailedWorktree,
            description: `${isFailedWorktree ? "Failed worktree" : "Stale artifact"} (${Math.floor(ageDays)} day(s) old, ${(stat.size / 1024).toFixed(1)} KB)`,
          })
        }
      } catch {
        // Skip entries we can't stat (permissions, broken symlinks, etc.)
      }
    }
  } catch {
    // Directory doesn't exist or can't be read — no candidates
  }

  return results
}

/**
 * Scan the runtime state directory for cleanup candidates.
 *
 * Convenience wrapper that resolves the runtime state dir for the given
 * working directory and delegates to `scanForCleanup`.
 *
 * @param cwd - Working directory (defaults to `process.cwd()`).
 * @param options - Scan options (TTL overrides).
 * @returns Array of cleanup candidates.
 */
export async function scanRuntimeStateForCleanup(
  cwd?: string,
  options?: ScanOptions,
): Promise<ArtifactCleanupMeta[]> {
  const runtimeDir = resolveRuntimeStateDir(cwd)
  return scanForCleanup(runtimeDir, options)
}

// ---------------------------------------------------------------------------
// Cleanup execution
// ---------------------------------------------------------------------------

/**
 * Options for the cleanup operation.
 */
export interface CleanupOptions {
  /** If true, only preview what would be deleted; do not actually remove. */
  dryRun?: boolean
}

/**
 * Result of a cleanup operation.
 */
export interface CleanupResult {
  /** Number of artifacts successfully cleaned. */
  cleaned: number
  /** Number of artifacts kept (skipped or failed). */
  kept: number
  /** Error messages for any failures. */
  errors: string[]
}

/**
 * Execute cleanup for a list of candidates.
 *
 * When `dryRun` is true, no files are deleted — all candidates are
 * counted as "cleaned" in the result summary.
 *
 * @param candidates - Cleanup candidates from `scanForCleanup()`.
 * @param options - Cleanup options (dry-run mode).
 * @returns Summary of what was cleaned, kept, and any errors.
 */
export async function cleanupArtifacts(
  candidates: ArtifactCleanupMeta[],
  options?: CleanupOptions,
): Promise<CleanupResult> {
  let cleaned = 0
  let kept = 0
  const errors: string[] = []

  if (options?.dryRun) {
    // In dry-run mode, nothing is actually deleted
    return { cleaned: candidates.length, kept: 0, errors: [] }
  }

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate.path)
      if (stat.isDirectory()) {
        await fs.rm(candidate.path, { recursive: true, force: true })
      } else {
        await fs.unlink(candidate.path)
      }
      cleaned++
    } catch (err: unknown) {
      errors.push(
        `Failed to clean ${candidate.path}: ${err instanceof Error ? err.message : String(err)}`,
      )
      kept++
    }
  }

  return { cleaned, kept, errors }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Build a human-readable dry-run summary for cleanup preview.
 *
 * @param candidates - Cleanup candidates from `scanForCleanup()`.
 * @returns A markdown-formatted summary string.
 */
export function formatCleanupSummary(candidates: ArtifactCleanupMeta[]): string {
  if (candidates.length === 0) return "No cleanup candidates found."

  const lines = [
    `Found ${candidates.length} cleanup candidate(s):`,
    "",
  ]

  for (const c of candidates) {
    lines.push(`- ${c.description}: \`${c.path}\``)
  }

  return lines.join("\n")
}
