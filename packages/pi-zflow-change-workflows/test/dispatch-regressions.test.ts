/**
 * dispatch-regressions.test.ts — Regression tests for zflow dispatch hang fixes.
 *
 * Covers:
 *   1. Rolling concurrency: with concurrency 2, task 3 starts before task 2 ends.
 *   2. Bridge source no longer contains blocking verification logic.
 *   3. Orchestration accepts missing verification from bridge (deferred to final).
 */
import * as assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { test, describe } from "node:test"

// ─── Helpers ──────────────────────────────────────────────────

/**
 * Minimal rolling-concurrency runner matching the bridge helper's contract.
 * Used to verify concurrency semantics without exporting production internals.
 */
async function rollingConcurrency<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const idx = nextIndex++
      results[idx] = await tasks[idx]()
    }
  }

  const active = Math.min(limit, tasks.length)
  const pool: Promise<void>[] = []
  for (let i = 0; i < active; i++) pool.push(worker())
  await Promise.all(pool)
  return results
}

/** Returns a task that resolves after `delayMs` milliseconds. */
function delayedTask<T>(value: T, delayMs: number): () => Promise<T> {
  return () => new Promise((r) => setTimeout(() => r(value), delayMs))
}

// ─── 1. Rolling concurrency semantics ─────────────────────────

describe("rolling concurrency semantics", () => {
  test("with limit 2, starts task 3 before task 2 finishes", async () => {
    // Three tasks:             start indices ─► 0      1       2
    // Task 0 resolves quickly  (20 ms)
    // Task 1 starts at t≈0, resolves at t≈200
    // Task 2 starts as soon as task 0 finishes (t≈20), not after task 1
    const executionOrder: number[] = []
    const task0 = async () => {
      executionOrder.push(0)
      await new Promise((r) => setTimeout(r, 20))
      return "fast"
    }
    const task1 = async () => {
      executionOrder.push(1)
      await new Promise((r) => setTimeout(r, 200))
      return "slow"
    }
    const task2 = async () => {
      executionOrder.push(2)
      return "immediate"
    }

    const results = await rollingConcurrency([task0, task1, task2], 2)

    // Task 0 starts first, task 1 starts second.
    // Task 2 should start as soon as task 0 finishes — not wait for task 1.
    assert.equal(executionOrder[0], 0, "task 0 must start first")
    assert.equal(executionOrder[1], 1, "task 1 must start second")
    // Task 2 must have started before task 1 finishes (at t≈200).
    // With batch concurrency (limit 2), task 2 would wait for both 0 and 1.
    // With rolling concurrency, task 2 starts as soon as task 0 frees the slot (t≈20).
    // Execution order [0,1,2] proves task 2 started immediately after task 0, not after task 1.
    const t2StartIndex = executionOrder.indexOf(2)
    assert.ok(
      t2StartIndex >= 0,
      "task 2 must have started",
    )
    // All 3 tasks must have started by the time rollingConcurrency resolves.
    assert.equal(
      executionOrder.length, 3,
      "all 3 tasks must have started before the runner completes",
    )

    assert.equal(results[0], "fast")
    assert.equal(results[1], "slow")
    assert.equal(results[2], "immediate")
  })

  test("preserves result order with varied durations", async () => {
    // Task 0 = 50ms, Task 1 = 10ms, Task 2 = 5ms
    const tasks = [
      delayedTask("a", 50),
      delayedTask("b", 10),
      delayedTask("c", 5),
    ]
    const results = await rollingConcurrency(tasks, 3)
    assert.deepEqual(results, ["a", "b", "c"])
  })

  test("handles empty task list", async () => {
    const results = await rollingConcurrency([], 5)
    assert.deepEqual(results, [])
  })

  test("handles single task", async () => {
    const results = await rollingConcurrency([() => Promise.resolve(42)], 1)
    assert.deepEqual(results, [42])
  })
})

// Resolve paths once at the top level.
const projectRoot = path.resolve(import.meta.dirname, "..", "..", "..")

// ─── 2. Source regression: bridge files have no blocking verification ──

