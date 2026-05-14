/**
 * recon-cache.test.ts — Tests for reconnaissance caching and freshness checks
 *
 * @module pi-zflow-change-workflows/recon-cache
 */

import assert from "node:assert/strict"
import { describe, it, before, after } from "node:test"
import * as fs from "node:fs/promises"
import { writeFileSync } from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { execFileSync } from "node:child_process"
import {
  getReconCachePath,
  readReconCache,
  writeReconCache,
  isReconFresh,
  type ReconCacheData,
} from "../extensions/zflow-change-workflows/recon-cache.js"

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Create a temporary directory for testing.
 */
async function createTempDir(): Promise<string> {
  const tmpDir = path.join(os.tmpdir(), `recon-cache-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  await fs.mkdir(tmpDir, { recursive: true })
  return tmpDir
}

/**
 * Set up a minimal git repository in the given directory.
 * Initializes git, creates a base file, and commits.
 */
function initGitRepo(dir: string): void {
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "test@test"], { cwd: dir, stdio: "ignore" })
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" })
  writeFileSync(path.join(dir, "README.md"), "# Test")
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" })
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" })
}

/**
 * Clean up a temporary directory.
 */
async function removeTempDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true })
  } catch {
    // Ignore cleanup failures
  }
}

// ── Tests ───────────────────────────────────────────────────────

describe("getReconCachePath", () => {
  it("returns a path ending with .recon-cache.json", () => {
    const cachePath = getReconCachePath("/tmp/test-recon")
    assert.ok(cachePath.endsWith(".recon-cache.json"))
  })
})

describe("readReconCache", () => {
  it("returns null when no cache exists", async () => {
    const tmpDir = await createTempDir()
    try {
      const result = await readReconCache(tmpDir)
      assert.equal(result, null)
    } finally {
      await removeTempDir(tmpDir)
    }
  })
})

describe("writeReconCache and readReconCache", () => {
  it("round-trips cache data correctly", async () => {
    const tmpDir = await createTempDir()
    try {
      const testData: ReconCacheData = {
        hash: "abc123def456",
        generatedAt: "2026-01-01T00:00:00.000Z",
        changePath: "src/auth",
        path: "/tmp/test/reconnaissance.md",
      }

      await writeReconCache(testData, tmpDir)
      const readBack = await readReconCache(tmpDir)

      assert.notEqual(readBack, null)
      assert.equal(readBack!.hash, "abc123def456")
      assert.equal(readBack!.generatedAt, "2026-01-01T00:00:00.000Z")
      assert.equal(readBack!.changePath, "src/auth")
      assert.equal(readBack!.path, "/tmp/test/reconnaissance.md")
    } finally {
      await removeTempDir(tmpDir)
    }
  })
})

describe("isReconFresh", () => {
  it("returns fresh=false when no cache exists", async () => {
    const cleanDir = await createTempDir()
    try {
      const result = await isReconFresh(undefined, cleanDir)
      assert.equal(result.fresh, false)
      assert.ok(result.reason.includes("No reconnaissance cache"))
    } finally {
      await removeTempDir(cleanDir)
    }
  })

  it("returns fresh=false when reconnaissance file is missing", async () => {
    const testDir = await createTempDir()
    try {
      // Write cache pointing to a file that doesn't exist
      await writeReconCache({
        hash: "test-hash-123",
        generatedAt: "2026-01-01T00:00:00.000Z",
        changePath: null,
        path: path.join(testDir, "reconnaissance.md"),
      }, testDir)

      // Recon file does not exist
      const result = await isReconFresh(undefined, testDir)
      assert.equal(result.fresh, false)
      assert.ok(result.reason.includes("not found"))
    } finally {
      await removeTempDir(testDir)
    }
  })

  it("returns fresh=false when change path does not match cached", async () => {
    const testDir = await createTempDir()
    try {
      // Write cache with one change path
      await writeReconCache({
        hash: "test-hash-456",
        generatedAt: "2026-01-01T00:00:00.000Z",
        changePath: "src/old-area",
        path: path.join(testDir, "reconnaissance.md"),
      }, testDir)

      // Create the recon file so the file-existence check passes
      await fs.writeFile(path.join(testDir, "reconnaissance.md"), "# Reconnaissance", "utf-8")

      // Query with a different change path
      const result = await isReconFresh("src/new-area", testDir)
      assert.equal(result.fresh, false)
      assert.ok(result.reason.includes("Change path mismatch"))
    } finally {
      await removeTempDir(testDir)
    }
  })

  it("returns fresh=true when cache matches and file exists", async () => {
    const testDir = await createTempDir()
    try {
      // Initialize a git repo so hash computation is stable
      initGitRepo(testDir)

      // Create the recon file
      await fs.writeFile(path.join(testDir, "reconnaissance.md"), "# Reconnaissance", "utf-8")

      const { computeRepoStructureHash } = await import(
        "../extensions/zflow-change-workflows/repo-map-cache.js"
      )
      const hash = computeRepoStructureHash(testDir)

      // Write cache with the actual hash
      await writeReconCache({
        hash,
        generatedAt: "2026-01-01T00:00:00.000Z",
        changePath: null,
        path: path.join(testDir, "reconnaissance.md"),
      }, testDir)

      const result = await isReconFresh(undefined, testDir)
      assert.equal(result.fresh, true)
      assert.ok(result.reason.includes("unchanged"))
    } finally {
      await removeTempDir(testDir)
    }
  })
})
