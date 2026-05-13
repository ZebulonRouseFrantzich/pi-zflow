/**
 * synthesizer.ts — Synthesizer input preparation and weighting guidance.
 *
 * Provides structured input formatting for the `zflow.synthesizer` agent
 * so the extension delegates consolidation to the synthesizer rather than
 * implementing bespoke severity-merge code.
 *
 * ## Design rules
 *
 * - The synthesizer is a prompt-based agent, not a deterministic function.
 *   This module prepares the input that the synthesizer agent consumes.
 * - Weighting guidance tells the synthesizer which reviewers' findings
 *   carry more weight in specific domains (algorithm/performance vs.
 *   cross-module/system impact).
 * - Deduplication logic lives in the synthesizer agent prompt, not here.
 *
 * ## Usage
 *
 * ```ts
 * import { prepareSynthesisInput, formatSynthesisPrompt, evaluateRecommendation }
 *   from "pi-zflow-review/synthesizer"
 *
 * const input = prepareSynthesisInput(manifest, reviewerOutputs, "code-review")
 * const prompt = formatSynthesisPrompt(input)
 * const result = evaluateRecommendation({ critical: 0, major: 2, minor: 1, nit: 3 })
 * // "CONDITIONAL-GO"
 * ```
 *
 * @module pi-zflow-review/synthesizer
 */

import type { ReviewerManifest, ReviewerMode } from "pi-zflow-review"

// ── Core interfaces ────────────────────────────────────────────

/**
 * Structured input for the synthesizer agent.
 */
export interface SynthesisInput {
  /** The reviewer manifest showing who ran, who was skipped, who failed. */
  manifest: ReviewerManifest
  /** Raw findings from each reviewer, keyed by reviewer short name. */
  reviewerFindings: Record<string, SynthesisReviewerOutput>
  /** The review mode: "plan-review" or "code-review". */
  mode: "plan-review" | "code-review"
}

/**
 * Findings output from a single reviewer, structured for the synthesizer.
 */
export interface SynthesisReviewerOutput {
  /** Reviewer short name (e.g. "correctness", "logic"). */
  name: string
  /** Whether this reviewer is required or optional. */
  required: boolean
  /** Structured findings from this reviewer. */
  findings: Array<{
    severity: "critical" | "major" | "minor" | "nit"
    title: string
    description: string
    evidence?: string
  }>
  /** Raw free-form text output from the reviewer (preserved as evidence). */
  rawOutput: string
}

/**
 * Weighting guidance for a single reviewer.
 *
 * Tells the synthesizer how much to weigh this reviewer's findings
 * in specific domains. Standard weight is 1.0.
 */
export interface WeightingGuidance {
  /**
   * Weight multiplier for algorithm/performance/complexity findings.
   * Higher values mean this reviewer's opinion carries more weight
   * on algorithmic soundness, state transitions, and performance.
   */
  algorithmWeight: number
  /**
   * Weight multiplier for cross-module/system-level findings.
   * Higher values mean this reviewer's opinion carries more weight
   * on integration, architecture, and system impact.
   */
  systemWeight: number
  /** Human-readable description of this reviewer's specialty focus. */
  focus: string
}

/**
 * Consolidated result from the synthesizer.
 */
export interface SynthesisResult {
  /** Consolidated findings after dedup and weighting. */
  consolidatedFindings: Array<{
    severity: "critical" | "major" | "minor" | "nit"
    title: string
    description: string
    evidence?: string
    /** Reviewers that support/identified this finding. */
    reviewerSupport: string[]
    /** Reviewers that explicitly disagree with this finding. */
    reviewerDissent?: string[]
  }>
  /** Summary counts by severity. */
  severitySummary: {
    critical: number
    major: number
    minor: number
    nit: number
  }
  /** Human-readable coverage notes about the review. */
  coverageNotes: string[]
  /** Go/no-go recommendation. */
  recommendation: "GO" | "NO-GO" | "CONDITIONAL-GO"
}

// ── Weighting guidance lookup ──────────────────────────────────

/**
 * Reviewer weight constants for plan-review mode.
 */
