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
import type { RepoBashGuardConfig } from "./repo-config.js"

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
  | "fix-worker"      // Fix worker (may only write to scratch/ or approved plan files)
  | "fix-orchestrator" // Fix orchestrator (trusted — may restructure files/dirs per fix plan)
  | "apply-back-resolver" // Apply-back resolver (may only write to scratch/ or integration worktree)

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
  /** Optional repo-local bash guard overrides. */
  bashPolicy?: RepoBashGuardConfig
}

// ---------------------------------------------------------------------------
// Blocked path patterns (always denied)
// ---------------------------------------------------------------------------

/**
 * Patterns that are always blocked, regardless of intent or allowlist.
 * These protect critical infrastructure, secrets, and package manager state.
 */
const BLOCKED_PATH_PATTERNS: RegExp[] = [
  // Git internals — always blocked (runtime state now lives under .zflow/)
  /(?:^|[/\\])\.git[\\/]/,
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
  // runtime state directory (e.g. <repo-root>/.zflow/), allow it regardless
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

  const relativeToProject = path.relative(projectRoot, resolvedPath)
  const firstSegment = relativeToProject.split(path.sep)[0]
  if (firstSegment && firstSegment !== ".zflow" && firstSegment.startsWith(".zflow")) {
    return {
      allowed: false,
      message: `Blocked runtime state prefix trick: writes to "${resolvedPath}" are denied by policy.`,
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

  // 4. Fix-worker intent: restrict to scratch scripts dir only (or approved plan files)
  if (intent === "fix-worker") {
    // Allow runtime state dir (includes .zflow/runs/*/scratch/)
    if (isPathWithinOrEqual(runtimeStateDir, resolvedPath)) {
      return {
        allowed: true,
        message: `Fix-worker write allowed to runtime state directory "${resolvedPath}".`,
        resolvedPath,
      }
    }

    // Compute relative path from project root to check against restricted locations
    const relativePath = path.relative(projectRoot, resolvedPath)
    const relativePathSlash = `/${relativePath.replace(/\\/g, "/")}`

    // Block writes to repo root, scripts/, test/, tests/, src/, lib/, packages/*/src/
    // unless the target is in the runtime state directory (handled above).
    const blockedRootDirs = [
      /^\/scripts\//i,
      /^\/test\//i,
      /^\/tests\//i,
      /^\/src\//i,
      /^\/lib\//i,
      /^\/packages\/[^/]+\/src\//i,
      /^\/[^/]+\.(sh|bash|py|js|ts)$/i,
    ]

    // Also block bare repo root files that look like scripts
    for (const pattern of blockedRootDirs) {
      if (pattern.test(relativePathSlash)) {
        return {
          allowed: false,
          message: `Fix-worker write denied: path "${resolvedPath}" is in a restricted location. ` +
            `Fix workers may only write to the runtime state directory (`.zflow/`) ` +
            `or files explicitly listed in the approved plan.`,
          resolvedPath,
        }
      }
    }
  }

  // 5. Apply-back-resolver intent: restrict to scratch scripts dir or integration worktree path
  if (intent === "apply-back-resolver") {
    // Allow runtime state dir (includes .zflow/runs/*/scratch/)
    if (isPathWithinOrEqual(runtimeStateDir, resolvedPath)) {
      return {
        allowed: true,
        message: `Apply-back-resolver write allowed to runtime state directory "${resolvedPath}".`,
        resolvedPath,
      }
    }

    // Allow writes within the integration worktree (under run dir)
    // Integration worktrees are under <runtime-state-dir>/runs/<runId>/integration-worktree/
    const runsDir = path.join(runtimeStateDir, "runs")
    if (isPathWithinOrEqual(runsDir, resolvedPath)) {
      return {
        allowed: true,
        message: `Apply-back-resolver write allowed to runs directory "${resolvedPath}".`,
        resolvedPath,
      }
    }

    // Block writes to repo root during apply-back resolution
    const relativeToProject = path.relative(projectRoot, resolvedPath)
    if (!relativeToProject.startsWith("..") && relativeToProject !== "" && !relativeToProject.startsWith(".zflow")) {
      return {
        allowed: false,
        message: `Apply-back-resolver write denied: path "${resolvedPath}" is outside the run directory. ` +
          `Apply-back resolvers may only write to the integration worktree or scratch directory.`,
        resolvedPath,
      }
    }
  }

  return {
    allowed: true,
    message: `Write allowed to "${resolvedPath}".`,
    resolvedPath,
  }
}

/**
 * Fully-normalized bash guard policy used while evaluating commands.
 */
interface NormalizedBashPolicy {
  allowCommandPrefixes: string[]
  denyCommandPrefixes: string[]
  allowExecutables: string[]
  denyExecutables: string[]
  allowReadOnlyChaining: boolean
}

interface SplitCommandResult {
  segments: string[]
  operators: string[]
}

interface SingleCommandGuardResult extends GuardResult {
  nextCwd?: string
  hasVerifiedWriteForm: boolean
  isReadOnly: boolean
}

const DEFAULT_BASH_POLICY: NormalizedBashPolicy = {
  allowCommandPrefixes: [],
  denyCommandPrefixes: [],
  allowExecutables: [],
  denyExecutables: [],
  allowReadOnlyChaining: true,
}

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+(?:-[rfv]*\s+)?/,
  /\brmdir\b/,
  /\bunlink\b/,
  /\bgit\s+clean\b/,
  /\bgit\s+rm\b/,
  /\bgit\s+checkout\s+--\s+/,
  /\bgit\s+reset\s+--hard\b/,
  /\bsed\s+(?:-[^\s]*i|--in-place)\b/,
  /\bperl\s+-i\b/,
  /\bruby\s+-i\b/,
  /\bpython\s+-i\b/,
  /\bdd\s+if=/,
  /\btruncate\b/,
  /\bmkfs\.\w+/,
  /\bfdisk\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bchgrp\b/,
  /\bnpm\s+(?:install|update|uninstall|publish|add)\b/,
  /\bpip\s+(?:install|uninstall)\b/,
  /\bmkdir\b/,
  /\btouch\b/,
  /^install\b/,
]

/**
 * Commands that are known safe / read-only.
 */
const DEFAULT_READ_ONLY_PREFIXES: RegExp[] = [
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
  /^cd\b/,
  /^git\s+(?:status|diff|log|show|grep|rev-parse|rev-list|ls-files|ls-tree|ls-remote|for-each-ref|shortlog|name-rev|check-ignore|check-attr|check-mailmap|count-objects|describe|help|merge-base|whatchanged|show-ref|show-branch|verify-commit|verify-pack|verify-tag|diff-files|diff-index|diff-tree|archive|worktree\s+list|stash\s+(?:list|show)|tag\s+(?:\-l|\-\-list)|config\s+(?:\-\-get\b|\-\-list\b|\-\-get-all\b)|branch\s+(?:\-l|\-\-list))\b/,
  /^git\s+-C\s+\S+\s+(?:status|diff|log|show|grep|rev-parse|rev-list|ls-files|ls-tree|ls-remote|for-each-ref|shortlog|name-rev|check-ignore|check-attr|check-mailmap|count-objects|describe|help|merge-base|whatchanged|show-ref|show-branch|verify-commit|verify-pack|verify-tag|diff-files|diff-index|diff-tree|archive|worktree\s+list|stash\s+(?:list|show)|tag\s+(?:\-l|\-\-list)|config\s+(?:\-\-get\b|\-\-list\b|\-\-get-all\b)|branch\s+(?:\-l|\-\-list))\b/,
  /^ping\s/,
  /^nslookup\s/,
  /^dig\s/,
  /^host\s/,
  /^nc\s+-[z]/,
  /^jq\b/,
  /^yq\b/,
  /^npm\s+(?:--prefix\s+\S+\s+)?(?:test|run\s+test|run\s+test:core|run\s+test:all)\b/,
  /^npx\s+tsx\s+(?:--test|--eval)/,
  /^tsx\s+(?:--test|--eval)/,
  /^pnpm\s+(?:(?:--dir\s+\S+|--[a-z-]+\s+\S+)\s+)*(?:typecheck|test|lint|run\s+(?:typecheck|test|lint|check|ci)(?:\s|$))/,
  /^make\s+(?:-C\s+\S+\s+)?(?:check|test|lint|ci|verify)(?:\s|$)/,
  /^just\s+(?:--list|--summary|codegen|smoke\b)/,
  /^tsc\s/,
  /^npx\s+tsc\s/,
  /^nix\s+(?:develop|shell|run)\b/,
]

function normalizeBashPolicy(policy?: RepoBashGuardConfig): NormalizedBashPolicy {
  return {
    allowCommandPrefixes: (policy?.allowCommandPrefixes ?? []).map((entry) => entry.trim().toLowerCase()).filter(Boolean),
    denyCommandPrefixes: (policy?.denyCommandPrefixes ?? []).map((entry) => entry.trim().toLowerCase()).filter(Boolean),
    allowExecutables: (policy?.allowExecutables ?? []).map((entry) => entry.trim().toLowerCase()).filter(Boolean),
    denyExecutables: (policy?.denyExecutables ?? []).map((entry) => entry.trim().toLowerCase()).filter(Boolean),
    allowReadOnlyChaining: policy?.allowReadOnlyChaining ?? DEFAULT_BASH_POLICY.allowReadOnlyChaining,
  }
}

function tokenizeShellWords(command: string): string[] {
  const tokens: string[] = []
  let current = ""
  let inSingle = false
  let inDouble = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]

    if (char === "\\" && !inSingle) {
      if (i + 1 < command.length) {
        current += command[i + 1]
        i++
      }
      continue
    }

    if (char === "'" && !inDouble) {
      inSingle = !inSingle
      continue
    }

    if (char === '"' && !inSingle) {
      inDouble = !inDouble
      continue
    }

    if (!inSingle && !inDouble && /\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ""
      }
      continue
    }

    current += char
  }

  if (current) tokens.push(current)
  return tokens
}

