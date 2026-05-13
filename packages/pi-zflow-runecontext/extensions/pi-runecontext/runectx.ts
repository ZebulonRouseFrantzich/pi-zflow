import * as fs from "node:fs/promises"
import * as path from "node:path"

/**
 * runectx.ts — Conservative status mapping and write-back helpers for RuneContext integration.
 *
 * Implements Phase 3 Task 3.6:
 * Support optional status synchronisation without corrupting canonical
 * `status.yaml` semantics.
 *
 * Status mapping policy (from the phase design):
 *
 * | Harness state       | Write-back policy            |
 * |---------------------|------------------------------|
 * | draft               | runtime-only by default      |
 * | validated           | runtime-only by default      |
 * | reviewed            | runtime-only by default      |
 * | approved            | prompt (preview then write)  |
 * | executing, drifted, | runtime-only                 |
 * | superseded          |                              |
 * | completed           | prompt (preview then write)  |
 * | cancelled           | runtime-only unless schema   |
 * |                     | equivalent exists            |
 *
 * Core rule: If the vocabulary is ambiguous, preserve `status.yaml` and
 * store richer state only in runtime metadata. Never silently mutate
 * RuneContext docs. The default write-back mode is `prompt` — the caller
 * must decide before any canonical write occurs.
 *
 * @module pi-zflow-runecontext/runectx
 */

// ── Types ────────────────────────────────────────────────────────

/**
 * Harness workflow states.
 *
 * These represent the lifecycle of a plan or task within the pi-zflow
 * harness. Not all states correspond directly to RuneContext status
 * values; some map to runtime-only metadata.
 */
export type HarnessState =
  | "draft"
  | "validated"
  | "reviewed"
  | "approved"
  | "executing"
  | "drifted"
  | "superseded"
  | "completed"
  | "cancelled"

/**
 * Write-back policy for a given harness state.
 *
 * - `"runtime-only"`: Do not write to canonical `status.yaml`. State is
 *   stored only in runtime metadata (e.g. plan-state.json).
 * - `"prompt"`: Offer the operator a write-back preview. Write only after
 *   explicit approval and only if the target status value is recognised
 *   by the project's `status.yaml` schema.
 * - `"auto"`: Automatically write to canonical `status.yaml` without
 *   prompting (reserved for future use; not the default).
 */
export type WriteBackPolicy = "runtime-only" | "prompt" | "auto"

/**
 * Result of mapping a harness state to a RuneContext status.
 *
 * Contains the mapped status value (or `null` for runtime-only states),
 * the applicable write-back policy, and a human-readable explanation of
 * the mapping decision.
 */
export interface StatusMappingResult {
  /**
   * The mapped RuneContext status value, or `null` if the mapping policy
   * is runtime-only (no canonical write-back should occur).
   */
  mappedStatus: string | null
  /** The write-back policy for this transition. */
  policy: WriteBackPolicy
  /** Human-readable explanation of the mapping decision. */
  reason: string
}

/**
 * Vocabulary from a project's `status.yaml` schema.
 *
 * Describes the set of status values that the project's canonical
 * schema recognises. Used to validate whether a mapped status value
 * would be compatible before attempting a write-back.
 */
export interface StatusVocabulary {
  /**
   * Known status values in the project's `status.yaml` schema.
   * An empty array indicates the vocabulary is unknown or unrestricted.
   */
  allowedStatuses: string[]
}

/**
 * A pending or approved amendment to canonical RuneContext docs.
 *
 * Captures the document-level changes that should be written back
 * to the canonical RuneContext change folder once approved.
 */
export interface RuneContextAmendment {
  /** The change this amendment targets. */
  changeId: string
  /** Absolute path to the change folder. */
  changePath: string
  /** Document changes to apply (key = filename, value = new content). */
  docChanges: Record<string, string>
  /** The harness state that triggered this amendment. */
  triggerState: HarnessState
  /** ISO timestamp of when the amendment was created. */
  createdAt: string
  /** Whether this amendment has been approved for write-back. */
  approved: boolean
}

/**
 * Result of attempting to write back an approved amendment.
 *
 * Reports per-file success/failure and a human-readable summary.
 */
export interface WriteBackResult {
  /** Whether the write-back succeeded (all files written). */
  success: boolean
  /** Files that were written successfully. */
  writtenFiles: string[]
  /** Files that failed to write (with error messages). */
  failedFiles: Array<{ path: string; error: string }>
  /** Whether the write-back was deferred (approval not yet granted). */
  deferred: boolean
  /** Human-readable summary of the outcome. */
  summary: string
}

// ── Mapping helpers ──────────────────────────────────────────────

