/**
 * builtin-overrides.test.ts — Tests for builtin agent override configuration.
 *
 * Covers:
 *   - Scout override has correct lane, tools, maxSubagentDepth, maxOutput
 *   - Unknown builtin returns null from getBuiltinOverride
 *   - hasBuiltinOverride returns true for known, false for unknown
 *   - applyBuiltinOverride merges correctly with base config
 *   - applyBuiltinOverride preserves base config values when present
 *   - applyBuiltinOverride fills missing values from override
 *   - getAllBuiltinOverrides returns all registered overrides
 *   - getBuiltinOverrideValues returns just the override values
 *   - Registry is extensible (values are not frozen)
 */
import { describe, it } from "node:test"
import * as assert from "node:assert/strict"
import {
  getBuiltinOverride,
  applyBuiltinOverride,
  hasBuiltinOverride,
  getAllBuiltinOverrides,
  getBuiltinOverrideValues,
  BUILTIN_SCOUT_OVERRIDE,
  BUILTIN_CONTEXT_BUILDER_OVERRIDE,
} from "../src/builtin-overrides.js"
import type { LaunchAgentConfig } from "../src/launch-config.js"

// ── Fixtures ────────────────────────────────────────────────────

/** A base launch config for an agent that has a profile binding. */
function makeBaseConfig(overrides?: Partial<LaunchAgentConfig>): LaunchAgentConfig {
  return {
    agent: "zflow.some-agent",
    model: "openai/gpt-5.4-mini",
    tools: "read, grep, find, ls",
    maxOutput: 8000,
    maxSubagentDepth: 0,
    thinking: "low",
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────────

describe("BUILTIN_SCOUT_OVERRIDE", () => {
  it("has the correct name", () => {
    assert.equal(BUILTIN_SCOUT_OVERRIDE.name, "builtin-scout")
  })

  it("has the correct lane", () => {
    assert.equal(BUILTIN_SCOUT_OVERRIDE.override.lane, "scout-cheap")
  })

  it("has the correct tools", () => {
    assert.equal(
      BUILTIN_SCOUT_OVERRIDE.override.tools,
      "read, grep, find, ls, bash",
    )
  })

  it("has maxOutput of 6000", () => {
    assert.equal(BUILTIN_SCOUT_OVERRIDE.override.maxOutput, 6000)
  })

  it("has maxSubagentDepth of 0", () => {
    assert.equal(BUILTIN_SCOUT_OVERRIDE.override.maxSubagentDepth, 0)
  })
})

describe("getBuiltinOverride", () => {
  it("returns scout override for 'scout'", () => {
    const result = getBuiltinOverride("scout")
    assert.notEqual(result, null)
    assert.equal(result!.name, "builtin-scout")
  })

  it("returns null for unknown builtin", () => {
    const result = getBuiltinOverride("nonexistent-agent")
    assert.equal(result, null)
  })

  it("returns null for empty string", () => {
    const result = getBuiltinOverride("")
    assert.equal(result, null)
  })
})

describe("hasBuiltinOverride", () => {
  it("returns true for known builtin 'scout'", () => {
    assert.equal(hasBuiltinOverride("scout"), true)
  })

  it("returns false for unknown builtin", () => {
    assert.equal(hasBuiltinOverride("unknown-agent"), false)
  })

  it("returns false for empty string", () => {
    assert.equal(hasBuiltinOverride(""), false)
  })
})

describe("applyBuiltinOverride", () => {
  it("merges override into base config (fills missing values)", () => {
    // Base config with no tools, maxOutput, or maxSubagentDepth set
    // (only agent and model are provided)
    const base: LaunchAgentConfig = {
      agent: "scout",
      model: "openai/gpt-5.4-mini",
    }
    const override = getBuiltinOverride("scout")!
    const result = applyBuiltinOverride(base, override)

    assert.equal(result.agent, "scout")
    assert.equal(result.model, "openai/gpt-5.4-mini")
    // Override fills in missing values
    assert.equal(result.tools, "read, grep, find, ls, bash")
    assert.equal(result.maxOutput, 6000)
    assert.equal(result.maxSubagentDepth, 0)
    // thinking comes from base (undefined) and override doesn't set it
    assert.equal(result.thinking, undefined)
  })

  it("preserves base config tools when override also has tools", () => {
    // Base config has tools: "read, grep, find, ls"
    // Override has tools: "read, grep, find, ls, bash"
    // Base takes precedence per design (profile binding is authoritative)
    const base = makeBaseConfig({
      tools: "read, grep, find, ls, bash, web_search",
    })
    const override = getBuiltinOverride("scout")!
    const result = applyBuiltinOverride(base, override)

    assert.equal(result.tools, "read, grep, find, ls, bash, web_search")
  })

  it("preserves base config maxOutput when override has maxOutput", () => {
    const base = makeBaseConfig({ maxOutput: 12000 })
    const override = getBuiltinOverride("scout")!
    const result = applyBuiltinOverride(base, override)

    assert.equal(result.maxOutput, 12000)
  })

  it("preserves base config maxSubagentDepth when override has maxSubagentDepth", () => {
    const base = makeBaseConfig({ maxSubagentDepth: 1 })
    const override = getBuiltinOverride("scout")!
    const result = applyBuiltinOverride(base, override)

    assert.equal(result.maxSubagentDepth, 1)
  })

  it("fills missing tools from override", () => {
    const base = makeBaseConfig({ tools: undefined })
    const override = getBuiltinOverride("scout")!
    const result = applyBuiltinOverride(base, override)

    assert.equal(result.tools, "read, grep, find, ls, bash")
  })

  it("fills missing maxOutput from override", () => {
    const base = makeBaseConfig({ maxOutput: undefined })
    const override = getBuiltinOverride("scout")!
    const result = applyBuiltinOverride(base, override)

    assert.equal(result.maxOutput, 6000)
  })

  it("fills missing maxSubagentDepth from override", () => {
    const base = makeBaseConfig({ maxSubagentDepth: undefined })
    const override = getBuiltinOverride("scout")!
    const result = applyBuiltinOverride(base, override)

    assert.equal(result.maxSubagentDepth, 0)
  })

  it("preserves thinking from base config unchanged", () => {
    const base = makeBaseConfig({ thinking: "high" })
    const override = getBuiltinOverride("scout")!
    const result = applyBuiltinOverride(base, override)

    assert.equal(result.thinking, "high")
  })

  it("returns a new object (does not mutate base)", () => {
    const base = makeBaseConfig()
    const override = getBuiltinOverride("scout")!
    const result = applyBuiltinOverride(base, override)

    assert.notEqual(result, base)
    assert.deepEqual(
      { agent: base.agent, model: base.model },
      { agent: result.agent, model: result.model },
    )
  })
})

describe("getAllBuiltinOverrides", () => {
  it("returns a record with at least scout", () => {
    const all = getAllBuiltinOverrides()
    assert.ok("scout" in all)
    assert.equal(all.scout.name, "builtin-scout")
  })

  it("returns a copy (not the internal registry)", () => {
    const all = getAllBuiltinOverrides()
    all.scout = { name: "hacked", description: "", override: {} }
    // Original should still be intact
    const original = getBuiltinOverride("scout")
    assert.equal(original!.name, "builtin-scout")
  })
})

describe("getBuiltinOverrideValues", () => {
  it("returns override values for known builtin", () => {
    const values = getBuiltinOverrideValues("scout")
    assert.notEqual(values, null)
    assert.equal(values!.lane, "scout-cheap")
    assert.equal(values!.tools, "read, grep, find, ls, bash")
    assert.equal(values!.maxOutput, 6000)
    assert.equal(values!.maxSubagentDepth, 0)
  })

  it("returns null for unknown builtin", () => {
    const values = getBuiltinOverrideValues("unknown")
    assert.equal(values, null)
  })

  it("returns a copy (not the internal override)", () => {
    const values = getBuiltinOverrideValues("scout")!
    values.maxOutput = 9999
    // Original should be unchanged
    const original = BUILTIN_SCOUT_OVERRIDE.override
    assert.equal(original.maxOutput, 6000)
  })
})

// ── Context-builder override tests ──────────────────────────────

describe("BUILTIN_CONTEXT_BUILDER_OVERRIDE", () => {
  it("has the correct name", () => {
    assert.equal(BUILTIN_CONTEXT_BUILDER_OVERRIDE.name, "builtin-context-builder")
  })

  it("has the correct lane", () => {
    assert.equal(BUILTIN_CONTEXT_BUILDER_OVERRIDE.override.lane, "scout-cheap")
  })

  it("has the correct tools (no bash)", () => {
    assert.equal(
      BUILTIN_CONTEXT_BUILDER_OVERRIDE.override.tools,
      "read, grep, find, ls",
    )
  })

  it("has maxOutput of 6000", () => {
    assert.equal(BUILTIN_CONTEXT_BUILDER_OVERRIDE.override.maxOutput, 6000)
  })

  it("does not set maxSubagentDepth (relies on default)", () => {
    assert.equal(
      BUILTIN_CONTEXT_BUILDER_OVERRIDE.override.maxSubagentDepth,
      undefined,
    )
  })
})

describe("getBuiltinOverride — context-builder", () => {
  it("returns context-builder override for 'context-builder'", () => {
    const result = getBuiltinOverride("context-builder")
    assert.notEqual(result, null)
    assert.equal(result!.name, "builtin-context-builder")
  })

  it("returns correct tools from context-builder override", () => {
    const result = getBuiltinOverride("context-builder")!
    assert.equal(result.override.tools, "read, grep, find, ls")
  })

  it("returns correct maxOutput from context-builder override", () => {
    const result = getBuiltinOverride("context-builder")!
    assert.equal(result.override.maxOutput, 6000)
  })
})

describe("hasBuiltinOverride — context-builder", () => {
  it("returns true for 'context-builder'", () => {
    assert.equal(hasBuiltinOverride("context-builder"), true)
  })
})

describe("applyBuiltinOverride — context-builder", () => {
  it("fills missing tools from context-builder override", () => {
    const base: LaunchAgentConfig = {
      agent: "context-builder",
      model: "openai/gpt-5.4-mini",
    }
    const override = getBuiltinOverride("context-builder")!
    const result = applyBuiltinOverride(base, override)

    assert.equal(result.agent, "context-builder")
    assert.equal(result.model, "openai/gpt-5.4-mini")
    assert.equal(result.tools, "read, grep, find, ls")
    assert.equal(result.maxOutput, 6000)
  })

  it("preserves base config tools when context-builder override also has tools", () => {
    const base: LaunchAgentConfig = {
      agent: "context-builder",
      model: "openai/gpt-5.4-mini",
      tools: "read, grep, find, ls, web_search",
    }
    const override = getBuiltinOverride("context-builder")!
    const result = applyBuiltinOverride(base, override)

    // Base takes precedence per design
    assert.equal(result.tools, "read, grep, find, ls, web_search")
  })

  it("fills missing maxOutput from context-builder override", () => {
    const base: LaunchAgentConfig = {
      agent: "context-builder",
      model: "openai/gpt-5.4-mini",
      maxOutput: undefined,
    }
    const override = getBuiltinOverride("context-builder")!
    const result = applyBuiltinOverride(base, override)

    assert.equal(result.maxOutput, 6000)
  })

  it("returns a new object (does not mutate base)", () => {
    const base: LaunchAgentConfig = {
      agent: "context-builder",
      model: "openai/gpt-5.4-mini",
    }
    const override = getBuiltinOverride("context-builder")!
    const result = applyBuiltinOverride(base, override)

    assert.notEqual(result, base)
  })
})

describe("getAllBuiltinOverrides — includes context-builder", () => {
  it("returns a record with both scout and context-builder", () => {
    const all = getAllBuiltinOverrides()
    assert.ok("scout" in all)
    assert.ok("context-builder" in all)
    assert.equal(all["context-builder"].name, "builtin-context-builder")
  })
})

describe("getBuiltinOverrideValues — context-builder", () => {
  it("returns override values for context-builder", () => {
    const values = getBuiltinOverrideValues("context-builder")
    assert.notEqual(values, null)
    assert.equal(values!.lane, "scout-cheap")
    assert.equal(values!.tools, "read, grep, find, ls")
    assert.equal(values!.maxOutput, 6000)
  })

  it("returns null for unknown builtin", () => {
    const values = getBuiltinOverrideValues("unknown")
    assert.equal(values, null)
  })
})
