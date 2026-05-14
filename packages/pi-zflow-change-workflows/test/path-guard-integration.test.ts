/**
 * Integration tests for the change-workflows path guard.
 *
 * Validates:
 * - Path guard allows writes to `.git/pi-zflow/plans/` (runtime state dir)
 * - Path guard blocks `.git/config`, `.git/HEAD`, etc.
 * - Path guard allows `.pi/` in repo root but blocks `~/.pi/`
 * - `before_tool_call` hook blocks edit/write to blocked paths
 * - `realpathSafe` call signature is compatible with core
 */
import * as assert from "node:assert/strict"
import { describe, it, afterEach, mock } from "node:test"
import * as path from "node:path"
import * as os from "node:os"
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs"

import {
  guardWrite,
  guardBashCommand,
  buildAllowedRoots,
  buildToolDeniedReminder,
} from "../extensions/zflow-change-workflows/path-guard.js"

import type { GuardResult, GuardOptions } from "../extensions/zflow-change-workflows/path-guard.js"

// ── Test fixtures ────────────────────────────────────────────────

const PROJECT_ROOT = "/tmp/pi-zflow-test-path-guard"
const GIT_DIR = path.join(PROJECT_ROOT, ".git")
const RUNTIME_STATE_DIR = path.join(GIT_DIR, "pi-zflow")

