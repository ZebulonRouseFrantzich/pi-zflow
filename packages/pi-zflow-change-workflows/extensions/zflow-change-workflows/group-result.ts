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
 * - changed files (committed + uncommitted)
 * - patch artifact path (binary-safe)
 * - scoped verification result
 * - retained/not-retained status
 *
 * ## Design
 *
 * - All git diff commands run FROM the worktree directory (worktreePath as cwd).
 * - Patches are generated with `--binary` for safe apply-back replay.
 * - Uncommitted changes in the worktree are captured alongside committed diffs.
 *
 * @module pi-zflow-change-workflows/group-result
 */

import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { resolveRunDir } from "pi-zflow-artifacts/artifact-paths"
import { readRun, updateRun } from "pi-zflow-artifacts/run-state"

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
  /** Files with uncommitted changes in the worktree. */
  uncommittedChanges: string[]
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
// Git helpers — all commands run from the worktree directory
// ---------------------------------------------------------------------------

/**
 * Run a git command in the given working directory and return trimmed stdout.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024, // 10MB
  }).trimEnd()
}

/**
 * Run a git diff command. Preserves trailing newlines because
 * patch/diff output must remain valid for `git apply`.
 */
function gitDiff(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024, // 10MB
  })
}

/**
 * Get the HEAD commit SHA in the given working directory.
 */
function getHeadSha(cwd: string): string {
  return git(cwd, "rev-parse", "HEAD")
}

/**
 * Get the list of files changed between two commits, scoped to specific paths.
 *
 * Runs from `worktreeCwd` to ensure we capture worktree-local changes.
 */
function getChangedFiles(
  worktreeCwd: string,
  baseCommit: string,
  scopedFiles: string[],
): string[] {
  // Committed changes between base and HEAD
  let committed: string[] = []
  try {
    const out = git(
      worktreeCwd,
      "diff", "--name-only", baseCommit, "HEAD", "--",
      ...scopedFiles,
    )
    committed = out ? out.split("\n").filter(Boolean) : []
  } catch {
    try {
      const out = git(worktreeCwd, "diff", "--name-only", baseCommit, "HEAD")
      committed = out ? out.split("\n").filter(Boolean) : []
    } catch {
      committed = []
    }
  }

  // Uncommitted changes (working tree vs HEAD, tracked files only)
  let uncommittedTracked: string[] = []
  try {
    const out = git(
      worktreeCwd,
      "diff", "--name-only", "HEAD", "--",
      ...scopedFiles,
    )
    uncommittedTracked = out ? out.split("\n").filter(Boolean) : []
  } catch {
    try {
      const out = git(worktreeCwd, "diff", "--name-only", "HEAD")
      uncommittedTracked = out ? out.split("\n").filter(Boolean) : []
    } catch {
      uncommittedTracked = []
    }
  }

  // Untracked files (not yet tracked by git)
  let untracked: string[] = []
  try {
    const out = git(worktreeCwd, "ls-files", "--others", "--exclude-standard")
    untracked = out ? out.split("\n").filter(Boolean) : []
  } catch {
    untracked = []
  }

  // Merge and deduplicate all three lists
  const seen = new Set<string>()
  return [...committed, ...uncommittedTracked, ...untracked].filter((f) => {
    if (seen.has(f)) return false
    seen.add(f)
    return true
  })
}

/**
 * Generate a binary-safe patch from the worktree's changes.
 *
 * Combines committed diff (base->HEAD) and uncommitted diff (HEAD->working tree).
 * Writes the combined patch atomically to `patchPath`.
 *
 * @param worktreeCwd - Worktree root directory (cd here for git commands).
 * @param baseCommit - The commit the worktree was created from.
 * @param patchPath - Absolute path to write the patch file to.
 * @param scopedFiles - Files to scope the diff to.
 */
