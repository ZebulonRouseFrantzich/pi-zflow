/**
 * group-result.ts — Captures worker outputs, changed-file manifests, and patch artifacts.
 *
 * Normalizes the metadata produced by each worktree run so apply-back and
 * recovery can reason over it. Called after a worker completes in its
 * isolated worktree.
 *
 * ## Per-group metadata captured
 *
 * - group id/name
 * - assigned agent
 * - worktree path
 * - base commit
 * - worktree head commit/ref
 * - changed files
 * - patch artifact path
 * - scoped verification result
 * - retained/not-retained status
 *
 * @module pi-zflow-change-workflows/group-result
 */

import * as path from "node:path"
import * as fs from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { resolveRunDir } from "pi-zflow-artifacts/artifact-paths"
import { readRun, updateRun } from "pi-zflow-artifacts/run-state"

// Synchronous file operations for patch writing
import * as fsSync from "node:fs"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of scoped verification for a group.
 */
export interface GroupVerificationResult {
  /** Overall status. */
  status: "pass" | "fail" | "skipped" | "missing"
  /** The verification command that was run. */
  command?: string
  /** Truncated stdout/stderr from verification. */
  output?: string
}

/**
 * Complete normalized metadata for a single execution group's worktree run.
 */
export interface GroupResult {
  /** Group identifier from execution-groups.md. */
  groupId: string
  /** Assigned agent runtime name. */
  agent: string
  /** Absolute path to the worktree where the worker ran. */
  worktreePath: string
  /** Base commit SHA (HEAD of primary when worktree was created). */
  baseCommit: string
  /** Head commit SHA of the worktree after the worker completed. */
  headCommit: string
  /** Files changed by this group (relative to repo root). */
  changedFiles: string[]
  /** Absolute path to the patch artifact file. */
  patchPath: string
  /** Result of scoped verification. */
  verification?: GroupVerificationResult
  /** Whether this group's worktree/patch should be retained. */
  retained: boolean
}

/**
 * Options for capturing a group result from a worktree.
 */
