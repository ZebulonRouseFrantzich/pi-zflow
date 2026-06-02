/**
 * resume-reconciler.test.ts — Unit tests for resume-reconciler.ts.
 */
import * as assert from "node:assert"
import { test, describe, before, after } from "node:test"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import * as fsSync from "node:fs"
import { execFileSync } from "node:child_process"
import * as os from "node:os"

import { reconcileResumeState, findBestResumeRun } from "../extensions/zflow-change-workflows/resume-reconciler.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTempRepo(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-zflow-resume-"))
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
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf-8" }).trim()
}

/**
 * Create a minimal run.json for testing the reconciler.
 */
async function createRunJson(
  runDir: string,
  runId: string,
  repoRoot: string,
  changeId: string,
  phase: string,
  groups: Array<{
    groupId: string
    changedFiles?: string[]
    patchPath?: string
  }>,
  groupLedger?: Record<string, Record<string, unknown>>,
  extraFields?: Record<string, unknown>,
): Promise<void> {
  await fs.mkdir(path.join(runDir, ".zflow", "runs", runId), { recursive: true })
  const runJson = {
    runId,
    repoRoot,
    branch: "main",
    head: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot, encoding: "utf-8",
    }).trim(),
    changeId,
    planVersion: "1",
    phase,
    groups: groups.map((g) => ({
      groupId: g.groupId,
      agent: "zflow.implement-routine",
      worktreePath: "",
      baseCommit: "",
      changedFiles: g.changedFiles ?? [],
      patchPath: g.patchPath ?? "",
      retained: false,
    })),
    applyBack: { status: "pending" },
    verification: { status: "pending" },
    retainedArtifacts: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: groupLedger ? { groupLedger } : {},
    ...extraFields,
  }
  await fs.writeFile(
    path.join(runDir, ".zflow", "runs", runId, "run.json"),
    JSON.stringify(runJson, null, 2),
    "utf-8",
  )
}

/**
 * Write a minimal execution-groups.md for testing.
 */
function writeExecGroupsMd(repoRoot: string, groups: string[][]): void {
  const lines = ["# Execution Groups", ""]
  for (const [id, file] of groups) {
    lines.push(`## Group ${id}: test`)
    lines.push("")
    lines.push(`- **Files:** ${file}`)
    lines.push(`- **Agent:** zflow.implement-routine`)
    lines.push("")
  }
  writeFile(repoRoot, ".zflow/plans/test-change/v1/execution-groups.md", lines.join("\n"))
}

// ---------------------------------------------------------------------------
// reconcileResumeState
// ---------------------------------------------------------------------------

