/**
 * transport-error-handling.test.ts — Unit tests for dispatch transport error
 * classification and resolver worktree inspection helpers.
 */
import * as assert from "node:assert/strict"
import { test, describe } from "node:test"
import * as path from "node:path"
import * as fs from "node:fs"
import { execFileSync } from "node:child_process"
import * as os from "node:os"

import { isTransportDispatchError } from "../extensions/zflow-change-workflows/index.js"

// ---------------------------------------------------------------------------
// isTransportDispatchError
// ---------------------------------------------------------------------------

describe("isTransportDispatchError", () => {
  test("classifies WebSocket error as transport", () => {
    assert.equal(isTransportDispatchError("WebSocket error"), true)
    assert.equal(isTransportDispatchError("WebSocket error during dispatch"), true)
  })

  test("classifies ECONNRESET as transport", () => {
    assert.equal(isTransportDispatchError("ECONNRESET"), true)
    assert.equal(isTransportDispatchError("econnreset"), true)
    assert.equal(isTransportDispatchError("connect ECONNRESET 127.0.0.1:443"), true)
  })

  test("classifies connection closed/reset/refused as transport", () => {
    assert.equal(isTransportDispatchError("Connection closed"), true)
    assert.equal(isTransportDispatchError("Connection reset"), true)
    assert.equal(isTransportDispatchError("Connection refused"), true)
  })

  test("classifies timeout/network/socket errors as transport", () => {
    assert.equal(isTransportDispatchError("timeout"), true)
    assert.equal(isTransportDispatchError("network error"), true)
    assert.equal(isTransportDispatchError("socket hang up"), true)
    assert.equal(isTransportDispatchError("ETIMEDOUT"), true)
    assert.equal(isTransportDispatchError("ENOTFOUND"), true)
    assert.equal(isTransportDispatchError("EPIPE"), true)
    assert.equal(isTransportDispatchError("ECONNREFUSED"), true)
    assert.equal(isTransportDispatchError("keepalive"), true)
  })

  test("classifies TLS errors as transport", () => {
    assert.equal(isTransportDispatchError("TLS error"), true)
    assert.equal(isTransportDispatchError("tls handshake failed"), true)
  })

  test("classifies generic transport mentions", () => {
    assert.equal(isTransportDispatchError("transport error"), true)
    assert.equal(isTransportDispatchError("Transport failure"), true)
  })

  test("returns false for undefined/null/empty", () => {
    assert.equal(isTransportDispatchError(undefined), false)
    assert.equal(isTransportDispatchError(""), false)
  })

  test("returns false for semantic failures", () => {
    assert.equal(isTransportDispatchError("Agent did not complete the task"), false)
    assert.equal(isTransportDispatchError("Task failed: model returned error"), false)
    assert.equal(isTransportDispatchError("Unknown agent"), false)
    assert.equal(isTransportDispatchError("Coverage verification failed"), false)
    assert.equal(isTransportDispatchError("Model not found"), false)
  })
})

// ---------------------------------------------------------------------------
// inspectResolverWorktreeState (integration-style with temp git repo)
// ---------------------------------------------------------------------------

async function git(repoDir: string, ...args: string[]): Promise<string> {
  return execFileSync("git", args, {
    cwd: repoDir,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim()
}

async function createTempRepo(): Promise<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zflow-test-"))
  execFileSync("git", ["init", "--initial-branch=main", tmpDir], { stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir, stdio: "ignore" })
  execFileSync("git", ["config", "user.name", "Test"], { cwd: tmpDir, stdio: "ignore" })
  return tmpDir
}

describe("inspectResolverWorktreeState", () => {
  test("detects unmerged files", async () => {
    const repo = await createTempRepo()
    fs.writeFileSync(path.join(repo, "file.txt"), "base content\n", "utf-8")
    await git(repo, "add", "file.txt")
    await git(repo, "commit", "-m", "initial")

    // Create two branches with conflicting changes
    fs.writeFileSync(path.join(repo, "file.txt"), "branch-a content\n", "utf-8")
    await git(repo, "add", "file.txt")
    await git(repo, "commit", "-m", "branch-a")
    const branchACommit = await git(repo, "rev-parse", "HEAD")

    await git(repo, "checkout", "HEAD~1", "-b", "branch-b")
    fs.writeFileSync(path.join(repo, "file.txt"), "branch-b content\n", "utf-8")
    await git(repo, "add", "file.txt")
    await git(repo, "commit", "-m", "branch-b")

    // Merge branch-a into branch-b — should conflict
    try {
      execFileSync("git", ["merge", branchACommit], {
        cwd: repo,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
        timeout: 10_000,
      })
    } catch {
      // expected conflict
    }

    const { inspectResolverWorktreeState } = await import(
      "../extensions/zflow-change-workflows/index.js"
    )
    const state = await inspectResolverWorktreeState(repo)
    assert.ok(state.unmergedFiles.length > 0, "should detect unmerged files")
    assert.ok(state.hasConflictMarkers, "should detect conflict markers")
    assert.ok(state.hasUncommittedChanges, "should detect uncommitted changes")
    assert.ok(state.summary.includes("unmerged"), "summary should mention unmerged")
    assert.ok(state.summary.includes("conflict"), "summary should mention conflict")

    fs.rmSync(repo, { recursive: true, force: true })
  })

  test("reports clean worktree", async () => {
    const repo = await createTempRepo()
    fs.writeFileSync(path.join(repo, "file.txt"), "some content\n", "utf-8")
    await git(repo, "add", "file.txt")
    await git(repo, "commit", "-m", "initial")

    const { inspectResolverWorktreeState } = await import(
      "../extensions/zflow-change-workflows/index.js"
    )
    const state = await inspectResolverWorktreeState(repo)
    assert.equal(state.unmergedFiles.length, 0, "no unmerged files in clean repo")
    assert.equal(state.hasConflictMarkers, false, "no conflict markers in clean repo")
    assert.equal(state.hasUncommittedChanges, false, "no uncommitted changes in clean repo")
    assert.ok(state.summary.includes("no unmerged"), "summary should say no unmerged")
    assert.ok(state.summary.includes("no conflict"), "summary should say no conflict")

    fs.rmSync(repo, { recursive: true, force: true })
  })
})