const PLAN_REVIEW_WEIGHTS: Record<string, WeightingGuidance> = {
  correctness: {
    algorithmWeight: 1.0,
    systemWeight: 1.0,
    focus: "Logical correctness, edge cases, and design soundness",
  },
  integration: {
    algorithmWeight: 1.0,
    systemWeight: 1.0,
    focus: "Cross-module impacts, API contracts, and data flow",
  },
  feasibility: {
    algorithmWeight: 0.8,
    systemWeight: 1.2,
    focus: "Practical feasibility, module structure, and effort realism",
  },
}

/**
 * Reviewer weight constants for code-review mode.
 */
const CODE_REVIEW_WEIGHTS: Record<string, WeightingGuidance> = {
  correctness: {
    algorithmWeight: 1.0,
    systemWeight: 1.0,
    focus: "Logic errors, edge cases, type safety, and regressions",
  },
  integration: {
    algorithmWeight: 1.0,
    systemWeight: 1.0,
    focus: "Cross-module coupling, API contracts, and pattern consistency",
  },
  security: {
    algorithmWeight: 1.0,
    systemWeight: 1.0,
    focus: "Injection vectors, auth/authorisation gaps, and secrets exposure",
  },
  logic: {
    algorithmWeight: 1.5,
    systemWeight: 0.8,
    focus: "Algorithmic soundness, state transitions, and performance modelling",
  },
  system: {
    algorithmWeight: 0.8,
    systemWeight: 1.5,
    focus: "System-level concerns: performance, scalability, observability, resilience",
  },
}

/**
 * Return weighting guidance for a reviewer.
 *
 * @param reviewerName - Short name of the reviewer (e.g. "correctness", "logic").
 * @param mode - The review mode.
 * @returns WeightingGuidance with algorithmWeight, systemWeight, and focus.
 */
export function getWeightingGuidance(
  reviewerName: string,
  mode: "plan-review" | "code-review",
): WeightingGuidance {
  const table = mode === "plan-review" ? PLAN_REVIEW_WEIGHTS : CODE_REVIEW_WEIGHTS
  const guidance = table[reviewerName]
  if (!guidance) {
    // Unknown reviewer returns default neutral weights
    return {
      algorithmWeight: 1.0,
      systemWeight: 1.0,
      focus: `General reviewer (${reviewerName})`,
    }
  }
  return guidance
}

// ── Synthesis input preparation ────────────────────────────────

/**
 * Prepare a structured SynthesisInput from raw reviewer results.
 *
 * Maps raw reviewer outputs (keyed by reviewer name) into the structured
 * SynthesisReviewerOutput format, determining required/optional status
 * from the reviewer name and mode.
 *
 * @param manifest - The reviewer manifest (tracks who ran, skipped, failed).
 * @param reviewerOutputs - Raw outputs keyed by reviewer short name.
 * @param mode - The review mode.
 * @returns A SynthesisInput ready for formatting.
 */
export function prepareSynthesisInput(
  manifest: ReviewerManifest,
  reviewerOutputs: Record<string, { findings: SynthesisReviewerOutput["findings"]; rawOutput: string }>,
  mode: "plan-review" | "code-review",
): SynthesisInput {
  const reviewerFindings: Record<string, SynthesisReviewerOutput> = {}

  for (const [name, output] of Object.entries(reviewerOutputs)) {
    const required = isRequiredReviewerSimple(name, mode)
    reviewerFindings[name] = {
      name,
      required,
      findings: output.findings,
      rawOutput: output.rawOutput,
    }
  }

  return {
    manifest,
    reviewerFindings,
    mode,
  }
}

// ── Simple required-reviewer check (avoids circular dep with plan-review.ts) ──

/**
 * Determine whether a reviewer is required or optional for a given mode.
 *
 * Duplicated from plan-review.ts to avoid circular dependency.
 *
 * Plan-review required: correctness, integration
 * Plan-review optional: feasibility
 *
 * Code-review required: correctness, integration, security
 * Code-review optional: logic, system
 */
function isRequiredReviewerSimple(
  reviewerName: string,
  mode: "plan-review" | "code-review",
): boolean {
  if (mode === "plan-review") {
    return reviewerName === "correctness" || reviewerName === "integration"
  }
  return (
    reviewerName === "correctness" ||
    reviewerName === "integration" ||
    reviewerName === "security"
  )
}

