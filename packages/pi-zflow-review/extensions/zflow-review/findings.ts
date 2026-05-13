/**
 * findings.ts — Review findings parsing, normalization, and persistence.
 *
 * Provides reviewer-manifest helpers for plan review and code review,
 * including tier-based reviewer selection and manifest creation.
 *
 * ## Reviewer name constants
 *
 * Plan-review tiers map to reviewers as follows:
 *
 * | Tier           | Reviewers                              |
 * | -------------- | -------------------------------------- |
 * | `"standard"`   | correctness, integration               |
 * | `"logic"`      | correctness, integration               |
 * | `"system"`     | correctness, integration, feasibility  |
 * | `"logic,system"`| correctness, integration, feasibility |
 *
 * Code-review tiers map to reviewers as follows:
 *
 * | Tier       | Core reviewers              | Extra reviewers |
 * | ---------- | --------------------------- | --------------- |
 * | `"standard"`| correctness, integration, security | —        |
 * | `"+logic"` | correctness, integration, security  | logic   |
 * | `"+system"`| correctness, integration, security  | system  |
 * | `"+full"`  | correctness, integration, security  | logic, system |
 *
 * @module pi-zflow-review/findings
 */

import * as path from "node:path"
import * as fs from "node:fs/promises"
import { resolveCodeReviewFindingsPath } from "pi-zflow-artifacts"

import {
  createManifest,
} from "pi-zflow-review"

import type {
  ReviewerManifest,
  ReviewerMode,
} from "pi-zflow-review"

// ── Plan-review tier mapping ───────────────────────────────────

/**
 * Plan-review tier → list of reviewer names.
 *
 * `"standard"` and `"logic"` share the same reviewer set (correctness +
 * integration) because the tier distinction affects *which* optional
 * plan-review agents are added; at the plan-review level, feasibility is
 * only added for `"system"` and `"logic,system"`.
 *
 * See master plan tables: plan-review tiers in the phase doc.
 */
const PLAN_TIER_REVIEWERS: Record<string, string[]> = {
  "standard":     ["correctness", "integration"],
  "logic":        ["correctness", "integration"],
  "system":       ["correctness", "integration", "feasibility"],
  "logic,system": ["correctness", "integration", "feasibility"],
}

/**
 * Return the reviewer names for a given plan-review tier.
 *
 * @param tier - One of `"standard"`, `"logic"`, `"system"`, `"logic,system"`.
 * @returns Array of reviewer short names.
 * @throws If the tier is unknown.
 */
export function getReviewerNamesForPlanTier(tier: string): string[] {
  const reviewers = PLAN_TIER_REVIEWERS[tier]
  if (!reviewers) {
    throw new Error(
      `Unknown plan-review tier "${tier}". ` +
      `Expected one of: ${Object.keys(PLAN_TIER_REVIEWERS).join(", ")}.`,
    )
  }
  return [...reviewers]
}

// ── Code-review tier mapping ───────────────────────────────────

/**
 * Code-review tier → list of reviewer names.
 *
 * Core reviewers (correctness, integration, security) are always present.
 * Optional reviewers (logic, system) are added according to the tier.
 */
const CODE_TIER_REVIEWERS: Record<string, string[]> = {
  "standard": ["correctness", "integration", "security"],
  "+logic":   ["correctness", "integration", "security", "logic"],
  "+system":  ["correctness", "integration", "security", "system"],
  "+full":    ["correctness", "integration", "security", "logic", "system"],
}

/**
 * Return the reviewer names for a given code-review tier.
 *
 * @param tier - One of `"standard"`, `"+logic"`, `"+system"`, `"+full"`.
 * @returns Array of reviewer short names.
 * @throws If the tier is unknown.
 */
export function getReviewerNamesForCodeTier(tier: string): string[] {
  const reviewers = CODE_TIER_REVIEWERS[tier]
  if (!reviewers) {
    throw new Error(
      `Unknown code-review tier "${tier}". ` +
      `Expected one of: ${Object.keys(CODE_TIER_REVIEWERS).join(", ")}.`,
    )
  }
  return [...reviewers]
}

