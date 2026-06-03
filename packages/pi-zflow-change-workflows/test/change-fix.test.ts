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
import { describe, it } from "node:test"
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

describe("parseReviewFindings", { concurrency: false }, () => {
  it("parses findings with all fields from valid markdown", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "zflow-test-fix-valid-"))
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

    try {
      const { parseReviewFindings } = await import(
        "../extensions/zflow-change-workflows/orchestration.js"
      )
      const { findings, rawPath } = await parseReviewFindings(tmpDir)

      assert.equal(findings.length, 4, "Expected 4 findings to be parsed")
      assert.ok(rawPath.endsWith("code-review-findings.md"))

      // Check critical finding
      const critical = findings.find(f => f.severity === "critical")
      assert.ok(critical, "Expected critical finding")
      assert.equal(critical!.title, "Missing input validation in login handler")
      assert.equal(critical!.file, "src/auth/login.ts")
      assert.equal(critical!.line, 42)
      assert.equal(critical!.reviewerRole, "correctness")
      assert.ok(critical!.evidence.includes("validation"), "Evidence should mention validation")
      assert.ok(critical!.recommendation.includes("input validation"), "Recommendation should mention fix")

      // Check major finding
      const major = findings.find(f => f.severity === "major")
      assert.ok(major, "Expected major finding")
      assert.equal(major!.title, "Inconsistent error response format")
      assert.equal(major!.file, "src/auth/types.ts")

      // Check finding IDs
      assert.ok(critical!.findingId, "Finding should have an ID")
      assert.ok(critical!.findingId.startsWith("finding-"), "Finding ID should start with 'finding-'")
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it("returns empty array for findings file with no findings", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "zflow-test-fix-empty-"))
    const reviewDir = join(tmpDir, ".zflow", "review")
    await mkdir(reviewDir, { recursive: true })
    await writeFile(join(reviewDir, "code-review-findings.md"), FINDINGS_WITHOUT_FINDINGS, "utf-8")

    try {
      const { parseReviewFindings } = await import(
        "../extensions/zflow-change-workflows/orchestration.js"
      )
      const { findings } = await parseReviewFindings(tmpDir)
      assert.equal(findings.length, 0, "Expected 0 findings")
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it("returns empty array when findings file does not exist", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "zflow-test-fix-missing-"))
    try {
      const { parseReviewFindings } = await import(
        "../extensions/zflow-change-workflows/orchestration.js"
      )
      const { findings } = await parseReviewFindings(tmpDir)
      assert.equal(findings.length, 0, "Expected 0 findings when no file exists")
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })
})

