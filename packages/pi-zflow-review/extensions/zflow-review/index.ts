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
import { parsePrUrl, validatePrUrl, checkAuthStatus, fetchPrDiff, checkSubmissionCapability } from "./pr.js"

import type { ResolvedPrTarget } from "./pr.js"
import type { CodeReviewInput, PrReviewInput } from "./orchestration.js"

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
  countDiffLines,
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
    description: "Review local changes against planning documents. Usage: /zflow-review-code [change-id] or /zflow-review-code [status]",
    handler: async (args: string, ctx: {
      ui: { notify: (message: string, type?: "info" | "warning" | "error") => void }
    }): Promise<void> => {
      const cwd = process.cwd()

      // Resolve repo root
      let repoRoot: string
      try {
        const { execSync } = await import("node:child_process")
        repoRoot = execSync("git rev-parse --show-toplevel", {
          cwd,
          encoding: "utf-8",
          timeout: 5_000,
        }).trim()
      } catch {
        ctx.ui.notify("Not a git repository — cannot determine repo root", "error")
        return
      }

      // Parse args: known status word or changeId
      const arg = args.trim().toLowerCase()
      const knownStatuses = ["passed", "failed", "skipped", "advisory", "unknown"] as const
      let verificationStatus: "passed" | "failed" | "skipped" | "unknown"
      let changeId: string

      if (knownStatuses.includes(arg as typeof knownStatuses[number])) {
        verificationStatus = arg === "advisory" ? "skipped" : (arg as "passed" | "failed" | "skipped" | "unknown")
        // No explicit changeId — derive from current directory name
        changeId = cwd.split("/").filter(Boolean).pop() ?? ""
      } else if (arg && arg.length > 0) {
        // Arg is neither empty nor a known status — treat as changeId
        changeId = arg
        verificationStatus = "unknown"
      } else {
        // No args at all
        changeId = cwd.split("/").filter(Boolean).pop() ?? ""
        verificationStatus = "unknown"
      }

      // Resolve planning artifact paths
      const { resolvePlanArtifactPath } = await import("pi-zflow-artifacts/artifact-paths")
      const { existsSync } = await import("node:fs")
      const { default: path } = await import("node:path")

      const planVersion = "v1"
      const artifactKeys = ["design", "executionGroups", "standards", "verification"] as const
      const planArtifactPaths: Record<string, string> = {
        design: "",
        executionGroups: "",
        standards: "",
        verification: "",
      }

      let hasAnyPlanArtifact = false
      const missing: string[] = []

      for (const key of artifactKeys) {
        const resolvedPath = resolvePlanArtifactPath(changeId, planVersion, key, cwd)
        planArtifactPaths[key] = resolvedPath
        if (existsSync(resolvedPath)) {
          hasAnyPlanArtifact = true
        } else {
          missing.push(key)
        }
      }

      if (!hasAnyPlanArtifact) {
        // Fallback: try without version (flat plan dir)
        const flatKeys: Record<string, string> = {
          design: "design.md",
          executionGroups: "execution-groups.md",
          standards: "standards.md",
          verification: "verification.md",
        }
        const { resolveRuntimeStateDir } = await import("pi-zflow-core/runtime-paths")
        const runtimeStateDir = resolveRuntimeStateDir(cwd)
        let foundFlat = false
        for (const [key, fileName] of Object.entries(flatKeys)) {
          const flatPath = path.join(runtimeStateDir, "plans", changeId, fileName)
          if (existsSync(flatPath)) {
            planArtifactPaths[key] = flatPath
            foundFlat = true
          }
        }
        if (foundFlat) {
          ctx.ui.notify(
            `ℹ️ Found plan artifacts in flat layout for change "${changeId}".`,
            "info",
          )
        } else {
          ctx.ui.notify(
            `ℹ️ No plan artifacts found for change "${changeId}". ` +
            "Code review will run with limited planning context (diff-only). " +
            "Pass a change-id argument to /zflow-review-code <change-id> to include planning docs.",
            "info",
          )
        }
      }

      // Resolve current branch name
      let branch = "(unknown)"
      try {
        const { execSync } = await import("node:child_process")
        branch = execSync("git rev-parse --abbrev-ref HEAD", {
          cwd,
          encoding: "utf-8",
          timeout: 5_000,
        }).trim()
      } catch { /* non-fatal */ }

      try {
        const input: CodeReviewInput = {
          source: `Manual code review via /zflow-review-code (change: ${changeId})`,
          repoPath: repoRoot,
          branch,
          planningArtifacts: {
            design: planArtifactPaths.design,
            executionGroups: planArtifactPaths.executionGroups,
            standards: planArtifactPaths.standards,
            verification: planArtifactPaths.verification,
          },
          verificationStatus,
          cwd,
        }

        const result = await reviewService.runCodeReview(input)
        ctx.ui.notify(
          `Code review complete.\n` +
          `Tier: ${result.tier}\n` +
          `Recommendation: ${result.recommendation}\n` +
          `Findings: ${result.severity.critical} critical, ${result.severity.major} major\n` +
          `Path: ${result.findingsPath}`,
        )
      } catch (err: unknown) {
        ctx.ui.notify(
          `Code review failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        )
      }
    },
  })

  pi.registerCommand("zflow-review-pr", {
    description: "Review an external GitHub PR or GitLab MR",
    handler: async (args: string, ctx: {
      ui: { notify: (message: string, type?: "info" | "warning" | "error") => void }
      cwd?: string
    }): Promise<void> => {
      const url = args.trim()
      if (!url) {
        ctx.ui.notify(
          "Usage: /zflow-review-pr <pr-url>\n" +
          "Example: /zflow-review-pr https://github.com/owner/repo/pull/42",
          "warning",
        )
        return
      }

      const cwd = ctx.cwd ?? process.cwd()

      // Parse URL
      let target: ResolvedPrTarget
      try {
        target = parsePrUrl(url)
      } catch (err: unknown) {
        ctx.ui.notify(
          `Invalid PR URL: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        )
        return
      }

      ctx.ui.notify(`Parsed ${target.platform} PR/MR: ${target.owner}/${target.repo}#${target.number}`)

      // Check auth
      ctx.ui.notify(`Checking authentication for ${target.platform}...`)
      const authStatus = await checkAuthStatus(target.platform)
      if (!authStatus.authenticated) {
        ctx.ui.notify(
          `Auth not available for ${target.platform}: ${authStatus.error ?? "unknown error"}\n` +
          `Install the CLI tool and authenticate first.\n` +
          `Example: \`${target.platform === "github" ? "gh" : "glab"} auth login\``,
          "warning",
        )
        return
      }

      // Check submission capability
      const submission = await checkSubmissionCapability(target.platform)

      if (submission.canSubmit) {
        ctx.ui.notify(`Authenticated as ${authStatus.username ?? "(unknown)"} — inline comment submission available`)
      } else {
        ctx.ui.notify(submission.fallbackMessage ?? "Inline comment submission not available")
      }

      // Fetch PR data
      ctx.ui.notify(`Fetching PR data from ${target.platform}...`)
      try {
        const fetchResult = await fetchPrDiff(target)

        ctx.ui.notify(
          `Fetched ${fetchResult.files.length} changed files: ` +
          `"${fetchResult.metadata.title}"`,
        )

        // Run review
        const input: PrReviewInput = {
          target: {
            platform: target.platform,
            owner: target.owner,
            repo: target.repo,
            number: target.number,
            url,
          },
          metadata: {
            title: fetchResult.metadata.title,
            description: fetchResult.metadata.description,
            state: fetchResult.metadata.state,
            headSha: fetchResult.metadata.headSha,
            baseSha: fetchResult.metadata.baseSha,
          },
          files: fetchResult.files.map((f) => ({
            path: f.path,
            patch: f.patch,
          })),
          submissionAvailable: submission.canSubmit,
          cwd,
        }

        ctx.ui.notify("Running PR review...")
        const result = await reviewService.runPrReview(input)

        ctx.ui.notify(
          `PR review complete.\n` +
          `Findings: ${result.findingsCount}\n` +
          `Chunks: ${result.chunkCount}\n` +
          `Path: ${result.findingsPath}`,
        )
      } catch (err: unknown) {
        ctx.ui.notify(
          `PR review failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        )
      }
    },
  })
}
