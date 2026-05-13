/**
 * apply-back.test.ts — Unit tests for Task 5.7/5.8 apply-back.
 */
import * as assert from "node:assert"
import { test, describe, before, after } from "node:test"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import * as fsSync from "node:fs"
import { execFileSync } from "node:child_process"
import * as os from "node:os"

import {
  executeApplyBack,
  PatchReplayStrategy,
} from "../extensions/zflow-change-workflows/apply-back.js"

import type { ApplyBackOptions } from "../extensions/zflow-change-workflows/apply-back.js"

import { createRun, createRecoveryRef, readRun } from "pi-zflow-artifacts/run-state"
import type { PreApplySnapshot } from "pi-zflow-artifacts/run-state"
import type { ExecutionGroup } from "../extensions/zflow-change-workflows/ownership-validator.js"
import { resolveRunDir } from "pi-zflow-artifacts/artifact-paths"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTempRepo(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-zflow-test-"))
  execFileSync("git", ["init"], { cwd: tmpDir, stdio: "pipe" })
  execFileSync("git", ["config", "user.email", "test@test"], { cwd: tmpDir, stdio: "pipe" })
  execFileSync("git", ["config", "user.name", "Test"], { cwd: tmpDir, stdio: "pipe" })
  await fs.mkdir(path.join(tmpDir, "src"), { recursive: true })
  await fs.writeFile(path.join(tmpDir, "README.md"), "# Test\n", "utf-8")
  await fs.writeFile(path.join(tmpDir, "src", "main.ts"), 'console.log("v1")\n', "utf-8")
  execFileSync("git", ["add", "-A"], { cwd: tmpDir, stdio: "pipe" })
  execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: tmpDir, stdio: "pipe" })
  return tmpDir
}

function makePatch(repoRoot: string, patchPath: string, content: string): void {
  execFileSync("mkdir", ["-p", path.dirname(patchPath)], { stdio: "pipe" })
  fsSync.writeFileSync(patchPath, content, "utf-8")
}

function makeGroup(id: string, files: string[], deps: string[] = []): ExecutionGroup {
  return { id, files, dependencies: deps, parallelizable: true }
}

// ---------------------------------------------------------------------------
// PatchReplayStrategy
// ---------------------------------------------------------------------------

