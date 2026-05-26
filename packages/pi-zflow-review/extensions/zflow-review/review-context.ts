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

// ── Findings format instruction ───────────────────────────────

/**
 * Detailed findings format instruction.
 *
 * Tells reviewers to produce structured findings with file paths,
 * severity, recommendations with reasoning, and pseudocode. This
 * ensures review artifacts carry the same level of actionable detail
 * as implementation tasks.
 */
const FINDINGS_FORMAT_INSTRUCTION =
  "## Required findings format\n\n" +
  "Produce findings in this format. Every finding MUST include every " +
  "field below. Do not omit fields or collapse multiple issues into a " +
  "single finding.\n\n" +
  "### <severity>: <one-line summary>\n\n" +
  "- **File**: relative path to the file containing the issue\n" +
  "- **Lines**: line range or specific line(s) where the issue occurs\n" +
  "- **Role**: your reviewer role (e.g. correctness, security)\n" +
  "- **Observation**: what the code currently does on the filesystem; " +
  "be specific about the behaviour, value, or state you observed. " +
  "Include HOW you verified it (e.g. \"ls confirmed file exists\", " +
  "\"read showed line 42 contains...\")\n" +
  "- **Expected behavior**: (optional) what the code SHOULD do instead " +
  "of what it currently does. Useful when the correct behaviour is " +
  "clear from the plan or project conventions.\n" +
  "- **Impact**: concrete example of what goes wrong — who is affected, " +
  "under what conditions, and how severe the consequence is\n" +
  "- **Fix requirements**: (optional) concrete things a fix must " +
  "accomplish. E.g. \"must validate input before passing to SQL query\" " +
  "or \"must return 404 when resource not found\". Useful for the " +
  "fix-orchestrator to validate fixes.\n" +
  "- **Validation**: (optional) how to verify the fix works, e.g. a " +
  "test command or assertion that should pass after the fix.\n" +
  "- **Suggested approach**: (optional) optional hint for the fix " +
  "worker, such as which library function to use or which pattern " +
  "to follow.\n" +
  "- **Recommendation**: detailed explanation of the fix, including " +
  "your reasoning and professional opinion on the best approach\n" +
  "- **Pseudocode**: a code snippet illustrating the recommended " +
  "change. Use the actual types, function names, and patterns from " +
  "the codebase. Keep it concise but specific enough that a developer " +
  "can implement the fix without ambiguity\n" +
  "- **Plan adherence**: whether this issue represents a deviation " +
  "from the approved plan, and if so which specific plan section or " +
  "group it deviates from. Cite the plan document and section.\n\n" +
  "Example:\n\n" +
  "### major: Token verifier accepts missing sub claim\n\n" +
  "- **File**: src/adapters/zitadel/token_verifier.ts\n" +
  "- **Lines**: 193-194\n" +
  "- **Role**: correctness\n" +
  "- **Observation**: `verifyToken` returns `subject: payload.sub ?? ''` " +
  "instead of rejecting tokens that lack a `sub` claim.\n" +
  "- **Expected behavior**: Tokens with missing or empty `sub` should " +
  "be rejected before returning `VerifiedToken`. The `sub` claim is " +
  "mandatory per OIDC Core 1.0 §2.\n" +
  "- **Impact**: Two validly-signed tokens from the same issuer with " +
  "missing `sub` both resolve to the same identity key (`issuer + ''`), " +
  "causing user A's data to be served to user B.\n" +
  "- **Fix requirements**: Token parsing must throw a " +
  "`TokenValidationError` when `sub` is missing or empty. No fallback " +
  "to empty string.\n" +
  "- **Validation**: After the fix, a unit test that creates a token " +
  "without `sub` should expect `TokenValidationError` to be thrown.\n" +
  "- **Suggested approach**: Add an early validation check after " +
  "signature verification, before extracting claims.\n" +
  "- **Recommendation**: Reject tokens with missing or empty `sub` before " +
  "returning `VerifiedToken`. This is a hard identity invariant — the " +
  "subject claim is mandatory per OIDC Core 1.0 §2.\n" +
  "- **Pseudocode**:\n" +
  "  ```ts\n" +
  "  if (!payload.sub || payload.sub.trim().length === 0) {\n" +
  "    throw new TokenValidationError(\n" +
  "      'TOKEN_MALFORMED',\n" +
  "      'Token missing subject',\n" +
  "    )\n" +
  "  }\n" +
  "  ```\n" +
  "- **Plan adherence**: Deviates from plan §Group 1B — identity " +
  "resolution requires issuer+subject as a stable unique key.\n"

