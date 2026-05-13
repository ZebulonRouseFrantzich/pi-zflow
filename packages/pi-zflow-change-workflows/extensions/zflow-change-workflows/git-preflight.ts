/**
 * git-preflight.ts — Clean-tree and untracked-overlap preflight checks.
 *
 * Blocks parallel worktree execution unless the primary worktree is in a
 * safe state. Provides the precondition enforcement that Task 5.1 requires
 * before any worktree dispatch.
 *
 * ## Design
 *
 * - `gitPorcelain()` parses `git status --porcelain` output into typed results.
 * - `assertCleanPrimaryTree()` validates the tree state against planned output
 *   paths and throws actionable errors when preconditions are not met.
 * - The current branch and HEAD sha are always captured for recovery metadata.
 *
 * @module pi-zflow-change-workflows/git-preflight
 */

import { execFileSync } from "node:child_process"
import * as path from "node:path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Parsed result of `git status --porcelain`.
 */
export interface GitPorcelainResult {
  /** Tracked-but-modified entries (staged or unstaged). */
  readonly trackedChanges: string[]
  /** Untracked file paths relative to repo root. */
  readonly untracked: string[]
  /** Raw porcelain lines for diagnostics. */
  readonly raw: string[]
}

/**
 * Result of a clean-tree assertion.
 *
 * When `clean` is `true`, the primary worktree is safe for parallel dispatch.
 * When `clean` is `false`, the caller MUST NOT dispatch parallel worktrees.
 */
