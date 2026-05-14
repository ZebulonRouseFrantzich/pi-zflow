/**
 * failure-log-helpers.ts — Failure-log readback helpers for planning context.
 *
 * Provides `loadRecentFailureLogEntries()` and `formatFailureLogReadback()`
 * for loading and formatting relevant failure-log entries before planning
 * similar tasks. Uses the existing `findRelevantFailures()` from failure-log.ts.
 *
 * ## Usage
 *
 * ```ts
 * import { loadRecentFailureLogEntries, formatFailureLogReadback }
 *   from "pi-zflow-change-workflows"
 *
 * const failures = await loadRecentFailureLogEntries({
 *   context: "config ownership",
 *   tags: ["plan-quality"],
 *   limit: 3,
 *   maxAge: 30,
 * })
 *
 * const summary = formatFailureLogReadback(failures)
 * // → "## Relevant past failures\n\n### ..."
 * ```
 *
 * @module pi-zflow-change-workflows/failure-log-helpers
 */

import { readFailureLog, findRelevantFailures } from "../extensions/zflow-change-workflows/failure-log.js"
import type { FailureLogEntry } from "../extensions/zflow-change-workflows/failure-log.js"

// ── Types ───────────────────────────────────────────────────────

/**
 * Options for loading recent relevant failure log entries.
 */
export interface FailureLogReadbackOptions {
  /** Free-text search context for keyword matching (e.g. "config ownership validation"). */
  context: string
  /** Optional root-cause tags to filter by (e.g. ["plan-quality", "verification-gap"]). */
  tags?: string[]
  /** Maximum number of entries to return. Default: 3. */
  limit?: number
  /** Maximum age in days. Default: 30. Pass 0 or Infinity to disable age filtering. */
  maxAge?: number
  /** Working directory (optional, for resolving runtime state dir). */
  cwd?: string
}

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Check whether an ISO-8601 timestamp is within `maxAgeDays` of the current time.
 *
 * @param timestamp - ISO-8601 timestamp string.
 * @param maxAgeDays - Maximum age in days.
 * @returns True if the timestamp is within the age limit or if maxAgeDays is falsy.
 */
function isWithinAgeLimit(timestamp: string, maxAgeDays: number | undefined): boolean {
  if (!maxAgeDays || maxAgeDays <= 0) return true

  const entryTime = new Date(timestamp).getTime()
  // If the timestamp is unparseable, include the entry (conservative)
  if (isNaN(entryTime)) return true

  const now = Date.now()
  const ageMs = now - entryTime
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000

  return ageMs <= maxAgeMs
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Load recent relevant failure log entries for context construction.
 *
 * Uses `findRelevantFailures()` for keyword matching, then applies
 * tag filtering and age filtering. Returns at most `limit` entries.
 *
 * @param options - Readback options including search context and filters.
 * @returns Array of matching `FailureLogEntry` objects, ordered by relevance.
 */
export async function loadRecentFailureLogEntries(
  options: FailureLogReadbackOptions,
): Promise<FailureLogEntry[]> {
  const {
    context,
    tags,
    limit = 3,
    maxAge = 30,
    cwd,
  } = options

  // Find relevant entries by keyword matching
  const relevant = await findRelevantFailures(context, cwd)

  if (relevant.length === 0) return []

  // Filter by tags if provided
  let filtered = relevant
  if (tags && tags.length > 0) {
    const tagSet = new Set(tags.map((t) => t.toLowerCase()))
    filtered = relevant.filter((entry) => {
      if (!entry.rootCause) return false
      return tagSet.has(entry.rootCause.toLowerCase())
    })
  }

  // Filter by age
  const ageFiltered = filtered.filter((entry) =>
    isWithinAgeLimit(entry.timestamp, maxAge),
  )

  // Return at most limit entries
  return ageFiltered.slice(0, limit)
}

/**
 * Format failure log entries into a concise readback summary string.
 *
 * Produces a markdown snippet with each entry's context, root cause,
 * and prevention recommendation. Total output is kept under 1000 characters.
 *
 * @param entries - Array of failure log entries to format.
 * @returns A formatted markdown string, or "No relevant past failures found."
 *          if the array is empty.
 */
export function formatFailureLogReadback(entries: FailureLogEntry[]): string {
  if (entries.length === 0) {
    return "No relevant past failures found."
  }

  const lines: string[] = ["## Relevant past failures", ""]

  for (const entry of entries) {
    lines.push(`### ${entry.context}`)
    if (entry.rootCause) {
      lines.push(`- **Root cause**: ${entry.rootCause}`)
    }
    if (entry.prevention) {
      lines.push(`- **Prevention**: ${entry.prevention}`)
    }
    if (entry.fixApplied) {
      lines.push(`- **Fix applied**: ${entry.fixApplied}`)
    }
    lines.push("")
  }

  let output = lines.join("\n")

  // Enforce 1000 character limit — trim entries from the end if needed
  if (output.length > 1000) {
    // Cut to the last complete entry within 1000 chars
    const safe = output.slice(0, 1000)
    const lastBreak = safe.lastIndexOf("\n### ")
    if (lastBreak > 0) {
      output = output.slice(0, lastBreak) + "\n\n_(additional entries omitted for length)_\n"
    } else {
      // Fallback: hard truncate
      output = output.slice(0, 997) + "..."
    }
  }

  return output
}