function writeBinaryPatch(
  worktreeCwd: string,
  baseCommit: string,
  patchPath: string,
  scopedFiles: string[],
): void {
  // 1. Get committed diff (base -> HEAD) with --binary
  let committedDiff = ""
  try {
    committedDiff = gitDiff(
      worktreeCwd,
      "diff", "--binary", baseCommit, "HEAD", "--",
      ...scopedFiles,
    )
  } catch {
    try {
      committedDiff = gitDiff(worktreeCwd, "diff", "--binary", baseCommit, "HEAD")
    } catch {
      committedDiff = ""
    }
  }

  // 2. Get uncommitted diff (HEAD -> working tree) with --binary
  let hadIntentToAdd = false
  try {
    const untrackedOut = git(worktreeCwd, "ls-files", "--others", "--exclude-standard")
    const untrackedFiles = untrackedOut ? untrackedOut.split("\n").filter(Boolean) : []
    if (untrackedFiles.length > 0) {
      for (const f of untrackedFiles) {
        git(worktreeCwd, "add", "-N", "--", f)
      }
      hadIntentToAdd = true
    }
  } catch {
    // Ignore errors
  }

  let uncommittedDiff = ""
  try {
    uncommittedDiff = gitDiff(
      worktreeCwd,
      "diff", "--binary", "HEAD", "--",
      ...scopedFiles,
    )
  } catch {
    try {
      uncommittedDiff = gitDiff(worktreeCwd, "diff", "--binary", "HEAD")
    } catch {
      uncommittedDiff = ""
    }
  }

  if (hadIntentToAdd) {
    try {
      git(worktreeCwd, "reset", "HEAD", "--", ".")
    } catch {
      // Best-effort cleanup
    }
  }

  // 3. Combine patches, ensuring trailing newline for git apply
  const combined = [committedDiff, uncommittedDiff].filter(Boolean).join("")
  // Ensure the patch ends with exactly one newline
  const finalPatch = combined.endsWith("\n") ? combined : combined + "\n"

  mkdirSync(path.dirname(patchPath), { recursive: true })
  fsSync.writeFileSync(patchPath, finalPatch, "utf-8")
}

// ---------------------------------------------------------------------------
// Main capture function
// ---------------------------------------------------------------------------

/**
 * Capture the result of a worktree group run.
 *
 * Collects changed files (committed + uncommitted), creates a binary-safe
 * patch artifact, and records the normalized metadata in the run's run.json.
 *
 * All git diff commands run FROM the worktree directory (`worktreePath`)
 * to ensure changes in the isolated worktree are captured correctly.
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

  // The base commit is the commit the worktree was created from (the primary's HEAD)
  const baseCommit = getHeadSha(repoRoot)

  // The worktree's HEAD (may differ from base if worker committed)
  const headCommit = getHeadSha(worktreePath)

  // Get changed files FROM the worktree (captures both committed and uncommitted)
  const changedFiles = getChangedFiles(worktreePath, baseCommit, scopedFiles)

  // Get uncommitted-only changes (tracked modifications + untracked files)
  let uncommitted: string[] = []
  try {
    const out = git(
      worktreePath,
      "diff", "--name-only", "HEAD", "--",
      ...scopedFiles,
    )
    uncommitted = out ? out.split("\n").filter(Boolean) : []
  } catch {
    try {
      const out = git(worktreePath, "diff", "--name-only", "HEAD")
      uncommitted = out ? out.split("\n").filter(Boolean) : []
    } catch {
      uncommitted = []
    }
  }

  // Also include untracked files in uncommitted list
  try {
    const out = git(worktreePath, "ls-files", "--others", "--exclude-standard")
    const untrackedFiles = out ? out.split("\n").filter(Boolean) : []
    const seen = new Set(uncommitted)
    for (const f of untrackedFiles) {
      if (!seen.has(f)) {
        uncommitted.push(f)
        seen.add(f)
      }
    }
  } catch {
    // Ignore errors discovering untracked files
  }

  // Write binary-safe patch artifact
  const runDir = resolveRunDir(runId, cwd)
  const patchesDir = path.join(runDir, "patches")
  const patchPath = path.join(patchesDir, `${groupId}.patch`)
  writeBinaryPatch(worktreePath, baseCommit, patchPath, scopedFiles)

  // Build the group result
  const groupResult: GroupResult = {
    groupId,
    agent,
    worktreePath,
    baseCommit,
    headCommit,
    changedFiles,
    uncommittedChanges: uncommitted,
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
    uncommittedChanges: uncommitted,
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
    uncommittedChanges: group.uncommittedChanges ?? [],
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
    uncommittedChanges: group.uncommittedChanges ?? [],
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
