import { describe, test } from "node:test"
import assert from "node:assert/strict"

import type { DispatchService } from "../src/dispatch-service.js"
import {
  extractRateLimitRetryDelayMs,
  extractRateLimitWaitText,
  formatRetryDelay,
  isRateLimitDispatchError,
  parseRetryDelayMs,
  runAgentWithRateLimitRetries,
} from "../src/rate-limit.js"

describe("core rate-limit helpers", () => {
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

  test("retries a single agent after waiting the provider-specified delay", async () => {
    const sleeps: number[] = []
    const notices: string[] = []
    let attempts = 0

    const dispatchService: DispatchService = {
      name: "test-dispatch",
      runParallel: async () => ({ ok: false, results: [] }),
      runAgent: async (input) => {
        attempts++
        if (attempts === 1) {
          input.onUpdate?.({
            agent: input.agent,
            status: "running",
            currentTool: "read",
            currentToolArgs: "src/example.ts",
            durationMs: 250,
          })
          return {
            ok: false,
            rawOutput: "",
            error: "429 Rate limit exceeded. Retry after 2 seconds.",
          }
        }
        return { ok: true, rawOutput: "done" }
      },
    }

    const result = await runAgentWithRateLimitRetries({
      dispatchService,
      input: {
        agent: "zflow.review-system",
        task: "Review the changes",
      },
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      onRateLimitNotice: async (notice) => {
        notices.push(notice.message)
      },
    })

    assert.equal(result.ok, true)
    assert.equal(attempts, 2)
    assert.equal(sleeps.length, 1)
    assert.ok(Math.abs((sleeps[0] ?? 0) - 2000) <= 25)
    assert.equal(result.retryCount, 1)
    assert.equal(result.totalRateLimitRetries, 1)
    assert.match(notices[0] ?? "", /provider rate limit/i)
    assert.match(notices[0] ?? "", /2s/)
  })

  test("resets the visible retry burst count after progress resumes", async () => {
    const notices: Array<{ attempt: number; message: string }> = []
    let attempts = 0
    const dispatchService: DispatchService = {
      name: "test-dispatch",
      runParallel: async () => ({ ok: false, results: [] }),
      runAgent: async (input) => {
        attempts++
        if (attempts === 1) {
          return {
            ok: false,
            rawOutput: "",
            error: "429 Rate limit exceeded. Retry after 1 second.",
          }
        }
        if (attempts === 2) {
          input.onUpdate?.({
            agent: input.agent,
            status: "running",
            currentTool: "read",
            currentToolArgs: "src/example.ts",
            durationMs: 500,
          })
          return {
            ok: false,
            rawOutput: "",
            error: "429 Rate limit exceeded. Retry after 1 second.",
          }
        }
        return { ok: true, rawOutput: "done" }
      },
    }

    const result = await runAgentWithRateLimitRetries({
      dispatchService,
      input: {
        agent: "zflow.review-security",
        task: "Review the changes",
      },
      sleep: async () => {},
      onRateLimitNotice: async (notice) => {
        notices.push({ attempt: notice.attempt, message: notice.message })
      },
    })

    assert.equal(result.ok, true)
    assert.deepEqual(notices.map((notice) => notice.attempt), [1, 1])
    assert.equal(result.retryCount, 1)
    assert.equal(result.totalRateLimitRetries, 2)
  })

  test("surfaces retry exhaustion when the agent keeps hitting 429", async () => {
    let attempts = 0
    const dispatchService: DispatchService = {
      name: "test-dispatch",
      runParallel: async () => ({ ok: false, results: [] }),
      runAgent: async () => {
        attempts++
        return {
          ok: false,
          rawOutput: "",
          error: "429 Rate limit exceeded. Retry after 1 second.",
        }
      },
    }

    const result = await runAgentWithRateLimitRetries({
      dispatchService,
      maxRetries: 2,
      sleep: async () => {},
      input: {
        agent: "zflow.synthesizer",
        task: "Synthesize findings",
      },
    })

    assert.equal(result.ok, false)
    assert.equal(attempts, 3)
    assert.equal(result.retryCount, 2)
    assert.equal(result.totalRateLimitRetries, 2)
    assert.match(result.error ?? "", /retry budget exhausted after 2 retries/i)
  })
})
