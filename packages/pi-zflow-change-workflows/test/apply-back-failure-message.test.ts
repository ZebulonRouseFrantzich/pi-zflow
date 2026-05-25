/**
 * Tests for formatApplyBackFailureMessage.
 *
 * Verifies that apply-back failure messages always include:
 * - The run ID
 * - The /zflow-resolve-apply-back <runId> command
 * - Options for recovery
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

// We test the formatter directly by importing the module.
// Since it uses dynamic imports inside, we test its output
// contract by calling it in a controlled environment.

describe("formatApplyBackFailureMessage", () => {
  let tmpDir: string
  let runDir: string
  let patchesDir: string
  let runStateDir: string

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "zflow-test-"))
    runDir = join(tmpDir, "runs", "test-run-123")
    patchesDir = join(runDir, "patches")
    runStateDir = join(tmpDir, "runs")
    await mkdir(patchesDir, { recursive: true })

    // Write a minimal run.json so the formatter can read changeId
    const runJson = {
      runId: "test-run-123",
      changeId: "test-change",
      planVersion: "v1",
      repoRoot: tmpDir,
      head: "abc123",
      phase: "applying",
      applyBack: { status: "failed", error: "3-way merge conflict in src/config.ts" },
      groups: [],
      preApplySnapshot: { head: "abc123", indexState: "clean", recoveryRef: "refs/zflow/recovery/test-run-123" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    await writeFile(
      join(runDir, "run.json"),
      JSON.stringify(runJson, null, 2),
      "utf-8",
    )
  })

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("includes the run ID in the formatted message", async () => {
    const { formatApplyBackFailureMessage } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    // Override the cwd so pi-zflow paths resolve under our temp dir.
    // We provide an explicit cwd=tmpDir and rely on the runDir resolution.
    // The formatter calls resolveRunDir() which uses the git-dir convention.
    // For this test we just verify the string structure.
    const msg = await formatApplyBackFailureMessage(
      "test-run-123",
      "test-change",
      "3-way merge conflict in src/config.ts",
      tmpDir,
      {
        patchesDir,
        integrationWorktreePath: join(runDir, "integration-worktree"),
        strategiesAttempted: ["patch-replay", "structured-merge"],
      },
    )
    assert.ok(msg.includes("test-run-123"), "message must include run ID")
    assert.ok(
      msg.includes("/zflow-resolve-apply-back test-run-123"),
      "message must include /zflow-resolve-apply-back <runId>",
    )
    assert.ok(msg.includes("test-change"), "message must include change ID")
    assert.ok(
      msg.includes(patchesDir),
      "message must include patches directory path",
    )
    assert.ok(
      msg.includes("patch-replay"),
      "message must include strategies attempted",
    )
    assert.ok(
      msg.includes("integration-worktree"),
      "message must include integration worktree path",
    )
  })

  it("includes recovery command options", async () => {
    const { formatApplyBackFailureMessage } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    const msg = await formatApplyBackFailureMessage(
      "test-run-123",
      "test-change",
      "test error",
      tmpDir,
      { patchesDir, integrationWorktreePath: join(runDir, "integration-worktree") },
    )
    assert.ok(msg.includes("--resume"), "message must mention --resume option")
    assert.ok(msg.includes("--abandon"), "message must mention --abandon option")
    assert.ok(msg.includes("Subagent resolution"), "message must mention subagent resolution")
    assert.ok(msg.includes("Inspect artifacts"), "message must mention artifact inspection")
  })

  it("works without optional extra fields", async () => {
    const { formatApplyBackFailureMessage } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    const msg = await formatApplyBackFailureMessage(
      "test-run-123",
      "test-change",
      "generic failure",
      tmpDir,
      // No extra fields provided
    )
    assert.ok(msg.includes("test-run-123"))
    assert.ok(
      msg.includes("/zflow-resolve-apply-back test-run-123"),
    )
    // Strategies should have a default value
    assert.ok(
      msg.includes("patch-replay"),
      "default strategies should be listed when none provided",
    )
  })

  it("includes resolution prompt path when provided", async () => {
    const { formatApplyBackFailureMessage } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    const promptPath = join(runDir, "subagent-resolution-prompt.md")
    const msg = await formatApplyBackFailureMessage(
      "test-run-123",
      "test-change",
      "test error",
      tmpDir,
      { patchesDir, resolutionPromptPath: promptPath },
    )
    assert.ok(
      msg.includes(promptPath),
      "message must include resolution prompt path",
    )
  })
})
