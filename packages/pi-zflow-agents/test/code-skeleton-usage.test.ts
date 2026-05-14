/**
 * code-skeleton-usage.test.ts — Task 8.7: code-skeleton usage verification.
 *
 * Validates that:
 * 1. The code-skeleton usage policy document exists with key guidance.
 * 2. The prompt fragment exists with expected sections.
 * 3. The prompt fragment is concise (under 2000 characters).
 * 4. The policy document includes an example skeleton format.
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

describe("code-skeleton-usage-policy", () => {
  it("policy document exists and contains key usage guidance", async () => {
    const policy = await readDoc("code-skeleton-usage.md")
    assert.ok(policy.includes("code-skeleton"))
    assert.ok(policy.includes("When to produce"))
    assert.ok(policy.includes("When NOT to use"))
    assert.ok(policy.length > 0)
  })

  it("policy document describes when to produce skeletons", async () => {
    const policy = await readDoc("code-skeleton-usage.md")
    const expectedScenarios = [
      "Before planning",
      "Context handoff",
      "After compaction",
      "Review preparation",
    ]
    for (const scenario of expectedScenarios) {
      assert.ok(policy.includes(scenario), `Policy should include "${scenario}"`)
    }
  })

  it("policy document describes when NOT to use skeletons", async () => {
    const policy = await readDoc("code-skeleton-usage.md")
    const expectedAvoid = [
      "Implementation details matter",
      "File is small",
      "Content already in context",
    ]
    for (const avoid of expectedAvoid) {
      assert.ok(policy.includes(avoid), `Policy should include "${avoid}"`)
    }
  })

  it("policy document mentions 30 line limit", async () => {
    const policy = await readDoc("code-skeleton-usage.md")
    assert.ok(policy.includes("30 lines"))
  })

  it("policy document includes an example skeleton format", async () => {
    const policy = await readDoc("code-skeleton-usage.md")
    assert.ok(policy.includes("**Exports:**"))
    assert.ok(policy.includes("**Imports from this module (major consumers):**"))
  })
})

describe("code-skeleton-guide-fragment", () => {
  it("prompt fragment exists and has content", async () => {
    const fragment = await readPromptFragment("code-skeleton-guide")
    assert.ok(fragment.length > 0)
  })

  it("prompt fragment contains key guidance sections", async () => {
    const fragment = await readPromptFragment("code-skeleton-guide")
    const expectedSections = [
      "When to produce",
      "When NOT to use",
      "Skeleton format",
      "30 lines",
    ]
    for (const section of expectedSections) {
      assert.ok(fragment.includes(section), `Fragment should include "${section}"`)
    }
  })

  it("prompt fragment mentions when implementation details matter", async () => {
    const fragment = await readPromptFragment("code-skeleton-guide")
    assert.ok(fragment.includes("implementation details matter"))
  })

  it("prompt fragment is concise (under 2000 characters)", async () => {
    const fragment = await readPromptFragment("code-skeleton-guide")
    assert.ok(
      fragment.length < 2_000,
      `Fragment is ${fragment.length} characters, expected < 2000`,
    )
  })
})
