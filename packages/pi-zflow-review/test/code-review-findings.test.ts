/**
 * code-review-findings.test.ts — Tests for code review findings persistence.
 *
 * Covers:
 *   - formatSeveritySummary: counts severities correctly
 *   - formatCoverageNotes: all status symbols
 *   - formatFindingsBySeverity: sections and grouping
 *   - persistCodeReviewFindings: file creation, content, formatting
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"

import {
  formatSeveritySummary,
  formatCoverageNotes,
  formatFindingsBySeverity,
  persistCodeReviewFindings,
  chooseCodeReviewTier,
  resolveReviewerArtifactDir,
  persistReviewerRawOutput,
  resolveAllReviewerArtifacts,
  loadReviewerRawOutput,
  addFindingTraceability,
} from "../extensions/zflow-review/findings.js"

import { createManifest, recordExecuted, recordSkipped, recordFailed } from "../src/reviewer-manifest.js"

import type { CodeReviewFinding, CodeReviewFindingsInput, CodeReviewTierContext } from "../extensions/zflow-review/findings.js"
import type { ReviewerManifest } from "../src/reviewer-manifest.js"

// ── Helpers ────────────────────────────────────────────────────

function makeManifest(
  overrides?: Partial<ReviewerManifest>,
): ReviewerManifest {
  return {
    mode: "code-review",
    tier: "standard",
    runId: "rev-test-code-001",
    createdAt: new Date("2026-01-15T10:00:00Z").toISOString(),
    reviewers: [],
    skippedReviewers: [],
    failedReviewers: [],
    ...overrides,
  }
}

function makeFinding(overrides: Partial<CodeReviewFinding> = {}): CodeReviewFinding {
  return {
    severity: "major",
    title: "Test finding",
    reviewerSupport: ["correctness"],
    evidence: "src/test.ts:10-20",
    whyItMatters: "This is a test finding",
    recommendation: "Fix the test finding",
    ...overrides,
  }
}

// ── formatSeveritySummary ──────────────────────────────────────

void describe("formatSeveritySummary", () => {
  it("should count severities correctly", () => {
    const findings: CodeReviewFinding[] = [
      makeFinding({ severity: "critical", title: "F1" }),
      makeFinding({ severity: "major", title: "F2" }),
      makeFinding({ severity: "major", title: "F3" }),
      makeFinding({ severity: "minor", title: "F4" }),
      makeFinding({ severity: "minor", title: "F5" }),
      makeFinding({ severity: "minor", title: "F6" }),
      makeFinding({ severity: "nit", title: "F7" }),
    ]

    const result = formatSeveritySummary(findings)

    assert.ok(result.includes("| Critical | 1 |"))
    assert.ok(result.includes("| Major    | 2 |"))
    assert.ok(result.includes("| Minor    | 3 |"))
    assert.ok(result.includes("| Nit      | 1 |"))
  })

  it("should return all zeros for empty findings", () => {
    const result = formatSeveritySummary([])

    assert.ok(result.includes("| Critical | 0 |"))
    assert.ok(result.includes("| Major    | 0 |"))
    assert.ok(result.includes("| Minor    | 0 |"))
    assert.ok(result.includes("| Nit      | 0 |"))
  })

  it("should include header row", () => {
    const result = formatSeveritySummary([])

    assert.ok(result.includes("| Severity | Count |"))
    assert.ok(result.includes("| -------- | ----- |"))
  })
})

// ── formatCoverageNotes ────────────────────────────────────────

void describe("formatCoverageNotes", () => {
  it("should show all executed reviewers with checkmark", () => {
    let m = createManifest("code-review", "standard", [
      "correctness",
      "integration",
    ])
    m = recordExecuted(m, "correctness")
    m = recordExecuted(m, "integration")

    const result = formatCoverageNotes(m)

    assert.ok(result.includes("correctness: ✅ executed"))
    assert.ok(result.includes("integration: ✅ executed"))
  })

  it("should show mixed executed and skipped reviewers", () => {
    let m = createManifest("code-review", "standard", [
      "correctness",
      "security",
    ])
    m = recordExecuted(m, "correctness")
    m = recordSkipped(m, "security", "no security concern")

    const result = formatCoverageNotes(m)

    assert.ok(result.includes("correctness: ✅ executed"))
    assert.ok(result.includes("security: ⚠️ skipped"))
    assert.ok(result.includes("no security concern"))
  })

  it("should show failed reviewer with cross mark", () => {
    let m = createManifest("code-review", "standard", [
      "correctness",
      "security",
    ])
    m = recordExecuted(m, "correctness")
    m = recordFailed(m, "security", "lane unavailable")

    const result = formatCoverageNotes(m)

    assert.ok(result.includes("correctness: ✅ executed"))
    assert.ok(result.includes("security: ❌ failed"))
    assert.ok(result.includes("lane unavailable"))
  })

  it("should show requested reviewer with pending symbol", () => {
    const m = createManifest("code-review", "standard", ["correctness"])

    const result = formatCoverageNotes(m)

    assert.ok(result.includes("correctness: ◻️ requested"))
    assert.ok(result.includes("not dispatched"))
  })

  it("should handle empty manifest reviewers", () => {
    const m = makeManifest({ reviewers: [] })
    const result = formatCoverageNotes(m)

    assert.equal(result, "")
  })
})

// ── formatFindingsBySeverity ────────────────────────────────────

void describe("formatFindingsBySeverity", () => {
  it("should include all severity section headings", () => {
    const findings: CodeReviewFinding[] = [
      makeFinding({ severity: "critical", title: "C1" }),
      makeFinding({ severity: "major", title: "M1" }),
      makeFinding({ severity: "minor", title: "m1" }),
      makeFinding({ severity: "nit", title: "n1" }),
    ]

    const result = formatFindingsBySeverity(findings)

    assert.ok(result.includes("## Critical Findings"))
    assert.ok(result.includes("## Major Findings"))
    assert.ok(result.includes("## Minor Findings"))
    assert.ok(result.includes("## Nits"))
  })

  it("should render finding fields correctly", () => {
    const findings: CodeReviewFinding[] = [
      {
        severity: "major",
        title: "Missing validation on CLI input",
        reviewerSupport: ["security", "correctness"],
        reviewerDissent: ["integration"],
        evidence: "src/cli.ts lines 44-58",
        whyItMatters: "path traversal may be possible",
        failureMode: "attacker-controlled relative path escapes intended root",
        recommendation: "normalize and enforce allowlisted roots",
      },
    ]

    const result = formatFindingsBySeverity(findings)

    assert.ok(result.includes("### Missing validation on CLI input"))
    assert.ok(result.includes("security, correctness"))
    assert.ok(result.includes("integration"))
    assert.ok(result.includes("src/cli.ts lines 44-58"))
    assert.ok(result.includes("path traversal may be possible"))
    assert.ok(result.includes("attacker-controlled relative path"))
    assert.ok(result.includes("normalize and enforce allowlisted roots"))
  })

  it("should show None for severity sections with no findings", () => {
    const findings: CodeReviewFinding[] = [
      makeFinding({ severity: "major" }),
    ]

    const result = formatFindingsBySeverity(findings)

    // Critical, Minor, Nits sections should show "None."
    assert.ok(result.includes("## Critical Findings"))
    assert.ok(result.includes("None."))
    assert.ok(result.includes("## Nits"))
  })

  it("should not include reviewerDissent when empty", () => {
    const findings: CodeReviewFinding[] = [
      makeFinding({
        severity: "minor",
        reviewerDissent: undefined,
      }),
    ]

    const result = formatFindingsBySeverity(findings)

    assert.ok(result.includes("### Test finding"))
    assert.ok(!result.includes("**Reviewer dissent**"))
  })

  it("should not include failureMode when absent", () => {
    const findings: CodeReviewFinding[] = [
      makeFinding({
        severity: "nit",
        failureMode: undefined,
      }),
    ]

    const result = formatFindingsBySeverity(findings)

    assert.ok(result.includes("### Test finding"))
    assert.ok(!result.includes("**Failure mode**"))
  })

  it("should order findings by severity", () => {
    const findings: CodeReviewFinding[] = [
      makeFinding({ severity: "nit", title: "N1" }),
      makeFinding({ severity: "critical", title: "C1" }),
      makeFinding({ severity: "major", title: "M1" }),
      makeFinding({ severity: "minor", title: "m1" }),
    ]

    const result = formatFindingsBySeverity(findings)

    const criticalIdx = result.indexOf("## Critical Findings")
    const majorIdx = result.indexOf("## Major Findings")
    const minorIdx = result.indexOf("## Minor Findings")
    const nitIdx = result.indexOf("## Nits")

    assert.ok(criticalIdx < majorIdx)
    assert.ok(majorIdx < minorIdx)
    assert.ok(minorIdx < nitIdx)
  })
})

// ── persistCodeReviewFindings ──────────────────────────────────

void describe("persistCodeReviewFindings", () => {
  let tmpDir: string

  // Track created file paths for cleanup
  const createdFiles: string[] = []

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "crf-test-"))
  })

  after(async () => {
    for (const fp of createdFiles) {
      await fs.rm(path.dirname(fp), { recursive: true, force: true }).catch(() => {})
    }
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  /**
   * Build a minimal valid input targeting a specific directory via cwd.
   */
  function makeInput(
    overrides: Partial<CodeReviewFindingsInput> = {},
  ): CodeReviewFindingsInput {
    let m = createManifest("code-review", "standard", [
      "correctness",
      "integration",
      "security",
    ])
    m = recordExecuted(m, "correctness")
    m = recordExecuted(m, "integration")
    m = recordSkipped(m, "security", "no security concerns found")

    return {
      source: "Implementation of feat-auth",
      repoPath: "/home/user/project",
      branch: "feat-auth",
      baseRef: "main",
      runId: m.runId,
      manifest: m,
      reviewers: ["correctness", "integration", "security"],
      reviewedFiles: ["src/auth.ts", "src/middleware.ts"],
      verificationContext: "All tests passed (42/42). Lint clean.",
      findings: [
        {
          severity: "major",
          title: "Missing input validation",
          reviewerSupport: ["correctness", "security"],
          reviewerDissent: ["integration"],
          evidence: "src/auth.ts:120-127",
          whyItMatters: "Unvalidated input may lead to injection",
          failureMode: "attacker-controlled payload bypasses auth",
          recommendation: "Add input validation before processing",
        },
        {
          severity: "minor",
          title: "Unused import",
          reviewerSupport: ["correctness"],
          evidence: "src/middleware.ts:1",
          whyItMatters: "Code clarity and maintainability",
          recommendation: "Remove unused import",
        },
      ],
      cwd: tmpDir,
      ...overrides,
    }
  }

  it("should create file at the correct path", async () => {
    const input = makeInput()

    const filePath = await persistCodeReviewFindings(input)
    createdFiles.push(filePath)

    assert.ok(filePath.endsWith("code-review-findings.md"))
    assert.ok(filePath.includes("review"), "should contain 'review' in path")

    const exists = await fs.stat(filePath).then(() => true).catch(() => false)
    assert.ok(exists, `file should exist at: ${filePath}`)
  })

  it("should contain required header sections", async () => {
    const input = makeInput()
    const filePath = await persistCodeReviewFindings(input)
    createdFiles.push(filePath)
    const content = await fs.readFile(filePath, "utf-8")

    assert.ok(content.includes("Code Review Findings"))
    assert.ok(content.includes("**Source**: Implementation of feat-auth"))
    assert.ok(content.includes("**Repo path**: /home/user/project"))
    assert.ok(content.includes("**Branch**: feat-auth"))
    assert.ok(content.includes("**Base ref**: main"))
    assert.ok(content.includes("**Run ID**: rev-"))
    assert.ok(content.includes("## Reviewed Changes"))
    assert.ok(content.includes("## Verification Context"))
    assert.ok(content.includes("## Coverage Notes"))
    assert.ok(content.includes("## Findings Summary"))
  })

  it("should include reviewed files list", async () => {
    const input = makeInput()
    const filePath = await persistCodeReviewFindings(input)
    createdFiles.push(filePath)
    const content = await fs.readFile(filePath, "utf-8")

    assert.ok(content.includes("- src/auth.ts"))
    assert.ok(content.includes("- src/middleware.ts"))
  })

  it("should include verification context", async () => {
    const input = makeInput()
    const filePath = await persistCodeReviewFindings(input)
    createdFiles.push(filePath)
    const content = await fs.readFile(filePath, "utf-8")

    assert.ok(content.includes("All tests passed (42/42). Lint clean."))
  })

  it("should include coverage notes from manifest", async () => {
    const input = makeInput()
    const filePath = await persistCodeReviewFindings(input)
    createdFiles.push(filePath)
    const content = await fs.readFile(filePath, "utf-8")

    assert.ok(content.includes("correctness: ✅ executed"))
    assert.ok(content.includes("integration: ✅ executed"))
    assert.ok(content.includes("security: ⚠️ skipped"))
    assert.ok(content.includes("no security concerns found"))
  })

  it("should include findings summary table", async () => {
    const input = makeInput()
    const filePath = await persistCodeReviewFindings(input)
    createdFiles.push(filePath)
    const content = await fs.readFile(filePath, "utf-8")

    assert.ok(content.includes("| Critical | 0 |"))
    assert.ok(content.includes("| Major    | 1 |"))
    assert.ok(content.includes("| Minor    | 1 |"))
    assert.ok(content.includes("| Nit      | 0 |"))
  })

  it("should include findings grouped by severity", async () => {
    const input = makeInput()
    const filePath = await persistCodeReviewFindings(input)
    createdFiles.push(filePath)
    const content = await fs.readFile(filePath, "utf-8")

    // Major findings section
    assert.ok(content.includes("## Major Findings"))
    assert.ok(content.includes("### Missing input validation"))
    assert.ok(content.includes("**Reviewer support**: correctness, security"))
    assert.ok(content.includes("**Reviewer dissent**: integration"))
    assert.ok(content.includes("**Evidence**: src/auth.ts:120-127"))
    assert.ok(content.includes("**Why it matters**: Unvalidated input"))
    assert.ok(content.includes("**Failure mode**: attacker-controlled payload"))
    assert.ok(content.includes("**Recommendation**: Add input validation"))

    // Minor findings section
    assert.ok(content.includes("## Minor Findings"))
    assert.ok(content.includes("### Unused import"))
    assert.ok(content.includes("**Evidence**: src/middleware.ts:1"))
  })

  it("should create parent directory automatically", async () => {
    const deepTmpDir = path.join(tmpDir, "deep", "nested")
    const input = makeInput({ cwd: deepTmpDir })

    const filePath = await persistCodeReviewFindings(input)
    createdFiles.push(filePath)

    const exists = await fs.stat(filePath).then(() => true).catch(() => false)
    assert.ok(exists)
  })

  it("should handle empty findings gracefully", async () => {
    const input = makeInput({ findings: [] })
    const filePath = await persistCodeReviewFindings(input)
    createdFiles.push(filePath)
    const content = await fs.readFile(filePath, "utf-8")

    assert.ok(content.includes("| Critical | 0 |"))
    assert.ok(content.includes("| Major    | 0 |"))
    assert.ok(content.includes("| Minor    | 0 |"))
    assert.ok(content.includes("| Nit      | 0 |"))
    assert.ok(content.includes("## Critical Findings"))
    assert.ok(content.includes("None."))
  })

  it("should handle reviewer dissent and failure mode correctly", async () => {
    const input = makeInput({
      findings: [
        {
          severity: "critical",
          title: "Security vulnerability",
          reviewerSupport: ["security"],
          evidence: "src/auth.ts:50",
          whyItMatters: "Authentication bypass",
          recommendation: "Fix auth logic",
        },
      ],
    })

    const filePath = await persistCodeReviewFindings(input)
    createdFiles.push(filePath)
    const content = await fs.readFile(filePath, "utf-8")

    assert.ok(content.includes("## Critical Findings"))
    assert.ok(content.includes("### Security vulnerability"))
    // No reviewer dissent line since none was provided
    assert.ok(!content.includes("**Reviewer dissent**"))
    // No failure mode line since none was provided
    assert.ok(!content.includes("**Failure mode**"))
  })
})

