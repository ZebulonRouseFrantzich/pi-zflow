/**
 * guards.ts — Write-target guards for RuneContext change trees.
 *
 * Implements Phase 3 Task 3.8:
 * Prevent runtime/orchestration artifacts from being written inside a
 * RuneContext change-doc directory. The guard functions here are advisory
 * — downstream orchestration code should call them before performing any
 * write inside a RuneContext tree.
 *
 * Only canonical RuneContext doc updates that have been explicitly routed
 * through the pi-runecontext extension are allowed inside the tree.
 * Everything else (run.json, plan-state.json, review findings, transient
 * execution checklists, etc.) is forbidden.
 *
 * @module pi-zflow-runecontext/guards
 */

import * as path from "node:path"

// ── Constants ────────────────────────────────────────────────────

/**
 * Runtime / orchestration artifact names that must never be written inside
 * a RuneContext change tree. These artifacts are derived or transient and
 * should live outside the portable change-doc directory.
 */
const FORBIDDEN_IN_RUNECONTEXT: ReadonlySet<string> = new Set([
  "run.json",
  "plan-state.json",
  "state-index.json",
  "execution-groups.md",
  "deviation-report.md",
  "review-findings.md",
  "repo-map.md",
  "reconnaissance.md",
])

/**
 * Canonical RuneContext document names that ARE allowed to be written
 * inside the change tree. These are the source-of-truth docs that define
 * the change: proposal, design, standards, verification, tasks, references,
 * and status metadata.
 */
const CANONICAL_DOCS: ReadonlySet<string> = new Set([
  "proposal.md",
  "design.md",
  "standards.md",
  "verification.md",
  "tasks.md",
  "references.md",
  "status.yaml",
])

// ── Public guards ────────────────────────────────────────────────

/**
 * Check whether a given filename is allowed to be written inside a
 * RuneContext change tree.
 *
 * - Returns `false` if the filename is a known runtime/orchestration artifact
 *   (e.g. `run.json`, `plan-state.json`, `review-findings.md`).
 * - Returns `true` if the filename is a recognised canonical doc
 *   (e.g. `proposal.md`, `design.md`, `status.yaml`).
 * - Returns `true` for any unknown filename — the guard only rejects
 *   known runtime artifacts, not unrecognised files.
 *
 * @param filename - The file name (basename only, e.g. `"run.json"`).
 * @returns `true` if a write with this filename is allowed inside the
 *          RuneContext tree, `false` if it is forbidden.
 */
export function isWriteAllowedInRuneContextTree(filename: string): boolean {
  // Known runtime artifacts are always forbidden
  if (FORBIDDEN_IN_RUNECONTEXT.has(filename)) {
    return false
  }
  // Canonical docs and any unrecognised files are allowed
  return true
}

/**
 * Validate a target write path against a RuneContext change tree path.
 *
 * If `targetPath` is inside `changePath` (i.e. the RuneContext change-doc
 * directory), the function checks whether the file being written is a
 * forbidden runtime artifact. If the target is outside the change tree,
 * the write is always allowed (the guard only concerns itself with content
 * inside the RuneContext tree).
 *
 * @param targetPath - The absolute or relative path where a write would occur.
 * @param changePath - The absolute path of the RuneContext change directory.
 * @returns An object with:
 *   - `allowed`: `true` if the write is permitted, `false` otherwise.
 *   - `reason`: A human-readable explanation when `allowed` is `false`;
 *     empty string when `allowed` is `true`.
 */
export function validateRuneContextWriteTarget(
  targetPath: string,
  changePath: string,
): { allowed: boolean; reason: string } {
  const absTarget = path.resolve(targetPath)
  const absChange = path.resolve(changePath)

  // If the target is NOT inside the change tree, the guard does not apply.
  if (!absTarget.startsWith(absChange + path.sep) && absTarget !== absChange) {
    return { allowed: true, reason: "" }
  }

  const basename = path.basename(absTarget)

  if (FORBIDDEN_IN_RUNECONTEXT.has(basename)) {
    return {
      allowed: false,
      reason: `runtime artifact "${basename}" must not be written inside RuneContext tree "${absChange}"`,
    }
  }

  return { allowed: true, reason: "" }
}

/**
 * Return a copy of the list of runtime artifact names that are forbidden
 * from being written inside a RuneContext change tree.
 *
 * Useful for documentation, error messages, and downstream tooling that
 * needs to enumerate the guard list.
 *
 * @returns An array of forbidden artifact file names.
 */
export function getForbiddenArtifacts(): string[] {
  return [...FORBIDDEN_IN_RUNECONTEXT]
}
