/**
 * deviations.test.ts — Unit tests for deviation report and summary operations.
 *
 * Tests cover:
 * - Formatting and parsing deviation reports
 * - Writing and reading back reports
 * - Synthesizing deviation summaries
 * - Determining recommendations
 */
import * as assert from "node:assert"
import { test, describe } from "node:test"

import {
  formatDeviationReport,
  synthesizeDeviationSummary,
  determineRecommendation,
} from "../extensions/zflow-change-workflows/deviations.js"
import type {
  DeviationReport,
  DeviationSummary,
} from "../extensions/zflow-change-workflows/deviations.js"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeReport(overrides: Partial<DeviationReport> = {}): DeviationReport {
  return {
    changeId: "ch42",
    planVersion: "v1",
    group: "Group 3",
    reportedBy: "zflow.implement-hard",
    status: "open",
    infeasibleInstruction: 'Modify existing FooService in src/foo.ts',
    actualStructure: '`FooService` does not exist; equivalent logic lives in src/core/foo-service.ts',
    blockingConflict: 'execution group targets the wrong module boundary',
    suggestedAmendment: 'update Group 3 paths and dependency notes to target src/core/foo-service.ts',
    filesInspected: ['src/foo.ts', 'src/core/foo-service.ts'],
    filesAffected: [],
    localEditsReverted: true,
    createdAt: '2026-05-13T00:00:00.000Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// formatDeviationReport
// ---------------------------------------------------------------------------

describe("formatDeviationReport", () => {
  test("includes all required fields", () => {
    const report = makeReport()
    const formatted = formatDeviationReport(report)

    assert.ok(formatted.includes("# Deviation Report"))
    assert.ok(formatted.includes("**Change ID**: ch42"))
    assert.ok(formatted.includes("**Plan Version**: v1"))
    assert.ok(formatted.includes("**Group**: Group 3"))
    assert.ok(formatted.includes("**Reported by**: zflow.implement-hard"))
    assert.ok(formatted.includes("**Status**: open"))
    assert.ok(formatted.includes("## What was planned"))
    assert.ok(formatted.includes("## What was found"))
    assert.ok(formatted.includes("## Impact"))
    assert.ok(formatted.includes("## Proposed resolution"))
    assert.ok(formatted.includes("## Files inspected"))
    assert.ok(formatted.includes("## Files affected"))
    assert.ok(formatted.includes("## Local edits reverted"))
  })

  test("marks edits as reverted with Yes", () => {
    const report = makeReport({ localEditsReverted: true })
    const formatted = formatDeviationReport(report)
    assert.ok(formatted.includes("Yes"))
    assert.ok(!formatted.includes("No") || formatted.indexOf("No") < 0)
  })

  test("marks edits as not reverted with No", () => {
    const report = makeReport({ localEditsReverted: false })
    const formatted = formatDeviationReport(report)
    assert.ok(formatted.includes("No"))
  })

  test("lists files inspected", () => {
    const report = makeReport({ filesInspected: ["src/a.ts", "src/b.ts"] })
    const formatted = formatDeviationReport(report)
    assert.ok(formatted.includes("- src/a.ts"))
    assert.ok(formatted.includes("- src/b.ts"))
  })

  test("shows (none) for empty files affected", () => {
    const report = makeReport({ filesAffected: [] })
    const formatted = formatDeviationReport(report)
    assert.ok(formatted.includes("(none)"))
  })

  test("lists non-empty files affected", () => {
    const report = makeReport({ filesAffected: ["src/a.ts"] })
    const formatted = formatDeviationReport(report)
    assert.ok(formatted.includes("- src/a.ts"))
    assert.ok(!formatted.includes("(none)"))
  })
})

// ---------------------------------------------------------------------------
// synthesizeDeviationSummary
// ---------------------------------------------------------------------------

describe("synthesizeDeviationSummary", () => {
  test("includes all affected groups", () => {
    const reports: DeviationReport[] = [
      makeReport({ group: "Group 3" }),
      makeReport({ group: "Group 4", changeId: "ch42", planVersion: "v1" }),
    ]
    const summary = synthesizeDeviationSummary("run-123", "ch42", "v1", reports)
    assert.ok(summary.affectedGroups.includes("Group 3"))
    assert.ok(summary.affectedGroups.includes("Group 4"))
  })

  test("deduplicates affected groups", () => {
    const reports: DeviationReport[] = [
      makeReport({ group: "Group 3" }),
      makeReport({ group: "Group 3" }),
    ]
    const summary = synthesizeDeviationSummary("run-123", "ch42", "v1", reports)
    assert.strictEqual(summary.affectedGroups.length, 1)
  })

  test("detects edits retained across reports", () => {
    const reports: DeviationReport[] = [
      makeReport({ localEditsReverted: true }),
      makeReport({ localEditsReverted: false }),
    ]
    const summary = synthesizeDeviationSummary("run-123", "ch42", "v1", reports)
    assert.strictEqual(summary.editsRetained, true)
  })

  test("detects no edits retained", () => {
    const reports: DeviationReport[] = [
      makeReport({ localEditsReverted: true }),
      makeReport({ localEditsReverted: true }),
    ]
    const summary = synthesizeDeviationSummary("run-123", "ch42", "v1", reports)
    assert.strictEqual(summary.editsRetained, false)
  })

  test("includes proposed amendments from reports", () => {
    const reports: DeviationReport[] = [
      makeReport({ suggestedAmendment: "fix paths in group 3" }),
      makeReport({ suggestedAmendment: "update dependencies for group 4" }),
    ]
    const summary = synthesizeDeviationSummary("run-123", "ch42", "v1", reports)
    assert.ok(summary.proposedAmendments.length >= 2)
  })

  test("deduplicates identical amendments", () => {
    const reports: DeviationReport[] = [
      makeReport({ suggestedAmendment: "fix paths" }),
      makeReport({ suggestedAmendment: "fix paths" }),
    ]
    const summary = synthesizeDeviationSummary("run-123", "ch42", "v1", reports)
    assert.strictEqual(summary.proposedAmendments.length, 1)
  })

  test("recommends replan when all edits reverted", () => {
    const reports: DeviationReport[] = [
      makeReport({ localEditsReverted: true }),
    ]
    const summary = synthesizeDeviationSummary("run-123", "ch42", "v1", reports)
    assert.strictEqual(summary.recommendation, "replan")
  })

  test("recommends inspect when edits are retained", () => {
    const reports: DeviationReport[] = [
      makeReport({ localEditsReverted: false }),
    ]
    const summary = synthesizeDeviationSummary("run-123", "ch42", "v1", reports)
    assert.strictEqual(summary.recommendation, "inspect")
  })

  test("includes required metadata fields", () => {
    const reports: DeviationReport[] = [makeReport()]
    const summary = synthesizeDeviationSummary("run-123", "ch42", "v1", reports)
    assert.strictEqual(summary.runId, "run-123")
    assert.strictEqual(summary.changeId, "ch42")
    assert.strictEqual(summary.planVersion, "v1")
    assert.ok(summary.createdAt)
  })

  test("includes common root causes", () => {
    const report = makeReport({
      blockingConflict: "execution group targets the wrong module boundary",
    })
    const summary = synthesizeDeviationSummary("run-123", "ch42", "v1", [report])
    assert.ok(summary.commonRootCauses.length > 0)
  })
})

// ---------------------------------------------------------------------------
// determineRecommendation
// ---------------------------------------------------------------------------

describe("determineRecommendation", () => {
  test("returns inspect for empty reports", () => {
    assert.strictEqual(determineRecommendation([]), "inspect")
  })

  test("returns replan when all edits reverted", () => {
    const reports: DeviationReport[] = [
      makeReport({ localEditsReverted: true }),
    ]
    assert.strictEqual(determineRecommendation(reports), "replan")
  })

  test("returns inspect when any edits retained", () => {
    const reports: DeviationReport[] = [
      makeReport({ localEditsReverted: false }),
    ]
    assert.strictEqual(determineRecommendation(reports), "inspect")
  })

  test("returns inspect when mixed (some retained, some reverted)", () => {
    const reports: DeviationReport[] = [
      makeReport({ localEditsReverted: true }),
      makeReport({ localEditsReverted: false }),
    ]
    assert.strictEqual(determineRecommendation(reports), "inspect")
  })
})