// ═══════════════════════════════════════════════════════════════
// chooseCodeReviewTier tests
// ═══════════════════════════════════════════════════════════════

void describe("chooseCodeReviewTier", () => {
  it("should return standard for empty context", () => {
    assert.equal(chooseCodeReviewTier({}), "standard")
  })

  it("should return standard when no trigger conditions are met", () => {
    const ctx = {
      executionGroups: [],
      verificationText: "simple boilerplate change",
      modifiedFiles: ["src/button.tsx"],
      modifiedDirectories: ["src"],
    }
    assert.equal(chooseCodeReviewTier(ctx), "standard")
  })

  // ── Logic triggers ──────────────────────────────────────────

  it("should return +logic when reviewTags includes logic", () => {
    const ctx: CodeReviewTierContext = {
      executionGroups: [{ reviewTags: "logic" }],
    }
    assert.equal(chooseCodeReviewTier(ctx), "+logic")
  })

  it("should return +logic when verification text mentions performance", () => {
    const ctx: CodeReviewTierContext = {
      verificationText: "Must meet sub-second response times for performance requirements",
    }
    assert.equal(chooseCodeReviewTier(ctx), "+logic")
  })

  it("should return +logic when verification text mentions complexity", () => {
    const ctx: CodeReviewTierContext = {
      verificationText: "time complexity should not exceed O(n log n)",
    }
    assert.equal(chooseCodeReviewTier(ctx), "+logic")
  })

  it("should return +logic when modified file contains algorithmic keyword", () => {
    const ctx: CodeReviewTierContext = {
      modifiedFiles: ["src/algorithm/sort.ts"],
    }
    assert.equal(chooseCodeReviewTier(ctx), "+logic")
  })

  it("should return +logic when modified file contains concurrency keyword", () => {
    const ctx: CodeReviewTierContext = {
      modifiedFiles: ["src/concurrency/worker.ts"],
    }
    assert.equal(chooseCodeReviewTier(ctx), "+logic")
  })

  it("should return +logic when modified file contains parallel keyword", () => {
    const ctx: CodeReviewTierContext = {
      modifiedFiles: ["src/parallel/processor.ts"],
    }
    assert.equal(chooseCodeReviewTier(ctx), "+logic")
  })

  it("should return +logic when hasAlgorithmicRisk is true", () => {
    const ctx: CodeReviewTierContext = {
      hasAlgorithmicRisk: true,
    }
    assert.equal(chooseCodeReviewTier(ctx), "+logic")
  })

  // ── System triggers ─────────────────────────────────────────

  it("should return +system when reviewTags includes system", () => {
    const ctx: CodeReviewTierContext = {
      executionGroups: [{ reviewTags: "system" }],
    }
    assert.equal(chooseCodeReviewTier(ctx), "+system")
  })

  it("should return +system when more than 10 files changed", () => {
    const files = Array.from({ length: 11 }, (_, i) => `src/file${i}.ts`)
    const ctx: CodeReviewTierContext = {
      modifiedFiles: files,
    }
    assert.equal(chooseCodeReviewTier(ctx), "+system")
  })

  it("should return standard when exactly 10 files changed", () => {
    const files = Array.from({ length: 10 }, (_, i) => `src/file${i}.ts`)
    const ctx: CodeReviewTierContext = {
      modifiedFiles: files,
    }
    assert.equal(chooseCodeReviewTier(ctx), "standard")
  })

  it("should return +system when more than 3 directories touched", () => {
    const ctx: CodeReviewTierContext = {
      modifiedDirectories: ["src", "lib", "config", "tests"],
    }
    assert.equal(chooseCodeReviewTier(ctx), "+system")
  })

  it("should return standard when exactly 3 directories touched", () => {
    const ctx: CodeReviewTierContext = {
      modifiedDirectories: ["src", "lib", "config"],
    }
    assert.equal(chooseCodeReviewTier(ctx), "standard")
  })

  it("should return +system when crossModuleDependencies present", () => {
    const ctx: CodeReviewTierContext = {
      crossModuleDependencies: ["auth → api", "db → cache"],
    }
    assert.equal(chooseCodeReviewTier(ctx), "+system")
  })

  it("should return +system when hasPublicApiChanges is true", () => {
    const ctx: CodeReviewTierContext = {
      hasPublicApiChanges: true,
    }
    assert.equal(chooseCodeReviewTier(ctx), "+system")
  })

  it("should return +system when hasMigrationChanges is true", () => {
    const ctx: CodeReviewTierContext = {
      hasMigrationChanges: true,
    }
    assert.equal(chooseCodeReviewTier(ctx), "+system")
  })

  // ── Combined triggers ───────────────────────────────────────

  it("should return +full when both logic and system conditions are met", () => {
    const ctx: CodeReviewTierContext = {
      executionGroups: [{ reviewTags: ["logic", "system"] }],
    }
    assert.equal(chooseCodeReviewTier(ctx), "+full")
  })

  it("should return +full when logic from tags and system from file count", () => {
    const files = Array.from({ length: 11 }, (_, i) => `src/file${i}.ts`)
    const ctx: CodeReviewTierContext = {
      executionGroups: [{ reviewTags: "logic" }],
      modifiedFiles: files,
    }
    assert.equal(chooseCodeReviewTier(ctx), "+full")
  })

  it("should return +full when system from tags and logic from algorithmic file", () => {
    const ctx: CodeReviewTierContext = {
      executionGroups: [{ reviewTags: "system" }],
      modifiedFiles: ["src/algorithm/sort.ts"],
    }
    assert.equal(chooseCodeReviewTier(ctx), "+full")
  })

  it("should return +full when logic from verification text and system from API change", () => {
    const ctx: CodeReviewTierContext = {
      verificationText: "performance requirements must be met",
      hasPublicApiChanges: true,
    }
    assert.equal(chooseCodeReviewTier(ctx), "+full")
  })

  // ── Edge cases ──────────────────────────────────────────────

  it("should return +full when logic from algorithmicRisk and system from migration", () => {
    const ctx: CodeReviewTierContext = {
      hasAlgorithmicRisk: true,
      hasMigrationChanges: true,
    }
    assert.equal(chooseCodeReviewTier(ctx), "+full")
  })

  it("should still return +system when multiple system conditions met but logic not flagged", () => {
    const files = Array.from({ length: 11 }, (_, i) => `src/file${i}.ts`)
    const ctx: CodeReviewTierContext = {
      modifiedFiles: files,
      modifiedDirectories: ["src", "lib", "config", "tests"],
      crossModuleDependencies: ["auth → api"],
      hasPublicApiChanges: true,
      hasMigrationChanges: true,
    }
    assert.equal(chooseCodeReviewTier(ctx), "+system")
  })

  it("should still return +logic when multiple logic conditions met but system not flagged", () => {
    const ctx: CodeReviewTierContext = {
      executionGroups: [{ reviewTags: "logic" }],
      verificationText: "performance-critical path",
      modifiedFiles: ["src/concurrency/worker.ts", "src/algorithm/sort.ts"],
      hasAlgorithmicRisk: true,
    }
    assert.equal(chooseCodeReviewTier(ctx), "+logic")
  })

  it("should handle empty arrays correctly", () => {
    const ctx: CodeReviewTierContext = {
      executionGroups: [],
      modifiedFiles: [],
      modifiedDirectories: [],
      crossModuleDependencies: [],
    }
    assert.equal(chooseCodeReviewTier(ctx), "standard")
  })

  it("should handle undefined fields correctly", () => {
    const ctx: CodeReviewTierContext = {
      executionGroups: [{ reviewTags: undefined }],
      modifiedFiles: undefined,
      modifiedDirectories: undefined,
      crossModuleDependencies: undefined,
    }
    assert.equal(chooseCodeReviewTier(ctx), "standard")
  })

  // ── reviewTags as array in execution group ──────────────────

  it("should handle reviewTags as array with logic", () => {
    const ctx: CodeReviewTierContext = {
      executionGroups: [{ reviewTags: ["logic"] }],
    }
    assert.equal(chooseCodeReviewTier(ctx), "+logic")
  })

  it("should handle reviewTags as array with system", () => {
    const ctx: CodeReviewTierContext = {
      executionGroups: [{ reviewTags: ["system"] }],
    }
    assert.equal(chooseCodeReviewTier(ctx), "+system")
  })

  it("should handle reviewTags as array with both tags across groups", () => {
    const ctx: CodeReviewTierContext = {
      executionGroups: [
        { reviewTags: ["logic"] },
        { reviewTags: ["system"] },
      ],
    }
    assert.equal(chooseCodeReviewTier(ctx), "+full")
  })
})