function splitTopLevelCommandSegments(command: string): SplitCommandResult | null {
  const segments: string[] = []
  const operators: string[] = []
  let current = ""
  let inSingle = false
  let inDouble = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]

    if (char === "`" && !inSingle && !inDouble) return null
    if (char === "$" && command[i + 1] === "(" && !inSingle && !inDouble) return null
    if ((char === "<" || char === ">") && command[i + 1] === "(" && !inSingle && !inDouble) return null

    if (char === "\\" && !inSingle) {
      current += char
      if (i + 1 < command.length) {
        current += command[i + 1]
        i++
      }
      continue
    }

    if (char === "'" && !inDouble) {
      inSingle = !inSingle
      current += char
      continue
    }

    if (char === '"' && !inSingle) {
      inDouble = !inDouble
      current += char
      continue
    }

    if (!inSingle && !inDouble) {
      if (char === ";") {
        if (current.trim()) segments.push(current.trim())
        operators.push(";")
        current = ""
        continue
      }
      if (char === "&" && command[i + 1] === "&") {
        if (current.trim()) segments.push(current.trim())
        operators.push("&&")
        current = ""
        i++
        continue
      }
      if (char === "|" && command[i + 1] === "|") {
        if (current.trim()) segments.push(current.trim())
        operators.push("||")
        current = ""
        i++
        continue
      }
      if (char === "|") {
        if (current.trim()) segments.push(current.trim())
        operators.push("|")
        current = ""
        continue
      }
    }

    current += char
  }

  if (current.trim()) segments.push(current.trim())
  return { segments, operators }
}

