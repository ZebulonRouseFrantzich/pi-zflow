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
