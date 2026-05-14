/**
 * scout-reconnaissance.test.ts — Task 8.6: scout reconnaissance tuning verification.
 *
 * Validates that:
 * 1. The scout reconnaissance policy document exists and contains key terms.
 * 2. The scout prompt fragment exists and contains the expected format sections.
 * 3. The prompt fragment is concise (under 3000 characters).
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import assert from "node:assert/strict"
import { describe, it } from "node:test"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..")

// ── Helpers ──────────────────────────────────────────────────────

async function readDoc(filename: string): Promise<string> {
  const docPath = path.join(REPO_ROOT, "docs", filename)
  return await fs.readFile(docPath, "utf-8")
}

async function readPromptFragment(name: string): Promise<string> {
  const fragmentPath = path.join(
    REPO_ROOT,
    "packages",
    "pi-zflow-agents",
    "prompt-fragments",
    "modes",
    `${name}.md`,
  )
  return await fs.readFile(fragmentPath, "utf-8")
}

// ── Tests ────────────────────────────────────────────────────────

describe("scout-reconnaissance-policy", () => {
  it("policy document exists and contains key role statements", async () => {
    const policy = await readDoc("scout-reconnaissance-policy.md")
    assert.ok(policy.includes("lazy-loading reconnaissance"))
    assert.ok(policy.includes("advisory, not restrictive"))
    assert.ok(policy.includes("maxOutput"))
  })

  it("policy document describes expected output qualities", async () => {
    const policy = await readDoc("scout-reconnaissance-policy.md")
    const expectedSections = [
      "Architecture summary",
      "Patterns and Conventions",
      "Hidden constraints",
      "Key Files",
    ]
    for (const section of expectedSections) {
      assert.ok(policy.includes(section), `Policy should include "${section}"`)
    }
  })

  it("policy document states what scout should NOT do", async () => {
    const policy = await readDoc("scout-reconnaissance-policy.md")
    assert.ok(policy.includes("should NOT do"))
    assert.ok(policy.includes("Dump entire file contents"))
    assert.ok(policy.includes("Make implementation decisions"))
    assert.ok(policy.includes("Override worker file reads"))
  })

  it("policy document is under 8KB", async () => {
    const policy = await readDoc("scout-reconnaissance-policy.md")
    assert.ok(policy.length < 8_000, `Policy is ${policy.length} bytes, expected < 8000`)
  })
})

describe("scout-reconnaissance-fragment", () => {
  it("prompt fragment exists and has content", async () => {
    const fragment = await readPromptFragment("scout-reconnaissance")
    assert.ok(fragment.length > 0)
  })

  it("prompt fragment contains the expected format sections", async () => {
    const fragment = await readPromptFragment("scout-reconnaissance")
    const expectedSections = [
      "### Architecture Overview",
      "### Patterns and Conventions",
      "### Key Files",
      "### Hidden Constraints",
      "### Recommendations",
    ]
    for (const section of expectedSections) {
      assert.ok(fragment.includes(section), `Fragment should include "${section}"`)
    }
  })

  it("prompt fragment mentions 6000 character limit", async () => {
    const fragment = await readPromptFragment("scout-reconnaissance")
    assert.ok(fragment.includes("6000"))
  })

  it("prompt fragment is concise (under 3000 characters)", async () => {
    const fragment = await readPromptFragment("scout-reconnaissance")
    assert.ok(
      fragment.length < 3_000,
      `Fragment is ${fragment.length} characters, expected < 3000`,
    )
  })
})
