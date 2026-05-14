/**
 * model-resolution.test.ts — Tests for the lane resolution engine.
 *
 * Covers:
 *   - resolveLane with valid candidates (first-wins)
 *   - resolveLane with no valid candidates (required → unresolved, optional → disabled)
 *   - resolveLane thinking compatibility (clamp up ok, downgrade for conservative rejected)
 *   - resolveLane model not found, not authenticated, no tools
 *   - resolveProfileLanes resolves all lanes
 *   - resolveAgentBindings maps lanes to agent bindings
 *   - resolveProfile full integration
 *   - hasUnresolvedRequiredLanes
 *   - getLaneStatusSummary
 *   - isModelThinkingCompatible edge cases
 *   - CONSERVATIVE_LANES set
 */
import { describe, it } from "node:test"
import * as assert from "node:assert/strict"
import {
  resolveLane,
  resolveProfileLanes,
  resolveAgentBindings,
  resolveProfile,
  hasUnresolvedRequiredLanes,
  getLaneStatusSummary,
  isModelThinkingCompatible,
  CONSERVATIVE_LANES,
} from "../extensions/zflow-profiles/model-resolution.js"
import type {
  NormalizedLaneDefinition,
  NormalizedProfileDefinition,
  NormalizedAgentBinding,
  ModelRegistry,
  ModelInfo,
  ResolvedLane,
  ResolvedProfile,
} from "../extensions/zflow-profiles/profiles.js"

// ── Helpers ─────────────────────────────────────────────────────

/** Create a simple model registry from an array of ModelInfo objects. */
function makeRegistry(models: ModelInfo[]): ModelRegistry {
  const map = new Map(models.map((m) => [m.id, m]))
  return {
    getModel(id: string): ModelInfo | undefined {
      return map.get(id)
    },
  }
}

/** Shorthand to create a ModelInfo. */
function model(
  id: string,
  overrides?: Partial<ModelInfo>,
): ModelInfo {
  return {
    id,
    supportsTools: true,
    supportsText: true,
    thinkingCapability: "medium",
    authenticated: true,
    ...overrides,
  }
}

/** Shorthand to create a NormalizedLaneDefinition. */
function lane(
  preferredModels: string[],
  overrides?: Partial<NormalizedLaneDefinition>,
): NormalizedLaneDefinition {
  return {
    required: true,
    optional: false,
    preferredModels,
    ...overrides,
  }
}

// ── Model registry with no models ───────────────────────────────

const EMPTY_REGISTRY: ModelRegistry = { getModel: () => undefined }

// ── Tests ───────────────────────────────────────────────────────