function looksLikePathToken(token: string): boolean {
  return token === "." || token === ".." || token.startsWith("/") || token.startsWith("./") || token.startsWith("../") || token.startsWith("~/") || token.includes("/")
}

function guardRepoPathAccess(
  targetPath: string,
  options: GuardOptions,
  baseDir: string,
): GuardResult | null {
  const projectRoot = options.projectRoot
  const runtimeStateDir = options.runtimeStateDir ?? resolveRuntimeStateDir(projectRoot)
  const expanded = targetPath.startsWith("~/")
    ? path.join(process.env.HOME ?? "~", targetPath.slice(2))
    : targetPath
  const absolutePath = path.isAbsolute(expanded)
    ? expanded
    : path.resolve(baseDir, expanded)
  const resolvedPath = resolveAncestorSafe(absolutePath, projectRoot)

  if (resolvedPath === null) {
    return {
      allowed: false,
      message: `Bash command blocked: path "${absolutePath}" could not be safely resolved within the repo/worktree roots.`,
      resolvedPath: absolutePath,
    }
  }

  for (const pattern of BLOCKED_PATH_PATTERNS) {
    if (pattern.test(resolvedPath)) {
      return {
        allowed: false,
        message: `Bash command blocked: path "${resolvedPath}" matches blocked pattern ${pattern}.`,
        resolvedPath,
      }
    }
  }

  const allowedRoots = [
    ...buildAllowedRoots(projectRoot, options.worktreePaths),
    runtimeStateDir,
  ]
  const withinAllowed = allowedRoots.some((root) => isPathWithinOrEqual(root, resolvedPath))
  if (!withinAllowed) {
    return {
      allowed: false,
      message: `Bash command blocked: path "${resolvedPath}" is outside allowed roots (${allowedRoots.join(", ")}).`,
      resolvedPath,
    }
  }

  return null
}