// ── Manifest factory helpers ───────────────────────────────────

/**
 * Build a reviewer manifest from a mode and tier.
 *
 * Uses the built-in tier→reviewer mapping for the given mode.
 *
 * @param mode - The review mode (`"plan-review"` or `"code-review"`).
 * @param tier - The review tier (valid for the given mode).
 * @returns A new ReviewerManifest with all requested reviewers in
 *   `"requested"` state.
 * @throws If the tier is unknown for the given mode.
 */
export function buildManifestFromTier(
  mode: ReviewerMode,
  tier: string,
): ReviewerManifest {
  let requestedReviewers: string[]

  if (mode === "plan-review") {
    requestedReviewers = getReviewerNamesForPlanTier(tier)
  } else {
    requestedReviewers = getReviewerNamesForCodeTier(tier)
  }

  return createManifest(mode, tier, requestedReviewers)
}

/**
 * Resolve the appropriate manifest tier description from a raw tier value.
 *
 * For plan reviews, valid tiers are `"standard"`, `"logic"`, `"system"`,
 * `"logic,system"`. For code reviews, valid tiers are `"standard"`,
 * `"+logic"`, `"+system"`, `"+full"`.
 *
 * This is a convenience wrapper for type validation.
 *
 * @param mode - The review mode.
 * @param tier - The tier value to validate.
 * @returns The tier string if valid.
 * @throws If the tier is unknown for the given mode.
 */
export function resolveTier(mode: ReviewerMode, tier: string): string {
  if (mode === "plan-review") {
    getReviewerNamesForPlanTier(tier) // validates
  } else {
    getReviewerNamesForCodeTier(tier) // validates
  }
  return tier
}

// ── Tier selection — plan review ───────────────────────────────

/**
 * Minimal execution-group shape used for tier selection.
 *
 * Only the `reviewTags` field is consumed; additional metadata is
 * ignored so callers may pass richer group objects without casting.
 */
export interface ExecutionGroupLike {
  /** Tag(s) indicating which review tiers apply.
   *  May be a single string, an array of strings, or undefined. */
  reviewTags?: string | string[]
}

/**
 * Collect all unique review tags from an array of execution groups.
 *
 * Tags may appear as a single string or an array of strings on each
 * group.  The result is always a deduplicated array of strings.
 *
 * @param groups - Array of execution-group-like objects.
 * @returns A flat, deduplicated array of tag strings.
 */
export function collectReviewTags(groups: ExecutionGroupLike[]): string[] {
  const tagSet = new Set<string>()

  for (const group of groups) {
    const tags = group.reviewTags
    if (tags === undefined || tags === null) continue

    if (Array.isArray(tags)) {
      for (const t of tags) tagSet.add(t)
    } else {
      tagSet.add(tags)
    }
  }

  return [...tagSet]
}

/**
 * Choose a plan-review tier based on the review tags found in
 * execution groups.
 *
 * The decision follows the master-plan table:
 *
 * | Tag(s) present         | Returned tier     |
 * | ---------------------- | ----------------- |
 * | `"logic"` + `"system"` | `"logic,system"`  |
 * | `"system"` only        | `"system"`        |
 * | `"logic"` only         | `"logic"`         |
 * | none of the above      | `"standard"`      |
 *
 * When the tier is `"standard"`, the plan-review swarm should be
 * skipped after structural validation completes successfully.
 *
 * @param groups - Array of execution-group objects (each may carry
 *   a `reviewTags` field as `string | string[] | undefined`).
 * @returns The resolved plan-review tier string.
 */
export function choosePlanReviewTier(groups: ExecutionGroupLike[]): string {
  const tags = collectReviewTags(groups)
  const hasLogic = tags.includes("logic")
  const hasSystem = tags.includes("system")

  if (hasLogic && hasSystem) return "logic,system"
  if (hasSystem) return "system"
  if (hasLogic) return "logic"

  return "standard"
}

