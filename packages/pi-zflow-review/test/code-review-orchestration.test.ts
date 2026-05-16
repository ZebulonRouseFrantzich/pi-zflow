/**
 * code-review-orchestration.test.ts — Tests for code review dispatch service integration.
 *
 * Validates that runCodeReview:
 *   - Uses typed DispatchService.runAgent when no reviewerRunner is provided
 *   - Falls back to skipped behavior when no dispatch service is available
 *   - Parses JSON findings from dispatch output and populates severity/recommendation
 */
import { describe, it, before, after, afterEach } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { execFileSync } from "node:child_process"

import { getZflowRegistry } from "pi-zflow-core/registry"
import {
  DISPATCH_SERVICE_CAPABILITY,
  type DispatchService,
} from "pi-zflow-core/dispatch-service"
import { resetZflowRegistry } from "pi-zflow-core"

import { runCodeReview, type CodeReviewInput } from "../extensions/zflow-review/orchestration.js"

// ── Temp directory for artifact persistence ────────────────────

let tmpDir: string

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-review-dispatch-"))
  // Make tmpDir a minimal git repo so runCodeReview's internal git commands
  // do not produce noisy "not a git repository" warnings.
  execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" })
  execFileSync("git", ["config", "user.name", "Test"], { cwd: tmpDir, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir, stdio: "ignore" })
  const gitkeepPath = path.join(tmpDir, ".gitkeep")
  await fs.writeFile(gitkeepPath, "", "utf-8")
  execFileSync("git", ["add", ".gitkeep"], { cwd: tmpDir, stdio: "ignore" })
  execFileSync("git", ["commit", "-m", "initial"], { cwd: tmpDir, stdio: "ignore" })
})

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

afterEach(() => {
  resetZflowRegistry()
})

// ── Helper: write planning artifact files ──────────────────────

async function writeArtifacts(
  dir: string,
  changeId: string,
  version: string,
): Promise<CodeReviewInput["planningArtifacts"]> {
  const versionDir = path.join(dir, ".git", "pi-zflow", "plans", changeId, version)
  await fs.mkdir(versionDir, { recursive: true })

  const artifacts: Record<string, string> = {
    "design.md": "# Design\n\nTest design doc.",
    "execution-groups.md": "# Execution Groups\n\nNo groups.",
    "standards.md": "# Standards\n\nTest standards.",
    "verification.md": "# Verification\n\nTest verification.",
  }

  for (const [file, content] of Object.entries(artifacts)) {
    await fs.writeFile(path.join(versionDir, file), content, "utf-8")
  }

  return {
    design: path.join(versionDir, "design.md"),
    executionGroups: path.join(versionDir, "execution-groups.md"),
    standards: path.join(versionDir, "standards.md"),
    verification: path.join(versionDir, "verification.md"),
  }
}

// ── Helper: make minimal code review input ─────────────────────

function makeInput(
  planningArtifacts: CodeReviewInput["planningArtifacts"],
  overrides: Partial<CodeReviewInput> = {},
): CodeReviewInput {
  return {
    source: "Test change",
    repoPath: tmpDir,
    branch: "test-branch",
    planningArtifacts,
    verificationStatus: "unknown",
    cwd: tmpDir,
    ...overrides,
  }
}

// ── Helper: selective fake DispatchService (different output per agent) ─

function makeSelectiveDispatchService(
  reviewerOutput: string,
  synthOutput: string,
): DispatchService & { callLog: Array<Record<string, unknown>> } {
  const callLog: Array<Record<string, unknown>> = []
  return {
    name: "test-selective-service",
    callLog,
    async runAgent(input) {
      callLog.push(input)
      if (input.agent === "zflow.synthesizer") {
        return { ok: true, rawOutput: synthOutput }
      }
      return { ok: true, rawOutput: reviewerOutput }
    },
    async runParallel() {
      return { ok: false, results: [] }
    },
  }
}

// ── Helper: fake DispatchService that captures raw runAgent calls ────

function makeFakeDispatchService(
  rawOutput: string,
): DispatchService & { callLog: Array<Record<string, unknown>> } {
  const callLog: Array<Record<string, unknown>> = []
  return {
    name: "test-fake-service",
    callLog,
    async runAgent(input) {
      callLog.push(input)
      return { ok: true, rawOutput }
    },
    async runParallel() {
      return { ok: false, results: [] }
    },
  }
}

// ═══════════════════════════════════════════════════════════════════
// Dispatch service integration
// ═══════════════════════════════════════════════════════════════════

