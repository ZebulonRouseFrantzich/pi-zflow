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
} from "../extensions/zflow-review/findings.js"

import { createManifest, recordExecuted, recordSkipped, recordFailed } from "../src/reviewer-manifest.js"

import type { CodeReviewFinding, CodeReviewFindingsInput } from "../extensions/zflow-review/findings.js"
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