// ═══════════════════════════════════════════════════════════════
// Code review findings persistence
// ═══════════════════════════════════════════════════════════════

/**
 * A single finding produced during code review.
 */
export interface CodeReviewFinding {
  severity: "critical" | "major" | "minor" | "nit"
  title: string
  reviewerSupport: string[]
  reviewerDissent?: string[]
  evidence: string
  whyItMatters: string
  failureMode?: string
  recommendation: string
}

/**
 * Input for generating the internal code review findings file.
 */
export interface CodeReviewFindingsInput {
  /** Description of what was reviewed (e.g. "Implementation of feat-auth"). */
  source: string
  /** Repository path (e.g. "/home/user/project"). */
  repoPath: string
  /** Current branch name. */
  branch: string
  /** Base ref for the diff (e.g. "main", "HEAD"). */
  baseRef: string
  /** Run ID from the reviewer manifest. */
  runId: string
  /** The reviewer manifest (used for coverage notes). */
  manifest: ReviewerManifest
  /** List of reviewer names that participated. */
  reviewers: string[]
  /** Files or areas that were reviewed. */
  reviewedFiles: string[]
  /** Verification status description. */
  verificationContext: string
  /** Structured findings from the synthesizer. */
  findings: CodeReviewFinding[]
  /** Working directory for runtime-state resolution (optional). */
  cwd?: string
}

// ── Severity helpers ───────────────────────────────────────────

/**
 * Map severity string to a numeric rank for sorting (lower = more severe).
 */
function severityRank(severity: string): number {
  switch (severity) {
    case "critical": return 0
    case "major":    return 1
    case "minor":    return 2
    case "nit":      return 3
    default:         return 4
  }
}

/**
 * Format a summary table of findings counts by severity.
 *
 * @param findings - Array of code review findings.
 * @returns Markdown table string.
 */
export function formatSeveritySummary(findings: CodeReviewFinding[]): string {
  let critical = 0
  let major = 0
  let minor = 0
  let nit = 0

  for (const f of findings) {
    switch (f.severity) {
      case "critical": critical++; break
      case "major":    major++; break
      case "minor":    minor++; break
      case "nit":      nit++; break
    }
  }

  const lines: string[] = []
  lines.push(`| Severity | Count |`)
  lines.push(`| -------- | ----- |`)
  lines.push(`| Critical | ${critical} |`)
  lines.push(`| Major    | ${major} |`)
  lines.push(`| Minor    | ${minor} |`)
  lines.push(`| Nit      | ${nit} |`)
  return lines.join("\n")
}

/**
 * Format coverage notes from a reviewer manifest.
 *
 * Produces a bullet list where each reviewer is annotated with:
 *   ✅ executed   — reviewer ran successfully
 *   ⚠️ skipped    — reviewer was not run (with reason)
 *   ❌ failed     — reviewer failed during execution
 *   ◻️ requested  — reviewer has not yet been dispatched
 *
 * @param manifest - The reviewer manifest.
 * @returns A string with one bullet per reviewer.
 */
export function formatCoverageNotes(manifest: ReviewerManifest): string {
  const lines: string[] = []

  for (const r of manifest.reviewers) {
    switch (r.status) {
      case "executed":
        lines.push(`- ${r.name}: ✅ executed`)
        break
      case "skipped":
        lines.push(`- ${r.name}: ⚠️ skipped${r.detail ? ` — ${r.detail}` : ""}`)
        break
      case "failed":
        lines.push(`- ${r.name}: ❌ failed${r.detail ? ` — ${r.detail}` : ""}`)
        break
      case "requested":
        lines.push(`- ${r.name}: ◻️ requested (not dispatched)`)
        break
    }
  }

  return lines.join("\n")
}

/**
 * Group findings by severity and format them as markdown sections.
 *
 * Sections appear in order: Critical, Major, Minor, Nits.
 * Each finding is formatted with support, dissent, evidence,
 * impact, failure mode, and recommendation.
 *
 * @param findings - Array of code review findings.
 * @returns Markdown string with severity-grouped sections.
 */