/**
 * Determine whether a status value is present in the project's vocabulary.
 *
 * When `allowedStatuses` is empty, the vocabulary is considered unknown
 * and every value is accepted (actual validation would occur at write
 * time by the RuneContext tooling).
 *
 * @param value - The status value to check.
 * @param vocabulary - The project's status vocabulary.
 * @returns `true` if the value is allowed or vocabulary is unrestricted.
 */
function isAllowedStatus(value: string, vocabulary: StatusVocabulary): boolean {
  if (vocabulary.allowedStatuses.length === 0) {
    // Unknown/unrestricted vocabulary — defer to runtime validation.
    return true
  }
  return vocabulary.allowedStatuses.includes(value)
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Map a harness workflow state to a RuneContext status value.
 *
 * The mapping is intentionally conservative:
 *   - States like `draft`, `validated`, `reviewed` are runtime-only
 *     because they have no direct RuneContext canonical equivalent.
 *   - `approved` and `completed` use a `prompt` policy — they can be
 *     written back but only after the operator has seen a preview and
 *     explicitly approved the write.
 *   - `cancelled` is runtime-only unless the project schema explicitly
 *     declares a "cancelled" status value.
 *
 * @param harnessState - The current harness workflow state.
 * @param vocabulary - The project's `status.yaml` vocabulary.
 * @returns A mapping result describing the mapped status, policy, and
 *          reasoning.
 */
export function mapHarnessStateToRuneStatus(
  harnessState: HarnessState,
  vocabulary: StatusVocabulary,
): StatusMappingResult {
  switch (harnessState) {
    case "draft": {
      return {
        mappedStatus: null,
        policy: "runtime-only",
        reason:
          'Harness state "draft" has no direct RuneContext canonical equivalent; stored in runtime metadata only.',
      }
    }

    case "validated": {
      return {
        mappedStatus: null,
        policy: "runtime-only",
        reason:
          'Harness state "validated" has no direct RuneContext canonical equivalent; stored in runtime metadata only.',
      }
    }

    case "reviewed": {
      return {
        mappedStatus: null,
        policy: "runtime-only",
        reason:
          'Harness state "reviewed" has no direct RuneContext canonical equivalent; stored in runtime metadata only.',
      }
    }

    case "approved": {
      if (isAllowedStatus("approved", vocabulary)) {
        return {
          mappedStatus: "approved",
          policy: "prompt",
          reason:
            'Harness state "approved" maps to RuneContext status "approved". Write-back offered as preview; requires explicit operator approval.',
        }
      }
      return {
        mappedStatus: null,
        policy: "runtime-only",
        reason:
          'Harness state "approved" has no corresponding status in the project schema; stored in runtime metadata only.',
      }
    }

    case "executing": {
      return {
        mappedStatus: null,
        policy: "runtime-only",
        reason:
          'Harness state "executing" is a runtime state; no canonical RuneContext write-back defined.',
      }
    }

    case "drifted": {
      return {
        mappedStatus: null,
        policy: "runtime-only",
        reason:
          'Harness state "drifted" is a runtime state; no canonical RuneContext write-back defined.',
      }
    }

    case "superseded": {
      return {
        mappedStatus: null,
        policy: "runtime-only",
        reason:
          'Harness state "superseded" is a runtime state; no canonical RuneContext write-back defined.',
      }
    }

    case "completed": {
      // Try "implemented" first (RuneContext convention), fall back to "completed".
      const candidate =
        isAllowedStatus("implemented", vocabulary)
          ? "implemented"
          : isAllowedStatus("completed", vocabulary)
            ? "completed"
            : null

      if (candidate !== null) {
        return {
          mappedStatus: candidate,
          policy: "prompt",
          reason:
            `Harness state "completed" maps to RuneContext status "${candidate}". ` +
            "Write-back offered as preview; requires explicit operator approval.",
        }
      }
      return {
        mappedStatus: null,
        policy: "runtime-only",
        reason:
          'Harness state "completed" has no corresponding status ("implemented" or "completed") in the project schema; stored in runtime metadata only.',
      }
    }

    case "cancelled": {
      if (isAllowedStatus("cancelled", vocabulary)) {
        return {
          mappedStatus: "cancelled",
          policy: "runtime-only",
          reason:
            'Harness state "cancelled" maps to RuneContext status "cancelled", but write-back is runtime-only by default. Use explicit configuration to enable canonical write-back.',
        }
      }
      return {
        mappedStatus: null,
        policy: "runtime-only",
        reason:
          'Harness state "cancelled" has no corresponding status in the project schema; stored in runtime metadata only.',
      }
    }

    default: {
      // Exhaustiveness guard — ensures all HarnessState variants are handled.
      const _exhaustive: never = harnessState
      return _exhaustive
    }
  }
}

/**
 * Build a runtime metadata object for the given harness state.
 *
 * This is the primary mechanism for preserving richer state when
 * write-back is runtime-only. The returned object can be stored in
 * runtime artifacts (e.g. plan-state.json) without touching canonical
 * RuneContext docs.
 *
 * @param harnessState - The current harness workflow state.
 * @param extra - Optional extra fields to include in the metadata.
 * @returns A plain object containing the harness state, a timestamp,
 *          and any extra fields.
 */
export function buildRuntimeMetadata(
  harnessState: HarnessState,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    harnessState,
    timestamp: new Date().toISOString(),
  }

  if (extra !== undefined) {
    for (const [key, value] of Object.entries(extra)) {
      metadata[key] = value
    }
  }

  return metadata
}

