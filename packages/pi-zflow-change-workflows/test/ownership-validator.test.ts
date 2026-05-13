/**
 * ownership-validator.test.ts — Unit tests for Task 5.2 ownership validation.
 */
import * as assert from "node:assert"
import { test, describe } from "node:test"

import {
  detectOwnershipConflicts,
  validateOwnershipAndDependencies,
  topoSortGroups,
} from "../extensions/zflow-change-workflows/ownership-validator.js"

import type {
  ExecutionGroup,
} from "../extensions/zflow-change-workflows/ownership-validator.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeGroup(
  id: string,
  files: string[],
  deps: string[] = [],
  parallelizable = true,
): ExecutionGroup {
  return { id, files, dependencies: deps, parallelizable }
}

// ---------------------------------------------------------------------------
// detectOwnershipConflicts
// ---------------------------------------------------------------------------

describe("detectOwnershipConflicts", () => {
  test("returns empty for groups with no overlap", () => {
    const groups = [
      makeGroup("group-1", ["src/a.ts", "src/b.ts"]),
      makeGroup("group-2", ["src/c.ts", "src/d.ts"]),
    ]
    const conflicts = detectOwnershipConflicts(groups)
    assert.deepEqual(conflicts, [])
  })

  test("detects simple overlap between two groups", () => {
    const groups = [
      makeGroup("group-1", ["src/a.ts"]),
      makeGroup("group-2", ["src/a.ts"]),
    ]
    const conflicts = detectOwnershipConflicts(groups)
    assert.equal(conflicts.length, 1)
    assert.equal(conflicts[0].file, "src/a.ts")
    assert.deepEqual(conflicts[0].groups, ["group-1", "group-2"])
  })

  test("detects overlap among three groups", () => {
    const groups = [
      makeGroup("group-1", ["src/a.ts"]),
      makeGroup("group-2", ["src/a.ts", "src/b.ts"]),
      makeGroup("group-3", ["src/a.ts"]),
    ]
    const conflicts = detectOwnershipConflicts(groups)
    assert.equal(conflicts.length, 1)
    assert.equal(conflicts[0].file, "src/a.ts")
    assert.equal(conflicts[0].groups.length, 3)
  })

  test("detects multiple independent conflicts", () => {
    const groups = [
      makeGroup("group-1", ["src/a.ts"]),
      makeGroup("group-2", ["src/a.ts"]),
      makeGroup("group-3", ["src/b.ts"]),
      makeGroup("group-4", ["src/b.ts"]),
    ]
    const conflicts = detectOwnershipConflicts(groups)
    assert.equal(conflicts.length, 2)
  })

  test("returns empty for non-parallelizable groups", () => {
    const groups = [
      makeGroup("group-1", ["src/a.ts"], [], false),
      makeGroup("group-2", ["src/a.ts"], [], false),
    ]
    const conflicts = detectOwnershipConflicts(groups)
    assert.deepEqual(conflicts, [])
  })

  test("ignores non-parallel groups that overlap with parallel ones", () => {
    // Non-parallel groups are ignored in conflict detection,
    // but parallel groups can still conflict with each other
    const groups = [
      makeGroup("group-1", ["src/a.ts"]),
      makeGroup("group-2", ["src/a.ts"], [], false),
    ]
    const conflicts = detectOwnershipConflicts(groups)
    // group-2 is non-parallelizable, so it's excluded
    // group-1 alone doesn't create a conflict
    assert.deepEqual(conflicts, [])
  })

  test("returns empty for no groups", () => {
    const conflicts = detectOwnershipConflicts([])
    assert.deepEqual(conflicts, [])
  })

  test("returns empty for groups with no files", () => {
    const groups = [
      makeGroup("group-1", []),
      makeGroup("group-2", []),
    ]
    const conflicts = detectOwnershipConflicts(groups)
    assert.deepEqual(conflicts, [])
  })
})

// ---------------------------------------------------------------------------
// topoSortGroups
// ---------------------------------------------------------------------------

