import * as assert from "node:assert/strict"
import { describe, test } from "node:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { execFileSync } from "node:child_process"

import { createRun, readRun } from "pi-zflow-artifacts"

import {
  persistImplementationDispatchSnapshot,
} from "../extensions/zflow-change-workflows/orchestration/implementation/live-progress.js"

async function createTestRepo(): Promise<string> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-live-progress-"))
  execFileSync("git", ["init"], { cwd: repoRoot, stdio: "pipe" })
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoRoot, stdio: "pipe" })
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoRoot, stdio: "pipe" })
  await fs.writeFile(path.join(repoRoot, "README.md"), "# test\n", "utf-8")
  execFileSync("git", ["add", "."], { cwd: repoRoot, stdio: "pipe" })
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "pipe" })
  return repoRoot
}

describe("persistImplementationDispatchSnapshot", () => {
  test("merges live dispatch progress into run.json metadata and group ledger", async () => {
    const repoRoot = await createTestRepo()
    try {
      const run = await createRun("impl-live-progress-test", repoRoot, "change-a", "v1", repoRoot)

      await persistImplementationDispatchSnapshot(run.runId, {
        groupUpdates: {
          "group-g1": {
            status: "running",
            agent: "worker",
            lastCommand: "bash yarn jest --runInBand",
            currentTool: "bash",
            model: "azure-ai-foundry/DeepSeek-V4-Flash",
            thinking: "xhigh",
            startedAt: "2026-06-02T18:00:00.000Z",
            lastProgressAt: "2026-06-02T18:01:00.000Z",
            retryCount: 1,
            rateLimitRetryCount: 1,
          },
        },
        dispatchProgress: {
          activeWave: 1,
          heartbeatCount: 12,
          totalGroups: 6,
          dispatchedGroups: ["group-g1"],
          completedGroups: 0,
          elapsedSeconds: 120,
          lastWorkflowUpdate: "Wave 1: 1 group(s) dispatched, 0/6 complete, 12 heartbeat(s), 120s elapsed",
          status: "running",
        },
      }, repoRoot)

      const updated = await readRun(run.runId, repoRoot)
      const groupLedger = updated.metadata?.groupLedger as Record<string, Record<string, unknown>>
      assert.ok(groupLedger)
      assert.equal(groupLedger["group-g1"]?.status, "running")
      assert.equal(groupLedger["group-g1"]?.agent, "worker")
      assert.equal(groupLedger["group-g1"]?.lastCommand, "bash yarn jest --runInBand")
      assert.equal(groupLedger["group-g1"]?.currentTool, "bash")
      assert.equal(groupLedger["group-g1"]?.rateLimitRetryCount, 1)
      assert.equal(groupLedger["group-g1"]?.retryCount, 1)
      assert.ok(typeof groupLedger["group-g1"]?.updatedAt === "string")

      const dispatchProgress = updated.metadata?.dispatchProgress as Record<string, unknown>
      assert.equal(dispatchProgress?.activeWave, 1)
      assert.equal(dispatchProgress?.heartbeatCount, 12)
      assert.equal(dispatchProgress?.elapsedSeconds, 120)
      assert.equal(dispatchProgress?.status, "running")
      assert.deepEqual(dispatchProgress?.dispatchedGroups, ["group-g1"])
      assert.ok(typeof dispatchProgress?.updatedAt === "string")
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })
})