// ═══════════════════════════════════════════════════════════════
// Raw reviewer artifact preservation
// ═══════════════════════════════════════════════════════════════

void describe("resolveReviewerArtifactDir", () => {
  it("should return the correct path pattern", () => {
    const result = resolveReviewerArtifactDir("rev-test-001", "correctness", "/tmp/pi-test")
    assert.ok(result.endsWith("/runs/rev-test-001/review-artifacts/correctness.md"))
    assert.ok(result.includes("correctness.md"))
  })

  it("should handle different reviewer names", () => {
    const result = resolveReviewerArtifactDir("rev-test-001", "integration", "/tmp/pi-test")
    assert.ok(result.endsWith("integration.md"))
    assert.ok(result.includes("review-artifacts"))
  })
})

void describe("persistReviewerRawOutput", () => {
  it("should create file at correct path", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "art-test-"))
    const runId = "rev-test-save"

    const fp = await persistReviewerRawOutput(runId, "security", "No issues found.", dir)

    assert.ok(fp.endsWith(`/runs/${runId}/review-artifacts/security.md`))
    const exists = await fs.stat(fp).then(() => true).catch(() => false)
    assert.ok(exists)

    await fs.rm(path.join(dir, "runs"), { recursive: true, force: true }).catch(() => {})
    await fs.rmdir(dir).catch(() => {})
  })

  it("should create parent directories automatically", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "art-test-"))
    const deepDir = path.join(dir, "deep", "nested")

    const fp = await persistReviewerRawOutput("run-deep", "correctness", "output", deepDir)

    const exists = await fs.stat(fp).then(() => true).catch(() => false)
    assert.ok(exists)

    await fs.rm(path.join(deepDir, "runs"), { recursive: true, force: true }).catch(() => {})
    await fs.rm(deepDir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  })
})

