/**
 * Extension activation and behavior tests for pi-zflow umbrella help extension.
 *
 * Validates that the extension registers `/zflow-help`, tolerates duplicate
 * loading, renders help for all supported arguments, and shows a startup
 * hint once per lifetime.
 */
import { describe, it, afterEach } from "node:test"
import * as assert from "node:assert"

import activateZflowHelpExtension from "../extensions/zflow-help/index.js"
import { resetZflowRegistry } from "pi-zflow-core"

// ── Test helpers ─────────────────────────────────────────────────

interface SentMessage {
  customType: string
  content: string
  display: boolean | string
}

interface NotifyCall {
  message: string
  type: string
}

function makePiStub() {
  const commands: Map<string, { description: string; handler?: Function }> = new Map()
  const events: Map<string, Function[]> = new Map()
  const sentMessages: SentMessage[] = []
  const notifyCalls: NotifyCall[] = []

  const piStub = {
    commands,
    events,
    sentMessages,
    notifyCalls,

    pi: {
      registerCommand(name: string, opts: { description: string; handler: Function }) {
        commands.set(name, { description: opts.description, handler: opts.handler })
      },
      on(eventName: string, handler: Function) {
        const list = events.get(eventName) ?? []
        list.push(handler)
        events.set(eventName, list)
      },
      sendMessage(msg: any, _opts?: any) {
        sentMessages.push({
          customType: msg.customType ?? "",
          content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
          display: msg.display ?? false,
        })
      },
    },
  }

  function makeCtx(hasUI: boolean = true) {
    return {
      hasUI,
      ui: {
        notify(message: string, type: string = "info") {
          notifyCalls.push({ message, type })
        },
      },
    }
  }

  return { ...piStub, makeCtx }
}

// ── Tests ─────────────────────────────────────────────────────────

