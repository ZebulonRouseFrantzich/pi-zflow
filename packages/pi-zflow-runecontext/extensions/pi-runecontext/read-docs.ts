/**
 * read-docs.ts — Canonical change-document reader for RuneContext flavors.
 *
 * Implements Phase 3 Task 3.3:
 * Load the correct set of canonical docs for planning, implementation,
 * and review from a resolved RuneContext change.
 *
 * Reading rules:
 *   - Always reads `status.yaml` (parsed as structured YAML)
 *   - Always reads `standards.md`
 *   - If `tasks.md` exists, uses it directly for task grouping/verification
 *   - If `tasks.md` does not exist (plain flavor), task group hints are
 *     derived from `proposal.md + design.md + verification.md`
 *   - Reads `references.md` when present (verified flavor)
 *
 * @module pi-zflow-runecontext/read-docs
 */

import * as fs from "node:fs/promises"
import * as yaml from "yaml"
import type { ResolvedRuneChange } from "./resolve-change.js"

// ── Types ────────────────────────────────────────────────────────

/** The raw text content of a single canonical change document. */
export type RuneDoc = string

/**
 * Structured status information parsed from `status.yaml`.
 *
 * At minimum contains a `status` field. Additional fields depend on
 * the RuneContext tooling version and project conventions.
 */
export interface RuneStatus {
  /** Current lifecycle status of the change (e.g. "draft", "active", "review", "completed"). */
  status: string
  /** Arbitrary additional fields present in the YAML. */
  [key: string]: unknown
}

/**
 * Canonical change documents loaded from a resolved RuneContext change.
 *
 * Every field is a raw document string except `status`, which is
 * parsed structured data. Optional fields are `null` when the
 * corresponding file does not exist for the detected flavor.
 */
export interface RuneDocs {
  /** The proposal document describing the change. */
  proposal: RuneDoc
  /** The design/architecture document. */
  design: RuneDoc
  /** Standards or conventions the change must follow. */
  standards: RuneDoc
  /** Verification criteria and test expectations. */
  verification: RuneDoc
  /** Parsed status metadata from status.yaml. */
  status: RuneStatus
  /**
   * Task grouping document (verified flavor only).
   * `null` for plain flavor changes.
   */
  tasks: RuneDoc | null
  /**
   * Reference documents (verified flavor only).
   * `null` for plain flavor changes.
   */
  references: RuneDoc | null
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Read a file's content as a UTF-8 string.
 *
 * @param filePath - Absolute path to the file.
 * @returns The file content.
 * @throws If the file cannot be read (e.g. missing, permissions).
 */
async function readFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf-8")
}

/**
 * Parse a YAML string into a structured object.
 *
 * Uses the `yaml` library parser which handles the common YAML subset
 * found in RuneContext status files (key-value mappings, basic scalars,
 * nested objects, arrays).
 *
 * @param yamlString - Raw YAML content.
 * @returns Parsed object (always a record).
 * @throws If the YAML content is invalid and cannot be parsed.
 */
function parseYaml(yamlString: string): RuneStatus {
  const parsed = yaml.parse(yamlString)

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "unknown" }
  }

  // Ensure `status` field exists — the RuneContext spec requires it.
  if (typeof (parsed as Record<string, unknown>).status !== "string") {
    ;(parsed as Record<string, unknown>).status = "unknown"
  }

  return parsed as RuneStatus
}

// ── Reader ───────────────────────────────────────────────────────

/**
 * Load all canonical documents from a resolved RuneContext change.
 *
 * This is the primary entry point for downstream consumers (planners,
 * implementers, reviewers) to access the authoritative change documents.
 *
 * The function reads every file referenced in `change.files` in
 * parallel. It does not validate existence — that is the responsibility
 * of `resolveRuneChange()` which guarantees all required files exist
 * before returning a `ResolvedRuneChange`.
 *
 * @param change - A fully resolved and validated RuneContext change.
 * @returns An object mapping each document role to its content.
 */
export async function readRuneContextDocs(
  change: ResolvedRuneChange,
): Promise<RuneDocs> {
  const files = change.files

  // Build the batch of read operations.
  // All always-present files are read unconditionally.
  const reads: Promise<string>[] = [
    readFile(files.proposal),
    readFile(files.design),
    readFile(files.standards),
    readFile(files.verification),
    readFile(files.status),
  ]

  // Conditionally read optional files based on flavor.
  // (The resolve-change step guarantees that if tasks is set for plain,
  // it's undefined; if set for verified, it exists.)
  if (files.tasks !== undefined) {
    reads.push(readFile(files.tasks))
  }
  if (files.references !== undefined) {
    reads.push(readFile(files.references))
  }

  // Execute all reads concurrently.
  const [
    proposal,
    design,
    standards,
    verification,
    statusRaw,
    ...optional
  ] = await Promise.all(reads)

  // Parse status.yaml separately — it's structured data.
  const status = parseYaml(statusRaw)

  // Unpack optional results (in the order they were pushed).
  let tasks: RuneDoc | null = null
  let references: RuneDoc | null = null

  let optIdx = 0
  if (files.tasks !== undefined) {
    tasks = optional[optIdx++] as string
  }
  if (files.references !== undefined) {
    references = optional[optIdx++] as string
  }

  return {
    proposal,
    design,
    standards,
    verification,
    status,
    tasks,
    references,
  }
}
