/**
 * triage.ts — pi-interview-backed triage for curated PR/MR comment submission.
 *
 * Provides pure data-transformation helpers that prepare findings as triage
 * questions and process triage responses. The orchestration layer calls
 * `pi-interview` with the questions and passes the responses here.
 *
 * ## Lifecycle
 *
 * 1. `buildTriageQuestions(findings)` → questions for pi-interview
 * 2. orchestration layer sends questions via pi-interview, collects responses
 * 3. `processTriageResponses(findings, responses)` → categorized TriageResult
 * 4. `formatTriageSummary(result)` → human-readable summary for the user
 *
 * @module pi-zflow-review/triage
 */

import type { PrReviewFinding } from "./findings.js"

// ── Core types ─────────────────────────────────────────────────

/**
 * Generate a stable finding ID from an index.
 *
 * Uses a short alphanumeric prefix + index for deterministic
 * identification even when finding titles are duplicated.
 */
function makeFindingId(index: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
  const id = []
  let n = index
  do {
    id.push(alphabet[n % alphabet.length])
    n = Math.floor(n / alphabet.length)
  } while (n > 0)
  return `f-${id.reverse().join("")}`
}

/**
 * A triage action chosen by the user for a single finding.
 */
export interface TriageAction {
  /** The finding this action applies to (matches TriageQuestion.findingId). */
  findingId: string
  /** The action to take. */
  action: "submit" | "dismiss" | "edit"
  /** When action is "edit", the edited body text to use for submission. */
  editedBody?: string
}

/**
 * The result of processing triage responses.
 */
export interface TriageResult {
  /** Findings that were marked for submission (action: submit or edit). */
  submitFindings: PrReviewFinding[]
  /** Findings that were dismissed (action: dismiss). */
  dismissedFindings: PrReviewFinding[]
  /** Total findings before triage. */
  totalFindings: number
  /** Whether any findings had their body edited. */
  hadEdits: boolean
}

/**
 * A triage question prepared for pi-interview.
 */
export interface TriageQuestion {
  /** Stable unique identifier for the finding. */
  findingId: string
  /** Finding title, used as the question prompt. */
  title: string
  /** Severity label. */
  severity: string
  /** Affected file path. */
  file: string
  /** Optional line range. */
  lines?: string
  /** Evidence description. */
  evidence: string
  /** Recommendation text. */
  recommendation: string
  /** Default triage action based on severity. */
  defaultAction: "submit" | "dismiss"
}

// ── Helpers ────────────────────────────────────────────────────

/**
 * Return the default triage action for a given severity level.
 *
 * - `critical` / `major` → `"submit"` (these are important findings)
 * - `minor` / `nit` → `"dismiss"` (advisory findings)
 *
 * @param severity - Finding severity level.
 * @returns The default triage action.
 */
export function getDefaultAction(
  severity: "critical" | "major" | "minor" | "nit",
): "submit" | "dismiss" {
  switch (severity) {
    case "critical":
    case "major":
      return "submit"
    case "minor":
    case "nit":
      return "dismiss"
  }
}

/**
 * Build triage questions from an array of PR review findings.
 *
 * Each finding is converted to a `TriageQuestion` with its default
 * action set based on severity. These questions can be sent to
 * pi-interview for user triage.
 *
 * @param findings - Array of PR review findings to triage.
 * @returns Array of triage questions for pi-interview.
 */
export function buildTriageQuestions(
  findings: PrReviewFinding[],
): TriageQuestion[] {
  return findings.map((f, idx) => ({
    findingId: makeFindingId(idx),
    title: f.title,
    severity: f.severity,
    file: f.file,
    lines: f.lines,
    evidence: f.evidence,
    recommendation: f.recommendation,
    defaultAction: getDefaultAction(f.severity),
  }))
}

/**
 * Process triage responses from pi-interview and produce a categorized result.
 *
 * Applies the user's triage decisions to the original findings:
 * - `submit` → finding is added to `submitFindings`, marked as submit=true
 * - `dismiss` → finding is added to `dismissedFindings`, marked as submit=false
 * - `edit` → finding is added to `submitFindings` with updated editedBody, submit=true
 *
 * If a finding is not referenced in the responses, it defaults to dismissed
 * (no action taken).
 *
 * @param findings - The original array of PR review findings.
 * @param responses - Array of triage actions from pi-interview.
 * @returns A TriageResult with categorized findings.
 */
export function processTriageResponses(
  findings: PrReviewFinding[],
  responses: TriageAction[],
): TriageResult {
  // Build a lookup map from findingId to TriageAction
  const responseMap = new Map<string, TriageAction>()
  for (const r of responses) {
    responseMap.set(r.findingId, r)
  }

  // Build a mapping from index to findingId (same algorithm as buildTriageQuestions)
  const indexToFindingId = new Map<number, string>()
  for (let i = 0; i < findings.length; i++) {
    indexToFindingId.set(i, makeFindingId(i))
  }
  // Build reverse mapping from findingId to index
  const findingIdToIndex = new Map<string, number>()
  for (const [idx, fid] of indexToFindingId) {
    findingIdToIndex.set(fid, idx)
  }

  const submitFindings: PrReviewFinding[] = []
  const dismissedFindings: PrReviewFinding[] = []
  let hadEdits = false

  for (let i = 0; i < findings.length; i++) {
    const finding = findings[i]
    const fid = makeFindingId(i)
    const response = responseMap.get(fid)

    if (!response) {
      // No triage response for this finding → dismiss by default
      dismissedFindings.push({ ...finding, submit: false })
      continue
    }

    switch (response.action) {
      case "submit": {
        submitFindings.push({ ...finding, submit: true })
        break
      }
      case "dismiss": {
        dismissedFindings.push({ ...finding, submit: false })
        break
      }
      case "edit": {
        hadEdits = true
        submitFindings.push({
          ...finding,
          submit: true,
          editedBody: response.editedBody ?? finding.editedBody,
        })
        break
      }
    }
  }

  return {
    submitFindings,
    dismissedFindings,
    totalFindings: findings.length,
    hadEdits,
  }
}

/**
 * Format a human-readable summary of the triage result.
 *
 * @param result - The triage result to summarise.
 * @returns A formatted markdown string describing triage outcomes.
 */
export function formatTriageSummary(result: TriageResult): string {
  const parts: string[] = []

  const submitCount = result.submitFindings.length
  const dismissCount = result.dismissedFindings.length

  parts.push(`## Triage Summary`)
  parts.push(``)
  parts.push(`- **${submitCount}** finding${submitCount !== 1 ? "s" : ""} selected for submission`)
  parts.push(`- **${dismissCount}** finding${dismissCount !== 1 ? "s" : ""} dismissed`)
  if (result.hadEdits) {
    const editedCount = result.submitFindings.filter((f) => f.editedBody).length
    parts.push(`- **${editedCount}** finding${editedCount !== 1 ? "s" : ""} edited before submission`)
  }
  parts.push(``)

  // If there are dismissed findings, list them briefly
  if (result.dismissedFindings.length > 0) {
    parts.push(`### Dismissed Findings`)
    for (const f of result.dismissedFindings) {
      parts.push(`- **${f.title}** (${f.file}) — ${f.severity}`)
    }
    parts.push(``)
  }

  return parts.join("\n")
}
