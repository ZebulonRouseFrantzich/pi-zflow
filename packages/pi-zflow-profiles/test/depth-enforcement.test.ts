/**
 * depth-enforcement.test.ts — Tests for maxSubagentDepth enforcement.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  validateMaxSubagentDepth,
  getDefaultMaxSubagentDepth,
  enforceDepthLimits,
  applyDefaultMaxSubagentDepth,
  KNOWN_DEPTH_OVERRIDES,
} from "../src/depth-enforcement.js"

import type { LaunchAgentConfig } from "../src/launch-config.js"

// ── Known depth overrides ───────────────────────────────────────

void describe("KNOWN_DEPTH_OVERRIDES", () => {
  it("should contain planner-frontier with depth 1", () => {
    assert.equal(KNOWN_DEPTH_OVERRIDES["zflow.planner-frontier"], 1)
  })

  it("should not contain any other agents", () => {
    const keys = Object.keys(KNOWN_DEPTH_OVERRIDES)
    assert.equal(keys.length, 1)
    assert.equal(keys[0], "zflow.planner-frontier")
  })
})

// ── getDefaultMaxSubagentDepth ──────────────────────────────────

void describe("getDefaultMaxSubagentDepth", () => {
  it("should return 1 for planner-frontier", () => {
    assert.equal(getDefaultMaxSubagentDepth("zflow.planner-frontier"), 1)
  })

  it("should return 0 for implement-routine", () => {
    assert.equal(getDefaultMaxSubagentDepth("zflow.implement-routine"), 0)
  })

  it("should return 0 for implement-hard", () => {
    assert.equal(getDefaultMaxSubagentDepth("zflow.implement-hard"), 0)
  })

  it("should return 0 for verifier", () => {
    assert.equal(getDefaultMaxSubagentDepth("zflow.verifier"), 0)
  })

  it("should return 0 for synthesizer", () => {
    assert.equal(getDefaultMaxSubagentDepth("zflow.synthesizer"), 0)
  })

  it("should return 0 for review-correctness", () => {
    assert.equal(getDefaultMaxSubagentDepth("zflow.review-correctness"), 0)
  })

  it("should return 0 for review-integration", () => {
    assert.equal(getDefaultMaxSubagentDepth("zflow.review-integration"), 0)
  })

  it("should return 0 for review-security", () => {
    assert.equal(getDefaultMaxSubagentDepth("zflow.review-security"), 0)
  })

  it("should return 0 for review-logic", () => {
    assert.equal(getDefaultMaxSubagentDepth("zflow.review-logic"), 0)
  })

  it("should return 0 for review-system", () => {
    assert.equal(getDefaultMaxSubagentDepth("zflow.review-system"), 0)
  })

  it("should return 0 for plan-validator", () => {
    assert.equal(getDefaultMaxSubagentDepth("zflow.plan-validator"), 0)
  })

  it("should return 0 for plan-review-correctness", () => {
    assert.equal(getDefaultMaxSubagentDepth("zflow.plan-review-correctness"), 0)
  })

  it("should return 0 for plan-review-integration", () => {
    assert.equal(getDefaultMaxSubagentDepth("zflow.plan-review-integration"), 0)
  })

  it("should return 0 for plan-review-feasibility", () => {
    assert.equal(getDefaultMaxSubagentDepth("zflow.plan-review-feasibility"), 0)
  })

  it("should return 0 for repo-mapper", () => {
    assert.equal(getDefaultMaxSubagentDepth("zflow.repo-mapper"), 0)
  })

  it("should return 0 for unknown agents", () => {
    assert.equal(getDefaultMaxSubagentDepth("unknown.agent"), 0)
    assert.equal(getDefaultMaxSubagentDepth(""), 0)
  })
})

// ── validateMaxSubagentDepth ────────────────────────────────────

void describe("validateMaxSubagentDepth", () => {
  it("should pass for planner-frontier with depth 1", () => {
    validateMaxSubagentDepth("zflow.planner-frontier", 1)
  })

  it("should throw for planner-frontier with depth 0", () => {
    assert.throws(
      () => validateMaxSubagentDepth("zflow.planner-frontier", 0),
      /Invalid maxSubagentDepth for zflow\.planner-frontier/,
    )
  })

  it("should throw for planner-frontier with depth 2", () => {
    assert.throws(
      () => validateMaxSubagentDepth("zflow.planner-frontier", 2),
      /Invalid maxSubagentDepth for zflow\.planner-frontier/,
    )
  })

  it("should pass for implement-routine with depth 0", () => {
    validateMaxSubagentDepth("zflow.implement-routine", 0)
  })

  it("should throw for implement-routine with depth 1", () => {
    assert.throws(
      () => validateMaxSubagentDepth("zflow.implement-routine", 1),
      /Invalid maxSubagentDepth for zflow\.implement-routine/,
    )
  })

  it("should throw for implement-hard with depth 1", () => {
    assert.throws(
      () => validateMaxSubagentDepth("zflow.implement-hard", 1),
      /Invalid maxSubagentDepth for zflow\.implement-hard/,
    )
  })

  it("should pass for implement-hard with depth 0", () => {
    validateMaxSubagentDepth("zflow.implement-hard", 0)
  })

  it("should throw for verifier with depth 1", () => {
    assert.throws(
      () => validateMaxSubagentDepth("zflow.verifier", 1),
      /Invalid maxSubagentDepth for zflow\.verifier/,
    )
  })

  it("should pass for verifier with depth 0", () => {
    validateMaxSubagentDepth("zflow.verifier", 0)
  })

  it("should throw for synthesizer with depth 1", () => {
    assert.throws(
      () => validateMaxSubagentDepth("zflow.synthesizer", 1),
      /Invalid maxSubagentDepth for zflow\.synthesizer/,
    )
  })

  it("should throw for review-correctness with depth 1", () => {
    assert.throws(
      () => validateMaxSubagentDepth("zflow.review-correctness", 1),
      /Invalid maxSubagentDepth for zflow\.review-correctness/,
    )
  })

  it("should throw for unknown agent with depth 1", () => {
    assert.throws(
      () => validateMaxSubagentDepth("unknown.agent", 1),
      /Invalid maxSubagentDepth for unknown\.agent/,
    )
  })

  it("should pass for unknown agent with depth 0", () => {
    validateMaxSubagentDepth("unknown.agent", 0)
  })
})

// ── applyDefaultMaxSubagentDepth ────────────────────────────────

void describe("applyDefaultMaxSubagentDepth", () => {
  it("should set depth 1 for planner-frontier when not set", () => {
    const config: LaunchAgentConfig = { agent: "zflow.planner-frontier", model: "gpt-5" }
    const result = applyDefaultMaxSubagentDepth(config)
    assert.equal(result.maxSubagentDepth, 1)
  })

  it("should accept explicit depth 1 for planner-frontier", () => {
    const config: LaunchAgentConfig = { agent: "zflow.planner-frontier", model: "gpt-5", maxSubagentDepth: 1 }
    const result = applyDefaultMaxSubagentDepth(config)
    assert.equal(result.maxSubagentDepth, 1)
  })

  it("should set depth 0 for implement-routine when not set", () => {
    const config: LaunchAgentConfig = { agent: "zflow.implement-routine", model: "gpt-5" }
    const result = applyDefaultMaxSubagentDepth(config)
    assert.equal(result.maxSubagentDepth, 0)
  })

  it("should accept explicit depth 0 for implement-routine", () => {
    const config: LaunchAgentConfig = { agent: "zflow.implement-routine", model: "gpt-5", maxSubagentDepth: 0 }
    const result = applyDefaultMaxSubagentDepth(config)
    assert.equal(result.maxSubagentDepth, 0)
  })

  it("should throw when implement-routine has explicit depth 1", () => {
    const config: LaunchAgentConfig = { agent: "zflow.implement-routine", model: "gpt-5", maxSubagentDepth: 1 }
    assert.throws(
      () => applyDefaultMaxSubagentDepth(config),
      /Invalid maxSubagentDepth for zflow\.implement-routine/,
    )
  })

  it("should throw when implement-hard has explicit depth 1", () => {
    const config: LaunchAgentConfig = { agent: "zflow.implement-hard", model: "gpt-5", maxSubagentDepth: 1 }
    assert.throws(
      () => applyDefaultMaxSubagentDepth(config),
      /Invalid maxSubagentDepth for zflow\.implement-hard/,
    )
  })

  it("should set depth 0 for unknown agent when not set", () => {
    const config: LaunchAgentConfig = { agent: "unknown.agent", model: "gpt-5" }
    const result = applyDefaultMaxSubagentDepth(config)
    assert.equal(result.maxSubagentDepth, 0)
  })

  it("should preserve other config fields", () => {
    const config: LaunchAgentConfig = {
      agent: "zflow.verifier",
      model: "claude-4",
      tools: "read, grep, find, ls, bash",
      maxOutput: 8000,
      thinking: "medium",
    }
    const result = applyDefaultMaxSubagentDepth(config)
    assert.equal(result.agent, "zflow.verifier")
    assert.equal(result.model, "claude-4")
    assert.equal(result.tools, "read, grep, find, ls, bash")
    assert.equal(result.maxOutput, 8000)
    assert.equal(result.thinking, "medium")
    assert.equal(result.maxSubagentDepth, 0)
  })
})

// ── enforceDepthLimits ──────────────────────────────────────────

void describe("enforceDepthLimits", () => {
  it("should apply defaults to all configs", () => {
    const configs: Record<string, LaunchAgentConfig> = {
      "zflow.planner-frontier": { agent: "zflow.planner-frontier", model: "gpt-5" },
      "zflow.implement-routine": { agent: "zflow.implement-routine", model: "gpt-5" },
      "zflow.verifier": { agent: "zflow.verifier", model: "gpt-5" },
      "zflow.synthesizer": { agent: "zflow.synthesizer", model: "gpt-5" },
    }

    const result = enforceDepthLimits(configs)

    assert.equal(result["zflow.planner-frontier"].maxSubagentDepth, 1)
    assert.equal(result["zflow.implement-routine"].maxSubagentDepth, 0)
    assert.equal(result["zflow.verifier"].maxSubagentDepth, 0)
    assert.equal(result["zflow.synthesizer"].maxSubagentDepth, 0)
  })

  it("should accept explicit correct depths", () => {
    const configs: Record<string, LaunchAgentConfig> = {
      "zflow.planner-frontier": { agent: "zflow.planner-frontier", model: "gpt-5", maxSubagentDepth: 1 },
      "zflow.review-correctness": { agent: "zflow.review-correctness", model: "gpt-5", maxSubagentDepth: 0 },
    }

    const result = enforceDepthLimits(configs)
    assert.equal(result["zflow.planner-frontier"].maxSubagentDepth, 1)
    assert.equal(result["zflow.review-correctness"].maxSubagentDepth, 0)
  })

  it("should throw when any agent has incorrect depth", () => {
    const configs: Record<string, LaunchAgentConfig> = {
      "zflow.planner-frontier": { agent: "zflow.planner-frontier", model: "gpt-5", maxSubagentDepth: 1 },
      "zflow.review-correctness": { agent: "zflow.review-correctness", model: "gpt-5", maxSubagentDepth: 1 },
    }

    assert.throws(
      () => enforceDepthLimits(configs),
      /Invalid maxSubagentDepth for zflow\.review-correctness/,
    )
  })

  it("should handle empty configs", () => {
    const result = enforceDepthLimits({})
    assert.deepEqual(result, {})
  })

  it("should return a new record (no mutation)", () => {
    const configs: Record<string, LaunchAgentConfig> = {
      "zflow.verifier": { agent: "zflow.verifier", model: "gpt-5" },
    }

    const result = enforceDepthLimits(configs)
    assert.notEqual(result, configs)
    assert.equal(result["zflow.verifier"].maxSubagentDepth, 0)
    // Original should not have been mutated
    assert.equal(configs["zflow.verifier"].maxSubagentDepth, undefined)
  })

  it("should set depth correctly for all zflow agents", () => {
    const agents = [
      "zflow.planner-frontier",
      "zflow.implement-routine",
      "zflow.implement-hard",
      "zflow.verifier",
      "zflow.synthesizer",
      "zflow.review-correctness",
      "zflow.review-integration",
      "zflow.review-security",
      "zflow.review-logic",
      "zflow.review-system",
      "zflow.plan-validator",
      "zflow.plan-review-correctness",
      "zflow.plan-review-integration",
      "zflow.plan-review-feasibility",
      "zflow.repo-mapper",
    ]

    const configs: Record<string, LaunchAgentConfig> = {}
    for (const agent of agents) {
      configs[agent] = { agent, model: "gpt-5" }
    }

    const result = enforceDepthLimits(configs)

    for (const agent of agents) {
      const expected = agent === "zflow.planner-frontier" ? 1 : 0
      assert.equal(
        result[agent].maxSubagentDepth,
        expected,
        `Expected ${agent} to have depth ${expected}, got ${result[agent].maxSubagentDepth}`,
      )
    }
  })
})