export function formatFindingsBySeverity(findings: CodeReviewFinding[]): string {
  const grouped: Record<string, CodeReviewFinding[]> = {
    critical: [],
    major:    [],
    minor:    [],
    nit:      [],
  }

  for (const f of findings) {
    grouped[f.severity].push(f)
  }

  const lines: string[] = []

  const severityLabels: Array<{ key: string; heading: string }> = [
    { key: "critical", heading: "Critical Findings" },
    { key: "major",    heading: "Major Findings" },
    { key: "minor",    heading: "Minor Findings" },
    { key: "nit",      heading: "Nits" },
  ]

  for (const { key, heading } of severityLabels) {
    const entries = grouped[key]
    if (entries.length === 0) {
      lines.push(`## ${heading}`)
      lines.push(``)
      lines.push(`None.`)
      lines.push(``)
      continue
    }

    lines.push(`## ${heading}`)
    lines.push(``)

    for (const f of entries) {
      lines.push(`### ${f.title}`)
      lines.push(`**Reviewer support**: ${f.reviewerSupport.join(", ")}`)
      if (f.reviewerDissent && f.reviewerDissent.length > 0) {
        lines.push(`**Reviewer dissent**: ${f.reviewerDissent.join(", ")}`)
      }
      lines.push(`**Evidence**: ${f.evidence}`)
      lines.push(`**Why it matters**: ${f.whyItMatters}`)
      if (f.failureMode) {
        lines.push(`**Failure mode**: ${f.failureMode}`)
      }
      lines.push(`**Recommendation**: ${f.recommendation}`)
      lines.push(``)
    }
  }

  return lines.join("\n")
}

/**
 * Persist code review findings to the canonical file location.
 *
 * Writes a structured markdown file to:
 * `<runtime-state-dir>/review/code-review-findings.md`
 *
 * The file includes a header with metadata, a severity summary
 * table, coverage notes from the manifest, and findings grouped
 * by severity.
 *
 * @param input - The findings input describing source, manifest,
 *   findings, and metadata.
 * @returns The absolute path to the written file.
 */
export async function persistCodeReviewFindings(
  input: CodeReviewFindingsInput,
): Promise<string> {
  const fp = resolveCodeReviewFindingsPath(input.cwd)

  // Ensure parent directory exists
  await fs.mkdir(path.dirname(fp), { recursive: true })

  const lines: string[] = []

  // ── Header ──────────────────────────────────────────────────
  lines.push(`# Code Review Findings`)
  lines.push(``)
  lines.push(`**Source**: ${input.source}`)
  lines.push(`**Repo path**: ${input.repoPath}`)
  lines.push(`**Branch**: ${input.branch}`)
  lines.push(`**Base ref**: ${input.baseRef}`)
  lines.push(`**Generated**: ${new Date().toISOString()}`)
  lines.push(`**Run ID**: ${input.runId}`)
  lines.push(``)

  // ── Reviewed Changes ────────────────────────────────────────
  lines.push(`## Reviewed Changes`)
  lines.push(``)
  for (const file of input.reviewedFiles) {
    lines.push(`- ${file}`)
  }
  lines.push(``)

  // ── Verification Context ────────────────────────────────────
  lines.push(`## Verification Context`)
  lines.push(``)
  lines.push(input.verificationContext)
  lines.push(``)

  // ── Coverage Notes ──────────────────────────────────────────
  lines.push(`## Coverage Notes`)
  lines.push(``)
  lines.push(formatCoverageNotes(input.manifest))
  lines.push(``)

  // ── Findings Summary ────────────────────────────────────────
  lines.push(`## Findings Summary`)
  lines.push(``)
  lines.push(formatSeveritySummary(input.findings))
  lines.push(``)

  // ── Findings by severity ────────────────────────────────────
  lines.push(formatFindingsBySeverity(input.findings))

  const content = lines.join("\n")

  await fs.writeFile(fp, content, "utf-8")
  return fp
}