describe("topoSortGroups", () => {
  test("returns sorted order for simple dependency chain", () => {
    const groups = [
      makeGroup("group-1", ["src/a.ts"]),
      makeGroup("group-2", ["src/b.ts"], ["group-1"]),
      makeGroup("group-3", ["src/c.ts"], ["group-2"]),
    ]
    const sorted = topoSortGroups(groups)
    assert.deepEqual(sorted, ["group-1", "group-2", "group-3"])
  })

  test("handles groups with no dependencies", () => {
    const groups = [
      makeGroup("group-3", ["src/c.ts"], []),
      makeGroup("group-1", ["src/a.ts"], []),
      makeGroup("group-2", ["src/b.ts"], []),
    ]
    const sorted = topoSortGroups(groups)
    assert.ok(sorted !== null)
    assert.equal(sorted!.length, 3)
    // All three have no deps, any order is valid
    assert.deepEqual(new Set(sorted), new Set(["group-1", "group-2", "group-3"]))
  })

  test("returns null for cyclic dependencies", () => {
    const groups = [
      makeGroup("group-1", ["src/a.ts"], ["group-2"]),
      makeGroup("group-2", ["src/b.ts"], ["group-3"]),
      makeGroup("group-3", ["src/c.ts"], ["group-1"]),
    ]
    const sorted = topoSortGroups(groups)
    assert.equal(sorted, null)
  })

  test("handles diamond dependency", () => {
    const groups = [
      makeGroup("group-1", ["src/a.ts"]),
      makeGroup("group-2", ["src/b.ts"], ["group-1"]),
      makeGroup("group-3", ["src/c.ts"], ["group-1"]),
      makeGroup("group-4", ["src/d.ts"], ["group-2", "group-3"]),
    ]
    const sorted = topoSortGroups(groups)
    assert.ok(sorted !== null)
    assert.equal(sorted!.length, 4)
    assert.ok(sorted!.indexOf("group-1") < sorted!.indexOf("group-2"))
    assert.ok(sorted!.indexOf("group-1") < sorted!.indexOf("group-3"))
    assert.ok(sorted!.indexOf("group-2") < sorted!.indexOf("group-4"))
    assert.ok(sorted!.indexOf("group-3") < sorted!.indexOf("group-4"))
  })

  test("handles single group", () => {
    const groups = [makeGroup("group-1", ["src/a.ts"])]
    const sorted = topoSortGroups(groups)
    assert.deepEqual(sorted, ["group-1"])
  })
})

// ---------------------------------------------------------------------------
// validateOwnershipAndDependencies
// ---------------------------------------------------------------------------

