/**
 * Regression tests for patch capture integrity in pi-zflow-subagents-bridge.
 *
 * Covers the class of bug where a patch's final hunk ends with trailing blank
 * context lines and the capture/serialization removes them, producing a corrupt
 * patch that fails to apply.
 *
 * Both capture paths are tested:
 *   - writePatchFromRange — direct range patch capture (git diff --binary base HEAD)
 *   - captureCompatPatchAgainstBase — compat staged patch capture (git diff --cached --binary base)
 *
 * Tests are self-contained using temporary git repositories.
 */
import { test, describe, beforeEach, afterEach } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { execFileSync } from "node:child_process"

import {
  writePatchFromRange,
  captureCompatPatchAgainstBase,
  validatePatchFile,
} from "../extensions/zflow-subagents-bridge/index.js"

// ── Test helpers ──────────────────────────────────────────────────

interface TestRepo {
  root: string
  cleanup: () => void
}

function createTestRepo(): TestRepo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zflow-patch-bctest-"))
  execFileSync("git", ["init"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
  return {
    root,
    cleanup: () => { fs.rmSync(root, { recursive: true, force: true }) },
  }
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  })
}

function commitAll(repoRoot: string, message: string): string {
  git(repoRoot, ["add", "-A"])
  git(repoRoot, ["commit", "-m", message])
  return git(repoRoot, ["rev-parse", "HEAD"]).trim()
}

function writeTextFile(repoRoot: string, relativePath: string, content: string): void {
  const fullPath = path.join(repoRoot, relativePath)
  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  fs.writeFileSync(fullPath, content, "utf-8")
}

function readTextFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8")
}

// ── Test scenario ────────────────────────────────────────────────
//
// Reproduce the actual corruption shape: the final hunk ends with a blank
// context line that must be preserved. Put the modified line late enough in
// the file that git's default trailing context includes the following blank
// line(s).
//
// Content:
//   intro-1
//   intro-2
//   keep-1
//   keep-2
//   keep-3
//   target-line   ← modified
//                ← blank context line
//   next-section  ← trailing context line

const INITIAL_CONTENT = "intro-1\nintro-2\nkeep-1\nkeep-2\nkeep-3\ntarget-line\n\nnext-section\n"
const MODIFIED_CONTENT = "intro-1\nintro-2\nkeep-1\nkeep-2\nkeep-3\nTARGET-LINE-MODIFIED\n\nnext-section\n"

function assertFileContainsBlankContextLines(
  patchContent: string,
  expectedMin: number,
  label: string,
): void {
  const lines = patchContent.split("\n")
  const blankContextLines = lines.filter(
    (l) => l.startsWith(" ") && l.trim() === "",
  )
  assert.ok(
    blankContextLines.length >= expectedMin,
    `${label}: expected at least ${expectedMin} blank context lines, got ${blankContextLines.length}\n` +
      `First 400 chars of patch:\n${patchContent.slice(0, 400)}`,
  )
}

// ── Tests: writePatchFromRange ────────────────────────────────────

