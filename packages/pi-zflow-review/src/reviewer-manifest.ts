/**
 * reviewer-manifest.ts — Reviewer-manifest shape and swarm input contracts.
 *
 * Defines the manifest structure used by plan-review and code-review swarms
 * for tracking requested, executed, skipped, and failed reviewers. The
 * manifest carries enough data for the synthesizer agent (zflow.synthesizer)
 * to reason over actual coverage and produce a consolidated report.
 *
 * ## Design rules
 *
 * - Supports both plan-review and code-review modes.
 * - Captures requested/executed/skipped/failed reviewer sets.
 * - Manifest is immutable-style: mutating functions return new objects.
 * - Tier field preserves the plan's tier classification
 *   ("standard", "logic", "system", "logic,system") for diagnostics.
 *
 * ## Usage
 *
 * ```ts
 * import { createManifest, recordExecuted, getCoverageSummary }
 *   from "pi-zflow-review"
 *
 * const manifest = createManifest("code-review", "standard", [
 *   "correctness", "integration", "security",
 * ])
 * const updated = recordExecuted(recordExecuted(manifest, "correctness"), "integration")
 * const summary = getCoverageSummary(updated)
 * // { total: 3, executed: 2, skipped: 0, failed: 0, complete: false }
 * ```
 *
 * @module pi-zflow-review/reviewer-manifest
 */

// ── Core types ──────────────────────────────────────────────────

/**
 * The review mode distinguishes between code-review and plan-review flows.
 *
 * - `"code-review"`: Reviewing implementation changes (diffs, worktree).
 * - `"plan-review"`: Reviewing planning artifacts (design, execution-groups, etc.).
 */
export type ReviewerMode = "code-review" | "plan-review"

/**
 * The status of a reviewer in the manifest lifecycle.
 *
 * - `"requested"`: Reviewer was requested but has not yet been dispatched.
 * - `"executed"`: Reviewer ran successfully and produced findings.
 * - `"skipped"`: Reviewer was not run (e.g., lane unavailable, optional and
 *   not needed, or conditionally excluded based on tier rules).
 * - `"failed"`: Reviewer was dispatched but returned an error.
 */
export type ReviewerStatus = "requested" | "executed" | "skipped" | "failed"

/**
 * Information about a reviewer that was skipped.
 */
export interface SkippedReviewer {
  /** Short name of the reviewer (e.g. "logic", "system"). */
  name: string
  /** Human-readable reason for skipping. */
  reason: string
}

/**
 * Information about a reviewer that failed during execution.
 */
export interface FailedReviewer {
  /** Short name of the reviewer (e.g. "correctness"). */
  name: string
  /** Error message or description of the failure. */
  error: string
}

/**
 * Runtime state for a single reviewer within a manifest.
 */
export interface ReviewerEntry {
  /** Short name of the reviewer (e.g. "correctness", "integration"). */
  name: string
  /** Current lifecycle status. */
  status: ReviewerStatus
  /** When skipped, the reason. When failed, the error. Otherwise undefined. */
  detail?: string
}

/**
 * The reviewer manifest — a complete record of a review swarm execution.
 *
 * Carries enough data for the synthesizer to reason over actual coverage
 * and produce a diagnostic report.
 */
export interface ReviewerManifest {
  /**
   * The review mode: "code-review" or "plan-review".
   */
  mode: ReviewerMode

  /**
   * Tier classification for plan reviews.
   * - `"standard"`: correctness + integration reviewers
   * - `"logic"`: correctness + integration + logic reviewers
   * - `"system"`: correctness + integration + feasibility reviewers
   * - `"logic,system"`: all available reviewers
   *
   * For code reviews, this is typically `"standard"`.
   */
  tier: string

  /**
   * Run identifier for correlation and diagnostics.
   * Generated at manifest creation time.
   */
  runId: string

  /**
   * Timestamp (ISO 8601) when the manifest was created.
   */
  createdAt: string

