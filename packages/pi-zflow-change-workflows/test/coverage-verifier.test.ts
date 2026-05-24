/**
 * coverage-verifier.test.ts — Unit tests for coverage-verifier.ts.
 */
import * as assert from "node:assert"
import { test, describe, before, after } from "node:test"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import * as fsSync from "node:fs"
import { execFileSync } from "node:child_process"
import * as os from "node:os"

import {
  parsePatchHunks,
  verifyGroupCoverage,
  generateCoverageReport,
} from "../extensions/zflow-change-workflows/coverage-verifier.js"

import type { GroupHunk } from "../extensions/zflow-change-workflows/coverage-verifier.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTempRepo(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-zflow-cov-"))
  execFileSync("git", ["init"], { cwd: tmpDir, stdio: "pipe" })
  execFileSync("git", ["config", "user.email", "test@test"], { cwd: tmpDir, stdio: "pipe" })
  execFileSync("git", ["config", "user.name", "Test"], { cwd: tmpDir, stdio: "pipe" })
  return tmpDir
}

function writeFile(repoRoot: string, filePath: string, content: string): void {
  const fullPath = path.join(repoRoot, filePath)
  fsSync.mkdirSync(path.dirname(fullPath), { recursive: true })
  fsSync.writeFileSync(fullPath, content, "utf-8")
}

function gitAddCommit(repoRoot: string, message: string): string {
  execFileSync("git", ["add", "-A"], { cwd: repoRoot, stdio: "pipe" })
  execFileSync("git", ["commit", "--allow-empty", "-m", message], { cwd: repoRoot, stdio: "pipe" })
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot, encoding: "utf-8",
  }).trim()
}

/**
 * Create a patch from baseCommit to HEAD and write it to a temp dir
 * outside the repo. Returns the absolute path to the patch file.
 * Patches are written outside the repo to prevent `git add -A` from
 * accidentally committing patch text that fools the coverage verifier.
 */
function createPatchOutsideRepo(repoRoot: string, baseCommit: string): string {
  const diff = execFileSync("git", ["diff", baseCommit, "HEAD"], {
    cwd: repoRoot, encoding: "utf-8",
  })
  const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "pi-zflow-patch-"))
  const patchPath = path.join(tmpDir, "patch.diff")
  fsSync.writeFileSync(patchPath, diff, "utf-8")
  return patchPath
}

// ---------------------------------------------------------------------------
// parsePatchHunks
// ---------------------------------------------------------------------------

describe("parsePatchHunks", () => {
  test("parses single-file addition hunk", () => {
    const patch = [
      "diff --git a/src/lib.ts b/src/lib.ts",
      "index abc..def 100644",
      "--- a/src/lib.ts",
      "+++ b/src/lib.ts",
      "@@ -0,0 +1,3 @@",
      "+export function hello() {",
      '+  return "world"',
      "+}",
    ].join("\n")

    const hunks = parsePatchHunks(patch)
    assert.equal(hunks.length, 1)
    assert.equal(hunks[0].file, "src/lib.ts")
    assert.equal(hunks[0].kind, "add")
    assert.deepEqual(hunks[0].originalLines, { start: 0, count: 0 })
  })

  test("parses modification hunk with context", () => {
    const patch = [
      "diff --git a/src/main.ts b/src/main.ts",
      "index abc..def 100644",
      "--- a/src/main.ts",
      "+++ b/src/main.ts",
      "@@ -10,7 +10,8 @@",
      " const x = 1",
      " const y = 2",
      "-const z = 3",
      "+const z = 30",
      "+const w = 4",
      " const a = 5",
    ].join("\n")

    const hunks = parsePatchHunks(patch)
    assert.equal(hunks.length, 1)
    assert.equal(hunks[0].kind, "modify")
    assert.equal(hunks[0].file, "src/main.ts")
    assert.deepEqual(hunks[0].originalLines, { start: 10, count: 7 })
  })

  test("parses deletion hunk", () => {
    const patch = [
      "diff --git a/src/old.ts b/src/old.ts",
      "index abc..def 100644",
      "--- a/src/old.ts",
      "+++ b/src/old.ts",
      "@@ -1,5 +0,0 @@",
      "-function oldStuff() {",
      '-  return "deprecated"',
      "-}",
    ].join("\n")

    const hunks = parsePatchHunks(patch)
    assert.equal(hunks.length, 1)
    assert.equal(hunks[0].kind, "delete")
    assert.equal(hunks[0].file, "src/old.ts")
  })

  test("parses multi-file patch", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "index abc..def 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,3 +1,4 @@",
      " line1",
      " line2",
      "+line3",
      " line4",
      "diff --git a/b.ts b/b.ts",
      "index ghi..jkl 100644",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -5,2 +5,3 @@",
      " old5",
      "+new6",
      " old6",
    ].join("\n")

    const hunks = parsePatchHunks(patch)
    assert.equal(hunks.length, 2)
    assert.equal(hunks[0].file, "a.ts")
    assert.equal(hunks[1].file, "b.ts")
  })

  test("returns empty array for empty patch", () => {
    const hunks = parsePatchHunks("")
    assert.equal(hunks.length, 0)
  })

  test("returns empty array for patch with no hunks", () => {
    const patch = [
      "diff --git a/README.md b/README.md",
      "index abc..def 100644",
      "--- a/README.md",
      "+++ b/README.md",
    ].join("\n")
    const hunks = parsePatchHunks(patch)
    assert.equal(hunks.length, 0)
  })
})

