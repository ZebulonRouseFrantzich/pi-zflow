/**
 * reviewer-manifest.test.ts — Tests for reviewer-manifest types and helpers.
 *
 * Covers:
 *   - createManifest produces correct initial state for both modes
 *   - recordExecuted, recordSkipped, recordFailed update state correctly
 *   - Immutable-style: original manifest is not mutated
 *   - Coverage summary calculated correctly
 *   - isComplete checks for all reviewers finished
 *   - getActiveReviewers / getInactiveReviewers / getReviewersByStatus
 *   - Error handling for unknown reviewers
 *   - Both code-review and plan-review modes work
 *   - Tier field is preserved
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  createManifest,
  recordExecuted,
  recordSkipped,
  recordFailed,
  getCoverageSummary,
  isComplete,
  getActiveReviewers,
  getInactiveReviewers,
  getReviewersByStatus,
} from "../src/reviewer-manifest.js"

import type { ReviewerManifest, CoverageSummary } from "../src/reviewer-manifest.js"

// ── createManifest ─────────────────────────────────────────────

void describe("createManifest", () => {
  it("should create a manifest with all reviewers in requested state", () => {
    const m = createManifest("code-review", "standard", [
      "correctness",
      "integration",
      "security",
    ])

    assert.equal(m.mode, "code-review")
    assert.equal(m.tier, "standard")
    assert.equal(m.reviewers.length, 3)
    assert.equal(m.skippedReviewers.length, 0)
    assert.equal(m.failedReviewers.length, 0)

    for (const r of m.reviewers) {
      assert.equal(r.status, "requested")
    }

    // Verify reviewer names
    assert.equal(m.reviewers[0].name, "correctness")
    assert.equal(m.reviewers[1].name, "integration")
    assert.equal(m.reviewers[2].name, "security")
  })

  it("should generate a unique runId", () => {
    const m1 = createManifest("code-review", "standard", ["correctness"])
    const m2 = createManifest("code-review", "standard", ["correctness"])

    assert.notEqual(m1.runId, m2.runId)
    assert.ok(m1.runId.startsWith("rev-"))
    assert.ok(m2.runId.startsWith("rev-"))
  })

  it("should set createdAt to a valid ISO timestamp", () => {
    const m = createManifest("code-review", "standard", ["correctness"])
    const parsed = new Date(m.createdAt)
    assert.ok(!isNaN(parsed.getTime()))
  })

  it("should work with plan-review mode", () => {
    const m = createManifest("plan-review", "system", [
      "correctness",
      "integration",
      "feasibility",
    ])

    assert.equal(m.mode, "plan-review")
    assert.equal(m.tier, "system")
    assert.equal(m.reviewers.length, 3)
  })

  it("should work with empty reviewer list", () => {
    const m = createManifest("code-review", "standard", [])

    assert.equal(m.reviewers.length, 0)
    assert.equal(m.skippedReviewers.length, 0)
    assert.equal(m.failedReviewers.length, 0)
  })

  it("should preserve tier field", () => {
    const m1 = createManifest("plan-review", "standard", ["correctness"])
    const m2 = createManifest("plan-review", "logic", ["correctness", "integration", "logic"])
    const m3 = createManifest("plan-review", "system", ["correctness", "integration", "feasibility"])
    const m4 = createManifest("plan-review", "logic,system", [
      "correctness", "integration", "feasibility", "logic",
    ])

    assert.equal(m1.tier, "standard")
    assert.equal(m2.tier, "logic")
    assert.equal(m3.tier, "system")
    assert.equal(m4.tier, "logic,system")
  })
})

// ── recordExecuted ─────────────────────────────────────────────

void describe("recordExecuted", () => {
  it("should mark a reviewer as executed", () => {
    const m = createManifest("code-review", "standard", [
      "correctness",
      "integration",
    ])

    const updated = recordExecuted(m, "correctness")

    // Updated manifest reflects the change
    assert.equal(updated.reviewers[0].status, "executed")
    assert.equal(updated.reviewers[1].status, "requested")

    // Original is not mutated
    assert.equal(m.reviewers[0].status, "requested")
    assert.equal(m.reviewers[1].status, "requested")
  })

  it("should support marking multiple reviewers as executed", () => {
    const m = createManifest("code-review", "standard", [
      "correctness",
      "integration",
      "security",
    ])

    const step1 = recordExecuted(m, "correctness")
    const step2 = recordExecuted(step1, "integration")
    const step3 = recordExecuted(step2, "security")

    assert.equal(step3.reviewers[0].status, "executed")
    assert.equal(step3.reviewers[1].status, "executed")
    assert.equal(step3.reviewers[2].status, "executed")
  })

  it("should throw for unknown reviewer", () => {
    const m = createManifest("code-review", "standard", ["correctness"])

    assert.throws(
      () => recordExecuted(m, "nonexistent"),
      /Unknown reviewer "nonexistent"/,
    )
  })

  it("should preserve skipped/failed reviewers when marking executed", () => {
    const m = createManifest("code-review", "standard", [
      "correctness",
      "integration",
    ])

    const withSkipped = recordSkipped(m, "integration", "not needed")
    const withExecuted = recordExecuted(withSkipped, "correctness")

    assert.equal(withExecuted.reviewers[0].status, "executed")
    assert.equal(withExecuted.reviewers[1].status, "skipped")
    assert.equal(withExecuted.skippedReviewers.length, 1)
  })
})

// ── recordSkipped ──────────────────────────────────────────────

void describe("recordSkipped", () => {
  it("should mark a reviewer as skipped with a reason", () => {
    const m = createManifest("code-review", "standard", [
      "correctness",
      "integration",
      "security",
    ])

    const updated = recordSkipped(m, "security", "lane unavailable")

    assert.equal(updated.reviewers[2].status, "skipped")
    assert.equal(updated.reviewers[2].detail, "lane unavailable")
    assert.equal(updated.skippedReviewers.length, 1)
    assert.equal(updated.skippedReviewers[0].name, "security")
    assert.equal(updated.skippedReviewers[0].reason, "lane unavailable")

    // Original is not mutated
    assert.equal(m.reviewers[2].status, "requested")
    assert.equal(m.skippedReviewers.length, 0)
  })

  it("should support multiple skipped reviewers", () => {
    const m = createManifest("code-review", "standard", [
      "correctness",
      "integration",
      "security",
      "logic",
    ])

    const step1 = recordSkipped(m, "logic", "tier does not include logic")
    const step2 = recordSkipped(step1, "security", "lane unavailable")

    assert.equal(step2.skippedReviewers.length, 2)
    assert.equal(step2.skippedReviewers[0].name, "logic")
    assert.equal(step2.skippedReviewers[1].name, "security")
  })

  it("should throw for unknown reviewer", () => {
    const m = createManifest("code-review", "standard", ["correctness"])

    assert.throws(
      () => recordSkipped(m, "unknown", "reason"),
      /Unknown reviewer "unknown"/,
    )
  })
})

// ── recordFailed ───────────────────────────────────────────────

void describe("recordFailed", () => {
  it("should mark a reviewer as failed with an error", () => {
    const m = createManifest("code-review", "standard", [
      "correctness",
      "integration",
    ])

    const updated = recordFailed(m, "correctness", "Timeout after 30s")

    assert.equal(updated.reviewers[0].status, "failed")
    assert.equal(updated.reviewers[0].detail, "Timeout after 30s")
    assert.equal(updated.failedReviewers.length, 1)
    assert.equal(updated.failedReviewers[0].name, "correctness")
    assert.equal(updated.failedReviewers[0].error, "Timeout after 30s")

    // Original is not mutated
    assert.equal(m.reviewers[0].status, "requested")
    assert.equal(m.failedReviewers.length, 0)
  })

  it("should support multiple failed reviewers", () => {
    const m = createManifest("code-review", "standard", [
      "correctness",
      "integration",
      "security",
    ])

    const step1 = recordFailed(m, "correctness", "model unavailable")
    const step2 = recordFailed(step1, "integration", "parse error")

    assert.equal(step2.failedReviewers.length, 2)
    assert.equal(step2.failedReviewers[0].name, "correctness")
    assert.equal(step2.failedReviewers[1].name, "integration")
  })

  it("should throw for unknown reviewer", () => {
    const m = createManifest("code-review", "standard", ["correctness"])

    assert.throws(
      () => recordFailed(m, "unknown", "error"),
      /Unknown reviewer "unknown"/,
    )
  })
})

// ── getCoverageSummary ─────────────────────────────────────────

void describe("getCoverageSummary", () => {
  it("should show all requested when no reviewers have been dispatched", () => {
    const m = createManifest("code-review", "standard", [
      "correctness",
      "integration",
      "security",
    ])

    const summary = getCoverageSummary(m)
    assert.equal(summary.total, 3)
    assert.equal(summary.executed, 0)
    assert.equal(summary.skipped, 0)
    assert.equal(summary.failed, 0)
    assert.equal(summary.complete, false)
  })

  it("should show executed count correctly", () => {
    const m = createManifest("code-review", "standard", [
      "correctness",
      "integration",
      "security",
    ])

    const step1 = recordExecuted(m, "correctness")
    const step2 = recordExecuted(step1, "security")

    const summary = getCoverageSummary(step2)
    assert.equal(summary.total, 3)
    assert.equal(summary.executed, 2)
    assert.equal(summary.skipped, 0)
    assert.equal(summary.failed, 0)
    assert.equal(summary.complete, false)
  })

  it("should show mixed states correctly", () => {
    const m = createManifest("code-review", "standard", [
      "correctness",
      "integration",
      "security",
      "logic",
    ])

    const step1 = recordExecuted(m, "correctness")
    const step2 = recordExecuted(step1, "integration")
    const step3 = recordSkipped(step2, "logic", "tier does not require")
    const step4 = recordFailed(step3, "security", "timeout")

    const summary = getCoverageSummary(step4)
    assert.equal(summary.total, 4)
    assert.equal(summary.executed, 2)
    assert.equal(summary.skipped, 1)
    assert.equal(summary.failed, 1)
    assert.equal(summary.complete, true)
  })

  it("should be complete when all reviewers have finished", () => {
    const m = createManifest("code-review", "standard", [
      "correctness",
      "integration",
    ])

    const s1 = recordExecuted(m, "correctness")
    const s2 = recordExecuted(s1, "integration")

    assert.equal(getCoverageSummary(s2).complete, true)
  })

  it("should be complete with skipped reviewers", () => {
    const m = createManifest("code-review", "standard", [
      "correctness",
      "integration",
      "security",
    ])

    const s1 = recordExecuted(m, "correctness")
    const s2 = recordExecuted(s1, "integration")
    const s3 = recordSkipped(s2, "security", "unavailable")

    assert.equal(getCoverageSummary(s3).complete, true)
  })

  it("should be complete with failed reviewers", () => {
    const m = createManifest("code-review", "standard", [
      "correctness",
      "integration",
    ])

    const s1 = recordExecuted(m, "correctness")
    const s2 = recordFailed(s1, "integration", "crash")

    assert.equal(getCoverageSummary(s2).complete, true)
  })

  it("should handle empty manifest", () => {
    const m = createManifest("code-review", "standard", [])

    const summary = getCoverageSummary(m)
    assert.equal(summary.total, 0)
    assert.equal(summary.executed, 0)
    assert.equal(summary.skipped, 0)
    assert.equal(summary.failed, 0)
    assert.equal(summary.complete, true)
  })
})

// ── isComplete ─────────────────────────────────────────────────

void describe("isComplete", () => {
  it("should return false when reviewers are still requested", () => {
    const m = createManifest("code-review", "standard", ["correctness"])
    assert.equal(isComplete(m), false)
  })

  it("should return true when all reviewers executed", () => {
    const m = createManifest("code-review", "standard", ["correctness"])
    const updated = recordExecuted(m, "correctness")
    assert.equal(isComplete(updated), true)
  })

  it("should return true when all reviewers skipped", () => {
    const m = createManifest("code-review", "standard", ["correctness"])
    const updated = recordSkipped(m, "correctness", "not needed")
    assert.equal(isComplete(updated), true)
  })

  it("should return true when all reviewers failed", () => {
    const m = createManifest("code-review", "standard", ["correctness"])
    const updated = recordFailed(m, "correctness", "error")
    assert.equal(isComplete(updated), true)
  })

  it("should return false when some reviewers are still requested", () => {
    const m = createManifest("code-review", "standard", [
      "correctness",
      "integration",
    ])
    const updated = recordExecuted(m, "correctness")
    assert.equal(isComplete(updated), false)
  })
})

// ── getActiveReviewers ─────────────────────────────────────────

void describe("getActiveReviewers", () => {
  it("should return empty array when no reviewers executed", () => {
    const m = createManifest("code-review", "standard", ["correctness"])
    assert.deepEqual(getActiveReviewers(m), [])
  })

  it("should return names of executed reviewers", () => {
    const m = createManifest("code-review", "standard", [
      "correctness",
      "integration",
      "security",
    ])

    const s1 = recordExecuted(m, "correctness")
    const s2 = recordExecuted(s1, "security")

    const active = getActiveReviewers(s2)
    assert.equal(active.length, 2)
    assert.ok(active.includes("correctness"))
    assert.ok(active.includes("security"))
    assert.ok(!active.includes("integration"))
  })

  it("should not include skipped or failed reviewers", () => {
    const m = createManifest("code-review", "standard", [
      "correctness",
      "integration",
      "security",
    ])

    const s1 = recordExecuted(m, "correctness")
    const s2 = recordSkipped(s1, "integration", "unavailable")
    const s3 = recordFailed(s2, "security", "timeout")

    assert.deepEqual(getActiveReviewers(s3), ["correctness"])
  })
})

// ── getInactiveReviewers ───────────────────────────────────────

void describe("getInactiveReviewers", () => {
  it("should return all reviewers when none executed", () => {
    const m = createManifest("code-review", "standard", [
      "correctness",
      "integration",
    ])

    const inactive = getInactiveReviewers(m)
    assert.equal(inactive.length, 2)
    assert.ok(inactive.includes("correctness"))
    assert.ok(inactive.includes("integration"))
  })

  it("should return only non-executed reviewers", () => {
    const m = createManifest("code-review", "standard", [
      "correctness",
      "integration",
      "security",
    ])

    const s1 = recordExecuted(m, "correctness")
    const s2 = recordSkipped(s1, "integration", "unavailable")

    const inactive = getInactiveReviewers(s2)
    assert.equal(inactive.length, 2)
    assert.ok(inactive.includes("integration"))
    assert.ok(inactive.includes("security"))
    assert.ok(!inactive.includes("correctness"))
  })
})

// ── getReviewersByStatus ───────────────────────────────────────

void describe("getReviewersByStatus", () => {
  it("should return reviewers filtered by status", () => {
    const m = createManifest("code-review", "standard", [
      "correctness",
      "integration",
      "security",
      "logic",
    ])

    const s1 = recordExecuted(m, "correctness")
    const s2 = recordExecuted(s1, "integration")
    const s3 = recordSkipped(s2, "logic", "tier")
    const s4 = recordFailed(s3, "security", "error")

    assert.deepEqual(getReviewersByStatus(s4, "executed"), [
      "correctness",
      "integration",
    ])
    assert.deepEqual(getReviewersByStatus(s4, "skipped"), ["logic"])
    assert.deepEqual(getReviewersByStatus(s4, "failed"), ["security"])
    assert.deepEqual(getReviewersByStatus(s4, "requested"), [])
  })

  it("should return empty array when no reviewers match status", () => {
    const m = createManifest("code-review", "standard", ["correctness"])
    assert.deepEqual(getReviewersByStatus(m, "failed"), [])
  })
})

// ── Plan-review mode with tier rules ────────────────────────────

void describe("plan-review tier scenarios", () => {
  it("should handle system tier plan review", () => {
    // System tier plan review: correctness + integration + feasibility
    const m = createManifest("plan-review", "system", [
      "correctness",
      "integration",
      "feasibility",
    ])

    const s1 = recordExecuted(m, "correctness")
    const s2 = recordExecuted(s1, "integration")
    const s3 = recordExecuted(s2, "feasibility")

    const summary = getCoverageSummary(s3)
    assert.equal(summary.total, 3)
    assert.equal(summary.executed, 3)
    assert.equal(summary.complete, true)
  })

  it("should handle logic tier plan review with skipped feasibility", () => {
    // Logic tier requests all three but feasibility may be skipped
    const m = createManifest("plan-review", "logic", [
      "correctness",
      "integration",
      "feasibility",
      "logic",
    ])

    const s1 = recordExecuted(m, "correctness")
    const s2 = recordExecuted(s1, "integration")
    const s3 = recordSkipped(s2, "feasibility", "lane unavailable")
    const s4 = recordExecuted(s3, "logic")

    const summary = getCoverageSummary(s4)
    assert.equal(summary.total, 4)
    assert.equal(summary.executed, 3)
    assert.equal(summary.skipped, 1)
    assert.equal(summary.complete, true)
  })

  it("should handle full logic,system tier with all reviewers", () => {
    const m = createManifest("plan-review", "logic,system", [
      "correctness",
      "integration",
      "feasibility",
      "logic",
    ])

    const s1 = recordExecuted(m, "correctness")
    const s2 = recordExecuted(s1, "integration")
    const s3 = recordExecuted(s2, "feasibility")
    const s4 = recordExecuted(s3, "logic")

    const summary = getCoverageSummary(s4)
    assert.equal(summary.total, 4)
    assert.equal(summary.executed, 4)
    assert.equal(summary.complete, true)
  })
})

// ── Synthesizer scenario ───────────────────────────────────────

void describe("synthesizer consumption scenario", () => {
  it("should carry enough data for synthesizer reasoning", () => {
    // Simulate a code-review run that the synthesizer would consume
    const m = createManifest("code-review", "standard", [
      "correctness",
      "integration",
      "security",
      "logic",
    ])

    const s1 = recordExecuted(m, "correctness")
    const s2 = recordExecuted(s1, "integration")
    const s3 = recordExecuted(s2, "security")
    const s4 = recordSkipped(s3, "logic", "lane unavailable")

    // The synthesizer can reason over:
    // 1. Which reviewers were requested
    // 2. Which reviewers actually ran
    // 3. Which were skipped and why
    // 4. Coverage gaps
    const summary = getCoverageSummary(s4)
    const active = getActiveReviewers(s4)

    assert.equal(summary.total, 4)
    assert.equal(summary.executed, 3)
    assert.equal(summary.skipped, 1)
    assert.equal(summary.failed, 0)
    assert.ok(active.includes("correctness"))
    assert.ok(active.includes("integration"))
    assert.ok(active.includes("security"))
    assert.ok(!active.includes("logic"))
    assert.equal(s4.skippedReviewers.length, 1)
    assert.equal(s4.skippedReviewers[0].name, "logic")
    assert.equal(s4.skippedReviewers[0].reason, "lane unavailable")
  })
})