  /**
   * The complete list of all reviewers in this swarm with their current
   * lifecycle status. This is the source of truth for requested/executed/
   * skipped/failed sets.
   */
  reviewers: ReviewerEntry[]

  /**
   * Convenience: list of reviewer names that were requested but did not
   * run (skipped).
   */
  skippedReviewers: SkippedReviewer[]

  /**
   * Convenience: list of reviewers that failed during execution.
   */
  failedReviewers: FailedReviewer[]
}

// ── Coverage summary ───────────────────────────────────────────

/**
 * Summary statistics for a reviewer manifest.
 */
export interface CoverageSummary {
  /** Total number of requested reviewers. */
  total: number
  /** Number of reviewers that executed successfully. */
  executed: number
  /** Number of reviewers that were skipped. */
  skipped: number
  /** Number of reviewers that failed. */
  failed: number
  /** Whether all requested reviewers have finished (executed + skipped + failed === total). */
  complete: boolean
}

// ── Manifest factory ───────────────────────────────────────────

let _runIdCounter = 0

/**
 * Generate a unique run ID for a manifest.
 */
function generateRunId(): string {
  _runIdCounter++
  const timestamp = Date.now().toString(36)
  const counter = _runIdCounter.toString(36).padStart(4, "0")
  return `rev-${timestamp}-${counter}`
}

/**
 * Create a new reviewer manifest.
 *
 * All requested reviewers start in the `"requested"` state.
 *
 * @param mode - The review mode ("code-review" or "plan-review").
 * @param tier - Tier classification (e.g. "standard", "logic", "system").
 * @param requestedReviewers - Array of reviewer short names (e.g. ["correctness", "integration"]).
 * @returns A new ReviewerManifest with all reviewers in requested state.
 */
export function createManifest(
  mode: ReviewerMode,
  tier: string,
  requestedReviewers: string[],
): ReviewerManifest {
  const reviewers: ReviewerEntry[] = requestedReviewers.map((name) => ({
    name,
    status: "requested",
  }))

  return {
    mode,
    tier,
    runId: generateRunId(),
    createdAt: new Date().toISOString(),
    reviewers,
    skippedReviewers: [],
    failedReviewers: [],
  }
}

// ── Manifest mutation helpers (immutable-style) ────────────────

/**
 * Deep-clone a manifest for immutable-style updates.
 */
function cloneManifest(m: ReviewerManifest): ReviewerManifest {
  return {
    ...m,
    reviewers: m.reviewers.map((r) => ({ ...r })),
    skippedReviewers: m.skippedReviewers.map((s) => ({ ...s })),
    failedReviewers: m.failedReviewers.map((f) => ({ ...f })),
  }
}

/**
 * Find a reviewer entry by name. Returns undefined if not found.
 */
function findReviewer(
  manifest: ReviewerManifest,
  reviewerName: string,
): ReviewerEntry | undefined {
  return manifest.reviewers.find((r) => r.name === reviewerName)
}

/**
 * Throw if the reviewer is unknown.
 */
function assertReviewerExists(
  manifest: ReviewerManifest,
  reviewerName: string,
): asserts reviewerName is string {
  if (!findReviewer(manifest, reviewerName)) {
    throw new Error(
      `Unknown reviewer "${reviewerName}". ` +
        `Known reviewers: [${manifest.reviewers.map((r) => r.name).join(", ")}].`,
    )
  }
}

/**
 * Mark a reviewer as executed (completed successfully).
 *
 * @param manifest - The current manifest (not mutated).
 * @param reviewerName - Short name of the reviewer (e.g. "correctness").
 * @returns A new manifest with the reviewer marked as executed.
 * @throws If the reviewer is unknown.
 */
export function recordExecuted(
  manifest: ReviewerManifest,
  reviewerName: string,
): ReviewerManifest {
  assertReviewerExists(manifest, reviewerName)

  const updated = cloneManifest(manifest)
  const entry = updated.reviewers.find((r) => r.name === reviewerName)!
  entry.status = "executed"
  return updated
}

