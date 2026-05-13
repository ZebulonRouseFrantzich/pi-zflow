/**
 * pi-zflow-review extension entrypoint
 *
 * Registers `/zflow-review-code` and `/zflow-review-pr <url>` commands.
 * Exports reviewer-manifest creation helpers and findings formatting.
 *
 * ## Registration contract
 *
 * - Claims `"review"` capability via `getZflowRegistry()` (guarded against
 *   duplicate loads).
 * - Provides `"review"` service with manifest creation, tier selection,
 *   and review orchestration primitives.
 * - Registers `/zflow-review-code`, `/zflow-review-pr <url>` commands.
 *
 * ## Related modules
 *
 * - `findings.ts` — reviewer-manifest helpers and tier→reviewer mapping
 * - `pr.ts` — PR/MR diff-only fetch and review
 * - `chunking.ts` — large-diff chunking for multi-reviewer dispatch
 * - `src/reviewer-manifest.ts` — manifest types and immutable helpers
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

import {
  createManifest,
} from "pi-zflow-review"

import type {
  ReviewerManifest,
  ReviewerMode,
} from "pi-zflow-review"

// ── Re-export findings helpers ─────────────────────────────────

export {
  getReviewerNamesForPlanTier,
  getReviewerNamesForCodeTier,
  buildManifestFromTier,
  resolveTier,
  collectReviewTags,
  choosePlanReviewTier,
  formatSeveritySummary,
  formatCoverageNotes,
  formatFindingsBySeverity,
  persistCodeReviewFindings,
} from "./findings.js"

export type {
  ExecutionGroupLike,
  CodeReviewFinding,
  CodeReviewFindingsInput,
} from "./findings.js"

// ── Re-export plan-review helpers ──────────────────────────────

export {
  runPlanReview,
  evaluateGating,
  incrementVersion,
  persistPlanReviewFindings,
  synthesiseFindings,
  defaultReviewerRunner,
  isRequiredReviewer,
  runReviewerWithRetry,
} from "./plan-review.js"

export type {
  PlanReviewInput,
  PlanReviewResult,
  Finding,
  ReviewerOutput,
  ReviewerContext,
  ReviewerRunner,
  RetryPolicy,
} from "./plan-review.js"

export type {
  ReviewerManifest,
  ReviewerMode,
} from "pi-zflow-review"

// ── Public manifest factory ────────────────────────────────────

/**
 * Create a reviewer manifest with the given mode, tier, and optional
 * custom reviewer list.
 *
 * When `customReviewers` is provided it overrides the built-in tier
 * mapping entirely, giving the caller full control over which
 * reviewers to include.
 *
 * When `customReviewers` is omitted, the manifest is built from the
 * built-in tier→reviewer mapping for the given mode.
 *
 * @param mode - Review mode (`"plan-review"` or `"code-review"`).
 * @param tier - Review tier (e.g. `"standard"`, `"+logic"`, `"system"`).
 * @param customReviewers - Optional. Override the default reviewer list.
 * @returns A new ReviewerManifest with all reviewers in `"requested"` state.
 * @throws If `customReviewers` is omitted and the tier is unknown for `mode`.
 */
export function createReviewManifest(
  mode: ReviewerMode,
  tier: string,
  customReviewers?: string[],
): ReviewerManifest {
  const reviewers = customReviewers ?? resolveReviewerNames(mode, tier)
  return createManifest(mode, tier, reviewers)
}

// ── Internal helpers ───────────────────────────────────────────

/**
 * Resolve the reviewer names for a given mode and tier using the
 * built-in mappings.
 *
 * @throws If the tier is unknown for the given mode.
 */
import {
  getReviewerNamesForPlanTier,
  getReviewerNamesForCodeTier,
} from "./findings.js"

function resolveReviewerNames(mode: ReviewerMode, tier: string): string[] {
  if (mode === "plan-review") {
    return getReviewerNamesForPlanTier(tier)
  }
  return getReviewerNamesForCodeTier(tier)
}

// ── Extension activation ───────────────────────────────────────

export default function activateZflowReviewExtension(pi: ExtensionAPI): void {
  // Registration logic will be added in later Phase 6 tasks.
  // This function will:
  //   1. Claim "review" via getZflowRegistry()
  //   2. Provide review service with manifest/primitives
  //   3. Register /zflow-review-code and /zflow-review-pr commands
}
