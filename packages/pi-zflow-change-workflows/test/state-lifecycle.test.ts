/**
 * state-lifecycle.test.ts — Unit tests for the upgraded state model
 * (Milestone 2: ChangeLifecycle in state-index.json).
 *
 * Covers:
 * - ChangeLifecycle CRUD (upsert, get, remove)
 * - listUnfinishedChanges filtering
 * - detectResumeContext with new changes map
 * - checkUnfinishedOnEntry (no work / structured resume)
 */
import * as assert from "node:assert"
import { test, describe, beforeEach, after } from "node:test"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import { randomUUID } from "node:crypto"

import {
  loadStateIndex,
  saveStateIndex,
  upsertChangeLifecycle,
  getChangeLifecycle,
  removeChangeLifecycle,
  listUnfinishedChanges,
} from "pi-zflow-artifacts/state-index"

import type {
  StateIndex,
  ChangeLifecycle,
} from "pi-zflow-artifacts/state-index"

import {
  detectResumeContext,
  checkUnfinishedOnEntry,
} from "../extensions/zflow-change-workflows/orchestration.js"

import type {
  UnfinishedOnEntryResult,
} from "../extensions/zflow-change-workflows/orchestration.js"

import { resolveStateIndexPath } from "pi-zflow-artifacts/artifact-paths"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = []

/**
 * Create a guaranteed-unique temporary directory for test isolation.
 * Uses randomUUID which is cryptographically unique across all calls.
 */
async function freshCwd(): Promise<string> {
  const d = path.join(os.tmpdir(), `zflow-tlc-${randomUUID()}`)
  await fs.mkdir(d, { recursive: true })
  tmpDirs.push(d)
  return d
}

/** Reset the state index for a given cwd to an empty default. */
async function resetState(cwd: string): Promise<void> {
  await saveStateIndex({ version: 2, entries: [], changes: {} }, cwd)
}

/**
 * Create a clean temporary directory with an initialized state index.
 */
async function freshStateCwd(): Promise<string> {
  const cwd = await freshCwd()
  await saveStateIndex({ version: 2, entries: [], changes: {} }, cwd)
  return cwd
}

/**
 * Helper to create a sample ChangeLifecycle record.
 */