describe("buildFixPlan", { concurrency: false }, () => {
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

// ── normalizeFindingsSource tests ───────────────────────────────

describe("normalizeFindingsSource", { concurrency: false }, () => {
  it('extracts change ID from "Implementation of X" format', async () => {
    const { normalizeFindingsSource } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    assert.equal(
      normalizeFindingsSource("Implementation of cloudflare-phase-1-tooling-scaffold"),
      "cloudflare-phase-1-tooling-scaffold",
    )
    assert.equal(
      normalizeFindingsSource("Implementation of phase-4-d1-control-plane"),
      "phase-4-d1-control-plane",
    )
    assert.equal(
      normalizeFindingsSource("Implementation of feat-auth"),
      "feat-auth",
    )
  })

  it('extracts change ID from "Code review for X" format', async () => {
    const { normalizeFindingsSource } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    assert.equal(
      normalizeFindingsSource("Code review for feat-auth"),
      "feat-auth",
    )
    assert.equal(
      normalizeFindingsSource("Code review of phase-3-auth"),
      "phase-3-auth",
    )
  })

  it("returns kebab-case directly when already a valid ID", async () => {
    const { normalizeFindingsSource } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    assert.equal(normalizeFindingsSource("feat-auth"), "feat-auth")
    assert.equal(normalizeFindingsSource("phase-4-d1-control-plane"), "phase-4-d1-control-plane")
    assert.equal(normalizeFindingsSource("simple"), "simple")
  })

  it("returns undefined for empty string", async () => {
    const { normalizeFindingsSource } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    assert.equal(normalizeFindingsSource(""), undefined)
    assert.equal(normalizeFindingsSource("   "), undefined)
  })
})

// ── assertFindingsMatchChange tests ─────────────────────────────

describe("assertFindingsMatchChange", { concurrency: false }, () => {
  it("does not throw when source matches requested change", async () => {
    const { assertFindingsMatchChange } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    assertFindingsMatchChange(
      "feat-auth",
      { sourceChangeId: "feat-auth", rawSource: "Implementation of feat-auth", runId: "run-123" },
      "/tmp/findings.md",
    )
  })

  it("does not throw when no source metadata is available", async () => {
    const { assertFindingsMatchChange } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    assertFindingsMatchChange(
      "feat-auth",
      { sourceChangeId: undefined, rawSource: undefined, runId: undefined },
      "/tmp/findings.md",
    )
  })

  it("throws with actionable error when findings are for a different change", async () => {
    const { assertFindingsMatchChange } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    assert.throws(
      () => assertFindingsMatchChange(
        "phase-4-d1-control-plane",
        {
          sourceChangeId: "cloudflare-phase-1-tooling-scaffold",
          rawSource: "Implementation of cloudflare-phase-1-tooling-scaffold",
          runId: "rev-mpygbt2y-0004",
        },
        "/tmp/.zflow/review/code-review-findings.md",
      ),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        return (
          msg.includes("phase-4-d1-control-plane") &&
          msg.includes("cloudflare-phase-1-tooling-scaffold") &&
          msg.includes("rev-mpygbt2y-0004") &&
          msg.includes("/tmp/.zflow/review/code-review-findings.md") &&
          msg.includes("Findings source mismatch")
        )
      },
    )
  })
})

// ── parseReviewFindings metadata extraction tests ───────────────

describe("parseReviewFindings metadata", { concurrency: false }, () => {
  const FINDINGS_WITH_METADATA = `# Code Review Findings

**Source**: Implementation of feat-auth
**Run ID**: run-abc-123

## Reviewed Changes

- src/auth/login.ts

## Coverage Notes

- correctness: ✅ executed

## Findings Summary

| Severity | Count |
| -------- | ----- |
| Major | 1 |

## Major Findings

### Inconsistent error response format

**Reviewer support**: integration
**Evidence**: Error responses use different JSON shapes.
**Why it matters**: API consumers cannot reliably parse errors.
**Recommendation**: Standardize error format.
**File**: \`src/auth/types.ts\`
`

  it("extracts sourceChangeId from the Source header", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "zflow-test-meta-1-"))
    const reviewDir = join(tmpDir, ".zflow", "review")
    await mkdir(reviewDir, { recursive: true })
    await writeFile(join(reviewDir, "code-review-findings.md"), FINDINGS_WITH_METADATA, "utf-8")
    try {
      const { execFileSync } = await import("node:child_process")
      try { execFileSync("git", ["init"], { cwd: tmpDir, stdio: "pipe" }) } catch { /* ok */ }
    } catch { /* ok */ }

    try {
      const { parseReviewFindings } = await import(
        "../extensions/zflow-change-workflows/orchestration.js"
      )
      const { metadata, findings } = await parseReviewFindings(tmpDir)

      assert.ok(metadata, "metadata should be present")
      assert.equal(metadata.sourceChangeId, "feat-auth")
      assert.equal(metadata.rawSource, "Implementation of feat-auth")
      assert.equal(metadata.runId, "run-abc-123")
      assert.equal(findings.length, 1, "Should still parse findings")
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it("metadata is empty when findings file has no Source header", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "zflow-test-meta-2-"))
    const reviewDir = join(tmpDir, ".zflow", "review")
    await mkdir(reviewDir, { recursive: true })
    await writeFile(join(reviewDir, "code-review-findings.md"), `# Code Review Findings

## Coverage Notes

- correctness: ✅ executed

## Findings Summary

None.

## Recommendation

GO
`, "utf-8")
    try {
      const { execFileSync } = await import("node:child_process")
      try { execFileSync("git", ["init"], { cwd: tmpDir, stdio: "pipe" }) } catch { /* ok */ }
    } catch { /* ok */ }

    try {
      const { parseReviewFindings } = await import(
        "../extensions/zflow-change-workflows/orchestration.js"
      )
      const { metadata, findings } = await parseReviewFindings(tmpDir)
      assert.ok(metadata, "metadata should be present")
      assert.equal(metadata.sourceChangeId, undefined)
      assert.equal(metadata.rawSource, undefined)
      assert.equal(metadata.runId, undefined)
      assert.equal(findings.length, 0)
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })
})

