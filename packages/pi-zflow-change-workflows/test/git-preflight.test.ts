/**
 * git-preflight.test.ts — Unit tests for Task 5.1 preflight logic.
 *
 * Tests run against the actual git repository of pi-zflow (cwd is the repo root).
 * We use `git status --porcelain` and helper git commands to set up and verify
 * preflight conditions in a dedicated temporary git repo so we don't pollute
 * the actual pi-zflow working tree.
 */
import * as assert from "node:assert"
import { test, describe, before, after, afterEach } from "node:test"
import * as path from "node:path"
import * as fsSync from "node:fs"
import * as fs from "node:fs/promises"
import { execFileSync } from "node:child_process"
import * as os from "node:os"

import {
  gitPorcelain,
  getCurrentBranch,
  getHeadSha,
  assertCleanPrimaryTree,
  resolveRepoRoot,
} from "../extensions/zflow-change-workflows/git-preflight.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a temporary git repository for testing.
 * Returns the absolute path to the repo root.
 */
async function createTempRepo(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-zflow-test-"))
  execFileSync("git", ["init"], { cwd: tmpDir, stdio: "pipe" })
  execFileSync("git", ["config", "user.email", "test@test"], { cwd: tmpDir, stdio: "pipe" })
  execFileSync("git", ["config", "user.name", "Test"], { cwd: tmpDir, stdio: "pipe" })
  // Create an initial commit so HEAD resolves to a branch
  fsSync.writeFileSync(path.join(tmpDir, ".gitkeep"), "", "utf-8")
  execFileSync("git", ["add", ".gitkeep"], { cwd: tmpDir, stdio: "pipe" })
  execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: tmpDir, stdio: "pipe" })
  return tmpDir
}

/**
 * Create a file in the temp repo, add it, and commit it.
 */
function commitFile(repoRoot: string, relativePath: string, content: string): void {
  const fullPath = path.join(repoRoot, relativePath)
  execFileSync("mkdir", ["-p", path.dirname(fullPath)], { stdio: "pipe" })
  fsSync.writeFileSync(fullPath, content, "utf-8")
  execFileSync("git", ["add", relativePath], { cwd: repoRoot, stdio: "pipe" })
  execFileSync("git", ["commit", "-m", `Add ${relativePath}`], { cwd: repoRoot, stdio: "pipe" })
}

/**
 * Create a file without staging it (untracked).
 */
function createUntrackedFile(repoRoot: string, relativePath: string, content: string): void {
  const fullPath = path.join(repoRoot, relativePath)
  execFileSync("mkdir", ["-p", path.dirname(fullPath)], { stdio: "pipe" })
  fsSync.writeFileSync(fullPath, content, "utf-8")
}

/**
 * Modify a tracked file without staging (unstaged tracked change).
 */
