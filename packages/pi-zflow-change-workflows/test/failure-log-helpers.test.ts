/**
 * failure-log-helpers.test.ts — Unit tests for failure-log readback helpers.
 *
 * Tests loadRecentFailureLogEntries() and formatFailureLogReadback().
 */
import * as assert from "node:assert"
import { test, describe, afterEach, beforeEach } from "node:test"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { execFileSync } from "node:child_process"

import {
  loadRecentFailureLogEntries,
  formatFailureLogReadback,
} from "../src/failure-log-helpers.js"

import type {
  FailureLogEntry,
} from "../extensions/zflow-change-workflows/failure-log.js"

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Create a temporary directory with a git repo for test isolation.
 * The git repo ensures resolveRuntimeStateDir uses .git/pi-zflow/.
 */
async function makeTempDir(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-test-failure-log-"))
  execFileSync("git", ["init"], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  await fs.writeFile(path.join(tmpDir, "README.md"), "# Test\n", "utf-8")
  execFileSync("git", ["add", "."], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  return tmpDir
}

/**
 * Create a minimal fake failure log file.
 * resolveRuntimeStateDir(cwd) resolves to `<git-dir>/pi-zflow/`,
 * so we write the log at `.git/pi-zflow/failure-log.md`.
 */
async function writeFakeFailureLog(
  repoRoot: string,
  entries: FailureLogEntry[],
): Promise<void> {
  const runtimeStateDir = path.join(repoRoot, ".git", "pi-zflow")
  await fs.mkdir(runtimeStateDir, { recursive: true })
  const logPath = path.join(runtimeStateDir, "failure-log.md")
  const lines: string[] = []
  for (const entry of entries) {
    lines.push(`## ${entry.timestamp}: ${entry.context}`)
    if (entry.expected) lines.push(`- **Expected**: ${entry.expected}`)
    if (entry.actual) lines.push(`- **Actual**: ${entry.actual}`)
    if (entry.rootCause) lines.push(`- **Root cause**: ${entry.rootCause}`)
    if (entry.fixApplied) lines.push(`- **Fix applied**: ${entry.fixApplied}`)
    if (entry.prevention) lines.push(`- **Prevention**: ${entry.prevention}`)
    lines.push("")
  }
  await fs.writeFile(logPath, lines.join("\n"), "utf-8")
}

// ── Fixtures ────────────────────────────────────────────────────

function makeRecentEntry(overrides?: Partial<FailureLogEntry>): FailureLogEntry {
  return {
    timestamp: new Date().toISOString(),
    context: "Plan quality: missing execution group for config module",
    expected: "All config files change in a single execution group",
    actual: "Config changes split across groups, causing git conflict",
    rootCause: "plan-quality",
    fixApplied: "Consolidated config changes into Group 1",
    prevention: "Validate config ownership overlaps during plan validation",
    ...overrides,
  }
}

function makeOldEntry(daysOld: number, overrides?: Partial<FailureLogEntry>): FailureLogEntry {
  const date = new Date()
  date.setDate(date.getDate() - daysOld)
  return {
    timestamp: date.toISOString(),
    context: "Old verification gap in tests",
    expected: "Tests pass after implementation",
    actual: "Integration test failed due to missing mock",
    rootCause: "verification-gap",
    fixApplied: "Added missing mock",
    prevention: "Run integration tests with full dependency tree",
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────────

describe("loadRecentFailureLogEntries", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await makeTempDir()
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  test("returns empty array when no failure log exists", async () => {
    const result = await loadRecentFailureLogEntries({
      context: "config ownership",
      cwd: tmpDir,
    })
    assert.strictEqual(result.length, 0)
  })

  test("returns relevant entries from a populated log", async () => {
    await writeFakeFailureLog(tmpDir, [
      makeRecentEntry(),
      makeRecentEntry({
        context: "Tool limitation: git apply timeout on large patch",
        rootCause: "tool-limitation",
      }),
    ])

    const result = await loadRecentFailureLogEntries({
      context: "config ownership",
      cwd: tmpDir,
    })
    assert.ok(result.length >= 1, "should find at least one matching entry")
    assert.ok(
      result.some((e) => e.context.includes("config module")),
      "should find the config-related entry",
    )
  })

  test("respects limit parameter", async () => {
    // Create 5 entries all matching "config"
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeRecentEntry({
        context: `Config issue #${i + 1}`,
        rootCause: "plan-quality",
        prevention: `Prevention #${i + 1}`,
      }),
    )
    await writeFakeFailureLog(tmpDir, entries)

    const result = await loadRecentFailureLogEntries({
      context: "config",
      limit: 2,
      cwd: tmpDir,
    })
    assert.strictEqual(result.length, 2, "should return at most 2 entries")
  })

  test("filters by tags when provided", async () => {
    await writeFakeFailureLog(tmpDir, [
      makeRecentEntry({ rootCause: "plan-quality" }),
      makeRecentEntry({
        context: "Verification missed edge case",
        rootCause: "verification-gap",
      }),
    ])

    const result = await loadRecentFailureLogEntries({
      context: "config",
      tags: ["verification-gap"],
      cwd: tmpDir,
    })
    assert.strictEqual(result.length, 1, "should find only verification-gap entries")
    assert.strictEqual(result[0]?.rootCause, "verification-gap")
  })

  test("filters by age, excluding old entries", async () => {
    await writeFakeFailureLog(tmpDir, [
      makeRecentEntry({ context: "Recent config issue" }),
      makeOldEntry(60, { context: "Old config issue from 60 days ago" }),
    ])

    const result = await loadRecentFailureLogEntries({
      context: "config",
      maxAge: 30,
      cwd: tmpDir,
    })
    assert.strictEqual(result.length, 1, "should exclude the 60-day-old entry")
    assert.ok(result[0]?.context.includes("Recent"), "should keep the recent entry")
  })
})

describe("formatFailureLogReadback", () => {
  test("returns safe fallback when entries array is empty", () => {
    const result = formatFailureLogReadback([])
    assert.strictEqual(result, "No relevant past failures found.")
  })

  test("produces a string with key fields when entries are provided", () => {
    const entry: FailureLogEntry = {
      timestamp: new Date().toISOString(),
      context: "Plan quality: missing execution group for config module",
      rootCause: "plan-quality",
      prevention: "Validate config ownership overlaps during plan validation",
      fixApplied: "Consolidated config changes into Group 1",
    }

    const result = formatFailureLogReadback([entry])
    assert.ok(result.includes("Relevant past failures"), "should have header")
    assert.ok(result.includes("config module"), "should include context")
    assert.ok(result.includes("plan-quality"), "should include root cause")
    assert.ok(result.includes("Validate config ownership"), "should include prevention")
  })

  test("keeps output under 1000 characters", () => {
    // Create 20 entries to force truncation
    const entries: FailureLogEntry[] = Array.from({ length: 20 }, (_, i) => ({
      timestamp: new Date().toISOString(),
      context: `Failure entry #${i + 1}: very long context description that should be truncated when there are too many items`,
      rootCause: "plan-quality",
      prevention: "Some prevention recommendation that takes up more space " +
        "and makes the entry even longer so it triggers truncation sooner",
    }))

    const result = formatFailureLogReadback(entries)
    assert.ok(
      result.length <= 1000,
      `output length ${result.length} should be ≤ 1000 characters`,
    )
  })
})
