/**
 * max-output-policy.test.ts — Tests for maxOutput enforcement policy.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import {
  validateMaxOutput,
  applyDefaultMaxOutput,
  getDefaultMaxOutput,
  EXPECTED_MAX_OUTPUT,
} from "../src/output-limits.js"

import type { LaunchAgentConfig } from "../src/launch-config.js"

// ── Helpers ─────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * Read the policy document from the project docs directory.
 */
async function readDoc(filename: string): Promise<string> {
  const docPath = path.resolve(__dirname, "..", "..", "..", "docs", filename)
  return await fs.readFile(docPath, "utf-8")
}

// ── Policy document tests ───────────────────────────────────────

void describe("max-output-policy", () => {
  it("policy document exists and contains key enforcement rules", async () => {
    const policy = await readDoc("max-output-policy.md")
    assert.ok(policy.includes("maxOutput"))
    assert.ok(policy.includes("No agent launch without a known"))
    assert.ok(policy.includes("Enforcement flow"))
    assert.ok(policy.includes("EXPECTED_MAX_OUTPUT"))
  })

  it("policy documents expected values by role", async () => {
    const policy = await readDoc("max-output-policy.md")
    // Planning tier
    assert.ok(policy.includes("zflow.planner-frontier"))
    // Implementation tier
    assert.ok(policy.includes("zflow.implement-routine"))
    assert.ok(policy.includes("zflow.implement-hard"))
    // Review tier
    assert.ok(policy.includes("zflow.review-correctness"))
    assert.ok(policy.includes("zflow.review-security"))
    // Synthesis tier
    assert.ok(policy.includes("zflow.synthesizer"))
    // Builtin agents
    assert.ok(policy.includes("builtin:scout"))
    assert.ok(policy.includes("builtin:context-builder"))
  })

  it("policy documents enforcement flow steps", async () => {
    const policy = await readDoc("max-output-policy.md")
    assert.ok(policy.includes("applyDefaultMaxOutput"))
    assert.ok(policy.includes("validateMaxOutput"))
    assert.ok(policy.includes("agent frontmatter"))
    assert.ok(policy.includes("profile binding"))
  })

  it("policy documents how to add new agents", async () => {
    const policy = await readDoc("max-output-policy.md")
    assert.ok(policy.includes("Add an entry to"))
    assert.ok(policy.includes("How to add a new agent"))
  })

  it("policy documents relationship to context management", async () => {
    const policy = await readDoc("max-output-policy.md")
    assert.ok(policy.includes("context window"))
    assert.ok(policy.includes("prevention"))
    assert.ok(policy.includes("compaction"))
  })
})

// ── EXPECTED_MAX_OUTPUT value range tests ───────────────────────

void describe("EXPECTED_MAX_OUTPUT value ranges", () => {
  it("all agent values are between 1000 and 20000", () => {
    for (const [agent, value] of Object.entries(EXPECTED_MAX_OUTPUT)) {
      assert.ok(
        value >= 1000 && value <= 20000,
        `Agent "${agent}" has maxOutput ${value}, expected between 1000 and 20000`,
      )
    }
  })

  it("planning tier agents have reasonable values", () => {
    assert.equal(EXPECTED_MAX_OUTPUT["zflow.planner-frontier"], 12000)
    assert.equal(EXPECTED_MAX_OUTPUT["zflow.plan-validator"], 6000)
    assert.equal(EXPECTED_MAX_OUTPUT["zflow.repo-mapper"], 6000)
  })

  it("implementation tier agents have reasonable values", () => {
    assert.equal(EXPECTED_MAX_OUTPUT["zflow.implement-hard"], 10000)
    assert.equal(EXPECTED_MAX_OUTPUT["zflow.implement-routine"], 8000)
    assert.equal(EXPECTED_MAX_OUTPUT["zflow.verifier"], 6000)
  })

  it("review tier agents have reasonable values", () => {
    assert.equal(EXPECTED_MAX_OUTPUT["zflow.review-correctness"], 10000)
    assert.equal(EXPECTED_MAX_OUTPUT["zflow.review-integration"], 8000)
    assert.equal(EXPECTED_MAX_OUTPUT["zflow.review-security"], 8000)
    assert.equal(EXPECTED_MAX_OUTPUT["zflow.review-logic"], 10000)
    assert.equal(EXPECTED_MAX_OUTPUT["zflow.review-system"], 12000)
  })

  it("synthesis tier agents have reasonable values", () => {
    assert.equal(EXPECTED_MAX_OUTPUT["zflow.synthesizer"], 12000)
  })
})

// ── applyDefaultMaxOutput enforcement tests ─────────────────────

void describe("applyDefaultMaxOutput enforcement", () => {
  it("throws for unknown agents", () => {
    const config: LaunchAgentConfig = {
      agent: "zflow.unknown-agent",
      model: "openai/gpt-4o",
      maxOutput: undefined,
    }
    assert.throws(() => {
      applyDefaultMaxOutput(config)
    }, /unknown/i)
  })

  it("applies default when maxOutput is undefined", () => {
    const config: LaunchAgentConfig = {
      agent: "zflow.planner-frontier",
      model: "openai/gpt-4o",
      maxOutput: undefined,
    }
    const result = applyDefaultMaxOutput(config)
    assert.equal(result.maxOutput, 12000)
  })

  it("rejects mismatched values", () => {
    const config: LaunchAgentConfig = {
      agent: "zflow.planner-frontier",
      model: "openai/gpt-4o",
      maxOutput: 6000, // wrong — should be 12000
    }
    assert.throws(() => {
      applyDefaultMaxOutput(config)
    }, /expected 12000, got 6000/i)
  })

  it("accepts correct explicit values", () => {
    const config: LaunchAgentConfig = {
      agent: "zflow.planner-frontier",
      model: "openai/gpt-4o",
      maxOutput: 12000,
    }
    const result = applyDefaultMaxOutput(config)
    assert.equal(result.maxOutput, 12000)
  })
})

// ── validateMaxOutput tests ─────────────────────────────────────

void describe("validateMaxOutput enforcement", () => {
  it("returns valid for correct values", () => {
    const result = validateMaxOutput("zflow.planner-frontier", 12000)
    assert.equal(result.valid, true)
    assert.equal(result.errors.length, 0)
  })

  it("returns invalid for missing values", () => {
    const result = validateMaxOutput("zflow.planner-frontier", undefined)
    assert.equal(result.valid, false)
    assert.ok(result.errors.length > 0)
  })

  it("returns invalid for wrong values", () => {
    const result = validateMaxOutput("zflow.planner-frontier", 6000)
    assert.equal(result.valid, false)
    assert.ok(result.errors.length > 0)
    assert.ok(result.errors[0].includes("expected 12000"))
  })

  it("returns invalid for unknown agents", () => {
    const result = validateMaxOutput("zflow.unknown-agent", 6000)
    assert.equal(result.valid, false)
    assert.ok(result.errors.length > 0)
  })
})
