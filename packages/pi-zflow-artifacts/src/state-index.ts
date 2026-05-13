/**
 * state-index.ts — Runtime state index for pi-zflow artifacts.
 *
 * Durable CRUD helpers for `<runtime-state-dir>/state-index.json`.
 * Tracks plan IDs, run IDs, review IDs, deviations, and artifacts
 * with their current status. Used by cleanup policies and the
 * `/zflow-clean` command to discover stale entries.
 *
 * ## Usage
 *
 * ```ts
 * import { addStateIndexEntry, listStateIndexEntries } from "pi-zflow-artifacts/state-index"
 *
 * await addStateIndexEntry({ type: "run", id: runId, status: "pending" })
 * const runs = await listStateIndexEntries({ type: "run" })
 * ```
 *
 * @module pi-zflow-artifacts/state-index
 */

import * as path from "node:path"
import * as fs from "node:fs/promises"
import { resolveStateIndexPath } from "./artifact-paths.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single entry in the state index.
 */
export interface StateIndexEntry {
  /** Entry type */
  type: "plan" | "run" | "review" | "deviation" | "artifact"
  /** Unique identifier */
  id: string
  /** Current status (e.g. "pending", "running", "completed", "failed", "drift-pending") */
  status: string
  /** ISO timestamp when the entry was created */
  createdAt: string
  /** ISO timestamp when the entry was last updated */
  updatedAt: string
  /** Optional metadata for richer queries */
  metadata?: Record<string, unknown>
}

/**
 * The full state index document.
 */
export interface StateIndex {
  /** Schema version for forward-compatibility */
  version: number
  /** All tracked entries */
  entries: StateIndexEntry[]
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_INDEX: StateIndex = {
  version: 1,
  entries: [],
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

/**
 * Load the state index from disk.
 *
 * Reads `<runtime-state-dir>/state-index.json`. Returns the default empty
 * index if the file does not exist or is malformed.
 *
 * @param cwd - Working directory (optional, for resolving runtime state dir).
 * @returns The loaded or default StateIndex.
 */
export async function loadStateIndex(cwd?: string): Promise<StateIndex> {
  const indexPath = resolveStateIndexPath(cwd)
  try {
    const raw = await fs.readFile(indexPath, "utf-8")
    const parsed = JSON.parse(raw) as StateIndex
    // Defensive: ensure version and entries exist
    if (typeof parsed.version !== "number") parsed.version = DEFAULT_INDEX.version
    if (!Array.isArray(parsed.entries)) parsed.entries = []
    return parsed
  } catch (err: unknown) {
    // ENOENT or parse error — return default
    return { ...DEFAULT_INDEX, entries: [...DEFAULT_INDEX.entries] }
  }
}

/**
 * Save the state index to disk atomically.
 *
 * Writes to a `.tmp` file first, then renames to the canonical path to
 * avoid partial writes or corruption.
 *
 * @param index - The state index to persist.
 * @param cwd - Working directory (optional).
 */
export async function saveStateIndex(index: StateIndex, cwd?: string): Promise<void> {
  const indexPath = resolveStateIndexPath(cwd)
  const tmpPath = indexPath + ".tmp"
  const json = JSON.stringify(index, null, 2)

  // Ensure the parent directory exists
  await fs.mkdir(path.dirname(indexPath), { recursive: true })

  // Atomic write
  await fs.writeFile(tmpPath, json, "utf-8")
  await fs.rename(tmpPath, indexPath)
}

/**
 * Add a new entry to the state index.
 *
 * @param entry - The entry to append. `createdAt` and `updatedAt` are set
 *                automatically if not provided.
 * @param cwd - Working directory (optional).
 */
export async function addStateIndexEntry(
  entry: Omit<StateIndexEntry, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string },
  cwd?: string,
): Promise<void> {
  const index = await loadStateIndex(cwd)
  const now = new Date().toISOString()

  const newEntry: StateIndexEntry = {
    ...entry,
    createdAt: entry.createdAt ?? now,
    updatedAt: entry.updatedAt ?? now,
  }

  index.entries.push(newEntry)
  await saveStateIndex(index, cwd)
}

/**
 * Update an existing entry in the state index by ID.
 *
 * Finds the first entry with matching `id`. Applies partial updates and
 * resets `updatedAt` to the current time.
 *
 * @param id - The unique identifier of the entry to update.
 * @param updates - Partial fields to merge into the existing entry.
 * @param cwd - Working directory (optional).
 */
export async function updateStateIndexEntry(
  id: string,
  updates: Partial<Omit<StateIndexEntry, "createdAt" | "id">>,
  cwd?: string,
): Promise<void> {
  const index = await loadStateIndex(cwd)
  const entry = index.entries.find((e) => e.id === id)
  if (!entry) {
    throw new Error(`State index entry not found: ${id}`)
  }

  Object.assign(entry, updates, { updatedAt: new Date().toISOString() })
  await saveStateIndex(index, cwd)
}

/**
 * List entries in the state index, optionally filtered by type and/or status.
 *
 * @param options - Optional filters.
 * @param cwd - Working directory (optional).
 * @returns A copy of matching entries.
 */
export async function listStateIndexEntries(
  options?: { type?: string; status?: string },
  cwd?: string,
): Promise<StateIndexEntry[]> {
  const index = await loadStateIndex(cwd)
  let entries = index.entries

  if (options?.type) {
    entries = entries.filter((e) => e.type === options.type)
  }
  if (options?.status) {
    entries = entries.filter((e) => e.status === options.status)
  }

  return [...entries] // return a copy
}

/**
 * Remove an entry from the state index by ID.
 *
 * @param id - The unique identifier of the entry to remove.
 * @param cwd - Working directory (optional).
 */
export async function removeStateIndexEntry(
  id: string,
  cwd?: string,
): Promise<void> {
  const index = await loadStateIndex(cwd)
  const before = index.entries.length
  index.entries = index.entries.filter((e) => e.id !== id)
  if (index.entries.length === before) {
    throw new Error(`State index entry not found: ${id}`)
  }
  await saveStateIndex(index, cwd)
}
