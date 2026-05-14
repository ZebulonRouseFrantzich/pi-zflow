/**
 * path-guard.ts — Change-workflows path guard implementation.
 *
 * Enforces mutation policies for implementation and planning workflows:
 * - Allowlists project root, active worktrees, and planner artifact paths
 * - Rejects writes to `.git`, `node_modules`, `.env*`, home dotfiles, secret files
 * - Rejects symlink escapes and traversal
 * - Planner may only write approved plan artifacts via `zflow_write_plan_artifact`
 * - Non-implementation/report agents should return output instead of writing files
 * - When the guard blocks a tool call, it returns an actionable error message
 *
 * ## Usage
 *
 * ```ts
 * import { guardWrite, guardBashCommand, type GuardResult }
 *   from "pi-zflow-change-workflows/path-guard"
 *
 * const result = guardWrite("/path/to/file", { intent: "write" })
 * if (!result.allowed) throw new Error(result.message)
 * ```
 *
 * See `docs/path-guard-policy.md` for the full design.
 *
 * @module pi-zflow-change-workflows/path-guard
 */

import * as path from "node:path"
import * as os from "node:os"
import { realpathSafe } from "pi-zflow-core/path-guard"
import { resolveRuntimeStateDir } from "pi-zflow-core/runtime-paths"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Intent of the write operation.
 */
export type GuardIntent =
  | "write"           // General file write/edit
  | "planner-artifact" // Planner writing approved plan artifacts
  | "bash-mutation"   // Bash command with destructive side effects
  | "implement"       // Implementation workflow write

/**
 * Result of a path guard check.
 */
export interface GuardResult {
  /** Whether the operation is allowed. */
  allowed: boolean
  /** Human-readable message describing why it was allowed or denied. */
  message: string
  /** The resolved absolute path that was checked. */
  resolvedPath: string
}

/**
 * Options for guard checks.
 */
export interface GuardOptions {
  /** Project root directory. */
  projectRoot: string
  /** Optional runtime state directory for planner artifact detection. */
  runtimeStateDir?: string
  /** Optional active worktree paths that are allowlisted. */
  worktreePaths?: string[]
  /** Whether planner artifact path tracking is enabled. */
  plannerMode?: boolean
}

// ---------------------------------------------------------------------------
// Blocked path patterns (always denied)
// ---------------------------------------------------------------------------

/**
 * Patterns that are always blocked, regardless of intent or allowlist.
 * These protect critical infrastructure, secrets, and package manager state.
 */
const BLOCKED_PATH_PATTERNS: RegExp[] = [
  // Git internals — allow .git/pi-zflow/ (runtime state dir)
  /(?:^|[/\\])\.git\/(?!pi-zflow\/)/,
  // Node modules
  /\bnode_modules\b/,
  // Environment files
  /(?:^|[/\\])\.env\b/,
  /(?:^|[/\\])\.env\.\w+/,
  // Home directory dotfiles (includes ~/.pi, ~/.ssh, etc.)
  /^\/(home|Users)\/[^/]+\/\.[a-zA-Z]/,
  // Secret-like files
  /\b(?:id_rsa|id_ed25519|credentials\.json|service-account\.json|\.netrc)\b/,
  // Package lock files
  /\bpackage-lock\.json\b/,
  /\byarn\.lock\b/,
  /\bpnpm-lock\.yaml\b/,
]

// ---------------------------------------------------------------------------
// Allowed write roots (allowlist)
// ---------------------------------------------------------------------------

/**
 * Build the default set of allowed write roots.
 *
 * @param projectRoot - The repository root.
 * @param worktreePaths - Optional additional worktree paths.
 * @returns Array of absolute paths that are allowed for writes.
 */
export function buildAllowedRoots(
  projectRoot: string,
  worktreePaths?: string[],
): string[] {
  const roots = [projectRoot]

  if (worktreePaths) {
    roots.push(...worktreePaths)
  }

  // Deduplicate and resolve to real paths
  return [...new Set(roots.map((r) => realpathSafe(r, projectRoot) || path.resolve(r)))]
}