describe("resolveLane", () => {
  it("resolves the first valid candidate", () => {
    const reg = makeRegistry([
      model("model-a"),
      model("model-b"),
    ])
    const result = resolveLane("test-lane", lane(["model-a", "model-b"]), reg)
    assert.equal(result.status, "resolved")
    assert.equal(result.model, "model-a")
    assert.equal(result.lane, "test-lane")
  })

  it("skips invalid candidates and picks the next one", () => {
    const reg = makeRegistry([
      model("model-a", { authenticated: false }),
      model("model-b", { supportsTools: false }),
      model("model-c"),
    ])
    const result = resolveLane("test-lane", lane(["model-a", "model-b", "model-c"]), reg)
    assert.equal(result.status, "resolved")
    assert.equal(result.model, "model-c")
  })

  it("returns unresolved-required when no candidate matches and lane is required", () => {
    const result = resolveLane("test-lane", lane(["model-a"], { required: true }), EMPTY_REGISTRY)
    assert.equal(result.status, "unresolved-required")
    assert.equal(result.model, null)
    assert.equal(result.required, true)
    assert.ok(result.reason)
    assert.ok(result.reason!.includes("unresolved"))
  })

  it("returns disabled-optional when no candidate matches and lane is optional", () => {
    const result = resolveLane(
      "test-lane",
      lane(["model-a"], { required: false, optional: true }),
      EMPTY_REGISTRY,
    )
    assert.equal(result.status, "disabled-optional")
    assert.equal(result.model, null)
    assert.equal(result.optional, true)
    assert.ok(result.reason)
    assert.ok(result.reason!.includes("disabled"))
  })

  it("returns unresolved-required when both required and optional are false (defaults to required)", () => {
    const result = resolveLane(
      "test-lane",
      lane(["model-a"], { required: false, optional: false }),
      EMPTY_REGISTRY,
    )
    assert.equal(result.status, "unresolved-required")
  })

  it("rejects unauthenticated model", () => {
    const reg = makeRegistry([model("model-a", { authenticated: false })])
    const result = resolveLane("test-lane", lane(["model-a"]), reg)
    assert.equal(result.status, "unresolved-required")
    assert.ok(result.reason!.includes("not authenticated"))
  })

  it("rejects model without tool support", () => {
    const reg = makeRegistry([model("model-a", { supportsTools: false })])
    const result = resolveLane("test-lane", lane(["model-a"]), reg)
    assert.equal(result.status, "unresolved-required")
    assert.ok(result.reason!.includes("tool"))
  })

  it("rejects model without text support", () => {
    const reg = makeRegistry([model("model-a", { supportsText: false })])
    const result = resolveLane("test-lane", lane(["model-a"]), reg)
    assert.equal(result.status, "unresolved-required")
    assert.ok(result.reason!.includes("text"))
  })

  it("preserves lane name in result", () => {
    const reg = makeRegistry([model("m1")])
    const result = resolveLane("scout-cheap", lane(["m1"]), reg)
    assert.equal(result.lane, "scout-cheap")
  })

  it("preserves required/optional flags in result", () => {
    const reg = makeRegistry([model("m1")])
    const result = resolveLane(
      "scout-cheap",
      lane(["m1"], { required: true }),
      reg,
    )
    assert.equal(result.required, true)
    assert.equal(result.optional, false)
  })

  it("preserves thinking level from lane when resolved", () => {
    const reg = makeRegistry([model("m1", { thinkingCapability: "high" })])
    const result = resolveLane(
      "scout-cheap",
      lane(["m1"], { thinking: "high" }),
      reg,
    )
    assert.equal(result.thinking, "high")
  })
})

describe("resolveLane — thinking compatibility", () => {
  it("accepts model with higher thinking than requested (clamp up)", () => {
    const reg = makeRegistry([model("m1", { thinkingCapability: "high" })])
    const result = resolveLane("scout-cheap", lane(["m1"], { thinking: "low" }), reg)
    assert.equal(result.status, "resolved")
    assert.equal(result.thinking, "high")
  })

  it("rejects thinking downgrade for conservative lane", () => {
    const reg = makeRegistry([model("m1", { thinkingCapability: "low" })])
    const result = resolveLane(
      "planning-frontier",
      lane(["m1"], { thinking: "high" }),
      reg,
    )
    assert.equal(result.status, "unresolved-required")
    assert.ok(result.reason!.toLowerCase().includes("conservative"))
  })

  it("accepts thinking downgrade for non-conservative lane", () => {
    const reg = makeRegistry([model("m1", { thinkingCapability: "low" })])
    const result = resolveLane(
      "worker-cheap",
      lane(["m1"], { thinking: "medium" }),
      reg,
    )
    assert.equal(result.status, "resolved")
    assert.equal(result.thinking, "low")
    assert.ok(result.reason!.includes("clamp"))
  })

  it("accepts model with exactly matching thinking level", () => {
    const reg = makeRegistry([model("m1", { thinkingCapability: "high" })])
    const result = resolveLane(
      "planning-frontier",
      lane(["m1"], { thinking: "high" }),
      reg,
    )
    assert.equal(result.status, "resolved")
    assert.equal(result.thinking, "high")
  })

  it("no requested thinking always compatible", () => {
    const reg = makeRegistry([model("m1", { thinkingCapability: "low" })])
    const result = resolveLane("scout-cheap", lane(["m1"]), reg)
    assert.equal(result.status, "resolved")
    assert.equal(result.thinking, "low")
  })
})