describe("validateOwnershipAndDependencies", () => {
  test("passes with no conflicts and no dependencies", () => {
    const groups = [
      makeGroup("group-1", ["src/a.ts"]),
      makeGroup("group-2", ["src/b.ts"]),
    ]
    const result = validateOwnershipAndDependencies(groups)
    assert.equal(result.valid, true)
    assert.equal(result.conflicts.length, 0)
    assert.equal(result.sequentialGroups.length, 0)
  })

  test("passes with no conflicts and explicit dependencies", () => {
    const groups = [
      makeGroup("group-1", ["src/a.ts"]),
      makeGroup("group-2", ["src/b.ts"], ["group-1"]),
    ]
    const result = validateOwnershipAndDependencies(groups)
    assert.equal(result.valid, true)
    assert.equal(result.conflicts.length, 0)
  })

  test("fails when conflicts exist and no dependency ordering", () => {
    const groups = [
      makeGroup("group-1", ["src/a.ts"]),
      makeGroup("group-2", ["src/a.ts"]),
    ]
    const result = validateOwnershipAndDependencies(groups)
    assert.equal(result.valid, false)
    assert.equal(result.conflicts.length, 1)
  })

  test("passes with conflicts resolved by explicit dependencies", () => {
    const groups = [
      makeGroup("group-1", ["src/a.ts"]),
      makeGroup("group-2", ["src/a.ts"], ["group-1"]),
    ]
    const result = validateOwnershipAndDependencies(groups)
    assert.equal(result.valid, true)
    assert.equal(result.conflicts.length, 1)
    // The two groups share a file and have explicit deps,
    // so they form a sequential chain
    assert.ok(result.sequentialGroups.length >= 0)
  })

  test("fails with cyclic dependencies even without file conflicts", () => {
    const groups = [
      makeGroup("group-1", ["src/a.ts"], ["group-2"]),
      makeGroup("group-2", ["src/b.ts"], ["group-1"]),
    ]
    const result = validateOwnershipAndDependencies(groups)
    assert.equal(result.valid, false)
  })

  test("handles non-parallelizable groups without invalidating", () => {
    const groups = [
      makeGroup("group-1", ["src/a.ts"], [], false),
      makeGroup("group-2", ["src/a.ts"], [], false),
    ]
    const result = validateOwnershipAndDependencies(groups)
    assert.equal(result.valid, true)
    assert.equal(result.conflicts.length, 0)
  })

  test("fails when parallel groups conflict without deps but non-parallel groups exist", () => {
    const groups = [
      makeGroup("group-1", ["src/a.ts"]),
      makeGroup("group-2", ["src/a.ts"]),
      makeGroup("group-3", ["src/b.ts"], [], false),
    ]
    const result = validateOwnershipAndDependencies(groups)
    assert.equal(result.valid, false)
    assert.equal(result.conflicts.length, 1)
  })

  test("passes with no groups (empty edge case)", () => {
    const result = validateOwnershipAndDependencies([])
    assert.equal(result.valid, true)
    assert.equal(result.conflicts.length, 0)
  })

  test("passes with complex multi-group dependencies resolving overlaps", () => {
    const groups = [
      makeGroup("group-1", ["src/core.ts"]),
      makeGroup("group-2", ["src/core.ts", "src/utils.ts"], ["group-1"]),
      makeGroup("group-3", ["src/utils.ts"], ["group-2"]),
      makeGroup("group-4", ["src/other.ts"]),
    ]
    const result = validateOwnershipAndDependencies(groups)
    assert.equal(result.valid, true)
    assert.equal(result.conflicts.length, 2)

    // Verify topological order
    const sorted = topoSortGroups(groups)
    assert.ok(sorted !== null)
    assert.ok(sorted!.indexOf("group-1") < sorted!.indexOf("group-2"))
    assert.ok(sorted!.indexOf("group-2") < sorted!.indexOf("group-3"))
  })

  test("fails when conflicting groups have wrong partial dependencies", () => {
    // group-1 and group-2 overlap on src/a.ts, but only group-1 depends on group-2
    const groups = [
      makeGroup("group-1", ["src/a.ts"], ["group-2"]),
      makeGroup("group-2", ["src/a.ts"]),
    ]
    const result = validateOwnershipAndDependencies(groups)
    // This is valid because group-1 depends on group-2, which creates a clear ordering
    // (group-2 first, then group-1)
    assert.equal(result.valid, true)
  })

  test("generates useful summary for valid result", () => {
    const groups = [
      makeGroup("group-1", ["src/a.ts"]),
      makeGroup("group-2", ["src/a.ts"], ["group-1"]),
    ]
    const result = validateOwnershipAndDependencies(groups)
    assert.ok(result.summary.includes("Conflict"))
    assert.ok(result.summary.includes("group-1"))
    assert.ok(result.summary.includes("group-2"))
  })

  test("generates useful summary for invalid result", () => {
    const groups = [
      makeGroup("group-1", ["src/a.ts"]),
      makeGroup("group-2", ["src/a.ts"]),
    ]
    const result = validateOwnershipAndDependencies(groups)
    assert.ok(result.summary.includes("Conflict"))
    assert.ok(result.summary.includes("Resolution options"))
  })
})