// ---------------------------------------------------------------------------
// Core guard functions
// ---------------------------------------------------------------------------

/**
 * Check whether a target path is allowed for mutation.
 *
 * This is the primary guard function. It enforces:
 * 1. Symlink/traversal safety via `realpathSafe`
 * 2. Blocked pattern check (git, node_modules, .env, etc.)
 * 3. Allowlist check (must be within project root or worktree paths)
 * 4. Planner artifact check (planner may only write to runtime-state-dir/plans)
 *
 * @param targetPath - The path being checked (relative or absolute).
 * @param options - Guard options including project root and intent.
 * @returns A `GuardResult` indicating whether the write is allowed.
 */
export function guardWrite(
  targetPath: string,
  options: GuardOptions & { intent?: GuardIntent },
): GuardResult {
  const intent = options.intent ?? "write"
  const projectRoot = options.projectRoot

  // Resolve to an absolute path
  const absolutePath = path.isAbsolute(targetPath)
    ? targetPath
    : path.resolve(projectRoot, targetPath)

  // Symlink/traversal safety: resolve real path
  const resolvedPath = realpathSafe(absolutePath, projectRoot) || absolutePath

  // Runtime state dir override: if the resolved path is under the known
  // runtime state directory (e.g. <git-dir>/pi-zflow/), allow it regardless
  // of blocked patterns.  This ensures runtime artifacts can always be written.
  const runtimeStateDir = options.runtimeStateDir ?? resolveRuntimeStateDir()
  if (resolvedPath.startsWith(runtimeStateDir)) {
    return {
      allowed: true,
      message: `Write allowed to runtime state directory "${resolvedPath}".`,
      resolvedPath,
    }
  }

  // 1. Check blocked patterns
  for (const pattern of BLOCKED_PATH_PATTERNS) {
    if (pattern.test(resolvedPath)) {
      return {
        allowed: false,
        message: `Blocked path pattern matched: ${pattern}. Writes to "${resolvedPath}" are denied by policy.`,
        resolvedPath,
      }
    }
  }

  // 2. Check allowlist: must be within project root or worktree paths
  const allowedRoots = buildAllowedRoots(projectRoot, options.worktreePaths)
  const withinAllowed = allowedRoots.some((root) => resolvedPath.startsWith(root))

  if (!withinAllowed) {
    return {
      allowed: false,
      message: `Path "${resolvedPath}" is outside allowed write roots. ` +
        `Allowed roots: ${allowedRoots.join(", ")}`,
      resolvedPath,
    }
  }

  // 3. Planner artifact policy: planner may only write to runtime-state-dir/plans
  if (intent === "planner-artifact") {
    const plansDir = path.join(runtimeStateDir, "plans")
    if (!resolvedPath.startsWith(plansDir)) {
      return {
        allowed: false,
        message: `Planner artifact write denied: path "${resolvedPath}" is outside the plans directory "${plansDir}". ` +
          `Use zflow_write_plan_artifact instead.`,
        resolvedPath,
      }
    }
    return {
      allowed: true,
      message: `Planner artifact write allowed to "${resolvedPath}".`,
      resolvedPath,
    }
  }

  // 4. Non-planner/report agents should not write arbitrary files
  if (intent === "implement" && options.plannerMode) {
    return {
      allowed: false,
      message: `Implementation write denied while in planner mode. ` +
        `Planner agents must use zflow_write_plan_artifact to write plan artifacts.`,
      resolvedPath,
    }
  }

  return {
    allowed: true,
    message: `Write allowed to "${resolvedPath}".`,
    resolvedPath,
  }
}