function matchesConfiguredPrefix(command: string, prefixes: string[]): boolean {
  const lower = command.trim().toLowerCase()
  return prefixes.some((prefix) => lower.startsWith(prefix))
}

function extractExecutable(tokens: string[]): string | null {
  if (tokens.length === 0) return null
  return tokens[0]!.toLowerCase()
}

function isConfiguredReadOnly(
  normalizedCommand: string,
  executable: string | null,
  policy: NormalizedBashPolicy,
): boolean {
  if (matchesConfiguredPrefix(normalizedCommand, policy.denyCommandPrefixes)) return false
  if (executable && policy.denyExecutables.includes(executable)) return false
  if (matchesConfiguredPrefix(normalizedCommand, policy.allowCommandPrefixes)) return true
  if (executable && policy.allowExecutables.includes(executable)) return true
  return false
}

function extractDirectoryTargets(tokens: string[]): string[] {
  const executable = extractExecutable(tokens)
  if (!executable) return []

  const results: string[] = []
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!
    const next = tokens[i + 1]
    if (executable === "git" && token === "-C" && next) results.push(next)
    if (executable === "pnpm" && token === "--dir" && next) results.push(next)
    if (executable === "npm" && token === "--prefix" && next) results.push(next)
    if (executable === "make" && token === "-C" && next) results.push(next)
    if (token.startsWith("--dir=")) results.push(token.slice("--dir=".length))
    if (token.startsWith("--prefix=")) results.push(token.slice("--prefix=".length))
  }
  return results
}

function extractReadOnlyPathTokens(tokens: string[]): string[] {
  const executable = extractExecutable(tokens)
  if (!executable) return []

  const nonOptionArgs = tokens.slice(1).filter((token) => !token.startsWith("-"))
  switch (executable) {
    case "ls":
    case "cat":
    case "head":
    case "tail":
    case "wc":
    case "stat":
    case "file":
    case "readlink":
    case "realpath":
    case "tree":
    case "du":
    case "diff":
    case "cmp":
    case "comm":
      return nonOptionArgs.filter(looksLikePathToken)
    case "grep":
    case "rg":
      return nonOptionArgs.slice(1).filter(looksLikePathToken)
    case "find":
      return (nonOptionArgs.length > 0 ? [nonOptionArgs[0]!] : []).filter(looksLikePathToken)
    default:
      return []
  }
}

function validateReadOnlyCommandPaths(
  tokens: string[],
  currentDir: string,
  options: GuardOptions,
): GuardResult | null {
  for (const dirTarget of extractDirectoryTargets(tokens)) {
    const dirCheck = guardRepoPathAccess(dirTarget, options, currentDir)
    if (dirCheck) return dirCheck
  }

  for (const pathToken of extractReadOnlyPathTokens(tokens)) {
    const pathCheck = guardRepoPathAccess(pathToken, options, currentDir)
    if (pathCheck) return pathCheck
  }

  return null
}

