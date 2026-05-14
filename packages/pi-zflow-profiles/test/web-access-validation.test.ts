/**
 * web-access-validation.test.ts — Tests for web-access role scoping validation.
 */
import * as assert from "node:assert"
import { describe, it } from "node:test"

import { validateWebAccessScope } from "../src/builtin-overrides.js"

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
})
