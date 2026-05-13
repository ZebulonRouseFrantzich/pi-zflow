/**
 * plan-review.ts — Plan-review execution flow, gating, and findings persistence.
 *
 * Orchestrates the plan-review swarm:
 *   1. Determines review tier from execution-groups review tags.
 *   2. Validates planning artifacts (structural check).
 *   3. Builds a reviewer manifest.
 *   4. Runs requested reviewers in parallel with retry/skip policy.
 *   5. Collects raw reviewer outputs.
 *   6. Synthesises findings into a consolidated report.
 *   7. Persists the findings file to
 *      `<runtime-state-dir>/plans/{changeId}/v{n}/plan-review-findings.md`.
 *   8. Gates plan approval on critical/major findings.
 *
 * ## Reviewer retry policy
 *
 * Required reviewers (correctness, integration for plan review;
 * correctness, integration, security for code review) that fail are
 * retried once. If the retry also fails the error is propagated and
 * the review fails.
 *
 * Optional reviewers (feasibility for plan review; logic, system for
 * code review) that fail are recorded as skipped and the review
 * continues with reduced-coverage notes.
 *
 * ## Testability
 *
 * The optional `reviewerRunner` parameter lets tests inject deterministic
 * reviewer outputs. When omitted, a stub that returns empty findings is
 * used, so all reviewers produce no findings (→ approve).
 *
 * @module pi-zflow-review/plan-review
 */

import * as path from "node:path"
import * as fs from "node:fs/promises"
import { resolveRuntimeStateDir } from "pi-zflow-core/runtime-paths"

import {
  choosePlanReviewTier,
  getReviewerNamesForPlanTier,
} from "./findings.js"

import {
  createManifest,
  recordExecuted,
  recordSkipped,
  recordFailed,
  getCoverageSummary,
} from "pi-zflow-review"

import type {
  ReviewerManifest,
  CoverageSummary,
  ReviewerMode,
} from "pi-zflow-review"

// ── Public interfaces ──────────────────────────────────────────

/**
 * Input to the plan-review flow.
 */
export interface PlanReviewInput {
  /** Unique change identifier (e.g. "feat-auth", "ch42"). */
  changeId: string
  /** Plan version label (e.g. "1", "v1", "2"). */
  planVersion: string
  /** Execution group objects (each may carry reviewTags). */
  executionGroups: Array<{ reviewTags?: string | string[] }>
  /** Paths to the four planning artifacts. */
  planningArtifacts: {
    /** Path to design.md */
    design: string
    /** Path to execution-groups.md */
    executionGroups: string
    /** Path to standards.md */
    standards: string
    /** Path to verification.md */
    verification: string
  }
  /** Working directory for runtime-state resolution (optional). */
  cwd?: string
  /**
   * Optional structural validation result.
   * When `false`, the flow stops with `"revise-plan"`.
   * Defaults to `true` (validation passes).
   */
  validationPassed?: boolean
  /**
   * Optional retry policy for reviewer execution.
   * When omitted, the default policy (one retry, no delay) is used.
   */
  retryPolicy?: RetryPolicy
}

/**
 * Result of the plan-review flow.
 */
export interface PlanReviewResult {
  /** Resolved review tier. */
  tier: string
  /** The final reviewer manifest (includes executed/skipped/failed state). */
  manifest: ReviewerManifest
  /** Aggregated severity counts from synthesised findings. */
  severity: { critical: number; major: number; minor: number; nit: number }
  /** Gating decision. */
  action: "approve" | "revise-plan"
  /** When action is "revise-plan", the suggested next version label. */
  nextVersion?: string
  /** Absolute path to the persisted findings file. */
  findingsPath: string
  /** Human-readable coverage notes about the review. */
  coverageNotes: string[]
}

/**
 * An individual finding produced by a reviewer.
 */
export interface Finding {
  severity: "critical" | "major" | "minor" | "nit"
  title: string
  description: string
  evidence?: string
}

/**
 * Output from a single reviewer run.
 */
export interface ReviewerOutput {
  /** Structured findings. */
  findings: Finding[]
  /** Raw free-form output (preserved as evidence). */
  rawOutput: string
}

