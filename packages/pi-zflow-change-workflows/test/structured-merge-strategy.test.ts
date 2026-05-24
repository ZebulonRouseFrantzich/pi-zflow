/**
 * structured-merge-strategy.test.ts — Unit tests for structured-merge-strategy.ts.
 */
import * as assert from "node:assert"
import { test, describe, before, after } from "node:test"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import * as fsSync from "node:fs"
import { execFileSync } from "node:child_process"
import * as os from "node:os"

import {
  detectConflictRegions,
  hasUnresolvedMarkers,
  resolveFileConflicts,
  resolveAllConflicts,
  isConflictSafeForAutoResolution,
} from "../extensions/zflow-change-workflows/structured-merge-strategy.js"

import type {
  ConflictRegion,
  StructuredMergeResult,
} from "../extensions/zflow-change-workflows/structured-merge-strategy.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeFile(repoRoot: string, filePath: string, content: string): void {
  const fullPath = path.join(repoRoot, filePath)
  fsSync.mkdirSync(path.dirname(fullPath), { recursive: true })
  fsSync.writeFileSync(fullPath, content, "utf-8")
}

// ---------------------------------------------------------------------------
// detectConflictRegions
// ---------------------------------------------------------------------------

describe("detectConflictRegions", () => {
  test("detects a single conflict region", () => {
    const content = [
      "line1",
      "line2",
      "<<<<<<< ours",
      "our change",
      "=======",
      "their change",
      ">>>>>>> theirs",
      "line3",
    ].join("\n")

    const filePath = path.join(os.tmpdir(), "conflict-test.txt")
    fsSync.writeFileSync(filePath, content, "utf-8")

    const regions = detectConflictRegions(filePath)
    assert.equal(regions.length, 1)
    assert.deepEqual(regions[0].ours, ["our change"])
    assert.deepEqual(regions[0].theirs, ["their change"])
    assert.equal(regions[0].startLine, 3)

    fsSync.unlinkSync(filePath)
  })

  test("detects multiple conflict regions", () => {
    const content = [
      "line1",
      "<<<<<<< ours",
      "change1",
      "=======",
      "change2",
      ">>>>>>> theirs",
      "middle",
      "<<<<<<< ours",
      "change3",
      "=======",
      "change4",
      ">>>>>>> theirs",
      "end",
    ].join("\n")

    const filePath = path.join(os.tmpdir(), "multi-conflict.txt")
    fsSync.writeFileSync(filePath, content, "utf-8")

    const regions = detectConflictRegions(filePath)
    assert.equal(regions.length, 2)

    fsSync.unlinkSync(filePath)
  })

  test("returns empty array for no conflicts", () => {
    const filePath = path.join(os.tmpdir(), "no-conflict.txt")
    fsSync.writeFileSync(filePath, "no conflict here\n", "utf-8")

    const regions = detectConflictRegions(filePath)
    assert.equal(regions.length, 0)

    fsSync.unlinkSync(filePath)
  })
})

// ---------------------------------------------------------------------------
// hasUnresolvedMarkers
// ---------------------------------------------------------------------------

describe("hasUnresolvedMarkers", () => {
  test("returns true for files with conflict markers", () => {
    const filePath = path.join(os.tmpdir(), "markers-present.txt")
    fsSync.writeFileSync(filePath, "<<<<<<< ours\n=======\n>>>>>>> theirs\n", "utf-8")

    assert.equal(hasUnresolvedMarkers(filePath), true)

    fsSync.unlinkSync(filePath)
  })

  test("returns false for clean files", () => {
    const filePath = path.join(os.tmpdir(), "no-markers.txt")
    fsSync.writeFileSync(filePath, "clean file\n", "utf-8")

    assert.equal(hasUnresolvedMarkers(filePath), false)

    fsSync.unlinkSync(filePath)
  })
})

// ---------------------------------------------------------------------------
// resolveFileConflicts — import conflicts
// ---------------------------------------------------------------------------

describe("resolveFileConflicts — import conflicts", () => {
  test("resolves import addition conflict", () => {
    const content = [
      'import { a } from "./a"',
      'import { b } from "./b"',
      "<<<<<<< HEAD",
      'import { c } from "./c"',
      "=======",
      'import { d } from "./d"',
      ">>>>>>> group",
      "",
      "export const x = 1",
    ].join("\n")

    const filePath = path.join(os.tmpdir(), "import-conflict.ts")
    fsSync.writeFileSync(filePath, content, "utf-8")

    const result = resolveFileConflicts(filePath)
    assert.equal(result.success, true)
    assert.equal(result.resolved, 1, "should resolve 1 import conflict")

    // Both imports should be present
    const resolvedContent = fsSync.readFileSync(filePath, "utf-8")
    assert.ok(resolvedContent.includes('import { c } from "./c"'), "should keep c import")
    assert.ok(resolvedContent.includes('import { d } from "./d"'), "should keep d import")
    assert.equal(hasUnresolvedMarkers(filePath), false, "should have no markers")

    fsSync.unlinkSync(filePath)
  })

  test("deduplicates identical imports", () => {
    const content = [
      'import { x } from "./lib"',
      "<<<<<<< HEAD",
      'import { y } from "./lib"',
      "=======",
      'import { y } from "./lib"',
      ">>>>>>> group",
      "",
      "export const z = 1",
    ].join("\n")

    const filePath = path.join(os.tmpdir(), "dedup-import.ts")
    fsSync.writeFileSync(filePath, content, "utf-8")

    const result = resolveFileConflicts(filePath)
    assert.equal(result.success, true)
    assert.equal(result.resolved, 1)

    const resolvedContent = fsSync.readFileSync(filePath, "utf-8")
    // Should only have one copy of the import
    const matches = resolvedContent.match(/import \{ y \} from "\.\/lib"/g)
    assert.equal(matches?.length, 1, "should deduplicate")

    fsSync.unlinkSync(filePath)
  })
})