/**
 * Findings format instruction for external PR review (no plan adherence).
 *
 * External reviewers evaluate diff-only. Plan adherence is omitted because
 * no planning documents are provided.
 */
const PR_FINDINGS_FORMAT_INSTRUCTION =
  "## Required findings format\n\n" +
  "Produce findings in this format. Every finding MUST include every " +
  "field below. Do not omit fields or collapse multiple issues into a " +
  "single finding.\n\n" +
  "### <severity>: <one-line summary>\n\n" +
  "- **File**: relative path to the file containing the issue\n" +
  "- **Lines**: line range or specific line(s) where the issue occurs\n" +
  "- **Role**: your reviewer role (e.g. correctness, security)\n" +
  "- **Observation**: what the code currently does; be specific about " +
  "the behaviour, value, or state you observed in the diff\n" +
  "- **Expected behavior**: (optional) what the code SHOULD do instead " +
  "of what it currently does.\n" +
  "- **Impact**: concrete example of what goes wrong — who is affected, " +
  "under what conditions, and how severe the consequence is\n" +
  "- **Fix requirements**: (optional) concrete things a fix must " +
  "accomplish. Useful for the fix-orchestrator to validate fixes.\n" +
  "- **Validation**: (optional) how to verify the fix works, e.g. a " +
  "test command or assertion.\n" +
  "- **Suggested approach**: (optional) optional hint for the fix " +
  "worker.\n" +
  "- **Recommendation**: detailed explanation of the fix, including " +
  "your reasoning and professional opinion on the best approach\n" +
  "- **Pseudocode**: a code snippet illustrating the recommended " +
  "change. Use the actual types, function names, and patterns from " +
  "the codebase. Keep it concise but specific enough that a developer " +
  "can implement the fix without ambiguity\n\n" +
  "Example:\n\n" +
  "### major: Race condition in cache invalidation\n\n" +
  "- **File**: src/cache/memory_cache.ts\n" +
  "- **Lines**: 87-95\n" +
  "- **Role**: correctness\n" +
  "- **Observation**: `invalidate()` deletes the entry without holding " +
  "the read lock, so a concurrent `get()` can observe a partially-cleared map.\n" +
  "- **Expected behavior**: `invalidate()` should acquire the write lock " +
  "before modifying the internal map to prevent concurrent reads from " +
  "seeing a partially-cleared state.\n" +
  "- **Impact**: Under concurrent access, a cache miss is returned " +
  "instead of a stale-but-valid entry, causing unnecessary fetches.\n" +
  "- **Fix requirements**: The fix must use the existing `_rwLock` to " +
  "acquire write exclusivity during map modifications. Read locks should " +
  "not be held during writes.\n" +
  "- **Validation**: A concurrent access test that calls `get()` and " +
  "`invalidate()` simultaneously should never return a miss for a " +
  "previously cached key.\n" +
  "- **Suggested approach**: Wrap `this._store.delete(key)` and " +
  "`this._lru.delete(key)` in `this._rwLock.writeLock()`.\n" +
  "- **Recommendation**: Acquire the write lock before modifying the " +
  "internal map. The existing `_rwLock` can be upgraded via `writeLock()` " +
  "which is already available on the class.\n" +
  "- **Pseudocode**:\n" +
  "  ```ts\n" +
  "  invalidate(key: string): void {\n" +
  "    this._rwLock.writeLock(() => {\n" +
  "      this._store.delete(key)\n" +
  "      this._lru.delete(key)\n" +
  "    })\n" +
  "  }\n" +
  "  ```\n"

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
 *
 * This is the `review-pr` mode fragment from `prompt-fragments/modes/review-pr.md`
 * inlined so the extension does not need a filesystem dependency.
 */
