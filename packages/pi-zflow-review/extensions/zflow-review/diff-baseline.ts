/**
 * diff-baseline.ts — Diff baseline resolution for internal code review.
 *
 * Resolves which base ref to compare changes against when constructing
 * diffs for internal code reviewers. Supports explicit override, HEAD,
 * merge-base with main, and the default "main" baseline.
 *
 * ## Usage
 *
 * ```ts
 * import { resolveDiffBaseline, buildDiffCommand, parseDiffBaselineOverride }
 *   from "pi-zflow-review"
 *
 * const baseline = resolveDiffBaseline({ baseRef: "origin/stable-v2" })
 * // { baseRef: "origin/stable-v2", resolution: "explicit", diffCommand: "git diff origin/stable-v2...HEAD" }
 *
 * const cmd = buildDiffCommand("main", "feature-branch")
 * // "git diff main...feature-branch"
 * ```
 *
 * @module pi-zflow-review/diff-baseline
 */

// ── Types ──────────────────────────────────────────────────────

/**
 * Input for resolving a diff baseline.
 */
export interface DiffBaselineInput {
  /**
   * Explicit base ref override (branch name, SHA, tag, etc.).
   * When provided, this takes precedence over useHead, useMergeBase,
   * and the default.
   */
  baseRef?: string
  /**
   * If true, use "HEAD" as the base ref.
   */
  useHead?: boolean
  /**
   * If true, compute merge-base with "main" using three-dot diff
   * notation (`git diff main...HEAD`). Ignored when baseRef is set
   * or useHead is true.
   */
  useMergeBase?: boolean
  /**
   * Working directory (currently unused by pure functions, preserved
   * for future git-execution integration).
   */
  cwd?: string
}

/**
 * The resolved baseline result.
 */
export interface ResolvedBaseline {
  /** The resolved base ref (branch name, SHA, "HEAD", etc.). */
  baseRef: string
  /**
   * How the baseline was determined.
   * - `"explicit"`: caller supplied a baseRef override.
   * - `"head"`: useHead was true.
   * - `"merge-base"`: useMergeBase was true; git three-dot diff.
   * - `"default"`: no overrides; use "main".
   */
  resolution: "explicit" | "head" | "merge-base" | "default"
  /** The git diff command to produce the diff against this baseline. */
  diffCommand: string
}

// ── Baseline resolution ────────────────────────────────────────

/**
 * Resolve the correct diff baseline for internal code review.
 *
 * Priority order:
 * 1. `baseRef` explicit override (if provided).
 * 2. `useHead` → baseline "HEAD".
 * 3. `useMergeBase` → baseline "main" (three-dot diff).
 * 4. Default → baseline "main".
 *
 * @param input - Baseline resolution input.
 * @returns A resolved baseline with the ref, resolution type, and
 *   the corresponding git diff command string.
 */
export function resolveDiffBaseline(input: DiffBaselineInput = {}): ResolvedBaseline {
  const { baseRef, useHead, useMergeBase } = input

  // Priority 1: explicit override
  if (baseRef !== undefined && baseRef !== "") {
    return {
      baseRef,
      resolution: "explicit",
      diffCommand: buildDiffCommand(baseRef, "HEAD"),
    }
  }

  // Priority 2: HEAD
  if (useHead === true) {
    return {
      baseRef: "HEAD",
      resolution: "head",
      diffCommand: buildDiffCommand("HEAD", "HEAD"),
    }
  }

  // Priority 3: merge-base with main (three-dot diff)
  if (useMergeBase === true) {
    return {
      baseRef: "main",
      resolution: "merge-base",
      diffCommand: buildDiffCommand("main", "HEAD", { threeDot: true }),
    }
  }

  // Priority 4: default
  return {
    baseRef: "main",
    resolution: "default",
    diffCommand: buildDiffCommand("main", "HEAD"),
  }
}

// ── Diff command construction ──────────────────────────────────

/**
 * Options for `buildDiffCommand`.
 */
export interface DiffCommandOptions {
  /** Use three-dot notation (`base...head`) for merge-base comparison. */
  threeDot?: boolean
}

/**
 * Build a git diff command string from a baseline and head ref.
 *
 * @param baseline - The base ref to compare against.
 * @param headRef - The head ref (defaults to `"HEAD"`).
 * @param options - Additional options.
 * @returns A git diff command string (e.g. `"git diff main...HEAD"`).
 */
export function buildDiffCommand(
  baseline: string,
  headRef: string = "HEAD",
  options?: DiffCommandOptions,
): string {
  const separator = options?.threeDot === true ? "..." : "..."
  return `git diff ${baseline}${separator}${headRef}`
}

// ── Override parsing ───────────────────────────────────────────

/**
 * Safely trim and validate a baseline override string.
 *
 * Acceptable values include: `"HEAD"`, `"main"`, `"origin/main"`,
 * `"origin/feature-branch"`, a full or abbreviated SHA, or any
 * valid git ref.
 *
 * Returns the cleaned string, or `undefined` for empty/whitespace-only
 * input so the caller can fall back to defaults.
 *
 * @param input - Raw override string (e.g. from CLI argument).
 * @returns The trimmed baseline string, or `undefined` if empty.
 */
export function parseDiffBaselineOverride(input: string): string | undefined {
  const trimmed = input.trim()
  if (trimmed.length === 0) return undefined
  return trimmed
}
