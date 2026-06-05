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
import * as fsSync from "node:fs"
import { resolveCodeReviewFindingsPath, resolveRunDir } from "pi-zflow-artifacts"

import {
  createManifest,
} from "pi-zflow-review"

import type {
  ReviewerManifest,
  ReviewerMode,
} from "pi-zflow-review"

import { resolvePrReviewPath } from "pi-zflow-artifacts"

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

// ── Tier selection — code review ──────────────────────────────

/**
 * Context for making code-review tier decisions.
 *
 * All fields are optional so callers may pass whatever data they
 * have available.  The decision logic applies the documented trigger
 * rules to determine whether optional reviewers (logic, system) are
 * needed.
 */
export interface CodeReviewTierContext {
  /** Execution groups with review tags. */
  executionGroups?: Array<{ reviewTags?: string | string[] }>
  /** Verification document content (plain text). */
  verificationText?: string
  /** List of modified file paths. */
  modifiedFiles?: string[]
  /** List of modified directory paths. */
  modifiedDirectories?: string[]
  /** Cross-module dependency descriptions (if known). */
  crossModuleDependencies?: string[]
  /** Whether public API changes are present. */
  hasPublicApiChanges?: boolean
  /** Whether migration/schema/config changes are present. */
  hasMigrationChanges?: boolean
  /** Whether the planner explicitly flagged algorithmic risk. */
  hasAlgorithmicRisk?: boolean
}

/**
 * Substrings in file paths that suggest algorithmic or concurrency
 * risk, triggering the `+logic` tier.
 */
const LOGIC_KEYWORDS = [
  "algorithm",
  "concurrency",
  "parallel",
  "scheduler",
  "lock",
  "mutex",
  "computation",
  "sort",
  "cache",
] as const

/**
 * Choose a code-review tier based on the change context and the
 * documented trigger rules.
 *
 * ## Logic reviewer added when ANY match:
 * - `reviewTags` include `"logic"`
 * - `verificationText` mentions "performance" or "complexity"
 * - A modified file path contains an algorithmic keyword
 *   (algorithm, concurrency, parallel, scheduler, lock, mutex,
 *   computation, sort, cache)
 * - `hasAlgorithmicRisk` is true
 *
 * ## System reviewer added when ANY match:
 * - `reviewTags` include `"system"`
 * - > 10 files changed
 * - > 3 directories touched
 * - `crossModuleDependencies` is non-empty
 * - `hasPublicApiChanges` is true
 * - `hasMigrationChanges` is true
 *
 * ## Return values
 *
 * | logic? | system? | tier       |
 * | :----: | :-----: | ---------- |
 * | no     | no      | `"standard"` |
 * | yes    | no      | `"+logic"`   |
 * | no     | yes     | `"+system"`  |
 * | yes    | yes     | `"+full"`    |
 *
 * @param ctx - Change context for the review tier decision.
 * @returns One of `"standard"`, `"+logic"`, `"+system"`, `"+full"`.
 */
export function chooseCodeReviewTier(ctx: CodeReviewTierContext): string {
  const addLogic = shouldAddLogicReviewer(ctx)
  const addSystem = shouldAddSystemReviewer(ctx)

  if (addLogic && addSystem) return "+full"
  if (addLogic) return "+logic"
  if (addSystem) return "+system"
  return "standard"
}

/**
 * Determine whether the logic reviewer should be added.
 *
 * Returns true if **any** of the logic trigger conditions are met.
 */
function shouldAddLogicReviewer(ctx: CodeReviewTierContext): boolean {
  // 1. execution-group reviewTags include "logic"
  if (ctx.executionGroups && ctx.executionGroups.length > 0) {
    const tags = collectReviewTags(ctx.executionGroups as ExecutionGroupLike[])
    if (tags.includes("logic")) return true
  }

  // 2. verification text mentions "performance" or "complexity"
  if (ctx.verificationText) {
    const lower = ctx.verificationText.toLowerCase()
    if (lower.includes("performance") || lower.includes("complexity")) {
      return true
    }
  }

  // 3. modified file paths contain algorithmic keywords
  if (ctx.modifiedFiles && ctx.modifiedFiles.length > 0) {
    for (const file of ctx.modifiedFiles) {
      const lower = file.toLowerCase()
      for (const kw of LOGIC_KEYWORDS) {
        if (lower.includes(kw)) return true
      }
    }
  }

  // 4. planner flagged algorithmic risk
  if (ctx.hasAlgorithmicRisk) return true

  return false
}