describe("resolveProfileLanes", () => {
  it("resolves all lanes in a profile", () => {
    const reg = makeRegistry([model("m1"), model("m2")])
    const profile: NormalizedProfileDefinition = {
      lanes: {
        scout: lane(["m1"]),
        worker: lane(["m2"]),
      },
      agentBindings: {},
    }
    const result = resolveProfileLanes(profile, reg)
    assert.ok("scout" in result)
    assert.ok("worker" in result)
    assert.equal(result.scout.model, "m1")
    assert.equal(result.worker.model, "m2")
  })

  it("handles profile with mixed resolution outcomes", () => {
    const reg = makeRegistry([
      model("good-model"),
      model("bad-model", { authenticated: false }),
    ])
    const profile: NormalizedProfileDefinition = {
      lanes: {
        good: lane(["good-model"]),
        bad: lane(["bad-model"], { required: false, optional: true }),
      },
      agentBindings: {},
    }
    const result = resolveProfileLanes(profile, reg)
    assert.equal(result.good.status, "resolved")
    assert.equal(result.bad.status, "disabled-optional")
  })
})

describe("resolveAgentBindings", () => {
  it("maps each agent binding to its resolved lane model", () => {
    const resolvedLanes: Record<string, ResolvedLane> = {
      "scout-cheap": {
        lane: "scout-cheap",
        model: "m1",
        required: true,
        optional: false,
        thinking: "low",
        status: "resolved",
      },
      "worker-strong": {
        lane: "worker-strong",
        model: "m2",
        required: true,
        optional: false,
        thinking: "high",
        status: "resolved",
      },
    }
    const profile: NormalizedProfileDefinition = {
      lanes: {},
      agentBindings: {
        scout: { lane: "scout-cheap", optional: false, tools: "read", maxOutput: 4000 },
        "zflow.implement-hard": { lane: "worker-strong", optional: false, maxOutput: 12000 },
      },
    }
    const result = resolveAgentBindings(profile, resolvedLanes)
    assert.equal(result.scout.resolvedModel, "m1")
    assert.equal(result.scout.tools, "read")
    assert.equal(result["zflow.implement-hard"].resolvedModel, "m2")
    assert.equal(result["zflow.implement-hard"].maxOutput, 12000)
  })

  it("sets resolvedModel to null when lane is unresolved", () => {
    const resolvedLanes: Record<string, ResolvedLane> = {
      "missing-lane": {
        lane: "missing-lane",
        model: null,
        required: false,
        optional: true,
        status: "disabled-optional",
        reason: "no model",
      },
    }
    const profile: NormalizedProfileDefinition = {
      lanes: {},
      agentBindings: {
        agentX: { lane: "missing-lane", optional: true },
      },
    }
    const result = resolveAgentBindings(profile, resolvedLanes)
    assert.equal(result.agentX.resolvedModel, null)
    assert.equal(result.agentX.status, "disabled-optional")
    assert.equal(result.agentX.reason, "no model")
  })

  it("handles unknown lane reference gracefully", () => {
    const result = resolveAgentBindings(
      {
        lanes: {},
        agentBindings: {
          agentX: { lane: "nonexistent" },
        },
      },
      {},
    )
    assert.equal(result.agentX.resolvedModel, null)
    assert.equal(result.agentX.status, "unresolved-required")
    assert.ok(result.agentX.reason!.includes("not found"))
  })
})

