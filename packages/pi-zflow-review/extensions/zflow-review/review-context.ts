/**
 * review-context.ts — Prompt context assembly for internal and external review.
 *
 * Provides prompt builders that ensure reviewers receive the correct
 * context depending on whether the review is for internal changes
 * (planning docs + diff) or external PR/MR diffs (diff-only).
 *
 * ## Design rules
 *
 * - Internal reviewers always receive planning documents before the diff,
 *   enforcing the principle that implementation is evaluated against the
 *   plan first. Novel defect detection is secondary.
 * - External PR/MR reviewers receive diff-only context with explicit
 *   instructions not to execute untrusted code.
 * - Verification-status reminders distinguish release-gating from
 *   advisory review modes.
 *
 * @module pi-zflow-review/review-context
 */

import * as fs from "node:fs/promises"
import type { PrMetadata as PrMetadata_ } from "./pr.js"

// Re-export PrMetadata so downstream modules and tests can import it from
// review-context.js without a direct dependency on pr.js.
export type PrMetadata = PrMetadata_

// ── Context interfaces ─────────────────────────────────────────

/**
 * Full context for internal code review.
 *
 * Internal reviewers receive planning document paths, the diff bundle,
 * and a verification-status reminder. The prompt builder reads the
 * planning documents and diff content from the provided paths.
 */
export interface InternalReviewContext {
  /** Planning document paths */
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
  /** Diff bundle content or path — if it is a path the builder reads it */
  diffBundle: string
  /** Verification status: "passed" | "failed" | "skipped" | "unknown" */
  verificationStatus: "passed" | "failed" | "skipped" | "unknown"
  /** The review tier (e.g. "standard", "+logic", "+system", "+full") */
  tier: string
}

/**
 * A single chunk of a large diff for dispatch to a reviewer agent.
 */
export interface ReviewDiffChunk {
  /** Unique chunk identifier (e.g. "chunk-1") */
  chunkId: string
  /** Files in this chunk */
  files: Array<{
    /** File path relative to repository root */
    path: string
    /** Unified diff patch for this file */
    patch: string
    /** Optional mapping from review-line to diff-right-side-line-number */
    lineMap?: Record<number, number>
  }>
}

/**
 * Full context for external PR/MR review.
 *
 * External reviewers receive diff chunks only, with explicit diff-only
 * and no-execution instructions. No planning documents are included.
 */
export interface ExternalReviewContext {
  /** Diff chunks from the PR/MR */
  diffChunks: ReviewDiffChunk[]
  /** PR/MR metadata */
  prMetadata: PrMetadata
  /** Explicit diff-only instruction text (overrides default) */
  diffOnlyInstructions: string
}

// ── Verification-status reminders ──────────────────────────────

/**
 * Default text for each verification-status value.
 *
 * - "passed": Release-gating verification passed. Findings are blocking.
 * - "failed": Release-gating verification failed. Review is advisory.
 * - "skipped": Final verification was skipped. Review is advisory.
 * - "unknown": Verification status unknown. Review is advisory.
 */
const VERIFICATION_REMINDERS: Record<
  InternalReviewContext["verificationStatus"],
  string
> = {
  passed:
    "Release-gating verification passed. Findings in this review are " +
    "release-gating: critical and major findings block approval.",
  failed:
    "Release-gating verification failed. This review is advisory — " +
    "findings are recommendations for improvement, not release gates.",
  skipped:
    "Final verification was skipped. This review is advisory rather " +
    "than release-gating. Findings inform future work but do not block.",
  unknown:
    "Verification status is unknown. This review is advisory — " +
    "findings are recorded for triage but do not block.",
}

/**
 * Return the standard verification-status reminder text.
 *
 * @param status - One of "passed", "failed", "skipped", "unknown".
 * @returns A human-readable reminder sentence.
 * @throws If the status value is not recognised.
 */
export function getVerificationStatusReminder(
  status: InternalReviewContext["verificationStatus"],
): string {
  const text = VERIFICATION_REMINDERS[status]
  if (!text) {
    throw new Error(
      `Unknown verification status "${String(status)}". ` +
      'Expected one of: "passed", "failed", "skipped", "unknown".',
    )
  }
  return text
}

// ── Plan-adherence instruction ─────────────────────────────────

/**
 * Standard instruction that plan adherence is the primary review goal.
 *
 * This text is included in internal review prompts to ensure the
 * reviewer evaluates implementation against the plan first. Novel
 * defect detection is secondary.
 */
const PLAN_ADHERENCE_INSTRUCTION =
  "## Primary objective\n\n" +
  "Your primary task is to evaluate the implementation against the " +
  "planning documents (design, execution groups, standards, and " +
  "verification plan). Novel defect detection is secondary — focus " +
  "first on whether the changes correctly implement the approved plan."

/**
 * Return the standard plan-adherence instruction text.
 *
 * @returns A string instructing reviewers that plan adherence is primary.
 */
export function getPlanAdherenceInstruction(): string {
  return PLAN_ADHERENCE_INSTRUCTION
}

// ── Diff-only instruction for external PR review ────────────────

/**
 * Default diff-only/no-execution instruction for external PR/MR review.
 */
