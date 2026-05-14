/**
 * failure-log.ts — Structured failure log read, search, and append.
 *
 * Provides structured entry parsing and writing for the failure log at
 * `<runtime-state-dir>/failure-log.md`. Works alongside the simpler
 * `appendFailureLog()` in verification.ts (which writes unstructured entries).
 *
 * ## Entry format
 *
 * Each entry in the log follows this markdown structure:
 *
 * ```markdown
 * ## <ISO-timestamp>: <context>
 * - **Expected**: <description>
 * - **Actual**: <description>
 * - **Root cause**: <classification>
 * - **Fix applied**: <description>
 * - **Prevention**: <recommendation>
 * ```
 *
 * All fields except `- **Expected**` are optional per entry.
 *
 * ## Usage
 *
 * ```ts
 * import { appendFailureEntry, readFailureLog, findRelevantFailures } from "./failure-log.js"
 *
 * await appendFailureEntry({
 *   timestamp: new Date().toISOString(),
 *   context: "Apply-back conflict on auth task group",
 *   expected: "group patch applies cleanly after Group 1",
 *   actual: "git apply --3way failed on src/auth/config.ts",
 *   rootCause: "plan-quality",
 *   fixApplied: "revised execution groups to make config changes sequential",
 *   prevention: "validate overlapping config ownership during plan validation",
 * })
 *
 * const entries = await readFailureLog()
 * const relevant = await findRelevantFailures("config ownership plan quality")
 * ```
 *
 * @module pi-zflow-change-workflows/failure-log
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import { resolveFailureLogPath } from "pi-zflow-artifacts/artifact-paths"

// ── Types ───────────────────────────────────────────────────────

/**
 * A single structured entry in the failure log.
 */
export interface FailureLogEntry {
  /** ISO-8601 timestamp of the failure event. */
  timestamp: string
  /** Short human-readable context (e.g. "Apply-back conflict on auth task group"). */
  context: string
  /** What was expected to happen. */
  expected?: string
  /** What actually happened. */
  actual?: string
  /** Root-cause classification (e.g. "plan-quality", "verification", "tool-limitation"). */
  rootCause?: string
  /** Description of the fix that was applied. */
  fixApplied?: string
  /** Prevention recommendation for future planning. */
  prevention?: string
}

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Known field keys that can appear in a failure log entry body.
 * Maps the markdown label to the interface property name.
 */
const FIELD_LABEL_TO_KEY: Record<string, keyof FailureLogEntry> = {
  "Expected": "expected",
  "Actual": "actual",
  "Root cause": "rootCause",
  "Fix applied": "fixApplied",
  "Prevention": "prevention",
}

/**
 * Regex to match a field line: `- **<Label>**: <value>`
 */
const FIELD_RE = /^-\s+\*\*([^*]+)\*\*:\s*(.*)$/

// ── Public API ──────────────────────────────────────────────────

/**
 * Read and parse all structured entries from the failure log.
 *
 * Returns an empty array if the log file does not exist or is empty.
 *
 * @param cwd - Working directory (optional, for resolving runtime state dir).
 * @returns Array of parsed `FailureLogEntry` objects.
 */
export async function readFailureLog(cwd?: string): Promise<FailureLogEntry[]> {
  const logPath = resolveFailureLogPath(cwd)

  try {
    const content = await fs.readFile(logPath, "utf-8")
    return parseFailureLog(content)
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException
    if (nodeErr.code === "ENOENT") {
      return []
    }
    // Re-throw unexpected errors (permissions, etc.)
    throw err
  }
}

/**
 * Parse raw failure log markdown content into structured entries.
 *
 * Each entry starts with `## <ISO-timestamp>: <context>` followed by
 * zero or more `- **<Field>**: <value>` lines.
 *
 * @param content - Raw markdown content of the failure log.
 * @returns Array of parsed entries.
 */
export function parseFailureLog(content: string): FailureLogEntry[] {
  const entries: FailureLogEntry[] = []

  // Split on `## ` headers (entry boundaries). The split produces
  // chunks where the first element is leading content before the
  // first `## ` (which we skip), and each subsequent chunk starts
  // with the header line.
  const sections = content.split(/^## /m).filter(Boolean)

  for (const section of sections) {
    const trimmed = section.trim()
    if (!trimmed) continue

    const lines = trimmed.split("\n")
    const headerLine = lines[0] ?? ""

    // Parse header: `<timestamp>: <context>`
    // Timestamp is everything up to the first `: ` or the whole line.
    const colonIdx = headerLine.indexOf(": ")
    const timestamp = colonIdx >= 0 ? headerLine.slice(0, colonIdx).trim() : headerLine.trim()
    const context = colonIdx >= 0 ? headerLine.slice(colonIdx + 2).trim() : ""

    if (!timestamp) continue

    const entry: FailureLogEntry = {
      timestamp,
      context: context || "unknown",
    }

    // Parse field lines
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue

      const match = line.match(FIELD_RE)
      if (match) {
        const label = match[1].trim()
        const value = match[2].trim()
        const key = FIELD_LABEL_TO_KEY[label]
        if (key && value) {
          ;(entry as unknown as Record<string, unknown>)[key] = value
        }
      }
      // Lines that are not field markers are silently ignored (e.g.,
      // continuation lines, blank lines between entries).
    }

    entries.push(entry)
  }

  return entries
}