/**
 * Determine whether the system reviewer should be added.
 *
 * Returns true if **any** of the system trigger conditions are met.
 */
function shouldAddSystemReviewer(ctx: CodeReviewTierContext): boolean {
  // 1. execution-group reviewTags include "system"
  if (ctx.executionGroups && ctx.executionGroups.length > 0) {
    const tags = collectReviewTags(ctx.executionGroups as ExecutionGroupLike[])
    if (tags.includes("system")) return true
  }

  // 2. >10 files changed or >3 directories touched
  if (ctx.modifiedFiles && ctx.modifiedFiles.length > 10) return true
  if (ctx.modifiedDirectories && ctx.modifiedDirectories.length > 3) return true

  // 3. cross-module dependencies present
  if (ctx.crossModuleDependencies && ctx.crossModuleDependencies.length > 0) return true

  // 4. public API changes
  if (ctx.hasPublicApiChanges) return true

  // 5. migration/schema/config changes
  if (ctx.hasMigrationChanges) return true

  return false
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
  /** Stable persisted finding identifier (e.g. "finding-3"). */
  findingId?: string
  /** Source file path for this finding (when available from the reviewer). */
  file?: string
  /** Starting line number for the finding. */
  line?: number
  /** Rendered line/range string (e.g. "42-56"). */
  lines?: string
  evidence: string
  whyItMatters: string
  failureMode?: string
  recommendation: string
  /** Path to the primary raw reviewer artifact for traceability */
  artifactPath?: string
  /** Additional raw reviewer artifacts that support this consolidated finding. */
  artifactPaths?: string[]
  /** Run ID for cross-referencing */
  runId?: string
  /** Enriched: what the code SHOULD do instead. */
  expectedBehavior?: string
  /** Enriched: concrete things a fix must accomplish. */
  fixRequirements?: string
  /** Enriched: how to verify the fix works. */
  validation?: string
  /** Enriched: optional hint for the fix worker. */
  suggestedApproach?: string
  /** Root-cause classification used for clustering and escalation. */
  rootCause?: string
  /** Root-cause family identifier shared across related findings/files. */
  findingFamily?: string
  /** Canonical key for exact duplicate/recurrence matching. */
  canonicalKey?: string
  /** Number of consecutive review loops this canonical issue has survived. */
  recurrenceCount?: number
  /** Prior finding IDs or canonical keys that this finding recurs from. */
  previousOccurrenceIds?: string[]
  /** Priority hint for downstream fix orchestration (1=highest). */
  fixPriority?: number
}

/**
 * Input for generating the internal code review findings file.
 */
export interface FocusedFixReviewContext {
  mode: "fix-follow-up"
  targetFiles?: string[]
  targetFamilies?: string[]
  priorFindings?: Array<{
    findingId?: string
    title: string
    severity: "critical" | "major" | "minor" | "nit"
    file?: string
    findingFamily?: string
    canonicalKey?: string
  }>
}

export interface PersistedCodeReviewFindingRef {
  findingId?: string
  title: string
  severity: "critical" | "major" | "minor" | "nit"
  file?: string
  rootCause?: string
  findingFamily?: string
  canonicalKey?: string
  recurrenceCount?: number
  previousOccurrenceIds?: string[]
}

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
  /** Additional orchestration coverage notes. */
  coverageNotes?: string[]
  /** Final recommendation for the review. */
  recommendation?: "GO" | "NO-GO" | "CONDITIONAL-GO"
  /** Number of reviewers that executed. */
  reviewersExecuted?: number
  /** Optional infrastructure summary for failed/blocked review execution. */
  reviewInfrastructureSummary?: string
  /** Optional recovery hint for infrastructure failures. */
  reviewInfrastructureHint?: string
  /** Working directory for runtime-state resolution (optional). */
  cwd?: string
  /** Optional focused follow-up review context for post-fix reruns. */
  focusReview?: FocusedFixReviewContext
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

