/**
 * manifest-helpers.test.ts — Tests for findings.ts manifest helpers.
 *
 * Covers:
 *   - getReviewerNamesForPlanTier for all valid tiers
 *   - getReviewerNamesForCodeTier for all valid tiers
 *   - Invalid tier throws
 *   - buildManifestFromTier for both modes
 *   - createReviewManifest with default and custom reviewers
 *   - resolveTier validation
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  getReviewerNamesForPlanTier,
  getReviewerNamesForCodeTier,
  buildManifestFromTier,
  resolveTier,
  choosePlanReviewTier,
  collectReviewTags,
} from "../extensions/zflow-review/findings.js"

import { createReviewManifest } from "../extensions/zflow-review/index.js"

import { createManifest, getCoverageSummary } from "../src/reviewer-manifest.js"

// ── getReviewerNamesForPlanTier ────────────────────────────────

void describe("getReviewerNamesForPlanTier", () => {
  it("should return [correctness, integration] for standard tier", () => {
    const names = getReviewerNamesForPlanTier("standard")
    assert.deepEqual(names, ["correctness", "integration"])
  })

  it("should return [correctness, integration] for logic tier", () => {
    const names = getReviewerNamesForPlanTier("logic")
    assert.deepEqual(names, ["correctness", "integration"])
  })

  it("should return [correctness, integration, feasibility] for system tier", () => {
    const names = getReviewerNamesForPlanTier("system")
    assert.deepEqual(names, ["correctness", "integration", "feasibility"])
  })

  it("should return [correctness, integration, feasibility] for logic,system tier", () => {
    const names = getReviewerNamesForPlanTier("logic,system")
    assert.deepEqual(names, ["correctness", "integration", "feasibility"])
  })

  it("should throw for unknown tier", () => {
    assert.throws(
      () => getReviewerNamesForPlanTier("invalid-tier"),
      /unknown plan-review tier/i,
    )
  })

  it("should return a fresh copy each call", () => {
    const a = getReviewerNamesForPlanTier("standard")
    const b = getReviewerNamesForPlanTier("standard")
    assert.deepEqual(a, b)
    assert.notStrictEqual(a, b) // different arrays
  })
})

// ── getReviewerNamesForCodeTier ────────────────────────────────

void describe("getReviewerNamesForCodeTier", () => {
  it("should return core reviewers for standard tier", () => {
    const names = getReviewerNamesForCodeTier("standard")
    assert.deepEqual(names, ["correctness", "integration", "security"])
  })

  it("should include logic for +logic tier", () => {
    const names = getReviewerNamesForCodeTier("+logic")
    assert.deepEqual(names, [
      "correctness",
      "integration",
      "security",
      "logic",
    ])
  })

  it("should include system for +system tier", () => {
    const names = getReviewerNamesForCodeTier("+system")
    assert.deepEqual(names, [
      "correctness",
      "integration",
      "security",
      "system",
    ])
  })

  it("should include logic and system for +full tier", () => {
    const names = getReviewerNamesForCodeTier("+full")
    assert.deepEqual(names, [
      "correctness",
      "integration",
      "security",
      "logic",
      "system",
    ])
  })

  it("should throw for unknown tier", () => {
    assert.throws(
      () => getReviewerNamesForCodeTier("invalid"),
      /unknown code-review tier/i,
    )
  })

  it("should return a fresh copy each call", () => {
    const a = getReviewerNamesForCodeTier("standard")
    const b = getReviewerNamesForCodeTier("standard")
    assert.deepEqual(a, b)
    assert.notStrictEqual(a, b)
  })
})

// ── resolveTier ────────────────────────────────────────────────

void describe("resolveTier", () => {
  it("should return the tier string for valid plan-review tier", () => {
    assert.equal(resolveTier("plan-review", "standard"), "standard")
    assert.equal(resolveTier("plan-review", "logic"), "logic")
    assert.equal(resolveTier("plan-review", "system"), "system")
    assert.equal(resolveTier("plan-review", "logic,system"), "logic,system")
  })

  it("should return the tier string for valid code-review tier", () => {
    assert.equal(resolveTier("code-review", "standard"), "standard")
    assert.equal(resolveTier("code-review", "+logic"), "+logic")
    assert.equal(resolveTier("code-review", "+system"), "+system")
    assert.equal(resolveTier("code-review", "+full"), "+full")
  })

  it("should throw for invalid tier", () => {
    assert.throws(() => resolveTier("plan-review", "invalid"), /unknown plan-review tier/i)
    assert.throws(() => resolveTier("code-review", "invalid"), /unknown code-review tier/i)
  })
})

// ── buildManifestFromTier ──────────────────────────────────────

void describe("buildManifestFromTier", () => {
  it("should build a plan-review manifest with correct tier reviewers", () => {
    const m = buildManifestFromTier("plan-review", "system")

    assert.equal(m.mode, "plan-review")
    assert.equal(m.tier, "system")
    assert.equal(m.reviewers.length, 3)
    assert.equal(m.reviewers[0].name, "correctness")
    assert.equal(m.reviewers[1].name, "integration")
    assert.equal(m.reviewers[2].name, "feasibility")

    // All start in requested state
    for (const r of m.reviewers) {
      assert.equal(r.status, "requested")
    }
  })

  it("should build a code-review manifest with correct tier reviewers", () => {
    const m = buildManifestFromTier("code-review", "+full")

    assert.equal(m.mode, "code-review")
    assert.equal(m.tier, "+full")
    assert.equal(m.reviewers.length, 5)
    assert.equal(m.reviewers[0].name, "correctness")
    assert.equal(m.reviewers[1].name, "integration")
    assert.equal(m.reviewers[2].name, "security")
    assert.equal(m.reviewers[3].name, "logic")
    assert.equal(m.reviewers[4].name, "system")
  })

  it("should build a standard code-review manifest with exactly 3 reviewers", () => {
    const m = buildManifestFromTier("code-review", "standard")
    assert.equal(m.reviewers.length, 3)
    assert.equal(m.reviewers[0].name, "correctness")
    assert.equal(m.reviewers[1].name, "integration")
    assert.equal(m.reviewers[2].name, "security")
  })

  it("should work with standard plan-review tier", () => {
    const m = buildManifestFromTier("plan-review", "standard")
    assert.equal(m.reviewers.length, 2)
  })

  it("should generate unique runIds across calls", () => {
    const a = buildManifestFromTier("code-review", "standard")
    const b = buildManifestFromTier("code-review", "standard")
    assert.notEqual(a.runId, b.runId)
  })

  it("should throw for unknown plan-review tier", () => {
    assert.throws(
      () => buildManifestFromTier("plan-review", "bogus"),
      /unknown plan-review tier/i,
    )
  })

  it("should throw for unknown code-review tier", () => {
    assert.throws(
      () => buildManifestFromTier("code-review", "bogus"),
      /unknown code-review tier/i,
    )
  })
})

// ── createReviewManifest ───────────────────────────────────────

void describe("createReviewManifest", () => {
  it("should create a manifest from tier mapping when no custom reviewers", () => {
    const m = createReviewManifest("plan-review", "system")

    assert.equal(m.mode, "plan-review")
    assert.equal(m.tier, "system")
    assert.equal(m.reviewers.length, 3)
  })

  it("should use custom reviewers when provided", () => {
    const m = createReviewManifest("code-review", "standard", [
      "correctness",
      "security",
    ])

    assert.equal(m.mode, "code-review")
    assert.equal(m.tier, "standard")
    assert.equal(m.reviewers.length, 2)
    assert.equal(m.reviewers[0].name, "correctness")
    assert.equal(m.reviewers[1].name, "security")
  })

  it("should create valid coverage summary from manifest", () => {
    const m = createReviewManifest("code-review", "+full")
    const summary = getCoverageSummary(m)

    assert.equal(summary.total, 5)
    assert.equal(summary.executed, 0)
    assert.equal(summary.skipped, 0)
    assert.equal(summary.failed, 0)
    assert.equal(summary.complete, false)
  })

  it("should throw for unknown tier without custom reviewers", () => {
    assert.throws(
      () => createReviewManifest("code-review", "non-existent"),
      /unknown code-review tier/i,
    )
  })

  it("should accept unknown tier when custom reviewers are provided", () => {
    // Custom reviewers bypasses tier validation
    const m = createReviewManifest("code-review", "custom-tier", [
      "correctness",
    ])
    assert.equal(m.tier, "custom-tier")
    assert.equal(m.reviewers.length, 1)
  })
})

// ── collectReviewTags ──────────────────────────────────────────

void describe("collectReviewTags", () => {
  it("should return empty array for empty groups", () => {
    assert.deepEqual(collectReviewTags([]), [])
  })

  it("should return empty array when no groups have reviewTags", () => {
    const groups = [
      { name: "group-a" },
      { name: "group-b" },
    ]
    assert.deepEqual(collectReviewTags(groups), [])
  })

  it("should collect a single string tag", () => {
    const groups = [
      { reviewTags: "logic" },
    ]
    assert.deepEqual(collectReviewTags(groups), ["logic"])
  })

  it("should collect tags from array field", () => {
    const groups = [
      { reviewTags: ["logic", "system"] },
    ]
    const tags = collectReviewTags(groups)
    assert.ok(tags.includes("logic"))
    assert.ok(tags.includes("system"))
    assert.equal(tags.length, 2)
  })

  it("should deduplicate tags across groups", () => {
    const groups = [
      { reviewTags: "logic" },
      { reviewTags: ["logic", "system"] },
    ]
    const tags = collectReviewTags(groups)
    assert.equal(tags.length, 2)
    assert.ok(tags.includes("logic"))
    assert.ok(tags.includes("system"))
  })

  it("should handle mixed single and array tags", () => {
    const groups = [
      { reviewTags: "logic" },
      { reviewTags: ["system", "other"] },
    ]
    const tags = collectReviewTags(groups)
    assert.equal(tags.length, 3)
    assert.ok(tags.includes("logic"))
    assert.ok(tags.includes("system"))
    assert.ok(tags.includes("other"))
  })

  it("should handle null or undefined reviewTags gracefully", () => {
    const groups = [
      { reviewTags: "logic" },
      { reviewTags: null },
      { reviewTags: undefined },
    ]
    const tags = collectReviewTags(groups)
    assert.deepEqual(tags, ["logic"])
  })
})

// ── choosePlanReviewTier ───────────────────────────────────────

void describe("choosePlanReviewTier", () => {
  it("should return standard for empty groups", () => {
    assert.equal(choosePlanReviewTier([]), "standard")
  })

  it("should return standard when no groups have reviewTags", () => {
    const groups = [
      { name: "alpha" },
      { name: "beta" },
    ]
    assert.equal(choosePlanReviewTier(groups), "standard")
  })

  it("should return standard when tags are unrelated", () => {
    const groups = [
      { reviewTags: "other-tag" },
    ]
    assert.equal(choosePlanReviewTier(groups), "standard")
  })

  it("should return logic when only logic tag is present", () => {
    const groups = [
      { reviewTags: "logic" },
    ]
    assert.equal(choosePlanReviewTier(groups), "logic")
  })

  it("should return logic when logic tag is in an array", () => {
    const groups = [
      { reviewTags: ["logic", "other"] },
    ]
    assert.equal(choosePlanReviewTier(groups), "logic")
  })

  it("should return logic when logic appears multiple times", () => {
    const groups = [
      { reviewTags: "logic" },
      { reviewTags: ["logic", "other"] },
    ]
    assert.equal(choosePlanReviewTier(groups), "logic")
  })

  it("should return system when only system tag is present", () => {
    const groups = [
      { reviewTags: "system" },
    ]
    assert.equal(choosePlanReviewTier(groups), "system")
  })

  it("should return system when system tag appears in one of several groups", () => {
    const groups = [
      { reviewTags: "other" },
      { reviewTags: "system" },
    ]
    assert.equal(choosePlanReviewTier(groups), "system")
  })

  it("should return logic,system when both logic and system tags present in different groups", () => {
    const groups = [
      { reviewTags: "logic" },
      { reviewTags: "system" },
    ]
    assert.equal(choosePlanReviewTier(groups), "logic,system")
  })

  it("should return logic,system when both tags are in the same array", () => {
    const groups = [
      { reviewTags: ["logic", "system"] },
    ]
    assert.equal(choosePlanReviewTier(groups), "logic,system")
  })

  it("should return logic,system when logic and system appear across multiple groups and arrays", () => {
    const groups = [
      { reviewTags: ["logic", "performance"] },
      { reviewTags: ["system", "migration"] },
    ]
    assert.equal(choosePlanReviewTier(groups), "logic,system")
  })

  it("should return logic,system when all groups carry both tags", () => {
    const groups = [
      { reviewTags: ["logic", "system"] },
      { reviewTags: ["logic", "system"] },
    ]
    assert.equal(choosePlanReviewTier(groups), "logic,system")
  })
})
