/**
 * path-guard — shared path-guard and sentinel policy contract.
 *
 * **Purpose**
 *
 * The path guard is pi-zflow's first line of defence against accidental or
 * malicious mutations outside approved directories.  Every mutating operation
 * (write, edit, bash rm/mv, etc.) is gated by `canWrite()`, which enforces
 * an **allowlist-first** security model:
 *
 *   1. Resolve the real path (rejecting symlink escape and `..` traversal).
 *   2. Check the path is within one of the configured **allowed mutation roots**.
 *   3. Check the path does **not** match any **blocked pattern** (`.git/`,
 *      `node_modules/`, `.env*`, home dotfiles, secret-like files).
 *   4. Optionally distinguish **planner-only artifact writes** (allowed in
 *      `<runtime-state-dir>/plans/`) from **implementation writes** (restricted
 *      to the working tree and approved worktree roots).
 *
 * **Ownership**
 *
 * The path guard is shared logic hosted in `pi-zflow-core`.
 * The two extension packages that enforce it at the Pi level are:
 *
 *   - `pi-zflow-change-workflows` — gates all implementation writes
 *     (`/zflow-change-implement`, `/zflow-clean`).
 *   - `pi-zflow-plan-mode` — gates the restricted bash policy during
 *     planning mode (`/zflow-plan`).
 *
 * @module pi-zflow-core/path-guard
 */

import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

// ---------------------------------------------------------------------------
// Sentinel policy — top-level configuration object
// ---------------------------------------------------------------------------

/**
 * Complete sentinel policy that a repo or user can commit as
 * `sentinel-policy.json` (or embed in `pi-zflow.config.json`).
 *
 * Later phases will load this at startup and pass it to the path-guard
 * and bash-policy enforcers.
 */
export interface SentinelPolicy {
  /**
   * Human-readable description of this policy (for diagnostics).
   */
  description?: string

  /**
   * The allowlist of directories where mutations are permitted.
   */
  allowedRoots: AllowedRoot[]

  /**
   * Glob-like patterns that are **always** denied, even inside allowed roots.
   */
  blockedPatterns: BlockedPattern[]

  /**
   * Symlink / traversal safety configuration.
   */
  symlinkSafety: SymlinkSafetyConfig

  /**
   * Planner artifact write policy — which directories the planner may
   * write to without triggering implementation-level restrictions.
   */
  plannerArtifactPolicy: PlannerArtifactPolicy
}

// ---------------------------------------------------------------------------
// Allowed roots
// ---------------------------------------------------------------------------

/**
 * A single entry in the mutation allowlist.
 */
export interface AllowedRoot {
  /**
   * Absolute or project-root-relative path to the allowed root.
   *
   * Relative paths are resolved against the project root at policy-load time.
   *
   * Examples:
   *   - `"."` — the repo working tree root
   *   - `"worktrees"` — a directory where temp worktrees live
   *   - `"/tmp/pi-zflow-*"` — temp fallback directories (glob)
   */
  path: string

  /**
   * Optional label for diagnostics.
   */
  label?: string

  /**
   * If true, the path is interpreted as a glob pattern and all matching
   * directories are allowed.  Default: `false`.
   */
  glob?: boolean

  /**
   * Optional restriction on what **write intent** is allowed in this root.
   *
   * - `"any"` (default) — any write is allowed.
   * - `"planner-artifact"` — only planner artifact writes are permitted here.
   *
   * This is how the planner-artifact runtime directory is protected from
   * implementation writes that might trample plan state.
   */
  allowIntent?: "any" | "planner-artifact"
}

// ---------------------------------------------------------------------------
// Blocked patterns
// ---------------------------------------------------------------------------

/**
 * A glob pattern defining paths that must never be mutated.
 */
export interface BlockedPattern {
  /**
   * Glob pattern relative to the allowed root, or absolute.
   *
   * Examples:
   *   - `.git/**`
   *   - `node_modules/**`
   *   - `.env*`
   *   - `** /secret*` (without the space)
   */
  pattern: string

