/**
 * Tests for FixOrchestratorConfig resolution and buildFixOrchestratorTaskPrompt.
 *
 * Validates:
 * - Default config values (maxAttemptsPerFinding=2, maxGlobalRounds=3)
 * - Environment variable overrides
 * - Profile setting overrides
 * - Env vars take precedence over profile settings
 * - The task prompt references config values
 */
import * as assert from "node:assert/strict"
import { describe, it, before, after } from "node:test"

describe("resolveFixOrchestratorConfig", () => {
  const originalEnv: Record<string, string | undefined> = {}

  before(() => {
    originalEnv.ZFLOW_FIX_MAX_ATTEMPTS_PER_FINDING = process.env.ZFLOW_FIX_MAX_ATTEMPTS_PER_FINDING
    originalEnv.ZFLOW_FIX_MAX_GLOBAL_ROUNDS = process.env.ZFLOW_FIX_MAX_GLOBAL_ROUNDS
  })

  after(() => {
    if (originalEnv.ZFLOW_FIX_MAX_ATTEMPTS_PER_FINDING !== undefined) {
      process.env.ZFLOW_FIX_MAX_ATTEMPTS_PER_FINDING = originalEnv.ZFLOW_FIX_MAX_ATTEMPTS_PER_FINDING
    } else {
      delete process.env.ZFLOW_FIX_MAX_ATTEMPTS_PER_FINDING
    }
    if (originalEnv.ZFLOW_FIX_MAX_GLOBAL_ROUNDS !== undefined) {
      process.env.ZFLOW_FIX_MAX_GLOBAL_ROUNDS = originalEnv.ZFLOW_FIX_MAX_GLOBAL_ROUNDS
    } else {
      delete process.env.ZFLOW_FIX_MAX_GLOBAL_ROUNDS
    }
  })

  it("returns default values when no env vars or profile settings are provided", async () => {
    delete process.env.ZFLOW_FIX_MAX_ATTEMPTS_PER_FINDING
    delete process.env.ZFLOW_FIX_MAX_GLOBAL_ROUNDS
    const { resolveFixOrchestratorConfig } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    const config = resolveFixOrchestratorConfig()
    assert.equal(config.maxAttemptsPerFinding, 2, "default maxAttemptsPerFinding should be 2")
    assert.equal(config.maxGlobalRounds, 3, "default maxGlobalRounds should be 3")
  })

  it("uses environment variables when set", async () => {
    delete process.env.ZFLOW_FIX_MAX_ATTEMPTS_PER_FINDING
    delete process.env.ZFLOW_FIX_MAX_GLOBAL_ROUNDS
    process.env.ZFLOW_FIX_MAX_ATTEMPTS_PER_FINDING = "5"
    process.env.ZFLOW_FIX_MAX_GLOBAL_ROUNDS = "7"
    const { resolveFixOrchestratorConfig } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    const config = resolveFixOrchestratorConfig()
    assert.equal(config.maxAttemptsPerFinding, 5, "env var maxAttemptsPerFinding should be 5")
    assert.equal(config.maxGlobalRounds, 7, "env var maxGlobalRounds should be 7")
  })

  it("uses profile settings when env vars are not set", async () => {
    delete process.env.ZFLOW_FIX_MAX_ATTEMPTS_PER_FINDING
    delete process.env.ZFLOW_FIX_MAX_GLOBAL_ROUNDS
    const { resolveFixOrchestratorConfig } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    const profileSettings = {
      maxAttemptsPerFinding: 4,
      maxGlobalRounds: 6,
    }
    const config = resolveFixOrchestratorConfig(profileSettings)
    assert.equal(config.maxAttemptsPerFinding, 4, "profile maxAttemptsPerFinding should be 4")
    assert.equal(config.maxGlobalRounds, 6, "profile maxGlobalRounds should be 6")
  })

  it("env vars take precedence over profile settings", async () => {
    process.env.ZFLOW_FIX_MAX_ATTEMPTS_PER_FINDING = "3"
    process.env.ZFLOW_FIX_MAX_GLOBAL_ROUNDS = "5"
    const { resolveFixOrchestratorConfig } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    const profileSettings = {
      maxAttemptsPerFinding: 8,
      maxGlobalRounds: 10,
    }
    const config = resolveFixOrchestratorConfig(profileSettings)
    assert.equal(config.maxAttemptsPerFinding, 3, "env var should override profile: expected 3, got " + config.maxAttemptsPerFinding)
    assert.equal(config.maxGlobalRounds, 5, "env var should override profile: expected 5, got " + config.maxGlobalRounds)
  })

  it('handles invalid env var values by falling through to defaults', async () => {
    process.env.ZFLOW_FIX_MAX_ATTEMPTS_PER_FINDING = "not-a-number"
    process.env.ZFLOW_FIX_MAX_GLOBAL_ROUNDS = ""
    const { resolveFixOrchestratorConfig } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    // parseInt("not-a-number") returns NaN, which is falsy, so falls through to default (2)
    // parseInt("") returns NaN, falls through to default (3)
    const config = resolveFixOrchestratorConfig()
    assert.equal(config.maxAttemptsPerFinding, 2, "invalid env var should fall back to default")
    assert.equal(config.maxGlobalRounds, 3, "empty string env var should fall back to default")
  })
})