void describe("loadReviewerRawOutput", () => {
  it("should read back written content", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "load-test-"))

    await persistReviewerRawOutput("run-load", "integration", "Test output content", dir)

    const loaded = await loadReviewerRawOutput("run-load", "integration", dir)
    assert.equal(loaded, "Test output content")

    await fs.rm(path.join(dir, "runs"), { recursive: true, force: true }).catch(() => {})
    await fs.rmdir(dir).catch(() => {})
  })

  it("should return null for missing file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "load-miss-"))

    const loaded = await loadReviewerRawOutput("run-miss", "nonexistent", dir)
    assert.equal(loaded, null)

    await fs.rmdir(dir).catch(() => {})
  })
})

void describe("resolveAllReviewerArtifacts", () => {
  it("should return list of artifacts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "list-test-"))

    await persistReviewerRawOutput("run-list", "correctness", "content", dir)
    await persistReviewerRawOutput("run-list", "integration", "content", dir)

    const artifacts = resolveAllReviewerArtifacts("run-list", dir)

    assert.equal(artifacts.length, 2)
    assert.ok(artifacts.some((a) => a.name === "correctness"))
    assert.ok(artifacts.some((a) => a.name === "integration"))
    assert.ok(artifacts[0].path.endsWith(".md"))

    await fs.rm(path.join(dir, "runs"), { recursive: true, force: true }).catch(() => {})
    await fs.rmdir(dir).catch(() => {})
  })

  it("should return empty array for no artifacts", () => {
    const dir = "/tmp/nonexistent-artifact-dir-test"
    const artifacts = resolveAllReviewerArtifacts("run-empty", dir)
    assert.deepEqual(artifacts, [])
  })

  it("should return sorted results", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sort-test-"))

    await persistReviewerRawOutput("run-sort", "system", "content", dir)
    await persistReviewerRawOutput("run-sort", "correctness", "content", dir)
    await persistReviewerRawOutput("run-sort", "integration", "content", dir)
    await persistReviewerRawOutput("run-sort", "security", "content", dir)

    const artifacts = resolveAllReviewerArtifacts("run-sort", dir)

    assert.equal(artifacts.length, 4)
    assert.equal(artifacts[0].name, "correctness")
    assert.equal(artifacts[1].name, "integration")
    assert.equal(artifacts[2].name, "security")
    assert.equal(artifacts[3].name, "system")

    await fs.rm(path.join(dir, "runs"), { recursive: true, force: true }).catch(() => {})
    await fs.rmdir(dir).catch(() => {})
  })
})