describe("writePatchFromRange — blank-context regression", () => {
  let repo: TestRepo
  let baseCommit: string
  let patchDir: string
  let patchPath: string

  beforeEach(() => {
    repo = createTestRepo()
    patchDir = fs.mkdtempSync(path.join(os.tmpdir(), "zflow-patch-out-"))
    patchPath = path.join(patchDir, "captured.patch")
  })

  afterEach(() => {
    repo.cleanup()
    try { fs.rmSync(patchDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  test("captures patch with trailing blank context that passes git apply --check", () => {
    writeTextFile(repo.root, "test.txt", INITIAL_CONTENT)
    baseCommit = commitAll(repo.root, "initial commit with trailing blank lines")

    writeTextFile(repo.root, "test.txt", MODIFIED_CONTENT)
    commitAll(repo.root, "modify line2 with trailing blanks unchanged")

    const result = writePatchFromRange(repo.root, patchPath, baseCommit)

    assert.ok(fs.existsSync(patchPath), "patch file should exist after capture")
    const patchContent = readTextFile(patchPath)
    assert.ok(patchContent.length > 0, "patch file should not be empty")
    assert.ok(result.changedFiles.includes("test.txt"), "changedFiles should include test.txt")
    assert.ok(result.headCommit, "headCommit should be non-empty")

    // validatePatchFile is already called internally; verify it works independently
    validatePatchFile(repo.root, patchPath, baseCommit)

    // Also verify with bare git apply --cached --check --binary
    const tmpIndex = path.join(os.tmpdir(), `zflow-verify-${Date.now()}`)
    try {
      execFileSync("git", ["read-tree", "--reset", baseCommit], {
        cwd: repo.root,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_INDEX_FILE: tmpIndex },
      })
      execFileSync("git", ["apply", "--cached", "--check", "--binary", patchPath], {
        cwd: repo.root,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_INDEX_FILE: tmpIndex },
      })
    } finally {
      try { fs.unlinkSync(tmpIndex) } catch { /* ignore */ }
    }
  })

  test("patch serialization preserves trailing blank context lines", () => {
    writeTextFile(repo.root, "test.txt", INITIAL_CONTENT)
    baseCommit = commitAll(repo.root, "initial")

    writeTextFile(repo.root, "test.txt", MODIFIED_CONTENT)
    commitAll(repo.root, "modify")

    writePatchFromRange(repo.root, patchPath, baseCommit)

    const patchContent = readTextFile(patchPath)
    assertFileContainsBlankContextLines(
      patchContent,
      1,
      "writePatchFromRange with blank trailing context",
    )

    validatePatchFile(repo.root, patchPath, baseCommit)
  })
})

// ── Tests: captureCompatPatchAgainstBase ──────────────────────────

describe("captureCompatPatchAgainstBase — blank-context regression", () => {
  let repo: TestRepo
  let baseCommit: string
  let patchDir: string
  let patchPath: string

  beforeEach(() => {
    repo = createTestRepo()
    patchDir = fs.mkdtempSync(path.join(os.tmpdir(), "zflow-patch-comp-"))
    patchPath = path.join(patchDir, "compat-captured.patch")
  })

  afterEach(() => {
    repo.cleanup()
    try { fs.rmSync(patchDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  test("captures staged patch with trailing blank context that passes git apply --check", () => {
    writeTextFile(repo.root, "data.txt", INITIAL_CONTENT)
    baseCommit = commitAll(repo.root, "initial")

    writeTextFile(repo.root, "data.txt", MODIFIED_CONTENT)

    const result = captureCompatPatchAgainstBase(repo.root, baseCommit, patchPath)

    assert.ok(fs.existsSync(patchPath), "patch file should exist after compat capture")
    const patchContent = readTextFile(patchPath)
    assert.ok(patchContent.length > 0, "patch file should not be empty")
    assert.ok(result.changedFiles.includes("data.txt"), "changedFiles should include data.txt")
    assert.ok(result.headCommit, "headCommit should be non-empty")

    validatePatchFile(repo.root, patchPath, baseCommit)
  })

  test("compat capture preserves trailing blank context lines in serialized patch", () => {
    writeTextFile(repo.root, "data.txt", INITIAL_CONTENT)
    baseCommit = commitAll(repo.root, "initial")

    writeTextFile(repo.root, "data.txt", MODIFIED_CONTENT)

    captureCompatPatchAgainstBase(repo.root, baseCommit, patchPath)

    const patchContent = readTextFile(patchPath)
    assertFileContainsBlankContextLines(
      patchContent,
      1,
      "captureCompatPatchAgainstBase with blank trailing context",
    )

    validatePatchFile(repo.root, patchPath, baseCommit)
  })
})

// ── Edge-case scenarios ───────────────────────────────────────────

describe("blank-context patch — edge cases", () => {
  let repo: TestRepo

  beforeEach(() => {
    repo = createTestRepo()
  })

  afterEach(() => {
    repo.cleanup()
  })

  test("adding content with an internal blank context line from a tracked base file produces a valid patch", () => {
    writeTextFile(repo.root, "blank.txt", "header\nseed\n\nfooter\n")
    const baseCommit = commitAll(repo.root, "initial tracked file")

    writeTextFile(repo.root, "blank.txt", "header\nSEED-MODIFIED\n\nfooter\n")
    commitAll(repo.root, "modify tracked file with internal blank context")

    const patchDir = fs.mkdtempSync(path.join(os.tmpdir(), "zflow-patch-edge-"))
    const patchPath = path.join(patchDir, "edge.patch")
    try {
      const result = writePatchFromRange(repo.root, patchPath, baseCommit)
      assert.ok(result.changedFiles.includes("blank.txt"))
      validatePatchFile(repo.root, patchPath, baseCommit)
    } finally {
      fs.rmSync(patchDir, { recursive: true, force: true })
    }
  })

  test("multiple files with internal blank context lines produce a valid combined patch", () => {
    writeTextFile(repo.root, "a.txt", "a1\na2\n\na4\n")
    writeTextFile(repo.root, "b.txt", "b1\nb2\n\nb4\n")
    const baseCommit = commitAll(repo.root, "initial tracked files")

    writeTextFile(repo.root, "a.txt", "a1\nA2-MODIFIED\n\na4\n")
    writeTextFile(repo.root, "b.txt", "b1\nB2-MODIFIED\n\nb4\n")
    commitAll(repo.root, "modify tracked files with internal blank context")

    const patchDir = fs.mkdtempSync(path.join(os.tmpdir(), "zflow-patch-multi-"))
    const patchPath = path.join(patchDir, "multi.patch")
    try {
      const result = writePatchFromRange(repo.root, patchPath, baseCommit)
      assert.ok(result.changedFiles.length >= 2, "should have at least 2 changed files")
      assert.ok(result.changedFiles.includes("a.txt"), "a.txt in changed files")
      assert.ok(result.changedFiles.includes("b.txt"), "b.txt in changed files")
      validatePatchFile(repo.root, patchPath, baseCommit)
    } finally {
      fs.rmSync(patchDir, { recursive: true, force: true })
    }
  })
})
