/**
 * Extension activation tests for pi-zflow-compaction.
 *
 * Validates that the extension activates cleanly, registers all expected
 * hooks, and the proactive compaction trigger fires correctly under
 * various context-usage conditions.
 */
import { describe, it, afterEach, mock } from "node:test"
import * as assert from "node:assert/strict"

import activateZflowCompactionExtension from "../extensions/zflow-compaction/index.js"
import { resetZflowRegistry } from "pi-zflow-core"

type PiEvent = string
type EventHandler = (...args: any[]) => any

/**
 * Create a minimal Pi API stub that records registered hooks and
 * provides a controllable ExtensionContext for turn_end testing.
 */
function makePiStub() {
  const eventHandlers: Map<PiEvent, EventHandler[]> = new Map()

  const compactFn = mock.fn()

  return {
    /** Map of event name -> registered handlers. */
    eventHandlers,
    /** Mock function that tracks calls to ctx.compact(). */
    compactFn,

    pi: {
      on(event: string, handler: EventHandler) {
        const handlers = eventHandlers.get(event) ?? []
        handlers.push(handler)
        eventHandlers.set(event, handlers)
      },
    },

    /** Create a context mock that exposes predictable usage data. */
    makeCtx(overrides?: {
      percent?: number | null
      tokens?: number | null
      contextWindow?: number
    }) {
      const pct = overrides?.percent ?? null
      const toks = overrides?.tokens ?? null
      const cw = overrides?.contextWindow ?? 100_000

      return {
        getContextUsage: () => ({
          tokens: toks,
          contextWindow: cw,
          percent: pct,
        }),
        compact: compactFn,
        modelRegistry: {
          find: () => undefined,
          getApiKeyAndHeaders: () => ({ ok: true, apiKey: "fake-key" }),
        },
        ui: { notify: () => {} },
      }
    },

    /** Reset mock state between tests. */
    reset() {
      eventHandlers.clear()
      compactFn.mock.resetCalls()
    },
  }
}

describe("zflow-compaction extension activation", () => {
  afterEach(() => {
    resetZflowRegistry()
  })

  it("registers the expected lifecycle hooks on single load", () => {
    const stub = makePiStub()

    activateZflowCompactionExtension(stub.pi as any)

    const registered = [...stub.eventHandlers.keys()]
    assert.ok(registered.includes("turn_end"), "turn_end hook must be registered")
    assert.ok(registered.includes("session_before_compact"), "session_before_compact hook must be registered")
    assert.ok(registered.includes("session_compact"), "session_compact hook must be registered")
    assert.ok(registered.includes("before_agent_start"), "before_agent_start hook must be registered")
  })

  it("does not register duplicate hooks on duplicate load", () => {
    resetZflowRegistry()
    const first = makePiStub()
    const second = makePiStub()

    activateZflowCompactionExtension(first.pi as any)
    activateZflowCompactionExtension(second.pi as any)

    // First activation registers hooks
    assert.equal(first.eventHandlers.get("turn_end")?.length, 1)
    assert.equal(first.eventHandlers.get("session_before_compact")?.length, 1)
    assert.equal(first.eventHandlers.get("session_compact")?.length, 1)
    assert.equal(first.eventHandlers.get("before_agent_start")?.length, 1)

    // Second activation should register nothing (capability claim prevents duplicate)
    assert.equal(second.eventHandlers.size, 0)
  })

  it("does not throw on activate", () => {
    const stub = makePiStub()

    assert.doesNotThrow(() => {
      activateZflowCompactionExtension(stub.pi as any)
    })
  })
})

