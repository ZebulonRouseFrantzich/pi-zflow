/**
 * group-result.test.ts — Unit tests for Task 5.6 group result capture.
 */
import * as assert from "node:assert"
import { test, describe, before, after } from "node:test"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import { execFileSync } from "node:child_process"
import * as os from "node:os"

import {
  captureGroupResult,
  getGroupResult,
  listGroupResults,
} from "../extensions/zflow-change-workflows/group-result.js"

import { createRun } from "pi-zflow-artifacts/run-state"

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
  await fs.writeFile(path.join(tmpDir, "src", "main.ts"), 'console.log("hello")\n', "utf-8")
  execFileSync("git", ["add", "-A"], { cwd: tmpDir, stdio: "pipe" })
  execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: tmpDir, stdio: "pipe" })
  return tmpDir
}

async function createWorktree(repoRoot: string): Promise<string> {
  const wtDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-zflow-wt-"))
  execFileSync("git", ["worktree", "add", "--detach", wtDir, "HEAD"], { cwd: repoRoot, stdio: "pipe" })
  return wtDir
}

async function makeCommitInWorktree(worktreePath: string, file: string, content: string): Promise<void> {
  const fullPath = path.join(worktreePath, file)
  await fs.mkdir(path.dirname(fullPath), { recursive: true })
  await fs.writeFile(fullPath, content, "utf-8")
  execFileSync("git", ["add", file], { cwd: worktreePath, stdio: "pipe" })
  execFileSync("git", ["commit", "-m", `Update ${file}`], { cwd: worktreePath, stdio: "pipe" })
}

function setRuntimeStateDir(dir: string) {
  process.env.PI_ZFLOW_RUNTIME_STATE_DIR = dir
}

function clearRuntimeStateDir() {
  delete process.env.PI_ZFLOW_RUNTIME_STATE_DIR
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("captureGroupResult", () => {
  let repoRoot: string
  let worktreePath: string
  let runId: string
  let stateDir: string

  before(async () => {
    repoRoot = await createTempRepo()
    worktreePath = await createWorktree(repoRoot)
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-zflow-state-"))
    setRuntimeStateDir(stateDir)
    runId = "test-run-gr"
    await createRun(runId, repoRoot, "ch42", "v1", repoRoot)
  })

  after(async () => {
    clearRuntimeStateDir()
    try {
      execFileSync("git", ["worktree", "remove", "--force", worktreePath], { stdio: "pipe" })
    } catch { /* worktree may not exist if test setup failed */ }
    await fs.rm(stateDir, { recursive: true, force: true })
    await fs.rm(repoRoot, { recursive: true, force: true })
  })

  test("captures group result with changed files", async () => {
    // Make a change in the worktree
    await makeCommitInWorktree(worktreePath, "src/main.ts", 'console.log("updated")\n')

    const result = await captureGroupResult({
      groupId: "group-1",
      agent: "zflow.implement-routine",
      worktreePath,
      runId,
      repoRoot,
      scopedFiles: ["src/main.ts"],
      cwd: repoRoot,
    })

    assert.equal(result.groupId, "group-1")
    assert.equal(result.agent, "zflow.implement-routine")
    assert.equal(result.worktreePath, worktreePath)
    assert.ok(result.baseCommit.length === 40)
    assert.ok(result.headCommit.length === 40)
    assert.ok(result.changedFiles.length > 0)
    assert.ok(result.changedFiles.some((f) => f.includes("src/main.ts")))
    assert.ok(result.patchPath.endsWith("group-1.patch"))
    assert.equal(result.retained, false)
  })

  test("patch file is written to disk", async () => {
    const result = await captureGroupResult({
      groupId: "group-patch",
      agent: "zflow.implement-routine",
      worktreePath,
      runId,
      repoRoot,
      scopedFiles: ["src/main.ts"],
      cwd: repoRoot,
    })

    const patchContent = await fs.readFile(result.patchPath, "utf-8")
    assert.ok(patchContent.length > 0)
    assert.ok(patchContent.includes("diff --git"))
  })

  test("stores verification result when provided", async () => {
    const result = await captureGroupResult({
      groupId: "group-verify",
      agent: "zflow.implement-hard",
      worktreePath,
      runId,
      repoRoot,
      scopedFiles: ["src/main.ts"],
      verification: {
        status: "pass",
        command: "npm test -- src/main.test.ts",
        output: "Tests passed: 5/5",
      },
      cwd: repoRoot,
    })

    assert.ok(result.verification)
    assert.equal(result.verification!.status, "pass")
    assert.equal(result.verification!.command, "npm test -- src/main.test.ts")
  })

  test("marks group as retained when specified", async () => {
    const result = await captureGroupResult({
      groupId: "group-retain",
      agent: "zflow.implement-routine",
      worktreePath,
      runId,
      repoRoot,
      scopedFiles: ["src/main.ts"],
      retain: true,
      cwd: repoRoot,
    })

    assert.equal(result.retained, true)
  })
})

describe("getGroupResult and listGroupResults", () => {
  let repoRoot: string
  let worktreePath: string
  let runId: string
  let stateDir: string

  before(async () => {
    repoRoot = await createTempRepo()
    worktreePath = await createWorktree(repoRoot)
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-zflow-state-"))
    setRuntimeStateDir(stateDir)
    runId = "test-run-list"
    await createRun(runId, repoRoot, "ch42", "v1", repoRoot)

    // Create some results
    await makeCommitInWorktree(worktreePath, "src/main.ts", 'console.log("v2")\n')
    await captureGroupResult({
      groupId: "group-a", agent: "zflow.implement-routine",
      worktreePath, runId, repoRoot,
      scopedFiles: ["src/main.ts"], cwd: repoRoot,
    })
    await makeCommitInWorktree(worktreePath, "src/utils.ts", 'export const x = 1;\n')
    await captureGroupResult({
      groupId: "group-b", agent: "zflow.implement-hard",
      worktreePath, runId, repoRoot,
      scopedFiles: ["src/utils.ts"], cwd: repoRoot,
    })
  })

  after(async () => {
    clearRuntimeStateDir()
    try {
      execFileSync("git", ["worktree", "remove", "--force", worktreePath], { stdio: "pipe" })
    } catch { /* worktree may not exist if test setup failed */ }
    await fs.rm(stateDir, { recursive: true, force: true })
    await fs.rm(repoRoot, { recursive: true, force: true })
  })

  test("getGroupResult returns correct group", async () => {
    const result = await getGroupResult(runId, "group-a", repoRoot)
    assert.ok(result !== null)
    assert.equal(result!.groupId, "group-a")
    assert.equal(result!.agent, "zflow.implement-routine")
  })

  test("getGroupResult returns null for missing group", async () => {
    const result = await getGroupResult(runId, "nonexistent", repoRoot)
    assert.equal(result, null)
  })

  test("listGroupResults returns all groups", async () => {
    const results = await listGroupResults(runId, repoRoot)
    assert.equal(results.length, 2)
    const ids = results.map((r) => r.groupId).sort()
    assert.deepEqual(ids, ["group-a", "group-b"])
  })
})