const DEFAULT_DIFF_ONLY_INSTRUCTION =
  "# Mode: /zflow-review-pr\n\n" +
  "## Behaviour\n\n" +
  "External PR/MR diff review mode.\n\n" +
  "- **Diff-only review.** The review is based on the diff content fetched " +
  "from the PR/MR URL. Do not execute, check out, or run untrusted PR code " +
  "unless explicitly instructed by the user.\n" +
  "- **Never execute untrusted PR code by default.** If the user explicitly " +
  "requests execution (e.g. \"test this PR\"), treat it as a separate action " +
  "with appropriate safety warnings.\n" +
  "- **Findings must state verification limits.** Every finding should indicate " +
  "whether it was determined by static analysis, logical reasoning, observed " +
  "behaviour, or is an advisory opinion. Do not claim runtime verification for " +
  "static findings.\n\n" +
  "## Severity scheme\n\n" +
  "Use the following severity levels:\n" +
  "- **critical** — blocks approval; must be resolved\n" +
  "- **major** — should be resolved before merging\n" +
  "- **minor** — nice to fix, not blocking\n" +
  "- **nit** — optional suggestion\n" +
  "Do not use severity levels outside this scheme."

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

  // ── Review-only instruction ─────────────────────────────────
  parts.push(
    "## Mode: review only\n\n" +
    "REVIEW ONLY. Do not edit, write, modify, patch, or apply changes. " +
    "Return findings only. Do not attempt to fix the code yourself.\n",
  )

  // ── Filesystem-verification instruction ─────────────────────
  // Reviewers receive a git diff that may be stale (e.g. after a fix
  // run).  Claims about file existence, deletion, or retention MUST be
  // verified against the actual filesystem before being reported.
  parts.push(
    "## Filesystem verification REQUIRED — do not skip\n\n" +
    "The diff bundle below shows what changed in the original implementation, " +
    "but fixes may have been applied since then. **Every claim about a file's " +
    "existence, contents, or state must be verified against the actual " +
    "filesystem before you report it as a finding.**\n\n" +
    "### Mandatory verification checklist\n\n" +
    "- **Before reporting a file as \"missing\" or \"non-existent\":** Run " +
    "`ls <path>` or `read <path>`. If the file exists on disk, do NOT report " +
    "it as missing.\n" +
    "- **Before reporting a file/directory as \"retained\" or \"not deleted\":** " +
    "Run `ls <path>`. If the path does not exist on disk, do NOT report it as " +
    "retained.\n" +
    "- **Before reporting file contents as \"contains X\" or \"does Y\":** " +
    "Run `read <path>` to see the current state. Do not rely on the diff — " +
    "the file on disk may be different.\n" +
    "- **Evidence field must cite the verification:** Instead of repeating " +
    "the claim, say \"Verified via `ls <path>` — file does not exist\" or " +
    "\"Verified via `read <path>` — line 12 contains...\"\n" +
    "- **If you cannot verify a claim with `ls` or `read`:** Drop the " +
    "finding. Do not report unverifiable claims.\n",
  )

  // ── Plan-adherence instruction ──────────────────────────────
  parts.push(getPlanAdherenceInstruction())
  parts.push("")

  // ── Findings format instruction ─────────────────────────────
  parts.push(FINDINGS_FORMAT_INSTRUCTION)

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
  parts.push(
    "This diff shows what the ORIGINAL IMPLEMENTATION changed. Fixes may have " +
    "been applied since — always verify current state with `ls`/`read`.",
  )
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

  // Extract a file list from the diff for quick reference
  const fileList = [...new Set(
    diffContent
      .split("\n")
      .filter(l => l.startsWith("+++ ") || l.startsWith("--- "))
      .map(l => l.replace(/^[+-]{3} [ab]\//, ""))
      .filter(f => f !== "/dev/null")
  )].sort()
  if (fileList.length > 0) {
    parts.push("**Files touched by implementation:**")
    for (const f of fileList) {
      parts.push(`- \`${f}\``)
    }
    parts.push("")
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

  // ── Findings format (PR-specific, no plan adherence) ─────
  parts.push(PR_FINDINGS_FORMAT_INSTRUCTION)
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

      // ── Line map for this file (Phase 9) ──────────────────────
      // Include the line map so reviewers can reference correct line numbers
      const fileLineMap = file.lineMap ?? {}
      const lineMapEntries = Object.entries(fileLineMap)
      if (lineMapEntries.length > 0) {
        parts.push("**Line map (diff line → new file line):**")
        parts.push("")
        parts.push("| Diff line | New file line |")
        parts.push("|---:|---:|")
        const entriesToShow = lineMapEntries.length > 12
          ? [...lineMapEntries.slice(0, 6), ["...", "..."] as [string, string], ...lineMapEntries.slice(-6)]
          : lineMapEntries
        for (const [diffLine, fileLine] of entriesToShow) {
          parts.push(`| ${diffLine} | ${fileLine} |`)
        }
        parts.push("")
      }
    }
  }

  return Promise.resolve(parts.join("\n"))
}