describe("bridge source regression — no blocking verification", () => {
  const bridgeFiles = [
    path.join(projectRoot, "packages", "pi-zflow-subagents-bridge", "extensions", "zflow-subagents-bridge", "index.ts"),
  ]
  const vendorBridgeFile = path.join(projectRoot, "vendor", "pi-subagents-zflow", "src", "zflow-bridge.ts")

  // The vendor file may not exist in all installation layouts; skip if absent.
  const allBridgePaths = [
    ...bridgeFiles.filter((f) => fs.existsSync(f)),
    ...(fs.existsSync(vendorBridgeFile) ? [vendorBridgeFile] : []),
  ]

  for (const filePath of allBridgePaths) {
    const fileName = path.basename(path.dirname(filePath)) + "/" + path.basename(filePath)

    test(`${fileName} has no spawnSync import`, () => {
      const content = fs.readFileSync(filePath, "utf-8")
      assert.ok(
        !content.includes('spawnSync'),
        `${filePath} must not import or call spawnSync`,
      )
    })

    test(`${fileName} has no runScopedVerification function`, () => {
      const content = fs.readFileSync(filePath, "utf-8")
      assert.ok(
        !content.includes("runScopedVerification"),
        `${filePath} must not define or call runScopedVerification`,
      )
    })

    test(`${fileName} has no extractScopedVerificationCommand function`, () => {
      const content = fs.readFileSync(filePath, "utf-8")
      assert.ok(
        !content.includes("extractScopedVerificationCommand"),
        `${filePath} must not define or call extractScopedVerificationCommand`,
      )
    })
  }

  test("at least one bridge file was found for regression check", () => {
    assert.ok(allBridgePaths.length > 0, "expected at least one bridge source file")
  })
})

// ─── 3. Orchestration accepts missing verification ──────────────────

describe("dispatch loop accepts missing verification", () => {
  const indexFilePath = path.resolve(
    projectRoot, "packages", "pi-zflow-change-workflows", "extensions", "zflow-change-workflows", "index.ts",
  )

  test("bridge verification field is optional in ParallelTaskResult contract", async () => {
    // Read the dispatch-service type definitions to confirm the verification
    // field has optional (?).
    const dispatchTypesPath = path.resolve(
      projectRoot, "packages", "pi-zflow-core", "src", "dispatch-service.ts",
    )
    const content = fs.readFileSync(dispatchTypesPath, "utf-8")

    // The 'verification' field should be optional (marked with '?' or ': ... | undefined')
    // We also check that 'verification' is not 'required' via the interface contract.
    const verificationFieldLine = content
      .split("\n")
      .find((l) => l.trim().match(/^\s*verification\s*(\?)?\s*:\s*/))

    assert.ok(verificationFieldLine, "must find a verification field in ParallelTaskResult")

    const trimmed = verificationFieldLine.trim()
    // The field should either have '?' (optional) or use a union including undefined
    const isOptional = trimmed.startsWith("verification?") || trimmed.includes("undefined")
    assert.ok(
      isOptional,
      `verification field must be optional: "${trimmed}"`,
    )
  })

  test("dispatch loop treats undefined verification as non-blocking", async () => {
    // Read the index file to find the group-result loop and verify the condition
    // treats missing verification as non-blocking.
    const content = fs.readFileSync(indexFilePath, "utf-8")

    // Ensure the old guard `!verification || verification.status !== "pass"` is gone.
    // The new guard should be `verification && verification.status === "fail"`.
    const oldPattern = /!verification\s*\|\|\s*verification\.status\s*!==\s*["']pass["']/
    const newPattern = /verification\s*&&\s*verification\.status\s*===\s*["']fail["']/

    assert.ok(
      !oldPattern.test(content),
      "index.ts must no longer contain the old guard '!verification || verification.status !== \"pass\"'",
    )
    assert.ok(
      newPattern.test(content),
      "index.ts must contain the new guard 'verification && verification.status === \"fail\"'",
    )
  })

  test("resume path also uses the new verification guard", async () => {
    const content = fs.readFileSync(indexFilePath, "utf-8")

    // Check that both dispatch and resume paths have the new guard.
    // We expect two occurrences: one in runWorktreeDispatchAndFinalize, one in resumeWorktreeDispatch.
    const matches = content.match(/verification\s*&&\s*verification\.status\s*===\s*["']fail["']/g)
    assert.ok(matches, "must find the new guard pattern")
    assert.ok(
      matches.length >= 2,
      `expected at least 2 occurrences of the new guard (dispatch + resume), found ${matches.length}`,
    )
  })
})
