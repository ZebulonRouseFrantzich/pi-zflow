/**
 * ownership-validator.test.ts — Unit tests for Task 5.2 ownership validation.
 *
 * Tests cover:
 * - No conflicts when groups own disjoint files
 * - Detection of overlapping file claims
 * - Resolution via explicit dependency order
 * - Failure when overlap is ambiguous (no dependency ordering)
 * - Multiple parallel groups with complex dependency chains
 * - Single-file conflicts, multi-file conflicts
 * - Empty groups, single groups
 */
import * as assert from "node:assert"
import { test, describe } from "node:test"

import {
  detectOwnershipConflicts,
  validateOwnershipAndDependencies,
  topoSortGroups,
} from "../extensions/zflow-change-workflows/ownership-validator.js"
import type { ExecutionGroup } from "../extensions/zflow-change-workflows/ownership-validator.js"

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function group(
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
  test("returns empty for groups with disjoint files", () => {
    const groups: ExecutionGroup[] = [
      group("g1", ["src/a.ts"]),
      group("g2", ["src/b.ts"]),
      group("g3", ["src/c.ts"]),
    ]
    const result = detectOwnershipConflicts(groups)
    assert.deepEqual(result, [])
  })

  test("detects single-file conflict between two groups", () => {
    const groups: ExecutionGroup[] = [
      group("g1", ["src/a.ts"]),
      group("g2", ["src/a.ts"]),
    ]
    const result = detectOwnershipConflicts(groups)
    assert.strictEqual(result.length, 1)
    assert.strictEqual(result[0].file, "src/a.ts")
    assert.deepEqual(result[0].groups, ["g1", "g2"])
  })

  test("detects same file claimed by three groups", () => {
    const groups: ExecutionGroup[] = [
      group("g1", ["src/shared.ts"]),
      group("g2", ["src/shared.ts"]),
      group("g3", ["src/shared.ts"]),
    ]
    const result = detectOwnershipConflicts(groups)
    assert.strictEqual(result.length, 1)
    assert.strictEqual(result[0].file, "src/shared.ts")
    assert.strictEqual(result[0].groups.length, 3)
  })

  test("detects multiple file conflicts", () => {
    const groups: ExecutionGroup[] = [
      group("g1", ["src/a.ts", "src/b.ts"]),
      group("g2", ["src/b.ts", "src/c.ts"]),
    ]
    const result = detectOwnershipConflicts(groups)
    assert.strictEqual(result.length, 1)
    assert.strictEqual(result[0].file, "src/b.ts")
  })

  test("returns empty for single group", () => {
    const groups: ExecutionGroup[] = [group("g1", ["src/a.ts"])]
    assert.deepEqual(detectOwnershipConflicts(groups), [])
  })

  test("returns empty for empty groups array", () => {
    assert.deepEqual(detectOwnershipConflicts([]), [])
  })

  test("handles groups with empty files array", () => {
    const groups: ExecutionGroup[] = [
      group("g1", []),
      group("g2", []),
    ]
    assert.deepEqual(detectOwnershipConflicts(groups), [])
  })
})

// ---------------------------------------------------------------------------
// validateOwnershipAndDependencies
// ---------------------------------------------------------------------------

