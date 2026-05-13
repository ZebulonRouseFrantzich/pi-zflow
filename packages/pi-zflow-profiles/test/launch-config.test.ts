/**
 * launch-config.test.ts — Tests for resolved-agent launch config generation.
 *
 * Covers:
 *   - buildLaunchConfig returns correct shape for a resolved agent
 *   - buildLaunchConfig returns null for unknown agent
 *   - buildLaunchConfig returns null when lane is unresolved
 *   - buildLaunchConfig inherits thinking from resolved lane
 *   - buildLaunchConfig preserves binding-level overrides
 *   - buildAllLaunchConfigs builds configs for all resolved agents
 *   - buildAllLaunchConfigs omits unresolved agents
 *   - buildAllLaunchConfigs returns empty record for empty profile
 *   - validateLaunchConfig basic and strict modes
 */
import { describe, it } from "node:test"
import * as assert from "node:assert/strict"
import {
  buildLaunchConfig,
  buildAllLaunchConfigs,
  validateLaunchConfig,
} from "../src/launch-config.js"
import type { ResolvedProfile } from "../extensions/zflow-profiles/profiles.js"

// ── Fixtures ────────────────────────────────────────────────────

/** A minimal resolved profile with two agents. */
function makeResolvedProfile(
  overrides?: Partial<ResolvedProfile>,
): ResolvedProfile {
  return {
    profileName: "test-profile",
    sourcePath: "/home/user/.pi/agent/zflow/profiles/test-profile.json",
    resolvedAt: "2026-05-13T00:00:00.000Z",
    resolvedLanes: {
      "planning-frontier": {
        lane: "planning-frontier",
        model: "openai/gpt-5.4",
        required: true,
        optional: false,
        thinking: "high",
        status: "resolved",
      },
      "worker-strong": {
        lane: "worker-strong",
        model: "openai/gpt-5.4-codex",
        required: true,
        optional: false,
        thinking: "high",
        status: "resolved",
      },
      "worker-cheap": {
        lane: "worker-cheap",
        model: "openai/gpt-5.4-mini",
        required: false,
        optional: true,
        thinking: "low",
        status: "resolved",
      },
      "scout-cheap": {
        lane: "scout-cheap",
        model: null,
        required: false,
        optional: true,
        thinking: "low",
        status: "disabled-optional",
        reason: "Optional lane disabled: no valid model",
      },
    },
    agentBindings: {
      "zflow.planner-frontier": {
        agent: "zflow.planner-frontier",
        lane: "planning-frontier",
        resolvedModel: "openai/gpt-5.4",
        optional: false,
        tools: "read, grep, find, ls, bash, zflow_write_plan_artifact, web_search, fetch_content, subagent",
        maxOutput: 12000,
        maxSubagentDepth: 1,
        status: "resolved",
      },
      "zflow.implement-routine": {
        agent: "zflow.implement-routine",
        lane: "worker-cheap",
        resolvedModel: "openai/gpt-5.4-mini",
        optional: false,
        tools: "read, grep, find, ls, bash, edit, write",
        maxOutput: 8000,
        maxSubagentDepth: 0,
        status: "resolved",
      },
      "zflow.scout": {
        agent: "zflow.scout",
        lane: "scout-cheap",
        resolvedModel: null,
        optional: true,
        tools: "read, grep, find, ls, bash",
        maxOutput: 6000,
        maxSubagentDepth: 0,
        status: "disabled-optional",
        reason: "Optional lane disabled: no valid model",
      },
    },
    ...overrides,
  }
}

/** A resolved profile with no agent bindings. */
function emptyResolvedProfile(): ResolvedProfile {
  return {
    profileName: "empty",
    sourcePath: "/dev/null",
    resolvedAt: "2026-05-13T00:00:00.000Z",
    resolvedLanes: {},
    agentBindings: {},
  }
}

// ── Tests ───────────────────────────────────────────────────────

