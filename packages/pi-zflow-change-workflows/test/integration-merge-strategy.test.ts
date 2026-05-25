/**
 * integration-merge-strategy.test.ts — Unit tests for integration-merge-strategy.ts.
 */
import * as assert from "node:assert"
import { test, describe, before, after } from "node:test"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import * as fsSync from "node:fs"
import { execFileSync } from "node:child_process"
import * as os from "node:os"

import {
  runIntegrationMerge,
} from "../extensions/zflow-change-workflows/integration-merge-strategy.js"

import type {
  IntegrationMergeConfig,
  IntegrationMergeResult,
} from "../extensions/zflow-change-workflows/integration-merge-strategy.js"

import type { PreApplySnapshot } from "pi-zflow-artifacts/run-state"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTempRepo(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-zflow-int-"))
  execFileSync("git", ["init"], { cwd: tmpDir, stdio: "pipe" })
  execFileSync("git", ["config", "user.email", "test@test"], { cwd: tmpDir, stdio: "pipe" })
  execFileSync("git", ["config", "user.name", "Test"], { cwd: tmpDir, stdio: "pipe" })
  return tmpDir
}

function writeFile(repoRoot: string, filePath: string, content: string): void {
  const fullPath = path.join(repoRoot, filePath)
  fsSync.mkdirSync(path.dirname(fullPath), { recursive: true })
  fsSync.writeFileSync(fullPath, content, "utf-8")
}

function gitAddCommit(repoRoot: string, message: string): string {
  execFileSync("git", ["add", "-A"], { cwd: repoRoot, stdio: "pipe" })
  execFileSync("git", ["commit", "-m", message], { cwd: repoRoot, stdio: "pipe" })
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot, encoding: "utf-8",
  }).trim()
}

function createPatch(repoRoot: string, baseCommit: string, patchPath: string): void {
  const diff = execFileSync("git", ["diff", baseCommit, "HEAD", "--binary"], {
    cwd: repoRoot, encoding: "utf-8",
  })
  fsSync.mkdirSync(path.dirname(patchPath), { recursive: true })
  fsSync.writeFileSync(patchPath, diff, "utf-8")
}

// ---------------------------------------------------------------------------
// runIntegrationMerge
// ---------------------------------------------------------------------------