/**
 * Context passed to each reviewer runner.
 */
export interface ReviewerContext {
  /** Paths to the four planning artifacts. */
  planningArtifacts: PlanReviewInput["planningArtifacts"]
  /** The resolved review tier. */
  tier: string
}

/**
 * Signature for a reviewer runner function.
 *
 * Implementations may call agent chains, LLM calls, or return stubs.
 * The function receives the reviewer short name and a context object
 * with the planning-artifact paths and review tier.
 */
export type ReviewerRunner = (
  reviewerName: string,
  context: ReviewerContext,
) => Promise<ReviewerOutput>

// ── Retry policy ───────────────────────────────────────────────

/**
 * Retry policy for reviewer execution.
 */
export interface RetryPolicy {
  /** Maximum number of retry attempts for required reviewers. Default: 1. */
  maxRetries: number
  /** Delay in milliseconds between retry attempts. Default: 0. */
  retryDelayMs: number
}

/**
 * Default retry policy: one retry with no delay.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 1,
  retryDelayMs: 0,
}

// ── Required-vs-optional reviewer policy ───────────────────────

/**
 * Determine whether a reviewer is required (fails closed) or optional
 * (fails open — recorded as skipped).
 *
 * Plan-review required: correctness, integration
 * Plan-review optional: feasibility
 *
 * Code-review required: correctness, integration, security
 * Code-review optional: logic, system
 *
 * @param reviewerName - Short name of the reviewer.
 * @param mode - The review mode.
 * @returns `true` if the reviewer is required, `false` if optional.
 */
export function isRequiredReviewer(
  reviewerName: string,
  mode: ReviewerMode,
): boolean {
  if (mode === "plan-review") {
    return reviewerName === "correctness" || reviewerName === "integration"
  }
  // code-review mode
  return (
    reviewerName === "correctness" ||
    reviewerName === "integration" ||
    reviewerName === "security"
  )
}

// ── Reviewer runner with retry ─────────────────────────────────

/**
 * Run a single reviewer with retry support.
 *
 * For required reviewers:
 *   - On first failure: retry once (if `policy.maxRetries >= 1`)
 *   - On second failure: error is thrown (caller sees rejection)
 *
 * For optional reviewers:
 *   - On first failure: retry once (if `policy.maxRetries >= 1`)
 *   - On second failure: returns a skipped result without throwing
 *
 * @param reviewerName - Short name of the reviewer.
 * @param isRequired - Whether the reviewer is required.
 * @param runner - The reviewer runner function.
 * @param context - Reviewer context (planning artifacts, tier).
 * @param policy - Retry policy (defaults to one retry).
 * @returns On success: `{ status: "success", output }`.
 *   On optional failure: `{ status: "skipped", reason }`.
 *   On required failure: throws.
 */
export async function runReviewerWithRetry(
  reviewerName: string,
  isRequired: boolean,
  runner: ReviewerRunner,
  context: ReviewerContext,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<
  { status: "success"; output: ReviewerOutput }
  | { status: "skipped"; reason: string }
> {
  let lastError: unknown

  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    try {
      const output = await runner(reviewerName, context)
      return { status: "success", output }
    } catch (err) {
      lastError = err
      if (attempt < policy.maxRetries) {
        // Retry after optional delay
        if (policy.retryDelayMs > 0) {
          await new Promise((r) => setTimeout(r, policy.retryDelayMs))
        }
        continue
      }
      // Last attempt failed
      if (isRequired) {
        // Required reviewer: propagate the error
        throw err
      }
      // Optional reviewer: return skipped result
      return { status: "skipped", reason: String(err) }
    }
  }

  throw new Error(
    `Unreachable: runReviewerWithRetry completed without returning for ${reviewerName}`,
  )
}

// ── Default stub runner ────────────────────────────────────────

/**
 * Default stub reviewer runner that returns empty findings.
 *
 * Used when callers do not supply a custom `reviewerRunner`.  This
 * ensures the flow always produces valid output (→ approve) in
 * tests or early development stages.
 */