void describe("addFindingTraceability", () => {
  it("should add artifactPath to findings", () => {
    const findings: CodeReviewFinding[] = [
      {
        severity: "major",
        title: "Missing validation",
        reviewerSupport: ["correctness", "security"],
        evidence: "src/auth.ts:10",
        whyItMatters: "Security risk",
        recommendation: "Add validation",
      },
    ]

    const result = addFindingTraceability(findings, "rev-trace-001", "/tmp/pi")

    assert.equal(result.length, 1)
    assert.ok(result[0].artifactPath)
    assert.ok(result[0].artifactPath!.includes("correctness.md"))
    assert.equal(result[0].runId, "rev-trace-001")
  })

  it("should preserve existing finding fields", () => {
    const findings: CodeReviewFinding[] = [
      {
        severity: "minor",
        title: "Unused import",
        reviewerSupport: ["correctness"],
        evidence: "src/util.ts:5",
        whyItMatters: "Clean code",
        recommendation: "Remove import",
        artifactPath: "/custom/path/artifact.md",
        runId: "existing-run",
      },
    ]

    const result = addFindingTraceability(findings, "new-run", "/tmp/pi")

    assert.equal(result[0].artifactPath, "/custom/path/artifact.md")
    assert.equal(result[0].runId, "existing-run")
    assert.equal(result[0].title, "Unused import")
    assert.equal(result[0].severity, "minor")
  })

  it("should use first supporter for artifact path", () => {
    const findings: CodeReviewFinding[] = [
      {
        severity: "critical",
        title: "Auth bypass",
        reviewerSupport: ["security", "correctness", "integration"],
        evidence: "src/auth.ts:50",
        whyItMatters: "Complete bypass",
        recommendation: "Fix logic",
      },
    ]

    const result = addFindingTraceability(findings, "rev-trace-002", "/tmp")

    assert.ok(result[0].artifactPath!.includes("security.md"))
    assert.equal(result[0].runId, "rev-trace-002")
  })

  it("should handle findings with empty reviewerSupport", () => {
    const findings: CodeReviewFinding[] = [
      {
        severity: "nit",
        title: "Minor style issue",
        reviewerSupport: [],
        evidence: "src/style.ts:1",
        whyItMatters: "Consistency",
        recommendation: "Format code",
      },
    ]

    const result = addFindingTraceability(findings, "rev-trace-003", "/tmp")

    assert.equal(result[0].artifactPath, undefined)
    assert.equal(result[0].runId, "rev-trace-003")
  })

  it("should not mutate the original findings array", () => {
    const findings: CodeReviewFinding[] = [
      {
        severity: "major",
        title: "Test",
        reviewerSupport: ["correctness"],
        evidence: "src/test.ts:1",
        whyItMatters: "Test",
        recommendation: "Fix",
      },
    ]

    const result = addFindingTraceability(findings, "rev-trace-004", "/tmp")

    assert.notStrictEqual(result, findings)
    assert.equal(findings[0].artifactPath, undefined)
    assert.equal(findings[0].runId, undefined)
  })
})