function makeLifecycle(
  changeId: string,
  lastPhase: ChangeLifecycle["lastPhase"] = "draft",
  unfinishedRuns: string[] = [],
  retainedWorktrees: string[] = [],
  artifactPaths: string[] = [],
): ChangeLifecycle {
  return {
    changeId,
    lastPhase,
    unfinishedRuns,
    retainedWorktrees,
    artifactPaths,
    cleanupMetadata: {},
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChangeLifecycle CRUD", () => {
  after(async () => {
    for (const d of tmpDirs) {
      await fs.rm(d, { recursive: true, force: true }).catch(() => {})
    }
    tmpDirs = []
  })

  test("upsertChangeLifecycle adds a new record", async () => {
    const cwd = await freshStateCwd()
    const cl = makeLifecycle("change-1", "draft", [], [], [])
    await upsertChangeLifecycle(cl, cwd)

    const loaded = await getChangeLifecycle("change-1", cwd)
    assert.ok(loaded, "Should retrieve the lifecycle")
    assert.strictEqual(loaded!.changeId, "change-1")
    assert.strictEqual(loaded!.lastPhase, "draft")
    assert.deepEqual(loaded!.unfinishedRuns, [])
    assert.deepEqual(loaded!.artifactPaths, [])
  })

  test("upsertChangeLifecycle merges with existing record", async () => {
    const cwd = await freshStateCwd()
    await upsertChangeLifecycle(
      makeLifecycle("merge-test", "draft", ["run-1"], ["/wt/a"], ["/art/a"]),
      cwd,
    )

    await upsertChangeLifecycle({
      changeId: "merge-test",
      lastPhase: "executing",
      unfinishedRuns: ["run-1", "run-2"],
      retainedWorktrees: ["/wt/a", "/wt/b"],
      artifactPaths: ["/art/a"],
      cleanupMetadata: { retentionDays: 30 },
    }, cwd)

    const loaded = await getChangeLifecycle("merge-test", cwd)
    assert.ok(loaded)
    assert.strictEqual(loaded!.lastPhase, "executing")
    assert.deepEqual(loaded!.unfinishedRuns, ["run-1", "run-2"])
    assert.deepEqual(loaded!.retainedWorktrees, ["/wt/a", "/wt/b"])
    assert.strictEqual(loaded!.cleanupMetadata.retentionDays, 30)
  })

  test("getChangeLifecycle returns null for non-existent", async () => {
    const cwd = await freshStateCwd()
    const result = await getChangeLifecycle("no-such-change", cwd)
    assert.strictEqual(result, null)
  })

  test("removeChangeLifecycle removes an existing record", async () => {
    const cwd = await freshStateCwd()
    await upsertChangeLifecycle(makeLifecycle("to-remove", "draft"), cwd)
    await removeChangeLifecycle("to-remove", cwd)

    const loaded = await getChangeLifecycle("to-remove", cwd)
    assert.strictEqual(loaded, null)
  })

  test("removeChangeLifecycle throws for non-existent", async () => {
    const cwd = await freshStateCwd()
    await assert.rejects(
      () => removeChangeLifecycle("not-here", cwd),
      { message: /not found/i },
    )
  })

  test("listUnfinishedChanges returns only changes with unfinished runs", async () => {
    const cwd = await freshStateCwd()
    // Reset to clean state first
    await saveStateIndex({ version: 2, entries: [], changes: {} }, cwd)

    await upsertChangeLifecycle(makeLifecycle("unfinished-1", "executing", ["run-a", "run-b"]), cwd)
    await upsertChangeLifecycle(makeLifecycle("finished-1", "completed", []), cwd)
    await upsertChangeLifecycle(makeLifecycle("unfinished-2", "drifted", ["run-c"]), cwd)
    await upsertChangeLifecycle(makeLifecycle("cancelled-1", "cancelled", []), cwd)

    const unfinished = await listUnfinishedChanges(cwd)
    assert.strictEqual(unfinished.length, 2, "Should return 2 unfinished changes")
    const ids = unfinished.map((cl) => cl.changeId).sort()
    assert.deepEqual(ids, ["unfinished-1", "unfinished-2"])
  })

  test("listUnfinishedChanges returns empty when no unfinished runs", async () => {
    const cwd = await freshStateCwd()
    // Reset to clean state first
    await saveStateIndex({ version: 2, entries: [], changes: {} }, cwd)

    await upsertChangeLifecycle(makeLifecycle("done", "completed", []), cwd)
    const unfinished = await listUnfinishedChanges(cwd)
    assert.strictEqual(unfinished.length, 0)
  })

  test("state-index default includes empty changes map", async () => {
    const cwd = await freshStateCwd()
    // Reset to clean state first
    await saveStateIndex({ version: 2, entries: [], changes: {} }, cwd)

    const index = await loadStateIndex(cwd)
    assert.ok(index.changes, "changes map should exist")
    assert.strictEqual(Object.keys(index.changes).length, 0)
    assert.strictEqual(index.version, 2)
  })
})