const ROOT_CAUSE_PATTERNS: Array<{ pattern: RegExp, category: string }> = [
  { pattern: /\b(auth|authori[sz]ation|permission|idor|secret|credential|token|xss|csrf|sql injection|security)\b/i, category: "security" },
  { pattern: /\b(pagination|limit|offset|page size|max[_ -]?order[_ -]?item[_ -]?ids)\b/i, category: "pagination" },
  { pattern: /\b(validate|validation|invalid|bad request|input size|safe integer|non[- ]?numeric|parse)\b/i, category: "validation" },
  { pattern: /\b(client|cli|dto|request interface|response dto|contract|pass-through|query params?)\b/i, category: "contract" },
  { pattern: /\b(error handling|error swallow|throw|catch|5xx|exception)\b/i, category: "error-handling" },
  { pattern: /\b(log|logging|observability|trace|correlation)\b/i, category: "observability" },
  { pattern: /\b(n\+1|performance|parallel|sequential await|scalability|latency)\b/i, category: "performance" },
  { pattern: /\b(type|typescript|date annotations?|string dates?|interface)\b/i, category: "types" },
  { pattern: /\b(test|coverage|assert|mock|fixture)\b/i, category: "testing" },
  { pattern: /\b(doc|documentation|help text|comment|readme)\b/i, category: "documentation" },
]

