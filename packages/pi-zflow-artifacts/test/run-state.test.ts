/**
 * run-state.test.ts — Unit tests for run-state.ts (Task 5.3).
 */
import * as assert from "node:assert"
import { test, describe, before, after, afterEach } from "node:test"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import { accessSync } from "node:fs"
import { execFileSync } from "node:child_process"
import * as os from "node:os"

import {
  createRun,
  readRun,
  updateRun,
  addGroupToRun,
  addRetainedArtifact,
  setRunPhase,
  createRecoveryRef,
  removeRecoveryRef,
  resetToPreApplySnapshot,
} from "../src/run-state.js"

import type {
  RunJson,
  PreApplySnapshot,
  GroupRunMetadata,
  RetainedArtifact,
} from "../src/run-state.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string
let repoRoot: string
let runId: string

/**
 * Create a temporary git repository for testing.
 */
async function createTempRepo(): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-zflow-test-"))
  execFileSync("git", ["init"], { cwd: tmp, stdio: "pipe" })
  execFileSync("git", ["config", "user.email", "test@test"], { cwd: tmp, stdio: "pipe" })
  execFileSync("git", ["config", "user.name", "Test"], { cwd: tmp, stdio: "pipe" })
  await fs.writeFile(path.join(tmp, ".gitkeep"), "", "utf-8")
  execFileSync("git", ["add", ".gitkeep"], { cwd: tmp, stdio: "pipe" })
  execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: tmp, stdio: "pipe" })
  return tmp
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

describe("createRun", () => {
  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-zflow-test-runs-"))
    repoRoot = await createTempRepo()
    setRuntimeStateDir(tmpDir)
  })

  after(async () => {
    clearRuntimeStateDir()
    await fs.rm(tmpDir, { recursive: true, force: true })
    await fs.rm(repoRoot, { recursive: true, force: true })
  })

  afterEach(async () => {
    // Clean up run directories between tests
    const runsDir = path.join(tmpDir, "runs")
    try {
      const entries = await fs.readdir(runsDir)
      for (const entry of entries) {
        await fs.rm(path.join(runsDir, entry), { recursive: true, force: true })
      }
    } catch { /* ignore */ }
  })

  test("creates run.json with correct initial structure", async () => {
    runId = "test-run-001"
    const run = await createRun(runId, repoRoot, "ch42", "v1", repoRoot)
    assert.equal(run.runId, runId)
    assert.equal(run.repoRoot, repoRoot)
    assert.equal(run.changeId, "ch42")
    assert.equal(run.planVersion, "v1")
    assert.equal(run.phase, "pending")
    assert.equal(run.applyBack.status, "pending")
    assert.equal(run.verification.status, "pending")
    assert.equal(run.groups.length, 0)
    assert.equal(run.retainedArtifacts.length, 0)
    assert.ok(run.branch.length > 0)
    assert.equal(run.head.length, 40)
    assert.ok(run.createdAt)
    assert.ok(run.updatedAt)
  })

  test("preApplySnapshot is recorded", async () => {
    const run = await createRun("test-run-002", repoRoot, "ch42", "v1", repoRoot)
    assert.ok(run.preApplySnapshot)
    assert.equal(run.preApplySnapshot!.head.length, 40)
    assert.ok(run.preApplySnapshot!.recoveryRef.startsWith("refs/zflow/recovery/"))
  })

  test("throws if run already exists", async () => {
    await createRun("test-run-003", repoRoot, "ch42", "v1", repoRoot)
    await assert.rejects(
      () => createRun("test-run-003", repoRoot, "ch42", "v1", repoRoot),
      /already exists/,
    )
  })

  test("writes file to correct path", async () => {
    const runId4 = "test-run-004"
    await createRun(runId4, repoRoot, "ch42", "v1", repoRoot)
    // Use the same resolve function to verify the path
    const { resolveRunStatePath } = await import("../src/artifact-paths.js")
    const runPath = resolveRunStatePath(runId4, repoRoot)
    const content = await fs.readFile(runPath, "utf-8")
    const parsed = JSON.parse(content) as RunJson
    assert.equal(parsed.runId, runId4)
  })
})

