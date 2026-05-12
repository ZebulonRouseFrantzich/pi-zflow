/**
 * health.test.ts — Tests for lane-health preflight and runtime failure handling.
 *
 * Covers:
 *   - preflightLaneHealth (all lanes healthy, unhealthy lanes, no registry)
 *   - preflightLaneHealth with subset of lanes (requiredLanes)
 *   - checkLaneModelHealth internals (via preflight)
 *   - reresolveLane (finds next valid candidate, skip models, no more candidates)
 *   - reresolveLane with worker-strong degradation protection
 *   - handleLaneFailure (agent fallback, re-resolution, optional skip, required throw)
 *   - handleLaneFailure with onReresolve callback
 *   - checkLaneHealth convenience wrapper
 *   - getHealthStatusSummary
 */
import { describe, it } from "node:test"
import * as assert from "node:assert/strict"
import {
  preflightLaneHealth,
  reresolveLane,
  handleLaneFailure,
  checkLaneHealth,
  getHealthStatusSummary,
} from "../extensions/zflow-profiles/health.js"
import type {
  ResolvedProfile,
  ResolvedLane,
  ModelRegistry,
  ModelInfo,
  NormalizedProfileDefinition,
  NormalizedLaneDefinition,
  NormalizedAgentBinding,
} from "../extensions/zflow-profiles/profiles.js"
import type {
  LaneHealthReport,
  FailureRecoveryAction,
  FailureRecoveryResult,
} from "../extensions/zflow-profiles/health.js"

// ── Helpers ─────────────────────────────────────────────────────

function model(id: string, overrides?: Partial<ModelInfo>): ModelInfo {
  return {
    id,
    supportsTools: true,
    supportsText: true,
    thinkingCapability: "medium",
    authenticated: true,
    ...overrides,
  }
}

function makeRegistry(models: ModelInfo[]): ModelRegistry {
  const map = new Map(models.map((m) => [m.id, m]))
  return {
    getModel(id: string): ModelInfo | undefined {
      return map.get(id)
    },
  }
}

function makeResolvedProfile(
  lanes: Record<string, Partial<ResolvedLane>>,
): ResolvedProfile {
  const resolvedLanes: Record<string, ResolvedLane> = {}
  for (const [name, overrides] of Object.entries(lanes)) {
    resolvedLanes[name] = {
      lane: name,
      model: null,
      required: true,
      optional: false,
      status: "resolved",
      ...overrides,
    }
  }

  return {
    profileName: "default",
    sourcePath: "/test/profiles.json",
    resolvedAt: new Date().toISOString(),
    resolvedLanes,
    agentBindings: {},
  }
}

function makeProfileDef(
  lanes: Record<string, NormalizedLaneDefinition>,
): NormalizedProfileDefinition {
  return {
    lanes,
    agentBindings: {},
  }
}

