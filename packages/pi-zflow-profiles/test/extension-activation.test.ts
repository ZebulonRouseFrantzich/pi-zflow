import { describe, it, afterEach } from "node:test"
import * as assert from "node:assert/strict"

import activateZflowProfilesExtension from "../extensions/zflow-profiles/index.js"
import { resetZflowRegistry } from "pi-zflow-core"

function makePiStub() {
  const commands: string[] = []
  const events: string[] = []
  return {
    commands,
    events,
    pi: {
      registerCommand(name: string) {
        commands.push(name)
      },
      on(eventName: string) {
        events.push(eventName)
      },
    },
  }
}

describe("zflow-profiles extension activation", () => {
  afterEach(() => {
    resetZflowRegistry()
  })

  it("does not register duplicate commands or hooks on duplicate load", () => {
    resetZflowRegistry()
    const first = makePiStub()
    const second = makePiStub()

    activateZflowProfilesExtension(first.pi as any)
    activateZflowProfilesExtension(second.pi as any)

    assert.deepEqual(first.commands, ["zflow-profile"])
    assert.deepEqual(first.events, ["session_start"])
    assert.deepEqual(second.commands, [])
    assert.deepEqual(second.events, [])
  })
})