const DEFAULT_DIFF_ONLY_INSTRUCTION =
  "## Review mode: Diff-only\n\n" +
  "This is a diff-only review. Do not execute, check out, or run " +
  "untrusted PR code. Base your findings entirely on static analysis " +
  "of the supplied diff hunks."

// ── Internal review prompt assembly ────────────────────────────

/**
 * Build the full prompt for an internal code review agent.
 *
 * The prompt includes:
 * 1. The reviewer's role name as a heading.
 * 2. The plan-adherence instruction (primary objective).
 * 3. The verification-status reminder.
 * 4. The planning document paths and their content (read from files).
 * 5. The diff bundle content.
 *
 * @param reviewerName - Short name of the reviewer (e.g. "correctness").
 * @param context - Internal review context with artifact paths and status.
 * @returns A fully assembled prompt string.
 */
export async function buildInternalReviewPrompt(
  reviewerName: string,
  context: InternalReviewContext,
): Promise<string> {
  const parts: string[] = []

  // ── Reviewer role heading ───────────────────────────────────
  parts.push(`# Reviewer: ${reviewerName}\n`)

  // ── Plan-adherence instruction ──────────────────────────────
  parts.push(getPlanAdherenceInstruction())
  parts.push("")

  // ── Verification-status reminder ────────────────────────────
  parts.push("## Verification status")
  parts.push("")
  parts.push(getVerificationStatusReminder(context.verificationStatus))
  parts.push("")

  // ── Planning documents ──────────────────────────────────────
  parts.push("## Planning documents")
  parts.push("")

  const artifactLabels: Array<[string, string]> = [
    ["design.md",   context.planningArtifacts.design],
    ["execution-groups.md", context.planningArtifacts.executionGroups],
    ["standards.md",        context.planningArtifacts.standards],
    ["verification.md",    context.planningArtifacts.verification],
  ]

  for (const [label, filePath] of artifactLabels) {
    parts.push(`### ${label}`)
    parts.push(`Path: ${filePath}`)
    parts.push("")
    try {
      const content = await fs.readFile(filePath, "utf-8")
      parts.push("```markdown")
      parts.push(content)
      parts.push("```")
    } catch {
      parts.push(`*Could not read ${filePath} — file not found or inaccessible.*`)
    }
    parts.push("")
  }

  // ── Diff bundle ─────────────────────────────────────────────
  parts.push("## Diff bundle")
  parts.push("")

  // The diffBundle field may be a file path or inline content.
  // If it looks like a path to an existing file, read it.
  let diffContent = context.diffBundle
  try {
    // Try reading as a file path first
    const fileContent = await fs.readFile(context.diffBundle, "utf-8")
    diffContent = fileContent
  } catch {
    // Not a file path — treat as inline content
  }

  parts.push("```diff")
  parts.push(diffContent)
  parts.push("```")

  parts.push("")

  return parts.join("\n")
}

// ── External PR review prompt assembly ─────────────────────────

/**
 * Build the full prompt for an external PR/MR review agent.
 *
 * The prompt includes:
 * 1. The reviewer's role name as a heading.
 * 2. Diff-only instructions (no execution of untrusted code).
 * 3. PR/MR metadata (platform, repo, number, title, description).
 * 4. The diff chunks (file patches) for review.
 *
 * No planning documents are included — this is a pure diff review.
 *
 * @param reviewerName - Short name of the reviewer (e.g. "correctness").
 * @param context - External review context with diff chunks, metadata, and
 *   diff-only instruction overrides.
 * @returns A fully assembled prompt string.
 */
export function buildExternalReviewPrompt(
  reviewerName: string,
  context: ExternalReviewContext,
): Promise<string> {
  const parts: string[] = []

  // ── Reviewer role heading ───────────────────────────────────
  parts.push(`# Reviewer: ${reviewerName}\n`)

  // ── Diff-only instruction ───────────────────────────────────
  parts.push(context.diffOnlyInstructions || DEFAULT_DIFF_ONLY_INSTRUCTION)
  parts.push("")

  // ── PR/MR metadata ─────────────────────────────────────────
  parts.push("## Pull request / Merge request metadata")
  parts.push("")
  parts.push(`- **Platform:** ${context.prMetadata.platform}`)
  parts.push(`- **Owner:** ${context.prMetadata.owner}`)
  parts.push(`- **Repository:** ${context.prMetadata.repo}`)
  parts.push(`- **Number:** #${context.prMetadata.number}`)
  parts.push(`- **URL:** ${context.prMetadata.url}`)
  parts.push(`- **Title:** ${context.prMetadata.title}`)
  parts.push(`- **Description:** ${context.prMetadata.description}`)
  parts.push("")

  // ── Diff chunks ────────────────────────────────────────────
  parts.push("## Diff chunks")
  parts.push("")

  for (const chunk of context.diffChunks) {
    parts.push(`### Chunk: ${chunk.chunkId}`)
    parts.push("")

    for (const file of chunk.files) {
      parts.push(`#### File: ${file.path}`)
      parts.push("")
      parts.push("```diff")
      parts.push(file.patch)
      parts.push("```")
      parts.push("")
    }
  }

  return Promise.resolve(parts.join("\n"))
}
