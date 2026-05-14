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
 * Per-change lifecycle tracking.
 *
 * Tracks the full lifecycle of a change across all its runs, worktrees,
 * and artifacts. Used by cleanup policies, resume detection, and HITL
 * resume prompts.
 */
export interface ChangeLifecycle {
  /** Unique change identifier (kebab-case). */
  changeId: string
  /** Last known phase of the change workflow. */
  lastPhase: "draft" | "validated" | "reviewed" | "approved" | "executing" | "drifted" | "superseded" | "completed" | "cancelled"
  /** Run IDs that are not yet completed or abandoned. */
  unfinishedRuns: string[]
  /** Worktree paths retained for inspection. */
  retainedWorktrees: string[]
  /** Known artifact paths for this change. */
  artifactPaths: string[]
  /** Cleanup metadata for stale-artifact policies. */
  cleanupMetadata: {
    /** ISO timestamp when artifacts became stale. */
    staleSince?: string
    /** Number of days to retain artifacts. */
    retentionDays?: number
    /** Whether this is a dry-run preview. */
    dryRunPreview?: boolean
  }
}

/**
 * The full state index document.
 */
export interface StateIndex {
  /** Schema version for forward-compatibility */
  version: number
  /** All tracked entries */
  entries: StateIndexEntry[]
  /** Per-change lifecycle records, keyed by changeId. */
  changes: Record<string, ChangeLifecycle>
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_INDEX: StateIndex = {
  version: 2,
  entries: [],
  changes: {},
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
    // Defensive: ensure required fields exist
    if (typeof parsed.version !== "number") parsed.version = DEFAULT_INDEX.version
    if (!Array.isArray(parsed.entries)) parsed.entries = []
    if (!parsed.changes || typeof parsed.changes !== "object" || Array.isArray(parsed.changes)) {
      parsed.changes = {}
    }
    return parsed
  } catch (err: unknown) {
    // ENOENT: file doesn't exist yet — return default
    // Other errors (corruption, permissions): re-throw so they are surfaced
    const nodeErr = err as NodeJS.ErrnoException
    if (nodeErr.code === "ENOENT") {
      return { ...DEFAULT_INDEX, entries: [...DEFAULT_INDEX.entries] }
    }
    throw err
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

// ---------------------------------------------------------------------------
// Change lifecycle CRUD
// ---------------------------------------------------------------------------

/**
 * Insert or update a change lifecycle record.
 *
 * Adds the record to the `changes` map keyed by `changeLifecycle.changeId`.
 * If a record already exists for that changeId, it is merged with the
 * provided fields (shallow merge, with arrays replaced wholesale).
 *
 * @param changeLifecycle - The change lifecycle data to upsert.
 * @param cwd - Working directory (optional).
 */
export async function upsertChangeLifecycle(
  changeLifecycle: ChangeLifecycle,
  cwd?: string,
): Promise<void> {
  const index = await loadStateIndex(cwd)
  const existing = index.changes[changeLifecycle.changeId]

  if (existing) {
    // Merge: keep existing fields that aren't overwritten
    index.changes[changeLifecycle.changeId] = {
      ...existing,
      ...changeLifecycle,
    }
  } else {
    index.changes[changeLifecycle.changeId] = { ...changeLifecycle }
  }

  await saveStateIndex(index, cwd)
}

/**
 * Retrieve a change lifecycle record by changeId.
 *
 * @param changeId - The change identifier to look up.
 * @param cwd - Working directory (optional).
 * @returns The ChangeLifecycle, or `null` if not found.
 */
export async function getChangeLifecycle(
  changeId: string,
  cwd?: string,
): Promise<ChangeLifecycle | null> {
  const index = await loadStateIndex(cwd)
  return index.changes[changeId] ?? null
}

/**
 * Remove a change lifecycle record by changeId.
 *
 * @param changeId - The change identifier to remove.
 * @param cwd - Working directory (optional).
 * @throws If no record exists for the given changeId.
 */
export async function removeChangeLifecycle(
  changeId: string,
  cwd?: string,
): Promise<void> {
  const index = await loadStateIndex(cwd)
  if (!index.changes[changeId]) {
    throw new Error(`Change lifecycle not found: ${changeId}`)
  }
  delete index.changes[changeId]
  await saveStateIndex(index, cwd)
}

/**
 * List all change lifecycle records that have unfinished runs.
 *
 * A change is considered unfinished when its `unfinishedRuns` array
 * is non-empty.
 *
 * @param cwd - Working directory (optional).
 * @returns Array of ChangeLifecycle records with non-empty unfinishedRuns.
 */
export async function listUnfinishedChanges(
  cwd?: string,
): Promise<ChangeLifecycle[]> {
  const index = await loadStateIndex(cwd)
  return Object.values(index.changes).filter(
    (cl) => cl.unfinishedRuns.length > 0,
  )
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