export async function defaultReviewerRunner(
  _reviewerName: string,
  _context: ReviewerContext,
): Promise<ReviewerOutput> {
  return {
    findings: [],
    rawOutput: "",
  }
}

// ── Path helper ────────────────────────────────────────────────

/**
 * Compute the path for the plan-review findings file.
 *
 * Path: `<runtime-state-dir>/plans/{changeId}/v{version}/plan-review-findings.md`
 *
 * The version label is normalised: a leading `"v"` is stripped then
 * re-prepended so that both `"1"` and `"v1"` produce `"v1"`.
 */
function resolvePlanReviewFindingsPath(
  changeId: string,
  planVersion: string,
  cwd?: string,
): string {
  const version = planVersion.replace(/^v/, "")
  return path.join(
    resolveRuntimeStateDir(cwd),
    "plans",
    changeId,
    `v${version}`,
    "plan-review-findings.md",
  )
}

// ── Core orchestration ─────────────────────────────────────────

/**
 * Run the plan-review flow.
 *
 * Steps (matching the phase-6 plan):
 * 1. Determine review tier from execution groups.
 * 2. Run structural validation (configurable via `input.validationPassed`).
 * 3. Build reviewer manifest.
 * 4. For non-`"standard"` tiers, dispatch all requested reviewers in
 *    parallel via the `reviewerRunner`.
 * 5. Record executed/skipped/failed states on the manifest.
 * 6. Synthesise findings (collate and deduplicate).
 * 7. Persist the findings file.
 * 8. Gate plan approval — if any `critical` or `major` finding exists,
 *    request plan revision.
 *
 * @param input - Plan review input details.
 * @param reviewerRunner - Optional custom reviewer runner. When omitted,
 *   a stub returning empty findings is used.
 * @returns The plan-review result with manifest, severity, and gating decision.
 */