/**
 * Find relevant past failures whose context, root cause, or fix
 * matches given keywords.
 *
 * This is the "read-before-similar-task" primitive. Callers use it
 * before planning similar tasks to surface lessons learned.
 *
 * @param context - Free-text search context (e.g. "config ownership validation").
 * @param cwd - Working directory (optional, for resolving runtime state dir).
 * @returns Matching entries, ordered newest-first.
 */
export async function findRelevantFailures(
  context: string,
  cwd?: string,
): Promise<FailureLogEntry[]> {
  const entries = await readFailureLog(cwd)
  if (entries.length === 0) return []

  // Build search keywords from the query (words longer than 3 chars)
  const keywords = context
    .toLowerCase()
    .split(/\s+/)
    .filter((k) => k.length > 3)

  if (keywords.length === 0) return []

  // Score each entry by how many keywords appear in its searchable text
  const scored = entries
    .map((entry) => {
      const searchable = [
        entry.context,
        entry.rootCause ?? "",
        entry.fixApplied ?? "",
        entry.prevention ?? "",
        entry.expected ?? "",
        entry.actual ?? "",
      ]
        .join(" ")
        .toLowerCase()

      const matchCount = keywords.filter((kw) => searchable.includes(kw)).length
      return { entry, score: matchCount }
    })
    .filter(({ score }) => score > 0)

  // Sort by score descending, then by timestamp descending
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return b.entry.timestamp.localeCompare(a.entry.timestamp)
  })

  return scored.map(({ entry }) => entry)
}

/**
 * Append a structured failure entry to the log file.
 *
 * Writes in the standard markdown format that `readFailureLog` and
 * `parseFailureLog` can parse back.
 *
 * Creates the file and parent directory if they do not exist.
 *
 * @param entry - The structured entry to append.
 * @param cwd - Working directory (optional).
 */
export async function appendFailureEntry(
  entry: FailureLogEntry,
  cwd?: string,
): Promise<void> {
  const logPath = resolveFailureLogPath(cwd)
  const lines: string[] = [
    `## ${entry.timestamp}: ${entry.context}`,
  ]

  if (entry.expected) lines.push(`- **Expected**: ${entry.expected}`)
  if (entry.actual) lines.push(`- **Actual**: ${entry.actual}`)
  if (entry.rootCause) lines.push(`- **Root cause**: ${entry.rootCause}`)
  if (entry.fixApplied) lines.push(`- **Fix applied**: ${entry.fixApplied}`)
  if (entry.prevention) lines.push(`- **Prevention**: ${entry.prevention}`)
  lines.push("") // trailing blank line separates entries

  const content = lines.join("\n")

  try {
    await fs.appendFile(logPath, content, "utf-8")
  } catch (err: unknown) {
    // ENOENT → directory doesn't exist yet; create and retry
    const nodeErr = err as NodeJS.ErrnoException
    if (nodeErr.code === "ENOENT") {
      await fs.mkdir(path.dirname(logPath), { recursive: true })
      await fs.appendFile(logPath, content, "utf-8")
    } else {
      throw err
    }
  }
}

/**
 * Format an array of failure log entries as a human-readable markdown string.
 *
 * Useful for display in HITL interaction prompts or session reminders.
 *
 * @param entries - Entries to format.
 * @returns A markdown string (one section per entry).
 */
export function formatFailureLogEntries(entries: FailureLogEntry[]): string {
  if (entries.length === 0) return "No failure log entries found."

  return entries
    .map((entry) => {
      const lines: string[] = [`### ${entry.timestamp}: ${entry.context}`]
      if (entry.expected) lines.push(`- Expected: ${entry.expected}`)
      if (entry.actual) lines.push(`- Actual: ${entry.actual}`)
      if (entry.rootCause) lines.push(`- Root cause: ${entry.rootCause}`)
      if (entry.fixApplied) lines.push(`- Fix: ${entry.fixApplied}`)
      if (entry.prevention) lines.push(`- Prevention: ${entry.prevention}`)
      return lines.join("\n")
    })
    .join("\n\n")
}
