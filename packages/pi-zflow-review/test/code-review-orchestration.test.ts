/**
 * code-review-orchestration.test.ts — Tests for code review dispatch service integration.
 *
 * Validates that runCodeReview:
 *   - Uses typed DispatchService.runAgent when no reviewerRunner is provided
 *   - Falls back to skipped behavior when no dispatch service is available
 *   - Parses JSON findings from dispatch output and populates severity/recommendation
 */
import { describe, it, before, beforeEach, after, afterEach } from "node:test"
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
import { ACTIVE_PROFILE_PATH, resetZflowRegistry } from "pi-zflow-core"

import { runCodeReview, type CodeReviewInput } from "../extensions/zflow-review/orchestration.js"

// ── Temp directory for artifact persistence ────────────────────

let tmpDir: string
let activeProfileBackup: string | null = null
let activeProfileExisted = false

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

beforeEach(async () => {
  await writeActiveProfileCache(buildDefaultReviewProfileCache())
})

afterEach(async () => {
  resetZflowRegistry()
  try {
    if (activeProfileExisted && activeProfileBackup !== null) {
      await fs.mkdir(path.dirname(ACTIVE_PROFILE_PATH), { recursive: true })
      await fs.writeFile(ACTIVE_PROFILE_PATH, activeProfileBackup, "utf-8")
    } else {
      await fs.rm(ACTIVE_PROFILE_PATH, { force: true })
    }
  } catch {
    // Best-effort cleanup/restore for profile cache tests.
  }
  activeProfileBackup = null
  activeProfileExisted = false
})

// ── Helper: write planning artifact files ──────────────────────