describe("PatchReplayStrategy", () => {
  const strategy = new PatchReplayStrategy()

  test("has correct name", () => {
    assert.equal(strategy.name, "patch-replay")
  })

  test("applyPatch succeeds for valid patch", async () => {
    const repoRoot = await createTempRepo()
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf-8" }).trim()

    // Create a patch by making a commit and diffing it
    await fs.writeFile(path.join(repoRoot, "src", "main.ts"), 'console.log("v2")\n', "utf-8")
    execFileSync("git", ["add", "src/main.ts"], { cwd: repoRoot, stdio: "pipe" })
    execFileSync("git", ["commit", "-m", "v2"], { cwd: repoRoot, stdio: "pipe" })

    const diff = execFileSync("git", ["diff", headSha, "HEAD", "--", "src/main.ts"], {
      cwd: repoRoot, encoding: "utf-8",
    })

    // Reset to original state
    execFileSync("git", ["reset", "--hard", headSha], { cwd: repoRoot, stdio: "pipe" })

    // Write patch
    const patchPath = path.join(os.tmpdir(), "test-patch.patch")
    fsSync.writeFileSync(patchPath, diff, "utf-8")

    // Apply patch
    await strategy.applyPatch(patchPath, repoRoot, "test-group")

    // Verify
    const content = await fs.readFile(path.join(repoRoot, "src", "main.ts"), "utf-8")
    assert.equal(content, 'console.log("v2")\n')

    await fs.rm(repoRoot, { recursive: true, force: true })
  })

  test("applyPatch throws for invalid patch", async () => {
    const repoRoot = await createTempRepo()
    const patchPath = path.join(os.tmpdir(), "bad-patch.patch")
    fsSync.writeFileSync(patchPath, "this is not a valid patch", "utf-8")

    await assert.rejects(
      () => strategy.applyPatch(patchPath, repoRoot, "bad-group"),
      /Failed to apply patch/,
    )

    await fs.rm(repoRoot, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// executeApplyBack
// ---------------------------------------------------------------------------

describe("executeApplyBack", () => {
  let repoRoot: string
  let runId: string
  let snapshot: PreApplySnapshot

  before(async () => {
    repoRoot = await createTempRepo()
    runId = "test-apply-back"
  })

  after(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true })
  })

  test("successfully applies patches in topological order", async () => {
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf-8" }).trim()
    snapshot = {
      head: headSha,
      indexState: "clean",
      recoveryRef: `refs/zflow/recovery/${runId}`,
    }

    // Create a run.json
    await createRun(runId, repoRoot, "ch42", "v1", repoRoot)
    createRecoveryRef(runId, repoRoot, headSha)

    // Create patches by making commits and diffing
    // Group 1 modifies src/main.ts
    await fs.writeFile(path.join(repoRoot, "src", "main.ts"), 'console.log("g1")\n', "utf-8")
    execFileSync("git", ["add", "src/main.ts"], { cwd: repoRoot, stdio: "pipe" })
    execFileSync("git", ["commit", "-m", "g1 work"], { cwd: repoRoot, stdio: "pipe" })
    const g1Head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf-8" }).trim()
    const g1Diff = execFileSync("git", ["diff", headSha, g1Head], { cwd: repoRoot, encoding: "utf-8" })

    // Group 2 modifies README.md
    await fs.writeFile(path.join(repoRoot, "README.md"), "# Test G2\n", "utf-8")
    execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "pipe" })
    execFileSync("git", ["commit", "-m", "g2 work"], { cwd: repoRoot, stdio: "pipe" })
    const g2Head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf-8" }).trim()
    const g2Diff = execFileSync("git", ["diff", g1Head, g2Head], { cwd: repoRoot, encoding: "utf-8" })

    // Reset to original
    execFileSync("git", ["reset", "--hard", headSha], { cwd: repoRoot, stdio: "pipe" })

    // Write patches to the run's patches directory
    const runDir = resolveRunDir(runId, repoRoot)
    const patchesDir = path.join(runDir, "patches")
    await fs.mkdir(patchesDir, { recursive: true })
    fsSync.writeFileSync(path.join(patchesDir, "group-1.patch"), g1Diff, "utf-8")
    fsSync.writeFileSync(path.join(patchesDir, "group-2.patch"), g2Diff, "utf-8")

    // Execute apply-back
    const groups: ExecutionGroup[] = [
      makeGroup("group-1", ["src/main.ts"]),
      makeGroup("group-2", ["README.md"], ["group-1"]),
    ]

    const options: ApplyBackOptions = {
      runId,
      repoRoot,
      snapshot,
      groups,
      cwd: repoRoot,
    }

    const result = await executeApplyBack(options)
    assert.equal(result.success, true)
    assert.equal(result.groupsApplied, 2)
    assert.equal(result.totalGroups, 2)
    assert.equal(result.rolledBack, false)

    // Verify files
    const mainContent = await fs.readFile(path.join(repoRoot, "src", "main.ts"), "utf-8")
    assert.equal(mainContent, 'console.log("g1")\n')
    const readmeContent = await fs.readFile(path.join(repoRoot, "README.md"), "utf-8")
    assert.equal(readmeContent, "# Test G2\n")
  })

  test("rolls back on failure", async () => {
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf-8" }).trim()
    snapshot = {
      head: headSha,
      indexState: "clean",
      recoveryRef: `refs/zflow/recovery/${runId}-fail`,
    }

    runId = "test-apply-back-fail"
    await createRun(runId, repoRoot, "ch42", "v1", repoRoot)
    createRecoveryRef(runId, repoRoot, headSha)

    const runDir = resolveRunDir(runId, repoRoot)
    const patchesDir = path.join(runDir, "patches")
    await fs.mkdir(patchesDir, { recursive: true })

    // Create a valid patch for group-1
    await fs.writeFile(path.join(repoRoot, "src", "main.ts"), 'console.log("g1-ok")\n', "utf-8")
    execFileSync("git", ["add", "src/main.ts"], { cwd: repoRoot, stdio: "pipe" })
    execFileSync("git", ["commit", "-m", "g1 ok"], { cwd: repoRoot, stdio: "pipe" })
    const g1Head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf-8" }).trim()
    const g1Diff = execFileSync("git", ["diff", headSha, g1Head], { cwd: repoRoot, encoding: "utf-8" })
    fsSync.writeFileSync(path.join(patchesDir, "group-1.patch"), g1Diff, "utf-8")

    // Create an invalid patch for group-2
    fsSync.writeFileSync(path.join(patchesDir, "group-2.patch"), "not a valid patch", "utf-8")

    // Reset to original
    execFileSync("git", ["reset", "--hard", headSha], { cwd: repoRoot, stdio: "pipe" })

    const groups: ExecutionGroup[] = [
      makeGroup("group-1", ["src/main.ts"]),
      makeGroup("group-2", ["README.md"], ["group-1"]),
    ]

    const options: ApplyBackOptions = {
      runId,
      repoRoot,
      snapshot,
      groups,
      cwd: repoRoot,
    }

    const result = await executeApplyBack(options)
    assert.equal(result.success, false)
    assert.equal(result.rolledBack, true)
    assert.equal(result.failingGroup, "group-2")
    assert.ok(result.error)

    // Verify rollback: main.ts should be unchanged (reset to headSha)
    const mainContent = await fs.readFile(path.join(repoRoot, "src", "main.ts"), "utf-8")
    assert.equal(mainContent, 'console.log("v1")\n')

    // Verify run phase
    const run = await readRun(runId, repoRoot)
    assert.equal(run.phase, "apply-back-conflicted")
  })
})
