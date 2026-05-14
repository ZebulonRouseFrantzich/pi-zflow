/**
 * skill-loading-policy.test.ts — Task 8.10: Skill and prompt-fragment loading policy verification.
 *
 * Validates that:
 * 1. The skill-loading policy document exists with key rules.
 * 2. Skill files stay within size budgets (individual < 35KB, with actionable flag for >10KB).
 * 3. Mode prompt fragments stay under 2KB each.
 * 4. Reminder prompt fragments stay under 1KB each.
 * 5. All agents use inheritSkills: false as the default.
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import assert from "node:assert/strict"
import { describe, it, before } from "node:test"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..")
const AGENTS_DIR = path.join(REPO_ROOT, "packages", "pi-zflow-agents")

// ── Helpers ──────────────────────────────────────────────────────

async function readDoc(filename: string): Promise<string> {
  const docPath = path.join(REPO_ROOT, "docs", filename)
  return await fs.readFile(docPath, "utf-8")
}

async function readFileSafe(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf-8")
  } catch {
    return ""
  }
}

async function listFiles(dir: string, ext: string): Promise<string[]> {
  const entries: string[] = []
  try {
    const items = await fs.readdir(dir, { withFileTypes: true })
    for (const item of items) {
      const fullPath = path.join(dir, item.name)
      if (item.isDirectory()) {
        entries.push(...await listFiles(fullPath, ext))
      } else if (item.name.endsWith(ext)) {
        entries.push(fullPath)
      }
    }
  } catch {
    // Directory doesn't exist
  }
  return entries
}

// ── Policy document tests ────────────────────────────────────────

describe("skill-loading-policy", () => {
  it("policy document exists and contains key rules", async () => {
    const policy = await readDoc("skill-loading-policy.md")
    assert.ok(policy.includes("Inject only needed focused skills"))
    assert.ok(policy.includes("inheritSkills: false"))
    assert.ok(policy.includes("Size budgets"))
    assert.ok(policy.length > 0)
  })

  it("policy document describes when skills should be loaded", async () => {
    const policy = await readDoc("skill-loading-policy.md")
    const expectedTriggers = [
      "Role relevance",
      "Explicit frontmatter",
      "On-demand injection",
      "After compaction",
    ]
    for (const trigger of expectedTriggers) {
      assert.ok(policy.includes(trigger), `Policy should include "${trigger}"`)
    }
  })

  it("policy document describes when skills should NOT be loaded", async () => {
    const policy = await readDoc("skill-loading-policy.md")
    const expectedAvoid = [
      "always-inherited background knowledge",
      "role doesn't need them",
      "implementation agents unnecessarily",
      "context is tight",
    ]
    for (const avoid of expectedAvoid) {
      assert.ok(policy.includes(avoid), `Policy should include "${avoid}"`)
    }
  })

  it("policy document specifies size budgets for skills and fragments", async () => {
    const policy = await readDoc("skill-loading-policy.md")
    assert.ok(policy.includes("5KB"))
    assert.ok(policy.includes("2KB"))
    assert.ok(policy.includes("1KB"))
  })

  it("policy document lists which agents use which skills", async () => {
    const policy = await readDoc("skill-loading-policy.md")
    assert.ok(policy.includes("implement-routine"))
    assert.ok(policy.includes("implementation-orchestration"))
    assert.ok(policy.includes("`implement-routine`") && policy.includes("|"))
  })

  it("policy document flags runecontext-workflow as an outlier", async () => {
    const policy = await readDoc("skill-loading-policy.md")
    assert.ok(policy.includes("runecontext-workflow"))
    assert.ok(policy.includes("29.5KB"))
  })
})

// ── Skill size budget tests ──────────────────────────────────────

describe("skill-size-budgets", () => {
  let skillFiles: string[]

  before(async () => {
    const skillsDir = path.join(AGENTS_DIR, "skills")
    const allMds = await listFiles(skillsDir, "SKILL.md")
    skillFiles = allMds.filter(f => f.endsWith("SKILL.md"))
  })

  it("all skill files exist", () => {
    assert.ok(skillFiles.length >= 7, `Expected at least 7 skill files, found ${skillFiles.length}`)
  })

  it("no single skill file exceeds 35KB", async () => {
    const oversized: string[] = []
    for (const f of skillFiles) {
      const content = await readFileSafe(f)
      if (content.length > 35_000) {
        oversized.push(`${path.basename(path.dirname(f))}: ${content.length} bytes`)
      }
    }
    assert.ok(
      oversized.length === 0,
      `Skills exceeding 35KB:\n${oversized.join("\n")}`,
    )
  })

  it("reports actionable warning for skills over 10KB", async () => {
    const large: string[] = []
    for (const f of skillFiles) {
      const content = await readFileSafe(f)
      if (content.length > 10_000) {
        large.push(`${path.basename(path.dirname(f))}: ${content.length} bytes — should be split`)
      }
    }
    // Known exception: runecontext-workflow (29KB) is large by design —
    // covers RuneContext detection, change-doc parsing, canonical doc
    // resolution, and write-back support. Loaded only for planning agents.
    // All other skills must be under 10KB.
    const nonRunecontext = large.filter(l => !l.startsWith("runecontext"))
    assert.equal(nonRunecontext.length, 0,
      `Skills exceeding 10KB (excluding known exception): ${nonRunecontext.join(", ")}`)
    // Still log runecontext as informational warning
    if (large.length > 0) {
      console.warn(`Skills exceeding 10KB (consider splitting):\n${large.join("\n")}`)
    }
  })
})

// ── Mode fragment size budget tests ──────────────────────────────

describe("mode-fragment-size-budgets", () => {
  let modeFiles: string[]

  before(async () => {
    const modesDir = path.join(AGENTS_DIR, "prompt-fragments", "modes")
    modeFiles = await listFiles(modesDir, ".md")
  })

  it("all mode fragments are under 2KB", async () => {
    const oversized: string[] = []
    for (const f of modeFiles) {
      const content = await readFileSafe(f)
      if (content.length >= 2_000) {
        oversized.push(`${path.basename(f)}: ${content.length} bytes`)
      }
    }
    assert.ok(
      oversized.length === 0,
      `Mode fragments exceeding 2KB budget:\n${oversized.join("\n")}`,
    )
  })
})

// ── Reminder fragment size budget tests ──────────────────────────

describe("reminder-fragment-size-budgets", () => {
  let reminderFiles: string[]

  before(async () => {
    const remindersDir = path.join(AGENTS_DIR, "prompt-fragments", "reminders")
    reminderFiles = await listFiles(remindersDir, ".md")
  })

  it("all reminder fragments are under 1KB", async () => {
    const oversized: string[] = []
    for (const f of reminderFiles) {
      const content = await readFileSafe(f)
      if (content.length >= 1_000) {
        oversized.push(`${path.basename(f)}: ${content.length} bytes`)
      }
    }
    assert.ok(
      oversized.length === 0,
      `Reminder fragments exceeding 1KB budget:\n${oversized.join("\n")}`,
    )
  })
})

// ── Agent frontmatter defaults test ──────────────────────────────

describe("agent-frontmatter-defaults", () => {
  let agentFiles: string[]

  before(async () => {
    const agentsDir = path.join(AGENTS_DIR, "agents")
    agentFiles = await listFiles(agentsDir, ".md")
  })

  it("all agents have inheritSkills: false", async () => {
    const nonCompliant: string[] = []
    for (const f of agentFiles) {
      const content = await readFileSafe(f)
      const nameMatch = content.match(/^name:\s*(.*)$/m)
      const agentName = nameMatch ? nameMatch[1] : path.basename(f)

      // Check if inheritSkills is explicitly set to false
      const inheritMatch = content.match(/^inheritSkills:\s*(.*)$/m)
      if (!inheritMatch) {
        nonCompliant.push(`${agentName}: missing inheritSkills field`)
      } else if (inheritMatch[1].trim() !== "false") {
        nonCompliant.push(`${agentName}: inheritSkills is "${inheritMatch[1].trim()}", expected "false"`)
      }
    }
    assert.ok(
      nonCompliant.length === 0,
      `Agents with non-compliant inheritSkills:\n${nonCompliant.join("\n")}`,
    )
  })

  it("all agents declare at most one skills entry in frontmatter", async () => {
    const multiSkills: string[] = []
    for (const f of agentFiles) {
      const content = await readFileSafe(f)
      const nameMatch = content.match(/^name:\s*(.*)$/m)
      const agentName = nameMatch ? nameMatch[1] : path.basename(f)

      // Count skills: occurrences in frontmatter
      const matches = content.match(/^skills:/gm)
      if (matches && matches.length > 1) {
        multiSkills.push(`${agentName}: ${matches.length} skills: declarations`)
      }
    }
    assert.ok(
      multiSkills.length === 0,
      `Agents with multiple skills: declarations:\n${multiSkills.join("\n")}`,
    )
  })
})