function laneDef(
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

// ── Tests ───────────────────────────────────────────────────────

describe("preflightLaneHealth", () => {
  it("returns all healthy when all resolved lanes exist and are authenticated", () => {
    const resolved = makeResolvedProfile({
      "scout-cheap": { model: "m1" },
      "worker-strong": { model: "m2" },
    })

    const registry = makeRegistry([
      model("m1"),
      model("m2", { thinkingCapability: "high" }),
    ])

    const report = preflightLaneHealth(resolved, registry)
    assert.equal(report.allHealthy, true)
    assert.equal(report.unhealthyLanes.length, 0)
    assert.equal(report.degradedLanes.length, 0)
    assert.equal(report.results.length, 2)
    assert.equal(report.results[0].status, "healthy")
    assert.equal(report.results[1].status, "healthy")
  })

  it("reports unhealthy when a resolved model is not in the registry", () => {
    const resolved = makeResolvedProfile({
      "scout-cheap": { model: "missing-model" },
      "worker-strong": { model: "m2" },
    })

    const registry = makeRegistry([model("m2")])

    const report = preflightLaneHealth(resolved, registry)
    assert.equal(report.allHealthy, false)
    assert.deepEqual(report.unhealthyLanes, ["scout-cheap"])
    assert.equal(report.results.length, 2)

    const unhealthy = report.results.find((r) => r.lane === "scout-cheap")
    assert.equal(unhealthy?.status, "unhealthy")
    assert.ok(unhealthy?.message?.includes("no longer available"))
  })

  it("reports unhealthy when a resolved model is no longer authenticated", () => {
    const resolved = makeResolvedProfile({
      "scout-cheap": { model: "m1" },
    })

    const registry = makeRegistry([model("m1", { authenticated: false })])

    const report = preflightLaneHealth(resolved, registry)
    assert.equal(report.allHealthy, false)
    assert.deepEqual(report.unhealthyLanes, ["scout-cheap"])
    assert.ok(
      report.results[0].message?.includes("no longer authenticated"),
    )
  })

  it("reports unhealthy when lane has no resolved model", () => {
    const resolved = makeResolvedProfile({
      "scout-cheap": { model: null, status: "unresolved-required" },
    })

    const registry = makeRegistry([model("m1")])

    const report = preflightLaneHealth(resolved, registry)
    assert.equal(report.allHealthy, false)
    assert.deepEqual(report.unhealthyLanes, ["scout-cheap"])
  })

  it("assumes healthy when no registry is provided", () => {
    const resolved = makeResolvedProfile({
      "scout-cheap": { model: "m1" },
    })

    const report = preflightLaneHealth(resolved)
    assert.equal(report.allHealthy, true)
    assert.equal(report.unhealthyLanes.length, 0)
  })

  it("checks only the specified subset of lanes (requiredLanes)", () => {
    const resolved = makeResolvedProfile({
      "scout-cheap": { model: "m1" },
      "worker-strong": { model: "missing-model" },
      "review-logic": { model: "m3" },
    })

    const registry = makeRegistry([model("m1"), model("m3")])

    // Only check scout-cheap and review-logic
    const report = preflightLaneHealth(resolved, registry, [
      "scout-cheap",
      "review-logic",
    ])
    assert.equal(report.allHealthy, true)
    assert.equal(report.unhealthyLanes.length, 0)

    // worker-strong is not checked, so its missing model isn't reported
    assert.equal(report.results.length, 2)
  })

  it("reports lanes not found in resolved profile as unhealthy", () => {
    const resolved = makeResolvedProfile({
      "scout-cheap": { model: "m1" },
    })

    const registry = makeRegistry([model("m1")])

    // Check a lane that doesn't exist in the resolved profile
    const report = preflightLaneHealth(resolved, registry, [
      "scout-cheap",
      "nonexistent-lane",
    ])
    assert.equal(report.allHealthy, false)
    assert.deepEqual(report.unhealthyLanes, ["nonexistent-lane"])
  })
})

describe("checkLaneHealth (convenience wrapper)", () => {
  it("returns true when all lanes are healthy", () => {
    const resolved = makeResolvedProfile({
      scout: { model: "m1" },
    })

    const registry = makeRegistry([model("m1")])
    assert.equal(checkLaneHealth(resolved, registry), true)
  })

  it("returns false when a lane is unhealthy", () => {
    const resolved = makeResolvedProfile({
      scout: { model: "missing-model" },
    })

    const registry = makeRegistry([])
    assert.equal(checkLaneHealth(resolved, registry), false)
  })
})

describe("reresolveLane", () => {
  it("finds the next valid candidate after skipping the current model", () => {
    const profileDef = makeProfileDef({
      "test-lane": laneDef(["failed-model", "good-model", "fallback-model"]),
    })

    const registry = makeRegistry([
      model("good-model"),
      model("fallback-model"),
    ])

    const result = reresolveLane("test-lane", profileDef, registry, [
      "failed-model",
    ])

    assert.notEqual(result, null)
    assert.equal(result!.model, "good-model")
    assert.equal(result!.status, "resolved")
  })

  it("returns null when no candidates remain after skipping", () => {
    const profileDef = makeProfileDef({
      "test-lane": laneDef(["only-model"]),
    })

    const registry = makeRegistry([model("only-model")])

    const result = reresolveLane("test-lane", profileDef, registry, [
      "only-model",
    ])

    assert.equal(result, null)
  })

  it("returns null when lane is not in profile definition", () => {
    const profileDef = makeProfileDef({})

    const result = reresolveLane("nonexistent", profileDef, makeRegistry([]), [])
    assert.equal(result, null)
  })

  it("skips unauthenticated candidates", () => {
    const profileDef = makeProfileDef({
      "test-lane": laneDef(["unauthenticated-model", "good-model"]),
    })

    const registry = makeRegistry([
      model("unauthenticated-model", { authenticated: false }),
      model("good-model"),
    ])

    const result = reresolveLane("test-lane", profileDef, registry, [])

    assert.notEqual(result, null)
    assert.equal(result!.model, "good-model")
  })

  it("skips candidates that lack tool support", () => {
    const profileDef = makeProfileDef({
      "test-lane": laneDef(["no-tools-model", "good-model"]),
    })

    const registry = makeRegistry([
      model("no-tools-model", { supportsTools: false }),
      model("good-model"),
    ])

    const result = reresolveLane("test-lane", profileDef, registry, [])
    assert.notEqual(result, null)
    assert.equal(result!.model, "good-model")
  })

  it("rejects thinking downgrade for conservative lanes", () => {
    const profileDef = makeProfileDef({
      "worker-strong": laneDef(
        ["low-thinking-model", "good-model"],
        { required: true, thinking: "high" },
      ),
    })

    const registry = makeRegistry([
      model("low-thinking-model", { thinkingCapability: "low" }),
      model("good-model", { thinkingCapability: "high" }),
    ])

    const result = reresolveLane("worker-strong", profileDef, registry, [])
    assert.notEqual(result, null)
    assert.equal(result!.model, "good-model")
  })

  it("never resolves worker-strong to a cheap-class model", () => {
    const profileDef = makeProfileDef({
      "worker-strong": laneDef(["cheap-model", "good-model"]),
    })

    const registry = makeRegistry([
      model("cheap-model", { thinkingCapability: "medium" }),
      model("good-model", { thinkingCapability: "high" }),
    ])

    const result = reresolveLane("worker-strong", profileDef, registry, [])

    // Should skip cheap-model (contains "cheap") and pick good-model
    assert.notEqual(result, null)
    assert.equal(result!.model, "good-model")
  })

  it("returns null when the only remaining candidate is a cheap model for worker-strong", () => {
    const profileDef = makeProfileDef({
      "worker-strong": laneDef(["only-cheap-model"]),
    })

    const registry = makeRegistry([
      model("only-cheap-model", { thinkingCapability: "medium" }),
    ])

    const result = reresolveLane("worker-strong", profileDef, registry, [])
    assert.equal(result, null)
  })

  it("preserves required/optional flags in the result", () => {
    const profileDef = makeProfileDef({
      "test-lane": laneDef(["failed-model", "good-model"], {
        required: false,
        optional: true,
      }),
    })

    const registry = makeRegistry([model("good-model")])

    const result = reresolveLane("test-lane", profileDef, registry, [
      "failed-model",
    ])

    assert.notEqual(result, null)
    assert.equal(result!.required, false)
    assert.equal(result!.optional, true)
  })
})

describe("handleLaneFailure", () => {
  const resolved = makeResolvedProfile({
    "scout-cheap": { model: "failed-model" },
    "worker-strong": { model: "m2" },
  })

  const profileDef = makeProfileDef({
    "scout-cheap": laneDef(["failed-model", "backup-model"]),
    "worker-strong": laneDef(["m2", "m3"]),
  })

  const registry = makeRegistry([
    model("backup-model"),
    model("m2", { thinkingCapability: "high" }),
    model("m3", { thinkingCapability: "high" }),
  ])

  it("returns recovered-via-agent-fallback when agent fallback succeeded", async () => {
    const result = await handleLaneFailure(
      "scout",
      "scout-cheap",
      new Error("Model timeout"),
      resolved,
      registry,
      profileDef,
      { agentFallbackOk: true },
    )

    assert.equal(result.action, "recovered-via-agent-fallback")
    assert.ok(result.message.includes("fallbackModels"))
  })

  it("recovers via re-resolution when next candidate is valid", async () => {
    const result = await handleLaneFailure(
      "scout",
      "scout-cheap",
      new Error("Model unavailable"),
      resolved,
      registry,
      profileDef,
    )

    assert.equal(result.action, "recovered-via-reresolution")
    assert.notEqual(result.reresolvedLane, undefined)
    assert.equal(result.reresolvedLane!.model, "backup-model")
    assert.equal(result.reresolvedLane!.status, "resolved")
    assert.ok(result.message.includes("backup-model"))
  })

  it("invokes onReresolve callback when re-resolution succeeds", async () => {
    let calledWithLane: string | undefined
    let calledWithModel: string | undefined

    const result = await handleLaneFailure(
      "scout",
      "scout-cheap",
      new Error("Model unavailable"),
      resolved,
      registry,
      profileDef,
      {
        onReresolve: (lane: string, model: string) => {
          calledWithLane = lane
          calledWithModel = model
        },
      },
    )

    assert.equal(result.action, "recovered-via-reresolution")
    assert.equal(calledWithLane, "scout-cheap")
    assert.equal(calledWithModel, "backup-model")
  })

  it("returns skip-optional-reviewer when an optional lane cannot recover", async () => {
    const optionalResolved = makeResolvedProfile({
      "review-logic": {
        model: "failed-model",
        optional: true,
        required: false,
      },
    })

    const optionalProfileDef = makeProfileDef({
      "review-logic": laneDef(["failed-model"], {
        required: false,
        optional: true,
      }),
    })

    // No backup model available
    const minimalRegistry = makeRegistry([])

    const result = await handleLaneFailure(
      "zflow.review-logic",
      "review-logic",
      new Error("Model failed"),
      optionalResolved,
      minimalRegistry,
      optionalProfileDef,
    )

    assert.equal(result.action, "skip-optional-reviewer")
    assert.ok(result.message.includes("Skipping"))
  })

  it("throws unrecoverable-required when a required lane cannot recover", async () => {
    const requiredResolved = makeResolvedProfile({
      "scout-cheap": {
        model: "failed-model",
        required: true,
        optional: false,
      },
    })

    const requiredProfileDef = makeProfileDef({
      "scout-cheap": laneDef(["failed-model"], {
        required: true,
        optional: false,
      }),
    })

    // No backup model available
    const minimalRegistry = makeRegistry([])

    await assert.rejects(
      () =>
        handleLaneFailure(
          "scout",
          "scout-cheap",
          new Error("Fatal model error"),
          requiredResolved,
          minimalRegistry,
          requiredProfileDef,
        ),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.ok(err.message.includes("scout-cheap"))
        assert.ok(err.message.includes("Required lane"))
        assert.ok(err.message.includes("Fatal model error"))
        return true
      },
    )
  })
})