describe("reconcileResumeState", () => {
  test("all patches reusable → applyBackNeeded = true", async () => {
    const repo = await createTempRepo()
    writeFile(repo, "README.md", "# Test\n")
    gitAddCommit(repo, "initial")

    const runId = "test-run-1"
    const changeId = "test-change"
    const runDir = repo

    // Create patch files on disk
    const patchesDir = path.join(runDir, ".zflow", "runs", runId, "patches")
    await fs.mkdir(patchesDir, { recursive: true })
    const patch1 = path.join(patchesDir, "group-1.patch")
    const patch2 = path.join(patchesDir, "group-2.patch")
    fsSync.writeFileSync(patch1, "diff --git a/a.ts b/a.ts\nindex a..b 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-// old\n+// new\n", "utf-8")
    fsSync.writeFileSync(patch2, "diff --git a/b.ts b/b.ts\nindex c..d 100644\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-// base\n+// updated\n", "utf-8")

    // Create run.json with groups that have patches and succeeded status
    const groupLedger: Record<string, Record<string, unknown>> = {
      "group-1": {
        groupId: "group-1",
        status: "succeeded",
        agent: "zflow.implement-routine",
        taskPrompt: "Do work on a.ts",
        files: ["a.ts"],
        dependencies: [],
        semanticCoupling: { dependsOnGroups: [], blocksGroups: [], sharedFiles: [], notes: [] },
        patchPath: patch1,
        appliedToPrimary: false,
        retryCount: 0,
        updatedAt: new Date().toISOString(),
      },
      "group-2": {
        groupId: "group-2",
        status: "succeeded",
        agent: "zflow.implement-routine",
        taskPrompt: "Do work on b.ts",
        files: ["b.ts"],
        dependencies: [],
        semanticCoupling: { dependsOnGroups: [], blocksGroups: [], sharedFiles: [], notes: [] },
        patchPath: patch2,
        appliedToPrimary: false,
        retryCount: 0,
        updatedAt: new Date().toISOString(),
      },
    }

    await createRunJson(
      runDir, runId, repo, changeId, "executing",
      [
        { groupId: "group-1", changedFiles: ["a.ts"], patchPath: patch1 },
        { groupId: "group-2", changedFiles: ["b.ts"], patchPath: patch2 },
      ],
      groupLedger,
    )

    // Write the current execution groups plan
    writeExecGroupsMd(repo, [["1", "a.ts"], ["2", "b.ts"]])

    const result = await reconcileResumeState(runId, changeId, "v1", repo)
    assert.equal(result.hasPreviousRun, true)
    assert.equal(result.previousRunId, runId)
    assert.equal(result.reusableGroups.length, 2)
    assert.equal(result.groupsNeedingRerun.length, 0)
    assert.equal(result.alreadyAppliedGroups.length, 0)
    assert.equal(result.applyBackNeeded, true)
    assert.equal(result.recommendedNextStep, "apply-back")

    await fs.rm(repo, { recursive: true, force: true })
  })

  test("some patches missing → groupsNeedingRerun populated", async () => {
    const repo = await createTempRepo()
    writeFile(repo, "README.md", "# Test\n")
    gitAddCommit(repo, "initial")

    const runId = "test-run-2"
    const changeId = "test-change"
    const runDir = repo

    // Create only one patch file
    const patchesDir = path.join(runDir, ".zflow", "runs", runId, "patches")
    await fs.mkdir(patchesDir, { recursive: true })
    const patch1 = path.join(patchesDir, "group-1.patch")
    fsSync.writeFileSync(patch1, "diff --git a/a.ts b/a.ts\nindex a..b 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-// old\n+// new\n", "utf-8")

    const groupLedger: Record<string, Record<string, unknown>> = {
      "group-1": {
        groupId: "group-1",
        status: "succeeded",
        agent: "zflow.implement-routine",
        taskPrompt: "Do work on a.ts",
        files: ["a.ts"],
        dependencies: [],
        semanticCoupling: { dependsOnGroups: [], blocksGroups: [], sharedFiles: [], notes: [] },
        patchPath: patch1,
        appliedToPrimary: false,
        retryCount: 0,
        updatedAt: new Date().toISOString(),
      },
      // group-2 has no patchPath
      "group-2": {
        groupId: "group-2",
        status: "pending",
        agent: "zflow.implement-routine",
        taskPrompt: "Do work on b.ts",
        files: ["b.ts"],
        dependencies: [],
        semanticCoupling: { dependsOnGroups: [], blocksGroups: [], sharedFiles: [], notes: [] },
        appliedToPrimary: false,
        retryCount: 0,
        updatedAt: new Date().toISOString(),
      },
    }

    await createRunJson(
      runDir, runId, repo, changeId, "executing",
      [
        { groupId: "group-1", changedFiles: ["a.ts"], patchPath: patch1 },
        { groupId: "group-2", changedFiles: ["b.ts"] },
      ],
      groupLedger,
    )

    writeExecGroupsMd(repo, [["1", "a.ts"], ["2", "b.ts"]])

    const result = await reconcileResumeState(runId, changeId, "v1", repo)
    assert.equal(result.hasPreviousRun, true)
    assert.equal(result.reusableGroups.length, 1)
    assert.equal(result.reusableGroups[0].groupId, "group-1")
    assert.equal(result.groupsNeedingRerun.length, 1)
    assert.equal(result.groupsNeedingRerun[0].groupId, "group-2")
    assert.equal(result.applyBackNeeded, false) // need to rerun first
    assert.equal(result.recommendedNextStep, "rerun-groups")

    await fs.rm(repo, { recursive: true, force: true })
  })

  test("downstream queued groups waiting on failed dependencies are not counted as rerun groups", async () => {
    const repo = await createTempRepo()
    writeFile(repo, "README.md", "# Test\n")
    gitAddCommit(repo, "initial")

    const runId = "test-run-dependency-wait"
    const changeId = "test-change"
    const runDir = repo

    const groupLedger: Record<string, Record<string, unknown>> = {
      "group-1": {
        groupId: "group-1",
        status: "failed",
        agent: "zflow.implement-routine",
        taskPrompt: "Do work on a.ts",
        files: ["a.ts"],
        dependencies: [],
        semanticCoupling: { dependsOnGroups: [], blocksGroups: ["group-2"], sharedFiles: [], notes: [] },
        appliedToPrimary: false,
        retryCount: 1,
        error: "429 rate limit exceeded",
        updatedAt: new Date().toISOString(),
      },
      "group-2": {
        groupId: "group-2",
        status: "queued",
        agent: "zflow.implement-routine",
        taskPrompt: "Do work on b.ts",
        files: ["b.ts"],
        dependencies: ["group-1"],
        semanticCoupling: { dependsOnGroups: ["group-1"], blocksGroups: [], sharedFiles: [], notes: [] },
        appliedToPrimary: false,
        retryCount: 0,
        updatedAt: new Date().toISOString(),
      },
    }

    await createRunJson(
      runDir, runId, repo, changeId, "partial",
      [
        { groupId: "group-1", changedFiles: ["a.ts"] },
        { groupId: "group-2", changedFiles: ["b.ts"] },
      ],
      groupLedger,
    )

    writeFile(repo, ".zflow/plans/test-change/v1/execution-groups.md", [
      "# Execution Groups",
      "",
      "## Group 1: test",
      "",
      "- **Files:** a.ts",
      "- **Agent:** zflow.implement-routine",
      "- **Dependencies:** none",
      "",
      "## Group 2: test",
      "",
      "- **Files:** b.ts",
      "- **Agent:** zflow.implement-routine",
      "- **Dependencies:** group-1",
      "",
    ].join("\n"))

    const result = await reconcileResumeState(runId, changeId, "v1", repo)
    assert.equal(result.groupsNeedingRerun.length, 1)
    assert.equal(result.groupsNeedingRerun[0].groupId, "group-1")
    assert.equal(result.recommendedNextStep, "rerun-groups")
    assert.match(result.summary, /1\/2 group\(s\) need rerun\./)
    assert.match(result.summary, /1\/2 group\(s\) are still waiting on dependency reruns\./)

    await fs.rm(repo, { recursive: true, force: true })
  })

  test("all groups already applied → applyBackNeeded = false", async () => {
    const repo = await createTempRepo()
    writeFile(repo, "README.md", "# Test\n")
    gitAddCommit(repo, "initial")

    const runId = "test-run-3"
    const changeId = "test-change"
    const runDir = repo

    const patchesDir = path.join(runDir, ".zflow", "runs", runId, "patches")
    await fs.mkdir(patchesDir, { recursive: true })
    const patch1 = path.join(patchesDir, "group-1.patch")
    fsSync.writeFileSync(patch1, "diff --git a/a.ts b/a.ts\nindex a..b 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-// old\n+// new\n", "utf-8")

    const groupLedger: Record<string, Record<string, unknown>> = {
      "group-1": {
        groupId: "group-1",
        status: "applied",
        agent: "zflow.implement-routine",
        taskPrompt: "Do work on a.ts",
        files: ["a.ts"],
        dependencies: [],
        semanticCoupling: { dependsOnGroups: [], blocksGroups: [], sharedFiles: [], notes: [] },
        patchPath: patch1,
        appliedToPrimary: true,
        retryCount: 0,
        updatedAt: new Date().toISOString(),
      },
    }

    await createRunJson(
      runDir, runId, repo, changeId, "partial",
      [{ groupId: "group-1", changedFiles: ["a.ts"], patchPath: patch1 }],
      groupLedger,
    )

    writeExecGroupsMd(repo, [["1", "a.ts"]])

    const result = await reconcileResumeState(runId, changeId, "v1", repo)
    assert.equal(result.hasPreviousRun, true)
    assert.equal(result.alreadyAppliedGroups.length, 1)
    assert.equal(result.groupsNeedingRerun.length, 0)
    assert.equal(result.applyBackNeeded, false)
    assert.equal(result.verificationNeeded, true)
    assert.equal(result.recommendedNextStep, "verify")

    await fs.rm(repo, { recursive: true, force: true })
  })

  test("apply-back-conflicted phase → applyBackNeeded = true", async () => {
    const repo = await createTempRepo()
    writeFile(repo, "README.md", "# Test\n")
    gitAddCommit(repo, "initial")

    const runId = "test-run-4"
    const changeId = "test-change"
    const runDir = repo

    const patchesDir = path.join(runDir, ".zflow", "runs", runId, "patches")
    await fs.mkdir(patchesDir, { recursive: true })
    const patch1 = path.join(patchesDir, "group-1.patch")
    fsSync.writeFileSync(patch1, "diff --git a/a.ts b/a.ts\nindex a..b 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-// old\n+// new\n", "utf-8")

    const groupLedger: Record<string, Record<string, unknown>> = {
      "group-1": {
        groupId: "group-1",
        status: "applied",
        agent: "zflow.implement-routine",
        taskPrompt: "Do work on a.ts",
        files: ["a.ts"],
        dependencies: [],
        semanticCoupling: { dependsOnGroups: [], blocksGroups: [], sharedFiles: [], notes: [] },
        patchPath: patch1,
        appliedToPrimary: true,
        retryCount: 1,
        updatedAt: new Date().toISOString(),
      },
    }

    await createRunJson(
      runDir, runId, repo, changeId, "apply-back-conflicted",
      [{ groupId: "group-1", changedFiles: ["a.ts"], patchPath: patch1 }],
      groupLedger,
    )

    writeExecGroupsMd(repo, [["1", "a.ts"]])

    const result = await reconcileResumeState(runId, changeId, "v1", repo)
    assert.equal(result.hasPreviousRun, true)
    assert.equal(result.reusableGroups.length, 1)
    assert.equal(result.alreadyAppliedGroups.length, 0)
    assert.equal(result.applyBackNeeded, true)
    assert.equal(result.applyBackCanUseCascade, true)
    assert.equal(result.recommendedNextStep, "apply-back")

    await fs.rm(repo, { recursive: true, force: true })
  })

  test("handles non-existent run", async () => {
    const result = await reconcileResumeState("nonexistent-run", "test-change", "v1")
    assert.equal(result.hasPreviousRun, false)
    assert.equal(result.groupsNeedingRerun.length, 0)
    assert.equal(result.recommendedNextStep, "inspect")
  })

  test("marks review needed when verification is newer than codeReview (stale review)", async () => {
    const repo = await createTempRepo()
    writeFile(repo, "README.md", "# Test\n")
    gitAddCommit(repo, "initial")

    const runId = "test-run-stale-review"
    const changeId = "test-change"
    const runDir = repo

    // Create patch file on disk
    const patchesDir = path.join(runDir, ".zflow", "runs", runId, "patches")
    await fs.mkdir(patchesDir, { recursive: true })
    const patch1 = path.join(patchesDir, "group-1.patch")
    fsSync.writeFileSync(patch1, "diff --git a/a.ts b/a.ts\nindex a..b 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-// old\n+// new\n", "utf-8")

    // Set up: all groups applied, verification passed (newer timestamp),
    // codeReview exists (older timestamp, pass=false)
    const groupLedger: Record<string, Record<string, unknown>> = {
      "group-1": {
        groupId: "group-1",
        status: "applied",
        agent: "zflow.implement-routine",
        taskPrompt: "Do work",
        files: ["a.ts"],
        dependencies: [],
        semanticCoupling: { dependsOnGroups: [], blocksGroups: [], sharedFiles: [], notes: [] },
        patchPath: patch1,
        appliedToPrimary: true,
        retryCount: 0,
        updatedAt: new Date().toISOString(),
      },
    }

    const verificationPassedAt = new Date(Date.now() - 1000 * 60).toISOString()  // 1 min ago
    const codeReviewCompletedAt = new Date(Date.now() - 1000 * 60 * 10).toISOString()  // 10 min ago

    await createRunJson(
      runDir, runId, repo, changeId, "executing",
      [{ groupId: "group-1", changedFiles: ["a.ts"], patchPath: patch1 }],
      groupLedger,
      {
        applyBack: { status: "completed", completedAt: new Date(Date.now() - 1000 * 60 * 20).toISOString() },
        verification: { status: "passed", completedAt: verificationPassedAt },
        codeReview: { pass: false, summary: "Found issues", completedAt: codeReviewCompletedAt },
      },
    )

    writeExecGroupsMd(repo, [["1", "a.ts"]])

    const result = await reconcileResumeState(runId, changeId, "v1", repo)
    assert.equal(result.hasPreviousRun, true)
    assert.equal(result.alreadyAppliedGroups.length, 1)
    assert.equal(result.applyBackNeeded, false)
    assert.equal(result.verificationNeeded, false)  // verification already current
    assert.equal(result.reviewNeeded, true)  // stale code review
    assert.equal(result.recommendedNextStep, "review")

    await fs.rm(repo, { recursive: true, force: true })
  })

  test("marks review needed when codeReview exists with pass=false and is current", async () => {
    const repo = await createTempRepo()
    writeFile(repo, "README.md", "# Test\n")
    gitAddCommit(repo, "initial")

    const runId = "test-run-failed-review"
    const changeId = "test-change"
    const runDir = repo

    const patchesDir = path.join(runDir, ".zflow", "runs", runId, "patches")
    await fs.mkdir(patchesDir, { recursive: true })
    const patch1 = path.join(patchesDir, "group-1.patch")
    fsSync.writeFileSync(patch1, "diff --git a/a.ts b/a.ts\nindex a..b 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-// old\n+// new\n", "utf-8")

    // Set up: all groups applied, verification passed, codeReview exists
    // with pass=false and is current (same timeframe as verification).
    const now = new Date()
    const sharedTs = now.toISOString()

    const groupLedger: Record<string, Record<string, unknown>> = {
      "group-1": {
        groupId: "group-1",
        status: "applied",
        agent: "zflow.implement-routine",
        taskPrompt: "Do work",
        files: ["a.ts"],
        dependencies: [],
        semanticCoupling: { dependsOnGroups: [], blocksGroups: [], sharedFiles: [], notes: [] },
        patchPath: patch1,
        appliedToPrimary: true,
        retryCount: 0,
        updatedAt: sharedTs,
      },
    }

    await createRunJson(
      runDir, runId, repo, changeId, "executing",
      [{ groupId: "group-1", changedFiles: ["a.ts"], patchPath: patch1 }],
      groupLedger,
      {
        applyBack: { status: "completed", completedAt: sharedTs },
        verification: { status: "passed", completedAt: sharedTs },
        codeReview: { pass: false, summary: "Found issues", completedAt: sharedTs },
      },
    )

    writeExecGroupsMd(repo, [["1", "a.ts"]])

    const result = await reconcileResumeState(runId, changeId, "v1", repo)
    assert.equal(result.hasPreviousRun, true)
    assert.equal(result.verificationNeeded, false)
    assert.equal(result.reviewNeeded, true)  // failed review needs rerun
    assert.equal(result.recommendedNextStep, "review")

    await fs.rm(repo, { recursive: true, force: true })
  })

  test("review not needed when codeReview passed and is current", async () => {
    const repo = await createTempRepo()
    writeFile(repo, "README.md", "# Test\n")
    gitAddCommit(repo, "initial")

    const runId = "test-run-passed-review"
    const changeId = "test-change"
    const runDir = repo

    const patchesDir = path.join(runDir, ".zflow", "runs", runId, "patches")
    await fs.mkdir(patchesDir, { recursive: true })
    const patch1 = path.join(patchesDir, "group-1.patch")
    fsSync.writeFileSync(patch1, "diff --git a/a.ts b/a.ts\nindex a..b 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-// old\n+// new\n", "utf-8")

    const now = new Date()
    const sharedTs = now.toISOString()

    const groupLedger: Record<string, Record<string, unknown>> = {
      "group-1": {
        groupId: "group-1",
        status: "applied",
        agent: "zflow.implement-routine",
        taskPrompt: "Do work",
        files: ["a.ts"],
        dependencies: [],
        semanticCoupling: { dependsOnGroups: [], blocksGroups: [], sharedFiles: [], notes: [] },
        patchPath: patch1,
        appliedToPrimary: true,
        retryCount: 0,
        updatedAt: sharedTs,
      },
    }

    await createRunJson(
      runDir, runId, repo, changeId, "executing",
      [{ groupId: "group-1", changedFiles: ["a.ts"], patchPath: patch1 }],
      groupLedger,
      {
        applyBack: { status: "completed", completedAt: sharedTs },
        verification: { status: "passed", completedAt: sharedTs },
        codeReview: { pass: true, summary: "All good", completedAt: sharedTs },
      },
    )

    writeExecGroupsMd(repo, [["1", "a.ts"]])

    const result = await reconcileResumeState(runId, changeId, "v1", repo)
    assert.equal(result.hasPreviousRun, true)
    assert.equal(result.verificationNeeded, false)
    assert.equal(result.reviewNeeded, false)
    assert.equal(result.recommendedNextStep, "complete")

    await fs.rm(repo, { recursive: true, force: true })
  })

  test("verification stale when apply-back completed after verification", async () => {
    const repo = await createTempRepo()
    writeFile(repo, "README.md", "# Test\n")
    gitAddCommit(repo, "initial")

    const runId = "test-run-stale-verif"
    const changeId = "test-change"
    const runDir = repo

    const patchesDir = path.join(runDir, ".zflow", "runs", runId, "patches")
    await fs.mkdir(patchesDir, { recursive: true })
    const patch1 = path.join(patchesDir, "group-1.patch")
    fsSync.writeFileSync(patch1, "diff --git a/a.ts b/a.ts\nindex a..b 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-// old\n+// new\n", "utf-8")

    // Set up: apply-back completed AFTER verification — verification is stale
    const now = Date.now()
    const verificationTs = new Date(now - 1000 * 60 * 30).toISOString()  // 30 min ago
    const applyBackTs = new Date(now - 1000 * 60 * 15).toISOString()    // 15 min ago (newer)

    const groupLedger: Record<string, Record<string, unknown>> = {
      "group-1": {
        groupId: "group-1",
        status: "applied",
        agent: "zflow.implement-routine",
        taskPrompt: "Do work",
        files: ["a.ts"],
        dependencies: [],
        semanticCoupling: { dependsOnGroups: [], blocksGroups: [], sharedFiles: [], notes: [] },
        patchPath: patch1,
        appliedToPrimary: true,
        retryCount: 0,
        updatedAt: applyBackTs,
      },
    }

    await createRunJson(
      runDir, runId, repo, changeId, "executing",
      [{ groupId: "group-1", changedFiles: ["a.ts"], patchPath: patch1 }],
      groupLedger,
      {
        applyBack: { status: "completed", completedAt: applyBackTs },
        verification: { status: "passed", completedAt: verificationTs },
      },
    )

    writeExecGroupsMd(repo, [["1", "a.ts"]])

    const result = await reconcileResumeState(runId, changeId, "v1", repo)
    assert.equal(result.hasPreviousRun, true)
    assert.equal(result.verificationNeeded, true)  // stale
    assert.equal(result.recommendedNextStep, "verify")

    await fs.rm(repo, { recursive: true, force: true })
  })

  test("review needed when verification passed but no codeReview exists", async () => {
    const repo = await createTempRepo()
    writeFile(repo, "README.md", "# Test\n")
    gitAddCommit(repo, "initial")

    const runId = "test-run-no-review"
    const changeId = "test-change"
    const runDir = repo

    const patchesDir = path.join(runDir, ".zflow", "runs", runId, "patches")
    await fs.mkdir(patchesDir, { recursive: true })
    const patch1 = path.join(patchesDir, "group-1.patch")
    fsSync.writeFileSync(patch1, "diff --git a/a.ts b/a.ts\nindex a..b 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-// old\n+// new\n", "utf-8")

    const now = new Date()
    const sharedTs = now.toISOString()

    const groupLedger: Record<string, Record<string, unknown>> = {
      "group-1": {
        groupId: "group-1",
        status: "applied",
        agent: "zflow.implement-routine",
        taskPrompt: "Do work",
        files: ["a.ts"],
        dependencies: [],
        semanticCoupling: { dependsOnGroups: [], blocksGroups: [], sharedFiles: [], notes: [] },
        patchPath: patch1,
        appliedToPrimary: true,
        retryCount: 0,
        updatedAt: sharedTs,
      },
    }

    await createRunJson(
      runDir, runId, repo, changeId, "executing",
      [{ groupId: "group-1", changedFiles: ["a.ts"], patchPath: patch1 }],
      groupLedger,
      {
        applyBack: { status: "completed", completedAt: sharedTs },
        verification: { status: "passed", completedAt: sharedTs },
        // No codeReview field
      },
    )

    writeExecGroupsMd(repo, [["1", "a.ts"]])

    const result = await reconcileResumeState(runId, changeId, "v1", repo)
    assert.equal(result.hasPreviousRun, true)
    assert.equal(result.verificationNeeded, false)
    assert.equal(result.reviewNeeded, true)  // no code review done
    assert.equal(result.recommendedNextStep, "review")

    await fs.rm(repo, { recursive: true, force: true })
  })

  test("review is not needed when verification failed and no codeReview exists", async () => {
    const repo = await createTempRepo()
    writeFile(repo, "README.md", "# Test\n")
    gitAddCommit(repo, "initial")

    const runId = "test-run-no-review-on-failed-verification"
    const changeId = "test-change"
    const runDir = repo

    const patchesDir = path.join(runDir, ".zflow", "runs", runId, "patches")
    await fs.mkdir(patchesDir, { recursive: true })
    const patch1 = path.join(patchesDir, "group-1.patch")
    fsSync.writeFileSync(patch1, "diff --git a/a.ts b/a.ts\nindex a..b 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-// old\n+// new\n", "utf-8")

    const verificationCompletedAt = new Date().toISOString()
    const groupLedger: Record<string, Record<string, unknown>> = {
      "group-1": {
        groupId: "group-1",
        status: "applied",
        agent: "zflow.implement-routine",
        taskPrompt: "Do work",
        files: ["a.ts"],
        dependencies: [],
        semanticCoupling: { dependsOnGroups: [], blocksGroups: [], sharedFiles: [], notes: [] },
        patchPath: patch1,
        appliedToPrimary: true,
        retryCount: 0,
        updatedAt: verificationCompletedAt,
      },
    }

    await createRunJson(
      runDir, runId, repo, changeId, "executing",
      [{ groupId: "group-1", changedFiles: ["a.ts"], patchPath: patch1 }],
      groupLedger,
      {
        applyBack: { status: "completed", completedAt: verificationCompletedAt },
        verification: { status: "failed", completedAt: verificationCompletedAt },
      },
    )

    writeExecGroupsMd(repo, [["1", "a.ts"]])

    const result = await reconcileResumeState(runId, changeId, "v1", repo)
    assert.equal(result.reviewNeeded, false)
    assert.notEqual(result.recommendedNextStep, "review")

    await fs.rm(repo, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// findBestResumeRun
// ---------------------------------------------------------------------------

describe("findBestResumeRun", () => {
  test("finds the latest partial run", async () => {
    const repo = await createTempRepo()
    writeFile(repo, "README.md", "# Test\n")
    gitAddCommit(repo, "initial")

    // Create a state-index entry for the change with proper changes map
    const stateIndexDir = path.join(repo, ".zflow")
    await fs.mkdir(stateIndexDir, { recursive: true })

    // Create two runs: one partial, one completed
    const partialRunId = "run-partial"
    const completedRunId = "run-completed"

    // Write the state-index with the correct schema (changes map, not entries array)
    const stateIndex = {
      version: 1,
      entries: [],
      changes: {
        "test-change": {
          changeId: "test-change",
          unfinishedRuns: [completedRunId, partialRunId],
          lastPhase: "partial",
        },
      },
    }

    await fs.writeFile(
      path.join(stateIndexDir, "state-index.json"),
      JSON.stringify(stateIndex, null, 2),
      "utf-8",
    )

    // Create run.json files at .zflow/runs/<runId>/run.json
    for (const [runId, phase] of [[partialRunId, "partial"], [completedRunId, "completed"]] as const) {
      const runJson = {
        runId,
        repoRoot: repo,
        branch: "main",
        head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf-8" }).trim(),
        changeId: "test-change",
        planVersion: "1",
        phase,
        groups: [],
        applyBack: { status: "pending" },
        verification: { status: "pending" },
        retainedArtifacts: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      await fs.mkdir(path.join(stateIndexDir, "runs", runId), { recursive: true })
      await fs.writeFile(
        path.join(stateIndexDir, "runs", runId, "run.json"),
        JSON.stringify(runJson, null, 2),
        "utf-8",
      )
    }

    const result = await findBestResumeRun("test-change", repo)
    assert.equal(result, partialRunId)

    await fs.rm(repo, { recursive: true, force: true })
  })

  test("returns null when no unfinished runs", async () => {
    const repo = await createTempRepo()
    writeFile(repo, "README.md", "# Test\n")
    gitAddCommit(repo, "initial")

    const stateIndexDir = path.join(repo, ".zflow")
    await fs.mkdir(stateIndexDir, { recursive: true })

    // Empty state index — no entries, no changes
    const stateIndex = { version: 1, entries: [], changes: {} }
    await fs.writeFile(
      path.join(stateIndexDir, "state-index.json"),
      JSON.stringify(stateIndex, null, 2),
      "utf-8",
    )

    const result = await findBestResumeRun("test-change", repo)
    assert.equal(result, null)

    await fs.rm(repo, { recursive: true, force: true })
  })

  test("returns null for non-existent change", async () => {
    const repo = await createTempRepo()
    writeFile(repo, "README.md", "# Test\n")
    gitAddCommit(repo, "initial")

    const result = await findBestResumeRun("nonexistent-change", repo)
    assert.equal(result, null)

    await fs.rm(repo, { recursive: true, force: true })
  })
})