// ── Prompt formatting ──────────────────────────────────────────

/**
 * Format a SynthesisInput into a prompt string suitable for the
 * zflow.synthesizer agent.
 *
 * The prompt includes:
 *   - Reviewer manifest summary (who executed, skipped, failed)
 *   - Each reviewer's structured findings with weighting guidance
 *   - Deduplication instructions from the synthesizer agent spec
 *   - Specialty weighting guidance
 *
 * @param input - The prepared synthesis input.
 * @returns A formatted prompt string.
 */
export function formatSynthesisPrompt(input: SynthesisInput): string {
  const { manifest, reviewerFindings, mode } = input
  const lines: string[] = []

  // ── Header ──
  lines.push(`# Synthesis Request — ${mode === "plan-review" ? "Plan Review" : "Code Review"}`)
  lines.push("")
  lines.push(`**Run ID**: ${manifest.runId}`)
  lines.push(`**Tier**: ${manifest.tier}`)
  lines.push(`**Mode**: ${mode}`)
  lines.push("")

  // ── Reviewer manifest summary ──
  lines.push("## Reviewer Manifest")
  lines.push("")
  lines.push("| Reviewer | Status | Detail |")
  lines.push("|----------|--------|--------|")
  for (const reviewer of manifest.reviewers) {
    const detail = reviewer.detail ?? ""
    lines.push(`| ${reviewer.name} | ${reviewer.status} | ${detail} |`)
  }
  if (manifest.skippedReviewers.length > 0) {
    lines.push("")
    lines.push("### Skipped reviewers")
    for (const s of manifest.skippedReviewers) {
      lines.push(`- **${s.name}**: ${s.reason}`)
    }
  }
  if (manifest.failedReviewers.length > 0) {
    lines.push("")
    lines.push("### Failed reviewers")
    for (const f of manifest.failedReviewers) {
      lines.push(`- **${f.name}**: ${f.error}`)
    }
  }
  lines.push("")

  // ── Findings from each reviewer ──
  const reviewerNames = Object.keys(reviewerFindings)
  if (reviewerNames.length === 0) {
    lines.push("## Reviewer Findings")
    lines.push("")
    lines.push("_No reviewer findings were collected._")
    lines.push("")
  } else {
    for (const name of reviewerNames) {
      const output = reviewerFindings[name]
      const guidance = getWeightingGuidance(name, mode)
      const requiredLabel = output.required ? "Required" : "Optional"

      lines.push(`## Reviewer: ${name} (${requiredLabel})`)
      lines.push("")
      lines.push(`**Focus**: ${guidance.focus}`)
      lines.push(`**Algorithm weight**: ${guidance.algorithmWeight}`)
      lines.push(`**System weight**: ${guidance.systemWeight}`)
      lines.push("")

      if (output.findings.length === 0) {
        lines.push("_No findings from this reviewer._")
        if (output.rawOutput) {
          lines.push(`**Raw output**: ${output.rawOutput}`)
        }
        lines.push("")
        continue
      }

      lines.push("| # | Severity | Title | Evidence |")
      lines.push("|---|----------|-------|----------|")
      for (let i = 0; i < output.findings.length; i++) {
        const f = output.findings[i]
        const evidence = f.evidence ?? "(no specific evidence)"
        lines.push(`| ${i + 1} | ${f.severity} | ${f.title} | ${evidence} |`)
      }
      lines.push("")

      // Add descriptions after the table for readability
      for (let i = 0; i < output.findings.length; i++) {
        const f = output.findings[i]
        lines.push(`**Finding ${i + 1}**: ${f.title}`)
        lines.push(`- Description: ${f.description}`)
        if (f.evidence) {
          lines.push(`- Evidence: ${f.evidence}`)
        }
        lines.push("")
      }

      // Include raw output if present
      if (output.rawOutput) {
        lines.push(`**Raw output**: ${output.rawOutput}`)
        lines.push("")
      }
    }
  }

  // ── Synthesis instructions ──
  lines.push("## Synthesis Instructions")
  lines.push("")
  lines.push("You are zflow.synthesizer. Follow the rules below when consolidating:")
  lines.push("")
  lines.push("### Core rules")
  lines.push("1. **Synthesise only.** Do not add new findings, modify code, or change plan artifacts.")
  lines.push("2. **Reason over the actual reviewer set.** Note coverage gaps where a reviewer was not invoked, skipped, or failed.")
  lines.push("3. **You may downgrade weak single-reviewer observations.** A finding raised by only one reviewer with thin evidence (no concrete file/line reference, speculative concern) may be downgraded one severity level. A finding raised by multiple reviewers or a single reviewer with strong evidence must not be downgraded. Downgrade decisions must be explicitly noted.")
  lines.push("")
  lines.push("### Deduplication rules")
  lines.push("- Same file + same concern + same root cause = deduplicate, credit both reviewers.")
  lines.push("- Same file + different concern = keep both findings.")
  lines.push("- Same concern + different files = keep both findings (may be systemic).")
  lines.push("- Severity differences: keep the higher severity from either reviewer. Note the discrepancy.")
  lines.push("")
  lines.push("### Specialty weighting guidance")
  lines.push("The following reviewers have domain-specific weighting annotations above:")
  lines.push("")
  for (const name of reviewerNames) {
    const guidance = getWeightingGuidance(name, mode)
    if (guidance.algorithmWeight !== 1.0 || guidance.systemWeight !== 1.0) {
      lines.push(
        `- **${name}** (algorithm: ${guidance.algorithmWeight}, system: ${guidance.systemWeight}): ` +
        `${guidance.focus}`,
      )
    }
  }
  lines.push("")
  lines.push("### Output format")
  lines.push("")
  lines.push("Return a consolidated report with the following sections:")
  lines.push("")
  lines.push(`1. **Consolidated findings** grouped by severity (critical > major > minor > nit).`)
  lines.push("   Each finding should list reviewer support and any dissent.")
  lines.push("2. **Severity summary** with counts for each severity level.")
  lines.push("3. **Coverage notes** — which reviewers were covered and any gaps.")
  lines.push("4. **Recommendation**: GO | NO-GO | CONDITIONAL-GO")
  lines.push("")
  lines.push("### Coverage notes")
  lines.push("For each expected reviewer role that did not produce findings, note why:")
  lines.push("- Not invoked (skipped)")
  lines.push("- Invoked but produced no findings")
  lines.push("- Invoked but could not complete (failed)")
  lines.push("")
  lines.push("## Output")
  lines.push("")
  lines.push("Produce the consolidated findings and recommendation below.")

  return lines.join("\n")
}

