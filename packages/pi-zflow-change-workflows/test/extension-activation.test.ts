/**
 * Extension activation tests for pi-zflow-change-workflows.
 *
 * Validates that the extension activates cleanly, registers all expected
 * commands, tolerates double-loading, and does not cause duplicate
 * command registration errors.
 */
import { describe, it, afterEach } from "node:test"
import * as assert from "node:assert/strict"

import activateZflowChangeWorkflowsExtension, {
  parseChangePlanArgs,
  parseChangePrepareArgs,
  shouldForkImplementationSessionAfterPrepare,
} from "../extensions/zflow-change-workflows/index.js"
import { resetZflowRegistry } from "pi-zflow-core"
import { getZflowRegistry } from "pi-zflow-core/registry"

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

describe("zflow-change-workflows extension activation", () => {
  afterEach(() => {
    resetZflowRegistry()
  })

  it("registers all expected workflow commands", () => {
    const { pi, commands } = makePiStub()

    activateZflowChangeWorkflowsExtension(pi as any)

    const registered = [...commands.keys()].sort()

    assert.ok(registered.includes("zflow-clean"), "zflow-clean must be registered")
    assert.ok(registered.includes("zflow-change-plan"), "zflow-change-plan must be registered")
    assert.ok(registered.includes("zflow-change-prepare"), "zflow-change-prepare must be registered")
    assert.ok(registered.includes("zflow-change-implement"), "zflow-change-implement must be registered")
    assert.ok(registered.includes("zflow-change-audit"), "zflow-change-audit must be registered")
    assert.ok(registered.includes("zflow-change-fix"), "zflow-change-fix must be registered")
    assert.ok(registered.includes("zflow-resolve-apply-back"), "zflow-resolve-apply-back must be registered")
  })

  it("registers each command exactly once on single load", () => {
    const { pi, commands } = makePiStub()

    activateZflowChangeWorkflowsExtension(pi as any)

    for (const [name, count] of commands) {
      assert.equal(
        count,
        1,
        `Command "${name}" registered ${count} times, expected exactly 1`,
      )
    }
  })

  it("does not register duplicate commands on second load (tolerates double-loading)", () => {
    resetZflowRegistry()
    const first = makePiStub()
    const second = makePiStub()

    activateZflowChangeWorkflowsExtension(first.pi as any)
    activateZflowChangeWorkflowsExtension(second.pi as any)

    // First call should register all commands
    const firstCommands = [...first.commands.keys()].sort()
    assert.ok(firstCommands.includes("zflow-clean"))
    assert.ok(firstCommands.includes("zflow-change-plan"))
    assert.ok(firstCommands.includes("zflow-change-prepare"))
    assert.ok(firstCommands.includes("zflow-change-implement"))
    assert.ok(firstCommands.includes("zflow-resolve-apply-back"))

    // Second call should register nothing (capability claim prevents duplicate)
    assert.deepEqual([...second.commands.keys()], [])
  })

  it("does not throw on activate", () => {
    const { pi } = makePiStub()

    assert.doesNotThrow(() => {
      activateZflowChangeWorkflowsExtension(pi as any)
    })
  })

  it("can be activated twice without errors", () => {
    const { pi } = makePiStub()

    assert.doesNotThrow(() => {
      activateZflowChangeWorkflowsExtension(pi as any)
      activateZflowChangeWorkflowsExtension(pi as any)
    })
  })

  it("never forks implementation sessions from prepare — always manual", () => {
    // shouldForkImplementationSessionAfterPrepare now always returns false
    // because /zflow-change-prepare should never start implementation automatically.
    assert.equal(shouldForkImplementationSessionAfterPrepare(), false)
  })

  it("parses change-plan args into path and notes", () => {
    const parsed = parseChangePlanArgs("oracle-mssql-entitlements-readonly initial read-only Oracle draft")

    assert.equal(parsed.changePath, "oracle-mssql-entitlements-readonly")
    assert.equal(parsed.notes, "initial read-only Oracle draft")
  })

  it("parses change-prepare notes and --no-runecontext opt-out", () => {
    const parsed = parseChangePrepareArgs(
      "@docs/change-ideas/cloudflare-target-architecture-combined-spec.md " +
        "This document is not a RuneContext folder or file. Please treat it as a normal idea file",
    )

    assert.equal(parsed.changePath, "docs/change-ideas/cloudflare-target-architecture-combined-spec.md")
    assert.equal(parsed.forceAdHoc, true)
    assert.match(parsed.notes, /normal idea file/)
  })

  it("keeps explicit RuneContext-style paths when no opt-out is present", () => {
    const parsed = parseChangePrepareArgs("@agent-os/specs/change-123")

    assert.equal(parsed.changePath, "@agent-os/specs/change-123")
    assert.equal(parsed.forceAdHoc, false)
  })
})
