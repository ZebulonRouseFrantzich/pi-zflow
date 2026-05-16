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
import * as fs from "node:fs"
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
  /(?:^|[/\\])\.git[\\/](?!pi-zflow[\\/])/,
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

/**
 * Return true when `candidatePath` is exactly `rootPath` or contained under it.
 *
 * This avoids unsafe string-prefix checks where `/repo-evil` would otherwise
 * be treated as contained in `/repo`.
 */
function isPathWithinOrEqual(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/**
 * Resolve `targetPath` to a real path, handling files that do not yet exist.
 *
 * - If the target exists, resolves it through symlinks via `realpathSafe`.
 * - If the target does not exist, walks up the directory tree until it finds
 *   an existing ancestor, resolves that ancestor through symlinks, then
 *   re-appends the non-existing suffix.
 *
 * This prevents symlink-escape for writes to new files under a symlinked
 * parent directory: the symlinked parent is resolved to its real location,
 * exposing any escape.
 *
 * Returns `null` if the nearest existing ancestor cannot be safely resolved.
 */
function resolveAncestorSafe(targetPath: string, projectRoot: string): string | null {
  const resolved = path.resolve(targetPath)

  let checkPath = resolved
  while (true) {
    try {
      // lstatSync succeeds for existing files, directories, and symlinks.
      fs.lstatSync(checkPath)
      const realPrefix = realpathSafe(checkPath, projectRoot)
      if (realPrefix === null) {
        return null
      }
      const suffix = path.relative(checkPath, resolved)
      return suffix ? path.join(realPrefix, suffix) : realPrefix
    } catch {
      // Path does not exist — continue walking up.
    }

    const parent = path.dirname(checkPath)
    if (parent === checkPath) {
      return null
    }
    checkPath = parent
  }
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

  // Symlink/traversal safety: resolve real path via ancestor-safe resolution.
  // This handles both existing files (direct realpath) and new files under
  // symlinked directories (walks up to find a resolvable ancestor).
  const resolvedPath = resolveAncestorSafe(absolutePath, projectRoot)
  if (resolvedPath === null) {
    return {
      allowed: false,
      message: `Path "${absolutePath}" could not be safely resolved. Writes are denied by policy.`,
      resolvedPath: absolutePath,
    }
  }

  // Runtime state dir override: if the resolved path is under the known
  // runtime state directory (e.g. <git-dir>/pi-zflow/), allow it regardless
  // of blocked patterns.  This ensures runtime artifacts can always be written.
  const runtimeStateDir = options.runtimeStateDir ?? resolveRuntimeStateDir(options.projectRoot)

  // Planner artifact writes are intentionally narrower than general runtime
  // state writes: planners may write only plan artifacts under plans/.
  if (intent === "planner-artifact") {
    const plansDir = path.join(runtimeStateDir, "plans")
    if (!isPathWithinOrEqual(plansDir, resolvedPath)) {
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

  if (isPathWithinOrEqual(runtimeStateDir, resolvedPath)) {
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
  const withinAllowed = allowedRoots.some((root) => isPathWithinOrEqual(root, resolvedPath))

  if (!withinAllowed) {
    return {
      allowed: false,
      message: `Path "${resolvedPath}" is outside allowed write roots. ` +
        `Allowed roots: ${allowedRoots.join(", ")}`,
      resolvedPath,
    }
  }

  // 3. Non-planner/report agents should not write arbitrary files
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
 * Uses a deny-by-default blocklist for obvious destructive/mutating
 * commands (rm, git rm, sed -i, etc.) and chained/subshell shell syntax
 * that could hide destructive operations.
 *
 * All multi-command shell syntax is blocked: `;`, `|`, `&&`, `||`,
 * backticks, `$()`, and process substitution.  Simple redirection (`>`)
 * is allowed but checked against the path guard.
 *
 * Known read-only commands (ls, git status/diff/log, cat, grep,
 * head, tail, wc, etc.) pass through to the existing path-based checks.
 *
 * All other commands that are not read-only and have no path-checked write
 * operation are blocked by default ("deny-by-default").
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
  const trimmed = command.trim()

  // Normalise: collapse repeated spaces and strip leading "sudo " for pattern matching
  const normalised = trimmed.replace(/\s+/g, " ").replace(/^sudo\s+/i, "")

  // ── 1. Detect shell chaining / subshell syntax ────────────────
  // Block all top-level multi-command syntax: `;`, `|`, `&&`, `||`,
  // backticks, `$(...)` command substitution, and `<(...)`/`>(...)`
  // process substitution.  This is deny-by-default: no form of chaining
  // or piping is allowed inside a single guardBashCommand call, even if
  // every individual command looks read-only, because later segments
  // could contain destructive operations.
  //
  // The only exception is redirection (`>` / `>>`) which is allowed but
  // separately checked against path guard.
  const hasTopLevelChaining = ((): boolean => {
    let inSingle = false
    let inDouble = false
    for (let i = 0; i < trimmed.length; i++) {
      const c = trimmed[i]
      if (c === "'" && !inDouble) inSingle = !inSingle
      else if (c === '"' && !inSingle) inDouble = !inDouble
      else if (!inSingle && !inDouble) {
        // Semicolon chaining
        if (c === ";") return true
        // Pipe chaining
        if (c === "|") return true
        // Backtick command substitution
        if (c === "`") return true
        // $(...) command substitution
        if (c === "$" && trimmed[i + 1] === "(") return true
        // Process substitution <(...) or >(...)
        if ((c === "<" || c === ">") && trimmed[i + 1] === "(") return true
      }
    }
    // Check for && and || outside quotes (character-pair scan above
    // can't easily express two-char operators, so use a simple
    // regex on the unquoted portions).
    const stripped = trimmed.replace(/['"][^'"]*['"]/g, "")
    if (/&&|\|\|/.test(stripped)) return true
    return false
  })()

  if (hasTopLevelChaining) {
    return {
      allowed: false,
      message:
        "Bash command blocked: shell chaining or piping detected (`;`, `|`, `&&`, `||`, " +
        "backticks, `$()`, or process substitution). " +
        "This guard does not allow chained or multi-command shell forms. " +
        "Run each command separately or use the edit/write tools for file changes.",
      resolvedPath: projectRoot,
    }
  }

  // ── 2. Block obvious destructive/mutating commands ────────────
  const destructivePatterns: RegExp[] = [
    // File removal
    /\brm\s+(?:-[rfv]*\s+)?/,
    /\brmdir\b/,
    /\bunlink\b/,
    // Git destructive commands
    /\bgit\s+clean\b/,
    /\bgit\s+rm\b/,
    /\bgit\s+checkout\s+--\s+/,
    /\bgit\s+reset\s+--hard\b/,
    // In-place editors
    /\bsed\s+(?:-[^\s]*i|--in-place)\b/,
    /\bperl\s+-i\b/,
    /\bruby\s+-i\b/,
    /\bpython\s+-i\b/,
    // Raw device / truncation
    /\bdd\s+if=/,
    /\btruncate\b/,
    /\bmkfs\.\w+/,
    /\bfdisk\b/,
    // Permission / ownership mutation
    /\bchmod\b/,
    /\bchown\b/,
    /\bchgrp\b/,
    // Package manager updates (destructive at filesystem level)
    /\bnpm\s+(?:install|update|uninstall|publish|add)\b/,
    /\bpip\s+(?:install|uninstall)\b/,
    // File / directory creation that modifies the filesystem
    /\bmkdir\b/,
    /\btouch\b/,
    /^install\b/,
  ]

  // Check if the command STARTS WITH a known read-only command.
  // If it does, skip destructive-pattern matching for the whole command
  // (the read-only prefix check below is tighter and already safe).
  // For commands that are NOT read-only, check destructive patterns.
  const isReadOnly = READ_ONLY_PREFIXES.some((re) => re.test(normalised))
  if (!isReadOnly) {
    for (const pattern of destructivePatterns) {
      if (pattern.test(normalised)) {
        return {
          allowed: false,
          message:
            `Bash command blocked by path guard: pattern \`${pattern.source}\` ` +
            "matches a destructive/mutating command. " +
            "Use the edit/write tools for file changes, or use a known read-only command " +
            "(git status/diff/log, cat, ls, grep, find, head, tail, etc.).",
          resolvedPath: projectRoot,
        }
      }
    }
  }

  // ── 3. Track whether a write form was checked and passed ────
  // We store this alongside redirection/tee/mv-cp checks below.
  let hasVerifiedWriteForm = false

  // ── 4. Extract file write targets from redirections ──────────
  const redirMatches = command.matchAll(/[>]{1,2}\s*(\S+)/g)
  for (const match of redirMatches) {
    const fileTarget = match[1]
    if (fileTarget) {
      hasVerifiedWriteForm = true
      const resolvedTarget = path.isAbsolute(fileTarget)
        ? fileTarget
        : path.resolve(projectRoot, fileTarget)
      const result = guardWrite(resolvedTarget, { ...options, intent })
      if (!result.allowed) return result
    }
  }

  // ── 5. Check for tee writes ──────────────────────────────────
  const teeMatch = command.match(/\btee\s+(-[aA]?\s+)?(\S+)/)
  if (teeMatch) {
    const fileTarget = teeMatch[2]
    if (fileTarget) {
      hasVerifiedWriteForm = true
      const resolvedTarget = path.isAbsolute(fileTarget)
        ? fileTarget
        : path.resolve(projectRoot, fileTarget)
      const result = guardWrite(resolvedTarget, { ...options, intent })
      if (!result.allowed) return result
    }
  }

  // ── 6. Check for mv/cp to protected locations ────────────────
  const mvCpMatch = command.match(/\b(mv|cp)\s+(\S+)\s+(\S+)/)
  if (mvCpMatch) {
    const destTarget = mvCpMatch[3]
    if (destTarget && !destTarget.startsWith("-")) {
      hasVerifiedWriteForm = true
      const resolvedTarget = path.isAbsolute(destTarget)
        ? destTarget
        : path.resolve(projectRoot, destTarget)
      const result = guardWrite(resolvedTarget, { ...options, intent })
      if (!result.allowed) return result
    }
  }

  // ── 7. Deny-by-default for unknown commands ──────────────────
  // If the command did not start with a known read-only prefix and also
  // did not contain any path-checked write operation (redirection, tee,
  // mv/cp), block it as unknown/untrusted.
  if (!isReadOnly && !hasVerifiedWriteForm) {
    return {
      allowed: false,
      message:
        "Bash command blocked: not a known read-only command and no " +
        "path-checked write operation detected. " +
        "Use a known read-only command (git status/diff/log, cat, ls, grep, " +
        "head, tail, etc.) or the edit/write tools for file changes.",
      resolvedPath: projectRoot,
    }
  }

  return {
    allowed: true,
    message: "Bash command passed path guard checks.",
    resolvedPath: projectRoot,
  }
}

// ── Known read-only command prefixes ─────────────────────────────

/**
 * Commands that are known safe / read-only.  A command matching one of
 * these prefixes skips the destructive-pattern blocklist and proceeds
 * to normal path-based checks.
 *
 * This list is intentionally conservative: it covers only well-known
 * inspection commands and clearly read-only git subcommands.  Any
 * command not in this list and not containing a path-checked write form
 * is blocked by default.
 */
const READ_ONLY_PREFIXES: RegExp[] = [
  // Generic read-only commands
  /^ls\b/,
  /^pwd\b/,
  /^cat\b/,
  /^grep\b/,
  /^rg\b/,
  /^find\b/,
  /^head\b/,
  /^tail\b/,
  /^wc\b/,
  /^sort\b/,
  /^uniq\b/,
  /^cut\b/,
  /^tr\b/,
  /^od\b/,
  /^xxd\b/,
  /^diff\b/,
  /^cmp\b/,
  /^comm\b/,
  /^tree\b/,
  /^du\b/,
  /^df\b/,
  /^stat\b/,
  /^file\b/,
  /^which\b/,
  /^type\b/,
  /^env\b/,
  /^printenv\b/,
  /^dirname\b/,
  /^basename\b/,
  /^readlink\b/,
  /^realpath\b/,
  /^date\b/,
  /^cal\b/,
  /^nproc\b/,
  /^uname\b/,
  /^hostname\b/,
  /^whoami\b/,
  /^id\b/,
  /^logname\b/,
  /^echo\b/,
  /^printf\b/,
  /^true\b/,
  /^false\b/,
  /^test\b/,
  /^\[\[?\s/,
  /^exit\b/,
  /^time\b/,

  // Git read-only subcommands — only truly read-only inspection commands
  /^git\s+(?:status|diff|log|show|grep|rev-parse|rev-list|ls-files|ls-tree|ls-remote|for-each-ref|shortlog|name-rev|check-ignore|check-attr|check-mailmap|count-objects|describe|help|merge-base|whatchanged|show-ref|show-branch|verify-commit|verify-pack|verify-tag|diff-files|diff-index|diff-tree|archive|worktree\s+list|stash\s+(?:list|show)|tag\s+(?:\-l|\-\-list)|config\s+(?:\-\-get\b|\-\-list\b|\-\-get-all\b)|branch\s+(?:\-l|\-\-list))\b/,

  // Web / network — read-only
  /^curl\s/,
  /^wget\s/,
  /^ping\s/,
  /^nslookup\s/,
  /^dig\s/,
  /^host\s/,
  /^nc\s+-[z]/,

  // Data format tools — read-only
  /^jq\b/,
  /^yq\b/,
]

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
