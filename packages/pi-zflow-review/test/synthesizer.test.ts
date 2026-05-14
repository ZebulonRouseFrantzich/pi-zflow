/**
 * synthesizer.test.ts — Tests for synthesizer input preparation and weighting guidance.
 *
 * Covers:
 *   - getWeightingGuidance: all reviewers in both modes
 *   - prepareSynthesisInput: maps outputs correctly
 *   - formatSynthesisPrompt: contains expected sections
 *   - evaluateRecommendation: all severity combinations
 *   - buildSynthesisResult: convenience wrapper
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  getWeightingGuidance,
  prepareSynthesisInput,
  formatSynthesisPrompt,
  evaluateRecommendation,
  buildSynthesisResult,
} from "../extensions/zflow-review/synthesizer.js"

import type {
  SynthesisInput,
  SynthesisReviewerOutput,
  SynthesisResult,
} from "../extensions/zflow-review/synthesizer.js"

import { createManifest, recordExecuted, recordSkipped, recordFailed } from "../src/reviewer-manifest.js"

import type { ReviewerManifest } from "../src/reviewer-manifest.js"

// ── Helper: build a manifest for testing ───────────────────────

function makeManifest(
  mode: "code-review" | "plan-review",
  tier: string,
  reviewers: string[],
  overrides?: Partial<ReviewerManifest>,
): ReviewerManifest {
  return {
    ...createManifest(mode, tier, reviewers),
    ...overrides,
  }
}

// ── getWeightingGuidance ───────────────────────────────────────

void describe("getWeightingGuidance", () => {
  it("should return standard weights for correctness in plan-review mode", () => {
    const g = getWeightingGuidance("correctness", "plan-review")
    assert.equal(g.algorithmWeight, 1.0)
    assert.equal(g.systemWeight, 1.0)
    assert.ok(g.focus.length > 0)
  })

  it("should return standard weights for integration in plan-review mode", () => {
    const g = getWeightingGuidance("integration", "plan-review")
    assert.equal(g.algorithmWeight, 1.0)
    assert.equal(g.systemWeight, 1.0)
  })

  it("should return higher system weight for feasibility", () => {
    const g = getWeightingGuidance("feasibility", "plan-review")
    assert.equal(g.algorithmWeight, 0.8)
    assert.equal(g.systemWeight, 1.2)
    assert.ok(g.focus.includes("feasibility"))
  })

  it("should return standard weights for correctness in code-review mode", () => {
    const g = getWeightingGuidance("correctness", "code-review")
    assert.equal(g.algorithmWeight, 1.0)
    assert.equal(g.systemWeight, 1.0)
  })

  it("should return standard weights for integration in code-review mode", () => {
    const g = getWeightingGuidance("integration", "code-review")
    assert.equal(g.algorithmWeight, 1.0)
    assert.equal(g.systemWeight, 1.0)
  })

  it("should return standard weights for security in code-review mode", () => {
    const g = getWeightingGuidance("security", "code-review")
    assert.equal(g.algorithmWeight, 1.0)
    assert.equal(g.systemWeight, 1.0)
  })

  it("should return higher algorithm weight for logic reviewer", () => {
    const g = getWeightingGuidance("logic", "code-review")
    assert.equal(g.algorithmWeight, 1.5)
    assert.equal(g.systemWeight, 0.8)
    assert.ok(g.focus.includes("algorithmic") || g.focus.includes("Algorithmic"))
  })

  it("should return higher system weight for system reviewer", () => {
    const g = getWeightingGuidance("system", "code-review")
    assert.equal(g.algorithmWeight, 0.8)
    assert.equal(g.systemWeight, 1.5)
    assert.ok(g.focus.includes("system-level") || g.focus.includes("System-level"))
  })

  it("should return default weights for unknown reviewer in plan-review mode", () => {
    const g = getWeightingGuidance("unknown-reviewer", "plan-review")
    assert.equal(g.algorithmWeight, 1.0)
    assert.equal(g.systemWeight, 1.0)
    assert.ok(g.focus.includes("unknown-reviewer"))
  })

  it("should return default weights for unknown reviewer in code-review mode", () => {
    const g = getWeightingGuidance("unknown-reviewer", "code-review")
    assert.equal(g.algorithmWeight, 1.0)
    assert.equal(g.systemWeight, 1.0)
    assert.ok(g.focus.includes("unknown-reviewer"))
  })

  it("should return consistent weights for all known plan-review reviewers", () => {
    const known = ["correctness", "integration", "feasibility"]
    for (const name of known) {
      const g = getWeightingGuidance(name, "plan-review")
      assert.ok(typeof g.algorithmWeight === "number")
      assert.ok(typeof g.systemWeight === "number")
      assert.ok(typeof g.focus === "string")
    }
  })

  it("should return consistent weights for all known code-review reviewers", () => {
    const known = ["correctness", "integration", "security", "logic", "system"]
    for (const name of known) {
      const g = getWeightingGuidance(name, "code-review")
      assert.ok(typeof g.algorithmWeight === "number")
      assert.ok(typeof g.systemWeight === "number")
      assert.ok(typeof g.focus === "string")
    }
  })
})

// ── prepareSynthesisInput ──────────────────────────────────────

void describe("prepareSynthesisInput", () => {
  it("should map reviewer outputs to structured format", () => {
    const manifest = makeManifest("code-review", "standard", [
      "correctness", "integration", "security",
    ])
    const outputs = {
      correctness: {
        findings: [
          { severity: "major" as const, title: "Missing null check", description: "Input not validated", evidence: "src/cli.ts:44" },
        ],
        rawOutput: "Found 1 issue",
      },
      integration: {
        findings: [],
        rawOutput: "No integration concerns",
      },
    }

    const input = prepareSynthesisInput(manifest, outputs, "code-review")

    assert.equal(input.mode, "code-review")
    assert.equal(input.manifest, manifest)
    assert.ok("correctness" in input.reviewerFindings)
    assert.ok("integration" in input.reviewerFindings)

    // correctness should be required
    assert.equal(input.reviewerFindings.correctness.required, true)
    assert.equal(input.reviewerFindings.correctness.name, "correctness")
    assert.equal(input.reviewerFindings.correctness.findings.length, 1)
    assert.equal(input.reviewerFindings.correctness.findings[0].title, "Missing null check")
    assert.equal(input.reviewerFindings.correctness.rawOutput, "Found 1 issue")

    // integration should have no findings
    assert.equal(input.reviewerFindings.integration.findings.length, 0)
  })

  it("should mark optional reviewers correctly", () => {
    const manifest = makeManifest("code-review", "+full", [
      "correctness", "integration", "security", "logic", "system",
    ])
    const outputs = {
      logic: { findings: [], rawOutput: "" },
      system: { findings: [], rawOutput: "" },
    }

    const input = prepareSynthesisInput(manifest, outputs, "code-review")

    assert.equal(input.reviewerFindings.logic.required, false)
    assert.equal(input.reviewerFindings.system.required, false)
  })

  it("should include empty findings when provided", () => {
    const manifest = makeManifest("code-review", "standard", ["correctness"])
    const input = prepareSynthesisInput(manifest, {}, "code-review")
    assert.deepEqual(Object.keys(input.reviewerFindings), [])
  })

  it("should set required correctly for plan-review mode", () => {
    const manifest = makeManifest("plan-review", "system", [
      "correctness", "integration", "feasibility",
    ])
    const outputs = {
      correctness: { findings: [], rawOutput: "" },
      integration: { findings: [], rawOutput: "" },
      feasibility: { findings: [], rawOutput: "" },
    }

    const input = prepareSynthesisInput(manifest, outputs, "plan-review")

    assert.equal(input.reviewerFindings.correctness.required, true)
    assert.equal(input.reviewerFindings.integration.required, true)
    assert.equal(input.reviewerFindings.feasibility.required, false)
  })
})

// ── formatSynthesisPrompt ──────────────────────────────────────

void describe("formatSynthesisPrompt", () => {
  it("should contain the run ID", () => {
    const manifest = makeManifest("code-review", "standard", ["correctness"])
    const input: SynthesisInput = {
      manifest,
      reviewerFindings: {},
      mode: "code-review",
    }
    const prompt = formatSynthesisPrompt(input)
    assert.ok(prompt.includes(manifest.runId))
  })

  it("should contain reviewer names when present", () => {
    const manifest = makeManifest("code-review", "standard", [
      "correctness", "integration",
    ])
    const input: SynthesisInput = {
      manifest,
      reviewerFindings: {
        correctness: {
          name: "correctness",
          required: true,
          findings: [],
          rawOutput: "",
        },
        integration: {
          name: "integration",
          required: true,
          findings: [],
          rawOutput: "",
        },
      },
      mode: "code-review",
    }
    const prompt = formatSynthesisPrompt(input)
    assert.ok(prompt.includes("correctness"))
    assert.ok(prompt.includes("integration"))
  })

  it("should contain weighting guidance", () => {
    const manifest = makeManifest("code-review", "+full", [
      "correctness", "integration", "security", "logic", "system",
    ])
    const input: SynthesisInput = {
      manifest,
      reviewerFindings: {
        logic: {
          name: "logic",
          required: false,
          findings: [
            { severity: "minor", title: "Test", description: "Test" },
          ],
          rawOutput: "",
        },
        system: {
          name: "system",
          required: false,
          findings: [
            { severity: "major", title: "System issue", description: "Issue", evidence: "src/system.ts:1" },
          ],
          rawOutput: "",
        },
      },
      mode: "code-review",
    }
    const prompt = formatSynthesisPrompt(input)
    assert.ok(prompt.includes("Algorithm weight"), "Should contain algorithm weight guidance")
    assert.ok(prompt.includes("System weight"), "Should contain system weight guidance")
    assert.ok(prompt.includes("logic"), "Should mention logic reviewer")
    assert.ok(prompt.includes("system"), "Should mention system reviewer")
  })

  it("should contain deduplication instructions", () => {
    const manifest = makeManifest("code-review", "standard", ["correctness"])
    const input: SynthesisInput = {
      manifest,
      reviewerFindings: {},
      mode: "code-review",
    }
    const prompt = formatSynthesisPrompt(input)
    assert.ok(prompt.includes("Deduplication"))
    assert.ok(prompt.includes("same root cause"))
  })

  it("should contain the synthesis instructions section", () => {
    const manifest = makeManifest("code-review", "standard", ["correctness"])
    const input: SynthesisInput = {
      manifest,
      reviewerFindings: {},
      mode: "code-review",
    }
    const prompt = formatSynthesisPrompt(input)
    assert.ok(prompt.includes("Synthesis Instructions"))
    assert.ok(prompt.includes("Core rules"))
    assert.ok(prompt.includes("Output format"))
    assert.ok(prompt.includes("GO | NO-GO | CONDITIONAL-GO"))
  })

  it("should contain manifest summary table", () => {
    const manifest = makeManifest("code-review", "standard", ["correctness", "integration"])
    const input: SynthesisInput = {
      manifest,
      reviewerFindings: {},
      mode: "code-review",
    }
    const prompt = formatSynthesisPrompt(input)
    assert.ok(prompt.includes("Reviewer Manifest"))
    assert.ok(prompt.includes("| Reviewer | Status | Detail |"))
    assert.ok(prompt.includes("| correctness |"))
    assert.ok(prompt.includes("| integration |"))
  })

  it("should include mode-appropriate header", () => {
    const manifest = makeManifest("plan-review", "system", ["correctness", "integration"])
    const input: SynthesisInput = {
      manifest,
      reviewerFindings: {},
      mode: "plan-review",
    }
    const prompt = formatSynthesisPrompt(input)
    assert.ok(prompt.includes("Plan Review"))

    const input2: SynthesisInput = {
      manifest: makeManifest("code-review", "standard", ["correctness"]),
      reviewerFindings: {},
      mode: "code-review",
    }
    const prompt2 = formatSynthesisPrompt(input2)
    assert.ok(prompt2.includes("Code Review"))
  })

  it("should show findings table with evidence", () => {
    const manifest = makeManifest("code-review", "standard", ["correctness"])
    const input: SynthesisInput = {
      manifest,
      reviewerFindings: {
        correctness: {
          name: "correctness",
          required: true,
          findings: [
            { severity: "critical", title: "CVE-2024-1234", description: "Remote code execution", evidence: "src/unsafe.ts:42" },
            { severity: "minor", title: "Unused import", description: "Remove unused import", evidence: "src/utils.ts:1" },
          ],
          rawOutput: "Two issues found",
        },
      },
      mode: "code-review",
    }
    const prompt = formatSynthesisPrompt(input)
    assert.ok(prompt.includes("CVE-2024-1234"))
    assert.ok(prompt.includes("Unused import"))
    assert.ok(prompt.includes("src/unsafe.ts:42"))
    assert.ok(prompt.includes("Remote code execution"))
    assert.ok(prompt.includes("Two issues found"))
  })

  it("should handle empty findings gracefully", () => {
    const manifest = makeManifest("code-review", "standard", ["correctness"])
    const input: SynthesisInput = {
      manifest,
      reviewerFindings: {
        correctness: {
          name: "correctness",
          required: true,
          findings: [],
          rawOutput: "No issues found",
        },
      },
      mode: "code-review",
    }
    const prompt = formatSynthesisPrompt(input)
    assert.ok(prompt.includes("No findings from this reviewer"))
    assert.ok(prompt.includes("No issues found"))
  })
})

// ── evaluateRecommendation ─────────────────────────────────────

void describe("evaluateRecommendation", () => {
  it("should return NO-GO when critical findings exist", () => {
    assert.equal(
      evaluateRecommendation({ critical: 1, major: 0, minor: 0, nit: 0 }),
      "NO-GO",
    )
  })

  it("should return NO-GO when critical and other findings mix", () => {
    assert.equal(
      evaluateRecommendation({ critical: 2, major: 3, minor: 5, nit: 10 }),
      "NO-GO",
    )
  })

  it("should return CONDITIONAL-GO when only major findings exist", () => {
    assert.equal(
      evaluateRecommendation({ critical: 0, major: 1, minor: 0, nit: 0 }),
      "CONDITIONAL-GO",
    )
  })

  it("should return CONDITIONAL-GO when major and minor findings mix", () => {
    assert.equal(
      evaluateRecommendation({ critical: 0, major: 2, minor: 3, nit: 0 }),
      "CONDITIONAL-GO",
    )
  })

  it("should return GO when only minor findings exist", () => {
    assert.equal(
      evaluateRecommendation({ critical: 0, major: 0, minor: 2, nit: 0 }),
      "GO",
    )
  })

  it("should return GO when only nit findings exist", () => {
    assert.equal(
      evaluateRecommendation({ critical: 0, major: 0, minor: 0, nit: 5 }),
      "GO",
    )
  })

  it("should return GO when no findings at all", () => {
    assert.equal(
      evaluateRecommendation({ critical: 0, major: 0, minor: 0, nit: 0 }),
      "GO",
    )
  })

  it("should return GO when minor and nit mix without critical or major", () => {
    assert.equal(
      evaluateRecommendation({ critical: 0, major: 0, minor: 1, nit: 3 }),
      "GO",
    )
  })
})

// ── buildSynthesisResult ───────────────────────────────────────

void describe("buildSynthesisResult", () => {
  it("should build result with GO recommendation when no findings", () => {
    const result = buildSynthesisResult([], { critical: 0, major: 0, minor: 0, nit: 0 }, ["All reviewers covered"])
    assert.equal(result.recommendation, "GO")
    assert.deepEqual(result.consolidatedFindings, [])
    assert.deepEqual(result.severitySummary, { critical: 0, major: 0, minor: 0, nit: 0 })
    assert.deepEqual(result.coverageNotes, ["All reviewers covered"])
  })

  it("should build result with NO-GO recommendation when critical", () => {
    const findings: SynthesisResult["consolidatedFindings"] = [
      {
        severity: "critical",
        title: "Security flaw",
        description: "Remote code execution vulnerability",
        evidence: "src/api.ts:22",
        reviewerSupport: ["security"],
      },
    ]
    const result = buildSynthesisResult(findings, { critical: 1, major: 0, minor: 0, nit: 0 }, ["Security flagged critical"])
    assert.equal(result.recommendation, "NO-GO")
    assert.equal(result.consolidatedFindings.length, 1)
    assert.equal(result.consolidatedFindings[0].reviewerSupport[0], "security")
  })

  it("should build result with CONDITIONAL-GO when major", () => {
    const findings: SynthesisResult["consolidatedFindings"] = [
      {
        severity: "major",
        title: "Missing validation",
        description: "Input validation is missing",
        evidence: "src/cli.ts:50",
        reviewerSupport: ["correctness"],
        reviewerDissent: ["integration"],
      },
    ]
    const result = buildSynthesisResult(findings, { critical: 0, major: 1, minor: 0, nit: 0 }, ["One major finding"])
    assert.equal(result.recommendation, "CONDITIONAL-GO")
    assert.ok(result.consolidatedFindings[0].reviewerDissent)
    assert.equal(result.consolidatedFindings[0].reviewerDissent![0], "integration")
  })
})
