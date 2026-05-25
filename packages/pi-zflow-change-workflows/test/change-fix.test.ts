/**
 * Tests for the unified /zflow-change-fix workflow.
 *
 * Covers:
 * - parseReviewFindings parses findings correctly
 * - buildFixPlan includes all selected findings
 * - buildFixPlan includes file paths and verification
 * - parseReviewFindings handles empty findings file
 */
import * as assert from "node:assert/strict"
import { describe, it, before, after } from "node:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

// ── Fixtures ─────────────────────────────────────────────────────

const VALID_FINDINGS_MD = `# Code Review Findings

**Source**: Implementation of feat-auth
**Run ID**: run-123

## Reviewed Changes

- src/auth/login.ts
- src/auth/types.ts

## Coverage Notes

- correctness: ✅ executed
- integration: ✅ executed
- security: ✅ executed

## Findings Summary

| Severity | Count |
| -------- | ----- |
| Critical | 1 |
| Major    | 1 |
| Minor    | 1 |
| Nit      | 1 |

## Critical Findings

### Missing input validation in login handler

**Reviewer support**: correctness
**Evidence**: The login endpoint accepts raw user input without any validation. An empty password or SQL injection in the username field would bypass authentication.
**Why it matters**: This is a critical security vulnerability that could allow unauthorized access.
**Recommendation**: Add input validation for both username and password fields. Sanitize inputs before database queries.
**File**: \`src/auth/login.ts\`
**Lines**: 42

## Major Findings

### Inconsistent error response format

**Reviewer support**: integration
**Evidence**: Error responses use different JSON shapes: some return {error: "msg"}, others {message: "msg", code: 500}.
**Why it matters**: API consumers cannot reliably parse error responses. Causes client-side errors.
**Recommendation**: Standardize on a single error response format: {error: string, code: number, details?: object}.
**File**: \`src/auth/types.ts\`

## Minor Findings

### Unused import in types file

**Reviewer support**: correctness
**Evidence**: The \`bcrypt\` import in src/auth/types.ts is declared but never used.
**Why it matters**: Unused imports clutter the codebase and may cause false positives in dependency scanning.
**Recommendation**: Remove the unused bcrypt import.
**File**: \`src/auth/types.ts\`
**Lines**: 1

## Nits

### Comment typo

**Reviewer support**: integration
**Evidence**: Line 15 of login.ts has a comment with "authenitcation" instead of "authentication".
**Why it matters**: Minor — does not affect functionality.
**Recommendation**: Fix the typo.
**File**: \`src/auth/login.ts\`
**Lines**: 15
`

const FINDINGS_WITHOUT_FINDINGS = `# Code Review Findings

**Source**: Implementation of feat-auth

## Reviewed Changes

None.

## Coverage Notes

No findings produced.

## Findings Summary

None.

## Recommendation

GO
`

// ── Tests ────────────────────────────────────────────────────────

describe("parseReviewFindings", () => {
  let tmpDir: string

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "zflow-test-fix-"))
    // Create .zflow structure
    const artDir = join(tmpDir, ".zflow")
    await mkdir(artDir, { recursive: true })
  })

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("parses findings with all fields from valid markdown", async () => {
    const reviewDir = join(tmpDir, ".zflow", "review")
    await mkdir(reviewDir, { recursive: true })
    await writeFile(join(reviewDir, "code-review-findings.md"), VALID_FINDINGS_MD, "utf-8")

    // Create minimal git structure for path resolution
    const { execFileSync } = await import("node:child_process")
    try {
      execFileSync("git", ["init"], { cwd: tmpDir, stdio: "pipe" })
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir, stdio: "pipe" })
      execFileSync("git", ["config", "user.name", "Test"], { cwd: tmpDir, stdio: "pipe" })
    } catch {
      // git may not be available in test env
    }

    const { parseReviewFindings } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    const { findings, rawPath } = await parseReviewFindings(tmpDir)

    assert.equal(findings.length, 4, "Expected 4 findings to be parsed")

    // Check critical finding
    const critical = findings.find(f => f.severity === "critical")
    assert.ok(critical, "Expected critical finding")
    assert.equal(critical!.title, "Missing input validation in login handler")
    assert.equal(critical!.file, "src/auth/login.ts")
    assert.equal(critical!.line, 42)
    assert.equal(critical!.reviewerRole, "correctness")
    assert.ok(critical!.evidence.includes("input validation"), "Evidence should mention input validation")
    assert.ok(critical!.recommendation.includes("input validation"), "Recommendation should mention fix")

    // Check major finding
    const major = findings.find(f => f.severity === "major")
    assert.ok(major, "Expected major finding")
    assert.equal(major!.title, "Inconsistent error response format")
    assert.equal(major!.file, "src/auth/types.ts")

    // Check finding IDs
    assert.ok(critical!.findingId, "Finding should have an ID")
    assert.ok(critical!.findingId.startsWith("finding-"), "Finding ID should start with 'finding-'")
  })

  it("returns empty array for findings file with no findings", async () => {
    const reviewDir = join(tmpDir, ".zflow", "review")
    await mkdir(reviewDir, { recursive: true })
    await writeFile(join(reviewDir, "code-review-findings.md"), FINDINGS_WITHOUT_FINDINGS, "utf-8")

    const { parseReviewFindings } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    const { findings } = await parseReviewFindings(tmpDir)
    assert.equal(findings.length, 0, "Expected 0 findings")
  })

  it("returns empty array when findings file does not exist", async () => {
    const { parseReviewFindings } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    const { findings } = await parseReviewFindings(tmpDir)
    assert.equal(findings.length, 0, "Expected 0 findings when no file exists")
  })
})