describe("resolveProfile", () => {
  it("fully resolves a profile with lanes and agent bindings", () => {
    const reg = makeRegistry([model("m1"), model("m2")])
    const profile: NormalizedProfileDefinition = {
      lanes: {
        scout: lane(["m1"]),
        worker: lane(["m2"]),
      },
      agentBindings: {
        s: { lane: "scout" },
        w: { lane: "worker" },
      },
    }
    const result = resolveProfile("default", profile, "/path/to/profiles.json", reg)
    assert.equal(result.profileName, "default")
    assert.equal(result.sourcePath, "/path/to/profiles.json")
    assert.ok(result.resolvedAt)
    assert.equal(result.resolvedLanes.scout.model, "m1")
    assert.equal(result.resolvedLanes.worker.model, "m2")
    assert.equal(result.agentBindings.s.resolvedModel, "m1")
    assert.equal(result.agentBindings.w.resolvedModel, "m2")
  })

  it("records resolution timestamp", () => {
    const reg = makeRegistry([model("m1")])
    const profile: NormalizedProfileDefinition = {
      lanes: { scout: lane(["m1"]) },
      agentBindings: { s: { lane: "scout" } },
    }
    const before = Date.now()
    const result = resolveProfile("default", profile, "/source.json", reg)
    const after = Date.now()
    const resolvedAt = new Date(result.resolvedAt).getTime()
    assert.ok(resolvedAt >= before && resolvedAt <= after)
  })
})

describe("hasUnresolvedRequiredLanes", () => {
  it("returns false when all lanes are resolved", () => {
    const resolved: ResolvedProfile = {
      profileName: "default",
      sourcePath: "/source.json",
      resolvedAt: new Date().toISOString(),
      resolvedLanes: {
        scout: {
          lane: "scout",
          model: "m1",
          required: true,
          optional: false,
          status: "resolved",
        },
      },
      agentBindings: {},
    }
    assert.equal(hasUnresolvedRequiredLanes(resolved), false)
  })

  it("returns true when a required lane is unresolved", () => {
    const resolved: ResolvedProfile = {
      profileName: "default",
      sourcePath: "/source.json",
      resolvedAt: new Date().toISOString(),
      resolvedLanes: {
        scout: {
          lane: "scout",
          model: null,
          required: true,
          optional: false,
          status: "unresolved-required",
          reason: "no model",
        },
      },
      agentBindings: {},
    }
    assert.equal(hasUnresolvedRequiredLanes(resolved), true)
  })

  it("returns false when only optional lanes are unresolved", () => {
    const resolved: ResolvedProfile = {
      profileName: "default",
      sourcePath: "/source.json",
      resolvedAt: new Date().toISOString(),
      resolvedLanes: {
        required: {
          lane: "required",
          model: "m1",
          required: true,
          optional: false,
          status: "resolved",
        },
        optional: {
          lane: "optional",
          model: null,
          required: false,
          optional: true,
          status: "disabled-optional",
          reason: "no model",
        },
      },
      agentBindings: {},
    }
    assert.equal(hasUnresolvedRequiredLanes(resolved), false)
  })
})

describe("getLaneStatusSummary", () => {
  it("produces summary lines for resolved lanes", () => {
    const resolved: ResolvedProfile = {
      profileName: "default",
      sourcePath: "/source.json",
      resolvedAt: new Date().toISOString(),
      resolvedLanes: {
        scout: {
          lane: "scout",
          model: "openai/gpt-4o-mini",
          required: true,
          optional: false,
          thinking: "low",
          status: "resolved",
        },
      },
      agentBindings: {},
    }
    const lines = getLaneStatusSummary(resolved)
    assert.equal(lines.length, 1)
    assert.ok(lines[0].includes("scout"))
    assert.ok(lines[0].includes("openai/gpt-4o-mini"))
    assert.ok(lines[0].includes("low"))
  })

  it("includes all three status types correctly", () => {
    const resolved: ResolvedProfile = {
      profileName: "default",
      sourcePath: "/source.json",
      resolvedAt: new Date().toISOString(),
      resolvedLanes: {
        ok: {
          lane: "ok",
          model: "m1",
          required: true,
          optional: false,
          status: "resolved",
        },
        warn: {
          lane: "warn",
          model: null,
          required: false,
          optional: true,
          status: "disabled-optional",
          reason: "not available",
        },
        fail: {
          lane: "fail",
          model: null,
          required: true,
          optional: false,
          status: "unresolved-required",
          reason: "no auth",
        },
      },
      agentBindings: {},
    }
    const lines = getLaneStatusSummary(resolved)
    assert.equal(lines.length, 3)
    assert.ok(lines[0].startsWith("- ok"))
    assert.ok(lines[1].includes("⚠"))
    assert.ok(lines[2].includes("✗"))
  })
})

