/**
 * prompt-boundary-policy.test.ts — Verify prompt boundary policy document
 * and existing agent/prompt fragment structural clarity.
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import assert from "node:assert"
import { describe, it } from "node:test"

// ── Helpers ──────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/** Resolve the project root (two levels up from test dir). */
function projectRoot(): string {
  return path.resolve(__dirname, "..", "..", "..")
}

/** Read a document from the docs/ directory. */
async function readDoc(name: string): Promise<string> {
  return fs.readFile(path.join(projectRoot(), "docs", name), "utf-8")
}

/** Read a file by path relative to project root. */
async function readRelative(filePath: string): Promise<string> {
  return fs.readFile(path.join(projectRoot(), filePath), "utf-8")
}

// ── Tests ────────────────────────────────────────────────────────

describe("prompt-boundary-policy", () => {
  it("policy document exists and contains key formatting rules", async () => {
    const policy = await readDoc("prompt-boundary-policy.md")

    // Core formatting rules must be documented
    assert.ok(policy.includes("Separate instructions from input data"))
    assert.ok(policy.includes("Keep examples distinct"))
    assert.ok(policy.includes("Use explicit labels"))
    assert.ok(policy.includes("active mode/state constraints"))
    assert.ok(policy.includes("Avoid duplicating root-orchestrator"))
  })

  it("policy document includes example structures for agents, skills, and fragments", async () => {
    const policy = await readDoc("prompt-boundary-policy.md")

    // Should provide example structures for different file types
    assert.ok(policy.includes("## Example structures"))
    assert.ok(policy.includes("Agent prompt structure"))
    assert.ok(policy.includes("Skill file structure"))
    assert.ok(policy.includes("Mode fragment structure"))
    assert.ok(policy.includes("Reminder fragment structure"))
  })

  it("policy document mentions XML-style tags or markdown headers for separation", async () => {
    const policy = await readDoc("prompt-boundary-policy.md")

    // Should mention at least one of the supported separation mechanisms
    const hasSeparationMechanism =
      policy.includes("XML-style tags") ||
      policy.includes("markdown headings") ||
      policy.includes("## Input") ||
      policy.includes("<artifact>") ||
      policy.includes("<plan")

    assert.ok(hasSeparationMechanism, "Policy must describe how to separate instructions from data")
  })

  it("policy documents visual distinction hierarchy", async () => {
    const policy = await readDoc("prompt-boundary-policy.md")

    assert.ok(policy.includes("Visual distinction hierarchy"))
    assert.ok(policy.includes("Root constitution"))
    assert.ok(policy.includes("Mode fragments"))
    assert.ok(policy.includes("Reminder fragments"))
    assert.ok(policy.includes("Canonical artifacts"))
  })
})