// ---------------------------------------------------------------------------
// resolveFileConflicts — config key conflicts
// ---------------------------------------------------------------------------

describe("resolveFileConflicts — package.json conflicts", () => {
  test("resolves non-overlapping dependency additions", () => {
    const content = [
      "{",
      '  "dependencies": {',
      '    "express": "^4.18.0"',
      "<<<<<<< HEAD",
      '    ,"lodash": "^4.17.21"',
      "=======",
      '    ,"axios": "^1.6.0"',
      ">>>>>>> group",
      "  }",
      "}",
    ].join("\n")

    // For package.json, we need the file name to be package.json
    const filePath = path.join(os.tmpdir(), "package.json")
    fsSync.writeFileSync(filePath, content, "utf-8")

    const result = resolveFileConflicts(filePath)
    assert.equal(result.resolved, 1, "should resolve 1 config conflict")

    const resolvedContent = fsSync.readFileSync(filePath, "utf-8")
    assert.ok(resolvedContent.includes("lodash"), "should keep lodash")
    assert.ok(resolvedContent.includes("axios"), "should keep axios")
    assert.equal(hasUnresolvedMarkers(filePath), false)

    fsSync.unlinkSync(filePath)
  })
})

// ---------------------------------------------------------------------------
// resolveFileConflicts — non-overlapping additions
// ---------------------------------------------------------------------------

describe("resolveFileConflicts — non-overlapping additions", () => {
  test("resolves when both sides add different content", () => {
    const content = [
      "const config = {",
      "<<<<<<< ours",
      '  host: "localhost",',
      "=======",
      "  debug: true,",
      ">>>>>>> theirs",
      "}",
    ].join("\n")

    const filePath = path.join(os.tmpdir(), "non-overlap.ts")
    fsSync.writeFileSync(filePath, content, "utf-8")

    const result = resolveFileConflicts(filePath)
    // At least one resolver should work
    assert.ok(result.resolved > 0 || result.success, "should attempt resolution")

    fsSync.unlinkSync(filePath)
  })
})

// ---------------------------------------------------------------------------
// resolveAllConflicts
// ---------------------------------------------------------------------------

describe("resolveAllConflicts", () => {
  test("returns success when no conflicts exist", () => {
    const repoPath = path.join(os.tmpdir(), "no-conflict-repo")
    fsSync.mkdirSync(repoPath, { recursive: true })
    execFileSync("git", ["init"], { cwd: repoPath, stdio: "pipe" })
    execFileSync("git", ["config", "user.email", "test@test"], { cwd: repoPath, stdio: "pipe" })
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoPath, stdio: "pipe" })
    writeFile(repoPath, "README.md", "# No conflicts\n")
    execFileSync("git", ["add", "-A"], { cwd: repoPath, stdio: "pipe" })
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoPath, stdio: "pipe" })

    const result = resolveAllConflicts(repoPath)
    assert.equal(result.success, true)
    assert.equal(result.resolved, 0)
    assert.equal(result.unresolved, 0)

    execFileSync("rm", ["-rf", repoPath], { stdio: "pipe" })
  })
})

// ---------------------------------------------------------------------------
// isConflictSafeForAutoResolution
// ---------------------------------------------------------------------------

describe("isConflictSafeForAutoResolution", () => {
  test("returns true for clean files", () => {
    const filePath = path.join(os.tmpdir(), "safe-clean.txt")
    fsSync.writeFileSync(filePath, "clean file\n", "utf-8")

    assert.equal(isConflictSafeForAutoResolution(filePath), true)

    fsSync.unlinkSync(filePath)
  })

  test("returns true for import-only conflicts", () => {
    const content = [
      'import { a } from "./a"',
      "<<<<<<< ours",
      'import { b } from "./b"',
      "=======",
      'import { c } from "./c"',
      ">>>>>>> theirs",
      "",
      "export const x = 1",
    ].join("\n")

    const filePath = path.join(os.tmpdir(), "safe-import.txt")
    fsSync.writeFileSync(filePath, content, "utf-8")

    // Using import resolution, this should be safe
    assert.equal(isConflictSafeForAutoResolution(filePath), true)

    fsSync.unlinkSync(filePath)
  })
})