void describe("runCodeReview with DispatchService", () => {
  it("calls runAgent with typed contract (agent + task, no nested context)", async () => {
    const planningArtifacts = await writeArtifacts(tmpDir, "ch-dispatch", "v1")
    const jsonOutput = JSON.stringify({
      findings: [
        {
          severity: "minor",
          title: "Style issue",
          description: "Use const instead of let",
        },
      ],
    })

    const fakeService = makeFakeDispatchService(jsonOutput)
    const registry = getZflowRegistry()
    registry.claim({
      capability: DISPATCH_SERVICE_CAPABILITY,
      version: "0.1.0",
      provider: "test",
      sourcePath: import.meta.url,
      compatibilityMode: "compatible",
    })
    registry.provide(DISPATCH_SERVICE_CAPABILITY, fakeService)

    const result = await runCodeReview(makeInput(planningArtifacts))

    // Assert runAgent was called with the typed shape and no extra keys
    assert.ok(fakeService.callLog.length > 0, "runAgent should be called")
    for (const rawInput of fakeService.callLog) {
      const keys = Object.keys(rawInput).sort()
      assert.deepEqual(
        keys,
        ["agent", "task"],
        `runAgent must receive exactly { agent, task }, got keys: ${keys.join(", ")}`,
      )
      assert.equal(typeof rawInput.agent, "string", "agent must be a string")
      assert.equal(typeof rawInput.task, "string", "task must be a string")
    }
  })

  it("parses JSON findings and populates severity/recommendation", async () => {
    const planningArtifacts = await writeArtifacts(tmpDir, "ch-findings", "v1")
    const jsonOutput = JSON.stringify({
      findings: [
        {
          severity: "critical",
          title: "Security bypass",
          description: "Auth check is missing",
        },
        {
          severity: "major",
          title: "Memory leak",
          description: "Unbounded cache growth",
        },
      ],
    })

    const fakeService = makeFakeDispatchService(jsonOutput)
    const registry = getZflowRegistry()
    registry.claim({
      capability: DISPATCH_SERVICE_CAPABILITY,
      version: "0.1.0",
      provider: "test",
      sourcePath: import.meta.url,
      compatibilityMode: "compatible",
    })
    registry.provide(DISPATCH_SERVICE_CAPABILITY, fakeService)

    const result = await runCodeReview(makeInput(planningArtifacts))

    // Each reviewer (correctness, integration, security — 3 total) gets the
    // same output with 1 critical and 1 major finding, so totals are 3 each.
    assert.equal(
      result.severity.critical, 3,
      `expected 3 critical findings (3 reviewers × 1), got ${result.severity.critical}`,
    )
    assert.equal(
      result.severity.major, 3,
      `expected 3 major findings (3 reviewers × 1), got ${result.severity.major}`,
    )
    assert.equal(result.severity.minor, 0, "should have 0 minor findings")
    assert.equal(result.severity.nit, 0, "should have 0 nit findings")

    // Recommendation should be NO-GO for critical findings
    assert.equal(result.recommendation, "NO-GO")
  })

  it("uses synthesizer output when parseable", async () => {
    const planningArtifacts = await writeArtifacts(tmpDir, "ch-synth-ok", "v1")

    // Reviewer findings output: minor only so local recommendation is GO
    const reviewerOutput = JSON.stringify({
      findings: [{ severity: "minor", title: "Style", description: "Nitpick" }],
    })
    // Synthesizer output: overrides to critical → NO-GO
    const synthOutput = JSON.stringify({
      severity: { critical: 2, major: 0, minor: 0, nit: 0 },
      recommendation: "NO-GO",
    })

    const fakeService = makeSelectiveDispatchService(reviewerOutput, synthOutput)
    const registry = getZflowRegistry()
    registry.claim({
      capability: DISPATCH_SERVICE_CAPABILITY,
      version: "0.1.0",
      provider: "test",
      sourcePath: import.meta.url,
      compatibilityMode: "compatible",
    })
    registry.provide(DISPATCH_SERVICE_CAPABILITY, fakeService)

    const result = await runCodeReview(makeInput(planningArtifacts))

    // Synthesizer should override local minor-only → critical
    assert.equal(
      result.severity.critical, 2,
      `expected synthesizer critical=2, got critical=${result.severity.critical}`,
    )
    assert.equal(
      result.severity.major, 0,
    )
    // Recommendation must come from synthesizer output
    assert.equal(result.recommendation, "NO-GO")
    // Coverage notes should mention authoritative result
    const hasAuthNote = result.coverageNotes.some(n => n.includes("authoritative"))
    assert.ok(hasAuthNote, "expected coverage note about authoritative synthesizer result")
  })

  it("falls back to local severity when synthesizer output is unparseable", async () => {
    const planningArtifacts = await writeArtifacts(tmpDir, "ch-synth-bad", "v1")

    // Reviewer findings output: minor only
    const reviewerOutput = JSON.stringify({
      findings: [{ severity: "major", title: "Bug", description: "Real bug" }],
    })
    // Unparseable synthesizer output
    const synthOutput = "I reviewed the findings and everything looks fine."

    const fakeService = makeSelectiveDispatchService(reviewerOutput, synthOutput)
    const registry = getZflowRegistry()
    registry.claim({
      capability: DISPATCH_SERVICE_CAPABILITY,
      version: "0.1.0",
      provider: "test",
      sourcePath: import.meta.url,
      compatibilityMode: "compatible",
    })
    registry.provide(DISPATCH_SERVICE_CAPABILITY, fakeService)

    const result = await runCodeReview(makeInput(planningArtifacts))

    // Should fall back to local severity: 3 reviewers × 1 major = 3 major
    assert.equal(
      result.severity.major, 3,
      `expected local major=3 (3 reviewers × 1), got major=${result.severity.major}`,
    )
    assert.equal(
      result.severity.critical, 0,
    )
    // Local recommendation for major > 0 → CONDITIONAL-GO
    assert.equal(result.recommendation, "CONDITIONAL-GO")
    // Coverage notes should mention fallback
    const hasFallbackNote = result.coverageNotes.some(n => n.includes("falling back"))
    assert.ok(hasFallbackNote, "expected coverage note about falling back to local")
  })

  it("falls back to skipped reviewers when no dispatch service is registered", async () => {
    const planningArtifacts = await writeArtifacts(tmpDir, "ch-nodispatch", "v1")

    // Ensure no dispatch service exists
    resetZflowRegistry()

    const result = await runCodeReview(makeInput(planningArtifacts))

    // All reviewers should be skipped
    assert.equal(
      result.manifest.reviewers.filter((r) => r.status === "skipped").length,
      result.manifest.reviewers.length,
      "all reviewers should be skipped",
    )
    // Severity should be zero
    assert.equal(result.severity.critical, 0)
    assert.equal(result.severity.major, 0)
    assert.equal(result.severity.minor, 0)
    assert.equal(result.severity.nit, 0)
  })
})
