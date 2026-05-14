/**
 * web-access-validation.test.ts — Tests for web-access role scoping validation.
 */
import * as assert from "node:assert"
import { describe, it } from "node:test"

import { validateWebAccessScope } from "../src/builtin-overrides.js"
import { buildLaunchConfig } from "../src/launch-config.js"
import type { ResolvedProfile } from "../extensions/zflow-profiles/profiles.js"

const IMPLEMENTATION_AGENTS = [
  "zflow.implement-routine",
  "zflow.implement-hard",
  "zflow.verifier",
  "zflow.repo-mapper",
]

const ALLOWED_AGENTS = [
  "zflow.planner-frontier",
  "zflow.plan-review-correctness",
  "zflow.plan-review-integration",
  "zflow.plan-review-feasibility",
  "zflow.review-correctness",
  "zflow.review-integration",
  "zflow.review-security",
  "zflow.review-logic",
  "zflow.review-system",
]

function makeResolvedProfile(agentName: string, tools: string): ResolvedProfile {
  return {
    profileName: "test-profile",
    sourcePath: "/tmp/profile.json",
    resolvedAt: "2026-05-14T00:00:00.000Z",
    resolvedLanes: {
      "worker-cheap": {
        lane: "worker-cheap",
        model: "openai/gpt-5.4-mini",
        required: true,
        optional: false,
        thinking: "low",
        status: "resolved",
      },
    },
    agentBindings: {
      [agentName]: {
        agent: agentName,
        lane: "worker-cheap",
        resolvedModel: "openai/gpt-5.4-mini",
        optional: false,
        tools,
        maxOutput: 8000,
        maxSubagentDepth: 0,
        status: "resolved",
      },
    },
  }
}

describe("web-access validation", () => {
  it("rejects web tools on implementation/verifier/repo-mapper agents", () => {
    for (const agent of IMPLEMENTATION_AGENTS) {
      const result = validateWebAccessScope(agent, "read, grep, find, ls, bash, edit, write, web_search, code_search")
      assert.equal(result.valid, false, `${agent} should be rejected for web access`)
      assert.ok(result.reason, `${agent} should have a rejection reason`)
    }
  })

  it("allows web tools on planner/review agents", () => {
    for (const agent of ALLOWED_AGENTS) {
      const result = validateWebAccessScope(agent, "read, grep, find, ls, web_search, fetch_content")
      assert.equal(result.valid, true, `${agent} should be allowed web access`)
    }
  })

  it("passes agents without web tools regardless of role", () => {
    const allAgents = [...IMPLEMENTATION_AGENTS, ...ALLOWED_AGENTS]
    for (const agent of allAgents) {
      const result = validateWebAccessScope(agent, "read, grep, find, ls, bash")
      assert.equal(result.valid, true, `${agent} without web tools should pass`)
    }
  })

  it("returns valid for unknown agents without web tools", () => {
    const result = validateWebAccessScope("zflow.unknown-agent", "read, grep")
    assert.equal(result.valid, true)
  })

  it("returns invalid for unknown agents WITH web tools", () => {
    const result = validateWebAccessScope("zflow.unknown-agent", "read, web_search")
    assert.equal(result.valid, false)
    assert.ok(result.reason)
  })

  it("handles undefined tools gracefully", () => {
    const result = validateWebAccessScope("zflow.implement-routine", undefined)
    assert.equal(result.valid, true)
  })

  it("handles tools as string array", () => {
    const result = validateWebAccessScope(
      "zflow.implement-routine",
      ["read", "grep", "web_search"],
    )
    assert.equal(result.valid, false)
  })

  it("buildLaunchConfig rejects profile bindings that grant web tools to implementation agents", () => {
    const profile = makeResolvedProfile(
      "zflow.implement-routine",
      "read, grep, find, ls, bash, edit, write, web_search",
    )

    assert.throws(
      () => buildLaunchConfig("zflow.implement-routine", profile),
      /web-access tools.*not in an allowed role/,
    )
  })

  it("buildLaunchConfig allows profile bindings that grant web tools to planner agents", () => {
    const profile = makeResolvedProfile(
      "zflow.planner-frontier",
      "read, grep, find, ls, bash, web_search, fetch_content",
    )

    const config = buildLaunchConfig("zflow.planner-frontier", profile)

    assert.ok(config)
    assert.equal(config.tools, "read, grep, find, ls, bash, web_search, fetch_content")
  })
})

describe("synthesizer web-access policy", () => {
  it("rejects web tools on synthesizer — per web-access-policy.md", () => {
    const result = validateWebAccessScope(
      "zflow.synthesizer",
      "read, grep, find, ls, bash, web_search, fetch_content",
    )
    assert.equal(result.valid, false, "synthesizer should NOT be allowed web tools")
    assert.ok(result.reason, "synthesizer should have a rejection reason")
  })

  it("passes synthesizer without web tools", () => {
    const result = validateWebAccessScope(
      "zflow.synthesizer",
      "read, grep, find, ls, bash",
    )
    assert.equal(result.valid, true, "synthesizer without web tools should pass")
  })
})
