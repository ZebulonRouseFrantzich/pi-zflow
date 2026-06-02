import * as assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { DispatchService } from "pi-zflow-core/dispatch-service"

import {
  dispatchParallelWithRateLimitRetries,
  extractRateLimitRetryDelayMs,
  extractRateLimitWaitText,
  formatRetryDelay,
  isRateLimitDispatchError,
  parseRetryDelayMs,
} from "../extensions/zflow-change-workflows/orchestration/implementation/rate-limit.js"

describe("implementation rate-limit helpers", () => {
  test("detects 429/rate-limit failures", () => {
    assert.equal(isRateLimitDispatchError("429 rate limit exceeded"), true)
    assert.equal(isRateLimitDispatchError("Your requests have exceeded rate limit."), true)
    assert.equal(isRateLimitDispatchError("usage limit reached"), true)
    assert.equal(isRateLimitDispatchError("Unknown agent"), false)
  })

  test("extracts and parses provider wait times", () => {
    assert.equal(extractRateLimitWaitText("429 usage limit reached. Wait time: 45 minutes. Provider message: boom"), "45 minutes")
    assert.equal(extractRateLimitWaitText("429 Monthly usage limit reached. Resets in 13 days."), "13 days")
    assert.equal(parseRetryDelayMs("45 minutes"), 45 * 60 * 1000)
    assert.equal(parseRetryDelayMs("2 hours 30 minutes"), (2 * 60 * 60 + 30 * 60) * 1000)
    assert.equal(parseRetryDelayMs("01:30"), 90 * 1000)
    assert.equal(extractRateLimitRetryDelayMs("429 usage limit reached. Wait time: 45 minutes."), 45 * 60 * 1000)
    assert.equal(formatRetryDelay(125000), "2m 5s")
  })

  test("retries rate-limited groups after waiting the provider-specified delay", async () => {
    const sleeps: number[] = []
    const notices: string[] = []
    let attempts = 0

    const dispatchService: DispatchService = {
      name: "test-dispatch",
      runAgent: async () => ({ ok: true, rawOutput: "" }),
      runParallel: async (input) => {
        attempts++
        if (attempts === 1) {
          input.tasks[0]?.onUpdate?.({
            agent: input.tasks[0]!.agent,
            status: "running",
            currentTool: "bash",
            currentToolArgs: "yarn jest --runInBand",
            durationMs: 1000,
          })
          return {
            ok: false,
            results: [{
              agent: input.tasks[0]!.agent,
              groupId: input.tasks[0]!.groupId,
              ok: false,
              rawOutput: "",
              error: "429 Rate limit exceeded. Retry after 2 seconds.",
            }],
          }
        }

        return {
          ok: true,
          results: [{
            agent: input.tasks[0]!.agent,
            groupId: input.tasks[0]!.groupId,
            ok: true,
            rawOutput: "done",
            changedFiles: ["src/example.ts"],
            verification: { status: "skipped" },
          }],
        }
      },
    }

    const result = await dispatchParallelWithRateLimitRetries({
      dispatchService,
      maxRetries: 3,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      onRateLimitNotice: async (notice) => {
        notices.push(notice.message)
      },
      input: {
        tasks: [{
          agent: "worker",
          groupId: "group-g1",
          task: "Implement the group",
        }],
        worktree: true,
      },
    })

    assert.equal(result.ok, true)
    assert.equal(attempts, 2)
    assert.deepEqual(sleeps, [2000])
    assert.equal(result.retryCounts["group-g1"], 1)
    assert.match(notices[0] ?? "", /group-g1 hit a provider rate limit/i)
    assert.match(notices[0] ?? "", /2s/)
  })

  test("resets the visible retry burst count after progress resumes", async () => {
    const notices: Array<{ attempt: number; message: string }> = []
    let attempts = 0
    const dispatchService: DispatchService = {
      name: "test-dispatch",
      runAgent: async () => ({ ok: true, rawOutput: "" }),
      runParallel: async (input) => {
        attempts++
        const task = input.tasks[0]!
        if (attempts === 1) {
          return {
            ok: false,
            results: [{
              agent: task.agent,
              groupId: task.groupId,
              ok: false,
              rawOutput: "",
              error: "429 Rate limit exceeded. Retry after 1 second.",
            }],
          }
        }
        if (attempts === 2) {
          task.onUpdate?.({
            agent: task.agent,
            status: "running",
            currentTool: "read",
            currentToolArgs: "src/example.ts",
            durationMs: 500,
          })
          return {
            ok: false,
            results: [{
              agent: task.agent,
              groupId: task.groupId,
              ok: false,
              rawOutput: "",
              error: "429 Rate limit exceeded. Retry after 1 second.",
            }],
          }
        }
        return {
          ok: true,
          results: [{
            agent: task.agent,
            groupId: task.groupId,
            ok: true,
            rawOutput: "done",
            verification: { status: "skipped" },
          }],
        }
      },
    }

    const result = await dispatchParallelWithRateLimitRetries({
      dispatchService,
      maxRetries: 3,
      sleep: async () => {},
      onRateLimitNotice: async (notice) => {
        notices.push({ attempt: notice.attempt, message: notice.message })
      },
      input: {
        tasks: [{
          agent: "worker",
          groupId: "group-g1",
          task: "Implement the group",
        }],
        worktree: true,
      },
    })

    assert.equal(result.ok, true)
    assert.deepEqual(notices.map((notice) => notice.attempt), [1, 1])
    assert.equal(result.retryCounts["group-g1"], 1)
  })

  test("serializes retry waves after a multi-group 429 burst", async () => {
    const sleeps: number[] = []
    const dispatchBatches: string[][] = []
    let attempts = 0

    const dispatchService: DispatchService = {
      name: "test-dispatch",
      runAgent: async () => ({ ok: true, rawOutput: "" }),
      runParallel: async (input) => {
        attempts++
        dispatchBatches.push(input.tasks.map((task) => task.groupId ?? "unknown"))
        if (attempts === 1) {
          return {
            ok: false,
            results: input.tasks.map((task, index) => ({
              agent: task.agent,
              groupId: task.groupId,
              ok: false,
              rawOutput: "",
              error: `429 Rate limit exceeded. Retry after ${index + 1} second.`,
            })),
          }
        }

        return {
          ok: true,
          results: [{
            agent: input.tasks[0]!.agent,
            groupId: input.tasks[0]!.groupId,
            ok: true,
            rawOutput: "done",
            verification: { status: "skipped" },
          }],
        }
      },
    }

    const result = await dispatchParallelWithRateLimitRetries({
      dispatchService,
      maxRetries: 3,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      input: {
        tasks: [
          { agent: "worker", groupId: "group-a", task: "A" },
          { agent: "worker", groupId: "group-b", task: "B" },
          { agent: "worker", groupId: "group-c", task: "C" },
        ],
        worktree: true,
        concurrency: 3,
      },
    })

    assert.equal(result.ok, true)
    assert.deepEqual(dispatchBatches, [
      ["group-a", "group-b", "group-c"],
      ["group-a"],
      ["group-b"],
      ["group-c"],
    ])
    assert.deepEqual(sleeps, [1000, 2000, 3000])
  })

  test("surfaces retry exhaustion when the group keeps hitting 429", async () => {
    let attempts = 0
    const dispatchService: DispatchService = {
      name: "test-dispatch",
      runAgent: async () => ({ ok: true, rawOutput: "" }),
      runParallel: async (input) => {
        attempts++
        return {
          ok: false,
          results: [{
            agent: input.tasks[0]!.agent,
            groupId: input.tasks[0]!.groupId,
            ok: false,
            rawOutput: "",
            error: "429 Rate limit exceeded. Retry after 1 second.",
          }],
        }
      },
    }

    const result = await dispatchParallelWithRateLimitRetries({
      dispatchService,
      maxRetries: 2,
      sleep: async () => {},
      input: {
        tasks: [{
          agent: "worker",
          groupId: "group-g1",
          task: "Implement the group",
        }],
        worktree: true,
      },
    })

    assert.equal(result.ok, false)
    assert.equal(attempts, 3)
    assert.equal(result.retryCounts["group-g1"], 2)
    assert.match(result.results[0]?.error ?? "", /retry budget exhausted after 2 retries/i)
  })
})
