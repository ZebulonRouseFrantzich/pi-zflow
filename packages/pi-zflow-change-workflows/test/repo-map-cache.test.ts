/**
 * repo-map-cache.test.ts — Unit tests for repo-map caching and freshness checks.
 */
import * as assert from "node:assert"
import { describe, it } from "node:test"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import { execFileSync } from "node:child_process"
import * as os from "node:os"

import {
  getRepoMapCachePath,
  readRepoMapCache,
  writeRepoMapCache,
  computeRepoStructureHash,
  isRepoMapFresh,
} from "../extensions/zflow-change-workflows/repo-map-cache.js"
import { resolveRuntimeStateDir } from "pi-zflow-core/runtime-paths"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTempRepo(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-zflow-repomapcache-"))
  execFileSync("git", ["init"], { cwd: tmpDir, stdio: "pipe" })
  execFileSync("git", ["config", "user.email", "test@test"], { cwd: tmpDir, stdio: "pipe" })
  execFileSync("git", ["config", "user.name", "Test"], { cwd: tmpDir, stdio: "pipe" })
  return tmpDir
}

async function makeInitialCommit(tmpDir: string): Promise<void> {
  await fs.writeFile(path.join(tmpDir, "README.md"), "# Test\n", "utf-8")
  execFileSync("git", ["add", "."], { cwd: tmpDir, stdio: "pipe" })
  execFileSync("git", ["commit", "-m", "initial"], { cwd: tmpDir, stdio: "pipe" })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("repo-map-cache", () => {
  describe("getRepoMapCachePath", () => {
    it("returns a path ending with .repo-map-cache.json", () => {
      const p = getRepoMapCachePath()
      assert.ok(p.endsWith(".repo-map-cache.json"), `Path should end with .repo-map-cache.json: ${p}`)
    })
  })

  describe("readRepoMapCache", () => {
    it("returns null when no cache exists", async () => {
      const tmpDir = await createTempRepo()
      const result = await readRepoMapCache(tmpDir)
      assert.strictEqual(result, null)
    })
  })

  describe("writeRepoMapCache and readRepoMapCache", () => {
    it("round-trips cache data correctly", async () => {
      const tmpDir = await createTempRepo()
      await makeInitialCommit(tmpDir)

      const hash = computeRepoStructureHash(tmpDir)
      const cacheData = {
        hash,
        generatedAt: new Date().toISOString(),
        entryCount: 1,
        path: path.join(resolveRuntimeStateDir(tmpDir), "repo-map.md"),
      }

      await writeRepoMapCache(cacheData, tmpDir)
      const readBack = await readRepoMapCache(tmpDir)

      assert.ok(readBack !== null, "Cache should exist after write")
      assert.strictEqual(readBack.hash, cacheData.hash)
      assert.strictEqual(readBack.entryCount, 1)
      assert.strictEqual(readBack.path, cacheData.path)
    })
  })

  describe("computeRepoStructureHash", () => {
    it("returns a non-empty string", () => {
      const hash = computeRepoStructureHash()
      assert.ok(typeof hash === "string", "Hash should be a string")
      assert.ok(hash.length > 0, "Hash should not be empty")
    })

    it("returns consistent results for the same repo state", async () => {
      const tmpDir = await createTempRepo()
      await makeInitialCommit(tmpDir)

      const hash1 = computeRepoStructureHash(tmpDir)
      const hash2 = computeRepoStructureHash(tmpDir)

      assert.strictEqual(hash1, hash2, "Hash should be consistent for the same state")
    })

    it("returns different results when structure changes", async () => {
      const tmpDir = await createTempRepo()
      await makeInitialCommit(tmpDir)

      const hashBefore = computeRepoStructureHash(tmpDir)

      // Add a new file and commit
      await fs.mkdir(path.join(tmpDir, "src"), { recursive: true })
      await fs.writeFile(path.join(tmpDir, "src", "main.ts"), "", "utf-8")
      execFileSync("git", ["add", "."], { cwd: tmpDir, stdio: "pipe" })
      execFileSync("git", ["commit", "-m", "add src/main.ts"], { cwd: tmpDir, stdio: "pipe" })

      const hashAfter = computeRepoStructureHash(tmpDir)

      assert.notStrictEqual(hashBefore, hashAfter, "Hash should change when structure changes")
    })
  })

  describe("isRepoMapFresh", () => {
    it("returns fresh=false when no cache exists", async () => {
      const tmpDir = await createTempRepo()
      const result = await isRepoMapFresh(tmpDir)

      assert.strictEqual(result.fresh, false)
      assert.ok(result.reason.includes("No repo-map cache"))
    })

    it("returns fresh=true when cache matches current state and file exists", async () => {
      const tmpDir = await createTempRepo()
      await makeInitialCommit(tmpDir)

      const runtimeDir = resolveRuntimeStateDir(tmpDir)
      const outputPath = path.join(runtimeDir, "repo-map.md")
      await fs.mkdir(runtimeDir, { recursive: true })
      await fs.writeFile(outputPath, "# test\n", "utf-8")

      const hash = computeRepoStructureHash(tmpDir)
      await writeRepoMapCache({
        hash,
        generatedAt: new Date().toISOString(),
        entryCount: 1,
        path: outputPath,
      }, tmpDir)

      const result = await isRepoMapFresh(tmpDir)

      assert.strictEqual(result.fresh, true, "Cache should be fresh when state matches")
    })

    it("returns fresh=false when repo map file is missing", async () => {
      const tmpDir = await createTempRepo()
      await makeInitialCommit(tmpDir)

      const hash = computeRepoStructureHash(tmpDir)
      const runtimeDir = resolveRuntimeStateDir(tmpDir)
      const outputPath = path.join(runtimeDir, "repo-map.md")

      await writeRepoMapCache({
        hash,
        generatedAt: new Date().toISOString(),
        entryCount: 1,
        path: outputPath,
      }, tmpDir)

      // Don't create repo-map.md — cache path won't exist
      const result = await isRepoMapFresh(tmpDir)

      assert.strictEqual(result.fresh, false)
      assert.ok(result.reason.includes("not found"))
    })

    it("returns fresh=false when hash changes due to new commit", async () => {
      const tmpDir = await createTempRepo()
      await makeInitialCommit(tmpDir)

      const runtimeDir = resolveRuntimeStateDir(tmpDir)
      const outputPath = path.join(runtimeDir, "repo-map.md")
      await fs.mkdir(runtimeDir, { recursive: true })
      await fs.writeFile(outputPath, "# test\n", "utf-8")

      // Write cache with current hash
      const oldHash = computeRepoStructureHash(tmpDir)
      await writeRepoMapCache({
        hash: oldHash,
        generatedAt: new Date().toISOString(),
        entryCount: 1,
        path: outputPath,
      }, tmpDir)

      // Make a new commit to change the hash
      await fs.writeFile(path.join(tmpDir, "new-file.ts"), 'export const x = 1\n', "utf-8")
      execFileSync("git", ["add", "."], { cwd: tmpDir, stdio: "pipe" })
      execFileSync("git", ["commit", "-m", "add new-file.ts"], { cwd: tmpDir, stdio: "pipe" })

      const result = await isRepoMapFresh(tmpDir)

      assert.strictEqual(result.fresh, false)
      assert.ok(result.reason.includes("hash mismatch"))
    })
  })
})