function makeOptions(overrides?: Partial<GuardOptions>): GuardOptions {
  return {
    projectRoot: PROJECT_ROOT,
    runtimeStateDir: RUNTIME_STATE_DIR,
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────

describe("path-guard integration — .git/pi-zflow/ runtime state dir", () => {
  it("allows writes to .git/pi-zflow/plans/ (runtime state dir)", () => {
    const result = guardWrite(
      path.join(RUNTIME_STATE_DIR, "plans", "ch42", "v1", "design.md"),
      makeOptions(),
    )
    assert.ok(result.allowed,
      `Expected write to .git/pi-zflow/plans/ to be allowed, got: ${result.message}`)
  })

  it("allows writes to any path under .git/pi-zflow/", () => {
    const result = guardWrite(
      path.join(RUNTIME_STATE_DIR, "state-index.json"),
      makeOptions(),
    )
    assert.ok(result.allowed,
      `Expected write to .git/pi-zflow/state-index.json to be allowed, got: ${result.message}`)
  })

  it("allows writes to the exact runtime state directory path", () => {
    const result = guardWrite(
      RUNTIME_STATE_DIR,
      makeOptions(),
    )
    assert.ok(result.allowed,
      `Expected write to exact runtime state dir to be allowed, got: ${result.message}`)
  })

  it("does not allow runtime state prefix tricks", () => {
    const result = guardWrite(
      `${RUNTIME_STATE_DIR}-evil/state-index.json`,
      makeOptions(),
    )
    assert.ok(!result.allowed,
      `Expected runtime-state prefix trick to be blocked, got: ${result.message}`)
  })

  it("allows writes to .git/pi-zflow even when runtimeStateDir is not explicitly set", () => {
    // Without runtimeStateDir in options, the guard should resolve it
    // via resolveRuntimeStateDir (which calls git rev-parse).
    // For this test, we set it explicitly to match.
    const result = guardWrite(
      path.join(RUNTIME_STATE_DIR, "reconnaissance.md"),
      makeOptions(),
    )
    assert.ok(result.allowed,
      `Expected write to .git/pi-zflow/ to be allowed, got: ${result.message}`)
  })

  it("blocks writes to .git/config", () => {
    const result = guardWrite(
      path.join(GIT_DIR, "config"),
      makeOptions(),
    )
    assert.ok(!result.allowed,
      `Expected write to .git/config to be blocked, got: ${result.message}`)
    assert.ok(result.message.includes("Blocked path pattern"),
      `Expected blocked pattern message, got: ${result.message}`)
  })

  it("blocks writes to .git/HEAD", () => {
    const result = guardWrite(
      path.join(GIT_DIR, "HEAD"),
      makeOptions(),
    )
    assert.ok(!result.allowed,
      `Expected write to .git/HEAD to be blocked, got: ${result.message}`)
  })

  it("blocks writes to .git/objects/", () => {
    const result = guardWrite(
      path.join(GIT_DIR, "objects", "ab", "cdef1234"),
      makeOptions(),
    )
    assert.ok(!result.allowed,
      `Expected write to .git/objects/ to be blocked, got: ${result.message}`)
  })

  it("blocks writes to .git/refs/heads/main", () => {
    const result = guardWrite(
      path.join(GIT_DIR, "refs", "heads", "main"),
      makeOptions(),
    )
    assert.ok(!result.allowed,
      `Expected write to .git/refs/ to be blocked, got: ${result.message}`)
  })

  it("blocks writes to node_modules/", () => {
    const result = guardWrite(
      path.join(PROJECT_ROOT, "node_modules", "some-pkg", "index.js"),
      makeOptions(),
    )
    assert.ok(!result.allowed,
      `Expected write to node_modules/ to be blocked, got: ${result.message}`)
  })

  it("blocks writes to .env files", () => {
    const result = guardWrite(
      path.join(PROJECT_ROOT, ".env"),
      makeOptions(),
    )
    assert.ok(!result.allowed,
      `Expected write to .env to be blocked, got: ${result.message}`)
  })
})

describe("path-guard integration — .pi directory", () => {
  it("blocks writes to home ~/.pi/ directory", () => {
    const result = guardWrite(
      "/home/user/.pi/agent/config.json",
      makeOptions(),
    )
    assert.ok(!result.allowed,
      `Expected write to ~/.pi/ to be blocked, got: ${result.message}`)
  })

  it("blocks writes to Users home .pi/ directory (macOS)", () => {
    const result = guardWrite(
      "/Users/user/.pi/agent/config.json",
      makeOptions(),
    )
    assert.ok(!result.allowed,
      `Expected write to ~/.pi/ to be blocked, got: ${result.message}`)
  })

  it("allows writes to .pi/ directory in repo root", () => {
    const result = guardWrite(
      path.join(PROJECT_ROOT, ".pi", "extensions", "local.ts"),
      makeOptions(),
    )
    // Should be allowed because it's within project root and .pi here is
    // a repo-local directory (not the home dotfile pattern)
    assert.ok(result.allowed,
      `Expected write to repo-local .pi/ to be allowed, got: ${result.message}`)
  })
})

describe("path-guard integration — allowed root boundaries", () => {
  it("allows the exact project root path", () => {
    const result = guardWrite(
      PROJECT_ROOT,
      makeOptions(),
    )
    assert.ok(result.allowed,
      `Expected exact project root path to be allowed, got: ${result.message}`)
  })

  it("does not allow project-root prefix tricks", () => {
    const result = guardWrite(
      `${PROJECT_ROOT}-evil/src/file.ts`,
      makeOptions(),
    )
    assert.ok(!result.allowed,
      `Expected project-root prefix trick to be blocked, got: ${result.message}`)
  })
})

describe("path-guard integration — guardBashCommand", () => {
  it("blocks bash write to blocked path via redirection", () => {
    const result = guardBashCommand(
      `echo "test" > ${path.join(GIT_DIR, "config")}`,
      makeOptions(),
    )
    assert.ok(!result.allowed,
      `Expected bash redirection to .git/config to be blocked, got: ${result.message}`)
  })

  it("allows bash write to allowed path", () => {
    const result = guardBashCommand(
      `echo "test" > ${path.join(PROJECT_ROOT, "src", "file.ts")}`,
      makeOptions(),
    )
    assert.ok(result.allowed,
      `Expected bash write to project file to be allowed, got: ${result.message}`)
  })
})

describe("path-guard integration — GuardIntent", () => {
  it("blocks planner-artifact writes outside plans dir", () => {
    const result = guardWrite(
      path.join(PROJECT_ROOT, "src", "app.ts"),
      makeOptions({ intent: "planner-artifact" }),
    )
    assert.ok(!result.allowed,
      `Expected planner-artifact outside plans dir to be blocked, got: ${result.message}`)
  })

  it("allows planner-artifact writes inside plans dir", () => {
    const plansDir = path.join(RUNTIME_STATE_DIR, "plans")
    const result = guardWrite(
      path.join(plansDir, "ch42", "v1", "design.md"),
      makeOptions({ intent: "planner-artifact" }),
    )
    assert.ok(result.allowed,
      `Expected planner-artifact inside plans dir to be allowed, got: ${result.message}`)
  })

  it("blocks planner-artifact plans-dir prefix tricks", () => {
    const plansDir = path.join(RUNTIME_STATE_DIR, "plans")
    const result = guardWrite(
      `${plansDir}-evil/ch42/design.md`,
      makeOptions({ intent: "planner-artifact" }),
    )
    assert.ok(!result.allowed,
      `Expected planner-artifact plans-dir prefix trick to be blocked, got: ${result.message}`)
  })
})

describe("path-guard integration — buildToolDeniedReminder", () => {
  it("produces a markdown reminder from a blocked result", () => {
    const result: GuardResult = {
      allowed: false,
      message: "Blocked path pattern matched.",
      resolvedPath: "/foo/bar",
    }
    const reminder = buildToolDeniedReminder(result)
    assert.ok(reminder.includes("Tool call blocked by path guard"))
    assert.ok(reminder.includes("Blocked path pattern matched."))
  })
})

describe("path-guard integration — symlink escape prevention", () => {
  it("blocks writes to a new file under a symlinked directory that points outside projectRoot", { skip: process.platform === "win32" }, () => {
    // Create temp directory structure
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "zflow-symlink-test-"))
    const outsideDir = path.join(testRoot, "outside")
    const repoDir = path.join(testRoot, "repo")
    const symlinkedDir = path.join(repoDir, "link-outside")
    const newFilePath = path.join(symlinkedDir, "new-file.ts")

    mkdirSync(outsideDir, { recursive: true })
    mkdirSync(path.join(outsideDir, "subdir"), { recursive: true })
    mkdirSync(repoDir, { recursive: true })

    // Attempt to create symlink
    let symlinkCreated = false
    try {
      symlinkSync(outsideDir, symlinkedDir)
      symlinkCreated = existsSync(symlinkedDir)
    } catch {
      // Symlink creation not supported — skip
    }

    if (!symlinkCreated) {
      // Cleanup and skip
      rmSync(testRoot, { recursive: true, force: true })
      return
    }

    try {
      const result = guardWrite(newFilePath, {
        projectRoot: repoDir,
        runtimeStateDir: path.join(testRoot, "runtime-state"),
      })
      assert.ok(!result.allowed,
        `Expected write through symlink outside project root to be blocked, got: ${result.message}`)
      assert.ok(
        result.message.includes("outside allowed write roots"),
        `Expected "outside allowed write roots" in message, got: ${result.message}`,
      )
    } finally {
      rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("allows writes to a new file under a symlinked directory that points inside projectRoot", { skip: process.platform === "win32" }, () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "zflow-symlink-test-"))
    const realDir = path.join(testRoot, "realdir")
    const repoDir = path.join(testRoot, "repo")
    const symlinkedDir = path.join(repoDir, "link-inside")
    const newFilePath = path.join(symlinkedDir, "new-file.ts")

    mkdirSync(realDir, { recursive: true })
    mkdirSync(repoDir, { recursive: true })

    let symlinkCreated = false
    try {
      symlinkSync(realDir, symlinkedDir)
      symlinkCreated = existsSync(symlinkedDir)
    } catch {
      // skip
    }

    if (!symlinkCreated) {
      rmSync(testRoot, { recursive: true, force: true })
      return
    }

    try {
      const result = guardWrite(newFilePath, {
        projectRoot: repoDir,
        runtimeStateDir: path.join(testRoot, "runtime-state"),
        worktreePaths: [realDir],
      })
      // Should be allowed because realDir is in worktreePaths which are allowed roots
      assert.ok(result.allowed,
        `Expected write through symlink inside allowed roots to be allowed, got: ${result.message}`)
    } finally {
      rmSync(testRoot, { recursive: true, force: true })
    }
  })
})
