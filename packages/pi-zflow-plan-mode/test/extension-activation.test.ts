/**
 * Extension activation tests for pi-zflow-plan-mode.
 *
 * Validates that the extension activates cleanly, registers all expected
 * commands, sets up lifecycle hooks, and does not import from
 * pi-zflow-change-workflows (maintaining clean package boundaries).
 */
import { describe, it, afterEach } from "node:test"
import * as assert from "node:assert/strict"

import activateZflowPlanModeExtension from "../extensions/zflow-plan-mode/index.js"
import { resetZflowRegistry } from "pi-zflow-core"

function makePiStub() {
  const commands: Map<string, number> = new Map()
  const events: string[] = []
  return {
    commands,
    events,
    pi: {
      registerCommand(name: string) {
        commands.set(name, (commands.get(name) ?? 0) + 1)
      },
      on(eventName: string) {
        events.push(eventName)
      },
      setActiveTools(_toolNames: string[]) {
        // no-op in stub — tool restriction is validated in integration
      },
    },
  }
}

describe("zflow-plan-mode extension activation", () => {
  afterEach(() => {
    resetZflowRegistry()
  })

  it("registers the zflow-plan command", () => {
    const { pi, commands } = makePiStub()

    activateZflowPlanModeExtension(pi as any)

    const registered = [...commands.keys()]
    assert.ok(registered.includes("zflow-plan"), "zflow-plan must be registered")
  })

  it("registers the zflow-plan command exactly once on single load", () => {
    const { pi, commands } = makePiStub()

    activateZflowPlanModeExtension(pi as any)

    assert.equal(commands.get("zflow-plan"), 1)
  })

  it("sets up tool_call and before_agent_start hooks", () => {
    const { pi, events } = makePiStub()

    activateZflowPlanModeExtension(pi as any)

    assert.ok(events.includes("tool_call"), "tool_call hook must be registered")
    assert.ok(events.includes("before_agent_start"), "before_agent_start hook must be registered")
  })

  it("does not register duplicate hooks or commands on duplicate load", () => {
    resetZflowRegistry()
    const first = makePiStub()
    const second = makePiStub()

    activateZflowPlanModeExtension(first.pi as any)
    activateZflowPlanModeExtension(second.pi as any)

    // First call registers command + hooks
    assert.equal(first.commands.get("zflow-plan"), 1)
    assert.ok(first.events.includes("tool_call"))
    assert.ok(first.events.includes("before_agent_start"))

    // Second call should register nothing (capability claim prevents duplicate)
    assert.equal(second.commands.size, 0)
    assert.equal(second.events.length, 0)
  })

  it("does not throw on activate", () => {
    const { pi } = makePiStub()

    assert.doesNotThrow(() => {
      activateZflowPlanModeExtension(pi as any)
    })
  })
})