function guardSingleBashCommand(
  command: string,
  options: GuardOptions & { intent?: GuardIntent },
  currentDir: string,
  allowWriteForms: boolean,
): SingleCommandGuardResult {
  const intent = options.intent ?? "bash-mutation"
  const projectRoot = options.projectRoot
  const trimmed = command.trim()
  const normalised = trimmed.replace(/\s+/g, " ").replace(/^sudo\s+/i, "")
  const policy = normalizeBashPolicy(options.bashPolicy)
  const tokens = tokenizeShellWords(normalised)
  const executable = extractExecutable(tokens)

  if (!trimmed) {
    return {
      allowed: true,
      message: "Empty bash segment ignored.",
      resolvedPath: currentDir,
      hasVerifiedWriteForm: false,
      isReadOnly: true,
      nextCwd: currentDir,
    }
  }

  if (trimmed.includes("`") || /\$\(/.test(trimmed) || /[<>]\(/.test(trimmed)) {
    return {
      allowed: false,
      message:
        "Bash command blocked: command substitution or process substitution detected. " +
        "Use plain commands or the dedicated tools instead.",
      resolvedPath: projectRoot,
      hasVerifiedWriteForm: false,
      isReadOnly: false,
    }
  }

  if (matchesConfiguredPrefix(normalised, policy.denyCommandPrefixes) || (executable && policy.denyExecutables.includes(executable))) {
    return {
      allowed: false,
      message: `Bash command blocked by repo bashGuard deny rule: ${normalised}`,
      resolvedPath: projectRoot,
      hasVerifiedWriteForm: false,
      isReadOnly: false,
    }
  }

  const isOrchFileRestructure = intent === "fix-orchestrator" && (
    /\brm\s+(?:-[rfv]*\s+)?/.test(normalised) ||
    /\brmdir\b/.test(normalised) ||
    /\bmkdir\b/.test(normalised) ||
    /\btouch\b/.test(normalised) ||
    /^mv\b/.test(normalised)
  )

  const configuredReadOnly = isConfiguredReadOnly(normalised, executable, policy)
  const builtinReadOnly = DEFAULT_READ_ONLY_PREFIXES.some((re) => re.test(normalised))
  const isReadOnly = configuredReadOnly || builtinReadOnly

  if (!isReadOnly && !isOrchFileRestructure) {
    for (const pattern of DESTRUCTIVE_PATTERNS) {
      if (pattern.test(normalised)) {
        return {
          allowed: false,
          message:
            `Bash command blocked by path guard: pattern \`${pattern.source}\` matches a destructive/mutating command. ` +
            "Use the edit/write tools for file changes, or use a known read-only command.",
          resolvedPath: projectRoot,
          hasVerifiedWriteForm: false,
          isReadOnly: false,
        }
      }
    }
  }

  if (executable === "cd") {
    const target = tokens[1]
    if (!target) {
      return {
        allowed: false,
        message: "Bash command blocked: `cd` without a target is not permitted.",
        resolvedPath: projectRoot,
        hasVerifiedWriteForm: false,
        isReadOnly: true,
      }
    }
    const dirCheck = guardRepoPathAccess(target, options, currentDir)
    if (dirCheck) {
      return { ...dirCheck, hasVerifiedWriteForm: false, isReadOnly: true }
    }
    return {
      allowed: true,
      message: `Bash command passed path guard checks for directory change to ${target}.`,
      resolvedPath: path.resolve(currentDir, target),
      hasVerifiedWriteForm: false,
      isReadOnly: true,
      nextCwd: path.resolve(currentDir, target),
    }
  }

  const containsWriteForm = allowWriteForms && (
    /[>]{1,2}\s*\S/.test(trimmed) ||
    /\btee\b/.test(trimmed) ||
    /\b(?:mv|cp)\s+\S+\s+\S+/.test(trimmed) ||
    /\bcurl\b[^\n]*\s-o\s+\S+/.test(trimmed) ||
    /\bwget\b[^\n]*\s-O\s+\S+/.test(trimmed)
  )

  if (isReadOnly && !containsWriteForm) {
    const pathCheck = validateReadOnlyCommandPaths(tokens, currentDir, options)
    if (pathCheck) {
      return { ...pathCheck, hasVerifiedWriteForm: false, isReadOnly: true }
    }
    return {
      allowed: true,
      message: "Bash command passed path guard checks.",
      resolvedPath: currentDir,
      hasVerifiedWriteForm: false,
      isReadOnly: true,
      nextCwd: currentDir,
    }
  }

  let hasVerifiedWriteForm = false

  if (allowWriteForms) {
    const redirMatches = trimmed.matchAll(/[>]{1,2}\s*(\S+)/g)
    for (const match of redirMatches) {
      const fileTarget = match[1]
      if (!fileTarget) continue
      hasVerifiedWriteForm = true
      const resolvedTarget = path.isAbsolute(fileTarget)
        ? fileTarget
        : path.resolve(currentDir, fileTarget)
      const result = guardWrite(resolvedTarget, { ...options, intent })
      if (!result.allowed) {
        return { ...result, hasVerifiedWriteForm, isReadOnly: false }
      }
    }

    const teeMatch = trimmed.match(/\btee\s+(-[aA]?\s+)?(\S+)/)
    if (teeMatch?.[2]) {
      hasVerifiedWriteForm = true
      const resolvedTarget = path.isAbsolute(teeMatch[2])
        ? teeMatch[2]
        : path.resolve(currentDir, teeMatch[2])
      const result = guardWrite(resolvedTarget, { ...options, intent })
      if (!result.allowed) {
        return { ...result, hasVerifiedWriteForm, isReadOnly: false }
      }
    }

    const mvCpMatch = trimmed.match(/\b(mv|cp)\s+(\S+)\s+(\S+)/)
    if (mvCpMatch?.[3] && !mvCpMatch[3].startsWith("-")) {
      hasVerifiedWriteForm = true
      const resolvedTarget = path.isAbsolute(mvCpMatch[3])
        ? mvCpMatch[3]
        : path.resolve(currentDir, mvCpMatch[3])
      const result = guardWrite(resolvedTarget, { ...options, intent })
      if (!result.allowed) {
        return { ...result, hasVerifiedWriteForm, isReadOnly: false }
      }
    }

    const curlOutputMatch = trimmed.match(/\bcurl\b[^\n]*\s-o\s+(\S+)/)
    if (curlOutputMatch?.[1]) {
      hasVerifiedWriteForm = true
      const resolvedTarget = path.isAbsolute(curlOutputMatch[1])
        ? curlOutputMatch[1]
        : path.resolve(currentDir, curlOutputMatch[1])
      const result = guardWrite(resolvedTarget, { ...options, intent })
      if (!result.allowed) {
        return { ...result, hasVerifiedWriteForm, isReadOnly: false }
      }
    }

    const wgetOutputMatch = trimmed.match(/\bwget\b[^\n]*\s-O\s+(\S+)/)
    if (wgetOutputMatch?.[1]) {
      hasVerifiedWriteForm = true
      const resolvedTarget = path.isAbsolute(wgetOutputMatch[1])
        ? wgetOutputMatch[1]
        : path.resolve(currentDir, wgetOutputMatch[1])
      const result = guardWrite(resolvedTarget, { ...options, intent })
      if (!result.allowed) {
        return { ...result, hasVerifiedWriteForm, isReadOnly: false }
      }
    }
  }

  if (!hasVerifiedWriteForm) {
    return {
      allowed: false,
      message:
        "Bash command blocked: not a known read-only command and no path-checked write operation detected. " +
        "Use a known read-only command, add a repo bashGuard allowlist entry, or use the edit/write tools for file changes.",
      resolvedPath: projectRoot,
      hasVerifiedWriteForm: false,
      isReadOnly: false,
    }
  }

  return {
    allowed: true,
    message: "Bash command passed path guard checks.",
    resolvedPath: currentDir,
    hasVerifiedWriteForm,
    isReadOnly: false,
    nextCwd: currentDir,
  }
}

/**
 * Check whether a bash command includes destructive operations that
 * should be blocked by the path guard.
 */
export function guardBashCommand(
  command: string,
  options: GuardOptions & { intent?: GuardIntent },
): GuardResult {
  const policy = normalizeBashPolicy(options.bashPolicy)
  const split = splitTopLevelCommandSegments(command.trim())

  if (!split) {
    return {
      allowed: false,
      message:
        "Bash command blocked: shell substitution detected (backticks, `$()`, or process substitution). " +
        "Use plain commands or the dedicated tools instead.",
      resolvedPath: options.projectRoot,
    }
  }

  if (split.segments.length > 1) {
    if (!policy.allowReadOnlyChaining) {
      return {
        allowed: false,
        message:
          "Bash command blocked: top-level chaining/piping is disabled by repo bashGuard policy. " +
          "Run each command separately or enable allowReadOnlyChaining.",
        resolvedPath: options.projectRoot,
      }
    }

    let currentDir = options.projectRoot
    for (const segment of split.segments) {
      const result = guardSingleBashCommand(segment, options, currentDir, false)
      if (!result.allowed) return result
      if (!result.isReadOnly) {
        return {
          allowed: false,
          message:
            "Bash command blocked: chained/piped commands are only allowed when every segment is read-only and repo-safe.",
          resolvedPath: options.projectRoot,
        }
      }
      currentDir = result.nextCwd ?? currentDir
    }

    return {
      allowed: true,
      message: "Bash command passed path guard checks.",
      resolvedPath: currentDir,
    }
  }

  const result = guardSingleBashCommand(split.segments[0] ?? command, options, options.projectRoot, true)
  return {
    allowed: result.allowed,
    message: result.message,
    resolvedPath: result.resolvedPath,
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