function normalizeConcernText(text: string): string {
  const stopWords = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "does", "not", "lack", "lacks", "missing", "current", "new", "oracle", "endpoint", "method", "function", "client", "api", "cli"])
  const tokens = text
    .toLowerCase()
    .replace(/`[^`]+`/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 2 && !stopWords.has(token))
  return tokens.slice(0, 6).join("-") || "general-issue"
}

export function inferFindingRootCause(finding: Pick<CodeReviewFinding, "title" | "evidence" | "recommendation" | "expectedBehavior" | "fixRequirements">): string {
  const haystack = [
    finding.title,
    finding.evidence,
    finding.recommendation,
    finding.expectedBehavior ?? "",
    finding.fixRequirements ?? "",
  ].join(" ")

  for (const { pattern, category } of ROOT_CAUSE_PATTERNS) {
    if (pattern.test(haystack)) return category
  }

  return "general"
}

export function buildFindingFamily(finding: Pick<CodeReviewFinding, "title" | "evidence" | "recommendation" | "expectedBehavior" | "fixRequirements" | "rootCause">): string {
  const rootCause = finding.rootCause ?? inferFindingRootCause(finding)
  const concern = normalizeConcernText(
    finding.expectedBehavior ??
    finding.fixRequirements ??
    finding.title ??
    finding.recommendation ??
    finding.evidence,
  )
  return `${rootCause}:${concern}`
}

export function buildCanonicalFindingKey(finding: Pick<CodeReviewFinding, "file" | "title" | "evidence" | "recommendation" | "expectedBehavior" | "fixRequirements" | "rootCause" | "findingFamily">): string {
  const family = finding.findingFamily ?? buildFindingFamily(finding)
  const file = finding.file?.trim() || "repo"
  return `${family}::${file}`
}

function mergeUniqueStrings(values: Array<string | undefined>): string[] | undefined {
  const merged = [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))]
  return merged.length > 0 ? merged : undefined
}

function choosePreferredText(primary: string | undefined, candidate: string | undefined): string | undefined {
  if (!primary?.trim()) return candidate?.trim()
  if (!candidate?.trim()) return primary.trim()
  return candidate.trim().length > primary.trim().length ? candidate.trim() : primary.trim()
}

export function parsePersistedCodeReviewFindings(content: string): PersistedCodeReviewFindingRef[] {
  if (!content.trim()) return []

  const findings: PersistedCodeReviewFindingRef[] = []
  const blocks = content.split(/(?=^### )/m).filter(Boolean)
  for (const block of blocks) {
    const titleMatch = block.match(/^### (.+)$/m)
    if (!titleMatch) continue
    const severityMatch = content
      .slice(0, content.indexOf(block))
      .split("\n")
      .reverse()
      .find((line) => /^## (Critical|Major|Minor)(?: Findings?)?$|^## Nits?$/i.test(line))
    let severity: PersistedCodeReviewFindingRef["severity"] = "minor"
    if (severityMatch) {
      const normalized = severityMatch.replace(/^## /, "").replace(/ Findings?$/i, "").toLowerCase()
      if (normalized === "critical") severity = "critical"
      else if (normalized === "major") severity = "major"
      else if (normalized === "minor") severity = "minor"
      else if (normalized.startsWith("nit")) severity = "nit"
    }
    const line = (label: string) => block.match(new RegExp(`^\\*\\*${label}\\*\\*:\\s*(.+)$`, "im"))?.[1]?.trim()
    const previous = line("Previous occurrences")
      ?.split(/\s*,\s*/)
      .map((entry) => entry.replace(/^`|`$/g, "").trim())
      .filter(Boolean)

    findings.push({
      findingId: line("Finding ID"),
      title: titleMatch[1].trim(),
      severity,
      file: line("File")?.replace(/^`|`$/g, ""),
      rootCause: line("Root cause"),
      findingFamily: line("Finding family"),
      canonicalKey: line("Canonical key"),
      recurrenceCount: line("Recurrence count") ? Number.parseInt(line("Recurrence count")!, 10) || undefined : undefined,
      previousOccurrenceIds: previous,
    })
  }

  return findings
}

export function consolidateCodeReviewFindings(
  findings: CodeReviewFinding[],
  previousFindings: PersistedCodeReviewFindingRef[] = [],
): CodeReviewFinding[] {
  const previousByKey = new Map(previousFindings
    .filter((finding) => finding.canonicalKey)
    .map((finding) => [finding.canonicalKey!, finding]))

  const grouped = new Map<string, CodeReviewFinding>()
  for (const finding of findings) {
    const rootCause = finding.rootCause ?? inferFindingRootCause(finding)
    const findingFamily = finding.findingFamily ?? buildFindingFamily({ ...finding, rootCause })
    const canonicalKey = finding.canonicalKey ?? buildCanonicalFindingKey({ ...finding, rootCause, findingFamily })
    const existing = grouped.get(canonicalKey)
    const previous = previousByKey.get(canonicalKey)

    const normalized: CodeReviewFinding = {
      ...finding,
      rootCause,
      findingFamily,
      canonicalKey,
      artifactPaths: mergeUniqueStrings([...(finding.artifactPaths ?? []), finding.artifactPath]),
      recurrenceCount: previous ? Math.max(1, previous.recurrenceCount ?? 1) + 1 : 1,
      previousOccurrenceIds: mergeUniqueStrings([...(finding.previousOccurrenceIds ?? []), ...(previous?.previousOccurrenceIds ?? []), previous?.findingId, previous?.canonicalKey]),
      fixPriority: severityRank(finding.severity) + 1,
    }

    if (!existing) {
      grouped.set(canonicalKey, normalized)
      continue
    }

    grouped.set(canonicalKey, {
      ...existing,
      severity: severityRank(normalized.severity) < severityRank(existing.severity) ? normalized.severity : existing.severity,
      reviewerSupport: mergeUniqueStrings([...existing.reviewerSupport, ...normalized.reviewerSupport]) ?? existing.reviewerSupport,
      reviewerDissent: mergeUniqueStrings([...(existing.reviewerDissent ?? []), ...(normalized.reviewerDissent ?? [])]),
      evidence: choosePreferredText(existing.evidence, normalized.evidence) ?? existing.evidence,
      whyItMatters: choosePreferredText(existing.whyItMatters, normalized.whyItMatters) ?? existing.whyItMatters,
      failureMode: choosePreferredText(existing.failureMode, normalized.failureMode),
      recommendation: choosePreferredText(existing.recommendation, normalized.recommendation) ?? existing.recommendation,
      expectedBehavior: choosePreferredText(existing.expectedBehavior, normalized.expectedBehavior),
      fixRequirements: choosePreferredText(existing.fixRequirements, normalized.fixRequirements),
      validation: choosePreferredText(existing.validation, normalized.validation),
      suggestedApproach: choosePreferredText(existing.suggestedApproach, normalized.suggestedApproach),
      artifactPath: existing.artifactPath ?? normalized.artifactPath,
      artifactPaths: mergeUniqueStrings([...(existing.artifactPaths ?? []), ...(normalized.artifactPaths ?? [])]),
      recurrenceCount: Math.max(existing.recurrenceCount ?? 1, normalized.recurrenceCount ?? 1),
      previousOccurrenceIds: mergeUniqueStrings([...(existing.previousOccurrenceIds ?? []), ...(normalized.previousOccurrenceIds ?? [])]),
      fixPriority: Math.min(existing.fixPriority ?? 4, normalized.fixPriority ?? 4),
    })
  }

  return [...grouped.values()]
    .sort((a, b) => {
      const sevDiff = severityRank(a.severity) - severityRank(b.severity)
      if (sevDiff !== 0) return sevDiff
      const fileDiff = (a.file ?? "").localeCompare(b.file ?? "")
      if (fileDiff !== 0) return fileDiff
      return a.title.localeCompare(b.title)
    })
    .map((finding, index) => ({
      ...finding,
      findingId: finding.findingId ?? `finding-${index + 1}`,
      artifactPath: finding.artifactPath ?? finding.artifactPaths?.[0],
    }))
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
    if (isNoiseFinding(f)) continue
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
 * Returns true if a finding is a reviewer preamble/scope statement rather
 * than an actionable finding.  These typically have identical or near-identical
 * title and evidence, no file paths, no line numbers, no expected behavior,
 * and no fix requirements — they describe what the reviewer looked at, not
 * what they found.
 */
function isNoiseFinding(f: CodeReviewFinding): boolean {
  // Must have at least one of: file path, line numbers, expected behavior,
  // fix requirements, validation, or suggested approach to be actionable.
  const hasFile = !!(f as any).file
  const hasLine = !!(f as any).line
  const hasConcrete = !!(
    f.expectedBehavior ||
    f.fixRequirements ||
    f.validation ||
    f.suggestedApproach
  )

  // If it has concrete details, it's a real finding regardless of title/evidence overlap
  if (hasFile || hasLine || hasConcrete) return false

  // Check for title/evidence near-identity (reviewer scope statements)
  const t = f.title.toLowerCase().replace(/\s+/g, " ")
  const e = f.evidence.toLowerCase().replace(/\s+/g, " ")
  if (t === e) return true

  // Check for common preamble patterns
  const preamblePatterns = [
    /^reviewed (the |scope: )/i,
    /^i reviewed /i,
    /^security review scope/i,
  ]
  const isPreamble = preamblePatterns.some((p) => p.test(f.title))
  if (isPreamble && !hasFile && !hasLine && !hasConcrete) return true

  return false
}

/**
 * Group findings by severity and format them as markdown sections.
 *
 * Noise findings (reviewer preamble/scope statements with no actionable
 * content) are filtered out before formatting. See `isNoiseFinding`.
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
    if (isNoiseFinding(f)) continue
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
      if (f.findingId) {
        lines.push(`**Finding ID**: ${f.findingId}`)
      }
      lines.push(`**Reviewer support**: ${f.reviewerSupport.join(", ")}`)
      if (f.reviewerDissent && f.reviewerDissent.length > 0) {
        lines.push(`**Reviewer dissent**: ${f.reviewerDissent.join(", ")}`)
      }
      if (f.file) {
        lines.push(`**File**: ${f.file}`)
      }
      if (f.lines) {
        lines.push(`**Lines**: ${f.lines}`)
      } else if (f.line) {
        lines.push(`**Lines**: ${f.line}`)
      }
      if (f.rootCause) {
        lines.push(`**Root cause**: ${f.rootCause}`)
      }
      if (f.findingFamily) {
        lines.push(`**Finding family**: ${f.findingFamily}`)
      }
      if (f.canonicalKey) {
        lines.push(`**Canonical key**: ${f.canonicalKey}`)
      }
      if (typeof f.recurrenceCount === "number") {
        lines.push(`**Recurrence count**: ${f.recurrenceCount}`)
      }
      if (f.previousOccurrenceIds && f.previousOccurrenceIds.length > 0) {
        lines.push(`**Previous occurrences**: ${f.previousOccurrenceIds.map((entry) => `\`${entry}\``).join(", ")}`)
      }
      if (f.artifactPath) {
        lines.push(`**Artifact path**: ${f.artifactPath}`)
      }
      if (f.artifactPaths && f.artifactPaths.length > 1) {
        lines.push(`**Artifact paths**: ${f.artifactPaths.map((entry) => `\`${entry}\``).join(", ")}`)
      }
      lines.push(`**Evidence**: ${f.evidence}`)
      lines.push(`**Why it matters**: ${f.whyItMatters}`)
      if (f.failureMode) {
        lines.push(`**Failure mode**: ${f.failureMode}`)
      }
      if (f.expectedBehavior) {
        lines.push(`**Expected behavior**: ${f.expectedBehavior}`)
      }
      if (f.fixRequirements) {
        lines.push(`**Fix requirements**: ${f.fixRequirements}`)
      }
      if (f.validation) {
        lines.push(`**Validation**: ${f.validation}`)
      }
      if (f.suggestedApproach) {
        lines.push(`**Suggested approach**: ${f.suggestedApproach}`)
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
  const reviewersExecuted = input.reviewersExecuted ?? input.manifest.reviewers.filter((reviewer) => reviewer.status === "executed").length
  const normalizedCoverageNotes = [...new Set((input.coverageNotes ?? [])
    .map((note) => note.trim())
    .filter((note) => note.length > 0))]

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
  if (input.focusReview) {
    lines.push("")
    lines.push(`Focused review mode: ${input.focusReview.mode}`)
    if (input.focusReview.targetFiles && input.focusReview.targetFiles.length > 0) {
      lines.push(`Focus files: ${input.focusReview.targetFiles.map((file) => `\`${file}\``).join(", ")}`)
    }
    if (input.focusReview.targetFamilies && input.focusReview.targetFamilies.length > 0) {
      lines.push(`Focus families: ${input.focusReview.targetFamilies.map((family) => `\`${family}\``).join(", ")}`)
    }
  }
  lines.push(``)

  // ── Review outcome ──────────────────────────────────────────
  lines.push(`## Review Outcome`)
  lines.push(``)
  lines.push(`- Recommendation: ${input.recommendation ?? "unknown"}`)
  lines.push(`- Reviewers executed: ${reviewersExecuted}/${input.reviewers.length}`)
  if (input.reviewInfrastructureSummary) {
    lines.push(`- Infrastructure status: failed`)
    lines.push(`- Infrastructure summary: ${input.reviewInfrastructureSummary}`)
    if (input.reviewInfrastructureHint) {
      lines.push(`- Recovery hint: ${input.reviewInfrastructureHint}`)
    }
  } else {
    lines.push(`- Infrastructure status: ok`)
  }
  lines.push(``)

  // ── Coverage Notes ──────────────────────────────────────────
  lines.push(`## Coverage Notes`)
  lines.push(``)
  lines.push(formatCoverageNotes(input.manifest))
  if (normalizedCoverageNotes.length > 0) {
    lines.push(``)
    for (const note of normalizedCoverageNotes) {
      lines.push(`- ${note}`)
    }
  }
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