  /**
   * Human-readable reason shown when a write is blocked.
   */
  reason: string

  /**
   * Severity:
   *   - `"error"` (default) — the write is blocked and the operation fails.
   *   - `"warn"` — the write is allowed but a diagnostic warning is emitted.
   *     Useful for soft-blocked patterns that may be relaxed later.
   */
  severity?: "error" | "warn"

  /**
   * Glob patterns that **exclude** certain paths from this blocked pattern.
   *
   * If the target path matches any exclusion pattern, the blocked pattern does
   * NOT apply — the write is allowed (subject to other policy checks).
   *
   * This is used to carve out intentional exceptions, such as the runtime
   * state directory inside `.git/`:
   *
   * ```json
   * { "pattern": ".git/**", "exclude": ["<runtime-state-dir>/**"], ... }
   * ```
   */
  exclude?: string[]
}

// ---------------------------------------------------------------------------
// Symlink / traversal safety
// ---------------------------------------------------------------------------

/**
 * Configuration for symlink escape and `..` traversal detection.
 */
export interface SymlinkSafetyConfig {
  /**
   * If true (default), symlinks are followed and the resolved real path
   * is checked against the allowlist.  Symlinks that resolve outside
   * allowed roots are rejected.
   */
  resolveSymlinks: boolean

  /**
   * If true (default), `..` traversal components in the path are
   * resolved and checked against the allowlist.  Paths that would
   * escape the allowed root via `..` are rejected.
   */
  preventTraversal: boolean
}

// ---------------------------------------------------------------------------
// Planner artifact policy
// ---------------------------------------------------------------------------

/**
 * Controls which directories the planner may write to.
 *
 * The planner must never modify source code (Must-preserve Decision #14).
 * Planner writes are restricted to dedicated artifact directories.
 */
export interface PlannerArtifactPolicy {
  /**
   * List of glob patterns for directories where planner artifact writes
   * are permitted.
   *
   * Default typically includes:
   *   - `<runtime-state-dir>/plans/**`
   *   - `<runtime-state-dir>/reconnaissance.md`
   *   - `<runtime-state-dir>/repo-map.md`
   */
  allowedArtifactDirs: string[]
}

// ---------------------------------------------------------------------------
// Write intent
// ---------------------------------------------------------------------------

/**
 * Distinguishes the **purpose** of a write operation.
 *
 * This is the mechanism that enforces "the planner must never modify source
 * code" (Must-preserve Decision #14) and keeps implementation writes from
 * trampling plan artifacts.
 */
export type WriteIntent =
  /** A planner writing a design doc, plan-state, or review artifact. */
  | "planner-artifact"
  /** An implementer (worker subagent) modifying source code or config. */
  | "implementation"
  /** System operation such as cleanup or log rotation. */
  | "system"
  /** Intent not yet classified — should be treated conservatively. */
  | "unknown"

// ---------------------------------------------------------------------------
// Path guard context passed to canWrite()
// ---------------------------------------------------------------------------

/**
 * Runtime context for a single `canWrite()` invocation.
 */
export interface PathGuardContext {
  /** The resolved sentinel policy in effect. */
  policy: SentinelPolicy

  /**
   * The project root (resolved working-tree root).
   * Relative `AllowedRoot.path` values are resolved against this.
   */
  projectRoot: string

  /**
   * The runtime state directory (`<git-dir>/pi-zflow/` or temp fallback).
   * Planner artifact patterns are resolved relative to this.
   */
  runtimeStateDir: string

  /** The intent of the write operation. */
  intent: WriteIntent

  /**
   * Extra diagnostic metadata (optional).
   * Example: `{ runId: "run-42", agent: "worker-1" }`
   */
  meta?: Record<string, string>
}

// ---------------------------------------------------------------------------
// canWrite result
// ---------------------------------------------------------------------------

/**
 * Result of a `canWrite()` check.
 */
