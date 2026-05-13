/**
 * worktree-integration.test.ts — Integration tests for Phase 5 worktree
 * orchestration, simulating the full prepare → dispatch → finalize flow.
 */
import * as assert from "node:assert"
import { test, describe, before, after, afterEach } from "node:test"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import { execFileSync } from "node:child_process"
import * as os from "node:os"

import {
  prepareWorktreeImplementationRun,
  finalizeWorktreeImplementationRun,
} from "../extensions/zflow-change-workflows/orchestration.js"

import type { ExecutionGroup } from "../extensions/zflow-change-workflows/ownership-validator.js"
import { captureGroupResult } from "../extensions/zflow-change-workflows/group-result.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let repoRoot: string
let stateDir: string

function setRuntimeStateDir(dir: string) {
  process.env.PI_ZFLOW_RUNTIME_STATE_DIR = dir
}

function clearRuntimeStateDir() {
  delete process.env.PI_ZFLOW_RUNTIME_STATE_DIR
}

async function createTempRepo(): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-zflow-int-"))
  execFileSync("git", ["init"], { cwd: tmp, stdio: "pipe" })
  execFileSync("git", ["config", "user.email", "test@test"], { cwd: tmp, stdio: "pipe" })
  execFileSync("git", ["config", "user.name", "Test"], { cwd: tmp, stdio: "pipe" })

  await fs.mkdir(path.join(tmp, "src"), { recursive: true })
  await fs.writeFile(path.join(tmp, "README.md"), "# Test Repo\n", "utf-8")
  await fs.writeFile(path.join(tmp, "src", "main.ts"), 'console.log("v1")\n', "utf-8")
  await fs.writeFile(path.join(tmp, "src", "utils.ts"), 'export const pi = 3.14;\n', "utf-8")

  execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "pipe" })
  execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: tmp, stdio: "pipe" })
  return tmp
}

async function createWorktree(repoRoot: string): Promise<string> {
  const wtDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-zflow-wt-"))
  execFileSync("git", ["worktree", "add", "--detach", wtDir, "HEAD"], { cwd: repoRoot, stdio: "pipe" })
  return wtDir
}

async function makeChangeInWorktree(worktreePath: string, file: string, content: string): Promise<void> {
  const fullPath = path.join(worktreePath, file)
  await fs.mkdir(path.dirname(fullPath), { recursive: true })
  await fs.writeFile(fullPath, content, "utf-8")
  execFileSync("git", ["add", file], { cwd: worktreePath, stdio: "pipe" })
  execFileSync("git", ["commit", "-m", `[pi-worker] ${file}`], { cwd: worktreePath, stdio: "pipe" })
}