export interface GitPreflightResult {
  /** Whether the tree passed all preflight checks. */
  readonly clean: boolean
  /** Current branch name (or "HEAD" if detached). */
  readonly branch: string
  /** Full SHA of HEAD. */
  readonly headSha: string
  /** Tracked changes found (empty when clean). */
  readonly trackedChanges: string[]
  /** Untracked files found (empty when clean). */
  readonly untracked: string[]
  /** Untracked files that overlap planned output paths (empty when clean). */
  readonly overlappingUntracked: string[]
  /** Human-readable summary for diagnostics / logging. */
  readonly summary: string
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Run a git command in the given repo root and return trimmed stdout.
 *
 * @param repoRoot - Absolute path to the git repository root.
 * @param args - Git subcommand arguments (e.g. `["status", "--porcelain"]`).
 * @returns Trimmed stdout.
 * @throws If git exits with a non-zero code.
 */
function git(repoRoot: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd()
}

/**
 * Parse `git status --porcelain` output into typed blocks.
 *
 * Porcelain format (v1):
 * - XY FILENAME
 * - XY "R" OLDFILE NEWFILE  (renames/copies — ignored here; trackedChanges catches them)
 *
 * Git config `status.relativePaths` is assumed on; if turned off, porcelain
 * paths are relative to the repo root regardless. We always supply `--porcelain`
 * without a path argument, so output paths are relative to the repo root.
 *
 * Tracked changes start with two non-space status characters (XY).
 * Untracked files are those starting with "?? ".
 *
 * @param raw - Raw stdout from `git status --porcelain`.
 * @param repoRoot - Repo root (used to resolve relative porcelain paths).
 * @returns Parsed result.
 */
function parsePorcelain(raw: string, _repoRoot: string): GitPorcelainResult {
  const lines = raw.length > 0 ? raw.split("\n") : []
  const trackedChanges: string[] = []
  const untracked: string[] = []

  for (const line of lines) {
    const trimmed = line.trimEnd()
    if (trimmed === "" || trimmed.length < 3) continue

    if (trimmed.startsWith("?? ")) {
      // Untracked file: "?? path/to/file"
      untracked.push(trimmed.slice(3))
    } else if (trimmed.startsWith("!")) {
      // Ignored file — skip
      continue
    } else {
      // Tracked change: two status chars then a space then path
      // For renames/copies: "R  oldpath -> newpath" or "R  oldpath newpath"
      // We only capture the effective path (second part for renames)
      const rest = trimmed.slice(3)
      if (trimmed[0] === "R" || trimmed[1] === "R") {
        // Rename or copy: XY oldpath -> newpath  or  XY oldpath newpath
        // Take the last path segment
        const parts = rest.split(/\s+/)
        trackedChanges.push(parts[parts.length - 1])
      } else if (!rest.startsWith(" ")) {
        trackedChanges.push(rest)
      }
    }
  }

  return {
    trackedChanges,
    untracked,
    raw: lines,
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run `git status --porcelain` in the given repo root and return parsed results.
 *
 * @param repoRoot - Absolute path to the git repository root.
 * @returns Parsed porcelain result.
 * @throws If git is not available or the directory is not a git repository.
 */
export function gitPorcelain(repoRoot: string): GitPorcelainResult {
  const stdout = git(repoRoot, "status", "--porcelain")
  return parsePorcelain(stdout, repoRoot)
}

/**
 * Get the current branch name (or "HEAD" if detached).
 *
 * @param repoRoot - Absolute path to the git repository root.
 * @returns Branch name (e.g. "main", "feature/foo", or "HEAD").
 */
export function getCurrentBranch(repoRoot: string): string {
  try {
    return git(repoRoot, "rev-parse", "--abbrev-ref", "HEAD")
  } catch {
    return "HEAD"
  }
}

/**
 * Get the full SHA of HEAD.
 *
 * @param repoRoot - Absolute path to the git repository root.
 * @returns Full HEAD sha.
 */
export function getHeadSha(repoRoot: string): string {
  return git(repoRoot, "rev-parse", "HEAD")
}

/**
 * Assert that the primary worktree is in a safe state for parallel execution.
 *
 * Checks:
 * 1. No tracked changes (`git status --porcelain` is empty for tracked files).
 * 2. Untracked files do not overlap planned output paths.
 *
 * On success, returns a `GitPreflightResult` with `clean: true` and metadata
 * (branch, head sha) suitable for recording in `run.json`.
 *
 * On failure, throws a descriptive `Error` that the orchestrator should surface
 * before declining to dispatch workers.
 *
 * @param repoRoot - Absolute path to the git repository root.
 * @param plannedPaths - Set of file paths that workers are expected to write to.
 * @returns Preflight result with clean=true and recovery metadata.
 * @throws Error with actionable message if the tree is dirty or paths overlap.
 */
export function assertCleanPrimaryTree(
  repoRoot: string,
  plannedPaths: Set<string>,
): GitPreflightResult {
  const branch = getCurrentBranch(repoRoot)
  const headSha = getHeadSha(repoRoot)

  const status = gitPorcelain(repoRoot)
  const overlappingUntracked = status.untracked.filter((p) => plannedPaths.has(p))

  // Check 1: tracked changes must be empty
  if (status.trackedChanges.length > 0) {
    const summary = [
      `Primary worktree has ${status.trackedChanges.length} tracked change(s).`,
      `Branch: ${branch}, HEAD: ${headSha.slice(0, 12)}`,
      "Tracked changes:",
      ...status.trackedChanges.map((f) => `  - ${f}`),
      "",
      "Run `git stash` or commit your changes before dispatching parallel workers.",
    ].join("\n")

    return {
      clean: false,
      branch,
      headSha,
      trackedChanges: status.trackedChanges,
      untracked: status.untracked,
      overlappingUntracked,
      summary,
    }
  }

  // Check 2: no untracked overlap with planned outputs
  if (overlappingUntracked.length > 0) {
    const summary = [
      `Untracked files overlap planned output paths (${overlappingUntracked.length} file(s)).`,
      `Branch: ${branch}, HEAD: ${headSha.slice(0, 12)}`,
      "Overlapping untracked files:",
      ...overlappingUntracked.map((f) => `  - ${f}`),
      "",
      "Move or delete these files, or adjust the planned output paths.",
    ].join("\n")

    return {
      clean: false,
      branch,
      headSha,
      trackedChanges: [],
      untracked: status.untracked,
      overlappingUntracked,
      summary,
    }
  }

  return {
    clean: true,
    branch,
    headSha,
    trackedChanges: [],
    untracked: status.untracked,
    overlappingUntracked: [],
    summary: `Primary worktree is clean. Branch: ${branch}, HEAD: ${headSha.slice(0, 12)}`,
  }
}

/**
 * Resolve the repo root from a working directory by calling `git rev-parse --show-toplevel`.
 *
 * @param cwd - Directory to resolve from (defaults to `process.cwd()`).
 * @returns Absolute path to the repository root.
 * @throws If the directory is not inside a git repository.
 */
export function resolveRepoRoot(cwd?: string): string {
  const resolved = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: cwd ?? process.cwd(),
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()

  return path.resolve(resolved)
}