// ── Recommendation evaluation ──────────────────────────────────

/**
 * Evaluate a severity summary and return a go/no-go recommendation.
 *
 * Rules drawn from the master plan:
 * - `critical > 0` → NO-GO (blocking findings)
 * - `major > 0` → CONDITIONAL-GO (should be resolved)
 * - only `minor`/`nit` or empty → GO (may proceed)
 *
 * @param severitySummary - Counts by severity.
 * @returns Recommendation: "GO", "NO-GO", or "CONDITIONAL-GO".
 */
export function evaluateRecommendation(
  severitySummary: { critical: number; major: number; minor: number; nit: number },
): "GO" | "NO-GO" | "CONDITIONAL-GO" {
  if (severitySummary.critical > 0) return "NO-GO"
  if (severitySummary.major > 0) return "CONDITIONAL-GO"
  return "GO"
}

// ── Build a SynthesisResult from synthesizer response (for callers) ──

/**
 * Build a SynthesisResult from the severity summary and coverage info.
 *
 * This is a convenience for callers that parse the synthesizer agent's
 * output and want to represent the result structurally.
 *
 * @param consolidatedFindings - The de-duplicated, consolidated findings.
 * @param severitySummary - Counts by severity.
 * @param coverageNotes - Human-readable coverage notes.
 * @returns A SynthesisResult with recommendation derived from severity.
 */
export function buildSynthesisResult(
  consolidatedFindings: SynthesisResult["consolidatedFindings"],
  severitySummary: SynthesisResult["severitySummary"],
  coverageNotes: string[],
): SynthesisResult {
  return {
    consolidatedFindings,
    severitySummary,
    coverageNotes,
    recommendation: evaluateRecommendation(severitySummary),
  }
}
