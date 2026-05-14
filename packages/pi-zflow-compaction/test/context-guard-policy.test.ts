/**
 * context-guard-policy.test.ts — Validates that the context-guard policy
 * document exists and documents the prevention-layer rules.
 *
 * This is a documentation-validation test, not a behavioral test of the
 * external pi-mono-context-guard package.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import { resolve } from "node:path"

const PACKAGE_ROOT = resolve(import.meta.dirname ?? __dirname, "..")

describe("context-guard-policy", () => {
  it("policy document exists and contains key prevention rules", async () => {
    const policyPath = resolve(PACKAGE_ROOT, "..", "..", "docs", "context-guard-policy.md")
    const content = await fs.readFile(policyPath, "utf-8")

    assert.ok(content.includes("pi-mono-context-guard"),
      "document mentions the guard package by name")
    assert.ok(content.includes("dedup"),
      "document mentions dedup behavior")
    assert.ok(content.includes("120"),
      "document mentions the default read limit of 120")
    assert.ok(content.includes("head -60") || content.includes("head 60"),
      "document mentions rg bounding with head -60")
    assert.ok(content.includes("per-session") || content.includes("per-process"),
      "document describes dedup cache scoping")
    assert.ok(content.includes("Context guard may suppress") ||
      content.includes("MUST be able to reread"),
      "document describes when dedup suppression is acceptable and when rereads must bypass it")
  })

  it("policy document describes all three safeguards", async () => {
    const policyPath = resolve(PACKAGE_ROOT, "..", "..", "docs", "context-guard-policy.md")
    const content = await fs.readFile(policyPath, "utf-8")

    assert.ok(content.includes("Auto-limit") || content.includes("auto-limit"),
      "document describes the read auto-limit safeguard")
    assert.ok(content.includes("Deduplicate") || content.includes("dedup"),
      "document describes the read dedup safeguard")
    assert.ok(content.includes("Bound") || content.includes("Bounding"),
      "document describes the rg output bounding safeguard")
  })
})
