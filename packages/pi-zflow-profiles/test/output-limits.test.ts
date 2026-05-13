/**
 * output-limits.test.ts — Tests for maxOutput enforcement.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  validateMaxOutput,
  validateMaxOutputStrict,
  validateAllMaxOutputs,
  getDefaultMaxOutput,
  enforceOutputLimits,
  applyDefaultMaxOutput,
  EXPECTED_MAX_OUTPUT,
} from "../src/output-limits.js"

import type { LaunchAgentConfig } from "../src/launch-config.js"

// ── EXPECTED_MAX_OUTPUT structure ───────────────────────────────

void describe("EXPECTED_MAX_OUTPUT", () => {
  it("should contain all expected agents", () => {
    const agents = Object.keys(EXPECTED_MAX_OUTPUT)
    assert.ok(agents.includes("zflow.planner-frontier"))
    assert.ok(agents.includes("zflow.synthesizer"))
    assert.ok(agents.includes("zflow.implement-hard"))
    assert.ok(agents.includes("zflow.implement-routine"))
    assert.ok(agents.includes("zflow.review-correctness"))
    assert.ok(agents.includes("zflow.review-integration"))
    assert.ok(agents.includes("zflow.review-security"))
    assert.ok(agents.includes("zflow.review-logic"))
    assert.ok(agents.includes("zflow.review-system"))
    assert.ok(agents.includes("zflow.plan-review-correctness"))
    assert.ok(agents.includes("zflow.plan-review-integration"))
    assert.ok(agents.includes("zflow.plan-review-feasibility"))
    assert.ok(agents.includes("zflow.plan-validator"))
    assert.ok(agents.includes("zflow.verifier"))
    assert.ok(agents.includes("zflow.repo-mapper"))
  })

  it("should have correct values per the plan", () => {
    // ~12000 tier
    assert.equal(EXPECTED_MAX_OUTPUT["zflow.planner-frontier"], 12000)
    assert.equal(EXPECTED_MAX_OUTPUT["zflow.synthesizer"], 12000)
    assert.equal(EXPECTED_MAX_OUTPUT["zflow.review-system"], 12000)

    // ~10000 tier
    assert.equal(EXPECTED_MAX_OUTPUT["zflow.implement-hard"], 10000)
    assert.equal(EXPECTED_MAX_OUTPUT["zflow.review-correctness"], 10000)
    assert.equal(EXPECTED_MAX_OUTPUT["zflow.review-logic"], 10000)
    assert.equal(EXPECTED_MAX_OUTPUT["zflow.plan-review-correctness"], 10000)
    assert.equal(EXPECTED_MAX_OUTPUT["zflow.plan-review-feasibility"], 10000)

    // ~8000 tier
    assert.equal(EXPECTED_MAX_OUTPUT["zflow.implement-routine"], 8000)
    assert.equal(EXPECTED_MAX_OUTPUT["zflow.review-integration"], 8000)
    assert.equal(EXPECTED_MAX_OUTPUT["zflow.review-security"], 8000)
    assert.equal(EXPECTED_MAX_OUTPUT["zflow.plan-review-integration"], 8000)

    // ~6000 tier
    assert.equal(EXPECTED_MAX_OUTPUT["zflow.plan-validator"], 6000)
    assert.equal(EXPECTED_MAX_OUTPUT["zflow.verifier"], 6000)
    assert.equal(EXPECTED_MAX_OUTPUT["zflow.repo-mapper"], 6000)

    // Builtins
    assert.equal(EXPECTED_MAX_OUTPUT["builtin-scout"], 6000)
    assert.equal(EXPECTED_MAX_OUTPUT["builtin-context-builder"], 6000)
  })
})

// ── getDefaultMaxOutput ─────────────────────────────────────────

void describe("getDefaultMaxOutput", () => {
  it("should return 12000 for planner-frontier", () => {
    assert.equal(getDefaultMaxOutput("zflow.planner-frontier"), 12000)
  })

  it("should return 12000 for synthesizer", () => {
    assert.equal(getDefaultMaxOutput("zflow.synthesizer"), 12000)
  })

  it("should return 10000 for implement-hard", () => {
    assert.equal(getDefaultMaxOutput("zflow.implement-hard"), 10000)
  })

  it("should return 8000 for implement-routine", () => {
    assert.equal(getDefaultMaxOutput("zflow.implement-routine"), 8000)
  })

  it("should return 10000 for review-correctness", () => {
    assert.equal(getDefaultMaxOutput("zflow.review-correctness"), 10000)
  })

  it("should return 8000 for review-integration", () => {
    assert.equal(getDefaultMaxOutput("zflow.review-integration"), 8000)
  })

  it("should return 8000 for review-security", () => {
    assert.equal(getDefaultMaxOutput("zflow.review-security"), 8000)
  })

  it("should return 10000 for review-logic", () => {
    assert.equal(getDefaultMaxOutput("zflow.review-logic"), 10000)
  })

  it("should return 12000 for review-system", () => {
    assert.equal(getDefaultMaxOutput("zflow.review-system"), 12000)
  })

  it("should return 10000 for plan-review-correctness", () => {
    assert.equal(getDefaultMaxOutput("zflow.plan-review-correctness"), 10000)
  })

  it("should return 8000 for plan-review-integration", () => {
    assert.equal(getDefaultMaxOutput("zflow.plan-review-integration"), 8000)
  })

  it("should return 10000 for plan-review-feasibility", () => {
    assert.equal(getDefaultMaxOutput("zflow.plan-review-feasibility"), 10000)
  })

  it("should return 6000 for plan-validator", () => {
    assert.equal(getDefaultMaxOutput("zflow.plan-validator"), 6000)
  })

  it("should return 6000 for verifier", () => {
    assert.equal(getDefaultMaxOutput("zflow.verifier"), 6000)
  })

  it("should return 6000 for repo-mapper", () => {
    assert.equal(getDefaultMaxOutput("zflow.repo-mapper"), 6000)
  })

  it("should return 6000 for builtin-scout", () => {
    assert.equal(getDefaultMaxOutput("builtin-scout"), 6000)
  })

  it("should return 6000 for builtin-context-builder", () => {
    assert.equal(getDefaultMaxOutput("builtin-context-builder"), 6000)
  })

  it("should return undefined for unknown agents", () => {
    assert.equal(getDefaultMaxOutput("unknown.agent"), undefined)
    assert.equal(getDefaultMaxOutput(""), undefined)
  })
})

// ── validateMaxOutput ──────────────────────────────────────────

void describe("validateMaxOutput", () => {
  it("should pass for planner-frontier with 12000", () => {
    const result = validateMaxOutput("zflow.planner-frontier", 12000)
    assert.equal(result.valid, true)
    assert.equal(result.errors.length, 0)
  })

  it("should pass for implement-routine with 8000", () => {
    const result = validateMaxOutput("zflow.implement-routine", 8000)
    assert.equal(result.valid, true)
    assert.equal(result.errors.length, 0)
  })

  it("should pass for implement-hard with 10000", () => {
    const result = validateMaxOutput("zflow.implement-hard", 10000)
    assert.equal(result.valid, true)
    assert.equal(result.errors.length, 0)
  })

  it("should fail for implement-hard with 20000 (old wrong value)", () => {
    const result = validateMaxOutput("zflow.implement-hard", 20000)
    assert.equal(result.valid, false)
    assert.ok(result.errors[0].includes("expected 10000, got 20000"))
    assert.equal(result.expectedOutput, 10000)
    assert.equal(result.configuredOutput, 20000)
  })

  it("should fail for implement-routine with 16000 (old wrong value)", () => {
    const result = validateMaxOutput("zflow.implement-routine", 16000)
    assert.equal(result.valid, false)
    assert.ok(result.errors[0].includes("expected 8000, got 16000"))
  })

  it("should fail when maxOutput is undefined", () => {
    const result = validateMaxOutput("zflow.verifier", undefined)
    assert.equal(result.valid, false)
    assert.ok(result.errors[0].includes("has no maxOutput configured"))
    assert.equal(result.expectedOutput, 6000)
    assert.equal(result.configuredOutput, undefined)
  })

  it("should fail for unknown agent", () => {
    const result = validateMaxOutput("unknown.agent", 10000)
    assert.equal(result.valid, false)
    assert.ok(result.errors[0].includes('Unknown agent "unknown.agent"'))
    assert.equal(result.expectedOutput, undefined)
  })

  it("should fail for review-integration with 10000 (old wrong value)", () => {
    const result = validateMaxOutput("zflow.review-integration", 10000)
    assert.equal(result.valid, false)
    assert.ok(result.errors[0].includes("expected 8000, got 10000"))
  })

  it("should fail for review-security with 10000 (old wrong value)", () => {
    const result = validateMaxOutput("zflow.review-security", 10000)
    assert.equal(result.valid, false)
    assert.ok(result.errors[0].includes("expected 8000, got 10000"))
  })

  it("should fail for plan-review-integration with 10000 (old wrong value)", () => {
    const result = validateMaxOutput("zflow.plan-review-integration", 10000)
    assert.equal(result.valid, false)
    assert.ok(result.errors[0].includes("expected 8000, got 10000"))
  })

  it("should fail for plan-validator with 8000 (old wrong value)", () => {
    const result = validateMaxOutput("zflow.plan-validator", 8000)
    assert.equal(result.valid, false)
    assert.ok(result.errors[0].includes("expected 6000, got 8000"))
  })

  it("should fail for verifier with 8000 (old wrong value)", () => {
    const result = validateMaxOutput("zflow.verifier", 8000)
    assert.equal(result.valid, false)
    assert.ok(result.errors[0].includes("expected 6000, got 8000"))
  })

  it("should fail for review-system with 10000 (old wrong value)", () => {
    const result = validateMaxOutput("zflow.review-system", 10000)
    assert.equal(result.valid, false)
    assert.ok(result.errors[0].includes("expected 12000, got 10000"))
  })

  it("should pass for review-system with 12000", () => {
    const result = validateMaxOutput("zflow.review-system", 12000)
    assert.equal(result.valid, true)
  })

  it("should pass for builtin-scout with 6000", () => {
    const result = validateMaxOutput("builtin-scout", 6000)
    assert.equal(result.valid, true)
  })

  it("should pass for builtin-context-builder with 6000", () => {
    const result = validateMaxOutput("builtin-context-builder", 6000)
    assert.equal(result.valid, true)
  })

  it("should include agent name in result", () => {
    const result = validateMaxOutput("zflow.verifier", 6000)
    assert.equal(result.agentName, "zflow.verifier")
  })
})

// ── validateMaxOutputStrict ─────────────────────────────────────

void describe("validateMaxOutputStrict", () => {
  it("should pass for correct values", () => {
    validateMaxOutputStrict("zflow.planner-frontier", 12000)
    validateMaxOutputStrict("zflow.verifier", 6000)
    validateMaxOutputStrict("zflow.review-correctness", 10000)
  })

  it("should throw for incorrect values", () => {
    assert.throws(
      () => validateMaxOutputStrict("zflow.planner-frontier", 8000),
      /Invalid maxOutput for/,
    )
  })

  it("should throw for undefined values", () => {
    assert.throws(
      () => validateMaxOutputStrict("zflow.verifier", undefined),
      /has no maxOutput configured/,
    )
  })

  it("should throw for unknown agent", () => {
    assert.throws(
      () => validateMaxOutputStrict("unknown.agent", 10000),
      /Unknown agent/,
    )
  })
})

// ── validateAllMaxOutputs ──────────────────────────────────────

void describe("validateAllMaxOutputs", () => {
  it("should validate all configs and return results", () => {
    const configs: Record<string, LaunchAgentConfig> = {
      "zflow.planner-frontier": { agent: "zflow.planner-frontier", model: "gpt-5", maxOutput: 12000 },
      "zflow.implement-routine": { agent: "zflow.implement-routine", model: "gpt-5", maxOutput: 8000 },
      "zflow.verifier": { agent: "zflow.verifier", model: "gpt-5", maxOutput: 6000 },
    }

    const results = validateAllMaxOutputs(configs)

    assert.equal(results["zflow.planner-frontier"].valid, true)
    assert.equal(results["zflow.implement-routine"].valid, true)
    assert.equal(results["zflow.verifier"].valid, true)
  })

  it("should report both valid and invalid results", () => {
    const configs: Record<string, LaunchAgentConfig> = {
      "zflow.planner-frontier": { agent: "zflow.planner-frontier", model: "gpt-5", maxOutput: 12000 },
      "zflow.verifier": { agent: "zflow.verifier", model: "gpt-5", maxOutput: 20000 },
    }

    const results = validateAllMaxOutputs(configs)

    assert.equal(results["zflow.planner-frontier"].valid, true)
    assert.equal(results["zflow.verifier"].valid, false)
  })

  it("should handle empty configs", () => {
    const results = validateAllMaxOutputs({})
    assert.deepEqual(results, {})
  })
})

// ── applyDefaultMaxOutput ──────────────────────────────────────

void describe("applyDefaultMaxOutput", () => {
  it("should fill in missing maxOutput with default", () => {
    const config: LaunchAgentConfig = { agent: "zflow.planner-frontier", model: "gpt-5" }
    const result = applyDefaultMaxOutput(config)
    assert.equal(result.maxOutput, 12000)
  })

  it("should accept explicit correct maxOutput", () => {
    const config: LaunchAgentConfig = { agent: "zflow.verifier", model: "gpt-5", maxOutput: 6000 }
    const result = applyDefaultMaxOutput(config)
    assert.equal(result.maxOutput, 6000)
  })

  it("should throw when explicit maxOutput is wrong", () => {
    const config: LaunchAgentConfig = { agent: "zflow.verifier", model: "gpt-5", maxOutput: 20000 }
    assert.throws(
      () => applyDefaultMaxOutput(config),
      /Invalid maxOutput for "zflow.verifier": expected 6000, got 20000/,
    )
  })

  it("should fill in missing maxOutput for implement-routine", () => {
    const config: LaunchAgentConfig = { agent: "zflow.implement-routine", model: "gpt-5" }
    const result = applyDefaultMaxOutput(config)
    assert.equal(result.maxOutput, 8000)
  })

  it("should fill in missing maxOutput for implement-hard", () => {
    const config: LaunchAgentConfig = { agent: "zflow.implement-hard", model: "gpt-5" }
    const result = applyDefaultMaxOutput(config)
    assert.equal(result.maxOutput, 10000)
  })

  it("should fill in missing maxOutput for review-system", () => {
    const config: LaunchAgentConfig = { agent: "zflow.review-system", model: "gpt-5" }
    const result = applyDefaultMaxOutput(config)
    assert.equal(result.maxOutput, 12000)
  })

  it("should throw for unknown agent", () => {
    const config: LaunchAgentConfig = { agent: "unknown.agent", model: "gpt-5" }
    assert.throws(
      () => applyDefaultMaxOutput(config),
      /Cannot apply maxOutput for unknown agent/,
    )
  })

  it("should preserve other config fields", () => {
    const config: LaunchAgentConfig = {
      agent: "zflow.verifier",
      model: "claude-4",
      tools: "read, grep, find, ls, bash",
      maxSubagentDepth: 0,
      thinking: "medium",
    }
    const result = applyDefaultMaxOutput(config)
    assert.equal(result.agent, "zflow.verifier")
    assert.equal(result.model, "claude-4")
    assert.equal(result.tools, "read, grep, find, ls, bash")
    assert.equal(result.maxSubagentDepth, 0)
    assert.equal(result.thinking, "medium")
    assert.equal(result.maxOutput, 6000)
  })
})

// ── enforceOutputLimits ────────────────────────────────────────

void describe("enforceOutputLimits", () => {
  it("should apply defaults to all configs", () => {
    const configs: Record<string, LaunchAgentConfig> = {
      "zflow.planner-frontier": { agent: "zflow.planner-frontier", model: "gpt-5" },
      "zflow.implement-routine": { agent: "zflow.implement-routine", model: "gpt-5" },
      "zflow.implement-hard": { agent: "zflow.implement-hard", model: "gpt-5" },
      "zflow.verifier": { agent: "zflow.verifier", model: "gpt-5" },
      "zflow.synthesizer": { agent: "zflow.synthesizer", model: "gpt-5" },
      "zflow.review-correctness": { agent: "zflow.review-correctness", model: "gpt-5" },
      "zflow.review-integration": { agent: "zflow.review-integration", model: "gpt-5" },
      "zflow.review-security": { agent: "zflow.review-security", model: "gpt-5" },
      "zflow.review-logic": { agent: "zflow.review-logic", model: "gpt-5" },
      "zflow.review-system": { agent: "zflow.review-system", model: "gpt-5" },
      "zflow.plan-review-correctness": { agent: "zflow.plan-review-correctness", model: "gpt-5" },
      "zflow.plan-review-integration": { agent: "zflow.plan-review-integration", model: "gpt-5" },
      "zflow.plan-review-feasibility": { agent: "zflow.plan-review-feasibility", model: "gpt-5" },
      "zflow.plan-validator": { agent: "zflow.plan-validator", model: "gpt-5" },
      "zflow.repo-mapper": { agent: "zflow.repo-mapper", model: "gpt-5" },
    }

    const result = enforceOutputLimits(configs)

    assert.equal(result["zflow.planner-frontier"].maxOutput, 12000)
    assert.equal(result["zflow.synthesizer"].maxOutput, 12000)
    assert.equal(result["zflow.review-system"].maxOutput, 12000)
    assert.equal(result["zflow.implement-hard"].maxOutput, 10000)
    assert.equal(result["zflow.review-correctness"].maxOutput, 10000)
    assert.equal(result["zflow.review-logic"].maxOutput, 10000)
    assert.equal(result["zflow.plan-review-correctness"].maxOutput, 10000)
    assert.equal(result["zflow.plan-review-feasibility"].maxOutput, 10000)
    assert.equal(result["zflow.implement-routine"].maxOutput, 8000)
    assert.equal(result["zflow.review-integration"].maxOutput, 8000)
    assert.equal(result["zflow.review-security"].maxOutput, 8000)
    assert.equal(result["zflow.plan-review-integration"].maxOutput, 8000)
    assert.equal(result["zflow.plan-validator"].maxOutput, 6000)
    assert.equal(result["zflow.verifier"].maxOutput, 6000)
    assert.equal(result["zflow.repo-mapper"].maxOutput, 6000)
  })

  it("should accept explicit correct values", () => {
    const configs: Record<string, LaunchAgentConfig> = {
      "zflow.planner-frontier": { agent: "zflow.planner-frontier", model: "gpt-5", maxOutput: 12000 },
      "zflow.implement-routine": { agent: "zflow.implement-routine", model: "gpt-5", maxOutput: 8000 },
    }

    const result = enforceOutputLimits(configs)
    assert.equal(result["zflow.planner-frontier"].maxOutput, 12000)
    assert.equal(result["zflow.implement-routine"].maxOutput, 8000)
  })

  it("should throw when any agent has incorrect maxOutput", () => {
    const configs: Record<string, LaunchAgentConfig> = {
      "zflow.planner-frontier": { agent: "zflow.planner-frontier", model: "gpt-5", maxOutput: 12000 },
      "zflow.verifier": { agent: "zflow.verifier", model: "gpt-5", maxOutput: 9999 },
    }

    assert.throws(
      () => enforceOutputLimits(configs),
      /Invalid maxOutput for "zflow.verifier": expected 6000, got 9999/,
    )
  })

  it("should handle empty configs", () => {
    const result = enforceOutputLimits({})
    assert.deepEqual(result, {})
  })

  it("should return a new record (no mutation)", () => {
    const configs: Record<string, LaunchAgentConfig> = {
      "zflow.verifier": { agent: "zflow.verifier", model: "gpt-5" },
    }

    const result = enforceOutputLimits(configs)
    assert.notEqual(result, configs)
    assert.equal(result["zflow.verifier"].maxOutput, 6000)
    // Original should not have been mutated
    assert.equal(configs["zflow.verifier"].maxOutput, undefined)
  })

  it("should set correct output for all zflow agents", () => {
    const agents = Object.keys(EXPECTED_MAX_OUTPUT)
      .filter((a) => a.startsWith("zflow."))

    const configs: Record<string, LaunchAgentConfig> = {}
    for (const agent of agents) {
      configs[agent] = { agent, model: "gpt-5" }
    }

    const result = enforceOutputLimits(configs)

    for (const agent of agents) {
      const expected = EXPECTED_MAX_OUTPUT[agent]
      assert.equal(
        result[agent].maxOutput,
        expected,
        `Expected ${agent} to have maxOutput ${expected}, got ${result[agent].maxOutput}`,
      )
    }
  })

  it("should handle mixed explicit and default configs", () => {
    const configs: Record<string, LaunchAgentConfig> = {
      "zflow.planner-frontier": { agent: "zflow.planner-frontier", model: "gpt-5", maxOutput: 12000 },
      "zflow.implement-routine": { agent: "zflow.implement-routine", model: "gpt-5" },
      "zflow.verifier": { agent: "zflow.verifier", model: "gpt-5", maxOutput: 6000 },
    }

    const result = enforceOutputLimits(configs)

    assert.equal(result["zflow.planner-frontier"].maxOutput, 12000) // explicit
    assert.equal(result["zflow.implement-routine"].maxOutput, 8000) // default
    assert.equal(result["zflow.verifier"].maxOutput, 6000) // explicit
  })
})
