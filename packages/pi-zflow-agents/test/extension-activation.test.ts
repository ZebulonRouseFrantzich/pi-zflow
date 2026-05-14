/**
 * Extension activation tests for pi-zflow-agents.
 *
 * Validates that the extension activates cleanly, registers all expected
 * commands, tolerates double-loading, and provides the agents service
 * via the capability registry.
 */
import { describe, it, afterEach } from "node:test"
import * as assert from "node:assert/strict"

import activateZflowAgentsExtension from "../extensions/zflow-agents/index.js"
import { resetZflowRegistry, getZflowRegistry } from "pi-zflow-core"

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
      on(_eventName: string) {
        events.push(_eventName)
      },
    },
  }
}

describe("zflow-agents extension activation", () => {
  afterEach(() => {
    resetZflowRegistry()
  })

  it("provides agents service via registry after activation", () => {
    const { pi } = makePiStub()
    const registry = getZflowRegistry()

    activateZflowAgentsExtension(pi as any)

    const service = registry.optional<{
      installAgentsAndChains: Function
      checkInstallStatus: Function
      formatInstallSummary: Function
      readManifest: Function
      writeManifest: Function
      diffManifest: Function
    }>("agents")
    assert.ok(service, "agents service must be available after activation")
    assert.equal(typeof service!.installAgentsAndChains, "function")
    assert.equal(typeof service!.checkInstallStatus, "function")
    assert.equal(typeof service!.formatInstallSummary, "function")
    assert.equal(typeof service!.readManifest, "function")
    assert.equal(typeof service!.writeManifest, "function")
    assert.equal(typeof service!.diffManifest, "function")
  })

  it("registers all expected commands", () => {
    const { pi, commands } = makePiStub()

    activateZflowAgentsExtension(pi as any)

    const registered = [...commands.keys()].sort()
    assert.ok(registered.includes("zflow-setup-agents"), "zflow-setup-agents must be registered")
    assert.ok(registered.includes("zflow-update-agents"), "zflow-update-agents must be registered")
  })

  it("registers each command exactly once on single load", () => {
    const { pi, commands } = makePiStub()

    activateZflowAgentsExtension(pi as any)

    for (const [name, count] of commands) {
      assert.equal(
        count,
        1,
        `Command "${name}" registered ${count} times, expected exactly 1`,
      )
    }
  })

  it("does not register duplicate commands on second load (tolerates double-loading)", () => {
    const first = makePiStub()
    const second = makePiStub()

    activateZflowAgentsExtension(first.pi as any)
    activateZflowAgentsExtension(second.pi as any)

    // First call should register all commands
    const firstCommands = [...first.commands.keys()].sort()
    assert.ok(firstCommands.includes("zflow-setup-agents"))
    assert.ok(firstCommands.includes("zflow-update-agents"))

    // Second call should register nothing (capability service guard prevents duplicate)
    assert.deepEqual([...second.commands.keys()], [])
  })

  it("returns same service instance on duplicate activation", () => {
    const registry = getZflowRegistry()
    const first = makePiStub()
    const second = makePiStub()

    activateZflowAgentsExtension(first.pi as any)
    const service1 = registry.optional("agents")

    activateZflowAgentsExtension(second.pi as any)
    const service2 = registry.optional("agents")

    assert.strictEqual(service1, service2)
  })

  it("does not throw on activate", () => {
    const { pi } = makePiStub()

    assert.doesNotThrow(() => {
      activateZflowAgentsExtension(pi as any)
    })
  })

  it("can be activated twice without errors", () => {
    const { pi } = makePiStub()

    assert.doesNotThrow(() => {
      activateZflowAgentsExtension(pi as any)
      activateZflowAgentsExtension(pi as any)
    })
  })
})