describe("buildFixPlan", () => {
  it("includes all selected findings in the plan", async () => {
    const { parseReviewFindings, buildFixPlan } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )

    // Create a minimal review dir with findings
    const tmpDir2 = await mkdtemp(join(tmpdir(), "zflow-test-build-"))
    const reviewDir = join(tmpDir2, ".zflow", "review")
    await mkdir(reviewDir, { recursive: true })
    await writeFile(join(reviewDir, "code-review-findings.md"), VALID_FINDINGS_MD, "utf-8")
    try {
      const { execFileSync } = await import("node:child_process")
      execFileSync("git", ["init"], { cwd: tmpDir2, stdio: "pipe" })
    } catch { /* ok */ }

    const { findings } = await parseReviewFindings(tmpDir2)
    assert.ok(findings.length > 0, "Need at least 1 finding")

    // Build plan with all findings
    const plan = await buildFixPlan("test-change", findings, tmpDir2)
    assert.ok(plan.includes("Fix Plan for test-change"), "Plan should include change ID")
    assert.ok(plan.includes("Findings to fix:"), "Plan should include count")

    // Each finding should be included
    for (const finding of findings) {
      assert.ok(plan.includes(finding.findingId), `Plan should include ${finding.findingId}`)
      assert.ok(plan.includes(finding.title), `Plan should include title "${finding.title}"`)
    }
  })

  it("includes target files from findings", async () => {
    const { parseReviewFindings, buildFixPlan } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    const tmpDir3 = await mkdtemp(join(tmpdir(), "zflow-test-files-"))
    const reviewDir = join(tmpDir3, ".zflow", "review")
    await mkdir(reviewDir, { recursive: true })
    await writeFile(join(reviewDir, "code-review-findings.md"), VALID_FINDINGS_MD, "utf-8")
    try {
      const { execFileSync } = await import("node:child_process")
      execFileSync("git", ["init"], { cwd: tmpDir3, stdio: "pipe" })
    } catch { /* ok */ }

    const { findings } = await parseReviewFindings(tmpDir3)
    const plan = await buildFixPlan("test-change", [findings[0]], tmpDir3)

    assert.ok(plan.includes("## Target Files"), "Plan should have Target Files section")
    assert.ok(plan.includes("src/auth/login.ts"), "Plan should include login.ts")
    await rm(tmpDir3, { recursive: true, force: true })
  })

  it("includes severity counts in the plan", async () => {
    const { parseReviewFindings, buildFixPlan } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    const tmpDir4 = await mkdtemp(join(tmpdir(), "zflow-test-sev-"))
    const reviewDir = join(tmpDir4, ".zflow", "review")
    await mkdir(reviewDir, { recursive: true })
    await writeFile(join(reviewDir, "code-review-findings.md"), VALID_FINDINGS_MD, "utf-8")
    try {
      const { execFileSync } = await import("node:child_process")
      execFileSync("git", ["init"], { cwd: tmpDir4, stdio: "pipe" })
    } catch { /* ok */ }

    const { findings } = await parseReviewFindings(tmpDir4)
    const plan = await buildFixPlan("test-change", findings, tmpDir4)

    assert.ok(plan.includes("1/1/1/1"), "Plan should show severity counts (crit/maj/min/nit)")
    await rm(tmpDir4, { recursive: true, force: true })
  })

  it("works with an empty findings array", async () => {
    const { buildFixPlan } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    const plan = await buildFixPlan("test-change", [])
    assert.ok(plan.includes("Fix Plan for test-change"))
    assert.ok(plan.includes("0/0/0/0"), "Should show 0/0/0/0 for empty findings")
  })
})