function modifyTrackedFile(repoRoot: string, relativePath: string, content: string): void {
  const fullPath = path.join(repoRoot, relativePath)
  fsSync.writeFileSync(fullPath, content, "utf-8")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("gitPorcelain", () => {
  let repoRoot: string

  before(async () => {
    repoRoot = await createTempRepo()
    // Create a base commit with a tracked file
    commitFile(repoRoot, "README.md", "# Test Repo")
    commitFile(repoRoot, "src/main.ts", 'console.log("hello")')
  })

  afterEach(() => {
    // Reset the repo to a clean state after every test
    execFileSync("git", ["checkout", "--", "."], { cwd: repoRoot, stdio: "pipe" })
    execFileSync("git", ["clean", "-fd"], { cwd: repoRoot, stdio: "pipe" })
  })

  test("returns empty result for clean tree", () => {
    const result = gitPorcelain(repoRoot)
    assert.deepEqual(result.trackedChanges, [])
    assert.deepEqual(result.untracked, [])
    assert.ok(Array.isArray(result.raw))
  })

  test("detects an untracked file", () => {
    createUntrackedFile(repoRoot, "untracked.txt", "I am untracked")
    const result = gitPorcelain(repoRoot)
    assert.ok(result.untracked.includes("untracked.txt"))
    assert.deepEqual(result.trackedChanges, [])
  })

  test("detects a tracked change (unstaged)", () => {
    modifyTrackedFile(repoRoot, "README.md", "# Modified content")
    const result = gitPorcelain(repoRoot)
    assert.ok(result.trackedChanges.length > 0)
    assert.ok(result.trackedChanges.some((f) => f.includes("README.md")))
  })

  test("handles multiple untracked files", () => {
    createUntrackedFile(repoRoot, "a.ts", "a")
    createUntrackedFile(repoRoot, "b.ts", "b")
    createUntrackedFile(repoRoot, "nested/c.ts", "c")

    const result = gitPorcelain(repoRoot)
    assert.ok(result.untracked.includes("a.ts"))
    assert.ok(result.untracked.includes("b.ts"))
    // Untracked directories are shown as "nested/" in porcelain output
    assert.ok(result.untracked.some((f) => f.startsWith("nested")), `Expected nested/, got: ${JSON.stringify(result.untracked)}`)
  })

  test("handles empty repo (only initial commit)", () => {
    // Already clean after previous cleanup
    const result = gitPorcelain(repoRoot)
    assert.deepEqual(result.trackedChanges, [])
    assert.deepEqual(result.untracked, [])
  })
})

describe("getCurrentBranch", () => {
  let repoRoot: string

  before(async () => {
    repoRoot = await createTempRepo()
  })

  test("returns 'master' or 'main' for default branch", () => {
    const branch = getCurrentBranch(repoRoot)
    // GitHub changed default to 'main', but 'git init' may use 'master'
    assert.ok(branch === "master" || branch === "main", `Expected master or main, got: ${branch}`)
  })

  test("returns branch name after checkout", () => {
    execFileSync("git", ["checkout", "-b", "feature/test"], { cwd: repoRoot, stdio: "pipe" })
    const branch = getCurrentBranch(repoRoot)
    assert.equal(branch, "feature/test")

    // Switch back
    execFileSync("git", ["checkout", "-"], { cwd: repoRoot, stdio: "pipe" })
  })
})

describe("getHeadSha", () => {
  let repoRoot: string

  before(async () => {
    repoRoot = await createTempRepo()
    commitFile(repoRoot, "README.md", "# Hello")
  })

  test("returns a 40-character (full) sha", () => {
    const sha = getHeadSha(repoRoot)
    assert.equal(sha.length, 40, `Expected 40-char sha, got ${sha.length}: ${sha}`)
    assert.ok(/^[0-9a-f]+$/.test(sha), `Expected hex string, got: ${sha}`)
  })

  test("sha changes after a commit", () => {
    const beforeSha = getHeadSha(repoRoot)
    commitFile(repoRoot, "NEW.md", "# New file")
    const afterSha = getHeadSha(repoRoot)
    assert.notEqual(beforeSha, afterSha)
  })
})

describe("assertCleanPrimaryTree", () => {
  let repoRoot: string

  before(async () => {
    repoRoot = await createTempRepo()
    commitFile(repoRoot, "README.md", "# Test")
    commitFile(repoRoot, "src/foo.ts", 'export const foo = 1')
  })

  afterEach(() => {
    execFileSync("git", ["checkout", "--", "."], { cwd: repoRoot, stdio: "pipe" })
    execFileSync("git", ["clean", "-fd"], { cwd: repoRoot, stdio: "pipe" })
  })

  test("returns clean=true for clean tree with no planned paths", () => {
    const result = assertCleanPrimaryTree(repoRoot, new Set())
    assert.equal(result.clean, true)
    assert.deepEqual(result.trackedChanges, [])
    assert.deepEqual(result.overlappingUntracked, [])
    assert.ok(result.branch.length > 0)
    assert.equal(result.headSha.length, 40)
  })

  test("returns clean=true for clean tree with non-overlapping planned paths", () => {
    const result = assertCleanPrimaryTree(repoRoot, new Set(["src/new-file.ts", "docs/guide.md"]))
    assert.equal(result.clean, true)
    assert.deepEqual(result.overlappingUntracked, [])
  })

  test("returns clean=false when tree has tracked changes", () => {
    modifyTrackedFile(repoRoot, "README.md", "# Dirty")
    const result = assertCleanPrimaryTree(repoRoot, new Set())
    assert.equal(result.clean, false)
    assert.ok(result.trackedChanges.length > 0)
    assert.ok(result.summary.includes("tracked change"))
    assert.ok(result.summary.includes(result.branch))
    assert.ok(result.summary.includes(result.headSha.slice(0, 12)))
  })

  test("returns clean=false when untracked files overlap planned paths", () => {
    createUntrackedFile(repoRoot, "src/conflict.ts", "overlapping")
    const result = assertCleanPrimaryTree(repoRoot, new Set(["src/conflict.ts"]))
    assert.equal(result.clean, false)
    assert.ok(result.overlappingUntracked.includes("src/conflict.ts"))
    assert.ok(result.summary.includes("overlap"))
  })

  test("returns clean=false with multiple overlapping untracked files", () => {
    createUntrackedFile(repoRoot, "a.ts", "a")
    createUntrackedFile(repoRoot, "b.ts", "b")
    const result = assertCleanPrimaryTree(repoRoot, new Set(["a.ts", "b.ts", "c.ts"]))
    assert.equal(result.clean, false)
    assert.equal(result.overlappingUntracked.length, 2)
    assert.ok(result.overlappingUntracked.includes("a.ts"))
    assert.ok(result.overlappingUntracked.includes("b.ts"))
  })

  test("ignores untracked files that are not in planned paths", () => {
    createUntrackedFile(repoRoot, "scratch.txt", "noise")
    createUntrackedFile(repoRoot, "notes.md", "notes")
    const result = assertCleanPrimaryTree(repoRoot, new Set(["src/foo.ts"]))
    assert.equal(result.clean, true, "should be clean when untracked files don't overlap planned paths")
    assert.equal(result.untracked.length, 2, "should report untracked files even when clean")
    assert.deepEqual(result.overlappingUntracked, [])
  })
})

describe("resolveRepoRoot", () => {
  test("resolves the current directory's repo root", () => {
    const root = resolveRepoRoot()
    // Assert structural properties rather than a specific directory name:
    // the repo root must be absolute and contain a .git entry.
    assert.ok(path.isAbsolute(root), `repo root must be absolute, got: ${root}`)
    assert.ok(fsSync.existsSync(path.join(root, ".git")), `repo root must contain .git, got: ${root}`)
    assert.ok(root.length > 0, "repo root must be a non-empty path")
  })

  test("resolves a specific directory's repo root", () => {
    // The test temp dirs we create are also git repos
    const root = resolveRepoRoot(process.cwd())
    assert.ok(root.length > 0)
  })
})

describe("GitPorcelainResult structure", () => {
  let repoRoot: string

  before(async () => {
    repoRoot = await createTempRepo()
    commitFile(repoRoot, "README.md", "# Test")
  })

  test("all fields are present with correct types", () => {
    const result = gitPorcelain(repoRoot)
    assert.ok(Array.isArray(result.trackedChanges))
    assert.ok(Array.isArray(result.untracked))
    assert.ok(Array.isArray(result.raw))
    // All items in trackedChanges and untracked should be strings
    for (const f of result.trackedChanges) assert.equal(typeof f, "string")
    for (const f of result.untracked) assert.equal(typeof f, "string")
  })
})

describe("GitPreflightResult structure", () => {
  let repoRoot: string

  before(async () => {
    repoRoot = await createTempRepo()
    commitFile(repoRoot, "README.md", "# Test")
  })

  afterEach(() => {
    execFileSync("git", ["checkout", "--", "."], { cwd: repoRoot, stdio: "pipe" })
    execFileSync("git", ["clean", "-fd"], { cwd: repoRoot, stdio: "pipe" })
  })

  test("result has all required fields for clean case", () => {
    const result = assertCleanPrimaryTree(repoRoot, new Set())
    assert.equal(typeof result.clean, "boolean")
    assert.equal(typeof result.branch, "string")
    assert.equal(typeof result.headSha, "string")
    assert.ok(Array.isArray(result.trackedChanges))
    assert.ok(Array.isArray(result.untracked))
    assert.ok(Array.isArray(result.overlappingUntracked))
    assert.equal(typeof result.summary, "string")
    assert.equal(result.clean, true)
    assert.equal(result.trackedChanges.length, 0)
  })

  test("result has all required fields for dirty case", () => {
    createUntrackedFile(repoRoot, "dirty.ts", "conflict")
    const result = assertCleanPrimaryTree(repoRoot, new Set(["dirty.ts"]))
    assert.equal(result.clean, false)
    assert.equal(typeof result.branch, "string")
    assert.equal(typeof result.headSha, "string")
    assert.equal(result.overlappingUntracked.length, 1)
    assert.ok(result.summary.length > 0)
  })
})