describe("proactive compaction trigger (turn_end)", () => {
  afterEach(() => {
    resetZflowRegistry()
  })

  it("triggers ctx.compact() when usage percent is >= threshold (0.6)", () => {
    const stub = makePiStub()
    activateZflowCompactionExtension(stub.pi as any)

    const handler = stub.eventHandlers.get("turn_end")!
    assert.ok(handler, "turn_end handler must exist")

    // Usage at 65 % — above 60 % threshold
    const ctx = stub.makeCtx({ percent: 65, tokens: 65_000, contextWindow: 100_000 })
    handler[0]("dummy-event", ctx)

    assert.equal(stub.compactFn.mock.callCount(), 1,
      "ctx.compact() should be called when usage >= 60 %")
  })

  it("does not trigger ctx.compact() when usage is below threshold", () => {
    const stub = makePiStub()
    activateZflowCompactionExtension(stub.pi as any)

    const handler = stub.eventHandlers.get("turn_end")![0]

    // Usage at 40 % — below 60 % threshold
    const ctx = stub.makeCtx({ percent: 40, tokens: 40_000, contextWindow: 100_000 })
    handler("dummy-event", ctx)

    assert.equal(stub.compactFn.mock.callCount(), 0,
      "ctx.compact() should NOT be called when usage < 60 %")
  })

  it("does not trigger ctx.compact() when usage data is null", () => {
    const stub = makePiStub()
    activateZflowCompactionExtension(stub.pi as any)

    const handler = stub.eventHandlers.get("turn_end")![0]

    // No usage data yet
    const ctx = stub.makeCtx({ percent: null, tokens: null, contextWindow: 100_000 })
    handler("dummy-event", ctx)

    assert.equal(stub.compactFn.mock.callCount(), 0,
      "ctx.compact() should NOT be called when usage is null")
  })

  it("does not trigger ctx.compact() when compaction is already in progress", () => {
    const stub = makePiStub()
    activateZflowCompactionExtension(stub.pi as any)

    const handler = stub.eventHandlers.get("turn_end")![0]

    // First call: triggers compact
    const ctx1 = stub.makeCtx({ percent: 70, tokens: 70_000, contextWindow: 100_000 })
    handler("dummy-event", ctx1)
    assert.equal(stub.compactFn.mock.callCount(), 1, "first call should trigger")

    // Second call while still "in progress" (no session_compact fired yet)
    const ctx2 = stub.makeCtx({ percent: 75, tokens: 75_000, contextWindow: 100_000 })
    handler("dummy-event", ctx2)
    assert.equal(stub.compactFn.mock.callCount(), 1,
      "ctx.compact() should NOT be called again while compaction is still in progress")
  })

  it("nud throttle clears after session_compact and new usage delta", () => {
    const stub = makePiStub()
    activateZflowCompactionExtension(stub.pi as any)

    const turnEnd = stub.eventHandlers.get("turn_end")![0]
    const sessionCompact = stub.eventHandlers.get("session_compact")![0]

    // Turn 1: 65 % usage → triggers compact
    const ctx1 = stub.makeCtx({ percent: 65, tokens: 65_000, contextWindow: 100_000 })
    turnEnd("dummy-event", ctx1)
    assert.equal(stub.compactFn.mock.callCount(), 1, "first call should trigger")

    // Simulate session_compact completing (clears the guard)
    sessionCompact()

    // Turn 2: usage at 72 % with delta > 5k → should trigger again
    const ctx2 = stub.makeCtx({ percent: 72, tokens: 72_000, contextWindow: 100_000 })
    turnEnd("dummy-event", ctx2)
    assert.equal(stub.compactFn.mock.callCount(), 2,
      "ctx.compact() should trigger again after session_compact and sufficient token delta")
  })

  it("uses tokens/contextWindow fallback when percent is null", () => {
    const stub = makePiStub()
    activateZflowCompactionExtension(stub.pi as any)

    const handler = stub.eventHandlers.get("turn_end")![0]

    // percent is null, but tokens/contextWindow = 72_000/100_000 = 0.72 >= 0.6
    const ctx = stub.makeCtx({ percent: null, tokens: 72_000, contextWindow: 100_000 })
    handler("dummy-event", ctx)

    assert.equal(stub.compactFn.mock.callCount(), 1,
      "ctx.compact() should be called when tokens/contextWindow >= threshold")
  })

  it("skips turn when no usage data is available at all", () => {
    const stub = makePiStub()
    activateZflowCompactionExtension(stub.pi as any)

    const handler = stub.eventHandlers.get("turn_end")![0]

    // Everything null
    const ctx = stub.makeCtx({ percent: null, tokens: null, contextWindow: 0 })
    handler("dummy-event", ctx)

    assert.equal(stub.compactFn.mock.callCount(), 0,
      "ctx.compact() should NOT be called when no usage data at all")
  })
})
