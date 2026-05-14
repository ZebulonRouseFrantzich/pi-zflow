/**
 * structured-interview.test.ts — Unit tests for Phase 7 structured HITL gates.
 *
 * Validates that runStructuredInterview adapts to different context shapes
 * and returns the correct parsed decisions.
 */
import * as assert from "node:assert"
import { test, describe } from "node:test"

import {
  runStructuredInterview,
  buildPlanApprovalQuestions,
  buildImplementationGateQuestions,
  parseInterviewResponse,
} from "../extensions/zflow-change-workflows/index.js"

import type { InterviewableContext } from "../extensions/zflow-change-workflows/index.js"

// ---------------------------------------------------------------------------
// Helpers — fake contexts
// ---------------------------------------------------------------------------

function makeFakeCtx(overrides?: Partial<InterviewableContext>): InterviewableContext {
  const calls: string[] = []
  const result = {
    calls,
    ...overrides,
    ui: {
      notify: (_msg: string, _type?: string) => {
        calls.push(`notify: ${_msg}`)
      },
      ...(overrides?.ui ?? {}),
    },
  }
  return result as unknown as InterviewableContext
}

// ---------------------------------------------------------------------------
// Tests — runStructuredInterview
// ---------------------------------------------------------------------------

describe("runStructuredInterview", () => {
  test("uses ctx.interview when available and returns parsed response", async () => {
    const questions = buildPlanApprovalQuestions(
      "test-change",
      "v1",
      "Test summary",
    )

    const ctx = makeFakeCtx({
      interview: async (_payload: string) => {
        return JSON.stringify({ decision: "approve" })
      },
    })

    const result = await runStructuredInterview(
      ctx,
      questions,
      "Fallback message",
    )

    assert.ok(result, "should return a result")
    assert.strictEqual(result!.decision, "approve")
  })

  test("uses ctx.ui.interview when available", async () => {
    const questions = buildPlanApprovalQuestions(
      "test-change",
      "v1",
      "Test summary",
    )

    const ctx = makeFakeCtx({
      ui: {
        interview: async (_payload: string) => {
          return JSON.stringify({ decision: "revise", revisionNotes: "Update design" })
        },
        notify: (_msg: string, _type?: string) => {},
      },
    })

    const result = await runStructuredInterview(
      ctx,
      questions,
      "Fallback message",
    )

    assert.ok(result, "should return a result")
    assert.strictEqual(result!.decision, "revise")
    assert.strictEqual(result!.revisionNotes, "Update design")
  })

  test("prefers ctx.interview over ctx.ui.interview", async () => {
    const questions = buildPlanApprovalQuestions(
      "test-change",
      "v1",
      "Test summary",
    )

    const ctx = makeFakeCtx({
      interview: async (_payload: string) => {
        return JSON.stringify({ decision: "approve" })
      },
      ui: {
        interview: async (_payload: string) => {
          return JSON.stringify({ decision: "cancel" })
        },
        notify: (_msg: string, _type?: string) => {},
      },
    })

    const result = await runStructuredInterview(
      ctx,
      questions,
      "Fallback message",
    )

    assert.ok(result, "should return a result")
    assert.strictEqual(result!.decision, "approve")
  })

  test("falls back to ctx.ui.select when interview is unavailable", async () => {
    const questions = buildPlanApprovalQuestions(
      "test-change",
      "v1",
      "Test summary",
    )

    let selectCalled = false
    const ctx = makeFakeCtx({
      ui: {
        select: async (_title: string, _options: string[]) => {
          selectCalled = true
          return "Approve"
        },
        notify: (_msg: string, _type?: string) => {},
      },
    })

    const result = await runStructuredInterview(
      ctx,
      questions,
      "Fallback message",
    )

    assert.ok(selectCalled, "ctx.ui.select should have been called")
    assert.ok(result, "should return a result")
    assert.strictEqual(result!.decision, "approve")
  })

  test("falls back to ctx.ui.confirm when select is also unavailable", async () => {
    const questions = buildPlanApprovalQuestions(
      "test-change",
      "v1",
      "Test summary",
    )

    let confirmCalled = false
    const ctx = makeFakeCtx({
      ui: {
        confirm: async (_title: string, _msg: string) => {
          confirmCalled = true
          return true
        },
        notify: (_msg: string, _type?: string) => {},
      },
    })

    const result = await runStructuredInterview(
      ctx,
      questions,
      "Please confirm",
    )

    assert.ok(confirmCalled, "ctx.ui.confirm should have been called")
    assert.ok(result, "should return a result")
    assert.strictEqual(result!.decision, "approve")
  })

  test("returns default decision when no interactive UI is available (notify-only)", async () => {
    const questions = buildPlanApprovalQuestions(
      "test-change",
      "v1",
      "Test summary",
    )

    let notified = ""
    const ctx = makeFakeCtx({
      ui: {
        notify: (msg: string, _type?: string) => {
          notified = msg
        },
      },
    })

    const result = await runStructuredInterview(
      ctx,
      questions,
      "Fallback message for manual review",
    )

    assert.ok(notified.includes("Fallback message for manual review"), "should have notified fallback message")
    assert.ok(result, "should return a result")
    assert.strictEqual(result!.decision, "inspect")
  })

  test("handles ctx.interview returning undefined gracefully", async () => {
    const questions = buildPlanApprovalQuestions(
      "test-change",
      "v1",
      "Test summary",
    )

    const ctx = makeFakeCtx({
      interview: async (_payload: string) => {
        return undefined // interview not available (returns void/undefined)
      },
      ui: {
        select: async (_title: string, _options: string[]) => {
          return "Cancel"
        },
        notify: (_msg: string, _type?: string) => {},
      },
    })

    const result = await runStructuredInterview(
      ctx,
      questions,
      "Fallback",
    )

    assert.ok(result, "should return a result")
    assert.strictEqual(result!.decision, "cancel")
  })

  test("works with implementation gate questions (verification-failure)", async () => {
    const questions = buildImplementationGateQuestions(
      "test-change",
      "verification-failure",
      "Verification failed: tests not passing",
    )

    const ctx = makeFakeCtx({
      interview: async (_payload: string) => {
        return JSON.stringify({ action: "Auto-fix Loop" })
      },
    })

    const result = await runStructuredInterview(
      ctx,
      questions,
      "Fallback",
    )

    assert.ok(result, "should return a result")
    assert.strictEqual(result!.decision, "Auto-fix Loop")
  })

  test("works with implementation gate questions (review-findings)", async () => {
    const questions = buildImplementationGateQuestions(
      "test-change",
      "review-findings",
      "Review found 3 critical issues",
    )

    const ctx = makeFakeCtx({
      interview: async (_payload: string) => {
        return JSON.stringify({ action: "Fix All" })
      },
    })

    const result = await runStructuredInterview(
      ctx,
      questions,
      "Fallback",
    )

    assert.ok(result, "should return a result")
    assert.strictEqual(result!.decision, "Fix All")
  })

  test("uses ctx.ui.select fallback with implementation gate questions", async () => {
    const questions = buildImplementationGateQuestions(
      "test-change",
      "drift",
      "Plan drift detected",
    )

    let selectedOption = ""
    const ctx = makeFakeCtx({
      ui: {
        select: async (_title: string, options: string[]) => {
          selectedOption = options[0] ?? ""
          // Simulate user selecting "Approve Amendment"
          const approveLabel = options.find((o) => o.startsWith("Approve"))
          return approveLabel ?? options[0]
        },
        notify: (_msg: string, _type?: string) => {},
      },
    })

    const result = await runStructuredInterview(
      ctx,
      questions,
      "Fallback",
    )

    assert.ok(result, "should return a result")
    assert.strictEqual(result!.decision, "approve")
  })

  test("handles sync ctx.interview (not async)", async () => {
    const questions = buildPlanApprovalQuestions(
      "test-change",
      "v1",
      "Test summary",
    )

    const ctx = makeFakeCtx({
      interview: (_payload: string) => {
        return JSON.stringify({ decision: "cancel" })
      },
    })

    const result = await runStructuredInterview(
      ctx,
      questions,
      "Fallback",
    )

    assert.ok(result, "should return a result")
    assert.strictEqual(result!.decision, "cancel")
  })
})