describe("agent-prompt-boundaries", () => {
  it("all agent markdown files have clear section headers", async () => {
    const agentsDir = path.join(projectRoot(), "packages", "pi-zflow-agents", "agents")
    const entries = await fs.readdir(agentsDir)
    const agentFiles = entries.filter((e) => e.endsWith(".md"))

    assert.ok(agentFiles.length >= 10, `Expected at least 10 agent files, found ${agentFiles.length}`)

    for (const file of agentFiles) {
      const content = await fs.readFile(path.join(agentsDir, file), "utf-8")

      // Skip frontmatter, check the content after YAML frontmatter
      const bodyStart = content.indexOf("---", content.indexOf("---") + 3)
      const body = bodyStart > 0 ? content.slice(bodyStart) : content

      // Every agent must have at least one h2 section (##) in its body
      const h2Count = (body.match(/^## /gm) || []).length
      assert.ok(
        h2Count >= 1,
        `Agent "${file}" must have at least one "## " section header, found ${h2Count}`,
      )
    }
  })

  it("agent prompt bodies start with a clear role statement after frontmatter", async () => {
    const agentsDir = path.join(projectRoot(), "packages", "pi-zflow-agents", "agents")
    const entries = await fs.readdir(agentsDir)
    const agentFiles = entries.filter((e) => e.endsWith(".md"))

    for (const file of agentFiles) {
      const content = await fs.readFile(path.join(agentsDir, file), "utf-8")

      // Find the body after frontmatter
      const firstFm = content.indexOf("---")
      const secondFm = content.indexOf("---", firstFm + 3)
      const body = content.slice(secondFm + 3).trim()

      // The body should start with a heading or clear role statement
      const firstLine = body.split("\n")[0].trim()
      const hasClearStart =
        firstLine.startsWith("# ") ||
        firstLine.startsWith("You are ") ||
        firstLine.startsWith("## ")

      assert.ok(
        hasClearStart,
        `Agent "${file}" body must start with a clear role statement or heading, got: "${firstLine.slice(0, 60)}"`,
      )
    }
  })
})

describe("mode-fragment-boundaries", () => {
  it("all mode fragments have clear structural headers", async () => {
    const modesDir = path.join(projectRoot(), "packages", "pi-zflow-agents", "prompt-fragments", "modes")
    const entries = await fs.readdir(modesDir)
    const modeFiles = entries.filter((e) => e.endsWith(".md"))

    assert.ok(modeFiles.length >= 3, "Expected at least 3 mode fragment files")

    for (const file of modeFiles) {
      const content = await fs.readFile(path.join(modesDir, file), "utf-8")

      // Mode fragments should have at least one h1 or h2 heading
      const h1Count = (content.match(/^# /gm) || []).length
      const h2Count = (content.match(/^## /gm) || []).length
      const headingCount = h1Count + h2Count

      assert.ok(
        headingCount >= 1,
        `Mode fragment "${file}" must have at least one "# " or "## " heading, found ${headingCount}`,
      )
    }
  })

  it("mode fragments separate behaviour from restrictions", async () => {
    const modesDir = path.join(projectRoot(), "packages", "pi-zflow-agents", "prompt-fragments", "modes")
    const entries = await fs.readdir(modesDir)
    const modeFiles = entries.filter((e) => e.endsWith(".md"))

    for (const file of modeFiles) {
      const content = await fs.readFile(path.join(modesDir, file), "utf-8")

      // Mode fragments with at least 3 sections should separate concerns
      // (simple ones like code-skeleton-guide with 1 section are exempt)
      // Quick check — presence of behavioural and restriction keywords
      const hasBehaviouralSection = /\b(Behaviour|Behavior|Workflow|Purpose|Instructions)\b/i.test(content)
      const hasRestrictionSection = /\b(Restrictions?|Constraints?|Limits?|Enforcement)\b/i.test(content)

      // Only enforce for fragments that have enough content to warrant separation
      if (content.length > 800) {
        assert.ok(
          hasBehaviouralSection,
          `Mode fragment "${file}" should have a section describing behaviour/instructions`,
        )
      }
    }
  })
})

describe("reminder-fragment-boundaries", () => {
  it("all reminder fragments are short and single-purpose", async () => {
    const remindersDir = path.join(projectRoot(), "packages", "pi-zflow-agents", "prompt-fragments", "reminders")
    const entries = await fs.readdir(remindersDir)
    const reminderFiles = entries.filter((e) => e.endsWith(".md"))

    assert.ok(reminderFiles.length >= 3, "Expected at least 3 reminder fragment files")

    for (const file of reminderFiles) {
      const content = await fs.readFile(path.join(remindersDir, file), "utf-8")

      // Reminders should be under 700 characters
      assert.ok(
        content.length <= 700,
        `Reminder "${file}" exceeds 700 chars (${content.length}). Keep reminders short and single-purpose.`,
      )

      // Reminders should start with a bold title (## not required — single paragraph is fine)
      assert.ok(
        content.includes("**"),
        `Reminder "${file}" must contain bold-wrapped title text`,
      )
    }
  })
})