describe("readRun and updateRun", () => {
  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-zflow-test-runs-"))
    repoRoot = await createTempRepo()
    setRuntimeStateDir(tmpDir)
    runId = "test-run-read"
    await createRun(runId, repoRoot, "ch42", "v1", repoRoot)
  })

  after(async () => {
    clearRuntimeStateDir()
    await fs.rm(tmpDir, { recursive: true, force: true })
    await fs.rm(repoRoot, { recursive: true, force: true })
  })

  test("readRun returns the correct run", async () => {
    const run = await readRun(runId, repoRoot)
    assert.equal(run.runId, runId)
    assert.equal(run.changeId, "ch42")
  })

  test("updateRun merges partial changes", async () => {
    const updated = await updateRun(runId, { phase: "executing" }, repoRoot)
    assert.equal(updated.phase, "executing")

    // Verify persistence
    const read = await readRun(runId, repoRoot)
    assert.equal(read.phase, "executing")
  })

  test("updateRun preserves existing fields", async () => {
    const updated = await updateRun(runId, { phase: "completed" }, repoRoot)
    assert.equal(updated.runId, runId)
    assert.equal(updated.changeId, "ch42")
    assert.equal(updated.phase, "completed")
  })

  test("updateRun updates timestamp", async () => {
    const before = await readRun(runId, repoRoot)
    await new Promise((r) => setTimeout(r, 10))
    const updated = await updateRun(runId, { phase: "pending" }, repoRoot)
    assert.ok(new Date(updated.updatedAt) > new Date(before.updatedAt))
  })
})

describe("addGroupToRun", () => {
  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-zflow-test-runs-"))
    repoRoot = await createTempRepo()
    setRuntimeStateDir(tmpDir)
    runId = "test-run-groups"
    await createRun(runId, repoRoot, "ch42", "v1", repoRoot)
  })

  after(async () => {
    clearRuntimeStateDir()
    await fs.rm(tmpDir, { recursive: true, force: true })
    await fs.rm(repoRoot, { recursive: true, force: true })
  })

  test("adds a group to the run", async () => {
    const group: GroupRunMetadata = {
      groupId: "group-1",
      agent: "zflow.implement-routine",
      worktreePath: "/tmp/worktree-1",
      baseCommit: "abc123",
      changedFiles: ["src/foo.ts"],
      patchPath: "/tmp/patches/group-1.patch",
      retained: false,
    }

    await addGroupToRun(runId, group, repoRoot)
    const run = await readRun(runId, repoRoot)
    assert.equal(run.groups.length, 1)
    assert.equal(run.groups[0].groupId, "group-1")
    assert.equal(run.groups[0].agent, "zflow.implement-routine")
  })

  test("adds multiple groups sequentially", async () => {
    const group2: GroupRunMetadata = {
      groupId: "group-2",
      agent: "zflow.implement-hard",
      worktreePath: "/tmp/worktree-2",
      baseCommit: "def456",
      changedFiles: ["src/bar.ts"],
      patchPath: "/tmp/patches/group-2.patch",
      retained: false,
    }

    await addGroupToRun(runId, group2, repoRoot)
    const run = await readRun(runId, repoRoot)
    assert.equal(run.groups.length, 2)
    assert.equal(run.groups[1].groupId, "group-2")
  })
})

describe("addRetainedArtifact", () => {
  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-zflow-test-runs-"))
    repoRoot = await createTempRepo()
    setRuntimeStateDir(tmpDir)
    runId = "test-run-retained"
    await createRun(runId, repoRoot, "ch42", "v1", repoRoot)
  })

  after(async () => {
    clearRuntimeStateDir()
    await fs.rm(tmpDir, { recursive: true, force: true })
    await fs.rm(repoRoot, { recursive: true, force: true })
  })

  test("adds a retained artifact entry", async () => {
    const artifact: RetainedArtifact = {
      type: "worktree",
      path: "/tmp/pi-worktree-test-1",
      reason: "apply-back-conflict",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    }

    await addRetainedArtifact(runId, artifact, repoRoot)
    const run = await readRun(runId, repoRoot)
    assert.equal(run.retainedArtifacts.length, 1)
    assert.equal(run.retainedArtifacts[0].type, "worktree")
    assert.equal(run.retainedArtifacts[0].reason, "apply-back-conflict")
  })
})