async function writeArtifacts(
  dir: string,
  changeId: string,
  version: string,
): Promise<CodeReviewInput["planningArtifacts"]> {
  const versionDir = path.join(dir, ".zflow", "plans", changeId, version)
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

async function writeActiveProfileCache(cache: Record<string, unknown>): Promise<void> {
  try {
    activeProfileBackup = await fs.readFile(ACTIVE_PROFILE_PATH, "utf-8")
    activeProfileExisted = true
  } catch {
    activeProfileBackup = null
    activeProfileExisted = false
  }
  await fs.mkdir(path.dirname(ACTIVE_PROFILE_PATH), { recursive: true })
  await fs.writeFile(ACTIVE_PROFILE_PATH, JSON.stringify(cache, null, 2), "utf-8")
}

function buildDefaultReviewProfileCache(): Record<string, unknown> {
  return {
    profileName: "default",
    sourcePath: "/tmp/test-profile.json",
    resolvedAt: new Date().toISOString(),
    ttlMinutes: 15,
    definitionHash: "hash",
    environmentFingerprint: "env",
    resolvedLanes: {
      "review-correctness": { model: "model-correctness", thinking: "medium", required: true, optional: false, status: "resolved" },
      "review-integration": { model: "model-integration", thinking: "medium", required: true, optional: false, status: "resolved" },
      "review-security": { model: "model-security", thinking: "high", required: true, optional: false, status: "resolved" },
      "synthesis-frontier": { model: "model-synth", thinking: "high", required: true, optional: false, status: "resolved" },
    },
    agentBindings: {
      "zflow.review-correctness": { lane: "review-correctness", resolvedModel: "model-correctness", tools: "read", maxOutput: 1000, maxSubagentDepth: 0 },
      "zflow.review-integration": { lane: "review-integration", resolvedModel: "model-integration", tools: "read", maxOutput: 1000, maxSubagentDepth: 0 },
      "zflow.review-security": { lane: "review-security", resolvedModel: "model-security", tools: "read", maxOutput: 1000, maxSubagentDepth: 0 },
      "zflow.synthesizer": { lane: "synthesis-frontier", resolvedModel: "model-synth", tools: "read", maxOutput: 1000, maxSubagentDepth: 0 },
    },
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

    // Assert runAgent was called with the typed shape and repo cwd, not a nested context object.
    assert.ok(fakeService.callLog.length > 0, "runAgent should be called")
    for (const rawInput of fakeService.callLog) {
      const keys = Object.keys(rawInput).sort()
      assert.ok(keys.includes("agent"), `runAgent input should include agent, got keys: ${keys.join(", ")}`)
      assert.ok(keys.includes("cwd"), `runAgent input should include cwd, got keys: ${keys.join(", ")}`)
      assert.ok(keys.includes("task"), `runAgent input should include task, got keys: ${keys.join(", ")}`)
      assert.ok(!keys.includes("context"), `runAgent input must not include nested context, got keys: ${keys.join(", ")}`)
      assert.equal(typeof rawInput.agent, "string", "agent must be a string")
      assert.match(String(rawInput.agent), /^zflow\.(review-|synthesizer$)/, "agent should be a packaged zflow runtime name")
      assert.equal(rawInput.cwd, tmpDir, "cwd must be forwarded to dispatch")
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

  it("marks reviewer as failed when dispatch returns ok: false", async () => {
    const planningArtifacts = await writeArtifacts(tmpDir, "ch-fail-dispatch", "v1")

    // Fake service that returns ok: false for all agents
    const failingService: DispatchService & { callLog: Array<Record<string, unknown>> } = {
      name: "test-failing-service",
      callLog: [],
      async runAgent(input) {
        this.callLog.push(input)
        return { ok: false, rawOutput: "", error: "Agent resolved but found no matching implementation" }
      },
      async runParallel() {
        return { ok: false, results: [] }
      },
    }

    const registry = getZflowRegistry()
    registry.claim({
      capability: DISPATCH_SERVICE_CAPABILITY,
      version: "0.1.0",
      provider: "test",
      sourcePath: import.meta.url,
      compatibilityMode: "compatible",
    })
    registry.provide(DISPATCH_SERVICE_CAPABILITY, failingService)

    const result = await runCodeReview(makeInput(planningArtifacts))

    // All reviewers should be marked as failed
    const failedReviewers = result.manifest.reviewers.filter((r) => r.status === "failed")
    assert.equal(
      failedReviewers.length,
      result.manifest.reviewers.length,
      "all reviewers should be marked as failed",
    )

    // Each failed reviewer should carry the error detail
    for (const r of failedReviewers) {
      assert.ok(
        r.detail && r.detail.length > 0,
        `expected non-empty error detail, got: ${r.detail}`,
      )
    }

    // Severity should be zero (no findings were parsed)
    assert.equal(result.severity.critical, 0)
    assert.equal(result.severity.major, 0)
    assert.equal(result.severity.minor, 0)
    assert.equal(result.severity.nit, 0)

    // Coverage notes should mention each failure
    const hasFailureNote = result.coverageNotes.some(n => n.includes("failed"))
    assert.ok(hasFailureNote, "expected coverage note about failed dispatch")
  })

  it("fails closed early with setup guidance when required reviewer agents are not discoverable", async () => {
    const planningArtifacts = await writeArtifacts(tmpDir, "ch-missing-review-agents", "v1")

    const missingAgentService: DispatchService & { callLog: Array<Record<string, unknown>> } = {
      name: "test-missing-agents",
      callLog: [],
      async listAgents() {
        return ["context-builder", "delegate", "oracle", "planner", "researcher", "reviewer", "scout", "worker"]
      },
      async runAgent(input) {
        this.callLog.push(input)
        return { ok: true, rawOutput: JSON.stringify({ findings: [] }) }
      },
      async runParallel() {
        return { ok: false, results: [] }
      },
    }

    const registry = getZflowRegistry()
    registry.claim({
      capability: DISPATCH_SERVICE_CAPABILITY,
      version: "0.1.0",
      provider: "test",
      sourcePath: import.meta.url,
      compatibilityMode: "compatible",
    })
    registry.provide(DISPATCH_SERVICE_CAPABILITY, missingAgentService)

    const result = await runCodeReview(makeInput(planningArtifacts))

    const reviewerCalls = missingAgentService.callLog.filter((call) => String(call.agent).startsWith("zflow.review-"))
    assert.equal(reviewerCalls.length, 0, "reviewer agents should fail preflight before dispatch")
    assert.equal(result.reviewersExecuted, 0)
    assert.equal(result.recommendation, "NO-GO")
    assert.equal(result.reviewInfrastructure?.status, "failed")
    assert.match(String(result.reviewInfrastructure?.summary), /not a clean zero-finding review/i)
    assert.match(String(result.reviewInfrastructure?.recoveryHint), /zflow-setup-agents|zflow-update-agents/i)

    const findingsContent = await fs.readFile(result.findingsPath, "utf-8")
    assert.match(findingsContent, /## Review Outcome/)
    assert.match(findingsContent, /Infrastructure status: failed/)
    assert.match(findingsContent, /zflow-setup-agents|zflow-update-agents/)
  })

  it("accepts empty findings JSON as valid structured result", async () => {
    const planningArtifacts = await writeArtifacts(tmpDir, "ch-empty-findings", "v1")
    const emptyJson = JSON.stringify({ findings: [] })

    const fakeService = makeFakeDispatchService(emptyJson)
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

    // All reviewers should be executed (not skipped/failed)
    const executedReviewers = result.manifest.reviewers.filter((r) => r.status === "executed")
    assert.equal(
      executedReviewers.length,
      result.manifest.reviewers.length,
      "all reviewers should be executed",
    )

    // All severity counts must be zero — no bogus findings fabricated from the empty JSON
    assert.equal(result.severity.critical, 0)
    assert.equal(result.severity.major, 0)
    assert.equal(result.severity.minor, 0)
    assert.equal(result.severity.nit, 0)
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
    // Severity should be zero, but the recommendation must fail closed because no reviewer ran.
    assert.equal(result.severity.critical, 0)
    assert.equal(result.severity.major, 0)
    assert.equal(result.severity.minor, 0)
    assert.equal(result.severity.nit, 0)
    assert.equal(result.recommendation, "NO-GO")
  })

  it("uses file-backed active profile cache when registry profiles service is absent", async () => {
    const planningArtifacts = await writeArtifacts(tmpDir, "ch-profile-fallback", "v1")
    await writeActiveProfileCache({
      profileName: "default",
      sourcePath: "/tmp/test-profile.json",
      resolvedAt: new Date().toISOString(),
      ttlMinutes: 15,
      definitionHash: "hash",
      environmentFingerprint: "env",
      resolvedLanes: {
        "review-correctness": { model: "model-correctness", thinking: "medium", required: true, optional: false, status: "resolved" },
        "review-integration": { model: "model-integration", thinking: "medium", required: true, optional: false, status: "resolved" },
        "review-security": { model: "model-security", thinking: "high", required: true, optional: false, status: "resolved" },
      },
      agentBindings: {
        "zflow.review-correctness": { lane: "review-correctness", resolvedModel: "model-correctness", tools: "read", maxOutput: 1000, maxSubagentDepth: 0 },
        "zflow.review-integration": { lane: "review-integration", resolvedModel: "model-integration", tools: "read", maxOutput: 1000, maxSubagentDepth: 0 },
        "zflow.review-security": { lane: "review-security", resolvedModel: "model-security", tools: "read", maxOutput: 1000, maxSubagentDepth: 0 },
      },
    })

    const jsonOutput = JSON.stringify({ findings: [] })
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
    assert.ok(fakeService.callLog.length > 0, "reviewers should be dispatched")

    const reviewerCalls = fakeService.callLog.filter((c) => String(c.agent).startsWith("zflow.review-"))
    assert.ok(reviewerCalls.length >= 3, `expected >=3 reviewer calls, got ${reviewerCalls.length}`)
    for (const call of reviewerCalls) {
      assert.ok(typeof call.model === "string" && call.model.length > 0, `reviewer call missing model override: ${JSON.stringify(call)}`)
      assert.ok(!String(call.model).startsWith("placeholder"), `reviewer call should not use placeholder model: ${JSON.stringify(call)}`)
    }
    assert.equal(result.manifest.reviewers.filter((r) => r.status === "failed").length, 0)
  })

  it("treats placeholder models as unusable and fails reviewer before dispatch", async () => {
    const planningArtifacts = await writeArtifacts(tmpDir, "ch-placeholder-filter", "v1")
    await writeActiveProfileCache({
      profileName: "default",
      sourcePath: "/tmp/test-profile.json",
      resolvedAt: new Date().toISOString(),
      ttlMinutes: 15,
      definitionHash: "hash",
      environmentFingerprint: "env",
      resolvedLanes: {
        "review-correctness": { model: "placeholder:high", thinking: "medium", required: true, optional: false, status: "resolved" },
        "review-integration": { model: "model-integration", thinking: "medium", required: true, optional: false, status: "resolved" },
        "review-security": { model: "model-security", thinking: "high", required: true, optional: false, status: "resolved" },
      },
      agentBindings: {
        "zflow.review-correctness": { lane: "review-correctness", resolvedModel: "placeholder:high", tools: "read", maxOutput: 1000, maxSubagentDepth: 0 },
        "zflow.review-integration": { lane: "review-integration", resolvedModel: "model-integration", tools: "read", maxOutput: 1000, maxSubagentDepth: 0 },
        "zflow.review-security": { lane: "review-security", resolvedModel: "model-security", tools: "read", maxOutput: 1000, maxSubagentDepth: 0 },
      },
    })

    const jsonOutput = JSON.stringify({ findings: [] })
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

    const reviewerCalls = fakeService.callLog.filter((c) => String(c.agent).startsWith("zflow.review-"))
    assert.ok(
      reviewerCalls.every((c) => String(c.agent) !== "zflow.review-correctness"),
      "correctness reviewer should not be dispatched with placeholder model",
    )
    const correctness = result.manifest.reviewers.find((r) => r.name === "correctness")
    assert.ok(correctness)
    assert.equal(correctness!.status, "failed")
    assert.match(String(correctness!.detail), /No usable resolved model/i)
    assert.equal(result.recommendation, "NO-GO")
  })
})

// ── diffBundle support ──────────────────────────────────────────

void describe("runCodeReview with explicit diffBundle", () => {
  it("uses diffBundle content when provided instead of running git diff", async () => {
    const planningArtifacts = await writeArtifacts(tmpDir, "ch-bundle", "v1")
    const jsonOutput = JSON.stringify({ findings: [] })

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

    const bundleContent = `diff --git a/README.md b/README.md
new file mode 100644
index 0000000..e69de29`

    const result = await runCodeReview(makeInput(planningArtifacts, {
      diffBundle: bundleContent,
      diffSource: "test-bundle",
    }))

    // Coverage notes should mention the bundle source
    const hasSourceNote = result.coverageNotes.some(n => n.includes("test-bundle"))
    assert.ok(hasSourceNote, "coverage notes should contain diff source label")
    // Coverage notes should mention bytes
    const hasBytesNote = result.coverageNotes.some(n => n.includes("bytes"))
    assert.ok(hasBytesNote, "coverage notes should mention diff bundle size")
  })

  it("emits empty-diff coverage note when explicit diffBundle is empty", async () => {
    const planningArtifacts = await writeArtifacts(tmpDir, "ch-emptybundle", "v1")
    const jsonOutput = JSON.stringify({ findings: [] })

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

    const result = await runCodeReview(makeInput(planningArtifacts, {
      diffBundle: "",
      diffSource: "empty-test",
    }))

    const hasEmptyNote = result.coverageNotes.some(n => n.includes("no changes"))
    assert.ok(hasEmptyNote, "coverage notes should mention empty diff when bundle is empty")
  })
})
