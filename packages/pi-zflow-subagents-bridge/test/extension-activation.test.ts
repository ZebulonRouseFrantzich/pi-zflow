/**
 * Extension activation tests for pi-zflow-subagents-bridge.
 *
 * Validates that the extension activates cleanly, registers/provides the
 * dispatch service, tolerates double-loading, does not register commands
 * or tools, and provides runAgent/runParallel methods.
 */
import { describe, it, afterEach, mock } from "node:test"
import * as assert from "node:assert/strict"

import activateZflowSubagentsBridgeExtension from "../extensions/zflow-subagents-bridge/index.js"
import { resetZflowRegistry } from "pi-zflow-core"
import {
  DISPATCH_SERVICE_CAPABILITY,
  type DispatchService,
} from "pi-zflow-core/dispatch-service"
import { getZflowRegistry } from "pi-zflow-core/registry"

function makePiStub() {
  const commands: Map<string, number> = new Map()
  const tools: Map<string, number> = new Map()
  const events: string[] = []
  return {
    commands,
    tools,
    events,
    pi: {
      registerCommand(name: string) {
        commands.set(name, (commands.get(name) ?? 0) + 1)
      },
      registerTool(_tool: unknown) {
        tools.set("tool", (tools.get("tool") ?? 0) + 1)
      },
      on(_eventName: string) {
        events.push(_eventName)
      },
    },
  }
}

describe("pi-zflow-subagents-bridge extension activation", () => {
  afterEach(() => {
    resetZflowRegistry()
  })

  it("registers the zflow-dispatch service in the registry", async () => {
    const stub = makePiStub()

    await activateZflowSubagentsBridgeExtension(stub.pi as any)

    const registry = getZflowRegistry()
    assert.ok(registry.has(DISPATCH_SERVICE_CAPABILITY), "zflow-dispatch capability must exist")

    const service = registry.get<DispatchService>(DISPATCH_SERVICE_CAPABILITY)
    assert.ok(service, "dispatch service must be provided")
    assert.ok(
      service.name.startsWith("pi-zflow-subagents-bridge:"),
      `service name should start with bridge prefix, got: ${service.name}`,
    )
    assert.equal(typeof service.runAgent, "function")
    assert.equal(typeof service.runParallel, "function")
  })

  it("does not register commands", async () => {
    const stub = makePiStub()

    await activateZflowSubagentsBridgeExtension(stub.pi as any)

    assert.equal(stub.commands.size, 0, "no commands should be registered")
  })

  it("does not register tools", async () => {
    const stub = makePiStub()

    await activateZflowSubagentsBridgeExtension(stub.pi as any)

    assert.equal(stub.tools.size, 0, "no tools should be registered")
  })

  it("does not register events", async () => {
    const stub = makePiStub()

    await activateZflowSubagentsBridgeExtension(stub.pi as any)

    assert.equal(stub.events.length, 0, "no event handlers should be registered")
  })

  it("duplicate activation is a no-op", async () => {
    const first = makePiStub()
    const second = makePiStub()

    await activateZflowSubagentsBridgeExtension(first.pi as any)
    await activateZflowSubagentsBridgeExtension(second.pi as any)

    const registry = getZflowRegistry()
    assert.ok(registry.has(DISPATCH_SERVICE_CAPABILITY))

    // Second activation should add no commands, tools, or events
    assert.equal(second.commands.size, 0)
    assert.equal(second.tools.size, 0)
    assert.equal(second.events.length, 0)
  })

  it("does not throw on activate", async () => {
    const stub = makePiStub()

    await assert.doesNotReject(async () => {
      await activateZflowSubagentsBridgeExtension(stub.pi as any)
    })
  })

  it("can be activated twice without errors", async () => {
    const stub = makePiStub()

    await assert.doesNotReject(async () => {
      await activateZflowSubagentsBridgeExtension(stub.pi as any)
      await activateZflowSubagentsBridgeExtension(stub.pi as any)
    })
  })
})

describe("pi-zflow-subagents-bridge dispatch service behavior", () => {
  /**
   * Since the pi-subagents-zflow fork is available as a file: dependency,
   * the bridge should provide an operational backend.  Tests validate
   * the full call path without requiring real agent files on disk.
   */
  async function getService(): Promise<DispatchService> {
    const stub = makePiStub()
    await activateZflowSubagentsBridgeExtension(stub.pi as any)
    const registry = getZflowRegistry()
    return registry.get<DispatchService>(DISPATCH_SERVICE_CAPABILITY)!
  }

  afterEach(() => {
    resetZflowRegistry()
  })

  it("runAgent returns ok: false with error when agent not found", async () => {
    const service = await getService()

    const result = await service.runAgent({
      agent: "nonexistent-agent-xyz",
      task: "Do something",
    })

    assert.equal(result.ok, false)
    assert.ok(result.error, "should have an error message")
    assert.ok(
      result.error!.includes("nonexistent-agent-xyz"),
      `error should mention the agent name, got: ${result.error}`,
    )
  })

  it("runParallel returns ok: false with one error per task", async () => {
    const service = await getService()

    const result = await service.runParallel({
      tasks: [
        { agent: "nonexistent-agent-xyz", task: "Task 1" },
        { agent: "another-nonexistent", task: "Task 2" },
      ],
    })

    assert.equal(result.ok, false)
    assert.equal(result.results.length, 2)
    for (const r of result.results) {
      assert.equal(r.ok, false)
      assert.ok(r.error, `error for "${r.agent}" should exist`)
    }
  })

  it("runParallel with empty tasks returns ok: false with empty results", async () => {
    const service = await getService()

    const result = await service.runParallel({
      tasks: [],
    })

    assert.equal(result.ok, false)
    assert.equal(result.results.length, 0)
  })
})