export interface CanWriteResult {
  /** Whether the write is permitted. */
  allowed: boolean

  /**
   * Human-readable message.
   * On denial, explains why the path was blocked.
   * On allowance, may be empty or confirm which rule matched.
   */
  message: string

  /**
   * If denied, the specific reason category.
   */
  reason?: "outside-allowed-roots" | "blocked-pattern" | "symlink-escape" | "traversal" | "intent-mismatch"

  /**
   * If denied, the matched blocked pattern (if applicable).
   */
  matchedPattern?: string
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Default allowed mutation roots.
 *
 *  1. The current working directory (project root) — implementation writes.
 *  2. `<runtime-state-dir>/plans/` — planner artifact writes only.
 *  3. `<runtime-state-dir>/review/` — planner artifact writes only.
 *  4. System temp directory (for fallback worktrees) — any write.
 *
 * NOTE: `<runtime-state-dir>` is resolved at runtime by `resolveRuntimeStateDir()`.
 * The patterns here are templates; the path guard substitutes the actual value.
 */
export const DEFAULT_ALLOWED_ROOTS: AllowedRoot[] = [
  { path: ".", label: "project root", allowIntent: "implementation" },
  // Planner artifact roots are resolved at runtime using runtimeStateDir
]

/**
 * Default blocked path patterns.
 *
 * These must be matched **case-insensitively** on case-insensitive filesystems.
 *
 * NOTE: The `.git/**` pattern excludes `<runtime-state-dir>/**` because
 * runtime state intentionally lives inside `.git/` per Task 0.6 design.
 * The `<runtime-state-dir>` placeholder is resolved at policy-load time.
 */
export const DEFAULT_BLOCKED_PATTERNS: BlockedPattern[] = [
  // --- Git internals (excludes the intentional runtime-state-dir carve-out) ---
  { pattern: ".git/**",             reason: "Git metadata must not be modified by automation", severity: "error",
    exclude: ["<runtime-state-dir>/**"] },
  { pattern: ".gitignore",          reason: "Gitignore must not be modified without explicit user intent", severity: "error" },
  { pattern: ".gitattributes",      reason: "Gitattributes must not be modified without explicit user intent", severity: "error" },
  { pattern: ".gitmodules",         reason: "Gitmodules must not be modified without explicit user intent", severity: "error" },

  // --- Dependencies ---
  { pattern: "node_modules/**",     reason: "node_modules is managed by package manager", severity: "error" },

  // --- Secrets and credentials ---
  { pattern: ".env*",               reason: "Environment/secret files must not be modified by automation", severity: "error" },
  { pattern: "**/*.pem",            reason: "Private key files must not be modified by automation", severity: "error" },
  { pattern: "**/*.key",            reason: "Private key files must not be modified by automation", severity: "error" },
  { pattern: "**/credentials*",     reason: "Credential files must not be modified by automation", severity: "error" },
  { pattern: "**/secrets/**",       reason: "Secrets directory must not be modified by automation", severity: "error" },

  // --- User home dotfiles (protects against runaway writes) ---
  { pattern: "~/.ssh/**",           reason: "SSH config must not be modified by automation", severity: "error" },
  { pattern: "~/.aws/**",           reason: "AWS config must not be modified by automation", severity: "error" },
  { pattern: "~/.config/**",        reason: "User config must not be modified by automation", severity: "warn" },
  { pattern: "~/.pi/**",            reason: "Pi config must not be modified without explicit user intent", severity: "error" },

  // --- Build outputs (typically generated, not source) ---
  { pattern: "dist/**",             reason: "Build output is generated; modify source instead", severity: "warn" },
  { pattern: ".cache/**",           reason: "Cache directory should not be modified by automation", severity: "warn" },
  { pattern: ".next/**",            reason: "Next.js build output is generated; modify source instead", severity: "warn" },
]

/**
 * Default symlink safety configuration.
 */
export const DEFAULT_SYMLINK_SAFETY: SymlinkSafetyConfig = {
  resolveSymlinks: true,
  preventTraversal: true,
}

/**
 * Default planner artifact policy.
 */
export function defaultPlannerArtifactPolicy(runtimeStateDir: string): PlannerArtifactPolicy {
  return {
    allowedArtifactDirs: [
      `${runtimeStateDir}/plans/**`,
      `${runtimeStateDir}/review/**`,
      `${runtimeStateDir}/reconnaissance.md`,
      `${runtimeStateDir}/repo-map.md`,
      `${runtimeStateDir}/state-index.json`,
    ],
  }
}

// ---------------------------------------------------------------------------
// Utility: resolve a path safely (no symlink escape, no traversal)
// ---------------------------------------------------------------------------

/**
 * Safely resolve a path to its real location, rejecting symlink escape
 * and `..` traversal.
 *
 * **Traversal detection (relative paths only):**
 * Relative paths are anchored to `projectRoot`. If the resolved path
 * would escape the project root via `..` components, it is rejected.
 * Absolute paths cannot be anchored to `projectRoot` and instead resolve
 * based on their own root (e.g. `/tmp/pi-zflow/...`); they are checked
 * against the sentinel policy's allowed roots by `canWrite()`.
 *
 * **Symlink escape detection:**
 * Symlinks are resolved and the real path is returned. The caller
 * (`canWrite()`) is responsible for checking the real path against
 * allowed roots. This function only ensures the path can be resolved
 * without filesystem errors.
 *
 * @param targetPath  The path to resolve (may be relative).
 * @param projectRoot Absolute project root used as anchor for relative paths.
 * @param config      Symlink safety configuration.
 * @returns The resolved real absolute path, or `null` if the path is unsafe.
 */
export function realpathSafe(
  targetPath: string,
  projectRoot: string,
  config: SymlinkSafetyConfig = DEFAULT_SYMLINK_SAFETY,
): string | null {
  const isRelative = !path.isAbsolute(targetPath)

  // Resolve to absolute
  const absPath = isRelative ? path.resolve(projectRoot, targetPath) : path.resolve(targetPath)

  // --- Traversal detection (relative paths only) ---
  //
  // Relative paths are anchored to projectRoot.  A relative path like
  // "src/../../etc/passwd" would resolve outside the project root and
  // must be rejected.
  //
  // Absolute paths (e.g. "/tmp/pi-zflow-abc123/...") are not anchored to
  // projectRoot and cannot "escape" via ".." in a meaningful way. They
  // are checked against the sentinel policy's allowed roots in canWrite().
  if (config.preventTraversal && isRelative) {
    const normalized = path.normalize(absPath)
    const rel = path.relative(projectRoot, normalized)
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return null  // escaped via ..
    }
  }