// ---------------------------------------------------------------------------
// Tests — parseInterviewResponse
// ---------------------------------------------------------------------------

describe("parseInterviewResponse", () => {
  test("parses plan approval response with 'decision' field", () => {
    const result = parseInterviewResponse(
      JSON.stringify({ decision: "approve" }),
    )
    assert.strictEqual(result.decision, "approve")
  })

  test("parses gate response with 'action' field", () => {
    const result = parseInterviewResponse(
      JSON.stringify({ action: "Fix All" }),
    )
    assert.strictEqual(result.decision, "Fix All")
  })

  test("prefers 'decision' over 'action' when both present", () => {
    const result = parseInterviewResponse(
      JSON.stringify({ decision: "approve", action: "cancel" }),
    )
    assert.strictEqual(result.decision, "approve")
  })

  test("extracts revisionNotes when present", () => {
    const result = parseInterviewResponse(
      JSON.stringify({ decision: "revise", revisionNotes: "Update design section" }),
    )
    assert.strictEqual(result.decision, "revise")
    assert.strictEqual(result.revisionNotes, "Update design section")
  })

  test("returns fallback 'cancel' for unparseable response", () => {
    const result = parseInterviewResponse("not json")
    assert.strictEqual(result.decision, "cancel")
  })

  test("returns fallback 'cancel' for empty response", () => {
    const result = parseInterviewResponse("")
    assert.strictEqual(result.decision, "cancel")
  })
})