describe("zflow-help extension", () => {
  afterEach(() => {
    resetZflowRegistry()
  })

  // ── Command registration ─────────────────────────────────────

  it("registers the zflow-help command", () => {
    const { commands, pi } = makePiStub()

    activateZflowHelpExtension(pi as any)

    assert.ok(commands.has("zflow-help"), "zflow-help must be registered")
    const def = commands.get("zflow-help")!
    assert.ok(def.description.length > 0, "command must have a description")
  })

  it("registers session_start event listener", () => {
    const { events, pi } = makePiStub()

    activateZflowHelpExtension(pi as any)

    assert.ok(events.has("session_start"), "session_start listener must be registered")
    const handlers = events.get("session_start")!
    assert.equal(handlers.length, 1, "exactly one session_start handler")
  })

  // ── Duplicate-load guard ─────────────────────────────────────

  it("does not register duplicate command on second load", () => {
    const first = makePiStub()
    const second = makePiStub()

    activateZflowHelpExtension(first.pi as any)
    activateZflowHelpExtension(second.pi as any)

    assert.equal(first.commands.size, 1, "first call registers one command")
    assert.equal(second.commands.size, 0, "second call registers nothing")
    assert.equal(second.events.size, 0, "second call registers no events")
  })

  it("does not register duplicate command when loaded twice on same pi", () => {
    const { commands, pi } = makePiStub()

    activateZflowHelpExtension(pi as any)
    activateZflowHelpExtension(pi as any)

    assert.equal(commands.size, 1, "command registered exactly once")
  })

  // ── Topic rendering — no args / overview ─────────────────────

  it("renders overview when called with no args", () => {
    const { commands, pi, sentMessages } = makePiStub()

    activateZflowHelpExtension(pi as any)
    const handler = commands.get("zflow-help")!.handler!

    handler("", makePiStub().makeCtx())

    assert.equal(sentMessages.length, 1, "one message sent")
    assert.equal(sentMessages[0].customType, "zflow-help")
    assert.ok(sentMessages[0].display === true)
    assert.ok(sentMessages[0].content.includes("pi-zflow Help"), "overview title")
    assert.ok(sentMessages[0].content.includes("Recommended Workflow"), "flow section")
  })

  it("renders overview when called with 'overview'", () => {
    const { commands, pi, sentMessages } = makePiStub()

    activateZflowHelpExtension(pi as any)
    const handler = commands.get("zflow-help")!.handler!

    handler("overview", makePiStub().makeCtx())

    assert.equal(sentMessages.length, 1)
    assert.ok(sentMessages[0].content.includes("pi-zflow Help"))
  })

  // ── Topic rendering — commands ───────────────────────────────

  it("renders commands list", () => {
    const { commands, pi, sentMessages } = makePiStub()

    activateZflowHelpExtension(pi as any)
    const handler = commands.get("zflow-help")!.handler!

    handler("commands", makePiStub().makeCtx())

    assert.equal(sentMessages.length, 1)
    assert.ok(sentMessages[0].content.includes("pi-zflow Commands"))
    assert.ok(sentMessages[0].content.includes("zflow-profile"), "includes profile commands")
    assert.ok(sentMessages[0].content.includes("zflow-change-prepare"), "includes change commands")
    assert.ok(sentMessages[0].content.includes("zflow-review-code"), "includes review commands")
    assert.ok(sentMessages[0].content.includes("zflow-plan"), "includes plan commands")
    assert.ok(sentMessages[0].content.includes("zflow_write_plan_artifact"), "includes artifact tool")
  })

  // ── Topic rendering — flow ───────────────────────────────────

  it("renders flow guidance", () => {
    const { commands, pi, sentMessages } = makePiStub()

    activateZflowHelpExtension(pi as any)
    const handler = commands.get("zflow-help")!.handler!

    handler("flow", makePiStub().makeCtx())

    assert.equal(sentMessages.length, 1)
    assert.ok(sentMessages[0].content.includes("Recommended Workflow"))
    assert.ok(sentMessages[0].content.includes("Profile Management"))
    assert.ok(sentMessages[0].content.includes("Read-Only Planning Mode"))
    assert.ok(sentMessages[0].content.includes("Change Workflows"))
    assert.ok(sentMessages[0].content.includes("Code Review"))
    assert.ok(sentMessages[0].content.includes("Typical Cycle"))
    assert.ok(!sentMessages[0].content.includes("//zflow-"), "usage must not render with doubled slashes")
  })

  // ── Topic rendering — per-topic args ─────────────────────────

  it("renders profiles topic", () => {
    const { commands, pi, sentMessages } = makePiStub()
    activateZflowHelpExtension(pi as any)
    const handler = commands.get("zflow-help")!.handler!

    handler("profiles", makePiStub().makeCtx())

    assert.equal(sentMessages.length, 1)
    assert.ok(sentMessages[0].content.includes("Profile Management"))
    assert.ok(sentMessages[0].content.includes("zflow-profile"))
  })

  it("renders plan-mode topic for 'plan' alias", () => {
    const { commands, pi, sentMessages } = makePiStub()
    activateZflowHelpExtension(pi as any)
    const handler = commands.get("zflow-help")!.handler!

    handler("plan", makePiStub().makeCtx())

    assert.equal(sentMessages.length, 1)
    assert.ok(sentMessages[0].content.includes("Read-Only Planning Mode"))
  })

  it("renders plan-mode topic for 'planning' alias", () => {
    const { commands, pi, sentMessages } = makePiStub()
    activateZflowHelpExtension(pi as any)
    const handler = commands.get("zflow-help")!.handler!

    handler("planning", makePiStub().makeCtx())

    assert.equal(sentMessages.length, 1)
    assert.ok(sentMessages[0].content.includes("Read-Only Planning Mode"))
  })

  it("renders review topic", () => {
    const { commands, pi, sentMessages } = makePiStub()
    activateZflowHelpExtension(pi as any)
    const handler = commands.get("zflow-help")!.handler!

    handler("review", makePiStub().makeCtx())

    assert.equal(sentMessages.length, 1)
    assert.ok(sentMessages[0].content.includes("Code Review"))
  })

  it("renders change topic", () => {
    const { commands, pi, sentMessages } = makePiStub()
    activateZflowHelpExtension(pi as any)
    const handler = commands.get("zflow-help")!.handler!

    handler("change", makePiStub().makeCtx())

    assert.equal(sentMessages.length, 1)
    assert.ok(sentMessages[0].content.includes("Change Workflows"))
  })

  it("renders agents topic", () => {
    const { commands, pi, sentMessages } = makePiStub()
    activateZflowHelpExtension(pi as any)
    const handler = commands.get("zflow-help")!.handler!

    handler("agents", makePiStub().makeCtx())

    assert.equal(sentMessages.length, 1)
    assert.ok(sentMessages[0].content.includes("Agent Setup"))
  })

  // ── Topic rendering — doctor ─────────────────────────────────

  it("renders diagnostics for doctor", () => {
    const { commands, pi, sentMessages } = makePiStub()
    activateZflowHelpExtension(pi as any)
    const handler = commands.get("zflow-help")!.handler!

    handler("doctor", makePiStub().makeCtx())

    assert.equal(sentMessages.length, 1)
    assert.ok(sentMessages[0].content.includes("pi-zflow Diagnostics"))
    assert.ok(sentMessages[0].content.includes("capabilities registered"))
    assert.ok(sentMessages[0].content.includes("zflow-help"), "includes own capability")
  })

  // ── Unknown arg ──────────────────────────────────────────────

  it("shows warning for unknown topic", () => {
    const { commands, pi, notifyCalls, makeCtx } = makePiStub()
    activateZflowHelpExtension(pi as any)
    const handler = commands.get("zflow-help")!.handler!

    handler("nonexistent", makeCtx(true))

    assert.equal(notifyCalls.length, 1)
    assert.ok(notifyCalls[0].type === "warning")
    assert.ok(notifyCalls[0].message.includes("Unknown help topic"))
  })

  // ── Startup hint ─────────────────────────────────────────────

  it("shows startup hint on session_start with startup reason and UI", () => {
    const { events, pi, notifyCalls, makeCtx } = makePiStub()
    activateZflowHelpExtension(pi as any)

    const handlers = events.get("session_start")!
    const handler = handlers[0]

    handler({ reason: "startup" }, makeCtx(true))

    assert.equal(notifyCalls.length, 1, "notification shown")
    assert.ok(notifyCalls[0].message.includes("pi-zflow loaded"))
    assert.equal(notifyCalls[0].type, "info")
  })

  it("does not show startup hint for non-startup reasons", () => {
    const { events, pi, notifyCalls, makeCtx } = makePiStub()
    activateZflowHelpExtension(pi as any)

    const handlers = events.get("session_start")!
    const handler = handlers[0]

    handler({ reason: "reload" }, makeCtx(true))
    handler({ reason: "resume" }, makeCtx(true))
    handler({ reason: "fork" }, makeCtx(true))

    assert.equal(notifyCalls.length, 0, "no notifications for non-startup reasons")
  })

  it("does not show startup hint when hasUI is false", () => {
    const { events, pi, notifyCalls, makeCtx } = makePiStub()
    activateZflowHelpExtension(pi as any)

    const handlers = events.get("session_start")!
    const handler = handlers[0]

    handler({ reason: "startup" }, makeCtx(false))

    assert.equal(notifyCalls.length, 0, "no notification when hasUI is false")
  })

  it("shows startup hint only once", () => {
    const { events, pi, notifyCalls, makeCtx } = makePiStub()
    activateZflowHelpExtension(pi as any)

    const handlers = events.get("session_start")!
    const handler = handlers[0]

    handler({ reason: "startup" }, makeCtx(true))
    handler({ reason: "startup" }, makeCtx(true))
    handler({ reason: "startup" }, makeCtx(true))

    assert.equal(notifyCalls.length, 1, "hint shown exactly once")
  })
})