describe("isModelThinkingCompatible", () => {
  it("compatible when no level requested", () => {
    const result = isModelThinkingCompatible(model("m1"), undefined)
    assert.equal(result.compatible, true)
  })

  it("compatible when model capability meets requested level", () => {
    const result = isModelThinkingCompatible(
      model("m1", { thinkingCapability: "medium" }),
      "medium",
    )
    assert.equal(result.compatible, true)
    assert.equal(result.effectiveLevel, "medium")
  })

  it("compatible when model exceeds requested level (clamp up)", () => {
    const result = isModelThinkingCompatible(
      model("m1", { thinkingCapability: "high" }),
      "low",
    )
    assert.equal(result.compatible, true)
    assert.equal(result.effectiveLevel, "high")
  })

  it("incompatible when model below requested and conservative", () => {
    const result = isModelThinkingCompatible(
      model("m1", { thinkingCapability: "low" }),
      "high",
      true, // conservative
    )
    assert.equal(result.compatible, false)
    assert.ok(result.reason.toLowerCase().includes("conservative"))
  })

  it("compatible when model below requested and non-conservative (acceptable clamp)", () => {
    const result = isModelThinkingCompatible(
      model("m1", { thinkingCapability: "low" }),
      "medium",
      false, // non-conservative
    )
    assert.equal(result.compatible, true)
    assert.equal(result.effectiveLevel, "low")
    assert.ok(result.reason.includes("clamp"))
  })
})

describe("CONSERVATIVE_LANES", () => {
  it("contains planning-frontier", () => {
    assert.ok(CONSERVATIVE_LANES.has("planning-frontier"))
  })
  it("contains worker-strong", () => {
    assert.ok(CONSERVATIVE_LANES.has("worker-strong"))
  })
  it("contains review-security", () => {
    assert.ok(CONSERVATIVE_LANES.has("review-security"))
  })
  it("contains synthesis-frontier", () => {
    assert.ok(CONSERVATIVE_LANES.has("synthesis-frontier"))
  })
  it("does not contain worker-cheap", () => {
    assert.ok(!CONSERVATIVE_LANES.has("worker-cheap"))
  })
  it("does not contain scout-cheap", () => {
    assert.ok(!CONSERVATIVE_LANES.has("scout-cheap"))
  })
  it("does not contain review-logic", () => {
    assert.ok(!CONSERVATIVE_LANES.has("review-logic"))
  })
  it("does not contain review-correctness", () => {
    assert.ok(!CONSERVATIVE_LANES.has("review-correctness"))
  })
  it("does not contain review-integration", () => {
    assert.ok(!CONSERVATIVE_LANES.has("review-integration"))
  })
})

// ── Integration test: full resolution with example config ───────

import { readFileSync } from "node:fs"
import { resolve as resolvePath, dirname } from "node:path"
import { fileURLToPath } from "node:url"
const __dirname = dirname(fileURLToPath(import.meta.url))

import { normalizeProfilesFile } from "../extensions/zflow-profiles/profiles.js"

