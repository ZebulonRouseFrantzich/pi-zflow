/**
 * pi-zflow-review extension entrypoint
 *
 * Registers `zflow-review-code` and `zflow-review-pr <url>` commands.
 * Exports reviewer-manifest creation helpers and findings formatting.
 *
 * ## Registration contract
 *
 * - Claims `"review"` capability via `getZflowRegistry()` (guarded against
 *   duplicate loads).
 * - Provides `"review"` service with manifest creation, tier selection,
 *   review orchestration primitives, and command dispatch.
 * - Registers `zflow-review-code`, `zflow-review-pr <url>` commands.
 * - Does NOT register generic `/review-*` aliases.
 *
 * ## Related modules
 *
 * - `findings.ts` — reviewer-manifest helpers and tier→reviewer mapping
 * - `pr.ts` — PR/MR diff-only fetch and review
 * - `chunking.ts` — large-diff chunking for multi-reviewer dispatch
 * - `orchestration.ts` — end-to-end code-review and PR-review flows
 * - `src/reviewer-manifest.ts` — manifest types and immutable helpers
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { getZflowRegistry, PI_ZFLOW_REVIEW_VERSION } from "pi-zflow-core"
import { parsePrUrl, validatePrUrl } from "./pr.js"

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
  chooseCodeReviewTier,
  formatSeveritySummary,
  formatCoverageNotes,
  formatFindingsBySeverity,
  persistCodeReviewFindings,
  resolveReviewerArtifactDir,
  persistReviewerRawOutput,
  resolveAllReviewerArtifacts,
  loadReviewerRawOutput,
  addFindingTraceability,
  persistPrReviewFindings,
} from "./findings.js"

export type {
  ExecutionGroupLike,
  CodeReviewTierContext,
  CodeReviewFinding,
  CodeReviewFindingsInput,
  PrReviewFinding,
  PrReviewFindingsInput,
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
  SynthesiserRunner,
} from "./plan-review.js"

// ── Re-export review-context helpers ──────────────────────────

export {
  buildInternalReviewPrompt,
  buildExternalReviewPrompt,
  getVerificationStatusReminder,
  getPlanAdherenceInstruction,
} from "./review-context.js"

export type {
  InternalReviewContext,
  ExternalReviewContext,
  ReviewDiffChunk,
} from "./review-context.js"

// ── Re-export synthesizer helpers ─────────────────────────────

export {
  getWeightingGuidance,
  prepareSynthesisInput,
  formatSynthesisPrompt,
  evaluateRecommendation,
  buildSynthesisResult,
} from "./synthesizer.js"

export type {
  SynthesisInput,
  SynthesisReviewerOutput,
  WeightingGuidance,
  SynthesisResult,
} from "./synthesizer.js"

// ── Re-export diff-baseline helpers ──────────────────────────

export {
  resolveDiffBaseline,
  buildDiffCommand,
  parseDiffBaselineOverride,
} from "./diff-baseline.js"

export type {
  DiffBaselineInput,
  ResolvedBaseline,
} from "./diff-baseline.js"

// ── Re-export PR/MR helpers ──────────────────────────────────

export {
  parsePrUrl,
  detectHost,
  buildPrApiCommands,
  validatePrUrl,
  buildFetchCommands,
  parsePrMetadataResponse,
  parsePrFilesResponse,
  combineDiffContent,
  fetchPrDiff,
  fetchAllPrFiles,
  defaultCommandRunner,
  checkAuthStatus,
  checkSubmissionCapability,
  buildSubmitCommentCommand,
  formatAuthSkipMessage,
} from "./pr.js"

export type {
  PrPlatform,
  ResolvedPrTarget,
  PrApiCommands,
  PrUrlValidation,
  PrMetadata,
  PrFile,
  PrFetchResult,
  CommandRunner,
  AuthStatus,
  SubmissionCapability,
  SubmitCommentInput,
} from "./pr.js"

// ── Re-export chunking helpers ───────────────────────────────

export {
  chunkDiff,
  buildLineMap,
  parsePatchLineNumbers,
  parseAllHunkLineNumbers,
  estimateChunkSize,
  mergeChunkFindings,
  resetChunkCounter,
} from "./chunking.js"

export type {
  ChunkingOptions,
  DiffChunk,
  ChunkingResult,
  ChunkFinding,
  ChunkResult,
  PatchLineNumbers,
} from "./chunking.js"

// ── Re-export triage helpers ──────────────────────────────────

export {
  getDefaultAction,
  buildTriageQuestions,
  processTriageResponses,
  formatTriageSummary,
} from "./triage.js"

export type {
  TriageAction,
  TriageResult,
  TriageQuestion,
} from "./triage.js"

// ── Re-export orchestration helpers ───────────────────────────

export {
  runCodeReview,
  runPrReview,
} from "./orchestration.js"

export type {
  CodeReviewInput,
  CodeReviewResult,
  PrReviewInput,
  PrReviewResult,
} from "./orchestration.js"

// ── Public manifest factory ────────────────────────────────────

/**
 * Create a reviewer manifest with the given mode, tier, and optional
 * custom reviewer list.
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

// ── Review service interface ───────────────────────────────────

export interface ReviewService {
  createReviewManifest: typeof createReviewManifest
  runPlanReview: (...args: Parameters<typeof import("./plan-review.js").runPlanReview>) => Promise<Awaited<ReturnType<typeof import("./plan-review.js").runPlanReview>>>
  runCodeReview: (...args: Parameters<typeof import("./orchestration.js").runCodeReview>) => Promise<Awaited<ReturnType<typeof import("./orchestration.js").runCodeReview>>>
  runPrReview: (...args: Parameters<typeof import("./orchestration.js").runPrReview>) => Promise<Awaited<ReturnType<typeof import("./orchestration.js").runPrReview>>>
  parsePrUrl: typeof parsePrUrl
  checkSubmissionCapability: (...args: Parameters<typeof import("./pr.js").checkSubmissionCapability>) => Promise<Awaited<ReturnType<typeof import("./pr.js").checkSubmissionCapability>>>
  validatePrUrl: typeof validatePrUrl
}

// ── Extension activation ───────────────────────────────────────

export default function activateZflowReviewExtension(pi: ExtensionAPI): void {
  const registry = getZflowRegistry()

  const claimed = registry.claim({
    capability: "review",
    version: PI_ZFLOW_REVIEW_VERSION,
    provider: "pi-zflow-review",
    sourcePath: import.meta.url,
  })

  if (!claimed) return

  const reviewService: ReviewService = {
    createReviewManifest,
    runPlanReview: async (...args) =>
      (await import("./plan-review.js")).runPlanReview(...args),
    runCodeReview: async (...args) =>
      (await import("./orchestration.js")).runCodeReview(...args),
    runPrReview: async (...args) =>
      (await import("./orchestration.js")).runPrReview(...args),
    parsePrUrl,
    checkSubmissionCapability: async (...args) =>
      (await import("./pr.js")).checkSubmissionCapability(...args),
    validatePrUrl,
  }
  registry.provide("review", reviewService)

  pi.registerCommand("zflow-review-code", {
    description: "Review local changes against planning documents",
    handler: async (args: string, ctx: {
      ui: { notify: (message: string, type?: "info" | "warning" | "error") => void }
    }): Promise<void> => {
      ctx.ui.notify("Running internal code review...")
    },
  })

  pi.registerCommand("zflow-review-pr", {
    description: "Review an external GitHub PR or GitLab MR",
    handler: async (args: string, ctx: {
      ui: { notify: (message: string, type?: "info" | "warning" | "error") => void }
    }): Promise<void> => {
      const url = args.trim()
      if (!url) {
        ctx.ui.notify(
          "Usage: zflow-review-pr <pr-url>\nExample: zflow-review-pr https://github.com/owner/repo/pull/42",
          "warning",
        )
        return
      }
      try {
        const target = parsePrUrl(url)
        ctx.ui.notify(`Parsed ${target.platform} PR/MR: ${target.owner}/${target.repo}#${target.number}`)
      } catch (err: unknown) {
        ctx.ui.notify(`Invalid PR URL: ${err instanceof Error ? err.message : String(err)}`, "error")
      }
    },
  })
}