describe("validateOwnershipAndDependencies", () => {
  test("passes for groups with no file overlaps", () => {
    const groups: ExecutionGroup[] = [
      group("g1", ["src/a.ts"]),
      group("g2", ["src/b.ts"]),
      group("g3", ["src/c.ts"]),
    ]
    const result = validateOwnershipAndDependencies(groups)
    assert.strictEqual(result.valid, true)
    assert.deepEqual(result.conflicts, [])
  })

  test("passes for overlapping files with explicit dependency order", () => {
    const groups: ExecutionGroup[] = [
      group("g1", ["src/shared.ts"]),
      group("g2", ["src/shared.ts"], ["g1"]), // g2 depends on g1
    ]
    const result = validateOwnershipAndDependencies(groups)
    assert.strictEqual(result.valid, true)
    assert.strictEqual(result.conflicts.length, 0)
    assert.ok(result.summary.includes("dependency order is explicit"))
  })

  test("passes for transitive dependency resolving overlap", () => {
    const groups: ExecutionGroup[] = [
      group("g1", ["src/a.ts"]),
      group("g2", ["src/b.ts"], ["g1"]),
      group("g3", ["src/a.ts"], ["g2"]), // g3 depends on g2, which depends on g1
    ]
    const result = validateOwnershipAndDependencies(groups)
    assert.strictEqual(result.valid, true)
    assert.strictEqual(result.conflicts.length, 0)
  })

  test("fails for overlapping files with no dependency order", () => {
    const groups: ExecutionGroup[] = [
      group("g1", ["src/shared.ts"]),
      group("g2", ["src/shared.ts"]), // no dependency between g1 and g2
    ]
    const result = validateOwnershipAndDependencies(groups)
    assert.strictEqual(result.valid, false)
    assert.strictEqual(result.conflicts.length, 1)
    assert.strictEqual(result.conflicts[0].file, "src/shared.ts")
  })

  test("fails when only some overlapping groups have dependencies", () => {
    const groups: ExecutionGroup[] = [
      group("g1", ["src/a.ts"]),
      group("g2", ["src/a.ts"], ["g1"]), // g2 depends on g1 — ok
      group("g3", ["src/a.ts"]), // g3 overlaps but has no dependency — fails
    ]
    const result = validateOwnershipAndDependencies(groups)
    // g3 overlaps with both g1 and g2 but has no dependency on either
    assert.strictEqual(result.valid, false)
  })

  test("handles empty groups array", () => {
    const result = validateOwnershipAndDependencies([])
    assert.strictEqual(result.valid, true)
    assert.deepEqual(result.conflicts, [])
  })

  test("handles single group", () => {
    const groups: ExecutionGroup[] = [group("g1", ["src/a.ts"])]
    const result = validateOwnershipAndDependencies(groups)
    assert.strictEqual(result.valid, true)
  })

  test("passes when overlapping groups are in a dependency chain (A←B←C)", () => {
    const groups: ExecutionGroup[] = [
      group("g1", ["src/core.ts"]),
      group("g2", ["src/core.ts", "src/more.ts"], ["g1"]),
      group("g3", ["src/more.ts"], ["g2"]),
    ]
    const result = validateOwnershipAndDependencies(groups)
    assert.strictEqual(result.valid, true)
    assert.strictEqual(result.conflicts.length, 0)
  })

  test("reports multiple overlapping files when ambiguously owned", () => {
    const groups: ExecutionGroup[] = [
      group("g1", ["src/a.ts", "src/b.ts"]),
      group("g2", ["src/a.ts", "src/b.ts"]),
      group("g3", ["src/c.ts"]),
    ]
    const result = validateOwnershipAndDependencies(groups)
    assert.strictEqual(result.valid, false)
    // Both a.ts and b.ts are conflicts, but they involve the same groups,
    // so they collapse into one OwnershipConflict per file
    assert.strictEqual(result.conflicts.length, 2)
  })

  test("conflict summary lists all ambiguous groups", () => {
    const groups: ExecutionGroup[] = [
      group("g1", ["src/app.ts"]),
      group("g2", ["src/app.ts"]),
      group("g3", ["src/app.ts"]),
    ]
    const result = validateOwnershipAndDependencies(groups)
    assert.strictEqual(result.valid, false)
    assert.ok(result.summary.includes("g1"))
    assert.ok(result.summary.includes("g2"))
    assert.ok(result.summary.includes("g3"))
  })

  test("single-file overlap between two groups with no deps fails", () => {
    const groups: ExecutionGroup[] = [
      group("g-a", ["src/conflict.ts"]),
      group("g-b", ["src/conflict.ts"]),
    ]
    const result = validateOwnershipAndDependencies(groups)
    assert.strictEqual(result.valid, false)
    assert.strictEqual(result.conflicts.length, 1)
    assert.strictEqual(result.conflicts[0].file, "src/conflict.ts")
  })

  test("overlapping groups with mutual one-way dep pass (A depends on B, B claims A's file)", () => {
    const groups: ExecutionGroup[] = [
      group("g1", ["src/shared.ts"]),
      group("g2", ["src/shared.ts"], ["g1"]),
    ]
    const result = validateOwnershipAndDependencies(groups)
    assert.strictEqual(result.valid, true)
  })
})