describe("buildLaunchConfig", () => {
  it("returns a complete LaunchAgentConfig for a resolved agent", () => {
    const profile = makeResolvedProfile()
    const config = buildLaunchConfig("zflow.planner-frontier", profile)

    assert.notEqual(config, null)
    assert.equal(config!.agent, "zflow.planner-frontier")
    assert.equal(config!.model, "openai/gpt-5.4")
    assert.equal(config!.tools, "read, grep, find, ls, bash, zflow_write_plan_artifact, web_search, fetch_content, subagent")
    assert.equal(config!.maxOutput, 12000)
    assert.equal(config!.maxSubagentDepth, 1)
    assert.equal(config!.thinking, "high")
  })

  it("returns null for an unknown agent name", () => {
    const profile = makeResolvedProfile()
    const config = buildLaunchConfig("zflow.nonexistent", profile)
    assert.equal(config, null)
  })

  it("returns null when the agent's lane is unresolved", () => {
    const profile = makeResolvedProfile()
    // zflow.scout is bound to scout-cheap which is disabled-optional
    const config = buildLaunchConfig("zflow.scout", profile)
    assert.equal(config, null)
  })

  it("inherits thinking from the resolved lane", () => {
    const profile = makeResolvedProfile()
    const config = buildLaunchConfig("zflow.implement-routine", profile)
    assert.notEqual(config, null)
    // implement-routine is bound to worker-cheap which has thinking: "low"
    assert.equal(config!.thinking, "low")
    assert.equal(config!.model, "openai/gpt-5.4-mini")
  })

  it("preserves binding-level tools, maxOutput, and maxSubagentDepth", () => {
    const profile = makeResolvedProfile()
    const config = buildLaunchConfig("zflow.implement-routine", profile)
    assert.notEqual(config, null)
    assert.equal(config!.tools, "read, grep, find, ls, bash, edit, write")
    assert.equal(config!.maxOutput, 8000)
    assert.equal(config!.maxSubagentDepth, 0)
  })
})

describe("buildAllLaunchConfigs", () => {
  it("builds configs for all resolved agents", () => {
    const profile = makeResolvedProfile()
    const configs = buildAllLaunchConfigs(profile)

    // planner-frontier is resolved, implement-routine is resolved, scout is not
    assert.equal(Object.keys(configs).length, 2)

    assert.ok(configs["zflow.planner-frontier"])
    assert.equal(configs["zflow.planner-frontier"].model, "openai/gpt-5.4")

    assert.ok(configs["zflow.implement-routine"])
    assert.equal(configs["zflow.implement-routine"].model, "openai/gpt-5.4-mini")

    // scout should be omitted (unresolved lane)
    assert.equal(configs["zflow.scout"], undefined)
  })

  it("returns empty record for profile with no agent bindings", () => {
    const profile = emptyResolvedProfile()
    const configs = buildAllLaunchConfigs(profile)
    assert.deepEqual(configs, {})
  })

  it("omits agents with null resolvedModel", () => {
    const profile = makeResolvedProfile({
      agentBindings: {
        "zflow.planner-frontier": {
          agent: "zflow.planner-frontier",
          lane: "planning-frontier",
          resolvedModel: null,
          optional: false,
          status: "unresolved-required",
          reason: "Could not resolve",
        },
        "zflow.implement-routine": {
          agent: "zflow.implement-routine",
          lane: "worker-cheap",
          resolvedModel: null,
          optional: true,
          status: "disabled-optional",
          reason: "Optional lane disabled",
        },
      },
    })
    const configs = buildAllLaunchConfigs(profile)
    assert.deepEqual(configs, {})
  })
})

describe("validateLaunchConfig", () => {
  it("returns true for a valid config in normal mode", () => {
    const valid = validateLaunchConfig({
      agent: "zflow.planner-frontier",
      model: "openai/gpt-5.4",
      tools: "read, grep",
      maxOutput: 12000,
      maxSubagentDepth: 1,
      thinking: "high",
    })
    assert.equal(valid, true)
  })

  it("returns false when agent is empty", () => {
    const valid = validateLaunchConfig({
      agent: "",
      model: "openai/gpt-5.4",
    })
    assert.equal(valid, false)
  })

  it("returns false when model is empty", () => {
    const valid = validateLaunchConfig({
      agent: "zflow.planner-frontier",
      model: "",
    })
    assert.equal(valid, false)
  })

  it("strict mode rejects missing optional fields", () => {
    const valid = validateLaunchConfig({
      agent: "zflow.planner-frontier",
      model: "openai/gpt-5.4",
    }, true)
    assert.equal(valid, false)
  })

  it("strict mode passes with all fields present", () => {
    const valid = validateLaunchConfig({
      agent: "zflow.planner-frontier",
      model: "openai/gpt-5.4",
      tools: "read, grep",
      maxOutput: 12000,
      maxSubagentDepth: 0,
      thinking: "medium",
    }, true)
    assert.equal(valid, true)
  })
})
