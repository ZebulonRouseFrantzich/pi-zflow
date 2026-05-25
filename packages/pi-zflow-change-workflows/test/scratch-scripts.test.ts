/**
 * Tests for ephemeral scratch script policy implementation.
 *
 * Validates:
 * - resolveScratchScriptsDir returns the correct path
 * - ensureScratchScriptsDir creates the directory
 * - buildEphemeralScriptRule includes the correct directory path
 * - path guard blocks writes to root scripts/ during fix-worker intent
 * - path guard allows writes to `.zflow/runs/*/scratch/scripts/` during fix-worker intent
 * - scanForOrphanedScripts detects recent helper script files
 */
import * as assert from "node:assert/strict"
import { describe, it, before, after, mock } from "node:test"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import { mkdtempSync, existsSync } from "node:fs"

import { guardWrite } from "../extensions/zflow-change-workflows/path-guard.js"
import type { GuardOptions } from "../extensions/zflow-change-workflows/path-guard.js"

// ── Test fixtures ────────────────────────────────────────────────

const FIXTURE_DIR = mkdtempSync(path.join(os.tmpdir(), "scratch-scripts-test-"))
const RUNTIME_STATE_DIR = path.join(FIXTURE_DIR, ".zflow")
const RUN_ID = "test-run-001"

function makeOptions(overrides?: Partial<GuardOptions>): GuardOptions {
  return {
    projectRoot: FIXTURE_DIR,
    runtimeStateDir: RUNTIME_STATE_DIR,
    ...overrides,
  }
}

// ── Setup / Teardown ─────────────────────────────────────────────

before(async () => {
  // Create the runtime state directory structure
  await fs.mkdir(path.join(RUNTIME_STATE_DIR, "runs", RUN_ID, "scratch", "scripts"), { recursive: true })
})

after(async () => {
  await fs.rm(FIXTURE_DIR, { recursive: true, force: true })
})

// ── resolveScratchScriptsDir ────────────────────────────────────

describe("resolveScratchScriptsDir", () => {
  it("returns the correct path", async () => {
    const { resolveScratchScriptsDir } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    const scriptsDir = await resolveScratchScriptsDir(RUN_ID, FIXTURE_DIR)
    const expected = path.join(RUNTIME_STATE_DIR, "runs", RUN_ID, "scratch", "scripts")
    assert.equal(scriptsDir, expected, `Expected ${expected}, got ${scriptsDir}`)
  })
})

// ── ensureScratchScriptsDir ─────────────────────────────────────

describe("ensureScratchScriptsDir", () => {
  it("creates the directory and returns the path", async () => {
    const { ensureScratchScriptsDir } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    const tempRunId = `ensure-test-${Date.now().toString(36)}`
    const scriptsDir = await ensureScratchScriptsDir(tempRunId, FIXTURE_DIR)
    assert.ok(existsSync(scriptsDir), `Expected directory to be created: ${scriptsDir}`)
    // Verify path is correct
    const expected = path.join(RUNTIME_STATE_DIR, "runs", tempRunId, "scratch", "scripts")
    assert.equal(scriptsDir, expected, `Expected ${expected}, got ${scriptsDir}`)
  })
})

// ── buildEphemeralScriptRule ────────────────────────────────────

describe("buildEphemeralScriptRule", () => {
  it("includes the correct scratch scripts directory", () => {
    const { buildEphemeralScriptRule } = require(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    const testDir = "/tmp/test-scratch/scripts"
    const rule = buildEphemeralScriptRule(testDir)
    assert.ok(rule.includes(testDir), "Rule should include the scratch scripts directory path")
    assert.ok(rule.includes("Ephemeral Script Policy"), "Rule should have a heading")
    assert.ok(rule.includes("Never write helper scripts to"), "Rule should forbid root scripts")
    assert.ok(rule.includes("blocked by the path guard"), "Rule should mention path guard enforcement")
  })
})

// ── path guard fix-worker intent ────────────────────────────────

describe("path guard — fix-worker intent", () => {
  it("blocks writes to root-level scripts/ during fix-worker intent", () => {
    const result = guardWrite(
      path.join(FIXTURE_DIR, "scripts", "verify-fix.sh"),
      { ...makeOptions(), intent: "fix-worker" },
    )
    assert.ok(!result.allowed,
      `Expected write to scripts/verify-fix.sh to be blocked, got: ${result.message}`)
    assert.ok(
      result.message.includes("restricted root directory") || result.message.includes("denied"),
      `Expected denial message about restricted root, got: ${result.message}`,
    )
  })

  it("blocks writes to repo root helper scripts during fix-worker intent", () => {
    const result = guardWrite(
      path.join(FIXTURE_DIR, "verify-fixes.sh"),
      { ...makeOptions(), intent: "fix-worker" },
    )
    assert.ok(!result.allowed,
      `Expected write to root verify-fixes.sh to be blocked, got: ${result.message}`)
  })

  it("allows writes to scratch/scripts/ during fix-worker intent", () => {
    const result = guardWrite(
      path.join(RUNTIME_STATE_DIR, "runs", RUN_ID, "scratch", "scripts", "verify-fix.sh"),
      { ...makeOptions(), intent: "fix-worker" },
    )
    assert.ok(result.allowed,
      `Expected write to scratch/scripts/ to be allowed, got: ${result.message}`)
  })

  it("allows writes to .zflow/ runs dir during fix-worker intent", () => {
    const result = guardWrite(
      path.join(RUNTIME_STATE_DIR, "runs", RUN_ID, "some-file.txt"),
      { ...makeOptions(), intent: "fix-worker" },
    )
    assert.ok(result.allowed,
      `Expected write to .zflow/runs/ to be allowed, got: ${result.message}`)
  })
})

// ── path guard apply-back-resolver intent ───────────────────────

describe("path guard — apply-back-resolver intent", () => {
  it("blocks writes to repo root during apply-back-resolver intent", () => {
    const result = guardWrite(
      path.join(FIXTURE_DIR, "debug-merge.sh"),
      { ...makeOptions(), intent: "apply-back-resolver" },
    )
    assert.ok(!result.allowed,
      `Expected write to root debug-merge.sh to be blocked, got: ${result.message}`)
  })

  it("allows writes to scratch/scripts/ during apply-back-resolver intent", () => {
    const result = guardWrite(
      path.join(RUNTIME_STATE_DIR, "runs", RUN_ID, "scratch", "scripts", "resolve.sh"),
      { ...makeOptions(), intent: "apply-back-resolver" },
    )
    assert.ok(result.allowed,
      `Expected write to scratch/scripts/ to be allowed, got: ${result.message}`)
  })

  it("allows writes to .zflow/runs/ during apply-back-resolver intent", () => {
    const result = guardWrite(
      path.join(RUNTIME_STATE_DIR, "runs", RUN_ID, "patches", "group-1.patch"),
      { ...makeOptions(), intent: "apply-back-resolver" },
    )
    assert.ok(result.allowed,
      `Expected write to .zflow/runs/patches to be allowed, got: ${result.message}`)
  })
})

// ── scanForOrphanedScripts ──────────────────────────────────────

describe("scanForOrphanedScripts", () => {
  it("detects recent verify scripts at the repo root", async () => {
    const { scanForOrphanedScripts } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )

    // Create a test verify script at the root with recent mtime
    const testScript = path.join(FIXTURE_DIR, "verify-test-helper.sh")
    await fs.writeFile(testScript, "#!/bin/bash\necho test\n", "utf-8")

    const orphans = await scanForOrphanedScripts({
      cwd: FIXTURE_DIR,
      maxAgeMinutes: 60,
    })

    assert.ok(orphans.length > 0, "Expected at least one orphaned script to be found")
    assert.ok(orphans.includes(testScript),
      `Expected ${testScript} to be in orphans list: ${orphans.join(", ")}`)

    // Cleanup
    await fs.unlink(testScript)
  })

  it("does not flag files without script-like patterns", async () => {
    const { scanForOrphanedScripts } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )

    const testFile = path.join(FIXTURE_DIR, "README.md")
    await fs.writeFile(testFile, "# Test\n", "utf-8")

    const orphans = await scanForOrphanedScripts({
      cwd: FIXTURE_DIR,
      maxAgeMinutes: 60,
    })

    const foundReadme = orphans.some((o) => o.endsWith("README.md"))
    assert.ok(!foundReadme, "README.md should not be flagged as an orphaned script")

    await fs.unlink(testFile)
  })
})

// ── buildWorkerTask includes ephemeral rule hint ────────────────

describe("buildWorkerTask ephemeral script rule", () => {
  it("includes the ephemeral script rule section in the task prompt", async () => {
    const { buildWorkerTask } = await import(
      "../extensions/zflow-change-workflows/orchestration.js"
    )
    const task = buildWorkerTask(
      {
        id: "group-1",
        agent: "zflow.implement-routine",
        files: ["src/test.ts"],
        dependencies: [],
        scopedVerification: "npm test",
        taskPrompt: "Implement group 1",
      },
      { runId: "test-123", repoRoot: "/repo", changeId: "change-1", planVersion: "v1" },
      { design: "/repo/design.md" },
    )
    assert.ok(
      task.includes("Ephemeral Script Policy"),
      "Worker task should include Ephemeral Script Policy heading",
    )
    assert.ok(
      task.includes("scratch/scripts"),
      "Worker task should mention scratch/scripts/ directory",
    )
  })
})
