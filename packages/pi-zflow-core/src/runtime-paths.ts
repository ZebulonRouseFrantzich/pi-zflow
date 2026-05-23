/**
 * Shared runtime path resolvers and cleanup defaults.
 *
 * These resolvers are used by multiple pi-zflow child packages to determine
 * where runtime state artifacts live. The contracts here must not be duplicated.
 *
 * @module pi-zflow-core/runtime-paths
 */

import * as path from "node:path"
import * as os from "node:os"
import * as fs from "node:fs"
import { createHash } from "node:crypto"
import { execSync } from "node:child_process"

// ---------------------------------------------------------------------------
// Cleanup defaults
// ---------------------------------------------------------------------------

/**
 * Default TTL for stale runtime/patch artifacts, in days.
 * Artifacts older than this may be cleaned by `/zflow-clean`.
 */
export const DEFAULT_STALE_ARTIFACT_TTL_DAYS = 14

/**
 * Default retention period for failed or interrupted worktrees, in days.
 * Worktrees that failed to apply back are kept this long before auto-cleanup.
 */
export const DEFAULT_FAILED_WORKTREE_RETENTION_DAYS = 7

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Produce a short, stable hash from an input string.
 * Used for deterministic temp-directory naming so the same cwd always
 * maps to the same fallback runtime directory.
 */
function stableHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12)
}

/**
 * Resolve the git directory (`.git` location) for a given working directory.
 *
 * Uses `git rev-parse --git-dir` to find the actual git metadata directory,
 * which correctly handles:
 *   - worktrees (separate git-dir)
 *   - submodules (nested git-dir)
 *   - `GIT_DIR` environment overrides
 *
 * Returns `null` if `cwd` is not inside a git repository.
 */
export function resolveGitDir(cwd: string): string | null {
  try {
    const gitDir = execSync("git rev-parse --git-dir", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim()
    return path.resolve(cwd, gitDir)
  } catch {
    return null
  }
}

/**
 * Check whether `cwd` (or `process.cwd()`) is inside a git repository.
 */
export function inGitRepo(cwd: string = process.cwd()): boolean {
  return resolveGitDir(cwd) !== null
}

// ---------------------------------------------------------------------------
// Public path resolvers
// ---------------------------------------------------------------------------

/**
 * Resolve the git working tree top-level directory.
 *
 * Uses `git rev-parse --show-toplevel`.
 *
 * Returns `null` if `cwd` is not inside a git repository.
 */
export function resolveGitToplevel(cwd: string = process.cwd()): string | null {
  try {
    const topLevel = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim()
    return topLevel || null
  } catch {
    // not a git repo
    return null
  }
}

/**
 * Ensure the runtime state directory exists and contains a `.gitignore`
 * that prevents the runtime artifacts from being tracked by git.
 *
 * Called by artifact path resolvers before the first write to a runtime
 * state path.  No-op on subsequent calls within the same process via an
 * internal cache.
 *
 * @param cwd - Working directory to resolve from (default: `process.cwd()`)
 */
const ensuredRuntimeDirs = new Set<string>()

export function ensureRuntimeStateDir(cwd: string = process.cwd()): string {
  const dir = resolveRuntimeStateDir(cwd)
  if (ensuredRuntimeDirs.has(dir)) return dir
  ensuredRuntimeDirs.add(dir)

  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    // Write a .gitignore that ignores everything inside .zflow/ except
    // the .gitignore itself. Also add .zflow/ to .git/info/exclude when
    // possible so the .zflow directory itself does not pollute `git status`.
    const gitignorePath = path.join(dir, ".gitignore")
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, "*\n!.gitignore\n", "utf-8")
    }

    const gitDir = resolveGitDir(cwd)
    if (gitDir) {
      const excludePath = path.join(gitDir, "info", "exclude")
      const excludeEntry = ".zflow/"
      try {
        fs.mkdirSync(path.dirname(excludePath), { recursive: true })
        const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf-8") : ""
        if (!existing.split(/\r?\n/).some((line) => line.trim() === excludeEntry)) {
          const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""
          fs.writeFileSync(excludePath, `${existing}${prefix}${excludeEntry}\n`, "utf-8")
        }
      } catch {
        // Best-effort only.
      }
    }
  } catch {
    // Non-fatal — ignore setup is best-effort
  }

  return dir
}

/**
 * Resolve the runtime state root directory for a project.
 *
 * **Primary** (inside a git repo):
 *   `<repo-toplevel>/.zflow/`
 *   This places state in a repo-visible directory outside the working tree
 *   pattern, while keeping it out of `.git/` internals.
 *
 * **Fallback** (outside git):
 *   `<os.tmpdir()>/pi-zflow-<stable-cwd-hash>/`
 *   The hash ensures different projects don't collide.
 *
 * @param cwd - Working directory to resolve from (default: `process.cwd()`)
 */
export function resolveRuntimeStateDir(cwd: string = process.cwd()): string {
  const gitToplevel = resolveGitToplevel(cwd)
  if (gitToplevel) {
    return path.join(gitToplevel, ".zflow")
  }
  return path.join(os.tmpdir(), `pi-zflow-${stableHash(cwd)}`)
}

/**
 * Resolve the user-local state root directory.
 *
 * Always returns `~/.pi/agent/zflow/` regardless of the current project.
 * This directory stores user-level agent/chains state, active profile cache,
 * and install manifests.
 */
export function resolveUserStateDir(): string {
  return path.join(os.homedir(), ".pi", "agent", "zflow")
}