/** Simulate a worker executing a group by creating a worktree, making changes, and capturing results. */
async function simulateGroupExecution(
  groupId: string,
  agentName: string,
  files: string[],
  runId: string,
  repoRoot: string,
): Promise<Awaited<ReturnType<typeof captureGroupResult>>> {
  const wt = await createWorktree(repoRoot)

  for (const file of files) {
    const fullPath = path.join(wt, file)
    await fs.mkdir(path.dirname(fullPath), { recursive: true })
    await fs.appendFile(fullPath, `// modified by ${groupId}\n`, "utf-8")
    execFileSync("git", ["add", file], { cwd: wt, stdio: "pipe" })
  }
  execFileSync("git", ["commit", "-m", `[pi-worker] ${groupId}: implementation`], {
    cwd: wt,
    stdio: "pipe",
  })

  return captureGroupResult({
    groupId,
    agent: agentName,
    worktreePath: wt,
    runId,
    repoRoot,
    scopedFiles: files,
    verification: { status: "pass", command: "echo ok", output: "OK" },
    cwd: repoRoot,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Phase 5 — Worktree orchestration integration", () => {
  before(async () => {
    repoRoot = await createTempRepo()
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-zflow-state-"))
    setRuntimeStateDir(stateDir)
  })

  after(async () => {
    clearRuntimeStateDir()
    await fs.rm(stateDir, { recursive: true, force: true })
    await fs.rm(repoRoot, { recursive: true, force: true })
  })

  afterEach(async () => {
    // Remove any orphaned worktrees first
    try {
      const wtList = execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      })
      const lines = wtList.split("\n")
      for (const line of lines) {
        if (line.startsWith("worktree ")) {
          const wt = line.slice("worktree ".length)
          if (wt !== repoRoot) {
            try {
              execFileSync("git", ["worktree", "remove", "--force", wt], {
                cwd: repoRoot,
                stdio: "pipe",
              })
            } catch { /* ignore */ }
          }
        }
      }
    } catch { /* ignore */ }

    // Reset the temp repo to a clean state
    try {
      execFileSync("git", ["reset", "--hard", "HEAD"], { cwd: repoRoot, stdio: "pipe" })
      execFileSync("git", ["clean", "-fd"], { cwd: repoRoot, stdio: "pipe" })
    } catch { /* ignore */ }
  })

  // ── Test prepare workflow ──────────────────────────────────────

  test("prepareWorktreeImplementationRun succeeds for clean tree", async () => {
    const groups: ExecutionGroup[] = [
      {
        id: "group-1",
        files: ["src/main.ts"],
        dependencies: [],
        parallelizable: true,
      },
      {
        id: "group-2",
        files: ["src/utils.ts"],
        dependencies: [],
        parallelizable: true,
      },
    ]

    const plan = await prepareWorktreeImplementationRun(
      "ch-int",
      "v1",
      groups,
      {},
      { cwd: repoRoot, repoRoot },
    )

    assert.ok(plan.runId, "Should have a run ID")
    assert.equal(plan.tasks.length, 2, "Should have 2 tasks")
    assert.ok(plan.preflight.clean, "Preflight should pass")
    assert.ok(plan.ownershipValidation.valid, "Ownership validation should pass")
    // parallelBatches depends on whether dependencies/conflicts exist
    // With clean non-conflicting groups, all should be in parallelBatches
    assert.equal(plan.run.phase, "pending", "Run should be in pending phase")
    assert.ok(plan.run.preApplySnapshot, "Should have pre-apply snapshot")
    assert.ok(plan.run.preApplySnapshot!.recoveryRef.includes("refs/zflow/recovery/"), "Should have recovery ref")
  })

  test("prepareWorktreeImplementationRun rejects dirty tree", async () => {
    await fs.writeFile(path.join(repoRoot, "src", "dirty.ts"), "// dirty\n", "utf-8")

    const groups: ExecutionGroup[] = [
      {
        id: "group-dirty",
        files: ["src/dirty.ts"],
        dependencies: [],
        parallelizable: true,
      },
    ]

    await assert.rejects(
      () => prepareWorktreeImplementationRun("ch-dirty", "v1", groups, {}, { cwd: repoRoot, repoRoot }),
      (err: Error) => {
        assert.ok(err.message.includes("preflight failed"), `Unexpected: ${err.message}`)
        return true
      },
    )

    execFileSync("git", ["checkout", "--", "."], { cwd: repoRoot, stdio: "pipe" })
    execFileSync("git", ["clean", "-fd"], { cwd: repoRoot, stdio: "pipe" })
  })

  test("prepareWorktreeImplementationRun rejects overlapping untracked files", async () => {
    await fs.writeFile(path.join(repoRoot, "src", "overlap.ts"), "// overlap\n", "utf-8")

    const groups: ExecutionGroup[] = [
      {
        id: "group-overlap",
        files: ["src/overlap.ts"],
        dependencies: [],
        parallelizable: true,
      },
    ]

    await assert.rejects(
      () => prepareWorktreeImplementationRun("ch-overlap", "v1", groups, {}, { cwd: repoRoot, repoRoot }),
      (err: Error) => {
        assert.ok(err.message.includes("preflight failed"), `Unexpected: ${err.message}`)
        return true
      },
    )

    execFileSync("git", ["checkout", "--", "."], { cwd: repoRoot, stdio: "pipe" })
    execFileSync("git", ["clean", "-fd"], { cwd: repoRoot, stdio: "pipe" })
  })

  test("prepareWorktreeImplementationRun detects ownership conflicts", async () => {
    const groups: ExecutionGroup[] = [
      {
        id: "group-a",
        files: ["src/main.ts"],
        dependencies: [],
        parallelizable: true,
      },
      {
        id: "group-b",
        files: ["src/main.ts"], // Same file — conflict
        dependencies: [],
        parallelizable: true,
      },
    ]

    // With no explicit dependency between conflicting groups, this should fail
    await assert.rejects(
      () => prepareWorktreeImplementationRun("ch-conflict", "v1", groups, {}, { cwd: repoRoot, repoRoot }),
      (err: Error) => {
        assert.ok(err.message.includes("validation failed"),
          `Expected validation error, got: ${err.message}`)
        return true
      },
    )
  })

  // ── Test full prepare → dispatch → finalize workflow ──────────

  test("full workflow with two parallel groups succeeds", async () => {
    const groups: ExecutionGroup[] = [
      { id: "g1", files: ["src/main.ts", "README.md"], dependencies: [], parallelizable: true },
      { id: "g2", files: ["src/utils.ts"], dependencies: [], parallelizable: true },
    ]

    const plan = await prepareWorktreeImplementationRun(
      "ch-full", "v1", groups, {}, { cwd: repoRoot, repoRoot },
    )

    const results = []
    for (const group of groups) {
      const r = await simulateGroupExecution(group.id, "zflow.implement-routine", group.files, plan.runId, repoRoot)
      results.push(r)
    }

    assert.equal(results.length, 2)
    for (const r of results) {
      assert.ok(r.changedFiles.length > 0, `Group ${r.groupId} should have changed files`)
    }

    const finalResult = await finalizeWorktreeImplementationRun(
      plan.runId, results,
      { cwd: repoRoot, changeId: "ch-full", planVersion: "v1", executionGroups: groups },
    )

    assert.ok(finalResult.success, `Apply-back should succeed: ${finalResult.error}`)
    assert.equal(finalResult.groupsApplied, 2, "Both groups should be applied")
    assert.ok(!finalResult.rolledBack, "Should not have rolled back")

    // Verify patches applied to primary
    const mainContent = await fs.readFile(path.join(repoRoot, "src", "main.ts"), "utf-8")
    assert.ok(mainContent.includes("// modified by g1"), "main.ts should contain g1 changes")
    const utilsContent = await fs.readFile(path.join(repoRoot, "src", "utils.ts"), "utf-8")
    assert.ok(utilsContent.includes("// modified by g2"), "utils.ts should contain g2 changes")
    const readmeContent = await fs.readFile(path.join(repoRoot, "README.md"), "utf-8")
    assert.ok(readmeContent.includes("// modified by g1"), "README.md should contain g1 changes")

    // Reset for other tests
    execFileSync("git", ["checkout", "--", "."], { cwd: repoRoot, stdio: "pipe" })
    execFileSync("git", ["clean", "-fd"], { cwd: repoRoot, stdio: "pipe" })
  })

  test("preserves existing untracked non-overlapping files", async () => {
    await fs.writeFile(path.join(repoRoot, "src", "user-work.ts"), "// user's work\n", "utf-8")

    const groups: ExecutionGroup[] = [
      { id: "g-ut", files: ["src/main.ts"], dependencies: [], parallelizable: true },
    ]

    const plan = await prepareWorktreeImplementationRun(
      "ch-untracked", "v1", groups, {}, { cwd: repoRoot, repoRoot },
    )

    assert.ok(plan.preflight.clean, "Preflight should pass with non-overlapping untracked files")

    const result = await simulateGroupExecution("g-ut", "zflow.implement-routine", ["src/main.ts"], plan.runId, repoRoot)

    const finalResult = await finalizeWorktreeImplementationRun(
      plan.runId, [result],
      { cwd: repoRoot, changeId: "ch-untracked", planVersion: "v1", executionGroups: groups },
    )

    assert.ok(finalResult.success, "Apply-back should succeed")

    // User's untracked file must still exist
    const userFileExists = await import("node:fs/promises").then(
      (fsp) => fsp.stat(path.join(repoRoot, "src", "user-work.ts")).then(() => true).catch(() => false),
    )
    assert.ok(userFileExists, "User's unrelated untracked file should still exist")

    execFileSync("git", ["checkout", "--", "."], { cwd: repoRoot, stdio: "pipe" })
    execFileSync("git", ["clean", "-fd"], { cwd: repoRoot, stdio: "pipe" })
  })

  test("finalize handles deviation reports gracefully", async () => {
    const groups: ExecutionGroup[] = [
      { id: "g-dev", files: ["src/main.ts"], dependencies: [], parallelizable: true },
    ]

    const plan = await prepareWorktreeImplementationRun(
      "ch-dev", "v1", groups, {}, { cwd: repoRoot, repoRoot },
    )

    // Write a deviation report manually
    const { writeDeviationReport } = await import(
      "../extensions/zflow-change-workflows/deviations.js"
    )
    await writeDeviationReport({
      changeId: "ch-dev",
      planVersion: "v1",
      group: "g-dev",
      reportedBy: "zflow.implement-routine",
      status: "open",
      infeasibleInstruction: "Modify FooService in src/main.ts",
      actualStructure: "FooService does not exist",
      blockingConflict: "Group targets wrong file",
      suggestedAmendment: "Target src/core/foo-service.ts instead",
      filesInspected: ["src/main.ts", "src/core/foo-service.ts"],
      filesAffected: [],
      localEditsReverted: true,
    }, repoRoot)

    const result = await simulateGroupExecution("g-dev", "zflow.implement-routine", ["src/main.ts"], plan.runId, repoRoot)

    const finalResult = await finalizeWorktreeImplementationRun(
      plan.runId, [result],
      { cwd: repoRoot, changeId: "ch-dev", planVersion: "v1", executionGroups: groups },
    )

    assert.ok(finalResult.success, "Apply-back should succeed despite deviation reports")
    assert.ok(finalResult.deviationSummaryPath, "Should have deviation summary path")
    assert.ok(
      finalResult.deviationSummaryPath!.includes("deviation-summary.md"),
      `Summary should be deviation-summary.md, got: ${finalResult.deviationSummaryPath}`,
    )

    execFileSync("git", ["checkout", "--", "."], { cwd: repoRoot, stdio: "pipe" })
    execFileSync("git", ["clean", "-fd"], { cwd: repoRoot, stdio: "pipe" })
  })
})