/**
 * Determine whether a mapping result warrants offering a write-back preview.
 *
 * Returns `true` when the policy is `"prompt"` or `"auto"`, indicating
 * that the caller should offer the operator a write-back preview (for
 * `"prompt"`) or proceed with automatic write-back (for `"auto"`).
 *
 * Returns `false` when the policy is `"runtime-only"` — no write-back
 * should be offered or performed.
 *
 * @param result - The status mapping result to check.
 * @returns `true` if a write-back preview (or automatic write) is
 *          appropriate.
 */
export function shouldOfferWriteBack(result: StatusMappingResult): boolean {
  return result.policy === "prompt" || result.policy === "auto"
}

// ── Amendment flow ───────────────────────────────────────────────

/**
 * Create a new amendment for a set of document changes.
 *
 * The amendment is created with `approved: false` — it must be
 * explicitly approved via {@link approveAmendment} before it can be
 * written back via {@link writeApprovedAmendment}.
 *
 * This function does NOT write anything to disk; it only constructs
 * the amendment object. Write-back is handled separately by
 * {@link writeApprovedAmendment}.
 *
 * @param changeId - Identifier for the change this amendment targets.
 * @param changePath - Absolute path to the change folder.
 * @param docChanges - Map of filenames to new file content.
 * @param triggerState - The harness state that triggered the amendment.
 * @returns A new {@link RuneContextAmendment} with `approved: false`.
 */
export function createAmendment(
  changeId: string,
  changePath: string,
  docChanges: Record<string, string>,
  triggerState: HarnessState,
): RuneContextAmendment {
  return {
    changeId,
    changePath,
    docChanges,
    triggerState,
    createdAt: new Date().toISOString(),
    approved: false,
  }
}

/**
 * Mark an amendment as approved for write-back.
 *
 * Returns a new {@link RuneContextAmendment} with `approved: true`.
 * The original amendment object is not mutated.
 *
 * @param amendment - The amendment to approve.
 * @returns A copy of the amendment with `approved: true`.
 */
export function approveAmendment(
  amendment: RuneContextAmendment,
): RuneContextAmendment {
  return {
    ...amendment,
    approved: true,
  }
}

/**
 * Write an approved amendment's document changes to disk.
 *
 * For each entry in `amendment.docChanges`, writes the content to
 * `<amendment.changePath>/<filename>`. If the amendment has not been
 * approved (`amendment.approved` is `false`), returns a deferred result
 * without writing anything.
 *
 * Canonical-doc write-back happens BEFORE derived artifact regeneration.
 * This function performs only the write-back; regeneration is an
 * orchestration concern for later phases.
 *
 * @param amendment - The amendment to write back (must be approved).
 * @returns A {@link WriteBackResult} describing what was written, what
 *          failed, and whether the write was deferred.
 */
export async function writeApprovedAmendment(
  amendment: RuneContextAmendment,
): Promise<WriteBackResult> {
  // ── Guard: amendment must be approved ──────────────────────────
  if (!amendment.approved) {
    return {
      success: false,
      writtenFiles: [],
      failedFiles: [],
      deferred: true,
      summary: `Write-back deferred: amendment for change "${amendment.changeId}" has not been approved yet.`,
    }
  }

  // ── Enforce canonical-doc write-back rule ──────────────────────
  // Derived artifact regeneration MUST happen after canonical-doc
  // write-back. That orchestration is handled by the caller.

  const writtenFiles: string[] = []
  const failedFiles: Array<{ path: string; error: string }> = []

  for (const [filename, content] of Object.entries(amendment.docChanges)) {
    const targetPath = path.join(amendment.changePath, filename)

    try {
      await fs.writeFile(targetPath, content, "utf-8")
      writtenFiles.push(targetPath)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err)
      failedFiles.push({ path: targetPath, error: message })
    }
  }

  const success = failedFiles.length === 0
  const summary = success
    ? `Successfully wrote ${writtenFiles.length} file(s) for change "${amendment.changeId}".`
    : `Wrote ${writtenFiles.length} file(s) but ${failedFiles.length} file(s) failed for change "${amendment.changeId}".`

  return {
    success,
    writtenFiles,
    failedFiles,
    deferred: false,
    summary,
  }
}