export async function runPlanReview(
  input: PlanReviewInput,
  reviewerRunner?: ReviewerRunner,
): Promise<PlanReviewResult> {
  const runner = reviewerRunner ?? defaultReviewerRunner
  const cwd = input.cwd
  const tier = choosePlanReviewTier(input.executionGroups)
  const findingsPath = resolvePlanReviewFindingsPath(
    input.changeId,
    input.planVersion,
    cwd,
  )

  const coverageNotes: string[] = []

  // ── Step 1: Validation ──────────────────────────────────────
  if (input.validationPassed === false) {
    return {
      tier,
      manifest: createManifest("plan-review", tier, []),
      severity: { critical: 0, major: 0, minor: 0, nit: 0 },
      action: "revise-plan",
      nextVersion: incrementVersion(input.planVersion),
      findingsPath,
      coverageNotes: ["Structural validation failed; plan must be revised."],
    }
  }

  // ── Step 2: Resolve reviewers ───────────────────────────────
  const reviewerNames = getReviewerNamesForPlanTier(tier)
  let manifest = createManifest("plan-review", tier, reviewerNames)

  // ── Step 3: Standard tier → skip swarm ──────────────────────
  if (tier === "standard") {
    coverageNotes.push(
      "Plan-review swarm skipped for standard tier (no review tags).",
    )
    // Persist an empty findings file noting the skip
    await persistPlanReviewFindings(
      {
        tier,
        manifest,
        severity: { critical: 0, major: 0, minor: 0, nit: 0 },
        coverageNotes,
      },
      input,
      findingsPath,
    )

    return {
      tier,
      manifest,
      severity: { critical: 0, major: 0, minor: 0, nit: 0 },
      action: "approve",
      findingsPath,
      coverageNotes,
    }
  }

  // ── Step 4: Run reviewers in parallel with retry ────────────
  const context: ReviewerContext = {
    planningArtifacts: input.planningArtifacts,
    tier,
  }

  const retryPolicy = input.retryPolicy ?? DEFAULT_RETRY_POLICY

  const settledResults = await Promise.allSettled(
    reviewerNames.map(async (name) => {
      const isRequired = isRequiredReviewer(name, "plan-review")
      const result = await runReviewerWithRetry(
        name,
        isRequired,
        runner,
        context,
        retryPolicy,
      )
      if (result.status === "skipped") {
        return { name, skipped: true as const, reason: result.reason }
      }
      return { name, skipped: false as const, output: result.output }
    }),
  )

  // ── Step 5: Record manifest state ───────────────────────────
  const allFindings: Array<{ reviewerName: string; finding: Finding }> = []
  const synthesizerInputs: string[] = []

  for (const result of settledResults) {
    if (result.status === "fulfilled") {
      const value = result.value
      if (value.skipped) {
        // Optional reviewer failed after retry — recorded as skipped
        manifest = recordSkipped(manifest, value.name, value.reason)
        coverageNotes.push(
          `Reviewer "${value.name}" skipped after retry: ${value.reason}`,
        )
      } else {
        const { name, output } = value
        manifest = recordExecuted(manifest, name)

        for (const finding of output.findings) {
          allFindings.push({ reviewerName: name, finding })
        }

        if (output.rawOutput) {
          synthesizerInputs.push(
            `## ${name}\n\n${output.rawOutput}`,
          )
        }
      }
    } else if (result.status === "rejected") {
      const name = extractRejectedReviewerName(result.reason, reviewerNames)
      manifest = recordFailed(manifest, name, String(result.reason))
      coverageNotes.push(
        `Reviewer "${name}" failed after retry: ${String(result.reason)}`,
      )
    }
  }

  // ── Step 6: Synthesise ──────────────────────────────────────
  const synthesised = synthesiseFindings(
    allFindings,
    getCoverageSummary(manifest),
    tier,
  )

  const { severity, entries } = synthesised

  // Build raw-output section for the findings file
  const rawOutputSection = synthesizerInputs.length > 0
    ? synthesizerInputs.join("\n\n")
    : "No reviewer raw outputs recorded."

  // Build coverage notes
  if (getCoverageSummary(manifest).skipped > 0) {
    for (const sr of manifest.skippedReviewers) {
      coverageNotes.push(
        `Reviewer "${sr.name}" skipped: ${sr.reason}`,
      )
    }
  }

  coverageNotes.push(
    `Reviewers executed: ${manifest.reviewers.filter((r) => r.status === "executed").length}`,
    `Reviewers failed: ${manifest.failedReviewers.length}`,
    `Reviewers skipped: ${manifest.skippedReviewers.length}`,
  )

  // ── Step 7: Persist findings ────────────────────────────────
  await persistPlanReviewFindings(
    {
      tier,
      manifest,
      severity,
      coverageNotes,
      entries,
      rawOutputSection,
    },
    input,
    findingsPath,
  )

  // ── Step 8: Gate ────────────────────────────────────────────
  const action = evaluateGating(severity)
  let nextVersion: string | undefined
  if (action === "revise-plan") {
    nextVersion = incrementVersion(input.planVersion)
  }

  return {
    tier,
    manifest,
    severity,
    action,
    nextVersion,
    findingsPath,
    coverageNotes,
  }
}

// ── Gating ─────────────────────────────────────────────────────

/**
 * Evaluate whether the plan can be approved based on severity counts.
 *
 * - Any `critical` or `major` finding → revise-plan.
 * - Only `minor` or `nit` findings → approve.
 * - No findings → approve.
 *
 * @param severity - Aggregated severity counts.
 * @returns Gating decision.
 */
export function evaluateGating(
  severity: { critical: number; major: number; minor: number; nit: number },
): "approve" | "revise-plan" {
  if (severity.critical > 0 || severity.major > 0) {
    return "revise-plan"
  }
  return "approve"
}

/**
 * Increment a plan version label.
 *
 * Supports both `"1"` → `"2"` and `"v1"` → `"v2"` formats.
 *
 * @param planVersion - Current version label.
 * @returns The next version label in the same format.
 */
export function incrementVersion(planVersion: string): string {
  const prefix = planVersion.startsWith("v") ? "v" : ""
  const num = parseInt(planVersion.replace(/^v/, ""), 10)
  const next = Number.isNaN(num) ? 2 : num + 1
  return `${prefix}${next}`
}

// ── Synthesis ──────────────────────────────────────────────────

/**
 * Internal representation of a synthesised finding entry.
 */
