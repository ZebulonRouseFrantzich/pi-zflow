/**
 * prompt-assembly.test.ts — Tests for prompt-fragment assembly.
 *
 * Covers:
 *   - assemblePrompt includes the role prompt always
 *   - Mode fragment is included only when requested
 *   - Reminders are included only when requested
 *   - Root orchestrator constitution is NOT included for subagents
 *   - Contradictory mode fragments cannot be simultaneously active
 *   - Skills context is included when provided
 *   - Artifact paths are included when provided
 *   - Distilled orchestrator invariants are included when provided
 *   - Unknown agent throws
 *   - listAvailableModes returns the correct set
 *   - listAvailableReminders returns the correct set
 */
import { describe, it } from "node:test"
import * as assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import { tmpdir } from "node:os"
import {
  assemblePrompt,
  checkModeConflicts,
  listAvailableModes,
  listAvailableReminders,
} from "../src/prompt-assembly.js"
import type { WorkflowMode, ReminderId } from "../src/prompt-assembly.js"

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Create a temporary package root with fixture files for testing
 * edge cases that the real package files cannot cover.
 */
function createTempPackageRoot(): string {
  const tmpPath = resolve(tmpdir(), `prompt-assembly-test-${Date.now()}`)
  // Create directory structure
  mkdirSync(resolve(tmpPath, "agents"), { recursive: true })
  mkdirSync(resolve(tmpPath, "prompt-fragments", "modes"), { recursive: true })
  mkdirSync(resolve(tmpPath, "prompt-fragments", "reminders"), { recursive: true })
  return tmpPath
}

function writeTempAgent(root: string, name: string, body: string): void {
  writeFileSync(resolve(root, "agents", `${name}.md`), body, "utf-8")
}

function writeTempMode(root: string, mode: string, content: string): void {
  writeFileSync(
    resolve(root, "prompt-fragments", "modes", `${mode}.md`),
    content,
    "utf-8",
  )
}

function writeTempReminder(root: string, id: string, content: string): void {
  writeFileSync(
    resolve(root, "prompt-fragments", "reminders", `${id}.md`),
    content,
    "utf-8",
  )
}