describe("getHealthStatusSummary", () => {
  it("returns a single 'All lanes healthy' line for a healthy report", () => {
    const report: LaneHealthReport = {
      results: [],
      allHealthy: true,
      degradedLanes: [],
      unhealthyLanes: [],
    }

    const lines = getHealthStatusSummary(report)
    assert.deepEqual(lines, ["All lanes healthy"])
  })

  it("includes degraded lanes in summary", () => {
    const report: LaneHealthReport = {
      results: [],
      allHealthy: false,
      degradedLanes: ["worker-strong"],
      unhealthyLanes: [],
    }

    const lines = getHealthStatusSummary(report)
    assert.ok(lines.some((l) => l.includes("Degraded")))
    assert.ok(lines.some((l) => l.includes("worker-strong")))
  })

  it("includes unhealthy lanes in summary", () => {
    const report: LaneHealthReport = {
      results: [],
      allHealthy: false,
      degradedLanes: [],
      unhealthyLanes: ["scout-cheap", "planning-frontier"],
    }

    const lines = getHealthStatusSummary(report)
    assert.ok(lines.some((l) => l.includes("Unhealthy")))
    assert.ok(lines.some((l) => l.includes("scout-cheap")))
    assert.ok(lines.some((l) => l.includes("planning-frontier")))
  })
})