// ---------------------------------------------------------------------------
// topoSortGroups
// ---------------------------------------------------------------------------

describe("topoSortGroups", () => {
  test("returns all groups in input order when no dependencies", () => {
    const groups: ExecutionGroup[] = [
      group("g1", []),
      group("g2", []),
      group("g3", []),
    ]
    const result = topoSortGroups(groups)
    assert.notStrictEqual(result, null)
    assert.strictEqual(result!.length, 3)
  })

  test("respects linear dependency chain", () => {
    const groups: ExecutionGroup[] = [
      group("g1", [], []),
      group("g2", [], ["g1"]),
      group("g3", [], ["g2"]),
    ]
    const result = topoSortGroups(groups)
    assert.notStrictEqual(result, null)
    // g1 must come before g2 before g3
    const idx1 = result!.indexOf("g1")
    const idx2 = result!.indexOf("g2")
    const idx3 = result!.indexOf("g3")
    assert.ok(idx1 < idx2, "g1 should come before g2")
    assert.ok(idx2 < idx3, "g2 should come before g3")
  })

  test("handles diamond dependency (g3 depends on g1 and g2)", () => {
    const groups: ExecutionGroup[] = [
      group("g1", [], []),
      group("g2", [], []),
      group("g3", [], ["g1", "g2"]),
    ]
    const result = topoSortGroups(groups)
    assert.notStrictEqual(result, null)
    const idx1 = result!.indexOf("g1")
    const idx2 = result!.indexOf("g2")
    const idx3 = result!.indexOf("g3")
    assert.ok(idx1 < idx3, "g1 should come before g3")
    assert.ok(idx2 < idx3, "g2 should come before g3")
  })

  test("returns null for circular dependency", () => {
    const groups: ExecutionGroup[] = [
      group("g1", [], ["g2"]),
      group("g2", [], ["g1"]),
    ]
    const result = topoSortGroups(groups)
    assert.strictEqual(result, null)
  })

  test("returns null for self-loop", () => {
    const groups: ExecutionGroup[] = [
      group("g1", [], ["g1"]),
    ]
    const result = topoSortGroups(groups)
    assert.strictEqual(result, null)
  })

  test("handles groups with no files and no dependencies", () => {
    const groups: ExecutionGroup[] = []
    const result = topoSortGroups(groups)
    assert.notStrictEqual(result, null)
    assert.deepEqual(result, [])
  })

  test("handles complex multi-level dependencies", () => {
    const groups: ExecutionGroup[] = [
      group("g1", [], []),
      group("g2", [], ["g1"]),
      group("g3", [], ["g1"]),
      group("g4", [], ["g2", "g3"]),
      group("g5", [], ["g4"]),
    ]
    const result = topoSortGroups(groups)
    assert.notStrictEqual(result, null)
    const idx: Record<string, number> = {}
    result!.forEach((id, i) => { idx[id] = i })
    assert.ok(idx["g1"] < idx["g2"])
    assert.ok(idx["g1"] < idx["g3"])
    assert.ok(idx["g2"] < idx["g4"])
    assert.ok(idx["g3"] < idx["g4"])
    assert.ok(idx["g4"] < idx["g5"])
  })

  test("ignores external dependencies not in the group list", () => {
    const groups: ExecutionGroup[] = [
      group("g1", [], []),
      group("g2", [], ["g1", "external-dep"]),
    ]
    const result = topoSortGroups(groups)
    assert.notStrictEqual(result, null)
    const idx1 = result!.indexOf("g1")
    const idx2 = result!.indexOf("g2")
    assert.ok(idx1 < idx2, "g1 should come before g2 even with external deps")
  })
})
