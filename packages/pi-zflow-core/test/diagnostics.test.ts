/**
 * Diagnostics tests — formatting, conflict inspection, missing capability messages.
 */
import * as assert from "node:assert"
import { test, describe, beforeEach } from "node:test"
import {
  getZflowRegistry,
  resetZflowRegistry,
} from "../src/registry.js"
import {
  formatDiagnostic,
  checkCapabilityConflict,
  formatMissingCapability,
  checkCommandCollision,
} from "../src/diagnostics.js"

describe("formatDiagnostic", () => {
  test("formats an info diagnostic", () => {
    const result = formatDiagnostic({
      level: "info",
      message: "loaded profiles",
      capability: "profiles",
      provider: "pi-zflow-profiles",
      timestamp: 1000,
    })
    assert.ok(result.includes("ℹ"))
    assert.ok(result.includes("[profiles]"))
    assert.ok(result.includes("loaded profiles"))
  })

  test("formats a warn diagnostic", () => {
    const result = formatDiagnostic({
      level: "warn",
      message: "deprecated version",
      timestamp: 1000,
    })
    assert.ok(result.includes("⚠"))
    assert.ok(result.includes("deprecated version"))
  })

  test("formats an error diagnostic", () => {
    const result = formatDiagnostic({
      level: "error",
      message: "capability conflict",
      capability: "profiles",
      provider: "pi-zflow-profiles",
      timestamp: 1000,
    })
    assert.ok(result.includes("✖"))
    assert.ok(result.includes("[profiles]"))
    assert.ok(result.includes("capability conflict"))
  })
})

describe("checkCapabilityConflict", () => {
  beforeEach(() => {
    resetZflowRegistry()
  })

  test("returns null for unclaimed capability", () => {
    const result = checkCapabilityConflict("profiles", "pi-zflow-profiles", "0.1.0")
    assert.strictEqual(result, null)
  })

  test("returns null for same provider and version", () => {
    const reg = getZflowRegistry()
    reg.claim({
      capability: "profiles",
      version: "0.1.0",
      provider: "pi-zflow-profiles",
      sourcePath: "test.ts",
    })
    const result = checkCapabilityConflict("profiles", "pi-zflow-profiles", "0.1.0")
    assert.strictEqual(result, null)
  })

  test("returns conflict message for different provider", () => {
    const reg = getZflowRegistry()
    reg.claim({
      capability: "profiles",
      version: "0.1.0",
      provider: "pi-zflow-profiles",
      sourcePath: "test.ts",
    })
    const result = checkCapabilityConflict("profiles", "pi-zflow-profiles-alt", "0.1.0")
    assert.ok(result !== null)
    assert.ok(result!.includes("already owned by"))
    assert.ok(result!.includes("pi-zflow-profiles"))
    assert.ok(result!.includes("pi-zflow-profiles-alt"))
  })
})

describe("formatMissingCapability", () => {
  test("includes default package name", () => {
    const result = formatMissingCapability("review")
    assert.ok(result.includes("review"))
    assert.ok(result.includes("pi install npm:pi-zflow-review"))
  })

  test("uses explicit suggested package", () => {
    const result = formatMissingCapability("custom", "my-custom-pkg")
    assert.ok(result.includes("my-custom-pkg"))
    assert.ok(result.includes("pi install npm:my-custom-pkg"))
  })
})

describe("checkCommandCollision", () => {
  test("returns null for properly namespaced command", () => {
    const result = checkCommandCollision("/zflow-profile", "pi-zflow-profiles")
    assert.strictEqual(result, null)
  })

  test("returns warning for un-namespaced command", () => {
    const result = checkCommandCollision("/profile", "pi-zflow-profiles")
    assert.ok(result !== null)
    assert.ok(result!.includes("/zflow-"))
    assert.ok(result!.includes("pi-zflow-profiles"))
  })

  test("returns warning for non-slash command", () => {
    const result = checkCommandCollision("zflow-profile", "pi-zflow-profiles")
    assert.ok(result !== null)
  })
})