describe("runIntegrationMerge", () => {
  test("merges non-overlapping patches successfully", async () => {
    const repo = await createTempRepo()
    writeFile(repo, "README.md", "# Base\n")
    writeFile(repo, "src/main.ts", 'console.log("base")\n')
    const baseCommit = gitAddCommit(repo, "initial")

    // Create patches directory
    const patchesDir = path.join(repo, "patches")
    fsSync.mkdirSync(patchesDir, { recursive: true })

    // Group 1: modify main.ts
    writeFile(repo, "src/main.ts", 'console.log("g1-edited")\n')
    gitAddCommit(repo, "g1")
    const patch1 = path.join(patchesDir, "group-1.patch")
    createPatch(repo, baseCommit, patch1)

    // Group 2: modify README.md
    execFileSync("git", ["reset", "--hard", baseCommit], { cwd: repo, stdio: "pipe" })
    writeFile(repo, "README.md", "# Base\n\nGroup 2 change\n")
    gitAddCommit(repo, "g2")
    const patch2 = path.join(patchesDir, "group-2.patch")
    createPatch(repo, baseCommit, patch2)

    // Reset to base
    execFileSync("git", ["reset", "--hard", baseCommit], { cwd: repo, stdio: "pipe" })

    const snapshot: PreApplySnapshot = {
      head: baseCommit,
      indexState: "clean",
      recoveryRef: "refs/zflow/recovery/test-int",
    }

    const groups = [
      { id: "group-1", files: ["src/main.ts"], dependencies: [], parallelizable: true },
      { id: "group-2", files: ["README.md"], dependencies: [], parallelizable: true },
    ]

    const patches = new Map<string, string>([
      ["group-1", patch1],
      ["group-2", patch2],
    ])

    const config: IntegrationMergeConfig = {
      runId: "test-int-merge",
      repoRoot: repo,
      snapshot,
      groups,
      patches,
    }

    const result = await runIntegrationMerge(config)
    assert.equal(result.success, true, "integration merge should succeed: " + (result.error ?? ""))
    assert.ok(result.consolidatedPatchPath, "should produce consolidated patch")
    assert.ok(fsSync.existsSync(result.consolidatedPatchPath!), "consolidated patch should exist")

    // Verify the consolidated patch contains both changes
    const consolidatedDiff = fsSync.readFileSync(result.consolidatedPatchPath!, "utf-8")
    assert.ok(consolidatedDiff.includes("g1-edited"), "should contain group-1 change")
    assert.ok(consolidatedDiff.includes("Group 2 change"), "should contain group-2 change")

    // Cleanup worktree
    execFileSync("git", ["worktree", "remove", "--force", result.integrationWorktreePath], {
      cwd: repo, stdio: ["ignore", "pipe", "pipe"],
    })

    await fs.rm(repo, { recursive: true, force: true })
  })

  test("reports failure for invalid patches", async () => {
    const repo = await createTempRepo()
    writeFile(repo, "README.md", "# Base\n")
    const baseCommit = gitAddCommit(repo, "initial")

    const patchesDir = path.join(repo, "patches")
    fsSync.mkdirSync(patchesDir, { recursive: true })

    // Write invalid patch
    fsSync.writeFileSync(path.join(patchesDir, "group-1.patch"), "not a real patch", "utf-8")

    const snapshot: PreApplySnapshot = {
      head: baseCommit,
      indexState: "clean",
      recoveryRef: "refs/zflow/recovery/test-int-fail",
    }

    const groups = [
      { id: "group-1", files: ["src/main.ts"], dependencies: [], parallelizable: true },
    ]

    const patches = new Map<string, string>([
      ["group-1", path.join(patchesDir, "group-1.patch")],
    ])

    const config: IntegrationMergeConfig = {
      runId: "test-int-fail",
      repoRoot: repo,
      snapshot,
      groups,
      patches,
    }

    const result = await runIntegrationMerge(config)

    // Should fail since the patch is invalid
    assert.equal(result.success, false, "should fail with invalid patch")
    assert.ok(result.failingGroup, "should identify failing group")

    // Cleanup worktree if it was created
    if (result.integrationWorktreePath) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", result.integrationWorktreePath], {
          cwd: repo, stdio: ["ignore", "pipe", "pipe"],
        })
      } catch {
        // Already cleaned up
      }
    }

    await fs.rm(repo, { recursive: true, force: true })
  })

  test("returns resolvableByAgent true on failure", async () => {
    const repo = await createTempRepo()
    writeFile(repo, "README.md", "# Base\n")
    const baseCommit = gitAddCommit(repo, "initial")

    const patchesDir = path.join(repo, "patches")
    fsSync.mkdirSync(patchesDir, { recursive: true })
    fsSync.writeFileSync(path.join(patchesDir, "group-1.patch"), "invalid", "utf-8")

    const snapshot: PreApplySnapshot = {
      head: baseCommit,
      indexState: "clean",
      recoveryRef: "refs/zflow/recovery/test-int-resolvable",
    }

    const groups = [
      { id: "group-1", files: ["README.md"], dependencies: [], parallelizable: true },
    ]

    const patches = new Map<string, string>([
      ["group-1", path.join(patchesDir, "group-1.patch")],
    ])

    const config: IntegrationMergeConfig = {
      runId: "test-int-resolvable",
      repoRoot: repo,
      snapshot,
      groups,
      patches,
    }

    const result = await runIntegrationMerge(config)
    assert.equal(result.success, false)
    // Integration merge failures should be resolvable by an agent
    assert.equal(result.resolvableByAgent, true, "merge failures should be agent-resolvable")

    if (result.integrationWorktreePath) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", result.integrationWorktreePath], {
          cwd: repo, stdio: ["ignore", "pipe", "pipe"],
        })
      } catch {
        // ignore
      }
    }

    await fs.rm(repo, { recursive: true, force: true })
  })
})
