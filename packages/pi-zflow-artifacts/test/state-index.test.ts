/**
 * state-index.test.ts — Unit tests for state-index.ts (Step 6).
 */
import * as assert from "node:assert"
import { test, describe, before, after, afterEach } from "node:test"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import { execFileSync } from "node:child_process"
import * as os from "node:os"

import {
  loadStateIndex,
  saveStateIndex,
  addStateIndexEntry,
  updateStateIndexEntry,
  listStateIndexEntries,
  removeStateIndexEntry,
} from "../src/state-index.js"

import { resolveStateIndexPath } from "../src/artifact-paths.js"

import type {
  StateIndex,
  StateIndexEntry,
} from "../src/state-index.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string

function setRuntimeStateDir(dir: string) {
  process.env.PI_ZFLOW_RUNTIME_STATE_DIR = dir
}

function clearRuntimeStateDir() {
  delete process.env.PI_ZFLOW_RUNTIME_STATE_DIR
}

/**
 * Wipe the state-index.json file so each test starts clean.
 */
async function wipeStateIndex(): Promise<void> {
  const indexPath = resolveStateIndexPath()
  try {
    await fs.unlink(indexPath)
  } catch {
    // ignore if file doesn't exist
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("state-index.ts", () => {
  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-zflow-test-"))
    setRuntimeStateDir(tmpDir)
  })

  after(async () => {
    clearRuntimeStateDir()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  afterEach(async () => {
    await wipeStateIndex()
  })

  test("loadStateIndex returns default for non-existent file", async () => {
    const index = await loadStateIndex()
    assert.equal(index.version, 2)
    assert.deepEqual(index.entries, [])
    assert.deepEqual(index.changes, {})
  })

  test("loadStateIndex returns fresh objects on ENOENT (no shared mutable state)", async () => {
    const index1 = await loadStateIndex()
    const index2 = await loadStateIndex()

    // Mutating index1.changes must not affect index2
    index1.changes["test"] = {
      changeId: "test",
      lastPhase: "draft",
      unfinishedRuns: [],
      retainedWorktrees: [],
      artifactPaths: [],
      cleanupMetadata: {},
    }

    assert.equal(Object.keys(index2.changes).length, 0,
      "mutating first ENOENT result must not contaminate second load")

    // Mutating index1.entries must not affect index2
    index1.entries.push({
      type: "run",
      id: "mutated-entry",
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    assert.equal(index2.entries.length, 0,
      "mutating first ENOENT entries must not affect second load")
  })

  test("saveStateIndex persists and loadStateIndex retrieves", async () => {
    const index: StateIndex = {
      version: 2,
      changes: {},
      entries: [
        {
          type: "run",
          id: "run-1",
          status: "pending",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    }

    await saveStateIndex(index)
    const loaded = await loadStateIndex()

    assert.equal(loaded.version, 2)
    assert.equal(loaded.entries.length, 1)
    assert.equal(loaded.entries[0].id, "run-1")
    assert.equal(loaded.entries[0].status, "pending")
  })

  test("addStateIndexEntry appends and saves", async () => {
    await addStateIndexEntry({
      type: "plan",
      id: "plan-42",
      status: "completed",
    })

    const loaded = await loadStateIndex()
    assert.equal(loaded.entries.length, 1)
    assert.equal(loaded.entries[0].type, "plan")
    assert.equal(loaded.entries[0].id, "plan-42")
    assert.ok(loaded.entries[0].createdAt)
    assert.ok(loaded.entries[0].updatedAt)
  })

  test("addStateIndexEntry preserves explicit timestamps", async () => {
    const fixedDate = "2025-01-01T00:00:00.000Z"
    await addStateIndexEntry({
      type: "run",
      id: "run-timestamp",
      status: "completed",
      createdAt: fixedDate,
      updatedAt: fixedDate,
    })

    const loaded = await loadStateIndex()
    const entry = loaded.entries.find((e) => e.id === "run-timestamp")
    assert.ok(entry)
    assert.equal(entry.createdAt, fixedDate)
    assert.equal(entry.updatedAt, fixedDate)
  })

  test("addStateIndexEntry with metadata", async () => {
    await addStateIndexEntry({
      type: "artifact",
      id: "art-1",
      status: "retained",
      metadata: { worktreePath: "/tmp/foo", expiresAt: "2025-06-01T00:00:00.000Z" },
    })

    const loaded = await loadStateIndex()
    const entry = loaded.entries.find((e) => e.id === "art-1")
    assert.ok(entry)
    assert.equal(entry.metadata?.worktreePath, "/tmp/foo")
    assert.equal(entry.metadata?.expiresAt, "2025-06-01T00:00:00.000Z")
  })

  test("updateStateIndexEntry modifies existing entry", async () => {
    await addStateIndexEntry({
      type: "run",
      id: "run-update",
      status: "pending",
    })

    await updateStateIndexEntry("run-update", {
      status: "running",
      metadata: { attempt: 2 },
    })

    const loaded = await loadStateIndex()
    const entry = loaded.entries.find((e) => e.id === "run-update")
    assert.ok(entry)
    assert.equal(entry.status, "running")
    assert.equal(entry.metadata?.attempt, 2)
    // updatedAt should have been reset
    assert.notEqual(entry.updatedAt, entry.createdAt)
  })

  test("updateStateIndexEntry throws for non-existent id", async () => {
    await assert.rejects(
      () => updateStateIndexEntry("nonexistent", { status: "completed" }),
      { message: /not found/ },
    )
  })

  test("listStateIndexEntries returns all entries when no filter", async () => {
    await addStateIndexEntry({ type: "run", id: "r1", status: "completed" })
    await addStateIndexEntry({ type: "plan", id: "p1", status: "approved" })
    await addStateIndexEntry({ type: "run", id: "r2", status: "failed" })

    const all = await listStateIndexEntries()
    assert.equal(all.length, 3)
  })

  test("listStateIndexEntries filters by type", async () => {
    await addStateIndexEntry({ type: "run", id: "r1", status: "completed" })
    await addStateIndexEntry({ type: "plan", id: "p1", status: "approved" })

    const runs = await listStateIndexEntries({ type: "run" })
    assert.equal(runs.length, 1)
    assert.equal(runs[0].id, "r1")

    const plans = await listStateIndexEntries({ type: "plan" })
    assert.equal(plans.length, 1)
  })

  test("listStateIndexEntries filters by status", async () => {
    await addStateIndexEntry({ type: "run", id: "r1", status: "completed" })
    await addStateIndexEntry({ type: "run", id: "r2", status: "failed" })

    const completed = await listStateIndexEntries({ status: "completed" })
    assert.equal(completed.length, 1)
    assert.equal(completed[0].id, "r1")
  })

  test("listStateIndexEntries filters by type and status", async () => {
    await addStateIndexEntry({ type: "run", id: "r1", status: "completed" })
    await addStateIndexEntry({ type: "run", id: "r2", status: "failed" })
    await addStateIndexEntry({ type: "plan", id: "p1", status: "completed" })

    const completedRuns = await listStateIndexEntries({ type: "run", status: "completed" })
    assert.equal(completedRuns.length, 1)
    assert.equal(completedRuns[0].id, "r1")
  })

  test("listStateIndexEntries returns a copy (not a reference)", async () => {
    await addStateIndexEntry({ type: "run", id: "r1", status: "completed" })

    const entries = await listStateIndexEntries()
    entries[0].status = "hacked"
    const reloaded = await listStateIndexEntries()
    assert.equal(reloaded[0].status, "completed")
  })

  test("removeStateIndexEntry removes entry by id", async () => {
    await addStateIndexEntry({ type: "run", id: "r1", status: "completed" })
    await addStateIndexEntry({ type: "plan", id: "p1", status: "approved" })

    await removeStateIndexEntry("r1")

    const remaining = await listStateIndexEntries()
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0].id, "p1")
  })

  test("removeStateIndexEntry throws for non-existent id", async () => {
    await assert.rejects(
      () => removeStateIndexEntry("nonexistent"),
      { message: /not found/ },
    )
  })

  test("loadStateIndex throws for malformed JSON", async () => {
    const indexPath = resolveStateIndexPath()
    await fs.mkdir(path.dirname(indexPath), { recursive: true })
    await fs.writeFile(indexPath, "this is not json", "utf-8")

    await assert.rejects(
      () => loadStateIndex(),
      SyntaxError,
    )
  })

  test("multiple entries survive save/load cycle", async () => {
    await addStateIndexEntry({ type: "run", id: "r1", status: "completed" })
    await addStateIndexEntry({ type: "run", id: "r2", status: "failed" })
    await addStateIndexEntry({ type: "plan", id: "p1", status: "approved" })
    await addStateIndexEntry({ type: "review", id: "rev1", status: "done" })
    await addStateIndexEntry({ type: "deviation", id: "dev1", status: "open" })

    const all = await listStateIndexEntries()
    assert.equal(all.length, 5)

    const loaded = await loadStateIndex()
    assert.equal(loaded.entries.length, 5)
  })

  test("atomic write does not corrupt on partial write", async () => {
    // First write valid data (version 2 with changes map)
    await saveStateIndex({ version: 2, entries: [], changes: {} }, tmpDir)

    // Simulate partial write by writing directly to the file (bypass atomic)
    const indexPath = resolveStateIndexPath(tmpDir)
    await fs.writeFile(indexPath, '{"version":2,"entri', "utf-8")

    // load should throw because the JSON is corrupt (not an ENOENT error)
    await assert.rejects(
      () => loadStateIndex(tmpDir),
      { name: "SyntaxError" },
    )
  })
})