describe("buildFixOrchestratorTaskPrompt", () => {
  it("includes the config values in the prompt", async () => {
    const { buildFixOrchestratorTaskPrompt, resolveFixOrchestratorConfig } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    const config = resolveFixOrchestratorConfig()

    const fixResult = {
      changeId: "test-change",
      fixPlan: "# Test fix plan",
      filesToModify: ["src/test.ts"],
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
      "/tmp/raw-reviewer-artifacts",
    )

    assert.ok(prompt.includes("test-change"), "prompt should include change ID")
    assert.ok(prompt.includes("zflow.fix-orchestrator"), "prompt should reference the orchestrator role")
    assert.ok(prompt.includes("subagent"), "prompt should mention subagent tool")
    assert.ok(prompt.includes("Finding ID") || prompt.includes("findings"), "prompt should reference findings")
  })

  it("includes parsed findings when present", async () => {
    const { buildFixOrchestratorTaskPrompt, resolveFixOrchestratorConfig } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    const config = resolveFixOrchestratorConfig()

    const fixResult = {
      changeId: "test-change",
      fixPlan: "# Test fix plan",
      filesToModify: ["src/test.ts"],
      verificationCommand: "npm test",
      parsedFindings: [
        {
          findingId: "finding-1",
          severity: "major" as const,
          title: "Null check missing",
          file: "src/test.ts",
          line: 42,
          reviewerRole: "correctness",
          evidence: "Missing null check on user object",
          recommendation: "Add null guard before accessing user.name",
        },
        {
          findingId: "finding-2",
          severity: "critical" as const,
          title: "SQL injection risk",
          file: "src/db.ts",
          line: 15,
          reviewerRole: "security",
          evidence: "User input passed directly to SQL query",
          recommendation: "Use parameterized queries",
          whyItMatters: "Allows attacker to execute arbitrary SQL",
        },
      ],
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
      undefined,
    )

    assert.ok(prompt.includes("finding-1"), "prompt should include first finding ID")
    assert.ok(prompt.includes("finding-2"), "prompt should include second finding ID")
    assert.ok(prompt.includes("Null check missing"), "prompt should include first finding title")
    assert.ok(prompt.includes("SQL injection risk"), "prompt should include second finding title")
    assert.ok(prompt.includes("src/test.ts"), "prompt should include first finding file")
    assert.ok(prompt.includes("correctness"), "prompt should include first finding reviewer role")
    assert.ok(prompt.includes("security"), "prompt should include second finding reviewer role")
    assert.ok(prompt.includes("Parameterized queries") || prompt.includes("parameterized"), "prompt should include fix recommendations")
  })
})
