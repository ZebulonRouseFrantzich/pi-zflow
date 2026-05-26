import * as assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  buildWorkflowIntercomSessionName,
  ensureWorkflowIntercomTarget,
} from "../extensions/zflow-change-workflows/index.js"

describe("workflow intercom target helpers", () => {
  it("builds a deterministic session name from workflow, change, and session id", () => {
    const name = buildWorkflowIntercomSessionName(
      "implement",
      "Feat Auth/Flow",
      "abcd1234-ef56-7890-abcd-1234567890ef",
    )

    assert.equal(name, "zflow-implement-feat-auth-flow-abcd1234")
  })

  it("reuses an existing session name without overwriting it", () => {
    let setCount = 0
    const pi = {
      getSessionName: () => "already-named-session",
      setSessionName: () => {
        setCount++
      },
    }
    const ctx = {
      sessionManager: {
        getSessionId: () => "deadbeef-1234-5678-90ab-fedcba987654",
      },
    }

    const target = ensureWorkflowIntercomTarget(pi, ctx, "fix", "feat-auth")

    assert.equal(target, "already-named-session")
    assert.equal(setCount, 0)
  })

  it("creates and stores a session name when the session is unnamed", () => {
    let storedName: string | undefined
    const pi = {
      getSessionName: () => storedName,
      setSessionName: (name: string) => {
        storedName = name
      },
    }
    const ctx = {
      sessionManager: {
        getSessionId: () => "feedface-1234-5678-90ab-fedcba987654",
      },
    }

    const target = ensureWorkflowIntercomTarget(pi, ctx, "fix", "feat-auth")

    assert.equal(target, "zflow-fix-feat-auth-feedface")
    assert.equal(storedName, "zflow-fix-feat-auth-feedface")
  })
})
