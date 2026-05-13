/**
 * output-conventions.test.ts — Tests for subagent output handling conventions.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  getAgentRole,
  getOutputConvention,
  getOutputInstructions,
  getOrchestratorOutputInstructions,
  isKnownAgent,
  getReportAgents,
  getImplementationAgents,
  getHybridAgents,
  REPORT_AGENTS,
  IMPLEMENTATION_AGENTS,
  HYBRID_AGENTS,
  ALL_AGENTS,
  OUTPUT_CONVENTIONS,
} from "../src/output-conventions.js"

import type { AgentRole, OutputConvention } from "../src/output-conventions.js"

// ── Agent sets completeness ─────────────────────────────────────

void describe("ALL_AGENTS", () => {
  it("should contain all report agents", () => {
    for (const agent of REPORT_AGENTS) {
      assert.ok(ALL_AGENTS.has(agent), `ALL_AGENTS missing report agent: ${agent}`)
    }
  })

  it("should contain all implementation agents", () => {
    for (const agent of IMPLEMENTATION_AGENTS) {
      assert.ok(ALL_AGENTS.has(agent), `ALL_AGENTS missing implementation agent: ${agent}`)
    }
  })

  it("should contain all hybrid agents", () => {
    for (const agent of HYBRID_AGENTS) {
      assert.ok(ALL_AGENTS.has(agent), `ALL_AGENTS missing hybrid agent: ${agent}`)
    }
  })

  it("should be the union of all three sets", () => {
    const union = new Set([...REPORT_AGENTS, ...IMPLEMENTATION_AGENTS, ...HYBRID_AGENTS])
    assert.equal(ALL_AGENTS.size, union.size)
    for (const agent of union) {
      assert.ok(ALL_AGENTS.has(agent))
    }
  })
})

// ── Agent set contents ──────────────────────────────────────────

void describe("REPORT_AGENTS", () => {
  const expected = [
    "builtin:scout",
    "zflow.repo-mapper",
    "zflow.verifier",
    "zflow.review-correctness",
    "zflow.review-integration",
    "zflow.review-security",
    "zflow.review-logic",
    "zflow.review-system",
    "zflow.plan-review-correctness",
    "zflow.plan-review-integration",
    "zflow.plan-review-feasibility",
    "zflow.plan-validator",
    "zflow.synthesizer",
  ]

  for (const agent of expected) {
    it(`should include ${agent}`, () => {
      assert.ok(REPORT_AGENTS.has(agent), `${agent} should be a report agent`)
    })
  }

  it("should have exactly the expected report agents", () => {
    assert.equal(REPORT_AGENTS.size, expected.length)
  })
})

void describe("IMPLEMENTATION_AGENTS", () => {
  const expected = [
    "zflow.implement-routine",
    "zflow.implement-hard",
  ]

  for (const agent of expected) {
    it(`should include ${agent}`, () => {
      assert.ok(IMPLEMENTATION_AGENTS.has(agent), `${agent} should be an implementation agent`)
    })
  }

  it("should have exactly the expected implementation agents", () => {
    assert.equal(IMPLEMENTATION_AGENTS.size, expected.length)
  })
})

void describe("HYBRID_AGENTS", () => {
  const expected = [
    "zflow.planner-frontier",
  ]

  for (const agent of expected) {
    it(`should include ${agent}`, () => {
      assert.ok(HYBRID_AGENTS.has(agent), `${agent} should be a hybrid agent`)
    })
  }

  it("should have exactly the expected hybrid agents", () => {
    assert.equal(HYBRID_AGENTS.size, expected.length)
  })
})

// ── getAgentRole ────────────────────────────────────────────────

void describe("getAgentRole", () => {
  it("should return 'report' for scout", () => {
    assert.equal(getAgentRole("builtin:scout"), "report")
  })

  it("should return 'report' for repo-mapper", () => {
    assert.equal(getAgentRole("zflow.repo-mapper"), "report")
  })

  it("should return 'report' for verifier", () => {
    assert.equal(getAgentRole("zflow.verifier"), "report")
  })

  it("should return 'report' for review-correctness", () => {
    assert.equal(getAgentRole("zflow.review-correctness"), "report")
  })

  it("should return 'report' for review-integration", () => {
    assert.equal(getAgentRole("zflow.review-integration"), "report")
  })

  it("should return 'report' for review-security", () => {
    assert.equal(getAgentRole("zflow.review-security"), "report")
  })

  it("should return 'report' for review-logic", () => {
    assert.equal(getAgentRole("zflow.review-logic"), "report")
  })

  it("should return 'report' for review-system", () => {
    assert.equal(getAgentRole("zflow.review-system"), "report")
  })

  it("should return 'report' for plan-review-correctness", () => {
    assert.equal(getAgentRole("zflow.plan-review-correctness"), "report")
  })

  it("should return 'report' for plan-review-integration", () => {
    assert.equal(getAgentRole("zflow.plan-review-integration"), "report")
  })

  it("should return 'report' for plan-review-feasibility", () => {
    assert.equal(getAgentRole("zflow.plan-review-feasibility"), "report")
  })

  it("should return 'report' for plan-validator", () => {
    assert.equal(getAgentRole("zflow.plan-validator"), "report")
  })

  it("should return 'report' for synthesizer", () => {
    assert.equal(getAgentRole("zflow.synthesizer"), "report")
  })

  it("should return 'implementation' for implement-routine", () => {
    assert.equal(getAgentRole("zflow.implement-routine"), "implementation")
  })

  it("should return 'implementation' for implement-hard", () => {
    assert.equal(getAgentRole("zflow.implement-hard"), "implementation")
  })

  it("should return 'hybrid' for planner-frontier", () => {
    assert.equal(getAgentRole("zflow.planner-frontier"), "hybrid")
  })

  it("should throw for unknown agent", () => {
    assert.throws(
      () => getAgentRole("zflow.unknown-agent"),
      /Unknown agent.*zflow\.unknown-agent/,
    )
  })

  it("should throw for empty string", () => {
    assert.throws(
      () => getAgentRole(""),
      /Unknown agent/,
    )
  })
})

// ── isKnownAgent ────────────────────────────────────────────────

void describe("isKnownAgent", () => {
  it("should return true for a report agent", () => {
    assert.ok(isKnownAgent("zflow.verifier"))
  })

  it("should return true for an implementation agent", () => {
    assert.ok(isKnownAgent("zflow.implement-routine"))
  })

  it("should return true for a hybrid agent", () => {
    assert.ok(isKnownAgent("zflow.planner-frontier"))
  })

  it("should return false for unknown agent", () => {
    assert.equal(isKnownAgent("zflow.unknown-agent"), false)
  })

  it("should return false for empty string", () => {
    assert.equal(isKnownAgent(""), false)
  })
})

// ── getOutputConvention ─────────────────────────────────────────

void describe("getOutputConvention", () => {
  it("should return the correct convention for verifier", () => {
    const conv = getOutputConvention("zflow.verifier")
    assert.equal(conv.agent, "zflow.verifier")
    assert.equal(conv.role, "report")
    assert.equal(conv.outputFormat, "structured-markdown")
    assert.equal(conv.persistsOutput, true)
  })

  it("should return the correct convention for implement-routine", () => {
    const conv = getOutputConvention("zflow.implement-routine")
    assert.equal(conv.agent, "zflow.implement-routine")
    assert.equal(conv.role, "implementation")
    assert.equal(conv.outputFormat, "file-changes")
    assert.equal(conv.persistsOutput, false)
  })

  it("should return the correct convention for planner-frontier", () => {
    const conv = getOutputConvention("zflow.planner-frontier")
    assert.equal(conv.agent, "zflow.planner-frontier")
    assert.equal(conv.role, "hybrid")
    assert.equal(conv.outputFormat, "plan-artifact")
    assert.equal(conv.persistsOutput, true)
  })

  it("should throw for unknown agent", () => {
    assert.throws(
      () => getOutputConvention("zflow.unknown-agent"),
      /Unknown agent.*zflow\.unknown-agent/,
    )
  })

  it("should return conventions for all known agents", () => {
    for (const agent of ALL_AGENTS) {
      const conv = getOutputConvention(agent)
      assert.ok(conv, `Must have convention for ${agent}`)
      assert.equal(conv.agent, agent)
      assert.ok(["report", "implementation", "hybrid"].includes(conv.role))
      assert.ok(["structured-markdown", "file-changes", "plan-artifact"].includes(conv.outputFormat))
    }
  })
})

// ── OUTPUT_CONVENTIONS completeness ─────────────────────────────

void describe("OUTPUT_CONVENTIONS", () => {
  it("should have an entry for every known agent", () => {
    for (const agent of ALL_AGENTS) {
      assert.ok(
        OUTPUT_CONVENTIONS[agent] !== undefined,
        `Missing OUTPUT_CONVENTIONS entry for ${agent}`,
      )
    }
  })

  it("should not have entries for unknown agents", () => {
    const extraKeys = Object.keys(OUTPUT_CONVENTIONS).filter(
      (key) => !ALL_AGENTS.has(key),
    )
    assert.equal(extraKeys.length, 0, `Unexpected extra conventions: ${extraKeys.join(", ")}`)
  })

  it("should have the correct total count", () => {
    assert.equal(Object.keys(OUTPUT_CONVENTIONS).length, ALL_AGENTS.size)
  })
})

// ── getReportAgents / getImplementationAgents / getHybridAgents ──

void describe("getReportAgents", () => {
  it("should return all report agents sorted", () => {
    const agents = getReportAgents()
    const sorted = [...REPORT_AGENTS].sort()
    assert.deepEqual(agents, sorted)
  })
})

void describe("getImplementationAgents", () => {
  it("should return all implementation agents sorted", () => {
    const agents = getImplementationAgents()
    const sorted = [...IMPLEMENTATION_AGENTS].sort()
    assert.deepEqual(agents, sorted)
  })
})

void describe("getHybridAgents", () => {
  it("should return all hybrid agents sorted", () => {
    const agents = getHybridAgents()
    const sorted = [...HYBRID_AGENTS].sort()
    assert.deepEqual(agents, sorted)
  })
})

// ── getOutputInstructions ───────────────────────────────────────

void describe("getOutputInstructions", () => {
  it("should include output conventions heading for report agent", () => {
    const instructions = getOutputInstructions("zflow.verifier")
    assert.ok(instructions.includes("## Output conventions"))
    assert.ok(instructions.includes("report-style agent"))
    assert.ok(instructions.includes("Do not use `edit`, `write`"))
  })

  it("should include structured markdown format for report agent", () => {
    const instructions = getOutputInstructions("zflow.synthesizer")
    assert.ok(instructions.includes("structured-markdown"))
  })

  it("should include output conventions heading for implementation agent", () => {
    const instructions = getOutputInstructions("zflow.implement-routine")
    assert.ok(instructions.includes("## Output conventions"))
    assert.ok(instructions.includes("implementation agent"))
    assert.ok(instructions.includes("Use `edit` and `write` tools"))
  })

  it("should include output conventions heading for hybrid agent", () => {
    const instructions = getOutputInstructions("zflow.planner-frontier")
    assert.ok(instructions.includes("## Output conventions"))
    assert.ok(instructions.includes("hybrid agent"))
    assert.ok(instructions.includes("restricted write tool"))
    assert.ok(instructions.includes("plan-artifact"))
  })

  it("should throw for unknown agent", () => {
    assert.throws(
      () => getOutputInstructions("zflow.unknown"),
      /Unknown agent/,
    )
  })

  it("should include report persistence reminder for report agents", () => {
    const instructions = getOutputInstructions("zflow.review-correctness")
    assert.ok(instructions.includes("not write files"))
    assert.ok(instructions.includes("persisted automatically"))
  })

  it("should include scoped verification reminder for implementation agents", () => {
    const instructions = getOutputInstructions("zflow.implement-hard")
    assert.ok(instructions.includes("scoped verification"))
    assert.ok(instructions.includes("summary"))
  })

  it("should generate valid instructions for all known agents", () => {
    for (const agent of ALL_AGENTS) {
      const instructions = getOutputInstructions(agent)
      assert.ok(instructions.length > 0, `Instructions for ${agent} should not be empty`)
      assert.ok(instructions.includes("## Output conventions"), `Instructions for ${agent} should have heading`)
    }
  })
})

// ── getOrchestratorOutputInstructions ───────────────────────────

void describe("getOrchestratorOutputInstructions", () => {
  it("should return a non-empty string", () => {
    const instructions = getOrchestratorOutputInstructions()
    assert.ok(instructions.length > 0)
  })

  it("should mention all three agent role types", () => {
    const instructions = getOrchestratorOutputInstructions()
    assert.ok(instructions.includes("Report-style agents"))
    assert.ok(instructions.includes("Implementation agents"))
    assert.ok(instructions.includes("Hybrid agents"))
  })

  it("should explain persistence responsibility", () => {
    const instructions = getOrchestratorOutputInstructions()
    assert.ok(instructions.includes("Persist their output"))
    assert.ok(instructions.includes("runtime-state files"))
  })

  it("should explain that file changes ARE the deliverable for impl agents", () => {
    const instructions = getOrchestratorOutputInstructions()
    assert.ok(instructions.includes("file changes ARE the primary output"))
  })
})

// ── Invariant: all known agents from other modules must match ───

void describe("Cross-module consistency", () => {
  it("should cover all agents that have depth enforcement", () => {
    // This is a cross-check: agents in depth-enforcement.ts should match
    const depthEnforcementAgents = [
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

    for (const agent of depthEnforcementAgents) {
      assert.ok(
        isKnownAgent(agent),
        `output-conventions should know about ${agent} (from depth-enforcement)`,
      )
    }
  })

  it("should cover all agents that have output limits", () => {
    // From the plan's required maxOutput targets
    const outputLimitAgents = [
      "builtin:scout",
      "zflow.planner-frontier",
      "zflow.synthesizer",
      "zflow.implement-hard",
      "zflow.review-correctness",
      "zflow.review-logic",
      "zflow.plan-review-correctness",
      "zflow.plan-review-feasibility",
      "zflow.implement-routine",
      "zflow.review-integration",
      "zflow.review-security",
      "zflow.plan-review-integration",
      "zflow.plan-validator",
      "zflow.repo-mapper",
      "zflow.verifier",
      "zflow.review-system",
    ]

    for (const agent of outputLimitAgents) {
      assert.ok(
        isKnownAgent(agent),
        `output-conventions should know about ${agent} (from output limits)`,
      )
    }
  })
})
