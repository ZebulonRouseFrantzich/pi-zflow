import { describe, it } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import {
  appendCacheTraceEntry,
  readCacheSummary,
  readSessionCacheTrace,
  resolveCacheSummaryPath,
  resolveSessionCacheTracePath,
} from "../src/index.js"
import type { ZflowCacheTraceEntry } from "pi-zflow-core"

async function makeRepo(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "pi-zflow-cache-trace-"))
}

function makeEntry(overrides?: Partial<ZflowCacheTraceEntry>): ZflowCacheTraceEntry {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    timestamp: new Date().toISOString(),
    cwdHash: "cwd-hash",
    workflowMode: "change-prepare",
    agentName: "zflow.planner-frontier",
    profileName: "default",
    provider: "openai",
    model: "gpt-test",
    stablePromptHash: "stable-hash-1",
    reminderHash: "reminder-hash-1",
    contextUsagePercent: 42,
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 300,
    cacheWriteTokens: 100,
    cacheHitRate: 0.3,
    compactionOccurredRecently: false,
    promptFingerprintChanged: false,
    modelChanged: false,
    modeChanged: false,
    toolBurstHint: false,
    regressionCause: null,
    ...overrides,
  }
}

describe("cache trace helpers", () => {
  it("appends session trace entries and writes a summary", async () => {
    const repo = await makeRepo()
    await fs.mkdir(path.join(repo, ".git"))

    await appendCacheTraceEntry(makeEntry(), { cwd: repo })
    await appendCacheTraceEntry(makeEntry({ turnId: "turn-2", cacheHitRate: 0.6, cacheReadTokens: 600 }), { cwd: repo })

    const trace = await readSessionCacheTrace(repo)
    const summary = await readCacheSummary(repo)

    assert.equal(trace.length, 2)
    assert.ok(summary)
    assert.equal(summary?.totalTurns, 2)
    assert.equal(summary?.cacheReadTokens, 900)
    assert.equal(summary?.cacheWriteTokens, 200)
    assert.equal(summary?.health, "healthy")
    assert.equal(summary?.hitRateSamples, 2)

    const tracePath = resolveSessionCacheTracePath(repo)
    const summaryPath = resolveCacheSummaryPath(repo)
    assert.ok((await fs.stat(tracePath)).isFile())
    assert.ok((await fs.stat(summaryPath)).isFile())
  })
})