// ═══════════════════════════════════════════════════════════════
// Raw reviewer artifact preservation
// ═══════════════════════════════════════════════════════════════

/**
 * Resolve the path for a single reviewer's raw output artifact.
 *
 * Pattern: `<runtime-state-dir>/runs/{runId}/review-artifacts/{reviewerName}.md`
 *
 * @param runId - Run identifier from the reviewer manifest.
 * @param reviewerName - Short name of the reviewer (e.g. "correctness").
 * @param cwd - Working directory for runtime-state resolution (optional).
 * @returns The absolute path to the raw reviewer artifact file.
 */
export function resolveReviewerArtifactDir(
  runId: string,
  reviewerName: string,
  cwd?: string,
): string {
  return path.join(resolveRunDir(runId, cwd), "review-artifacts", `${reviewerName}.md`)
}

/**
 * Persist a reviewer's raw output to the run's artifact directory.
 *
 * Creates parent directories as needed and writes the raw text as
 * a markdown file at:
 * `<runtime-state-dir>/runs/{runId}/review-artifacts/{reviewerName}.md`
 *
 * @param runId - Run identifier from the reviewer manifest.
 * @param reviewerName - Short name of the reviewer (e.g. "correctness").
 * @param rawOutput - The raw text output from the reviewer agent.
 * @param cwd - Working directory for runtime-state resolution (optional).
 * @returns The absolute path to the written artifact file.
 */