  // --- Symlink resolution ---
  if (config.resolveSymlinks) {
    try {
      const real = fs.realpathSync(absPath)
      // Return the resolved real path. The caller (canWrite) will check
      // it against allowed roots — there is no separate project-root
      // check here because legitimate paths routinely sit outside the
      // working tree (e.g. <git-dir>/pi-zflow/ for runtime state,
      // /tmp/pi-zflow-<hash>/ for fallback, or active worktree roots).
      return real
    } catch {
      // Path may not exist yet (e.g., about to create a file)
      // Fall through — return the absolute unresolved path
    }
  }

  return absPath
}

// ---------------------------------------------------------------------------
// Allowlist check
// ---------------------------------------------------------------------------

/**
 * Check whether `resolvedPath` is within one of the configured allowed roots.
 *
 * @param resolvedPath  An already-resolved absolute path.
 * @param allowedRoots  List of allowed roots from the policy.
 * @param projectRoot   Project root used to resolve relative allowed root paths.
 * @returns `true` if the path is within at least one allowed root.
 */
export function isWithinAllowedRoots(
  resolvedPath: string,
  allowedRoots: AllowedRoot[],
  projectRoot: string,
): boolean {
  for (const root of allowedRoots) {
    const rootAbs = path.isAbsolute(root.path) ? root.path : path.resolve(projectRoot, root.path)

    if (root.glob) {
      // Glob matching — basic support for ** and * at end of pattern.
      // Use path-relative containment rather than raw startsWith so
      // /tmp/root-other does not match /tmp/root.
      const pattern = rootAbs.endsWith("/**") ? rootAbs.slice(0, -3) : rootAbs
      if (isSameOrWithin(resolvedPath, pattern)) return true
    } else {
      // Directory/file containment match.
      if (isSameOrWithin(resolvedPath, rootAbs)) return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Blocked-pattern check
// ---------------------------------------------------------------------------

/**
 * Check whether `resolvedPath` matches any blocked pattern.
 *
 * @param resolvedPath   An already-resolved absolute path.
 * @param blockedPatterns List of blocked patterns from the policy.
 * @param projectRoot    Project root used to relativize paths for pattern matching.
 * @returns The first matching `BlockedPattern`, or `null` if none match.
 */
export function matchesBlockedPatterns(
  resolvedPath: string,
  blockedPatterns: BlockedPattern[],
  projectRoot: string,
): BlockedPattern | null {
  // Convert to a project-root-relative path for pattern matching
  const relPath = path.relative(projectRoot, resolvedPath)

  for (const bp of blockedPatterns) {
    if (!matchGlob(relPath, bp.pattern)) continue

    // If the blocked pattern has exclusion patterns, check them
    if (bp.exclude && bp.exclude.length > 0) {
      const isExcluded = bp.exclude.some((exPattern) => matchGlob(relPath, exPattern))
      if (isExcluded) continue  // Exclusion matched — skip this blocked pattern
    }

    return bp
  }
  return null
}

// ---------------------------------------------------------------------------
// Core canWrite()
// ---------------------------------------------------------------------------

/**
 * The central path-guard decision function.
 *
 * Every mutating operation in pi-zflow must call `canWrite()` before
 * performing the write.  This enforces the allowlist-first security model.
 *
 * **Algorithm:**
 *
 *  1. Resolve the real path (`realpathSafe`).
 *     - Rejects symlink escape and `..` traversal.
 *     - If the file doesn't exist yet, resolves the parent directory.
 *  2. Check the resolved path is within an allowed root.
 *  3. Check the path doesn't match any blocked pattern.
 *  4. If the write intent is `"planner-artifact"`, verify the path is
 *     within an artifact directory.
 *  5. If the write intent is `"implementation"`, verify the path is NOT
 *     a planner artifact directory (prevents trampling plan state).
 *
 * @param targetPath  The path the caller wants to write to.
 * @param context     Full runtime context (policy, project root, intent).
 * @returns A `CanWriteResult` indicating whether the write is permitted.
 */
export function canWrite(
  targetPath: string,
  context: PathGuardContext,
): CanWriteResult {
  const { policy, projectRoot, intent } = context

  // --- Step 1: resolve real path safely ---
  const resolved = realpathSafe(targetPath, projectRoot, policy.symlinkSafety)
  if (resolved === null) {
    // Path may not exist yet — try resolving the parent directory
    const parentResolved = realpathSafe(path.dirname(targetPath), projectRoot, policy.symlinkSafety)
    if (parentResolved === null) {
      return {
        allowed: false,
        message: `Path "${targetPath}" is outside the project root or escapes via symlink/traversal.`,
        reason: resolved === null && parentResolved === null ? "symlink-escape" : "traversal",
      }
    }
  }

  const finalPath = resolved ?? realpathSafe(path.dirname(targetPath), projectRoot, policy.symlinkSafety)!

  // --- Step 2: check allowed roots ---
  if (!isWithinAllowedRoots(finalPath, policy.allowedRoots, projectRoot)) {
    return {
      allowed: false,
      message: `Path "${targetPath}" is not within any configured allowed root.`,
      reason: "outside-allowed-roots",
    }
  }

  // --- Step 3: check blocked patterns ---
  const blocked = matchesBlockedPatterns(finalPath, policy.blockedPatterns, projectRoot)
  if (blocked && blocked.severity !== "warn") {
    return {
      allowed: false,
      message: `Path "${targetPath}" matches blocked pattern "${blocked.pattern}": ${blocked.reason}`,
      reason: "blocked-pattern",
      matchedPattern: blocked.pattern,
    }
  }

  // --- Step 4 & 5: intent-based restrictions ---
  if (intent === "planner-artifact") {
    const artifactOk = isWithinArtifactDir(finalPath, context)
    if (!artifactOk) {
      return {
        allowed: false,
        message: `Planner artifact writes are only allowed in ${context.runtimeStateDir}/plans/ and ${context.runtimeStateDir}/review/.`,
        reason: "intent-mismatch",
      }
    }
  }

  if (intent === "implementation") {
    // Implementers must NOT write to planner artifact directories
    const inArtifactDir = isWithinArtifactDir(finalPath, context)
    if (inArtifactDir) {
      return {
        allowed: false,
        message: `Implementation writes must not modify plan artifacts. Path "${targetPath}" is inside a planner-artifact directory.`,
        reason: "intent-mismatch",
      }
    }
  }

  // --- All checks passed ---
  let message = `Write to "${targetPath}" is permitted.`
  if (blocked && blocked.severity === "warn") {
    message = `Write to "${targetPath}" matches soft-blocked pattern "${blocked.pattern}": ${blocked.reason}`
  }

  return { allowed: true, message }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Return true when `candidate` is exactly `root` or is contained beneath it.
 *
 * This avoids raw string prefix checks, where `/tmp/project-other` would
 * otherwise incorrectly match `/tmp/project`.
 */
function isSameOrWithin(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

/**
 * Simple glob matching.
 *
 * Supports `**` (match any number of directories), `*` (match within a single
 * path segment), and literal characters.
 *
 * This is intentionally simple — it does NOT support `?`, `[a-z]`, or `{a,b}`
 * patterns.  Later phases may replace this with `picomatch` or `minimatch`.
 */
function matchGlob(target: string, pattern: string): boolean {
  // Normalise path separators
  const normalizedTarget = target.replace(/\\/g, "/")
  const normalizedPattern = pattern.replace(/\\/g, "/")

  // Escape regex special characters, then replace glob wildcards
  let regexStr = ""
  let i = 0
  while (i < normalizedPattern.length) {
    const ch = normalizedPattern[i]
    if (ch === "*" && normalizedPattern[i + 1] === "*" && normalizedPattern[i + 2] === "/") {
      // **/ — match zero or more directory levels
      regexStr += "(.*/)?"
      i += 3
    } else if (ch === "*" && normalizedPattern[i + 1] === "*" && i + 2 >= normalizedPattern.length) {
      // ** at end — match everything
      regexStr += ".*"
      i += 2
    } else if (ch === "*") {
      // single * — match within a single path segment
      regexStr += "[^/]*"
      i += 1
    } else {
      // literal character — escape for regex
      regexStr += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")
      i += 1
    }
  }

  const regex = new RegExp(`^${regexStr}$`)
  return regex.test(normalizedTarget)
}

/**
 * Check whether a resolved path is inside a planner artifact directory.
 */
function isWithinArtifactDir(resolvedPath: string, context: PathGuardContext): boolean {
  const { policy, runtimeStateDir } = context
  const dirs = policy.plannerArtifactPolicy.allowedArtifactDirs

  for (const pattern of dirs) {
    const resolvedPattern = pattern.replace("<runtime-state-dir>", runtimeStateDir)
    if (matchGlob(resolvedPath, resolvedPattern)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Public helper: build a fully-resolved SentinelPolicy from defaults + overrides
// ---------------------------------------------------------------------------

/**
 * Build a resolved `SentinelPolicy` by merging defaults with user-provided
 * overrides (if any).  The runtime state directory is substituted into
 * planner-artifact patterns at this point.
 *
 * In addition to the overridden/ default allowed roots, the resolved
 * policy automatically includes the runtime state directory sub-paths
 * (from the planner artifact policy) as allowed roots with
 * `allowIntent: "planner-artifact"` so that planner writes to
 * `<runtime-state-dir>/plans/`, `<runtime-state-dir>/review/`, etc.
 * are permitted even when the runtime state directory sits outside the
 * project root (e.g. the OS temp fallback).
 *
 * @param overrides       Partial policy overrides (may be empty).
 * @param projectRoot     Resolved project root.
 * @param runtimeStateDir Resolved runtime state directory.
 * @returns A fully-resolved `SentinelPolicy`.
 */
export function resolveSentinelPolicy(
  overrides: Partial<SentinelPolicy>,
  projectRoot: string,
  runtimeStateDir: string,
): SentinelPolicy {
  const allowedRoots = overrides.allowedRoots ?? DEFAULT_ALLOWED_ROOTS
  const blockedPatterns = overrides.blockedPatterns ?? DEFAULT_BLOCKED_PATTERNS
  const symlinkSafety = overrides.symlinkSafety ?? DEFAULT_SYMLINK_SAFETY
  const plannerArtifactPolicy = overrides.plannerArtifactPolicy ?? defaultPlannerArtifactPolicy(runtimeStateDir)

  // Resolve relative allowed root paths against projectRoot
  const resolvedRoots = allowedRoots.map((root) => {
    if (path.isAbsolute(root.path)) return root
    return { ...root, path: path.resolve(projectRoot, root.path) }
  })

  // Resolve any <runtime-state-dir> placeholders in blocked patterns (including exclusions).
  // Patterns are relative to projectRoot, so ensure exclusion patterns are also relative.
  const resolvedBlocked = blockedPatterns.map((bp) => ({
    ...bp,
    pattern: bp.pattern.replace("<runtime-state-dir>", runtimeStateDir),
    exclude: bp.exclude?.map((e) => {
      const resolved = e.replace("<runtime-state-dir>", runtimeStateDir)
      // If the exclusion is absolute, relativize it against projectRoot
      if (path.isAbsolute(resolved)) {
        return path.relative(projectRoot, resolved)
      }
      return resolved
    }),
  }))

  // Resolve planner artifact dirs
  const resolvedArtifactDirs = plannerArtifactPolicy.allowedArtifactDirs.map(
    (d) => d.replace("<runtime-state-dir>", runtimeStateDir),
  )

  // Merge the runtime state dir and its sub-paths into the allowed roots so
  // that planner-artifact writes are always permitted, even when the runtime
  // state dir falls outside the project root (temp fallback).
  const runtimeStateRoots: AllowedRoot[] = resolvedArtifactDirs.map((dir) => ({
    path: dir.endsWith("/**") ? dir.slice(0, -3) : dir,
    label: `runtime-state: ${dir}`,
    glob: dir.endsWith("/**"),
    allowIntent: "any" as const,
  }))
  // Also add the bare runtime state dir root so writes to the state index etc. work
  runtimeStateRoots.push({
    path: runtimeStateDir,
    label: "runtime-state-root",
    allowIntent: "any",
  })

  // Merge — deduplicate by path (in-order, so user roots win on collision)
  const seen = new Set(resolvedRoots.map((r) => r.path))
  for (const r of runtimeStateRoots) {
    if (!seen.has(r.path)) {
      resolvedRoots.push(r)
      seen.add(r.path)
    }
  }

  return {
    description: overrides.description ?? "pi-zflow default sentinel policy",
    allowedRoots: resolvedRoots,
    blockedPatterns: resolvedBlocked,
    symlinkSafety,
    plannerArtifactPolicy: {
      allowedArtifactDirs: resolvedArtifactDirs,
    },
  }
}
