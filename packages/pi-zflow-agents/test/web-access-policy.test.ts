/**
 * web-access-policy.test.ts — Tests for Task 8.13 web-access policy.
 *
 * Verifies that:
 * - The policy document exists with key restrictions
 * - Implementation agents do not have web_search tools
 * - Planner agent has web_search tools
 * - Policy documents roles that may and may not receive web access
 *
 * @module pi-zflow-agents/test/web-access-policy
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import assert from "node:assert"
import { describe, it } from "node:test"

// ── Helpers ──────────────────────────────────────────────────────

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..")
const agentsDir = path.resolve(repoRoot, "packages", "pi-zflow-agents", "agents")
const docsDir = path.resolve(repoRoot, "docs")

/**
 * Read an agent markdown file and extract the tools: field from frontmatter.
 */
async function getAgentTools(agentName: string): Promise<string[]> {
  const filePath = path.join(agentsDir, `${agentName}.md`)
  const content = await fs.readFile(filePath, "utf-8")

  // Extract the tools: line from frontmatter (between --- delimiters)
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return []

  const frontmatter = match[1]
  const toolsLine = frontmatter.split("\n").find((l) => l.startsWith("tools:"))
  if (!toolsLine) return []

  const toolsValue = toolsLine.replace("tools:", "").trim()
  return toolsValue.split(",").map((t) => t.trim()).filter(Boolean)
}

/**
 * Read a doc file as a string.
 */
async function readDoc(filename: string): Promise<string> {
  const filePath = path.join(docsDir, filename)
  return await fs.readFile(filePath, "utf-8")
}

// ── Tests ────────────────────────────────────────────────────────

describe("web-access-policy", () => {
  it("policy document exists and contains key restriction rules", async () => {
    const policy = await readDoc("web-access-policy.md")
    assert.ok(policy.length > 500, "Policy document should have substantial content")
    assert.ok(
      policy.includes("scoped by role") || policy.includes("authorized roles"),
      'Policy should contain "scoped by role" or "authorized roles"',
    )
    assert.ok(
      policy.includes("should focus") || policy.includes("must NOT"),
      'Policy should contain restrictions like "should focus" or "must NOT"',
    )
  })

  it("policy documents roles that may receive web access", async () => {
    const policy = await readDoc("web-access-policy.md")
    // Check that planner-frontier is listed as a role that may receive web access
    assert.ok(policy.includes("planner-frontier"), "Policy should mention planner-frontier")
    // Check that review roles are mentioned
    assert.ok(
      policy.includes("review-") || policy.includes("review"),
      "Policy should mention review roles",
    )
  })

  it("policy documents roles that should not receive web access", async () => {
    const policy = await readDoc("web-access-policy.md")
    // Implementation agents should be listed as prohibited
    assert.ok(
      policy.includes("implement-routine") || policy.includes("implement"),
      "Policy should mention implementation agents as restricted",
    )
    assert.ok(policy.includes("verifier"), "Policy should mention verifier as restricted")
  })

  it("policy documents context cost rationale", async () => {
    const policy = await readDoc("web-access-policy.md")
    assert.ok(
      policy.includes("context") && (policy.includes("cost") || policy.includes("token")),
      "Policy should mention context cost or token usage rationale",
    )
  })

  it("planner-frontier has web_search tool", async () => {
    const tools = await getAgentTools("planner-frontier")
    assert.ok(
      tools.includes("web_search"),
      `planner-frontier should have web_search tool, got: ${tools.join(", ")}`,
    )
  })

  it("implement-routine does not have web_search tool", async () => {
    const tools = await getAgentTools("implement-routine")
    assert.ok(
      !tools.includes("web_search"),
      `implement-routine should NOT have web_search tool, got: ${tools.join(", ")}`,
    )
  })

  it("implement-hard does not have web_search tool", async () => {
    const tools = await getAgentTools("implement-hard")
    assert.ok(
      !tools.includes("web_search"),
      `implement-hard should NOT have web_search tool, got: ${tools.join(", ")}`,
    )
  })

  it("verifier does not have web_search tool", async () => {
    const tools = await getAgentTools("verifier")
    assert.ok(
      !tools.includes("web_search"),
      `verifier should NOT have web_search tool, got: ${tools.join(", ")}`,
    )
  })
})