describe("setRunPhase", () => {
  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-zflow-test-runs-"))
    repoRoot = await createTempRepo()
    setRuntimeStateDir(tmpDir)
    runId = "test-run-phase"
    await createRun(runId, repoRoot, "ch42", "v1", repoRoot)
  })

  after(async () => {
    clearRuntimeStateDir()
    await fs.rm(tmpDir, { recursive: true, force: true })
    await fs.rm(repoRoot, { recursive: true, force: true })
  })

  test("updates phase correctly", async () => {
    await setRunPhase(runId, "executing", repoRoot)
    const run = await readRun(runId, repoRoot)
    assert.equal(run.phase, "executing")

    await setRunPhase(runId, "applying", repoRoot)
    const run2 = await readRun(runId, repoRoot)
    assert.equal(run2.phase, "applying")

    await setRunPhase(runId, "completed", repoRoot)
    const run3 = await readRun(runId, repoRoot)
    assert.equal(run3.phase, "completed")
  })
})

describe("Recovery ref helpers", () => {
  before(async () => {
    repoRoot = await createTempRepo()
  })

  after(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true })
  })

  test("createRecoveryRef creates a git ref", () => {
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim()

    createRecoveryRef("test-recovery", repoRoot, headSha)

    const refSha = execFileSync("git", ["rev-parse", "refs/zflow/recovery/test-recovery"], {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim()

    assert.equal(refSha, headSha)
  })

  test("removeRecoveryRef removes the git ref", () => {
    removeRecoveryRef("test-recovery", repoRoot)

    assert.throws(() => {
      execFileSync("git", ["rev-parse", "refs/zflow/recovery/test-recovery"], {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      })
    })
  })

  test("resetToPreApplySnapshot resets working tree", () => {
    // Create a commit to reset to
    const originalHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot, encoding: "utf-8",
    }).trim()

    // Make a change and commit it
    execFileSync("git", ["commit", "--allow-empty", "-m", "After snapshot"], {
      cwd: repoRoot, stdio: "pipe",
    })

    const snapshot: PreApplySnapshot = {
      head: originalHead,
      indexState: "clean",
      recoveryRef: "refs/zflow/recovery/test-reset",
    }

    createRecoveryRef("test-reset", repoRoot, originalHead)
    resetToPreApplySnapshot("test-reset", repoRoot, snapshot)

    const headAfter = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot, encoding: "utf-8",
    }).trim()

    assert.equal(headAfter, originalHead)
  })

  test("resetToPreApplySnapshot rejects invalid snapshot.head and preserves untracked files", () => {
    const headBefore = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot, encoding: "utf-8",
    }).trim()

    // Create an untracked file that must survive
    const untrackedPath = path.join(repoRoot, "surviving-notes.txt")
    execFileSync("touch", [untrackedPath], { cwd: repoRoot, stdio: "pipe" })

    const snapshot: PreApplySnapshot = {
      head: "0000000000000000000000000000000000000000",
      indexState: "clean",
      recoveryRef: "refs/zflow/recovery/test-reset-invalid",
    }

    // Should throw because both recovery ref and snapshot.head are invalid
    assert.throws(
      () => resetToPreApplySnapshot("test-reset-invalid", repoRoot, snapshot),
      { message: /not a valid commit/i },
    )

    // HEAD should be unchanged
    const headAfter = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot, encoding: "utf-8",
    }).trim()
    assert.equal(headAfter, headBefore)

    // Untracked file must survive
    assert.doesNotThrow(
      () => accessSync(untrackedPath),
      "untracked file must survive after failed recovery",
    )
  })
})