export async function persistReviewerRawOutput(
  runId: string,
  reviewerName: string,
  rawOutput: string,
  cwd?: string,
): Promise<string> {
  const fp = resolveReviewerArtifactDir(runId, reviewerName, cwd)
  await fs.mkdir(path.dirname(fp), { recursive: true })
  await fs.writeFile(fp, rawOutput, "utf-8")
  return fp
}

/**
 * Resolve paths to all raw reviewer artifacts for a given run.
 *
 * Scans `<runtime-state-dir>/runs/{runId}/review-artifacts/` for
 * `.md` files and returns their names and paths. Returns an empty
 * array if the directory does not exist or contains no artifacts.
 *
 * @param runId - Run identifier from the reviewer manifest.
 * @param cwd - Working directory for runtime-state resolution (optional).
 * @returns Array of `{ name, path }` objects where `name` is the
 *   reviewer name derived from the file stem.
 */
export function resolveAllReviewerArtifacts(
  runId: string,
  cwd?: string,
): Array<{ name: string; path: string }> {
  const artifactsDir = path.join(resolveRunDir(runId, cwd), "review-artifacts")

  if (!fsSync.existsSync(artifactsDir)) {
    return []
  }

  const entries = fsSync.readdirSync(artifactsDir, { withFileTypes: true })
  const artifacts: Array<{ name: string; path: string }> = []

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      const name = entry.name.slice(0, -3) // strip ".md" suffix
      artifacts.push({ name, path: path.join(artifactsDir, entry.name) })
    }
  }

  return artifacts.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Load a single reviewer's raw output from the artifact directory.
 *
 * @param runId - Run identifier from the reviewer manifest.
 * @param reviewerName - Short name of the reviewer (e.g. "correctness").
 * @param cwd - Working directory for runtime-state resolution (optional).
 * @returns The raw text content, or `null` if the artifact file does
 *   not exist or cannot be read.
 */
