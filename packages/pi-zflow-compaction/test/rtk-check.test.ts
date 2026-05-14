/**
 * rtk-check.test.ts — Tests for the RTK binary availability check module.
 *
 * @module pi-zflow-compaction/test/rtk-check
 */

import { describe, it, mock } from "node:test"
import assert from "node:assert/strict"

// ── Helper to reset module state between tests ──────────────────

/**
 * Import the module fresh for each test. We use dynamic import with
 * a cache-busting query parameter so that mocked dependencies do not
 * leak between tests.
 */
async function importModule(cacheBust: string) {
  return import(`../src/rtk-check.js?cache=${cacheBust}`)
}

// ── Tests ───────────────────────────────────────────────────────

describe("rtk-check", () => {
  it("checkRtkAvailability returns an object with available boolean", async () => {
    const mod = await importModule("a")
    const result = await mod.checkRtkAvailability()

    // Result must be an object with an `available` boolean
    assert.ok(typeof result === "object" && result !== null)
    assert.equal(typeof result.available, "boolean")
    // The actual value depends on whether rtk is installed — we just
    // verify the shape and that available is a boolean.
    if (result.available) {
      assert.ok(typeof result.version === "string")
    } else {
      // When unavailable, version and path are undefined
      assert.equal(result.version, undefined)
    }
  })

  it("alertRtkMissing emits the standard warning message via console.warn", async () => {
    const mod = await importModule("b")

    // Mock console.warn
    const warnings: string[] = []
    mock.method(console, "warn", (msg: string) => {
      warnings.push(msg)
    })

    await mod.alertRtkMissing()

    // Should have called console.warn once with the standard message
    assert.equal(warnings.length, 1)
    assert.ok(
      warnings[0].includes("Install rtk for command rewriting"),
      `Expected warning to mention installing rtk, got: ${warnings[0]}`,
    )
    assert.ok(
      warnings[0].includes("Output compaction will still work without it"),
      `Expected warning to mention output compaction still works, got: ${warnings[0]}`,
    )

    // Restore original console.warn
    mock.restoreAll()
  })

  it("ensureRtkOrAlert returns the check result", async () => {
    const mod = await importModule("c")

    const result = await mod.ensureRtkOrAlert()

    // Must return an RtkCheckResult
    assert.ok(typeof result === "object" && result !== null)
    assert.equal(typeof result.available, "boolean")
    // If rtk is available, it should also have a version
    if (result.available) {
      assert.ok(typeof result.version === "string")
    }
  })
})
