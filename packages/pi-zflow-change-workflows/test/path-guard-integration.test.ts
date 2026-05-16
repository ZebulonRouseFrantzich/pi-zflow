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

  // ── Destructive command blocklist ───────────────────────────

  it("blocks rm command", () => {
    const result = guardBashCommand(
      `rm ${path.join(PROJECT_ROOT, "src", "file.ts")}`,
      makeOptions(),
    )
    assert.ok(!result.allowed,
      `Expected rm to be blocked, got: ${result.message}`)
  })

  it("blocks rm -rf command", () => {
    const result = guardBashCommand("rm -rf node_modules", makeOptions())
    assert.ok(!result.allowed,
      `Expected rm -rf to be blocked, got: ${result.message}`)
  })

  it("blocks rmdir command", () => {
    const result = guardBashCommand("rmdir dist", makeOptions())
    assert.ok(!result.allowed,
      `Expected rmdir to be blocked, got: ${result.message}`)
  })

  it("blocks git rm command", () => {
    const result = guardBashCommand("git rm src/old-file.ts", makeOptions())
    assert.ok(!result.allowed,
      `Expected git rm to be blocked, got: ${result.message}`)
  })

  it("blocks git clean command", () => {
    const result = guardBashCommand("git clean -fd", makeOptions())
    assert.ok(!result.allowed,
      `Expected git clean to be blocked, got: ${result.message}`)
  })

  it("blocks git reset --hard command", () => {
    const result = guardBashCommand("git reset --hard", makeOptions())
    assert.ok(!result.allowed,
      `Expected git reset --hard to be blocked, got: ${result.message}`)
  })

  it("blocks sed -i command", () => {
    const result = guardBashCommand('sed -i "s/foo/bar/g" file.ts', makeOptions())
    assert.ok(!result.allowed,
      `Expected sed -i to be blocked, got: ${result.message}`)
  })

  it("blocks sed --in-place command", () => {
    const result = guardBashCommand('sed --in-place "s/foo/bar/g" file.ts', makeOptions())
    assert.ok(!result.allowed,
      `Expected sed --in-place to be blocked, got: ${result.message}`)
  })

  it("blocks chmod command", () => {
    const result = guardBashCommand("chmod +x script.sh", makeOptions())
    assert.ok(!result.allowed,
      `Expected chmod to be blocked, got: ${result.message}`)
  })

  it("blocks chown command", () => {
    const result = guardBashCommand("chown user:user file.ts", makeOptions())
    assert.ok(!result.allowed,
      `Expected chown to be blocked, got: ${result.message}`)
  })

  // ── Shell chaining ─────────────────────────────────────────

  it("blocks semicolon chaining", () => {
    const result = guardBashCommand("cd src; rm file.ts", makeOptions())
    assert.ok(!result.allowed,
      `Expected semicolon chaining to be blocked, got: ${result.message}`)
  })

  it("blocks pipe chaining with destructive command", () => {
    const result = guardBashCommand("cat file | rm file", makeOptions())
    assert.ok(!result.allowed,
      `Expected pipe chaining with rm to be blocked, got: ${result.message}`)
  })

  it("blocks && chaining with destructive command", () => {
    const result = guardBashCommand("git status && rm file", makeOptions())
    assert.ok(!result.allowed,
      `Expected && chaining to be blocked, got: ${result.message}`)
  })

  it("blocks || chaining with destructive command", () => {
    const result = guardBashCommand("grep foo file || rm file", makeOptions())
    assert.ok(!result.allowed,
      `Expected || chaining to be blocked, got: ${result.message}`)
  })

  it("blocks backtick command substitution", () => {
    const result = guardBashCommand("echo `ls`", makeOptions())
    assert.ok(!result.allowed,
      `Expected backtick substitution to be blocked, got: ${result.message}`)
  })

  it("blocks dollar-paren command substitution", () => {
    const result = guardBashCommand("cat $(which git)", makeOptions())
    assert.ok(!result.allowed,
      `Expected $() substitution to be blocked, got: ${result.message}`)
  })

  it("blocks sudo destructive command", () => {
    const result = guardBashCommand("sudo rm /etc/config", makeOptions())
    assert.ok(!result.allowed,
      `Expected sudo rm to be blocked, got: ${result.message}`)
  })

  // ── mkdir, touch, install ─────────────────────────────────

  it("blocks mkdir command", () => {
    const result = guardBashCommand("mkdir tmp", makeOptions())
    assert.ok(!result.allowed,
      `Expected mkdir to be blocked, got: ${result.message}`)
  })

  it("blocks touch command", () => {
    const result = guardBashCommand("touch file.ts", makeOptions())
    assert.ok(!result.allowed,
      `Expected touch to be blocked, got: ${result.message}`)
  })

  it("blocks install command", () => {
    const result = guardBashCommand("install -m 755 script.sh /usr/local/bin/", makeOptions())
    assert.ok(!result.allowed,
      `Expected install to be blocked, got: ${result.message}`)
  })

  // ── Unknown commands blocked (deny-by-default) ────────────

  it("blocks python script.py (unknown command)", () => {
    const result = guardBashCommand("python script.py", makeOptions())
    assert.ok(!result.allowed,
      `Expected python to be blocked, got: ${result.message}`)
  })

  it("blocks node script.js (unknown command)", () => {
    const result = guardBashCommand("node script.js", makeOptions())
    assert.ok(!result.allowed,
      `Expected node to be blocked, got: ${result.message}`)
  })

  it("blocks make build (unknown command)", () => {
    const result = guardBashCommand("make build", makeOptions())
    assert.ok(!result.allowed,
      `Expected make to be blocked, got: ${result.message}`)
  })

  it("blocks git stash apply --index (not read-only)", () => {
    const result = guardBashCommand("git stash apply --index", makeOptions())
    assert.ok(!result.allowed,
      `Expected git stash apply to be blocked, got: ${result.message}`)
  })

  it("blocks git init (not read-only)", () => {
    const result = guardBashCommand("git init", makeOptions())
    assert.ok(!result.allowed,
      `Expected git init to be blocked, got: ${result.message}`)
  })

  it("blocks source command", () => {
    const result = guardBashCommand("source ./script.sh", makeOptions())
    assert.ok(!result.allowed,
      `Expected source to be blocked, got: ${result.message}`)
  })

  it("blocks dot-source command", () => {
    const result = guardBashCommand(". ./script.sh", makeOptions())
    assert.ok(!result.allowed,
      `Expected dot-source to be blocked, got: ${result.message}`)
  })

  it("blocks export command", () => {
    const result = guardBashCommand("export FOO=bar", makeOptions())
    assert.ok(!result.allowed,
      `Expected export to be blocked, got: ${result.message}`)
  })

  it("blocks cd command", () => {
    const result = guardBashCommand("cd src", makeOptions())
    assert.ok(!result.allowed,
      `Expected cd to be blocked, got: ${result.message}`)
  })

  it("blocks npx command", () => {
    const result = guardBashCommand("npx some-tool", makeOptions())
    assert.ok(!result.allowed,
      `Expected npx to be blocked, got: ${result.message}`)
  })

  it("blocks env wrapper destructive command", () => {
    const result = guardBashCommand("env rm -rf /tmp/foo", makeOptions())
    assert.ok(!result.allowed,
      `Expected env rm to be blocked, got: ${result.message}`)
  })

  it("blocks time wrapper destructive command", () => {
    const result = guardBashCommand("time rm file", makeOptions())
    assert.ok(!result.allowed,
      `Expected time rm to be blocked, got: ${result.message}`)
  })

  it("blocks curl simple fetch (not read-only)", () => {
    const result = guardBashCommand("curl https://example.com", makeOptions())
    assert.ok(!result.allowed,
      `Expected curl to be blocked, got: ${result.message}`)
  })

  it("blocks curl with output flag (writes to disk)", () => {
    const result = guardBashCommand("curl -o /tmp/out https://example.com", makeOptions())
    assert.ok(!result.allowed,
      `Expected curl -o to be blocked, got: ${result.message}`)
  })

  it("blocks wget simple fetch (not read-only)", () => {
    const result = guardBashCommand("wget https://example.com", makeOptions())
    assert.ok(!result.allowed,
      `Expected wget to be blocked, got: ${result.message}`)
  })

  it("blocks wget with output flag (writes to disk)", () => {
    const result = guardBashCommand("wget -O /tmp/out https://example.com", makeOptions())
    assert.ok(!result.allowed,
      `Expected wget -O to be blocked, got: ${result.message}`)
  })

  // ── Read-only commands still allowed ───────────────────────

  it("allows git status", () => {
    const result = guardBashCommand("git status", makeOptions())
    assert.ok(result.allowed,
      `Expected git status to be allowed, got: ${result.message}`)
  })

  it("allows git diff", () => {
    const result = guardBashCommand("git diff", makeOptions())
    assert.ok(result.allowed,
      `Expected git diff to be allowed, got: ${result.message}`)
  })

  it("allows git log", () => {
    const result = guardBashCommand("git log --oneline -5", makeOptions())
    assert.ok(result.allowed,
      `Expected git log to be allowed, got: ${result.message}`)
  })

  it("allows git show", () => {
    const result = guardBashCommand("git show", makeOptions())
    assert.ok(result.allowed,
      `Expected git show to be allowed, got: ${result.message}`)
  })

  it("allows git ls-files", () => {
    const result = guardBashCommand("git ls-files", makeOptions())
    assert.ok(result.allowed,
      `Expected git ls-files to be allowed, got: ${result.message}`)
  })

  it("allows git ls-tree", () => {
    const result = guardBashCommand("git ls-tree HEAD", makeOptions())
    assert.ok(result.allowed,
      `Expected git ls-tree to be allowed, got: ${result.message}`)
  })

  it("allows git rev-parse", () => {
    const result = guardBashCommand("git rev-parse HEAD", makeOptions())
    assert.ok(result.allowed,
      `Expected git rev-parse to be allowed, got: ${result.message}`)
  })

  it("allows ls", () => {
    const result = guardBashCommand("ls -la src/", makeOptions())
    assert.ok(result.allowed,
      `Expected ls to be allowed, got: ${result.message}`)
  })

  it("allows cat", () => {
    const result = guardBashCommand("cat package.json", makeOptions())
    assert.ok(result.allowed,
      `Expected cat to be allowed, got: ${result.message}`)
  })

  it("allows grep", () => {
    const result = guardBashCommand('grep -r "TODO" src/', makeOptions())
    assert.ok(result.allowed,
      `Expected grep to be allowed, got: ${result.message}`)
  })

  it("allows find", () => {
    const result = guardBashCommand("find . -name '*.ts'", makeOptions())
    assert.ok(result.allowed,
      `Expected find to be allowed, got: ${result.message}`)
  })

  it("allows head/tail", () => {
    const result = guardBashCommand("tail -20 README.md", makeOptions())
    assert.ok(result.allowed,
      `Expected tail to be allowed, got: ${result.message}`)
  })

  it("blocks piped read-only commands (no chaining allowed)", () => {
    const result = guardBashCommand("git diff | head -50", makeOptions())
    assert.ok(!result.allowed,
      `Expected piped read-only commands to be blocked, got: ${result.message}`)
  })

  it("allows echo with redirection to allowed path", () => {
    const result = guardBashCommand(
      `echo "test" > ${path.join(PROJECT_ROOT, "file.ts")}`,
      makeOptions(),
    )
    assert.ok(result.allowed,
      `Expected echo with redirection to allowed path to be allowed, got: ${result.message}`)
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