// ── buildFixOrchestratorTaskPrompt artifact paths tests ─────────

describe("buildFixOrchestratorTaskPrompt artifact paths", { concurrency: false }, () => {
  it("includes artifact paths from parsed findings in the prompt", async () => {
    const { buildFixOrchestratorTaskPrompt, resolveFixOrchestratorConfig } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    const config = resolveFixOrchestratorConfig()

    // Simulate findings with artifact paths from a real review run
    const findingsWithArtifacts = [
      {
        findingId: "finding-1",
        severity: "critical" as const,
        title: "Missing validation",
        file: "src/auth/login.ts",
        line: 42,
        reviewerRole: "correctness",
        evidence: "No input validation",
        recommendation: "Add validation",
        artifactPath: "runs/rev-abc-0001/review-artifacts/correctness.md",
      },
      {
        findingId: "finding-2",
        severity: "major" as const,
        title: "Inconsistent error format",
        file: "src/auth/types.ts",
        reviewerRole: "integration",
        evidence: "Different error shapes",
        recommendation: "Standardize",
        artifactPath: "runs/rev-abc-0001/review-artifacts/integration.md",
      },
      {
        findingId: "finding-3",
        severity: "minor" as const,
        title: "Unused import",
        file: "src/auth/types.ts",
        reviewerRole: "correctness",
        evidence: "Unused bcrypt import",
        recommendation: "Remove import",
        // No artifactPath — should be excluded from the paths table
      },
    ]

    const fixResult = {
      changeId: "test-change",
      fixPlan: "# Test fix plan",
      filesToModify: ["src/auth/login.ts", "src/auth/types.ts"],
      verificationCommand: "npm test",
      parsedFindings: findingsWithArtifacts,
      rawFindingsPath: "/tmp/findings.md",
      planVersion: "v1",
      lifecycleState: "executing",
      fixOrchestratorConfig: config,
      fixOrchestratorTaskPrompt: undefined,
    }

    const prompt = await buildFixOrchestratorTaskPrompt(
      "test-change",
      fixResult,
      "/tmp/findings.md",
      undefined, // no bogus rawReviewerDir
    )

    // Should list artifact paths in a table
    assert.ok(
      prompt.includes("runs/rev-abc-0001/review-artifacts/correctness.md"),
      "prompt should include finding-1 artifact path",
    )
    assert.ok(
      prompt.includes("runs/rev-abc-0001/review-artifacts/integration.md"),
      "prompt should include finding-2 artifact path",
    )
    // Should NOT include generic per-finding instructions since none exist
    // Should NOT reference a bogus raw-reviewer-artifacts directory
    assert.ok(
      !prompt.includes("raw-reviewer-artifacts"),
      "prompt should not reference a bogus reviewer artifacts dir",
    )
    // Should include the per-artifact reading instructions
    assert.ok(
      prompt.includes("Read the raw reviewer artifact listed above"),
      "prompt should tell agents to read the listed artifacts",
    )
  })

  it("omits artifact paths section when no findings have artifact paths", async () => {
    const { buildFixOrchestratorTaskPrompt, resolveFixOrchestratorConfig } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    const config = resolveFixOrchestratorConfig()

    const fixResult = {
      changeId: "test-change",
      fixPlan: "# Test fix plan",
      filesToModify: [],
      verificationCommand: undefined,
      parsedFindings: [],
      rawFindingsPath: "/tmp/findings.md",
      planVersion: "v1",
      lifecycleState: "executing",
      fixOrchestratorConfig: config,
      fixOrchestratorTaskPrompt: undefined,
    }

    const prompt = await buildFixOrchestratorTaskPrompt(
      "test-change",
      fixResult,
      "/tmp/findings.md",
    )

    // Should not have the artifact paths section header
    assert.ok(
      !prompt.includes("Raw reviewer artifacts"),
      "prompt should not have Raw reviewer artifacts section when no findings have paths",
    )
  })
})

// ── buildFixPlan enriched fields tests ─────────────────────────

