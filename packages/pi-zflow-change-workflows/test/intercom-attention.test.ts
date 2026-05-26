import * as assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  detectWorkflowAttentionSignal,
  detectIncomingWorkflowAttention,
} from "../extensions/zflow-change-workflows/index.js"

describe("detectWorkflowAttentionSignal", () => {
  it("detects contact_supervisor need-decision signals", () => {
    const message = detectWorkflowAttentionSignal({
      id: "group-a",
      agent: "zflow.implement-routine",
      title: "Group A",
      lastCommand: "contact_supervisor {\"reason\":\"need_decision\",\"message\":\"BLOCKED: group A needs clarification\"}",
      logs: [],
    })

    assert.ok(message)
    assert.match(message!, /Group A/)
    assert.match(message!, /BLOCKED/)
    assert.match(message!, /contact_supervisor/)
  })

  it("detects raw intercom drift signals from logs", () => {
    const message = detectWorkflowAttentionSignal({
      id: "group-b",
      agent: "zflow.implement-hard",
      title: undefined,
      lastCommand: "read execution-groups.md",
      logs: [
        "intercom send to zflow-implement-feat-auth-deadbeef",
        "DRIFT DETECTED: execution group is infeasible",
      ],
    })

    assert.ok(message)
    assert.match(message!, /zflow\.implement-hard/)
    assert.match(message!, /intercom/)
  })

  it("returns undefined for normal worker activity", () => {
    const message = detectWorkflowAttentionSignal({
      id: "group-c",
      agent: "zflow.implement-routine",
      title: "Group C",
      lastCommand: "edit src/foo.ts",
      logs: ["updated src/foo.ts"],
    })

    assert.equal(message, undefined)
  })
})

describe("detectIncomingWorkflowAttention", () => {
  it("detects incoming custom intercom coordination messages", () => {
    const message = detectIncomingWorkflowAttention({
      id: "entry-1",
      type: "message",
      message: {
        role: "custom",
        customType: "pi-intercom",
        content: "DRIFT DETECTED: Group A cannot proceed until the orchestrator responds.",
        timestamp: Date.now(),
      },
    })

    assert.ok(message)
    assert.match(message!, /Incoming DRIFT_DETECTED signal/)
  })

  it("ignores workflow progress custom messages", () => {
    const message = detectIncomingWorkflowAttention({
      id: "entry-2",
      type: "message",
      message: {
        role: "custom",
        customType: "zflow-workflow-progress",
        content: "implementation progress",
        timestamp: Date.now(),
      },
    })

    assert.equal(message, undefined)
  })

  it("ignores unrelated session messages", () => {
    const message = detectIncomingWorkflowAttention({
      id: "entry-3",
      type: "message",
      message: {
        role: "user",
        content: "Please continue implementing the plan.",
        timestamp: Date.now(),
      },
    })

    assert.equal(message, undefined)
  })
})
