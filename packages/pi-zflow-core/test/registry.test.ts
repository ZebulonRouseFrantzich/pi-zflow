/**
 * Registry tests — capability claim, provide, get, optional, onChange, diagnostics.
 */
import * as assert from "node:assert"
import { test, describe, beforeEach } from "node:test"
import {
  getZflowRegistry,
  resetZflowRegistry,
  ZflowRegistry,
  MissingCapabilityError,
  IncompatibleCapabilityError,
  areVersionsCompatible,
} from "../src/registry.js"

describe("ZflowRegistry", () => {
  let registry: ZflowRegistry

  beforeEach(() => {
    resetZflowRegistry()
    registry = getZflowRegistry()
  })

  // ── Singleton ──────────────────────────────────────────────────

  test("getZflowRegistry wrappers share the same internal state", () => {
    const r1 = getZflowRegistry()
    const r2 = getZflowRegistry()
    // Each call to getZflowRegistry creates a new ZflowRegistry wrapper,
    // but they share the same globalThis-backed state. Mutations through
    // one wrapper are visible through the other.
    r1.claim({
      capability: "shared",
      version: "1.0.0",
      provider: "test-pkg",
      sourcePath: "test.ts",
    })
    assert.ok(r2.has("shared"))
    r2.claim({
      capability: "also-shared",
      version: "1.0.0",
      provider: "test-pkg",
      sourcePath: "test.ts",
    })
    assert.ok(r1.has("also-shared"))
  })

  test("resetZflowRegistry creates a fresh state", () => {
    registry.claim({
      capability: "test",
      version: "1.0.0",
      provider: "test-pkg",
      sourcePath: "test.ts",
    })
    assert.ok(registry.has("test"))
    resetZflowRegistry()
    const fresh = getZflowRegistry()
    assert.ok(!fresh.has("test"))
  })

  test("getZflowRegistry survives reset via Symbol.for", () => {
    const r1 = getZflowRegistry()
    ;(globalThis as any)[Symbol.for("pi-zflow-core:registry")] = undefined
    const r2 = getZflowRegistry()
    assert.notStrictEqual(r1, r2) // different internal state after delete
  })

  // ── Claim ──────────────────────────────────────────────────────

  test("claim adds a capability", () => {
    const result = registry.claim({
      capability: "profiles",
      version: "0.1.0",
      provider: "pi-zflow-profiles",
      sourcePath: "profiles.ts",
    })
    assert.ok(result !== null)
    assert.equal(result.claim.capability, "profiles")
    assert.equal(result.claim.provider, "pi-zflow-profiles")
    assert.equal(result.claim.version, "0.1.0")
    assert.ok(registry.has("profiles"))
  })

  test("claim with same provider+version is a no-op", () => {
    const first = registry.claim({
      capability: "profiles",
      version: "0.1.0",
      provider: "pi-zflow-profiles",
      sourcePath: "first.ts",
    })
    const second = registry.claim({
      capability: "profiles",
      version: "0.1.0",
      provider: "pi-zflow-profiles",
      sourcePath: "second.ts",
    })
    assert.strictEqual(second, first)
    // Only one duplicate-source entry added
    assert.equal(second!.duplicateSources.length, 0)
  })

  test("claim with compatible version from different provider records duplicate", () => {
    const first = registry.claim({
      capability: "profiles",
      version: "0.1.0",
      provider: "pi-zflow-profiles",
      sourcePath: "first.ts",
    })
    const second = registry.claim({
      capability: "profiles",
      version: "0.1.0",
      provider: "pi-zflow-profiles-alt",
      sourcePath: "second.ts",
    })
    assert.strictEqual(second, first)
    assert.equal(first!.duplicateSources.length, 1)
    assert.ok(first!.duplicateSources[0].includes("pi-zflow-profiles-alt"))
  })

  test("claim with incompatible version returns null", () => {
    registry.claim({
      capability: "profiles",
      version: "0.1.0",
      provider: "pi-zflow-profiles",
      sourcePath: "first.ts",
    })
    const second = registry.claim({
      capability: "profiles",
      version: "0.2.0",
      provider: "pi-zflow-profiles-v2",
      sourcePath: "second.ts",
    })
    assert.strictEqual(second, null)
  })

  test("claim emits 'claimed' event", () => {
    const events: any[] = []
    registry.onChange("profiles", (e) => events.push(e))
    registry.claim({
      capability: "profiles",
      version: "0.1.0",
      provider: "pi-zflow-profiles",
      sourcePath: "test.ts",
    })
    assert.equal(events.length, 1)
    assert.equal(events[0].type, "claimed")
    assert.equal(events[0].capability, "profiles")
  })

  // ── Provide ────────────────────────────────────────────────────

  test("provide sets service for claimed capability", () => {
    registry.claim({
      capability: "profiles",
      version: "0.1.0",
      provider: "pi-zflow-profiles",
      sourcePath: "test.ts",
    })
    const service = { resolve: () => "ok" }
    registry.provide("profiles", service)
    const got = registry.get<typeof service>("profiles")
    assert.strictEqual(got, service)
  })

  test("provide emits 'provided' event", () => {
    const events: any[] = []
    registry.claim({
      capability: "profiles",
      version: "0.1.0",
      provider: "pi-zflow-profiles",
      sourcePath: "test.ts",
    })
    registry.onChange("profiles", (e) => events.push(e))
    registry.provide("profiles", {})
    assert.equal(events.length, 1)
    assert.equal(events[0].type, "provided")
  })

  test("provide on unclaimed capability throws", () => {
    assert.throws(
      () => registry.provide("nonexistent", {}),
      /unclaimed capability/,
    )
  })

  // ── Get (required) ─────────────────────────────────────────────

  test("get returns provided service", () => {
    registry.claim({
      capability: "profiles",
      version: "0.1.0",
      provider: "pi-zflow-profiles",
      sourcePath: "test.ts",
    })
    registry.provide("profiles", { name: "test-profile" })
    const svc = registry.get<{ name: string }>("profiles")
    assert.equal(svc.name, "test-profile")
  })

  test("get throws MissingCapabilityError for unclaimed capability", () => {
    assert.throws(() => registry.get("nonexistent"), MissingCapabilityError)
  })

  test("get throws MissingCapabilityError for claimed but not provided", () => {
    registry.claim({
      capability: "profiles",
      version: "0.1.0",
      provider: "pi-zflow-profiles",
      sourcePath: "test.ts",
    })
    assert.throws(() => registry.get("profiles"), MissingCapabilityError)
  })

  // ── Optional ───────────────────────────────────────────────────

  test("optional returns undefined for unclaimed capability", () => {
    assert.strictEqual(registry.optional("nonexistent"), undefined)
  })

  test("optional returns undefined for claimed but not provided", () => {
    registry.claim({
      capability: "review",
      version: "0.1.0",
      provider: "pi-zflow-review",
      sourcePath: "test.ts",
    })
    assert.strictEqual(registry.optional("review"), undefined)
  })

  test("optional returns service when provided", () => {
    registry.claim({
      capability: "review",
      version: "0.1.0",
      provider: "pi-zflow-review",
      sourcePath: "test.ts",
    })
    const svc = { review: () => "ok" }
    registry.provide("review", svc)
    assert.strictEqual(registry.optional("review"), svc)
  })

  // ── onChange ───────────────────────────────────────────────────

  test("onChange calls listener for matching events", () => {
    const events: any[] = []
    const unsub = registry.onChange("profiles", (e) => events.push(e))
    registry.claim({
      capability: "profiles",
      version: "0.1.0",
      provider: "pi-zflow-profiles",
      sourcePath: "test.ts",
    })
    assert.equal(events.length, 1)
    unsub()
  })

  test("onChange unsubscribe works", () => {
    const events: any[] = []
    const unsub = registry.onChange("profiles", (e) => events.push(e))
    unsub()
    registry.claim({
      capability: "profiles",
      version: "0.1.0",
      provider: "pi-zflow-profiles",
      sourcePath: "test.ts",
    })
    assert.equal(events.length, 0)
  })

  test("listener errors are caught as diagnostics", () => {
    registry.onChange("profiles", () => {
      throw new Error("boom")
    })
    registry.claim({
      capability: "profiles",
      version: "0.1.0",
      provider: "pi-zflow-profiles",
      sourcePath: "test.ts",
    })
    const diags = registry.getDiagnostics()
    const errorDiags = diags.filter((d) => d.level === "error")
    assert.ok(errorDiags.length >= 1)
    assert.ok(errorDiags.some((d) => d.message.includes("boom")))
  })

  // ── Diagnostics ────────────────────────────────────────────────

  test("addDiagnostic stores entries", () => {
    registry.addDiagnostic({
      level: "warn",
      message: "test warning",
      capability: "test",
    })
    const diags = registry.getDiagnostics()
    assert.equal(diags.length, 1)
    assert.equal(diags[0].level, "warn")
    assert.equal(diags[0].message, "test warning")
    assert.equal(diags[0].capability, "test")
    assert.ok(typeof diags[0].timestamp === "number")
  })

  test("getDiagnostics returns a snapshot copy", () => {
    registry.addDiagnostic({ level: "info", message: "one" })
    const snapshot = registry.getDiagnostics()
    registry.addDiagnostic({ level: "info", message: "two" })
    assert.equal(snapshot.length, 1)
    assert.equal(registry.getDiagnostics().length, 2)
  })

  test("incompatible claim generates error diagnostic", () => {
    registry.claim({
      capability: "profiles",
      version: "0.1.0",
      provider: "pi-zflow-profiles",
      sourcePath: "first.ts",
    })
    registry.claim({
      capability: "profiles",
      version: "0.2.0",
      provider: "pi-zflow-profiles-v2",
      sourcePath: "second.ts",
    })
    const errorDiags = registry
      .getDiagnostics()
      .filter((d) => d.level === "error")
    assert.ok(errorDiags.length >= 1)
    assert.ok(errorDiags[0].message.includes("conflicts"))
  })

  // ── Snapshots ──────────────────────────────────────────────────

  test("getCapabilities returns a snapshot map", () => {
    registry.claim({
      capability: "profiles",
      version: "0.1.0",
      provider: "pi-zflow-profiles",
      sourcePath: "test.ts",
    })
    const capMap = registry.getCapabilities()
    assert.ok(capMap.has("profiles"))
    assert.equal(capMap.size, 1)
    // Mutating snapshot doesn't affect registry
    capMap.delete("profiles")
    assert.ok(registry.has("profiles"))
  })

  test("getClaim returns the claim or undefined", () => {
    assert.strictEqual(registry.getClaim("nope"), undefined)
    registry.claim({
      capability: "profiles",
      version: "0.1.0",
      provider: "pi-zflow-profiles",
      sourcePath: "test.ts",
    })
    const claim = registry.getClaim("profiles")
    assert.ok(claim)
    assert.equal(claim!.provider, "pi-zflow-profiles")
  })
})

// ── Version compatibility (standalone) ───────────────────────────

describe("areVersionsCompatible", () => {
  test("exact mode: equal strings match", () => {
    assert.ok(areVersionsCompatible("0.1.0", "0.1.0", "exact"))
  })

  test("exact mode: different strings do not match", () => {
    assert.ok(!areVersionsCompatible("0.1.0", "0.2.0", "exact"))
    assert.ok(!areVersionsCompatible("0.1.0", "0.1.1", "exact"))
  })

  test("compatible mode: currently same as exact (Phase 1 placeholder)", () => {
    // In Phase 1, "compatible" mode is a placeholder that falls back
    // to exact matching. This test documents the placeholder behaviour
    // and should be updated when semver matching is implemented.
    assert.ok(areVersionsCompatible("0.1.0", "0.1.0", "compatible"))
    assert.ok(!areVersionsCompatible("0.1.0", "0.2.0", "compatible"))
    // TODO(phase-2): 0.1.x should be compatible with 0.1.y
  })
})
