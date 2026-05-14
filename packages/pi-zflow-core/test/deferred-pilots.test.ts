/**
 * deferred-pilots.test.ts — Documentation validation for deferred systems.
 *
 * Verifies that docs/deferred-pilots.md exists and documents all intentionally
 * deferred context/navigation systems with their rationale and alternatives.
 *
 * @module pi-zflow-core/test/deferred-pilots
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import assert from "node:assert"
import { describe, it } from "node:test"

// ── Test helpers ────────────────────────────────────────────────

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..")
const DOC_PATH = path.join(ROOT, "docs", "deferred-pilots.md")
const README_PATH = path.join(ROOT, "README.md")

async function readDoc(filePath: string): Promise<string> {
  return await fs.readFile(filePath, "utf-8")
}

// ── Deferred items check ────────────────────────────────────────

describe("deferred-pilots document", () => {
  it("exists and references all six deferred systems", async () => {
    const content = await readDoc(DOC_PATH)
    const required = [
      "pi-dcp",
      "pi-observational-memory",
      "manifest.build",
      "nono",
      "Indexed code navigation foundation",
      "codemapper",
    ]
    for (const item of required) {
      assert.ok(
        content.includes(item),
        `Expected deferred document to mention "${item}"`,
      )
    }
  })

  it("documents each deferred system with a reason", async () => {
    const content = await readDoc(DOC_PATH)
    // Each system should have a "Why deferred" or "Re-evaluation trigger" section
    const reasonIndicators = [
      "Why deferred",
      "Re-evaluation trigger",
    ]
    let reasonCount = 0
    for (const indicator of reasonIndicators) {
      // Count occurrences of each indicator
      const matches = content.match(new RegExp(`\\*\\*${indicator}\\*\\*`, "g"))
      if (matches) reasonCount += matches.length
    }
    // At least 6 indicators across the document (one per system)
    assert.ok(
      reasonCount >= 6,
      `Expected at least 6 reason/trigger sections, found ${reasonCount}`,
    )
  })

  it("mentions the cymbal alternative for indexed code navigation", async () => {
    const content = await readDoc(DOC_PATH)
    assert.ok(content.includes("cymbal"), "Expected document to mention cymbal")
    assert.ok(
      content.includes("codemapper") && content.includes("cymbal"),
      "Expected cymbal to be presented as alternative to codemapper",
    )
  })

  it("documents the baseline comparison policy", async () => {
    const content = await readDoc(DOC_PATH)
    const baselinePhrases = [
      "measured against",
      "Phase 8 baseline",
      "explicit approval",
    ]
    for (const phrase of baselinePhrases) {
      assert.ok(
        content.includes(phrase),
        `Expected document to include "${phrase}"`,
      )
    }
  })

  it("documents an alternative for each deferred system", async () => {
    const content = await readDoc(DOC_PATH)
    // Look for the Phase 8 equivalent table
    assert.ok(
      content.includes("Phase 8 equivalent"),
      "Expected a table mapping deferred systems to current equivalents",
    )
    // Each system should have an "Alternative" field
    const altMatches = content.match(/\*\*Alternative\*\*/g)
    assert.ok(
      altMatches && altMatches.length >= 6,
      `Expected at least 6 Alternative sections, found ${altMatches?.length ?? 0}`,
    )
  })

  it("does not exceed 15KB", async () => {
    const content = await readDoc(DOC_PATH)
    assert.ok(
      content.length < 15000,
      `Expected document under 15KB, got ${(content.length / 1024).toFixed(1)}KB`,
    )
  })
})

// ── README reference check ──────────────────────────────────────

describe("README deferred systems section", () => {
  it("references docs/deferred-pilots.md", async () => {
    const content = await readDoc(README_PATH)
    assert.ok(
      content.includes("deferred-pilots.md"),
      "Expected README to reference docs/deferred-pilots.md",
    )
  })

  it("lists the six deferred systems", async () => {
    const content = await readDoc(README_PATH)
    const required = [
      "pi-dcp",
      "pi-observational-memory",
      "manifest.build",
      "nono",
      "Indexed code navigation",
      "codemapper",
    ]
    for (const item of required) {
      assert.ok(
        content.includes(item),
        `Expected README to mention "${item}"`,
      )
    }
  })

  it("states these are intentionally excluded from v1", async () => {
    const content = await readDoc(README_PATH)
    const exclusionPhrases = [
      "intentionally excluded",
      "explicit re-evaluation",
    ]
    // Check across line boundaries by removing newlines for matching
    const flatContent = content.replace(/\n/g, " ")
    const found = exclusionPhrases.some((p) => flatContent.includes(p))
    assert.ok(found, "Expected README to indicate intentional exclusion from v1")
  })
})
