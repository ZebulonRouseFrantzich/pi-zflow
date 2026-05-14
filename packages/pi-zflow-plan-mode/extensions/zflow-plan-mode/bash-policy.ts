/**
 * bash-policy.ts — Plan-mode restricted bash policy enforcement.
 *
 * Intercepts bash tool calls during planning mode and rejects commands
 * that would mutate source code or the working tree. Read-only commands
 * (cat, ls, grep, find, git log, git diff, etc.) are allowed without
 * restriction.
 *
 * ## Consumption contract
 *
 * ```ts
 * import { validatePlanModeBash } from "./bash-policy.js"
 *
 * const result = validatePlanModeBash(command)
 * if (!result.allowed) {
 *   // Block with result.reason
 * }
 * ```
 *
 * @module pi-zflow-plan-mode/bash-policy
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of a plan-mode bash validation check.
 */
export interface BashPolicyResult {
  /** Whether the command is allowed in plan mode. */
  allowed: boolean
  /** Human-readable reason if blocked. */
  reason?: string
}

// ---------------------------------------------------------------------------
// Blocked patterns
// ---------------------------------------------------------------------------

/**
 * Patterns that are always blocked in plan mode.
 * Each entry has a regex pattern and a descriptive reason.
 */
const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Shell redirection operators (write to files)
  // Only output redirection (`>`, `>>`) is blocked.
  // Input redirection (`<`, `<<`) is allowed (read-only commands like `grep pattern < file` are fine).
  { pattern: /[>]{1,2}/, reason: "File output redirection blocked in plan mode" },

  // tee command (writes to files)
  { pattern: /\btee\b/, reason: "tee command blocked in plan mode" },

  // Git write commands
  { pattern: /\bgit\s+(commit|add|checkout|reset|merge|rebase|push|fetch|pull|branch\s+-[dD]|tag\s+-[dD])\b/, reason: "Git write commands blocked in plan mode" },

  // Destructive file operations
  // rm: single file (rm file.ts) or with flags (rm -rf node_modules/)
  { pattern: /\brm\s+(?:-[a-zA-Z]+\s+)?/, reason: "File deletion blocked in plan mode" },
  { pattern: /\bmv\s+/, reason: "File move/rename blocked in plan mode" },
  { pattern: /\bcp\s+/, reason: "File copy blocked in plan mode" },
  { pattern: /\bmkdir\s+/, reason: "Directory creation blocked in plan mode" },
  { pattern: /\brmdir\s+/, reason: "Directory removal blocked in plan mode" },
  { pattern: /\bchmod\s+/, reason: "File permission changes blocked in plan mode" },
  { pattern: /\bchown\s+/, reason: "File ownership changes blocked in plan mode" },

  // Package installs
  { pattern: /\b(npm install|npm ci|npm update|pnpm add|pnpm install|pnpm update|yarn add|yarn install|yarn upgrade)\b/, reason: "Package install/update commands blocked in plan mode" },

  // Editors
  { pattern: /\b(vi[m]?|nano|emacs|code|subl|atom)\b/, reason: "Editor commands blocked in plan mode" },

  // Direct write utilities
  { pattern: /\b(dd|install|mkfifo|mknod|ln)\s+/, reason: "Filesystem mutation blocked in plan mode" },
]

// ---------------------------------------------------------------------------
// Allowlist for commands that contain blocked patterns but are read-only
// ---------------------------------------------------------------------------

/**
 * Full command overrides — whole commands that are allowed despite
 * containing blocked patterns.
 *
 * Most read-only commands (cat, ls, grep, etc.) do NOT match any
 * blocked patterns and pass through without needing an allowlist entry.
 * Only commands that WOULD match a blocked pattern but are actually
 * read-only should be listed here.
 *
 * Currently no such commands are needed:
 * - `git status`, `git log`, etc. do not match `git (commit|add|...)`.
 * - `cat file.ts` does not match any blocked pattern.
 */
const ALLOWLIST_COMMANDS: Array<{ prefix: string; comment: string }> = []

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if a bash command is allowed during plan mode.
 *
 * Rejects write/editing operations (redirections, destructive commands,
 * package installs, editors) while allowing read-only exploration.
 *
 * The check order is:
 * 1. Blocked patterns are checked first.
 * 2. If a blocked pattern matches, the allowlist is consulted for
 *    explicit overrides (e.g., `git diff` contains no blocked patterns
 *    so it never reaches the allowlist; but a hypothetically blocked
 *    read-only command could be allowlisted).
 *
 * @param command - The bash command string to validate.
 * @returns A BashPolicyResult indicating whether the command is allowed.
 */
export function validatePlanModeBash(command: string): BashPolicyResult {
  const trimmed = command.trim()

  // Empty commands are allowed (no-op)
  if (!trimmed) {
    return { allowed: true }
  }

  // Check blocked patterns first
  let matchedReason: string | undefined
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      matchedReason = reason
      break
    }
  }

  // If blocked, check allowlist for explicit overrides
  if (matchedReason) {
    for (const entry of ALLOWLIST_COMMANDS) {
      if (trimmed.startsWith(entry.prefix)) {
        return { allowed: true }
      }
    }
    return { allowed: false, reason: matchedReason }
  }

  // All other commands are allowed (read-only by default)
  return { allowed: true }
}