describe("detectResumeContext with changes map", () => {
  after(async () => {
    for (const d of tmpDirs) {
      await fs.rm(d, { recursive: true, force: true }).catch(() => {})
    }
    tmpDirs = []
  })

  test("returns null when no unfinished changes exist", async () => {
    const cwd = await freshStateCwd()
    await upsertChangeLifecycle(makeLifecycle("completed-change", "completed", []), cwd)
    const context = await detectResumeContext(undefined, cwd)
    assert.strictEqual(context, null)
  })

  test("returns null when specific changeId has no unfinished work", async () => {
    const cwd = await freshStateCwd()
    await upsertChangeLifecycle(makeLifecycle("done", "completed", []), cwd)
    await upsertChangeLifecycle(makeLifecycle("unfinished", "executing", ["run-1"]), cwd)

    const context = await detectResumeContext("done", cwd)
    assert.strictEqual(context, null)
  })

  test("returns context for specific unfinished changeId", async () => {
    const cwd = await freshStateCwd()
    await upsertChangeLifecycle(makeLifecycle("other", "completed", []), cwd)
    await upsertChangeLifecycle(
      makeLifecycle("active", "executing", ["run-xyz"], ["/wt/active"], ["/art/active"]),
      cwd,
    )

    const context = await detectResumeContext("active", cwd)
    assert.ok(context, "Should detect unfinished work")
    assert.strictEqual(context!.changeId, "active")
    assert.strictEqual(context!.lastPhase, "executing")
    assert.ok(context!.details.includes("run-xyz"), "Details should mention the run")
    assert.ok(context!.resumeOptions.includes("resume"))
    assert.ok(context!.resumeOptions.includes("abandon"))
    assert.ok(context!.resumeOptions.includes("inspect"))
    assert.ok(context!.resumeOptions.includes("cleanup"))
  })

  test("returns context for first unfinished change when no changeId given", async () => {
    const cwd = await freshStateCwd()
    await upsertChangeLifecycle(makeLifecycle("first", "executing", ["run-1"]), cwd)
    await upsertChangeLifecycle(makeLifecycle("second", "drifted", ["run-2"]), cwd)

    const context = await detectResumeContext(undefined, cwd)
    assert.ok(context, "Should detect unfinished work")
    assert.ok(["first", "second"].includes(context!.changeId))
    assert.ok(context!.details.length > 0)
  })
})

describe("checkUnfinishedOnEntry", () => {
  after(async () => {
    for (const d of tmpDirs) {
      await fs.rm(d, { recursive: true, force: true }).catch(() => {})
    }
    tmpDirs = []
  })

  test("returns hasUnfinishedWork false when no lifecycle exists", async () => {
    const cwd = await freshStateCwd()
    const result = await checkUnfinishedOnEntry("new-change", cwd)
    assert.strictEqual(result.hasUnfinishedWork, false)
    assert.deepEqual(result.unfinishedRunIds, [])
    assert.strictEqual(result.choices.length, 0)
  })

  test("returns hasUnfinishedWork false when lifecycle has empty unfinishedRuns", async () => {
    const cwd = await freshStateCwd()
    await upsertChangeLifecycle(makeLifecycle("done", "completed", []), cwd)
    const result = await checkUnfinishedOnEntry("done", cwd)
    assert.strictEqual(result.hasUnfinishedWork, false)
  })

  test("returns structured result with choices when unfinished work exists", async () => {
    const cwd = await freshStateCwd()
    await upsertChangeLifecycle(
      makeLifecycle("active-change", "executing", ["run-1", "run-2"], ["/wt/a"], ["/art/a"]),
      cwd,
    )

    const result = await checkUnfinishedOnEntry("active-change", cwd)
    assert.ok(result, "Should return a result")
    assert.strictEqual(result.hasUnfinishedWork, true)
    assert.strictEqual(result.changeId, "active-change")
    assert.strictEqual(result.lastPhase, "executing")
    assert.deepEqual(result.unfinishedRunIds, ["run-1", "run-2"])
    assert.deepEqual(result.retainedWorktrees, ["/wt/a"])

    const actions = result.choices.map((c) => c.action)
    assert.ok(actions.includes("resume"))
    assert.ok(actions.includes("abandon"))
    assert.ok(actions.includes("inspect"))
    assert.ok(actions.includes("cleanup"))

    assert.ok(result.summary.includes("active-change"))
    assert.ok(result.summary.includes("executing"))
    assert.ok(result.summary.includes("run-1"))
    assert.ok(result.summary.includes("run-2"))
  })

  test("returns structured result with drift phase", async () => {
    const cwd = await freshStateCwd()
    await upsertChangeLifecycle(
      makeLifecycle("drifted-change", "drifted", ["run-drift"]),
      cwd,
    )

    const result = await checkUnfinishedOnEntry("drifted-change", cwd)
    assert.strictEqual(result.hasUnfinishedWork, true)
    assert.strictEqual(result.lastPhase, "drifted")
    assert.deepEqual(result.unfinishedRunIds, ["run-drift"])
    assert.strictEqual(result.choices.length, 4)
  })
})
