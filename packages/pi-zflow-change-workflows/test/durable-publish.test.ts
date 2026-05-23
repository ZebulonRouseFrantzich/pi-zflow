/**
 * durable-publish.test.ts — Unit tests for publishPlanArtifacts helper.
 *
 * Validates that plan artifacts are correctly published from runtime state
 * into a durable repo-visible path with a manifest file.
 */
import * as assert from "node:assert"
import { test, describe } from "node:test"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { execFileSync } from "node:child_process"

import { publishPlanArtifacts, resolveChangeImplementTarget } from "../extensions/zflow-change-workflows/orchestration.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Create a temporary directory initialised as a git repo.
 */
async function createTestRepo(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-durable-"))
  execFileSync("git", ["init"], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  await fs.writeFile(path.join(tmpDir, "README.md"), "# Test", "utf-8")
  execFileSync("git", ["add", "."], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  return tmpDir
}

/**
 * Write runtime plan artifacts to simulate what runChangePrepareWorkflow produces.
 */
async function writeRuntimePlanArtifacts(
  runtimeStateDir: string,
  changeId: string,
  planVersion: string,
): Promise<{ versionDir: string; artifactPaths: Record<string, string> }> {
  const versionDir = path.join(runtimeStateDir, "plans", changeId, planVersion)
  await fs.mkdir(versionDir, { recursive: true })

  const content: Record<string, string> = {
    "design.md": "# Design\n\nTest design document.",
    "execution-groups.md": "# Execution Groups\n\nTest execution groups.",
    "standards.md": "# Standards\n\nTest standards document.",
    "verification.md": "# Verification\n\nTest verification plan.",
  }

  const artifactPaths: Record<string, string> = {}
  for (const [fileName, fileContent] of Object.entries(content)) {
    const filePath = path.join(versionDir, fileName)
    await fs.writeFile(filePath, fileContent, "utf-8")
  }
  // Fix: key by artifact key not filename
  const result: Record<string, string> = {
    design: path.join(versionDir, "design.md"),
    executionGroups: path.join(versionDir, "execution-groups.md"),
    standards: path.join(versionDir, "standards.md"),
    verification: path.join(versionDir, "verification.md"),
  }

  return { versionDir, artifactPaths: result }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("publishPlanArtifacts", () => {
  test("publishes four plan artifacts to durable repo path", async () => {
    const repoRoot = await createTestRepo()
    try {
      // Simulate runtime state directory structure
      const runtimeStateDir = path.join(repoRoot, ".git", "pi-zflow")
      const changeId = "test-feature"
      const planVersion = "v1"

      await writeRuntimePlanArtifacts(runtimeStateDir, changeId, planVersion)

      const result = await publishPlanArtifacts(changeId, planVersion, {
        cwd: repoRoot,
        runtimeStateDir,
      })

      // Assert result structure
      assert.equal(result.changeId, changeId)
      assert.equal(result.planVersion, planVersion)
      assert.ok(result.durableDir, "durableDir must be set")
      assert.ok(result.manifestPath, "manifestPath must be set")
      assert.equal(result.artifactCount, 4, "all four artifacts should publish")

      // Assert durable directory exists
      const dirStat = await fs.stat(result.durableDir)
      assert.ok(dirStat.isDirectory(), "durable dir must be a directory")

      // Assert each artifact file exists at published path
      for (const [key, filePath] of Object.entries(result.publishedArtifacts)) {
        assert.ok(filePath, `published path for ${key} must be set`)
        const stat = await fs.stat(filePath)
        assert.ok(stat.isFile(), `published artifact ${key} must be a file`)
      }

      // Assert manifest file exists and is valid JSON
      const manifestRaw = await fs.readFile(result.manifestPath, "utf-8")
      const manifest = JSON.parse(manifestRaw)
      assert.equal(manifest.changeId, changeId)
      assert.equal(manifest.planVersion, planVersion)
      assert.ok(manifest.generatedAt, "manifest must have generatedAt")
      assert.ok(manifest.sourceRuntimePath, "manifest must have sourceRuntimePath")
      assert.ok(manifest.note, "manifest must have a note")
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })

  test("publishes to custom repo relative path", async () => {
    const repoRoot = await createTestRepo()
    try {
      const runtimeStateDir = path.join(repoRoot, ".git", "pi-zflow")
      const changeId = "test-custom"
      const planVersion = "v2"

      await writeRuntimePlanArtifacts(runtimeStateDir, changeId, planVersion)

      const customDir = "plans/archive"
      const result = await publishPlanArtifacts(changeId, planVersion, {
        cwd: repoRoot,
        runtimeStateDir,
        repoRelativeDir: customDir,
      })

      assert.ok(result.durableDir.includes(customDir), "durable dir should use custom path")
      assert.ok(result.durableDir.includes(changeId), "durable dir should contain changeId")
      assert.equal(result.artifactCount, 4)
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })

  test("reports missing artifacts as errors", async () => {
    const repoRoot = await createTestRepo()
    try {
      const runtimeStateDir = path.join(repoRoot, ".git", "pi-zflow")
      const changeId = "test-missing"
      const planVersion = "v1"

      // Write only some artifacts
      const versionDir = path.join(runtimeStateDir, "plans", changeId, planVersion)
      await fs.mkdir(versionDir, { recursive: true })
      await fs.writeFile(path.join(versionDir, "design.md"), "# Design", "utf-8")
      // Do not write the other three

      const result = await publishPlanArtifacts(changeId, planVersion, {
        cwd: repoRoot,
        runtimeStateDir,
      })

      assert.ok(result.errors.length > 0, "should report missing artifact errors")
      assert.ok(
        result.errors.some((e) => e.includes("execution-groups")),
        "should mention missing execution-groups",
      )
      // The design file should still publish
      assert.ok(result.publishedArtifacts.design, "design should still publish")
      assert.equal(result.artifactCount, 1, "only one artifact should publish")
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })

  test("manifest references correct source and review paths", async () => {
    const repoRoot = await createTestRepo()
    try {
      const runtimeStateDir = path.join(repoRoot, ".git", "pi-zflow")
      const changeId = "test-manifest-refs"
      const planVersion = "v1"

      await writeRuntimePlanArtifacts(runtimeStateDir, changeId, planVersion)

      const result = await publishPlanArtifacts(changeId, planVersion, {
        cwd: repoRoot,
        runtimeStateDir,
      })

      const manifestRaw = await fs.readFile(result.manifestPath, "utf-8")
      const manifest = JSON.parse(manifestRaw)

      // Source runtime path should point to the plans directory
      assert.ok(
        manifest.sourceRuntimePath.includes(changeId),
        "sourceRuntimePath should reference the change",
      )
      // Source artifacts should be absolute paths
      for (const sourcePath of Object.values(manifest.sourceArtifacts)) {
        assert.ok(typeof sourcePath === "string", "source artifact path must be a string")
      }
      // Note should mention .git/pi-zflow
      assert.ok(
        manifest.note.includes(".git/pi-zflow"),
        "manifest note should reference runtime state dir",
      )
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })

  test("resolveChangeImplementTarget maps durable docs path to previous runtime change id", async () => {
    const repoRoot = await createTestRepo()
    try {
      const runtimeStateDir = path.join(repoRoot, ".git", "pi-zflow")
      const runtimeChangeId = "docs-change-ideas-cl-mphn61g6"
      const durableChangeId = "cloudflare-target-architecture"
      const planVersion = "v1"

      await writeRuntimePlanArtifacts(runtimeStateDir, runtimeChangeId, planVersion)
      await fs.writeFile(
        path.join(runtimeStateDir, "plans", runtimeChangeId, "plan-state.json"),
        JSON.stringify({ changeId: runtimeChangeId, approvedVersion: planVersion }, null, 2),
        "utf-8",
      )

      const result = await publishPlanArtifacts(runtimeChangeId, planVersion, {
        cwd: repoRoot,
        runtimeStateDir,
      })
      const durableDir = path.join(repoRoot, "docs", "zflow-changes", durableChangeId, planVersion)
      await fs.mkdir(path.dirname(durableDir), { recursive: true })
      await fs.rename(result.durableDir, durableDir)
      await fs.rm(path.dirname(result.durableDir), { recursive: true, force: true })
      const manifestPath = path.join(durableDir, "manifest.json")
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"))
      manifest.changeId = durableChangeId
      manifest.previousRuntimeChangeId = runtimeChangeId
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8")

      const fromChangeDir = await resolveChangeImplementTarget(`@docs/zflow-changes/${durableChangeId}/`, repoRoot)
      assert.equal(fromChangeDir.changeId, runtimeChangeId)
      assert.equal(fromChangeDir.durableChangeId, durableChangeId)

      const fromVersionDir = await resolveChangeImplementTarget(`docs/zflow-changes/${durableChangeId}/${planVersion}/`, repoRoot)
      assert.equal(fromVersionDir.changeId, runtimeChangeId)
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })
})