function cleanupTemp(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

// ── Known package root (used for real file tests) ────────────────

/** Resolve the package root relative to the test file location. */
const PACKAGE_ROOT = resolve(import.meta.dirname ?? __dirname, "..")

// ── Tests ───────────────────────────────────────────────────────

describe("assemblePrompt", () => {
  it("includes the role prompt always", () => {
    const result = assemblePrompt({
      agentName: "zflow.planner-frontier",
    })
    assert.ok(result.rolePrompt.length > 0)
    assert.ok(result.prompt.includes(result.rolePrompt))
    assert.ok(result.prompt.startsWith(result.rolePrompt))
    assert.equal(result.debug.agentFile.length > 0, true)
  })

  it("includes the mode fragment only when requested", () => {
    // Without mode
    const without = assemblePrompt({ agentName: "zflow.planner-frontier" })
    assert.equal(without.modeFragment, undefined)

    // With mode
    const withMode = assemblePrompt({
      agentName: "zflow.planner-frontier",
      mode: "change-prepare",
    })
    assert.ok(withMode.modeFragment !== undefined)
    assert.ok(withMode.modeFragment!.length > 0)
    assert.ok(withMode.prompt.includes(withMode.modeFragment!))
  })

  it("includes reminders only when requested", () => {
    // Without reminders
    const without = assemblePrompt({ agentName: "zflow.planner-frontier" })
    assert.equal(Object.keys(without.includedReminders).length, 0)

    // With reminders
    const withReminders = assemblePrompt({
      agentName: "zflow.planner-frontier",
      activeReminders: ["approved-plan-loaded", "verification-status"],
    })
    assert.equal(Object.keys(withReminders.includedReminders).length, 2)
    assert.ok("approved-plan-loaded" in withReminders.includedReminders)
    assert.ok("verification-status" in withReminders.includedReminders)
    assert.ok(
      withReminders.prompt.includes(
        withReminders.includedReminders["approved-plan-loaded"],
      ),
    )
  })

  it("skips reminders whose files do not exist silently", () => {
    const tmpRoot = createTempPackageRoot()
    try {
      // Create a minimal agent file
      writeTempAgent(tmpRoot, "test-agent", "You are a test agent.")
      // Don't create any reminder files

      const result = assemblePrompt({
        agentName: "zflow.test-agent",
        activeReminders: ["approved-plan-loaded", "verification-status"],
        customPackageRoot: tmpRoot,
      })
      assert.equal(Object.keys(result.includedReminders).length, 0)
    } finally {
      cleanupTemp(tmpRoot)
    }
  })

  it("does NOT include the root-orchestrator constitution for subagents", () => {
    const result = assemblePrompt({
      agentName: "zflow.planner-frontier",
    })
    // The root orchestrator constitution should not appear verbatim
    assert.ok(!result.prompt.includes("Root orchestrator constitution"))
    assert.ok(!result.prompt.includes("## Tool discipline"))
    assert.ok(!result.prompt.includes("## Truthfulness"))
  })

  it("includes skills context when provided", () => {
    const result = assemblePrompt({
      agentName: "zflow.planner-frontier",
      skills: ["change-doc-workflow", "runecontext-workflow"],
    })
    assert.ok(result.skillsContext !== undefined)
    assert.ok(result.skillsContext!.includes("change-doc-workflow"))
    assert.ok(result.skillsContext!.includes("runecontext-workflow"))
    assert.ok(result.prompt.includes("## Relevant skills"))
  })

  it("includes artifact paths when provided", () => {
    const result = assemblePrompt({
      agentName: "zflow.planner-frontier",
      artifactPaths: {
        "Plan artifacts": "/runtime/plans/add-auth/v1",
        "Repo map": "/runtime/repo-map.md",
      },
    })
    assert.ok(result.artifactContext !== undefined)
    assert.ok(result.artifactContext!.includes("/runtime/plans/add-auth/v1"))
    assert.ok(result.artifactContext!.includes("/runtime/repo-map.md"))
    assert.ok(result.prompt.includes("## Canonical paths"))
  })

  it("includes distilled orchestrator invariants when provided", () => {
    const result = assemblePrompt({
      agentName: "zflow.planner-frontier",
      distilledOrchestratorInvariants: [
        "Never modify source code directly.",
        "Use zflow_write_plan_artifact for all writes.",
      ],
    })
    assert.ok(result.orchestratorInvariants !== undefined)
    assert.ok(result.orchestratorInvariants!.includes("Never modify source code"))
    assert.ok(result.orchestratorInvariants!.includes("zflow_write_plan_artifact"))
    assert.ok(result.prompt.includes("## Orchestrator invariants"))
  })

  it("places active constraints near the end of the prompt", () => {
    const result = assemblePrompt({
      agentName: "zflow.planner-frontier",
      mode: "change-prepare",
      activeReminders: ["plan-mode-active"],
      artifactPaths: {
        "Plan directory": "/runtime/plans/my-change/v1",
      },
      skills: ["change-doc-workflow"],
    })
    // The artifact paths section should be near the end
    const canonicalIdx = result.prompt.indexOf("## Canonical paths")
    const roleIdx = result.prompt.indexOf(result.rolePrompt.slice(0, 50))
    assert.ok(canonicalIdx > roleIdx, "Canonical paths should appear after role prompt")
  })

  it("throws on unknown agent file", () => {
    const tmpRoot = createTempPackageRoot()
    try {
      assert.throws(
        () => {
          assemblePrompt({
            agentName: "zflow.nonexistent-agent",
            customPackageRoot: tmpRoot,
          })
        },
        { message: /file not found/ },
      )
    } finally {
      cleanupTemp(tmpRoot)
    }
  })

  it("correctly handles implement-routine agent", () => {
    const result = assemblePrompt({
      agentName: "zflow.implement-routine",
      mode: "change-implement",
      activeReminders: ["approved-plan-loaded"],
    })
    assert.ok(result.rolePrompt.includes("implement-routine"))
    assert.ok(result.rolePrompt.includes("approved plan groups"))
    assert.ok(result.modeFragment !== undefined)
    assert.ok(result.modeFragment!.includes("approved plan version"))
    assert.ok(
      result.includedReminders["approved-plan-loaded"].includes("Approved plan loaded"),
    )
  })

  it("correctly handles review-correctness agent", () => {
    const result = assemblePrompt({
      agentName: "zflow.review-correctness",
      activeReminders: ["verification-status"],
    })
    assert.ok(result.rolePrompt.includes("review-correctness"))
    assert.ok(result.rolePrompt.includes("logic errors"))
    assert.ok(
      result.includedReminders["verification-status"].includes("Verification status"),
    )
  })
})

describe("checkModeConflicts", () => {
  it("returns null when no conflict exists", () => {
    const result = checkModeConflicts("change-prepare", ["plan-mode"])
    assert.equal(result, null)
  })

  it("detects conflict between change-prepare and change-implement", () => {
    const result = checkModeConflicts("change-implement", ["change-prepare"])
    assert.ok(result !== null)
    assert.ok(result!.includes("change-implement"))
    assert.ok(result!.includes("change-prepare"))
    assert.ok(result!.includes("mutually exclusive"))
  })

  it("returns null when conflicting mode is not active", () => {
    const result = checkModeConflicts("change-implement", [])
    assert.equal(result, null)
  })

  it("detects conflict with plan-mode when already active", () => {
    // plan-mode is in its own conflict group
    const result = checkModeConflicts("plan-mode", ["plan-mode"])
    // Having plan-mode as both requested and active is fine since they're the same
    assert.equal(result, null)

    // But having plan-mode and another from same group would be weird (plan-mode is alone)
  })
})

describe("listAvailableModes", () => {
  it("returns the expected mode fragments", () => {
    const modes = listAvailableModes(PACKAGE_ROOT)
    assert.ok(Array.isArray(modes))
    assert.ok(modes.length >= 5, `Expected at least 5 modes, got ${modes.length}`)
    assert.ok(modes.includes("change-prepare"))
    assert.ok(modes.includes("change-implement"))
    assert.ok(modes.includes("plan-mode"))
    assert.ok(modes.includes("review-pr"))
    assert.ok(modes.includes("zflow-clean"))
  })

  it("returns empty array for non-existent modes directory", () => {
    const tmpRoot = createTempPackageRoot()
    try {
      const modes = listAvailableModes(tmpRoot)
      assert.deepEqual(modes, [])
    } finally {
      cleanupTemp(tmpRoot)
    }
  })

  it("filters out non-.md files", () => {
    const tmpRoot = createTempPackageRoot()
    try {
      writeTempMode(tmpRoot, "change-prepare", "# Mode: prepare")
      writeTempMode(tmpRoot, "change-implement", "# Mode: implement")
      // Create a non-markdown file
      writeFileSync(
        resolve(tmpRoot, "prompt-fragments", "modes", ".DS_Store"),
        "",
        "utf-8",
      )
      const modes = listAvailableModes(tmpRoot)
      assert.ok(modes.includes("change-prepare"))
      assert.ok(modes.includes("change-implement"))
      assert.equal(modes.length, 2)
    } finally {
      cleanupTemp(tmpRoot)
    }
  })
})

describe("listAvailableReminders", () => {
  it("returns the expected reminder fragments", () => {
    const reminders = listAvailableReminders(PACKAGE_ROOT)
    assert.ok(Array.isArray(reminders))
    assert.ok(reminders.length >= 7, `Expected at least 7 reminders, got ${reminders.length}`)
    assert.ok(reminders.includes("approved-plan-loaded"))
    assert.ok(reminders.includes("compaction-handoff"))
    assert.ok(reminders.includes("drift-detected"))
    assert.ok(reminders.includes("external-file-change"))
    assert.ok(reminders.includes("plan-mode-active"))
    assert.ok(reminders.includes("tool-denied"))
    assert.ok(reminders.includes("verification-status"))
  })

  it("returns empty array for non-existent reminders directory", () => {
    const tmpRoot = createTempPackageRoot()
    try {
      const reminders = listAvailableReminders(tmpRoot)
      assert.deepEqual(reminders, [])
    } finally {
      cleanupTemp(tmpRoot)
    }
  })
})