export async function loadReviewerRawOutput(
  runId: string,
  reviewerName: string,
  cwd?: string,
): Promise<string | null> {
  const fp = resolveReviewerArtifactDir(runId, reviewerName, cwd)
  try {
    return await fs.readFile(fp, "utf-8")
  } catch {
    return null
  }
}

/**
 * Add traceability references to an array of findings.
 *
 * Each finding receives an `artifactPath` pointing to the raw reviewer
 * output for the first reviewer in its `reviewerSupport` list, and a
 * `runId` field for cross-referencing.
 *
 * If a finding already has an `artifactPath` or `runId`, it is not
 * overwritten.
 *
 * @param findings - Array of code review findings to annotate.
 * @param runId - Run identifier used to resolve artifact paths.
 * @param cwd - Working directory for runtime-state resolution (optional).
 * @returns A new array of findings with traceability fields added.
 */
export function addFindingTraceability(
  findings: CodeReviewFinding[],
  runId: string,
  cwd?: string,
): CodeReviewFinding[] {
  return findings.map((f) => {
    const inferredPrimary = f.reviewerSupport.length > 0
      ? resolveReviewerArtifactDir(runId, f.reviewerSupport[0], cwd)
      : undefined
    const artifactPaths = mergeUniqueStrings([...(f.artifactPaths ?? []), f.artifactPath, inferredPrimary])
    return {
      ...f,
      artifactPath: f.artifactPath ?? artifactPaths?.[0],
      artifactPaths,
      runId: f.runId ?? runId,
    }
  })
}

// ═══════════════════════════════════════════════════════════════
// PR/MR review findings persistence
// ═══════════════════════════════════════════════════════════════

/**
 * A single finding produced during PR/MR diff review.
 */
export interface PrReviewFinding {
  severity: "critical" | "major" | "minor" | "nit"
  title: string
  /** Relative file path */
  file: string
  /** Line range (e.g. "120-127" or "45") */
  lines?: string
  /** Evidence description */
  evidence: string
  /** Recommendation text */
  recommendation: string
  /** Whether this finding should be submitted as an inline PR comment */
  submit: boolean
  /** Optional edited body text for PR submission */
  editedBody?: string
}

/**
 * Input for generating the external PR/MR review findings file.
 */
