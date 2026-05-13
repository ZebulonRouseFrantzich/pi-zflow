/**
 * triage.test.ts — Tests for pi-interview-backed triage helpers.
 *
 * Covers:
 *   - getDefaultAction: all four severity levels
 *   - buildTriageQuestions: conversion, default actions, empty input
 *   - processTriageResponses: submit, dismiss, edit, mixed actions, default dismiss
 *   - formatTriageSummary: counts, dismissed list, edits
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  getDefaultAction,
  buildTriageQuestions,
  processTriageResponses,
  formatTriageSummary,
} from "../extensions/zflow-review/triage.js"

import type {
  TriageAction,
  TriageResult,
  TriageQuestion,
} from "../extensions/zflow-review/triage.js"

import type { PrReviewFinding } from "../extensions/zflow-review/findings.js"

// ── Helpers ────────────────────────────────────────────────────

function makeFinding(
  overrides: Partial<PrReviewFinding> & { title: string; severity: "critical" | "major" | "minor" | "nit" },
): PrReviewFinding {
  return {
    title: overrides.title,
    severity: overrides.severity,
    file: overrides.file ?? "src/test.ts",
    evidence: overrides.evidence ?? "Evidence description",
    recommendation: overrides.recommendation ?? "Fix it",
    submit: overrides.submit ?? true,
    lines: overrides.lines,
    editedBody: overrides.editedBody,
  }
}

// ── getDefaultAction ───────────────────────────────────────────

void describe("getDefaultAction", () => {
  it("should return submit for critical severity", () => {
    assert.equal(getDefaultAction("critical"), "submit")
  })

  it("should return submit for major severity", () => {
    assert.equal(getDefaultAction("major"), "submit")
  })

  it("should return dismiss for minor severity", () => {
    assert.equal(getDefaultAction("minor"), "dismiss")
  })

  it("should return dismiss for nit severity", () => {
    assert.equal(getDefaultAction("nit"), "dismiss")
  })
})

// ── buildTriageQuestions ───────────────────────────────────────

void describe("buildTriageQuestions", () => {
  it("should convert findings to triage questions", () => {
    const findings: PrReviewFinding[] = [
      makeFinding({ title: "Missing null guard", severity: "critical", file: "src/webhook.ts", lines: "120-127" }),
      makeFinding({ title: "Unused import", severity: "nit", file: "src/util.ts" }),
    ]

    const questions = buildTriageQuestions(findings)

    assert.equal(questions.length, 2)

    // First finding
    assert.equal(questions[0].findingId, "f-a")
    assert.equal(questions[0].title, "Missing null guard")
    assert.equal(questions[0].severity, "critical")
    assert.equal(questions[0].file, "src/webhook.ts")
    assert.equal(questions[0].lines, "120-127")

    // Second finding
    assert.equal(questions[1].findingId, "f-b")
    assert.equal(questions[1].severity, "nit")
    assert.equal(questions[1].file, "src/util.ts")
  })

  it("should set default action based on severity", () => {
    const findings: PrReviewFinding[] = [
      makeFinding({ title: "Critical bug", severity: "critical" }),
      makeFinding({ title: "Major issue", severity: "major" }),
      makeFinding({ title: "Minor style", severity: "minor" }),
      makeFinding({ title: "Nitpick", severity: "nit" }),
    ]

    const questions = buildTriageQuestions(findings)

    assert.equal(questions[0].defaultAction, "submit")
    assert.equal(questions[1].defaultAction, "submit")
    assert.equal(questions[2].defaultAction, "dismiss")
    assert.equal(questions[3].defaultAction, "dismiss")
  })

  it("should return empty array for empty findings", () => {
    const questions = buildTriageQuestions([])
    assert.deepEqual(questions, [])
  })
})

// ── processTriageResponses ─────────────────────────────────────

void describe("processTriageResponses", () => {
  it("should mark finding as submitted when action is submit", () => {
    const findings: PrReviewFinding[] = [
      makeFinding({ title: "Missing guard", severity: "critical" }),
    ]

    const responses: TriageAction[] = [
      { findingId: "f-a", action: "submit" },
    ]

    const result = processTriageResponses(findings, responses)

    assert.equal(result.submitFindings.length, 1)
    assert.equal(result.submitFindings[0].title, "Missing guard")
    assert.equal(result.submitFindings[0].submit, true)
    assert.equal(result.dismissedFindings.length, 0)
    assert.equal(result.totalFindings, 1)
    assert.equal(result.hadEdits, false)
  })

  it("should mark finding as dismissed when action is dismiss", () => {
    const findings: PrReviewFinding[] = [
      makeFinding({ title: "Style nit", severity: "nit" }),
    ]

    const responses: TriageAction[] = [
      { findingId: "f-a", action: "dismiss" },
    ]

    const result = processTriageResponses(findings, responses)

    assert.equal(result.dismissedFindings.length, 1)
    assert.equal(result.dismissedFindings[0].title, "Style nit")
    assert.equal(result.dismissedFindings[0].submit, false)
    assert.equal(result.submitFindings.length, 0)
    assert.equal(result.hadEdits, false)
  })

  it("should update editedBody when action is edit", () => {
    const findings: PrReviewFinding[] = [
      makeFinding({ title: "Missing guard", severity: "major", evidence: "old evidence" }),
    ]

    const responses: TriageAction[] = [
      { findingId: "f-a", action: "edit", editedBody: "Please add input validation here because..." },
    ]

    const result = processTriageResponses(findings, responses)

    assert.equal(result.submitFindings.length, 1)
    assert.equal(result.submitFindings[0].title, "Missing guard")
    assert.equal(result.submitFindings[0].submit, true)
    assert.equal(result.submitFindings[0].editedBody, "Please add input validation here because...")
    assert.equal(result.dismissedFindings.length, 0)
    assert.equal(result.hadEdits, true)
  })

  it("should handle mixed actions correctly", () => {
    const findings: PrReviewFinding[] = [
      makeFinding({ title: "Critical bug", severity: "critical" }),
      makeFinding({ title: "Minor style", severity: "minor" }),
      makeFinding({ title: "Edit me", severity: "major", evidence: "original" }),
    ]

    const responses: TriageAction[] = [
      { findingId: "f-a", action: "submit" },
      { findingId: "f-b", action: "dismiss" },
      { findingId: "f-c", action: "edit", editedBody: "Reworded" },
    ]

    const result = processTriageResponses(findings, responses)

    assert.equal(result.submitFindings.length, 2)
    assert.equal(result.submitFindings[0].title, "Critical bug")
    assert.equal(result.submitFindings[1].title, "Edit me")
    assert.equal(result.submitFindings[1].editedBody, "Reworded")
    assert.equal(result.dismissedFindings.length, 1)
    assert.equal(result.dismissedFindings[0].title, "Minor style")
    assert.equal(result.totalFindings, 3)
    assert.equal(result.hadEdits, true)
  })

  it("should dismiss findings not referenced in responses", () => {
    const findings: PrReviewFinding[] = [
      makeFinding({ title: "Bug A", severity: "critical" }),
      makeFinding({ title: "Bug B", severity: "major" }),
    ]

    // Only respond to Bug A (findingId f-a)
    const responses: TriageAction[] = [
      { findingId: "f-a", action: "submit" },
    ]

    const result = processTriageResponses(findings, responses)

    assert.equal(result.submitFindings.length, 1)
    assert.equal(result.submitFindings[0].title, "Bug A")
    assert.equal(result.dismissedFindings.length, 1)
    assert.equal(result.dismissedFindings[0].title, "Bug B")
    assert.equal(result.totalFindings, 2)
    assert.equal(result.hadEdits, false)
  })
})

// ── formatTriageSummary ───────────────────────────────────────

void describe("formatTriageSummary", () => {
  it("should show correct counts for mixed result", () => {
    const result: TriageResult = {
      submitFindings: [
        makeFinding({ title: "Bug A", severity: "critical" }),
      ],
      dismissedFindings: [
        makeFinding({ title: "Nit B", severity: "nit" }),
      ],
      totalFindings: 2,
      hadEdits: false,
    }

    const summary = formatTriageSummary(result)

    assert.ok(summary.includes("Triage Summary"))
    assert.ok(summary.includes("**1** finding selected for submission"))
    assert.ok(summary.includes("**1** finding dismissed"))
  })

  it("should handle all-dismissed case", () => {
    const result: TriageResult = {
      submitFindings: [],
      dismissedFindings: [
        makeFinding({ title: "Nit A", severity: "nit", file: "src/a.ts" }),
        makeFinding({ title: "Nit B", severity: "nit", file: "src/b.ts" }),
      ],
      totalFindings: 2,
      hadEdits: false,
    }

    const summary = formatTriageSummary(result)

    assert.ok(summary.includes("**0** findings selected for submission"))
    assert.ok(summary.includes("**2** findings dismissed"))
    assert.ok(summary.includes("Dismissed Findings"))
    assert.ok(summary.includes("Nit A"))
    assert.ok(summary.includes("Nit B"))
  })

  it("should include edit count when edits present", () => {
    const result: TriageResult = {
      submitFindings: [
        makeFinding({ title: "Bug A", severity: "critical" }),
        makeFinding({ title: "Bug B", severity: "major", editedBody: "edited" }),
      ],
      dismissedFindings: [],
      totalFindings: 2,
      hadEdits: true,
    }

    const summary = formatTriageSummary(result)

    assert.ok(summary.includes("**1** finding edited before submission"))
    assert.ok(summary.includes("**2** findings selected for submission"))
  })
})
