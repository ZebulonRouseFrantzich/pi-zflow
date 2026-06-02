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
import {
  extractExecutableScopedVerificationCommands,
  extractUsageLimitWaitTime,
  isUsageLimitError,
  normalizeScopedVerificationLineForCwd,
  resolveMeaningfulSingleError,
} from "../extensions/zflow-subagents-bridge/index.js"
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
    assert.ok(service.capabilities, "dispatch capabilities should be exposed")
    assert.equal(typeof service.capabilities?.isolatedWorktrees, "boolean")
    assert.equal(typeof service.capabilities?.sharedWorkspaceSerialized, "boolean")
    assert.equal(typeof service.capabilities?.baseRefWorktrees, "boolean")
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

  it("fails fast for unsupported shared-concurrent worktree requests", async () => {
    const service = await getService()

    const result = await service.runParallel({
      worktree: true,
      tasks: [{
        groupId: "group-1",
        agent: "nonexistent-agent-xyz",
        task: "Task 1",
        worktreeStrategy: {
          mode: "shared-staging",
          workspaceId: "shared-auth",
          workspaceConcurrency: "concurrent",
        },
      }],
    })

    assert.equal(result.ok, false)
    assert.equal(result.results.length, 1)
    assert.match(result.results[0]?.error ?? "", /shared concurrent worktree clusters/)
  })
})

describe("pi-zflow-subagents-bridge scoped verification helpers", () => {
  it("strips redundant nested-repo cd prefixes", () => {
    assert.equal(
      normalizeScopedVerificationLineForCwd(
        "cd customer-accessible-apis && yarn tsc-all",
        "/tmp/pi-worktree-123/customer-accessible-apis",
      ),
      "yarn tsc-all",
    )
  })

  it("strips repo-prefix cd commands when compat worktrees use synthetic temp directories", () => {
    assert.equal(
      normalizeScopedVerificationLineForCwd(
        "cd opscompass-api-client && npm test -- --runInBand license-manager-oracle-entitlements",
        "/tmp/pi-worktree-e84d7553-0",
        [
          "opscompass-api-client/api/license-manager/license-manager.ts",
          "opscompass-api-client/api/license-manager/oracle-entitlements.ts",
        ],
      ),
      "npm test -- --runInBand license-manager-oracle-entitlements",
    )
  })

  it("keeps only executable scoped verification lines", () => {
    assert.deepEqual(
      extractExecutableScopedVerificationCommands(
        [
          "cd customer-accessible-apis && yarn tsc-all",
          "manual payload review to confirm field parity",
          "Oracle endpoints compile and remain read-only.",
          "npm test -- --runInBand api/license-manager",
        ].join("\n"),
        "/tmp/pi-worktree-123/customer-accessible-apis",
      ),
      [
        "yarn tsc-all",
        "npm test -- --runInBand api/license-manager",
      ],
    )
  })

  it("normalizes temp-root compat verification commands using claimed file prefixes", () => {
    assert.deepEqual(
      extractExecutableScopedVerificationCommands(
        [
          "cd opscompass-api-client && npm test -- --runInBand license-manager-oracle-entitlements",
          "manual audit to confirm existing MSSQL names remain unchanged",
          "cd opscompass-api-client && npm test -- --runInBand license-manager-mssql-parity",
        ].join("\n"),
        "/tmp/pi-worktree-e84d7553-0",
        [
          "opscompass-api-client/api/license-manager/license-manager.ts",
          "opscompass-api-client/tests/api/license-manager-oracle-entitlements.test.ts",
        ],
      ),
      [
        "npm test -- --runInBand license-manager-oracle-entitlements",
        "npm test -- --runInBand license-manager-mssql-parity",
      ],
    )
  })
})

describe("pi-zflow-subagents-bridge usage-limit diagnostics", () => {
  it("detects provider 429 usage-limit errors", () => {
    assert.equal(
      isUsageLimitError("429 Monthly usage limit reached. Resets in 13 days."),
      true,
    )
    assert.equal(
      isUsageLimitError("Rate limit exceeded for this account."),
      true,
    )
    assert.equal(
      isUsageLimitError("Model \"placeholder:high\" not found."),
      false,
    )
  })

  it("extracts wait time when provider includes it", () => {
    assert.equal(
      extractUsageLimitWaitTime("429 Monthly usage limit reached. Resets in 13 days."),
      "13 days",
    )
    assert.equal(
      extractUsageLimitWaitTime("Rate limit exceeded. Retry after 45 minutes."),
      "45 minutes",
    )
    assert.equal(
      extractUsageLimitWaitTime("No wait time here."),
      undefined,
    )
  })

  it("surfaces the first usage-limit attempt instead of placeholder fallback", () => {
    const error = resolveMeaningfulSingleError({
      error: 'Error: Model "placeholder:high" not found. Use --list-models to see available models.',
      modelAttempts: [
        {
          model: "opencode-go/deepseek-v4-pro",
          success: false,
          exitCode: 1,
          error: "429 Monthly usage limit reached. Resets in 13 days.",
        },
        {
          model: "placeholder",
          success: false,
          exitCode: 1,
          error: 'Error: Model "placeholder:high" not found. Use --list-models to see available models.',
        },
      ],
    })

    assert.match(error ?? "", /429 usage limit reached/)
    assert.match(error ?? "", /Wait time: 13 days/)
    assert.match(error ?? "", /opencode-go\/deepseek-v4-pro/)
  })

  it("falls back to the original error when no usage-limit attempt exists", () => {
    const error = resolveMeaningfulSingleError({
      error: 'Error: Model "placeholder:high" not found. Use --list-models to see available models.',
      modelAttempts: [
        {
          model: "placeholder",
          success: false,
          exitCode: 1,
          error: 'Error: Model "placeholder:high" not found. Use --list-models to see available models.',
        },
      ],
    })

    assert.equal(
      error,
      'Error: Model "placeholder:high" not found. Use --list-models to see available models.',
    )
  })
})