describe("integration — resolve with example config", () => {
  function loadExampleProfile(): NormalizedProfileDefinition {
    const raw = JSON.parse(
      readFileSync(
        resolvePath(__dirname, "..", "config", "profiles.example.json"),
        "utf8",
      ),
    )
    const profiles = normalizeProfilesFile(raw)
    return profiles.default
  }

  it("resolves all lanes with a fully available model registry", () => {
    // Create a registry where every model in the example config is available
    // Uses the actual provider names from profiles.example.json (openai-codex/*, opencode-go/*)
    const allModels: ModelInfo[] = [
      // scout-cheap models
      model("opencode-go/deepseek-v4-flash", { thinkingCapability: "low" }),
      model("opencode-go/qwen3.6-plus", { thinkingCapability: "medium" }),
      // planning-frontier models
      model("openai-codex/gpt-5.4", { thinkingCapability: "high" }),
      model("opencode-go/mimo-v2.5-pro", { thinkingCapability: "high" }),
      // worker-cheap models
      model("openai-codex/gpt-5.4-mini", { thinkingCapability: "medium" }),
      // worker-strong
      model("opencode-go/mimo-v2.5-pro", { thinkingCapability: "high" }),
      // review models (Codex models support high thinking/reasoning)
      model("openai-codex/gpt-5.3-codex", { thinkingCapability: "high" }),
      // synthesis-frontier
      model("opencode-go/mimo-v2.5-pro", { thinkingCapability: "high" }),
    ]
    const reg = makeRegistry(allModels)
    const profile = loadExampleProfile()
    const resolved = resolveProfile("default", profile, "/example.json", reg)

    // All required lanes should resolve
    const requiredUnresolved = Object.values(resolved.resolvedLanes).filter(
      (l) => l.status === "unresolved-required",
    )
    assert.equal(
      requiredUnresolved.length,
      0,
      `Expected 0 unresolved required lanes, got: ${JSON.stringify(requiredUnresolved)}`,
    )

    // Optional lanes (review-logic, review-system) should resolve if models available
    assert.equal(resolved.resolvedLanes["review-logic"].status, "resolved")
    assert.equal(resolved.resolvedLanes["review-system"].status, "resolved")
  })

  it("disables optional lanes when models are missing", () => {
    // Custom profile where:
    // - required lanes have available models
    // - review-logic (optional) has one available model (claude-4-sonnet)
    // - review-system (optional) only has models NOT in the registry
    const manualProfile: NormalizedProfileDefinition = {
      lanes: {
        "planning-frontier": { required: true, optional: false, thinking: "high", preferredModels: ["openai/gpt-5.4"] },
        "worker-strong": { required: true, optional: false, thinking: "high", preferredModels: ["openai/gpt-5.4-codex"] },
        "review-logic": { required: false, optional: true, thinking: "medium", preferredModels: ["anthropic/claude-4-sonnet"] },
        "review-system": { required: false, optional: true, thinking: "high", preferredModels: ["anthropic/claude-4-opus"] },
      },
      agentBindings: {},
    }

    const reg = makeRegistry([
      model("openai/gpt-5.4", { thinkingCapability: "high" }),
      model("openai/gpt-5.4-codex", { thinkingCapability: "high" }),
      model("anthropic/claude-4-sonnet", { thinkingCapability: "medium" }),
      // NOTE: claude-4-opus is intentionally NOT included
    ])

    const resolved = resolveProfile("default", manualProfile, "/test.json", reg)

    // Required lanes should resolve
    assert.equal(resolved.resolvedLanes["planning-frontier"].status, "resolved")
    assert.equal(resolved.resolvedLanes["worker-strong"].status, "resolved")

    // review-logic has claude-4-sonnet in registry → resolved
    assert.equal(resolved.resolvedLanes["review-logic"].status, "resolved")
    // review-system only has claude-4-opus which is NOT in registry → disabled-optional
    assert.equal(resolved.resolvedLanes["review-system"].status, "disabled-optional")
  })
})
