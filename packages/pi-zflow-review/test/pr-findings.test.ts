/**
 * pr-findings.test.ts — Tests for PR/MR review findings persistence.
 *
 * Covers:
 *   - formatPrSeveritySummary: counts, zeros, markdown headers
 *   - formatPrFindingsBySeverity: headings, file, lines, submit checkbox,
 *     empty sections, ordering, editedBody
 *   - persistPrReviewFindings: path, PR URL, SHAs, coverage notes,
 *     severity summary, grouped findings, directory creation,
 *     empty findings, submit checkboxes
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

import {
  formatPrSeveritySummary,
  formatPrFindingsBySeverity,
  persistPrReviewFindings,
} from "../extensions/zflow-review/findings.js"

import type {
  PrReviewFinding,
  PrReviewFindingsInput,
} from "../extensions/zflow-review/findings.js"

// ── Helpers ────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pr-findings-test-"))
}

function makeMinimalInput(overrides?: Partial<PrReviewFindingsInput>): PrReviewFindingsInput {
  return {
    prMetadata: {
      url: "https://github.com/owner/repo/pull/42",
      platform: "github",
      headSha: "abc123",
      baseSha: "def456",
    },
    runId: "pr-test-001",
    coverageNotes: ["Diff-only review (no code execution)"],
    findings: [],
    wasChunked: false,
    submissionAvailable: true,
    ...overrides,
  }
}

// ── formatPrSeveritySummary ────────────────────────────────────

void describe("formatPrSeveritySummary", () => {
  it("should show zeros when no findings present", () => {
    const result = formatPrSeveritySummary([])
    assert.ok(result.includes("| Severity | Count |"))
    assert.ok(result.includes("| Critical | 0 |"))
    assert.ok(result.includes("| Major    | 0 |"))
    assert.ok(result.includes("| Minor    | 0 |"))
    assert.ok(result.includes("| Nit      | 0 |"))
  })

  it("should count findings by severity correctly", () => {
    const findings: PrReviewFinding[] = [
      { severity: "critical", title: "C1", file: "a.ts", evidence: "e", recommendation: "r", submit: true },
      { severity: "critical", title: "C2", file: "b.ts", evidence: "e", recommendation: "r", submit: true },
      { severity: "major", title: "M1", file: "c.ts", evidence: "e", recommendation: "r", submit: false },
      { severity: "minor", title: "m1", file: "d.ts", evidence: "e", recommendation: "r", submit: true },
      { severity: "nit", title: "n1", file: "e.ts", evidence: "e", recommendation: "r", submit: false },
    ]
    const result = formatPrSeveritySummary(findings)
    assert.ok(result.includes("| Critical | 2 |"))
    assert.ok(result.includes("| Major    | 1 |"))
    assert.ok(result.includes("| Minor    | 1 |"))
    assert.ok(result.includes("| Nit      | 1 |"))
  })

  it("should include markdown table headers", () => {
    const result = formatPrSeveritySummary([])
    assert.ok(result.includes("| Severity | Count |"))
    assert.ok(result.includes("| -------- | ----- |"))
  })
})

// ── formatPrFindingsBySeverity ─────────────────────────────────

void describe("formatPrFindingsBySeverity", () => {
  it("should render headings for each severity level", () => {
    const findings: PrReviewFinding[] = [
      { severity: "critical", title: "C1", file: "a.ts", lines: "10-20", evidence: "e", recommendation: "r", submit: true },
    ]
    const result = formatPrFindingsBySeverity(findings)
    assert.ok(result.includes("## Critical Findings"))
    assert.ok(result.includes("## Major Findings"))
    assert.ok(result.includes("## Minor Findings"))
    assert.ok(result.includes("## Nits"))
  })

  it("should include file path in finding entry", () => {
    const findings: PrReviewFinding[] = [
      { severity: "major", title: "Bad null check", file: "src/webhook.ts", evidence: "direct access before guard", recommendation: "add guard", submit: true },
    ]
    const result = formatPrFindingsBySeverity(findings)
    assert.ok(result.includes("**File**: src/webhook.ts"))
  })

  it("should include lines when present", () => {
    const findings: PrReviewFinding[] = [
      { severity: "major", title: "Missing guard", file: "src/webhook.ts", lines: "120-127", evidence: "e", recommendation: "r", submit: true },
    ]
    const result = formatPrFindingsBySeverity(findings)
    assert.ok(result.includes("**Lines**: 120-127"))
  })

  it("should include submit checkbox", () => {
    const findings: PrReviewFinding[] = [
      { severity: "minor", title: "Style nit", file: "a.ts", evidence: "e", recommendation: "r", submit: true },
    ]
    const result = formatPrFindingsBySeverity(findings)
    assert.ok(result.includes("**Submit**: [ ] (pending)"))
  })

  it("should show pending indicator for submit=true", () => {
    const findings: PrReviewFinding[] = [
      { severity: "minor", title: "Style", file: "a.ts", evidence: "e", recommendation: "r", submit: true },
    ]
    const result = formatPrFindingsBySeverity(findings)
    assert.ok(result.includes("[ ] (pending)"))
  })

  it("should show unchecked for submit=false", () => {
    const findings: PrReviewFinding[] = [
      { severity: "minor", title: "Style", file: "a.ts", evidence: "e", recommendation: "r", submit: false },
    ]
    const result = formatPrFindingsBySeverity(findings)
    assert.ok(result.includes("**Submit**: [ ]"))
  })

  it("should include editedBody when present", () => {
    const findings: PrReviewFinding[] = [
      { severity: "major", title: "Guard missing", file: "a.ts", evidence: "e", recommendation: "r", submit: true, editedBody: "Please add input validation here..." },
    ]
    const result = formatPrFindingsBySeverity(findings)
    assert.ok(result.includes("**Edited body**: Please add input validation here..."))
  })

  it("should say None. for empty severity sections", () => {
    const findings: PrReviewFinding[] = []
    const result = formatPrFindingsBySeverity(findings)
    // All sections should show None.
    assert.ok(result.includes("None."))
  })

  it("should order findings by severity", () => {
    const findings: PrReviewFinding[] = [
      { severity: "nit", title: "N1", file: "a.ts", evidence: "e", recommendation: "r", submit: false },
      { severity: "critical", title: "C1", file: "b.ts", evidence: "e", recommendation: "r", submit: true },
      { severity: "major", title: "M1", file: "c.ts", evidence: "e", recommendation: "r", submit: true },
    ]
    const result = formatPrFindingsBySeverity(findings)
    const criticalIdx = result.indexOf("C1")
    const majorIdx = result.indexOf("M1")
    const nitIdx = result.indexOf("N1")
    assert.ok(criticalIdx < majorIdx, "critical should come before major")
    assert.ok(majorIdx < nitIdx, "major should come before nit")
  })
})

// ── persistPrReviewFindings ────────────────────────────────────

void describe("persistPrReviewFindings", () => {
  it("should create a file at the expected path", async () => {
    const tmpDir = createTempDir()
    try {
      const input = makeMinimalInput({ cwd: tmpDir })
      const fp = await persistPrReviewFindings(input)
      assert.ok(fp.endsWith("pr-review-pr-test-001.md"), `unexpected path: ${fp}`)
      assert.ok(fs.existsSync(fp), "file should exist")
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("should contain the PR URL", async () => {
    const tmpDir = createTempDir()
    try {
      const input = makeMinimalInput({ cwd: tmpDir })
      const fp = await persistPrReviewFindings(input)
      const content = fs.readFileSync(fp, "utf-8")
      assert.ok(content.includes("https://github.com/owner/repo/pull/42"))
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("should contain head and base SHA", async () => {
    const tmpDir = createTempDir()
    try {
      const input = makeMinimalInput({ cwd: tmpDir })
      const fp = await persistPrReviewFindings(input)
      const content = fs.readFileSync(fp, "utf-8")
      assert.ok(content.includes("abc123"))
      assert.ok(content.includes("def456"))
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("should contain coverage notes", async () => {
    const tmpDir = createTempDir()
    try {
      const input = makeMinimalInput({
        cwd: tmpDir,
        coverageNotes: ["Custom coverage note here"],
      })
      const fp = await persistPrReviewFindings(input)
      const content = fs.readFileSync(fp, "utf-8")
      assert.ok(content.includes("Custom coverage note here"))
      assert.ok(content.includes("Diff-only review"))
      assert.ok(content.includes("Chunked: no"))
      assert.ok(content.includes("Submission available: yes"))
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("should contain severity summary table", async () => {
    const tmpDir = createTempDir()
    try {
      const findings: PrReviewFinding[] = [
        { severity: "critical", title: "C1", file: "a.ts", evidence: "e", recommendation: "r", submit: true },
      ]
      const input = makeMinimalInput({ cwd: tmpDir, findings })
      const fp = await persistPrReviewFindings(input)
      const content = fs.readFileSync(fp, "utf-8")
      assert.ok(content.includes("## Findings Summary"))
      assert.ok(content.includes("| Critical | 1 |"))
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("should group findings by severity", async () => {
    const tmpDir = createTempDir()
    try {
      const findings: PrReviewFinding[] = [
        { severity: "nit", title: "N1", file: "a.ts", evidence: "e", recommendation: "r", submit: false },
        { severity: "critical", title: "C1", file: "b.ts", evidence: "e", recommendation: "r", submit: true },
      ]
      const input = makeMinimalInput({ cwd: tmpDir, findings })
      const fp = await persistPrReviewFindings(input)
      const content = fs.readFileSync(fp, "utf-8")
      // Critical should come before Nits
      const criticalIdx = content.indexOf("## Critical Findings")
      const nitsIdx = content.indexOf("## Nits")
      assert.ok(criticalIdx < nitsIdx, "critical section should come before nits")
      assert.ok(content.includes("### C1"))
      assert.ok(content.includes("### N1"))
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("should contain submit checkboxes for findings", async () => {
    const tmpDir = createTempDir()
    try {
      const findings: PrReviewFinding[] = [
        { severity: "major", title: "M1", file: "a.ts", evidence: "e", recommendation: "r", submit: true },
      ]
      const input = makeMinimalInput({ cwd: tmpDir, findings })
      const fp = await persistPrReviewFindings(input)
      const content = fs.readFileSync(fp, "utf-8")
      assert.ok(content.includes("**Submit**: [ ]"))
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("should create parent directories automatically", async () => {
    const tmpDir = createTempDir()
    try {
      const nestedDir = path.join(tmpDir, "deep", "nested")
      const input = makeMinimalInput({ cwd: nestedDir })
      const fp = await persistPrReviewFindings(input)
      assert.ok(fs.existsSync(fp), "file should exist in nested directory")
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("should handle empty findings gracefully", async () => {
    const tmpDir = createTempDir()
    try {
      const input = makeMinimalInput({ cwd: tmpDir, findings: [] })
      const fp = await persistPrReviewFindings(input)
      const content = fs.readFileSync(fp, "utf-8")
      assert.ok(content.includes("None."))
      assert.ok(content.includes("| Critical | 0 |"))
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("should include platform in header", async () => {
    const tmpDir = createTempDir()
    try {
      const input = makeMinimalInput({ cwd: tmpDir })
      const fp = await persistPrReviewFindings(input)
      const content = fs.readFileSync(fp, "utf-8")
      assert.ok(content.includes("**Platform**: github"))
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("should include run ID in header", async () => {
    const tmpDir = createTempDir()
    try {
      const input = makeMinimalInput({ cwd: tmpDir, runId: "custom-run-123" })
      const fp = await persistPrReviewFindings(input)
      const content = fs.readFileSync(fp, "utf-8")
      assert.ok(content.includes("custom-run-123"))
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("should handle GitLab platform", async () => {
    const tmpDir = createTempDir()
    try {
      const input = makeMinimalInput({
        cwd: tmpDir,
        prMetadata: {
          url: "https://gitlab.com/owner/repo/-/merge_requests/7",
          platform: "gitlab",
          headSha: "ghi789",
          baseSha: "jkl012",
        },
      })
      const fp = await persistPrReviewFindings(input)
      const content = fs.readFileSync(fp, "utf-8")
      assert.ok(content.includes("**Platform**: gitlab"))
      assert.ok(content.includes("**Head SHA**: ghi789"))
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("should indicate chunked when wasChunked is true", async () => {
    const tmpDir = createTempDir()
    try {
      const input = makeMinimalInput({ cwd: tmpDir, wasChunked: true })
      const fp = await persistPrReviewFindings(input)
      const content = fs.readFileSync(fp, "utf-8")
      assert.ok(content.includes("Chunked: yes"))
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("should indicate submission unavailable when missing auth", async () => {
    const tmpDir = createTempDir()
    try {
      const input = makeMinimalInput({ cwd: tmpDir, submissionAvailable: false })
      const fp = await persistPrReviewFindings(input)
      const content = fs.readFileSync(fp, "utf-8")
      assert.ok(content.includes("Submission available: no"))
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("should include file and lines in finding entries", async () => {
    const tmpDir = createTempDir()
    try {
      const findings: PrReviewFinding[] = [
        {
          severity: "major",
          title: "Missing null guard",
          file: "src/webhook.ts",
          lines: "120-127",
          evidence: "diff introduces direct access before guard",
          recommendation: "guard payload.event before field access",
          submit: true,
        },
      ]
      const input = makeMinimalInput({ cwd: tmpDir, findings })
      const fp = await persistPrReviewFindings(input)
      const content = fs.readFileSync(fp, "utf-8")
      assert.ok(content.includes("**File**: src/webhook.ts"))
      assert.ok(content.includes("**Lines**: 120-127"))
      assert.ok(content.includes("**Evidence**: diff introduces direct access before guard"))
      assert.ok(content.includes("**Recommendation**: guard payload.event before field access"))
      assert.ok(content.includes("**Submit**: [ ] (pending)"))
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