// ---------------------------------------------------------------------------
// verifyGroupCoverage
// ---------------------------------------------------------------------------

describe("verifyGroupCoverage", () => {
  test("detects preserved addition hunk", async () => {
    const repo = await createTempRepo()
    writeFile(repo, "README.md", "# Original\n")
    const baseCommit = gitAddCommit(repo, "initial")

    // Make a change and create a patch
    writeFile(repo, "src/lib.ts", 'export const VERSION = "1.0"\n')
    gitAddCommit(repo, "add lib")
    const patchPath = createPatchOutsideRepo(repo, baseCommit)

    // Reset to base
    execFileSync("git", ["reset", "--hard", baseCommit], { cwd: repo, stdio: "pipe" })

    // Re-apply the change (simulate merged result)
    writeFile(repo, "src/lib.ts", 'export const VERSION = "1.0"\n')
    gitAddCommit(repo, "merged add")

    const coverage = await verifyGroupCoverage("test-group", patchPath, repo, baseCommit)
    assert.equal(coverage.covered, true)
    assert.equal(coverage.preservedHunks.length, 1)
    assert.equal(coverage.missingHunks.length, 0)

    await fs.rm(repo, { recursive: true, force: true })
  })

  test("detects missing hunk", async () => {
    const repo = await createTempRepo()
    writeFile(repo, "README.md", "# Original\n")
    const baseCommit = gitAddCommit(repo, "initial")

    // Create a patch
    writeFile(repo, "src/extra.ts", 'export const EXTRA = "yes"\n')
    gitAddCommit(repo, "add extra")
    const patchPath = createPatchOutsideRepo(repo, baseCommit)

    // Reset and DON'T apply the change
    execFileSync("git", ["reset", "--hard", baseCommit], { cwd: repo, stdio: "pipe" })

    // No changes applied to merged result
    gitAddCommit(repo, "no changes")

    const coverage = await verifyGroupCoverage("test-group", patchPath, repo, baseCommit)
    assert.equal(coverage.covered, false)
    assert.equal(coverage.missingHunks.length, 1)

    await fs.rm(repo, { recursive: true, force: true })
  })

  test("detects transformed hunk when lines partially present", async () => {
    const repo = await createTempRepo()
    writeFile(repo, "src/config.ts", [
      "const config = {",
      "  port: 3000,",
      "}",
      "export default config",
    ].join("\n"))
    const baseCommit = gitAddCommit(repo, "initial")

    // Original group adds a specific config key
    writeFile(repo, "src/config.ts", [
      "const config = {",
      "  port: 3000,",
      '  host: "localhost",',
      "}",
      "export default config",
    ].join("\n"))
    gitAddCommit(repo, "group adds host")
    const patchPath = createPatchOutsideRepo(repo, baseCommit)

    // Merge result has a different structure (e.g. host on same line)
    execFileSync("git", ["reset", "--hard", baseCommit], { cwd: repo, stdio: "pipe" })
    writeFile(repo, "src/config.ts", [
      "const config = {",
      '  port: 3000, host: "localhost",',
      "}",
      "export default config",
    ].join("\n"))
    gitAddCommit(repo, "merged with inline host")

    const coverage = await verifyGroupCoverage("test-group", patchPath, repo, baseCommit)
    assert.equal(coverage.covered, true)  // should pass because intent is preserved
    assert.equal(coverage.missingHunks.length, 0)

    await fs.rm(repo, { recursive: true, force: true })
  })

  test("preserves unchanged patch correctly when all hunks match", async () => {
    const repo = await createTempRepo()
    writeFile(repo, "README.md", "# Original\n")
    const baseCommit = gitAddCommit(repo, "initial")

    // Make a change and capture the patch
    writeFile(repo, "README.md", "# Original\n\n## Section 2\n")
    gitAddCommit(repo, "add section")
    const patchPath = createPatchOutsideRepo(repo, baseCommit)

    // Reset and re-apply exactly the same change (simulate preserved merge)
    execFileSync("git", ["reset", "--hard", baseCommit], { cwd: repo, stdio: "pipe" })
    writeFile(repo, "README.md", "# Original\n\n## Section 2\n")
    gitAddCommit(repo, "merged same")

    const coverage = await verifyGroupCoverage("same-group", patchPath, repo, baseCommit)
    assert.equal(coverage.covered, true)
    assert.equal(coverage.missingHunks.length, 0)
    assert.equal(coverage.preservedHunks.length, coverage.originalHunks.length)

    await fs.rm(repo, { recursive: true, force: true })
  })

  test("detects preserved deletion", async () => {
    const repo = await createTempRepo()
    writeFile(repo, "src/old.ts", 'export function legacy() { return "old" }\n')
    const baseCommit = gitAddCommit(repo, "initial")

    // Delete the file
    fsSync.unlinkSync(path.join(repo, "src/old.ts"))
    gitAddCommit(repo, "delete old")
    const patchPath = createPatchOutsideRepo(repo, baseCommit)

    // Reset and re-delete (simulating merged result)
    execFileSync("git", ["reset", "--hard", baseCommit], { cwd: repo, stdio: "pipe" })
    fsSync.unlinkSync(path.join(repo, "src/old.ts"))
    gitAddCommit(repo, "merged delete")

    const coverage = await verifyGroupCoverage("del-group", patchPath, repo, baseCommit)
    assert.equal(coverage.covered, true)
    assert.equal(coverage.preservedHunks.length, 1)
    assert.equal(coverage.missingHunks.length, 0)

    await fs.rm(repo, { recursive: true, force: true })
  })

  test("reports empty patch as covered", async () => {
    const repo = await createTempRepo()
    writeFile(repo, "README.md", "# Original\n")
    const baseCommit = gitAddCommit(repo, "initial")

    const patchPath = path.join(repo, "empty.patch")
    fsSync.writeFileSync(patchPath, "", "utf-8")

    const coverage = await verifyGroupCoverage("empty-group", patchPath, repo, baseCommit)
    assert.equal(coverage.covered, true)
    assert.equal(coverage.originalHunks.length, 0)

    await fs.rm(repo, { recursive: true, force: true })
  })

  test("handles non-existent patch file", async () => {
    const repo = await createTempRepo()
    const baseCommit = gitAddCommit(repo, "initial")

    const coverage = await verifyGroupCoverage("no-patch", "/nonexistent/patch.patch", repo, baseCommit)
    assert.equal(coverage.covered, true)
    assert.equal(coverage.summary.includes("No patch file found"), true)

    await fs.rm(repo, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// generateCoverageReport
// ---------------------------------------------------------------------------

describe("generateCoverageReport", () => {
  test("reports all groups covered when all patches are applied", async () => {
    const repo = await createTempRepo()
    writeFile(repo, "README.md", "# Base\n")
    const baseCommit = gitAddCommit(repo, "initial")

    // Group A: add lib-a
    writeFile(repo, "src/lib-a.ts", 'export const A = 1\n')
    gitAddCommit(repo, "add lib-a")
    const patchA = createPatchOutsideRepo(repo, baseCommit)

    // Group B: add lib-b
    writeFile(repo, "src/lib-b.ts", 'export const B = 2\n')
    gitAddCommit(repo, "add lib-b")
    const patchB = createPatchOutsideRepo(repo, baseCommit)

    // Reset to base and apply both changes (simulate successful merge)
    execFileSync("git", ["reset", "--hard", baseCommit], { cwd: repo, stdio: "pipe" })
    writeFile(repo, "src/lib-a.ts", 'export const A = 1\n')
    writeFile(repo, "src/lib-b.ts", 'export const B = 2\n')
    gitAddCommit(repo, "merged both")

    const report = await generateCoverageReport(
      [
        { groupId: "group-a", patchPath: patchA },
        { groupId: "group-b", patchPath: patchB },
      ],
      repo,
      baseCommit,
    )

    assert.equal(report.allCovered, true)
    assert.equal(report.groupsCovered, 2)
    assert.equal(report.totalGroups, 2)

    await fs.rm(repo, { recursive: true, force: true })
  })

  test("reports some groups missing when a patch is not applied", async () => {
    const repo = await createTempRepo()
    writeFile(repo, "README.md", "# Base\n")
    const baseCommit = gitAddCommit(repo, "initial")

    // Group A: will be applied
    writeFile(repo, "src/lib-a.ts", 'export const A = 1\n')
    gitAddCommit(repo, "add lib-a")
    const patchA = createPatchOutsideRepo(repo, baseCommit)

    // Group B: will NOT be applied
    writeFile(repo, "src/lib-b.ts", 'export const B = 2\n')
    gitAddCommit(repo, "add lib-b")
    const patchB = createPatchOutsideRepo(repo, baseCommit)

    // Reset and only apply group A
    execFileSync("git", ["reset", "--hard", baseCommit], { cwd: repo, stdio: "pipe" })
    writeFile(repo, "src/lib-a.ts", 'export const A = 1\n')
    gitAddCommit(repo, "merged only a")

    const report = await generateCoverageReport(
      [
        { groupId: "group-a", patchPath: patchA },
        { groupId: "group-b", patchPath: patchB },
      ],
      repo,
      baseCommit,
    )

    assert.equal(report.allCovered, false)
    assert.equal(report.groupsCovered, 1)
    assert.equal(report.totalGroups, 2)
    assert.equal(report.groups[1].missingHunks.length, 1)

    await fs.rm(repo, { recursive: true, force: true })
  })

  test("generates readable summary", async () => {
    const repo = await createTempRepo()
    writeFile(repo, "README.md", "# Base\n")
    const baseCommit = gitAddCommit(repo, "initial")

    // One patch applied
    writeFile(repo, "src/feature.ts", 'export const FEATURE = true\n')
    gitAddCommit(repo, "add feature")
    const patchPath = createPatchOutsideRepo(repo, baseCommit)

    execFileSync("git", ["reset", "--hard", baseCommit], { cwd: repo, stdio: "pipe" })
    writeFile(repo, "src/feature.ts", 'export const FEATURE = true\n')
    gitAddCommit(repo, "merged")

    const report = await generateCoverageReport(
      [{ groupId: "feature-group", patchPath }],
      repo,
      baseCommit,
    )

    assert.equal(report.summary.includes("Coverage report:"), true)
    assert.equal(report.summary.includes("✓"), true)

    await fs.rm(repo, { recursive: true, force: true })
  })
})