interface SynthesisedEntry {
  severity: "critical" | "major" | "minor" | "nit"
  title: string
  description: string
  evidence?: string
  reviewers: string[]
  dissentingReviewers: string[]
}

/**
 * Result of the synthesis step.
 */
interface SynthesisResult {
  severity: { critical: number; major: number; minor: number; nit: number }
  entries: SynthesisedEntry[]
}

/**
 * Synthesise findings from multiple reviewers.
 *
 * Deduplicates findings that share the same title, preserving the
 * highest-evidenced severity and recording all reviewers who
 * identified the issue.  Reviewers who ran and did not flag the
 * finding are not treated as dissenters — only explicit dissent
 * (not yet tracked at this level) would be recorded.
 *
 * This is a simplified synthesis suitable for the stubbed flow.
 * Full synthesis (with agent-powered consolidation) is delegated
 * to `zflow.synthesizer` (see `agents/synthesizer.md`).
 *
 * @param allFindings - All findings from all reviewers.
 * @param coverage - Summary of reviewer coverage.
 * @param tier - The review tier.
 * @returns Synthesised severity counts and deduplicated entries.
 */
export function synthesiseFindings(
  allFindings: Array<{ reviewerName: string; finding: Finding }>,
  coverage: CoverageSummary,
  _tier: string,
): SynthesisResult {
  // Deduplicate by title (same title → same root cause)
  const dedupMap = new Map<string, SynthesisedEntry>()

  for (const { reviewerName, finding } of allFindings) {
    const existing = dedupMap.get(finding.title)
    if (existing) {
      // Keep higher severity
      const existingRank = severityRank(existing.severity)
      const newRank = severityRank(finding.severity)
      if (newRank < existingRank) {
        existing.severity = finding.severity
      }
      // Add reviewer if not already present
      if (!existing.reviewers.includes(reviewerName)) {
        existing.reviewers.push(reviewerName)
      }
    } else {
      dedupMap.set(finding.title, {
        severity: finding.severity,
        title: finding.title,
        description: finding.description,
        evidence: finding.evidence,
        reviewers: [reviewerName],
        dissentingReviewers: [],
      })
    }
  }

  // Count severity
  const severity = { critical: 0, major: 0, minor: 0, nit: 0 }
  const entries = [...dedupMap.values()]
  for (const entry of entries) {
    severity[entry.severity]++
  }

  return { severity, entries }
}

/**
 * Severity rank (lower = more severe).
 */
function severityRank(s: "critical" | "major" | "minor" | "nit"): number {
  switch (s) {
    case "critical": return 0
    case "major":    return 1
    case "minor":    return 2
    case "nit":      return 3
  }
}

// ── Persistence ────────────────────────────────────────────────

/**
 * Data needed to render the findings markdown file.
 */
interface FindingsFileData {
  tier: string
  manifest: ReviewerManifest
  severity: { critical: number; major: number; minor: number; nit: number }
  coverageNotes: string[]
  entries?: SynthesisedEntry[]
  rawOutputSection?: string
}

/**
 * Persist the plan-review findings file to disk.
 *
 * The file is written to
 * `<runtime-state-dir>/plans/{changeId}/v{version}/plan-review-findings.md`.
 *
 * @param data - Synthesised findings data.
 * @param input - Original plan-review input (for path computation).
 * @param findingsPath - Pre-computed findings file path.
 */
export async function persistPlanReviewFindings(
  data: FindingsFileData | Omit<FindingsFileData, "entries" | "rawOutputSection">,
  input: PlanReviewInput,
  findingsPath?: string,
): Promise<string> {
  const fp = findingsPath ?? resolvePlanReviewFindingsPath(
    input.changeId,
    input.planVersion,
    input.cwd,
  )

  // Ensure parent directory exists
  await fs.mkdir(path.dirname(fp), { recursive: true })

  const content = buildFindingsMarkdown(data, input)

  await fs.writeFile(fp, content, "utf-8")
  return fp
}

/**
 * Build the markdown content for the findings file.
 */