export interface CaptureGroupResultOptions {
  /** Group identifier. */
  groupId: string
  /** Assigned agent runtime name. */
  agent: string
  /** Absolute path to the worktree. */
  worktreePath: string
  /** Run ID for persisting metadata. */
  runId: string
  /** Repo root (used for relative path resolution and git commands). */
  repoRoot: string
  /** Scope of files this group was expected to change (for diff filtering). */
  scopedFiles: string[]
  /** Whether to retain the worktree after capture. */
  retain?: boolean
  /** Scoped verification command output (optional). */
  verification?: GroupVerificationResult
  /** Working directory for runtime state dir resolution. */
  cwd?: string
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Get the HEAD commit SHA of a worktree or repo.
 */
function getHeadSha(cwd: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

/**
 * Get the diff between two commits for specific files.
 *
 * Returns unified diff output as a string.
 */
function getDiff(repoRoot: string, baseCommit: string, headCommit: string, paths: string[]): string {
  try {
    const result = execFileSync("git", [
      "diff", baseCommit, headCommit, "--",
      ...paths,
    ], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024, // 10MB
    })
    return result
  } catch {
    // Fall back to full diff if scoped diff fails
    try {
      return execFileSync("git", [
        "diff", baseCommit, headCommit,
      ], {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 10 * 1024 * 1024,
      })
    } catch {
      return ""
    }
  }
}

/**
 * Get the list of files changed between two commits, scoped to specific paths.
 */
function getChangedFiles(repoRoot: string, baseCommit: string, headCommit: string, scopedFiles: string[]): string[] {
  try {
    const result = execFileSync("git", [
      "diff", "--name-only", baseCommit, headCommit, "--",
      ...scopedFiles,
    ], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    return result.trim().split("\n").filter(Boolean)
  } catch {
    // Fall back to full file list
    try {
      const result = execFileSync("git", [
        "diff", "--name-only", baseCommit, headCommit,
      ], {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      })
      return result.trim().split("\n").filter(Boolean)
    } catch {
      return []
    }
  }
}

/**
 * Write a patch file from the diff between two commits.
 */
function writePatchFile(repoRoot: string, baseCommit: string, headCommit: string, patchPath: string, scopedFiles: string[]): void {
  const diff = getDiff(repoRoot, baseCommit, headCommit, scopedFiles)
  execFileSync("mkdir", ["-p", path.dirname(patchPath)], { stdio: "pipe" })
  fsSync.writeFileSync(patchPath, diff, "utf-8")
}

// ---------------------------------------------------------------------------
// Main capture function
// ---------------------------------------------------------------------------

/**
 * Capture the result of a worktree group run.
 *
 * Collects changed files, creates a patch artifact, and records the
 * normalized metadata in the run's run.json.
 *
 * @param options - Capture options.
 * @returns The captured GroupResult.
 */
export async function captureGroupResult(
  options: CaptureGroupResultOptions,
): Promise<GroupResult> {
  const {
    groupId,
    agent,
    worktreePath,
    runId,
    repoRoot,
    scopedFiles,
    retain = false,
    verification,
    cwd,
  } = options

  // Resolve the base commit (the worktree was created from this)
  const baseCommit = getHeadSha(repoRoot)

  // Get the worktree's head commit
  const headCommit = getHeadSha(worktreePath)

  // Get changed files
  const changedFiles = getChangedFiles(repoRoot, baseCommit, headCommit, scopedFiles)

  // Write the patch artifact
  const runDir = resolveRunDir(runId, cwd)
  const patchesDir = path.join(runDir, "patches")
  const patchPath = path.join(patchesDir, `${groupId}.patch`)
  writePatchFile(repoRoot, baseCommit, headCommit, patchPath, scopedFiles)

  // Build the group result
  const groupResult: GroupResult = {
    groupId,
    agent,
    worktreePath,
    baseCommit,
    headCommit,
    changedFiles,
    patchPath,
    verification,
    retained: retain,
  }

  // Persist to run.json
  const run = await readRun(runId, cwd)
  const existingIndex = run.groups.findIndex((g) => g.groupId === groupId)

  const groupMeta = {
    groupId,
    agent,
    worktreePath,
    baseCommit,
    headCommit,
    changedFiles,
    patchPath,
    scopedVerification: verification
      ? {
          status: verification.status,
          command: verification.command,
          output: verification.output,
        }
      : undefined,
    retained: retain,
  }

  if (existingIndex >= 0) {
    run.groups[existingIndex] = groupMeta
  } else {
    run.groups.push(groupMeta)
  }

  await updateRun(runId, { groups: run.groups }, cwd)

  return groupResult
}

/**
 * Read a group result from a run's metadata.
 *
 * @param runId - Unique run identifier.
 * @param groupId - Group identifier.
 * @param cwd - Working directory (optional).
 * @returns The GroupResult for the given group, or null if not found.
 */
export async function getGroupResult(
  runId: string,
  groupId: string,
  cwd?: string,
): Promise<GroupResult | null> {
  const run = await readRun(runId, cwd)
  const group = run.groups.find((g) => g.groupId === groupId)
  if (!group) return null

  return {
    groupId: group.groupId,
    agent: group.agent,
    worktreePath: group.worktreePath,
    baseCommit: group.baseCommit,
    headCommit: group.headCommit ?? "",
    changedFiles: group.changedFiles,
    patchPath: group.patchPath,
    verification: group.scopedVerification
      ? {
          status: group.scopedVerification.status,
          command: group.scopedVerification.command,
          output: group.scopedVerification.output,
        }
      : undefined,
    retained: group.retained,
  }
}

/**
 * List all group results for a run.
 *
 * @param runId - Unique run identifier.
 * @param cwd - Working directory (optional).
 * @returns Array of GroupResult objects.
 */
export async function listGroupResults(
  runId: string,
  cwd?: string,
): Promise<GroupResult[]> {
  const run = await readRun(runId, cwd)
  return run.groups.map((group) => ({
    groupId: group.groupId,
    agent: group.agent,
    worktreePath: group.worktreePath,
    baseCommit: group.baseCommit,
    headCommit: group.headCommit ?? "",
    changedFiles: group.changedFiles,
    patchPath: group.patchPath,
    verification: group.scopedVerification
      ? {
          status: group.scopedVerification.status,
          command: group.scopedVerification.command,
          output: group.scopedVerification.output,
        }
      : undefined,
    retained: group.retained,
  }))
}
