/**
 * Tests for ephemeral scratch script policy implementation.
 */
import assert from "node:assert/strict"
import { describe, it, before, after } from "node:test"
import path from "node:path"
import fs from "node:fs/promises"
import os from "node:os"
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
  await fs.mkdir(path.join(RUNTIME_STATE_DIR, "runs", RUN_ID, "scratch", "scripts"), { recursive: true })
})

after(async () => {
  await fs.rm(FIXTURE_DIR, { recursive: true, force: true })
})

// ── resolveScratchScriptsDir ────────────────────────────────────

describe("resolveScratchScriptsDir", () => {
  it("returns the correct path", async () => {
    const mod = await import("../extensions/zflow-change-workflows/orchestration.js")
    const scriptsDir = await mod.resolveScratchScriptsDir(RUN_ID, FIXTURE_DIR)
    const expected = path.join(RUNTIME_STATE_DIR, "runs", RUN_ID, "scratch", "scripts")
    // The actual path may differ due to runtime state dir resolution (git-dir based)
    // Just verify it contains the run ID and scratch/scripts suffix
    assert.ok(scriptsDir.includes(RUN_ID), "Path should contain run ID: " + scriptsDir)
    assert.ok(scriptsDir.endsWith("scratch/scripts"), "Path should end with scratch/scripts: " + scriptsDir)
  })
})

// ── ensureScratchScriptsDir ─────────────────────────────────────

describe("ensureScratchScriptsDir", () => {
  it("creates the directory and returns the path", async () => {
    const mod = await import("../extensions/zflow-change-workflows/orchestration.js")
    const tempRunId = "ensure-test-" + Date.now().toString(36)
    const scriptsDir = await mod.ensureScratchScriptsDir(tempRunId, FIXTURE_DIR)
    assert.ok(existsSync(scriptsDir), "Expected directory to be created: " + scriptsDir)
    assert.ok(scriptsDir.endsWith("scratch/scripts"), "Path should end with scratch/scripts: " + scriptsDir)
  })
})

// ── buildEphemeralScriptRule ────────────────────────────────────

describe("buildEphemeralScriptRule", () => {
  it("includes the correct scratch scripts directory", async () => {
    const mod = await import("../extensions/zflow-change-workflows/orchestration.js")
    const testDir = "/tmp/test-scratch/scripts"
    const rule = mod.buildEphemeralScriptRule(testDir)
    assert.ok(rule.includes(testDir), "Rule should include the scratch scripts directory path")
    assert.ok(rule.includes("Ephemeral Script Policy"), "Rule should have a heading")
    assert.ok(rule.includes("NEVER write helper scripts"), "Rule should forbid root scripts")
  })
})

// ── path guard fix-worker intent ────────────────────────────────

describe("path guard — fix-worker intent", () => {
  it("blocks writes to root-level scripts/ during fix-worker intent", () => {
    const result = guardWrite(
      path.join(FIXTURE_DIR, "scripts", "verify-fix.sh"),
      { ...makeOptions(), intent: "fix-worker" },
    )
    assert.ok(!result.allowed, "Expected write to scripts/verify-fix.sh to be blocked, got: " + result.message)
  })

  it("blocks writes to repo root helper scripts during fix-worker intent", () => {
    const result = guardWrite(
      path.join(FIXTURE_DIR, "verify-fixes.sh"),
      { ...makeOptions(), intent: "fix-worker" },
    )
    assert.ok(!result.allowed, "Expected write to root verify-fixes.sh to be blocked, got: " + result.message)
  })

  it("allows writes to scratch/scripts/ during fix-worker intent", () => {
    const result = guardWrite(
      path.join(RUNTIME_STATE_DIR, "runs", RUN_ID, "scratch", "scripts", "verify-fix.sh"),
      { ...makeOptions(), intent: "fix-worker" },
    )
    assert.ok(result.allowed, "Expected write to scratch/scripts/ to be allowed, got: " + result.message)
  })
})

// ── path guard apply-back-resolver intent ───────────────────────

describe("path guard — apply-back-resolver intent", () => {
  it("blocks writes to repo root during apply-back-resolver intent", () => {
    const result = guardWrite(
      path.join(FIXTURE_DIR, "debug-apply-back.sh"),
      { ...makeOptions(), intent: "apply-back-resolver" },
    )
    assert.ok(!result.allowed, "Expected write to root to be blocked, got: " + result.message)
  })

  it("allows writes to .zflow/runs/ during apply-back-resolver intent", () => {
    const result = guardWrite(
      path.join(RUNTIME_STATE_DIR, "runs", RUN_ID, "scratch", "scripts", "debug.sh"),
      { ...makeOptions(), intent: "apply-back-resolver" },
    )
    assert.ok(result.allowed, "Expected write to .zflow/runs/ to be allowed, got: " + result.message)
  })
})

// ── scanForOrphanedScripts ──────────────────────────────────────

describe("scanForOrphanedScripts", () => {
  it("detects helper scripts at repo root", async () => {
    const mod = await import("../extensions/zflow-change-workflows/orchestration.js")
    // Write a fake helper script at repo root
    const helperPath = path.join(FIXTURE_DIR, "verify-something.sh")
    await fs.writeFile(helperPath, "#!/bin/bash\necho test\n", "utf-8")
    try {
      const orphans = await mod.scanForOrphanedScripts({ cwd: FIXTURE_DIR, maxAgeMinutes: 1440 })
      const found = orphans.some(function(p: string) { return p.includes("verify-something.sh") })
      assert.ok(found, "Should detect verify-something.sh as orphaned, got: " + orphans.join(", "))
    } finally {
      await fs.rm(helperPath, { force: true })
    }
  })

  it("does not flag README as orphaned", async () => {
    const mod = await import("../extensions/zflow-change-workflows/orchestration.js")
    const orphans = await mod.scanForOrphanedScripts({ cwd: FIXTURE_DIR, maxAgeMinutes: 1440 })
    const found = orphans.some(function(p: string) { return p.includes("README") })
    assert.ok(!found, "README should not be flagged: " + orphans.join(", "))
  })
})
