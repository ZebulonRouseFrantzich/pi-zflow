/**
 * worktree-setup.test.ts — Unit tests for Task 5.5 worktree setup hook.
 */
import * as assert from "node:assert"
import { test, describe, before, after, mock } from "node:test"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import { execFileSync } from "node:child_process"
import * as os from "node:os"

import {
  repoNeedsWorktreeSetup,
  getRepoWorktreeSetupConfig,
} from "../extensions/zflow-change-workflows/worktree-setup.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTempRepo(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-zflow-test-"))
  execFileSync("git", ["init"], { cwd: tmpDir, stdio: "pipe" })
  execFileSync("git", ["config", "user.email", "test@test"], { cwd: tmpDir, stdio: "pipe" })
  execFileSync("git", ["config", "user.name", "Test"], { cwd: tmpDir, stdio: "pipe" })
  await fs.writeFile(path.join(tmpDir, ".gitkeep"), "", "utf-8")
  execFileSync("git", ["add", ".gitkeep"], { cwd: tmpDir, stdio: "pipe" })
  execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: tmpDir, stdio: "pipe" })
  return tmpDir
}

// ---------------------------------------------------------------------------
// repoNeedsWorktreeSetup
// ---------------------------------------------------------------------------

describe("repoNeedsWorktreeSetup", () => {
  let repoRoot: string

  before(async () => {
    repoRoot = await createTempRepo()
  })

  after(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true })
  })

  test("returns false for empty repo with only .gitkeep", async () => {
    const needs = await repoNeedsWorktreeSetup(repoRoot)
    // No package.json, no tsconfig.json → "unknown" → false
    assert.equal(needs, false)
  })

  test("returns false for plain-ts-js repo", async () => {
    await fs.writeFile(path.join(repoRoot, "package.json"), '{"name":"test"}', "utf-8")
    await fs.writeFile(path.join(repoRoot, "tsconfig.json"), "{}", "utf-8")
    const needs = await repoNeedsWorktreeSetup(repoRoot)
    assert.equal(needs, false)
  })

  test("returns true for pnpm workspace", async () => {
    await fs.writeFile(path.join(repoRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf-8")
    const needs = await repoNeedsWorktreeSetup(repoRoot)
    assert.equal(needs, true)
    // Clean up for other tests
    await fs.rm(path.join(repoRoot, "pnpm-workspace.yaml"))
  })

  test("returns true for env-stub-required repo", async () => {
    await fs.writeFile(path.join(repoRoot, ".env.example"), "FOO=bar\n", "utf-8")
    const needs = await repoNeedsWorktreeSetup(repoRoot)
    assert.equal(needs, true)
    await fs.rm(path.join(repoRoot, ".env.example"))
  })

  test("returns false for unknown repo class", async () => {
    // No package.json or other markers → "unknown"
    // Already clean from previous cleanup
    const needs = await repoNeedsWorktreeSetup(repoRoot)
    assert.equal(needs, false)
  })
})

// ---------------------------------------------------------------------------
// getRepoWorktreeSetupConfig
// ---------------------------------------------------------------------------

describe("getRepoWorktreeSetupConfig", () => {
  let repoRoot: string

  before(async () => {
    repoRoot = await createTempRepo()
  })

  after(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true })
  })

  test("returns null when no config file exists", async () => {
    const config = await getRepoWorktreeSetupConfig(repoRoot)
    assert.equal(config, null)
  })

  test("returns null when config file has no worktreeSetupHook", async () => {
    const configDir = path.join(repoRoot, ".pi", "zflow")
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({ someOtherSetting: true }),
      "utf-8",
    )
    const config = await getRepoWorktreeSetupConfig(repoRoot)
    assert.equal(config, null)
  })

  test("returns hook config when .pi/zflow/config.json has worktreeSetupHook", async () => {
    const configDir = path.join(repoRoot, ".pi", "zflow")
    await fs.writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({
        worktreeSetupHook: {
          script: ".pi/zflow/worktree-setup-hook.sh",
          runtime: "shell",
          timeoutMs: 30000,
          description: "Install dependencies",
        },
      }),
      "utf-8",
    )
    const config = await getRepoWorktreeSetupConfig(repoRoot)
    assert.ok(config !== null)
    assert.equal(config!.script, ".pi/zflow/worktree-setup-hook.sh")
    assert.equal(config!.runtime, "shell")
    assert.equal(config!.timeoutMs, 30000)
    assert.equal(config!.description, "Install dependencies")
  })

  test("applies default runtime and timeout when not specified", async () => {
    const configDir = path.join(repoRoot, ".pi", "zflow")
    await fs.writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({
        worktreeSetupHook: {
          script: ".pi/zflow/hook.sh",
        },
      }),
      "utf-8",
    )
    const config = await getRepoWorktreeSetupConfig(repoRoot)
    assert.ok(config !== null)
    assert.equal(config!.runtime, "shell")
    assert.equal(config!.timeoutMs, 60000)
  })

  test("reads from pi-zflow.config.json as fallback", async () => {
    // Remove .pi/zflow/config.json and create pi-zflow.config.json
    await fs.rm(path.join(repoRoot, ".pi", "zflow", "config.json"))
    await fs.writeFile(
      path.join(repoRoot, "pi-zflow.config.json"),
      JSON.stringify({
        worktreeSetupHook: {
          script: ".pi/zflow/fallback-hook.sh",
        },
      }),
      "utf-8",
    )
    const config = await getRepoWorktreeSetupConfig(repoRoot)
    assert.ok(config !== null)
    assert.equal(config!.script, ".pi/zflow/fallback-hook.sh")
  })

  test("returns null when config file is invalid JSON", async () => {
    // Remove the valid pi-zflow.config.json so it doesn't shadow the bad file
    await fs.rm(path.join(repoRoot, "pi-zflow.config.json"), { force: true })

    // Write invalid JSON to the FIRST candidate path (.pi/zflow/config.json)
    await fs.mkdir(path.join(repoRoot, ".pi", "zflow"), { recursive: true })
    await fs.writeFile(
      path.join(repoRoot, ".pi", "zflow", "config.json"),
      "not valid json",
      "utf-8",
    )
    // Should skip invalid files and continue searching
    const config = await getRepoWorktreeSetupConfig(repoRoot)
    // No remaining candidates have valid config — should return null
    assert.strictEqual(config, null)
  })

  test("warns on malformed JSON when config file exists but cannot be parsed", async () => {
    const warnCalls: string[] = []
    mock.method(console, "warn", (msg: string) => { warnCalls.push(msg) })

    const configDir = path.join(repoRoot, ".pi", "zflow")
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(path.join(configDir, "config.json"), "not valid json", "utf-8")

    const config = await getRepoWorktreeSetupConfig(repoRoot)

    // Restore original warn before assertions
    mock.restoreAll()

    // NULL because the JSON is unparseable and no other candidates have valid hook config
    assert.strictEqual(config, null)

    // Should have at least one warning mentioning the config path
    const hasWarn = warnCalls.some((w) => w.includes(".pi/zflow/config.json"))
    assert.ok(hasWarn, `expected warning mentioning config path, got: ${warnCalls.join(", ")}`)
  })
})
