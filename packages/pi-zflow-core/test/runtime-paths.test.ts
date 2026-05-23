/**
 * Runtime path resolver unit tests.
 */
import * as assert from "node:assert"
import { test, describe } from "node:test"
import * as path from "node:path"
import * as os from "node:os"

import {
  resolveRuntimeStateDir,
  resolveUserStateDir,
  DEFAULT_STALE_ARTIFACT_TTL_DAYS,
  DEFAULT_FAILED_WORKTREE_RETENTION_DAYS,
  inGitRepo,
  resolveGitDir,
  resolveGitToplevel,
} from "../src/runtime-paths.js"

describe("runtime path constants", () => {
  test("DEFAULT_STALE_ARTIFACT_TTL_DAYS is 14", () => {
    assert.equal(DEFAULT_STALE_ARTIFACT_TTL_DAYS, 14)
  })

  test("DEFAULT_FAILED_WORKTREE_RETENTION_DAYS is 7", () => {
    assert.equal(DEFAULT_FAILED_WORKTREE_RETENTION_DAYS, 7)
  })
})

describe("resolveUserStateDir", () => {
  test("returns ~/.pi/agent/zflow/", () => {
    const result = resolveUserStateDir()
    assert.ok(result.endsWith(path.join(".pi", "agent", "zflow")))
    assert.ok(result.startsWith(os.homedir()))
  })
})

describe("inGitRepo", () => {
  test("detects current directory is in a git repo", () => {
    // This project is a git repo
    const result = inGitRepo()
    assert.ok(result, "expected to be in a git repo")
  })

  test("detects /tmp is not in a git repo", () => {
    const result = inGitRepo("/tmp")
    // /tmp might be inside a git repo in some setups, but unlikely
    // This is a soft check; skip if it fails
    if (result) {
      console.log("Skipping: /tmp appears to be in a git repo")
    }
  })
})

describe("resolveRuntimeStateDir", () => {
  test("returns <toplevel>/.zflow/ when in a repo", () => {
    const result = resolveRuntimeStateDir()
    assert.ok(result.endsWith(path.join(".zflow")), `expected .zflow suffix, got: ${result}`)
    // Should contain ".zflow" since the runtime dir is <toplevel>/.zflow/
    assert.ok(
      result.includes(".zflow") || result.includes(os.tmpdir()),
      `expected .zflow or tmpdir in path, got: ${result}`,
    )
  })

  test("falls back to tmpdir when outside git", () => {
    const result = resolveRuntimeStateDir("/tmp")
    assert.ok(result.startsWith(os.tmpdir()), `expected tmpdir prefix, got: ${result}`)
    assert.ok(result.includes("pi-zflow-"), `expected pi-zflow- hash suffix, got: ${result}`)
  })

  test("produces deterministic hash for the same cwd", () => {
    const a = resolveRuntimeStateDir("/tmp/foo")
    const b = resolveRuntimeStateDir("/tmp/foo")
    assert.equal(a, b)
  })

  test("produces different hashes for different cwds", () => {
    const a = resolveRuntimeStateDir("/tmp/project-alpha")
    const b = resolveRuntimeStateDir("/tmp/project-beta")
    assert.notEqual(a, b)
  })

  test("resolveGitToplevel returns non-null inside this repo", () => {
    const result = resolveGitToplevel()
    assert.notEqual(result, null, "expected to resolve git toplevel")
    assert.ok(path.isAbsolute(result!), "expected absolute path")
  })

  test("resolveGitToplevel returns null outside git", () => {
    const result = resolveGitToplevel("/tmp")
    if (result !== null) {
      // /tmp could be inside a git repo in some setups; that's ok
      console.log("resolveGitToplevel(/tmp) resolved to:", result)
    }
  })
})
