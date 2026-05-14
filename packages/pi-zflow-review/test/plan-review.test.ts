/**
 * plan-review.test.ts — Tests for plan-review execution flow and gating.
 *
 * Covers:
 *   - runPlanReview: standard tier, logic tier, system tier
 *   - Gating: critical → revise-plan, major → revise-plan, minor/nit → approve
 *   - Validation failure → revise-plan
 *   - Manifest state: executed, skipped, failed reviewers
 *   - evaluateGating edge cases
 *   - incrementVersion edge cases
 *   - synthesiseFindings deduplication
 *   - persistPlanReviewFindings writes correct content
 *   - Findings file path matches expected pattern
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"

import {
  runPlanReview,
  evaluateGating,
  incrementVersion,
  synthesiseFindings,
  defaultReviewerRunner,
  persistPlanReviewFindings,
  isRequiredReviewer,
  runReviewerWithRetry,
  DEFAULT_RETRY_POLICY,
} from "../extensions/zflow-review/plan-review.js"

import type {
  PlanReviewInput,
  ReviewerRunner,
  ReviewerContext,
  ReviewerOutput,
  Finding,
  RetryPolicy,
} from "../extensions/zflow-review/plan-review.js"

import {
  getCoverageSummary,
  createManifest,
} from "../src/reviewer-manifest.js"

// ── Temporary directory for persistence tests ──────────────────

let tmpDir: string

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-review-test-"))
})

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

// ── Helper: build a minimal PlanReviewInput ────────────────────

function makeInput(
  overrides: Partial<PlanReviewInput> & {
    executionGroups?: Array<{ reviewTags?: string | string[] }>
  } = {},
): PlanReviewInput {
  return {
    changeId: "test-change",
    planVersion: "1",
    executionGroups: overrides.executionGroups ?? [],
    planningArtifacts: {
      design: "/fake/design.md",
      executionGroups: "/fake/execution-groups.md",
      standards: "/fake/standards.md",
      verification: "/fake/verification.md",
    },
    ...overrides,
  }
}

// ── Helper: reviewer runner that produces specific findings ────

function makeRunner(
  findings: Finding[],
  rawOutput = "",
): ReviewerRunner {
  return async (
    _name: string,
    _context: ReviewerContext,
  ): Promise<ReviewerOutput> => ({
    findings,
    rawOutput,
  })
}

// ── evaluateGating ─────────────────────────────────────────────

void describe("evaluateGating", () => {
  it("should approve when no findings", () => {
    assert.equal(
      evaluateGating({ critical: 0, major: 0, minor: 0, nit: 0 }),
      "approve",
    )
  })

  it("should approve when only minor findings", () => {
    assert.equal(
      evaluateGating({ critical: 0, major: 0, minor: 2, nit: 0 }),
      "approve",
    )
  })

  it("should approve when only nit findings", () => {
    assert.equal(
      evaluateGating({ critical: 0, major: 0, minor: 0, nit: 1 }),
      "approve",
    )
  })

  it("should approve minor + nit together", () => {
    assert.equal(
      evaluateGating({ critical: 0, major: 0, minor: 1, nit: 3 }),
      "approve",
    )
  })

  it("should require revision when critical findings exist", () => {
    assert.equal(
      evaluateGating({ critical: 1, major: 0, minor: 0, nit: 0 }),
      "revise-plan",
    )
  })

  it("should require revision when major findings exist", () => {
    assert.equal(
      evaluateGating({ critical: 0, major: 1, minor: 0, nit: 0 }),
      "revise-plan",
    )
  })

  it("should require revision when both critical and major exist", () => {
    assert.equal(
      evaluateGating({ critical: 2, major: 3, minor: 1, nit: 0 }),
      "revise-plan",
    )
  })

  it("should require revision when critical exists alongside minor", () => {
    assert.equal(
      evaluateGating({ critical: 1, major: 0, minor: 5, nit: 2 }),
      "revise-plan",
    )
  })
})

// ── incrementVersion ───────────────────────────────────────────

void describe("incrementVersion", () => {
  it("should increment numeric version: 1 → 2", () => {
    assert.equal(incrementVersion("1"), "2")
  })

  it("should increment v-prefixed version: v1 → v2", () => {
    assert.equal(incrementVersion("v1"), "v2")
  })

  it("should increment v-prefixed version: v3 → v4", () => {
    assert.equal(incrementVersion("v3"), "v4")
  })

  it("should handle non-numeric gracefully: abc → 2", () => {
    const result = incrementVersion("abc")
    assert.equal(result, "2")
  })

  it("should handle zero: 0 → 1", () => {
    assert.equal(incrementVersion("0"), "1")
  })

  it("should handle v0 → v1", () => {
    assert.equal(incrementVersion("v0"), "v1")
  })
})

// ── synthesiseFindings ─────────────────────────────────────────

void describe("synthesiseFindings", () => {
  it("should return empty severity when no findings", () => {
    const result = synthesiseFindings(
      [],
      { total: 0, executed: 0, skipped: 0, failed: 0, complete: true },
      "standard",
    )
    assert.deepEqual(result.severity, {
      critical: 0,
      major: 0,
      minor: 0,
      nit: 0,
    })
    assert.equal(result.entries.length, 0)
  })

  it("should count severity correctly", () => {
    const allFindings = [
      { reviewerName: "correctness", finding: { severity: "critical" as const, title: "C1", description: "Critical issue" } },
      { reviewerName: "integration", finding: { severity: "major" as const, title: "M1", description: "Major issue" } },
      { reviewerName: "correctness", finding: { severity: "minor" as const, title: "m1", description: "Minor issue" } },
      { reviewerName: "integration", finding: { severity: "nit" as const, title: "n1", description: "Nit" } },
    ]

    const result = synthesiseFindings(
      allFindings,
      { total: 2, executed: 2, skipped: 0, failed: 0, complete: true },
      "logic",
    )

    assert.equal(result.severity.critical, 1)
    assert.equal(result.severity.major, 1)
    assert.equal(result.severity.minor, 1)
    assert.equal(result.severity.nit, 1)
    assert.equal(result.entries.length, 4)
  })

  it("should deduplicate findings with same title", () => {
    const allFindings = [
      { reviewerName: "correctness", finding: { severity: "critical" as const, title: "Missing guard", description: "Critical: no null check" } },
      { reviewerName: "integration", finding: { severity: "major" as const, title: "Missing guard", description: "Major: null check missing" } },
    ]

    const result = synthesiseFindings(
      allFindings,
      { total: 2, executed: 2, skipped: 0, failed: 0, complete: true },
      "logic",
    )

    // Deduplicated to one entry with higher severity
    assert.equal(result.entries.length, 1)
    assert.equal(result.severity.critical, 1)
    assert.equal(result.severity.major, 0)
    assert.equal(result.entries[0].reviewers.length, 2)
    assert.ok(result.entries[0].reviewers.includes("correctness"))
    assert.ok(result.entries[0].reviewers.includes("integration"))
  })

  it("should keep findings with different titles separate", () => {
    const allFindings = [
      { reviewerName: "correctness", finding: { severity: "critical" as const, title: "Null guard", description: "Missing null guard" } },
      { reviewerName: "integration", finding: { severity: "major" as const, title: "API contract", description: "API contract mismatch" } },
    ]

    const result = synthesiseFindings(
      allFindings,
      { total: 2, executed: 2, skipped: 0, failed: 0, complete: true },
      "logic",
    )

    assert.equal(result.entries.length, 2)
    assert.equal(result.severity.critical, 1)
    assert.equal(result.severity.major, 1)
  })

  it("should preserve evidence in deduplicated entry", () => {
    const allFindings = [
      {
        reviewerName: "correctness",
        finding: { severity: "critical" as const, title: "Same issue", description: "desc", evidence: "evidence from correctness" },
      },
      {
        reviewerName: "integration",
        finding: { severity: "major" as const, title: "Same issue", description: "desc" },
      },
    ]

    const result = synthesiseFindings(
      allFindings,
      { total: 2, executed: 2, skipped: 0, failed: 0, complete: true },
      "system",
    )

    assert.equal(result.entries.length, 1)
    // Should keep the evidence from the first occurrence (correctness)
    assert.equal(result.entries[0].evidence, "evidence from correctness")
  })
})

// ── runPlanReview — standard tier ──────────────────────────────

void describe("runPlanReview — standard tier", () => {
  it("should approve without running any reviewers", async () => {
    const input = makeInput({
      executionGroups: [{ reviewTags: "standard" }],
    })

    const result = await runPlanReview(input)

    assert.equal(result.tier, "standard")
    assert.equal(result.action, "approve")
    assert.deepEqual(result.severity, {
      critical: 0,
      major: 0,
      minor: 0,
      nit: 0,
    })
    assert.ok(result.findingsPath.includes("plan-review-findings.md"))
    assert.ok(
      result.coverageNotes.some((n) => n.includes("skipped")),
    )
  })

  it("should create a manifest for standard tier", async () => {
    const input = makeInput({
      executionGroups: [{ reviewTags: "standard" }],
    })

    const result = await runPlanReview(input)

    assert.equal(result.manifest.mode, "plan-review")
    assert.equal(result.manifest.tier, "standard")
    assert.equal(result.manifest.reviewers.length, 2)
  })

  it("should not call reviewerRunner for standard tier", async () => {
    let called = false
    const runner: ReviewerRunner = async () => {
      called = true
      return { findings: [], rawOutput: "" }
    }

    const input = makeInput({
      executionGroups: [{ reviewTags: "standard" }],
    })

    await runPlanReview(input, runner)
    assert.equal(called, false, "reviewer runner should not be called for standard tier")
  })
})

// ── runPlanReview — logic tier ─────────────────────────────────

void describe("runPlanReview — logic tier", () => {
  it("should run correctness + integration reviewers", async () => {
    const executed: string[] = []
    const runner: ReviewerRunner = async (name) => {
      executed.push(name)
      return { findings: [], rawOutput: "" }
    }

    const input = makeInput({
      executionGroups: [{ reviewTags: "logic" }],
    })

    const result = await runPlanReview(input, runner)

    assert.equal(result.tier, "logic")
    assert.equal(result.action, "approve")

    // Manifest should have correctness + integration
    const names = result.manifest.reviewers.map((r) => r.name)
    assert.ok(names.includes("correctness"))
    assert.ok(names.includes("integration"))

    // Both reviewers should have been called
    assert.ok(executed.includes("correctness"))
    assert.ok(executed.includes("integration"))
  })

  it("should record both reviewers as executed on success", async () => {
    const input = makeInput({
      executionGroups: [{ reviewTags: "logic" }],
    })

    const result = await runPlanReview(input)

    for (const r of result.manifest.reviewers) {
      assert.equal(r.status, "executed")
    }
  })
})

// ── runPlanReview — system tier ────────────────────────────────

void describe("runPlanReview — system tier", () => {
  it("should include feasibility reviewer", async () => {
    const executed: string[] = []
    const runner: ReviewerRunner = async (name) => {
      executed.push(name)
      return { findings: [], rawOutput: "" }
    }

    const input = makeInput({
      executionGroups: [{ reviewTags: "system" }],
    })

    const result = await runPlanReview(input, runner)

    assert.equal(result.tier, "system")
    assert.equal(result.manifest.reviewers.length, 3)

    const names = result.manifest.reviewers.map((r) => r.name)
    assert.ok(names.includes("correctness"))
    assert.ok(names.includes("integration"))
    assert.ok(names.includes("feasibility"))

    assert.ok(executed.includes("feasibility"))
  })
})

// ── runPlanReview — logic,system tier ──────────────────────────

void describe("runPlanReview — logic,system tier", () => {
  it("should include all reviewers", async () => {
    const input = makeInput({
      executionGroups: [
        { reviewTags: "logic" },
        { reviewTags: "system" },
      ],
    })

    const runner: ReviewerRunner = async () => ({ findings: [], rawOutput: "" })

    const result = await runPlanReview(input, runner)

    assert.equal(result.tier, "logic,system")
    assert.equal(result.manifest.reviewers.length, 3)
    assert.ok(result.manifest.reviewers.every((r) => r.status === "executed"))
  })
})

// ── runPlanReview — validation failure ─────────────────────────

void describe("runPlanReview — validation failure", () => {
  it("should return revise-plan when validation fails", async () => {
    const input = makeInput({
      executionGroups: [{ reviewTags: "logic" }],
      validationPassed: false,
    })

    const result = await runPlanReview(input)

    assert.equal(result.action, "revise-plan")
    assert.ok(result.nextVersion)
    assert.deepEqual(result.severity, {
      critical: 0,
      major: 0,
      minor: 0,
      nit: 0,
    })
  })

  it("should set nextVersion on validation failure", async () => {
    const input = makeInput({
      planVersion: "v1",
      executionGroups: [],
      validationPassed: false,
    })

    const result = await runPlanReview(input)
    assert.equal(result.action, "revise-plan")
    assert.equal(result.nextVersion, "v2")
  })

  it("should include coverage note about validation failure", async () => {
    const input = makeInput({
      executionGroups: [],
      validationPassed: false,
    })

    const result = await runPlanReview(input)
    assert.ok(
      result.coverageNotes.some((n) => n.includes("validation")),
    )
  })
})

// ── runPlanReview — gating ─────────────────────────────────────

void describe("runPlanReview — gating", () => {
  it("should approve when no findings raised", async () => {
    const input = makeInput({
      executionGroups: [{ reviewTags: "logic" }],
    })

    const result = await runPlanReview(input)
    assert.equal(result.action, "approve")
  })

  it("should approve when only minor findings raised", async () => {
    const runner = makeRunner([
      { severity: "minor", title: "Style nit", description: "Minor formatting" },
    ])

    const input = makeInput({
      executionGroups: [{ reviewTags: "logic" }],
    })

    const result = await runPlanReview(input, runner)
    assert.equal(result.action, "approve")
    assert.equal(result.severity.minor, 1)
  })

  it("should approve when only nit findings raised", async () => {
    const runner = makeRunner([
      { severity: "nit", title: "Typo", description: "Comment typo" },
    ])

    const input = makeInput({
      executionGroups: [{ reviewTags: "logic" }],
    })

    const result = await runPlanReview(input, runner)
    assert.equal(result.action, "approve")
    assert.equal(result.severity.nit, 1)
  })

  it("should require revision with critical findings", async () => {
    const runner = makeRunner([
      { severity: "critical", title: "Security hole", description: "Critical security issue" },
    ])

    const input = makeInput({
      executionGroups: [{ reviewTags: "logic" }],
    })

    const result = await runPlanReview(input, runner)
    assert.equal(result.action, "revise-plan")
    assert.equal(result.severity.critical, 1)
  })

  it("should require revision with major findings", async () => {
    const runner = makeRunner([
      { severity: "major", title: "Design flaw", description: "Major design issue" },
    ])

    const input = makeInput({
      executionGroups: [{ reviewTags: "logic" }],
    })

    const result = await runPlanReview(input, runner)
    assert.equal(result.action, "revise-plan")
    assert.equal(result.severity.major, 1)
  })

  it("should require revision with mixed critical and minor findings", async () => {
    const runner = makeRunner([
      { severity: "critical", title: "Security", description: "Critical" },
      { severity: "minor", title: "Style", description: "Minor" },
    ])

    const input = makeInput({
      executionGroups: [{ reviewTags: "logic" }],
    })

    const result = await runPlanReview(input, runner)
    assert.equal(result.action, "revise-plan")
    assert.equal(result.severity.critical, 1)
    assert.equal(result.severity.minor, 1)
  })

  it("should suggest nextVersion on revise-plan", async () => {
    const runner = makeRunner([
      { severity: "critical", title: "Blocker", description: "Blocking issue" },
    ])

    const input = makeInput({
      planVersion: "v3",
      executionGroups: [{ reviewTags: "logic" }],
    })

    const result = await runPlanReview(input, runner)
    assert.equal(result.action, "revise-plan")
    assert.equal(result.nextVersion, "v4")
  })
})

// ── runPlanReview — manifest state with reviewer failures ──────

void describe("runPlanReview — reviewer failures", () => {
  it("should record failed reviewers in manifest", async () => {
    const runner: ReviewerRunner = async (name) => {
      if (name === "correctness") {
        throw new Error("correctness: lane unavailable")
      }
      return { findings: [], rawOutput: "" }
    }

    const input = makeInput({
      executionGroups: [{ reviewTags: "logic" }],
    })

    const result = await runPlanReview(input, runner)

    const correctness = result.manifest.reviewers.find(
      (r) => r.name === "correctness",
    )
    assert.equal(correctness?.status, "failed")

    const integration = result.manifest.reviewers.find(
      (r) => r.name === "integration",
    )
    assert.equal(integration?.status, "executed")

    assert.equal(result.manifest.failedReviewers.length, 1)
    assert.equal(result.manifest.failedReviewers[0].name, "correctness")
  })

  it("should return needs-zeb when required reviewer fails", async () => {
    const runner: ReviewerRunner = async (name) => {
      if (name === "correctness") {
        throw new Error("correctness: crashed")
      }
      return { findings: [], rawOutput: "" }
    }

    const input = makeInput({
      executionGroups: [{ reviewTags: "logic" }],
    })

    const result = await runPlanReview(input, runner)
    assert.equal(result.action, "needs-zeb")
    assert.ok(result.needsZebReason?.includes("correctness"), "should mention the failed reviewer")
  })

  it("should still approve when optional (feasibility) reviewer fails with no findings", async () => {
    const runner: ReviewerRunner = async (name) => {
      if (name === "feasibility") {
        throw new Error("feasibility: not available")
      }
      return { findings: [], rawOutput: "" }
    }

    const input = makeInput({
      executionGroups: [{ reviewTags: "system" }],
    })

    const result = await runPlanReview(input, runner)
    assert.equal(result.action, "approve")
    // feasibility is optional, so plan can still be approved
    assert.ok(result.coverageNotes.some(n => n.includes("feasibility")))
  })
})

// ── runPlanReview — custom runner with mixed results ───────────

void describe("runPlanReview — mixed findings", () => {
  it("should aggregate findings from multiple reviewers", async () => {
    const runner: ReviewerRunner = async (name) => {
      if (name === "correctness") {
        return {
          findings: [
            { severity: "critical" as const, title: "Null guard missing", description: "Missing null check in input handling" },
          ],
          rawOutput: "correctness: found null guard issue",
        }
      }
      if (name === "integration") {
        return {
          findings: [
            { severity: "major" as const, title: "API contract mismatch", description: "Return type differs from spec" },
          ],
          rawOutput: "integration: found API mismatch",
        }
      }
      return { findings: [], rawOutput: "" }
    }

    const input = makeInput({
      executionGroups: [{ reviewTags: "logic" }],
    })

    const result = await runPlanReview(input, runner)

    assert.equal(result.severity.critical, 1)
    assert.equal(result.severity.major, 1)
    assert.equal(result.action, "revise-plan")
  })

  it("should deduplicate findings with same title across reviewers", async () => {
    const runner: ReviewerRunner = async (name) => {
      return {
        findings: [
          { severity: "critical" as const, title: "Missing input validation", description: name === "correctness" ? "No validation on input" : "Input not sanitized" },
        ],
        rawOutput: "",
      }
    }

    const input = makeInput({
      executionGroups: [{ reviewTags: "logic" }],
    })

    const result = await runPlanReview(input, runner)

    // Deduplicated: same title → one entry
    assert.equal(result.severity.critical, 1)
    assert.equal(result.action, "revise-plan")
  })
})

// ── persistPlanReviewFindings ──────────────────────────────────

void describe("persistPlanReviewFindings", () => {
  it("should write a markdown file to the expected path", async () => {
    const input = makeInput({ cwd: tmpDir })

    const manifest = createManifest("plan-review", "logic", [
      "correctness",
      "integration",
    ])

    const fp = await persistPlanReviewFindings(
      {
        tier: "logic",
        manifest,
        severity: { critical: 0, major: 0, minor: 1, nit: 0 },
        coverageNotes: ["Review completed"],
      },
      input,
    )

    // Check file exists and contains expected headers
    const content = await fs.readFile(fp, "utf-8")
    assert.ok(content.includes("# Plan Review Findings"))
    assert.ok(content.includes("APPROVE"))
    assert.ok(content.includes("Reviewer manifest"))
    assert.ok(content.includes("Severity summary"))
    assert.ok(content.includes("logic"))
  })

  it("should write REVISE-PLAN when critical findings exist", async () => {
    const input = makeInput({ cwd: tmpDir })

    const manifest = createManifest("plan-review", "system", [
      "correctness",
      "integration",
      "feasibility",
    ])

    const fp = await persistPlanReviewFindings(
      {
        tier: "system",
        manifest,
        severity: { critical: 1, major: 0, minor: 0, nit: 0 },
        coverageNotes: ["Critical security issue found"],
      },
      input,
    )

    const content = await fs.readFile(fp, "utf-8")
    assert.ok(content.includes("REVISE-PLAN"))
  })

  it("should create parent directory automatically", async () => {
    const deepDir = path.join(tmpDir, "deep", "nested")
    const input = makeInput({ cwd: deepDir })

    const manifest = createManifest("plan-review", "standard", [
      "correctness",
      "integration",
    ])

    const fp = await persistPlanReviewFindings(
      {
        tier: "standard",
        manifest,
        severity: { critical: 0, major: 0, minor: 0, nit: 0 },
        coverageNotes: [],
      },
      input,
    )

    const content = await fs.readFile(fp, "utf-8")
    assert.ok(content.includes("# Plan Review Findings"))
  })

  it("should include change ID and version in output", async () => {
    const input = makeInput({
      changeId: "feat-auth",
      planVersion: "v3",
      cwd: tmpDir,
    })

    const manifest = createManifest("plan-review", "logic", [
      "correctness",
      "integration",
    ])

    const fp = await persistPlanReviewFindings(
      {
        tier: "logic",
        manifest,
        severity: { critical: 0, major: 0, minor: 0, nit: 0 },
        coverageNotes: [],
      },
      input,
    )

    const content = await fs.readFile(fp, "utf-8")
    assert.ok(content.includes("feat-auth"))
    assert.ok(content.includes("v3"))
  })

  it("should include findings entries when provided", async () => {
    const input = makeInput({ cwd: tmpDir })

    const manifest = createManifest("plan-review", "logic", [
      "correctness",
      "integration",
    ])

    const fp = await persistPlanReviewFindings(
      {
        tier: "logic",
        manifest,
        severity: { critical: 0, major: 1, minor: 0, nit: 0 },
        coverageNotes: [],
        entries: [
          {
            severity: "major",
            title: "API contract violation",
            description: "Return type mismatch in user service",
            evidence: "src/service.ts:45",
            reviewers: ["integration"],
            dissentingReviewers: [],
          },
        ],
        rawOutputSection: "## integration\n\nFound API mismatch",
      },
      input,
    )

    const content = await fs.readFile(fp, "utf-8")
    assert.ok(content.includes("API contract violation"))
    assert.ok(content.includes("Return type mismatch"))
    assert.ok(content.includes("src/service.ts:45"))
    assert.ok(content.includes("Raw reviewer outputs"))
  })
})

// ── Findings file path pattern ─────────────────────────────────

void describe("findings file path", () => {
  it("should match expected pattern with plan version", async () => {
    const input = makeInput({
      changeId: "ch42",
      planVersion: "2",
      executionGroups: [{ reviewTags: "logic" }],
      cwd: tmpDir,
    })

    const result = await runPlanReview(input)

    assert.ok(result.findingsPath.includes("ch42"))
    assert.ok(result.findingsPath.includes("v2"))
    assert.ok(result.findingsPath.endsWith("plan-review-findings.md"))
  })

  it("should handle v-prefixed plan version correctly", async () => {
    const input = makeInput({
      changeId: "ch42",
      planVersion: "v5",
      executionGroups: [{ reviewTags: "logic" }],
      cwd: tmpDir,
    })

    const result = await runPlanReview(input)

    assert.ok(result.findingsPath.includes("v5"))
    assert.ok(result.findingsPath.endsWith("plan-review-findings.md"))
  })
})

// ── defaultReviewerRunner ──────────────────────────────────────

void describe("defaultReviewerRunner", () => {
  it("should return empty findings", async () => {
    const output = await defaultReviewerRunner("correctness", {
      planningArtifacts: {
        design: "/d.md",
        executionGroups: "/eg.md",
        standards: "/s.md",
        verification: "/v.md",
      },
      tier: "logic",
    })

    assert.deepEqual(output.findings, [])
    assert.equal(output.rawOutput, "")
  })
})

// ── isRequiredReviewer ─────────────────────────────────────────

void describe("isRequiredReviewer", () => {
  it("should mark correctness as required in plan-review mode", () => {
    assert.equal(isRequiredReviewer("correctness", "plan-review"), true)
  })

  it("should mark integration as required in plan-review mode", () => {
    assert.equal(isRequiredReviewer("integration", "plan-review"), true)
  })

  it("should mark feasibility as optional in plan-review mode", () => {
    assert.equal(isRequiredReviewer("feasibility", "plan-review"), false)
  })

  it("should mark unknown reviewer as optional in plan-review mode", () => {
    assert.equal(isRequiredReviewer("nonexistent", "plan-review"), false)
  })

  it("should mark correctness as required in code-review mode", () => {
    assert.equal(isRequiredReviewer("correctness", "code-review"), true)
  })

  it("should mark integration as required in code-review mode", () => {
    assert.equal(isRequiredReviewer("integration", "code-review"), true)
  })

  it("should mark security as required in code-review mode", () => {
    assert.equal(isRequiredReviewer("security", "code-review"), true)
  })

  it("should mark logic as optional in code-review mode", () => {
    assert.equal(isRequiredReviewer("logic", "code-review"), false)
  })

  it("should mark system as optional in code-review mode", () => {
    assert.equal(isRequiredReviewer("system", "code-review"), false)
  })

  it("should mark unknown reviewer as optional in code-review mode", () => {
    assert.equal(isRequiredReviewer("unknown", "code-review"), false)
  })
})

// ── runReviewerWithRetry ───────────────────────────────────────

void describe("runReviewerWithRetry", () => {
  const baseContext: ReviewerContext = {
    planningArtifacts: {
      design: "/d.md",
      executionGroups: "/eg.md",
      standards: "/s.md",
      verification: "/v.md",
    },
    tier: "logic",
  }

  it("should return success for required reviewer on first try", async () => {
    const output: ReviewerOutput = {
      findings: [{ severity: "minor", title: "test", description: "desc" }],
      rawOutput: "ok",
    }
    const runner: ReviewerRunner = async () => output

    const result = await runReviewerWithRetry(
      "correctness",
      true,
      runner,
      baseContext,
    )

    assert.equal(result.status, "success")
    if (result.status === "success") {
      assert.equal(result.output.findings.length, 1)
      assert.equal(result.output.rawOutput, "ok")
    }
  })

  it("should return success for optional reviewer on first try", async () => {
    const output: ReviewerOutput = { findings: [], rawOutput: "" }
    const runner: ReviewerRunner = async () => output

    const result = await runReviewerWithRetry(
      "feasibility",
      false,
      runner,
      baseContext,
    )

    assert.equal(result.status, "success")
  })

  it("should retry required reviewer on first failure and succeed on second", async () => {
    let callCount = 0
    const output: ReviewerOutput = {
      findings: [{ severity: "major", title: "fixed", description: "Fixed on retry" }],
      rawOutput: "retry-ok",
    }
    const runner: ReviewerRunner = async () => {
      callCount++
      if (callCount === 1) throw new Error("temporary failure")
      return output
    }

    const result = await runReviewerWithRetry(
      "correctness",
      true,
      runner,
      baseContext,
    )

    assert.equal(callCount, 2)
    assert.equal(result.status, "success")
    if (result.status === "success") {
      assert.equal(result.output.findings[0].severity, "major")
    }
  })

  it("should throw for required reviewer when both attempts fail", async () => {
    let callCount = 0
    const runner: ReviewerRunner = async () => {
      callCount++
      throw new Error("persistent failure")
    }

    await assert.rejects(
      runReviewerWithRetry("correctness", true, runner, baseContext),
      /persistent failure/,
    )

    assert.equal(callCount, 2) // Initial + 1 retry
  })

  it("should return skipped for optional reviewer when both attempts fail", async () => {
    let callCount = 0
    const runner: ReviewerRunner = async () => {
      callCount++
      throw new Error("optional failure")
    }

    const result = await runReviewerWithRetry(
      "feasibility",
      false,
      runner,
      baseContext,
    )

    assert.equal(callCount, 2) // Initial + 1 retry
    assert.equal(result.status, "skipped")
    if (result.status === "skipped") {
      assert.ok(result.reason.includes("optional failure"))
    }
  })

  it("should not retry when maxRetries is 0", async () => {
    let callCount = 0
    const runner: ReviewerRunner = async () => {
      callCount++
      throw new Error("no-retry failure")
    }

    const result = await runReviewerWithRetry(
      "feasibility",
      false,
      runner,
      baseContext,
      { maxRetries: 0, retryDelayMs: 0 },
    )

    assert.equal(callCount, 1) // No retry
    assert.equal(result.status, "skipped")
  })

  it("should retry required reviewer with maxRetries=0 and fail", async () => {
    let callCount = 0
    const runner: ReviewerRunner = async () => {
      callCount++
      throw new Error("no-retry required failure")
    }

    await assert.rejects(
      runReviewerWithRetry("correctness", true, runner, baseContext, {
        maxRetries: 0,
        retryDelayMs: 0,
      }),
      /no-retry required failure/,
    )

    assert.equal(callCount, 1)
  })

  it("should respect retryDelayMs by waiting between attempts", async () => {
    let callCount = 0
    const runner: ReviewerRunner = async () => {
      callCount++
      if (callCount === 1) throw new Error("delayed retry failure")
      return { findings: [], rawOutput: "" }
    }

    const start = Date.now()
    await runReviewerWithRetry(
      "correctness",
      true,
      runner,
      baseContext,
      { maxRetries: 1, retryDelayMs: 50 },
    )
    const elapsed = Date.now() - start

    assert.equal(callCount, 2)
    assert.ok(elapsed >= 40, `Expected at least 40ms delay (50ms requested), got ${elapsed}ms`)
  })
})

// ── runPlanReview — retry behavior ─────────────────────────────

void describe("runPlanReview — retry behavior", () => {
  it("should retry required reviewer that fails then succeeds", async () => {
    let callCount = 0
    const runner: ReviewerRunner = async (name) => {
      if (name === "correctness") {
        callCount++
        if (callCount === 1) throw new Error("temporary lane failure")
      }
      return { findings: [], rawOutput: "" }
    }

    const input = makeInput({
      executionGroups: [{ reviewTags: "logic" }],
    })

    const result = await runPlanReview(input, runner)

    assert.equal(result.action, "approve")
    const correctness = result.manifest.reviewers.find(
      (r) => r.name === "correctness",
    )
    assert.equal(correctness?.status, "executed")
    assert.equal(callCount, 2) // Initial + 1 retry
  })

  it("should record required reviewer as failed when retries exhausted", async () => {
    const runner: ReviewerRunner = async (name) => {
      if (name === "correctness") {
        throw new Error("correctness: lane permanently unavailable")
      }
      return { findings: [], rawOutput: "" }
    }

    const input = makeInput({
      executionGroups: [{ reviewTags: "logic" }],
    })

    const result = await runPlanReview(input, runner)

    const correctness = result.manifest.reviewers.find(
      (r) => r.name === "correctness",
    )
    assert.equal(correctness?.status, "failed")
    assert.ok(
      result.coverageNotes.some((n) => n.includes("failed after retry")),
    )
  })

  it("should skip optional reviewer that fails and continue", async () => {
    const runner: ReviewerRunner = async (name) => {
      if (name === "feasibility") {
        throw new Error("feasibility: lane busy")
      }
      return { findings: [], rawOutput: "" }
    }

    const input = makeInput({
      executionGroups: [{ reviewTags: "system" }],
    })

    const result = await runPlanReview(input, runner)

    const feasibility = result.manifest.reviewers.find(
      (r) => r.name === "feasibility",
    )
    assert.equal(feasibility?.status, "skipped")
    assert.ok(
      result.coverageNotes.some((n) => n.includes("skipped after retry")),
    )
  })

  it("should still approve when optional reviewer fails but no other findings", async () => {
    const runner: ReviewerRunner = async (name) => {
      if (name === "feasibility") {
        throw new Error("feasibility: temporary issue")
      }
      return { findings: [], rawOutput: "" }
    }

    const input = makeInput({
      executionGroups: [{ reviewTags: "system" }],
    })

    const result = await runPlanReview(input, runner)

    assert.equal(result.action, "approve")
  })

  it("should record skip reason in coverage notes for optional failures", async () => {
    const runner: ReviewerRunner = async (name) => {
      if (name === "feasibility") {
        throw new Error("lane not available")
      }
      return { findings: [], rawOutput: "" }
    }

    const input = makeInput({
      executionGroups: [{ reviewTags: "system" }],
    })

    const result = await runPlanReview(input, runner)

    const skipNote = result.coverageNotes.find((n) =>
      n.includes("feasibility"),
    )
    assert.ok(skipNote, "should have coverage note about feasibility skip")
    assert.ok(skipNote!.includes("lane not available"))
  })

  it("should accept custom retryPolicy via input", async () => {
    const runner: ReviewerRunner = async (name) => {
      if (name === "correctness") {
        throw new Error("correctness: fail")
      }
      return { findings: [], rawOutput: "" }
    }

    const input = makeInput({
      executionGroups: [{ reviewTags: "logic" }],
      retryPolicy: { maxRetries: 0, retryDelayMs: 0 },
    })

    const result = await runPlanReview(input, runner)

    // With maxRetries=0, correctness fails immediately without retry
    const correctness = result.manifest.reviewers.find(
      (r) => r.name === "correctness",
    )
    assert.equal(correctness?.status, "failed")
  })
})

// ── DEFAULT_RETRY_POLICY ───────────────────────────────────────

void describe("DEFAULT_RETRY_POLICY", () => {
  it("should have maxRetries of 1 and retryDelayMs of 0", () => {
    assert.equal(DEFAULT_RETRY_POLICY.maxRetries, 1)
    assert.equal(DEFAULT_RETRY_POLICY.retryDelayMs, 0)
  })
})