export interface PrReviewFindingsInput {
  /** PR/MR metadata */
  prMetadata: {
    /** Full PR/MR URL */
    url: string
    /** Host platform */
    platform: "github" | "gitlab"
    /** Head (source) SHA */
    headSha: string
    /** Base (target) SHA */
    baseSha: string
  }
  /** Run ID for correlation */
  runId: string
  /** Coverage notes (e.g. "Diff-only review", "Chunked: yes") */
  coverageNotes: string[]
  /** Structured findings */
  findings: PrReviewFinding[]
  /** Whether the diff was chunked into parts */
  wasChunked: boolean
  /** Whether inline comment submission is available (auth/permissions) */
  submissionAvailable: boolean
  /** Working directory for runtime-state resolution (optional) */
  cwd?: string
}

// ── PR severity summary ───────────────────────────────────────

/**
 * Format a summary table of PR review findings counts by severity.
 *
 * @param findings - Array of PR review findings.
 * @returns Markdown table string.
 */
export function formatPrSeveritySummary(findings: PrReviewFinding[]): string {
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
 * Group PR findings by severity and format them as markdown sections
 * with file/line references and submit checkboxes.
 *
 * Sections appear in order: Critical, Major, Minor, Nits.
 *
 * @param findings - Array of PR review findings.
 * @returns Markdown string with severity-grouped sections.
 */
export function formatPrFindingsBySeverity(findings: PrReviewFinding[]): string {
  const grouped: Record<string, PrReviewFinding[]> = {
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
      if (f.file) {
        lines.push(`**File**: ${f.file}`)
      }
      if (f.lines) {
        lines.push(`**Lines**: ${f.lines}`)
      }
      lines.push(`**Evidence**: ${f.evidence}`)
      lines.push(`**Recommendation**: ${f.recommendation}`)
      lines.push(`**Submit**: ${f.submit ? "[ ] (pending)" : "[ ]"}`)
      if (f.editedBody) {
        lines.push(`**Edited body**: ${f.editedBody}`)
      }
      lines.push(``)
    }
  }

  return lines.join("\n")
}

/**
 * Persist PR/MR review findings to the canonical file location.
 *
 * Writes a structured markdown file to:
 * `<runtime-state-dir>/review/pr-review-{id}.md`
 *
 * The file includes PR metadata headers, coverage notes, a severity
 * summary table, and findings grouped by severity with file/line
 * references and submit checkboxes.
 *
 * @param input - The PR review findings input.
 * @returns The absolute path to the written file.
 */
export async function persistPrReviewFindings(
  input: PrReviewFindingsInput,
): Promise<string> {
  const fp = resolvePrReviewPath(input.runId, input.cwd)

  // Ensure parent directory exists
  await fs.mkdir(path.dirname(fp), { recursive: true })

  const lines: string[] = []

  // ── Header ──────────────────────────────────────────────────
  lines.push(`# PR Review Findings`)
  lines.push(``)
  lines.push(`**PR URL**: ${input.prMetadata.url}`)
  lines.push(`**Platform**: ${input.prMetadata.platform}`)
  lines.push(`**Head SHA**: ${input.prMetadata.headSha}`)
  lines.push(`**Base SHA**: ${input.prMetadata.baseSha}`)
  lines.push(`**Generated**: ${new Date().toISOString()}`)
  lines.push(`**Run ID**: ${input.runId}`)
  lines.push(``)

  // ── Coverage Notes ──────────────────────────────────────────
  lines.push(`## Coverage Notes`)
  lines.push(``)
  for (const note of input.coverageNotes) {
    lines.push(`- ${note}`)
  }
  lines.push(`- Diff-only review (no code execution)`)
  lines.push(`- Chunked: ${input.wasChunked ? "yes" : "no"}`)
  lines.push(`- Submission available: ${input.submissionAvailable ? "yes" : "no"}`)
  lines.push(``)

  // ── Findings Summary ────────────────────────────────────────
  lines.push(`## Findings Summary`)
  lines.push(``)
  lines.push(formatPrSeveritySummary(input.findings))
  lines.push(``)

  // ── Findings by severity ────────────────────────────────────
  lines.push(formatPrFindingsBySeverity(input.findings))

  const content = lines.join("\n")

  await fs.writeFile(fp, content, "utf-8")
  return fp
}
