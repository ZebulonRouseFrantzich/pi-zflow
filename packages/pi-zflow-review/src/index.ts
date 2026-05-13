/**
 * pi-zflow-review
 *
 * Multi-provider plan review, code review, PR/MR diff review,
 * findings parsing/writing helpers, and /zflow-review commands.
 */
export const PACKAGE_VERSION = "0.1.0" as const

// ── Reviewer manifest ──────────────────────────────────────────

export {
  createManifest,
  recordExecuted,
  recordSkipped,
  recordFailed,
  getCoverageSummary,
  isComplete,
  getActiveReviewers,
  getInactiveReviewers,
  getReviewersByStatus,
} from "./reviewer-manifest.js"

export type {
  ReviewerMode,
  ReviewerStatus,
  SkippedReviewer,
  FailedReviewer,
  ReviewerEntry,
  ReviewerManifest,
  CoverageSummary,
} from "./reviewer-manifest.js"