describe("buildFixPlan enriched fields", { concurrency: false }, () => {
  const FINDINGS_WITH_ENRICHED_FIELDS = `# Code Review Findings

**Source**: Implementation of test-change
**Run ID**: run-999

## Reviewed Changes

- src/auth/login.ts

## Coverage Notes

- correctness: ✅ executed

## Findings Summary

| Severity | Count |
| -------- | ----- |
| Major | 1 |

## Major Findings

### Inconsistent error response format

**Reviewer support**: integration
**Evidence**: Error responses use different JSON shapes.
**Why it matters**: API consumers cannot reliably parse errors.
**Recommendation**: Standardize error format.
**File**: \`src/auth/types.ts\`
**Expected behavior**: All error responses follow {error: string, code: number}.
**Fix requirements**: Update all error-return paths to use the standard format; replace ad-hoc \`{message: string}\` objects.
**Validation**: All existing tests pass; grep for non-standard error shapes returns zero matches.
**Suggested approach**: Create a shared \`ApiError\` class and throw it from all error paths.
`

  async function setupTmpFindings(content: string): Promise<string> {
    const tmpDir = await mkdtemp(join(tmpdir(), "zflow-test-enriched-"))
    const reviewDir = join(tmpDir, ".zflow", "review")
    await mkdir(reviewDir, { recursive: true })
    await writeFile(join(reviewDir, "code-review-findings.md"), content, "utf-8")
    try {
      const { execFileSync } = await import("node:child_process")
      try { execFileSync("git", ["init"], { cwd: tmpDir, stdio: "pipe" }) } catch { /* ok */ }
    } catch { /* ok */ }
    return tmpDir
  }

  it("includes expectedBehavior in buildFixPlan output", async () => {
    const { parseReviewFindings, buildFixPlan } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    const tmpDir = await setupTmpFindings(FINDINGS_WITH_ENRICHED_FIELDS)
    try {
      const { findings } = await parseReviewFindings(tmpDir)
      assert.ok(findings.length > 0, "Need at least 1 finding")
      const plan = await buildFixPlan("test-change", findings, tmpDir)
      assert.ok(
        plan.includes("**Expected behavior:**"),
        "buildFixPlan should include Expected behavior when present",
      )
      assert.ok(
        plan.includes("All error responses follow {error: string, code: number}."),
        "buildFixPlan should include the actual expected behavior value",
      )
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it("includes fixRequirements in buildFixPlan output", async () => {
    const { parseReviewFindings, buildFixPlan } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    const tmpDir = await setupTmpFindings(FINDINGS_WITH_ENRICHED_FIELDS)
    try {
      const { findings } = await parseReviewFindings(tmpDir)
      const plan = await buildFixPlan("test-change", findings, tmpDir)
      assert.ok(
        plan.includes("**Fix requirements:**"),
        "buildFixPlan should include Fix requirements when present",
      )
      assert.ok(
        plan.includes("Update all error-return paths"),
        "buildFixPlan should include the actual fix requirements value",
      )
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it("includes validation in buildFixPlan output", async () => {
    const { parseReviewFindings, buildFixPlan } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    const tmpDir = await setupTmpFindings(FINDINGS_WITH_ENRICHED_FIELDS)
    try {
      const { findings } = await parseReviewFindings(tmpDir)
      const plan = await buildFixPlan("test-change", findings, tmpDir)
      assert.ok(
        plan.includes("**Validation:**"),
        "buildFixPlan should include Validation when present",
      )
      assert.ok(
        plan.includes("All existing tests pass"),
        "buildFixPlan should include the actual validation value",
      )
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it("includes suggestedApproach in buildFixPlan output", async () => {
    const { parseReviewFindings, buildFixPlan } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    const tmpDir = await setupTmpFindings(FINDINGS_WITH_ENRICHED_FIELDS)
    try {
      const { findings } = await parseReviewFindings(tmpDir)
      const plan = await buildFixPlan("test-change", findings, tmpDir)
      assert.ok(
        plan.includes("**Suggested approach:**"),
        "buildFixPlan should include Suggested approach when present",
      )
      assert.ok(
        plan.includes("ApiError"),
        "buildFixPlan should include the actual suggested approach value",
      )
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })
})

// ── buildFixOrchestratorTaskPrompt conflict-resolution tests ────

describe("buildFixOrchestratorTaskPrompt conflict-resolution protocol", { concurrency: false }, () => {
  it("includes the Conflict Resolution Protocol section", async () => {
    const { buildFixOrchestratorTaskPrompt, resolveFixOrchestratorConfig } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    const config = resolveFixOrchestratorConfig()

    const fixResult = {
      changeId: "test-change",
      fixPlan: "# Test fix plan",
      filesToModify: [],
      verificationCommand: "npm test",
      parsedFindings: [],
      rawFindingsPath: "/tmp/findings.md",
      planVersion: "v1",
      lifecycleState: "executing",
      fixOrchestratorConfig: config,
      fixOrchestratorTaskPrompt: undefined,
    }

    const prompt = await buildFixOrchestratorTaskPrompt(
      "test-change",
      fixResult,
      "/tmp/findings.md",
    )

    assert.ok(
      prompt.includes("Conflict Resolution Protocol"),
      "prompt should have a Conflict Resolution Protocol heading",
    )
    assert.ok(
      prompt.includes("Treat suggested approaches as advisory only"),
      "prompt should say suggested approaches are advisory",
    )
    assert.ok(
      prompt.includes("minimal compliant fix"),
      "prompt should mention minimal compliant fix",
    )
  })

  it("includes placeholder/missing-file guidance", async () => {
    const { buildFixOrchestratorTaskPrompt, resolveFixOrchestratorConfig } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    const config = resolveFixOrchestratorConfig()

    const fixResult = {
      changeId: "test-change",
      fixPlan: "# Test fix plan",
      filesToModify: [],
      verificationCommand: undefined,
      parsedFindings: [],
      rawFindingsPath: "/tmp/findings.md",
      planVersion: "v1",
      lifecycleState: "executing",
      fixOrchestratorConfig: config,
      fixOrchestratorTaskPrompt: undefined,
    }

    const prompt = await buildFixOrchestratorTaskPrompt(
      "test-change",
      fixResult,
      "/tmp/findings.md",
    )

    assert.ok(
      prompt.includes("Placeholder/missing-file"),
      "prompt should have placeholder/missing-file guidance",
    )
    assert.ok(
      prompt.includes("export {}"),
      "prompt should encourage export {} stubs over real scaffolding",
    )
  })

  it("includes cross-finding consistency guidance", async () => {
    const { buildFixOrchestratorTaskPrompt, resolveFixOrchestratorConfig } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    const config = resolveFixOrchestratorConfig()

    const fixResult = {
      changeId: "test-change",
      fixPlan: "# Test fix plan",
      filesToModify: [],
      verificationCommand: undefined,
      parsedFindings: [],
      rawFindingsPath: "/tmp/findings.md",
      planVersion: "v1",
      lifecycleState: "executing",
      fixOrchestratorConfig: config,
      fixOrchestratorTaskPrompt: undefined,
    }

    const prompt = await buildFixOrchestratorTaskPrompt(
      "test-change",
      fixResult,
      "/tmp/findings.md",
    )

    assert.ok(
      prompt.includes("Cross-finding consistency"),
      "prompt should have cross-finding consistency guidance",
    )
    assert.ok(
      prompt.includes("re-read ALL findings"),
      "prompt should say to re-read all findings",
    )
  })

  it("includes introduced-risk check instructions", async () => {
    const { buildFixOrchestratorTaskPrompt, resolveFixOrchestratorConfig } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    const config = resolveFixOrchestratorConfig()

    const fixResult = {
      changeId: "test-change",
      fixPlan: "# Test fix plan",
      filesToModify: [],
      verificationCommand: undefined,
      parsedFindings: [],
      rawFindingsPath: "/tmp/findings.md",
      planVersion: "v1",
      lifecycleState: "executing",
      fixOrchestratorConfig: config,
      fixOrchestratorTaskPrompt: undefined,
    }

    const prompt = await buildFixOrchestratorTaskPrompt(
      "test-change",
      fixResult,
      "/tmp/findings.md",
    )

    assert.ok(
      prompt.includes("Post-fix introduced-risk check"),
      "prompt should have introduced-risk check section",
    )
    assert.ok(
      prompt.includes("plan-forbidden"),
      "prompt should mention plan-forbidden concepts check",
    )
    assert.ok(
      prompt.includes("introduce the same problem"),
      "prompt should mention checking for same problem in new locations",
    )
  })
})