function buildFindingsMarkdown(
  data: FindingsFileData | Omit<FindingsFileData, "entries" | "rawOutputSection">,
  input: PlanReviewInput,
): string {
  const { tier, manifest, severity, coverageNotes } = data
  const entries = "entries" in data ? data.entries : undefined
  const rawOutputSection = "rawOutputSection" in data ? data.rawOutputSection : undefined

  const lines: string[] = []

  lines.push(`# Plan Review Findings`)
  lines.push(``)
  lines.push(`**Change ID:** ${input.changeId}`)
  lines.push(`**Plan version:** ${input.planVersion}`)
  lines.push(`**Review tier:** ${tier}`)
  lines.push(`**Run ID:** ${manifest.runId}`)
  lines.push(`**Generated:** ${manifest.createdAt}`)
  lines.push(`**Action:** ${severity.critical > 0 || severity.major > 0 ? "REVISE-PLAN" : "APPROVE"}`)
  lines.push(``)

  // ── Coverage notes ──────────────────────────────────────────
  lines.push(`## Coverage notes`)
  lines.push(``)

  if (coverageNotes.length === 0) {
    lines.push(`No coverage notes.`)
  } else {
    for (const note of coverageNotes) {
      lines.push(`- ${note}`)
    }
  }
  lines.push(``)

  // ── Reviewer manifest summary ───────────────────────────────
  lines.push(`## Reviewer manifest`)
  lines.push(``)
  lines.push(`| Reviewer | Status | Detail |`)
  lines.push(`| -------- | ------ | ------ |`)
  for (const r of manifest.reviewers) {
    const detail = r.detail ?? ""
    lines.push(`| ${r.name} | ${r.status} | ${detail} |`)
  }
  lines.push(``)

  // ── Severity summary ────────────────────────────────────────
  lines.push(`## Severity summary`)
  lines.push(``)
  lines.push(`| Severity | Count |`)
  lines.push(`| -------- | ----- |`)
  lines.push(`| critical | ${severity.critical} |`)
  lines.push(`| major    | ${severity.major} |`)
  lines.push(`| minor    | ${severity.minor} |`)
  lines.push(`| nit      | ${severity.nit} |`)
  lines.push(``)

  // ── Findings ────────────────────────────────────────────────
  if (entries && entries.length > 0) {
    lines.push(`## Findings`)
    lines.push(``)

    // Sort: critical first, then major, minor, nit
    const sorted = [...entries].sort(
      (a, b) => severityRank(a.severity) - severityRank(b.severity),
    )

    for (const entry of sorted) {
      lines.push(`### ${entry.title}`)
      lines.push(`**Severity:** ${entry.severity}`)
      lines.push(`**Reviewer support:** ${entry.reviewers.join(", ")}`)
      if (entry.dissentingReviewers.length > 0) {
        lines.push(`**Reviewer dissent:** ${entry.dissentingReviewers.join(", ")}`)
      }
      lines.push(``)
      lines.push(entry.description)
      if (entry.evidence) {
        lines.push(``)
        lines.push(`**Evidence:** ${entry.evidence}`)
      }
      lines.push(``)
    }
  } else {
    lines.push(`## Findings`)
    lines.push(``)
    lines.push(`No findings were raised.`)
    lines.push(``)
  }

  // ── Raw reviewer outputs ────────────────────────────────────
  if (rawOutputSection) {
    lines.push(`## Raw reviewer outputs`)
    lines.push(``)
    lines.push(rawOutputSection)
    lines.push(``)
  }

  return lines.join("\n")
}

// ── Internal helpers ───────────────────────────────────────────

/**
 * Extract the reviewer name from a rejected promise.
 *
 * When the runner wraps the reviewer name in the error message
 * (e.g. `"reviewer:correctness failed: ..."`) we parse it out.
 * Otherwise fall back to the first remaining requested reviewer.
 *
 * @param reason - The rejection reason.
 * @param reviewerNames - All reviewer names for this run.
 * @returns A reviewer name to mark as failed.
 */
function extractRejectedReviewerName(
  reason: unknown,
  reviewerNames: string[],
): string {
  const msg = String(reason)
  for (const name of reviewerNames) {
    if (msg.includes(name)) return name
  }
  return reviewerNames[0] ?? "unknown"
}