/**
 * Check whether a bash command includes destructive operations that
 * should be blocked by the path guard.
 *
 * This is a best-effort heuristic check that catches common destructive
 * patterns. It is intended to supplement, not replace, the path-based
 * `guardWrite` checks.
 *
 * @param command - The full bash command string.
 * @param options - Guard options.
 * @returns A `GuardResult` indicating whether the command is allowed.
 */
export function guardBashCommand(
  command: string,
  options: GuardOptions & { intent?: GuardIntent },
): GuardResult {
  const intent = options.intent ?? "bash-mutation"
  const projectRoot = options.projectRoot

  // Extract file write targets from redirections
  const redirMatches = command.matchAll(/[>]{1,2}\s*(\S+)/g)
  for (const match of redirMatches) {
    const fileTarget = match[1]
    if (fileTarget) {
      const resolvedTarget = path.isAbsolute(fileTarget)
        ? fileTarget
        : path.resolve(projectRoot, fileTarget)
      const result = guardWrite(resolvedTarget, { ...options, intent })
      if (!result.allowed) return result
    }
  }

  // Check for tee writes
  const teeMatch = command.match(/\btee\s+(-[aA]?\s+)?(\S+)/)
  if (teeMatch) {
    const fileTarget = teeMatch[2]
    if (fileTarget) {
      const resolvedTarget = path.isAbsolute(fileTarget)
        ? fileTarget
        : path.resolve(projectRoot, fileTarget)
      const result = guardWrite(resolvedTarget, { ...options, intent })
      if (!result.allowed) return result
    }
  }

  // Check for mv/cp to protected locations
  const mvCpMatch = command.match(/\b(mv|cp)\s+(\S+)\s+(\S+)/)
  if (mvCpMatch) {
    const destTarget = mvCpMatch[3]
    if (destTarget && !destTarget.startsWith("-")) {
      const resolvedTarget = path.isAbsolute(destTarget)
        ? destTarget
        : path.resolve(projectRoot, destTarget)
      const result = guardWrite(resolvedTarget, { ...options, intent })
      if (!result.allowed) return result
    }
  }

  return {
    allowed: true,
    message: "Bash command passed path guard checks.",
    resolvedPath: projectRoot,
  }
}

/**
 * Check whether a git write command (commit, add, checkout, push, etc.)
 * is allowed.
 *
 * Git write commands are generally blocked during planning mode.
 *
 * @param command - The full bash command string.
 * @returns Whether the command appears to be a git write command.
 */
export function isGitWriteCommand(command: string): boolean {
  const gitWritePatterns = [
    /\bgit\s+commit\b/,
    /\bgit\s+add\b/,
    /\bgit\s+checkout\s+-[fb]/,
    /\bgit\s+push\b/,
    /\bgit\s+merge\b/,
    /\bgit\s+rebase\b/,
    /\bgit\s+reset\s+(--hard|--soft)/,
    /\bgit\s+rm\b/,
    /\bgit\s+mv\b/,
    /\bgit\s+tag\b/,
    /\bgit\s+branch\s+-[dDmM]/,
    /\bgit\s+cherry-pick\b/,
    /\bgit\s+revert\s+--no-edit/,
  ]

  return gitWritePatterns.some((pattern) => pattern.test(command))
}

/**
 * Get a consolidated tool-denied reminder message from a guard result.
 *
 * This can be used to inject the `tool-denied` runtime reminder when a
 * tool call is blocked by the path guard.
 *
 * @param result - The guard result from `guardWrite` or `guardBashCommand`.
 * @returns A concise markdown reminder string.
 */
export function buildToolDeniedReminder(result: GuardResult): string {
  return [
    "⚠️ **Tool call blocked by path guard**",
    "",
    `**Reason:** ${result.message}`,
    "",
    "**Required action:** Adjust your approach. Do not retry the same write without approval.",
    "  - If you are a planner, use `zflow_write_plan_artifact` instead.",
    "  - If you are an implementer, check that the path is within the project root.",
    "",
  ].join("\n")
}