/**
 * Mark a reviewer as skipped (not run).
 *
 * @param manifest - The current manifest (not mutated).
 * @param reviewerName - Short name of the reviewer.
 * @param reason - Human-readable reason for skipping.
 * @returns A new manifest with the reviewer marked as skipped.
 * @throws If the reviewer is unknown.
 */
export function recordSkipped(
  manifest: ReviewerManifest,
  reviewerName: string,
  reason: string,
): ReviewerManifest {
  assertReviewerExists(manifest, reviewerName)

  const updated = cloneManifest(manifest)
  const entry = updated.reviewers.find((r) => r.name === reviewerName)!
  entry.status = "skipped"
  entry.detail = reason
  updated.skippedReviewers = [
    ...updated.skippedReviewers,
    { name: reviewerName, reason },
  ]
  return updated
}

/**
 * Mark a reviewer as failed (execution error).
 *
 * @param manifest - The current manifest (not mutated).
 * @param reviewerName - Short name of the reviewer.
 * @param error - Error message or description of the failure.
 * @returns A new manifest with the reviewer marked as failed.
 * @throws If the reviewer is unknown.
 */
export function recordFailed(
  manifest: ReviewerManifest,
  reviewerName: string,
  error: string,
): ReviewerManifest {
  assertReviewerExists(manifest, reviewerName)

  const updated = cloneManifest(manifest)
  const entry = updated.reviewers.find((r) => r.name === reviewerName)!
  entry.status = "failed"
  entry.detail = error
  updated.failedReviewers = [
    ...updated.failedReviewers,
    { name: reviewerName, error },
  ]
  return updated
}

// ── Query helpers ──────────────────────────────────────────────

/**
 * Get a summary of reviewer coverage from the manifest.
 *
 * @param manifest - The reviewer manifest.
 * @returns Coverage statistics.
 */
export function getCoverageSummary(manifest: ReviewerManifest): CoverageSummary {
  const total = manifest.reviewers.length
  const executed = manifest.reviewers.filter(
    (r) => r.status === "executed",
  ).length
  const skipped = manifest.reviewers.filter(
    (r) => r.status === "skipped",
  ).length
  const failed = manifest.reviewers.filter(
    (r) => r.status === "failed",
  ).length

  return {
    total,
    executed,
    skipped,
    failed,
    complete: executed + skipped + failed === total,
  }
}

/**
 * Check whether all requested reviewers have completed (executed, skipped,
 * or failed). This does not distinguish success from failure — it only
 * checks that no reviewers remain in the "requested" state.
 *
 * @param manifest - The reviewer manifest.
 * @returns true if all reviewers have finished, false otherwise.
 */
export function isComplete(manifest: ReviewerManifest): boolean {
  return manifest.reviewers.every((r) => r.status !== "requested")
}

/**
 * Get the set of reviewers that actually ran (executed successfully).
 *
 * @param manifest - The reviewer manifest.
 * @returns Array of reviewer names that executed successfully.
 */
export function getActiveReviewers(manifest: ReviewerManifest): string[] {
  return manifest.reviewers
    .filter((r) => r.status === "executed")
    .map((r) => r.name)
}

/**
 * Get the set of reviewers that were requested but did not execute
 * (combines skipped and failed).
 *
 * @param manifest - The reviewer manifest.
 * @returns Array of reviewer names that did not execute.
 */
export function getInactiveReviewers(manifest: ReviewerManifest): string[] {
  return manifest.reviewers
    .filter((r) => r.status !== "executed")
    .map((r) => r.name)
}

/**
 * Get the set of reviewer short names that are in a specific status.
 *
 * @param manifest - The reviewer manifest.
 * @param status - The status to filter by.
 * @returns Array of reviewer names matching the status.
 */
export function getReviewersByStatus(
  manifest: ReviewerManifest,
  status: ReviewerStatus,
): string[] {
  return manifest.reviewers
    .filter((r) => r.status === status)
    .map((r) => r.name)
}
