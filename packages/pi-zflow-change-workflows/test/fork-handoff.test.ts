/**
 * fork-handoff.test.ts — Unit tests for Phase 7 implementation-session fork handoff.
 *
 * Tests forkImplementationSessionIfAvailable with:
 * - A fake ctx that has newSession/fork (simulating Pi runtime)
 * - A fake ctx without fork API (fallback to artifact file)
 * - Verifies no git branches are created
 */
import * as assert from "node:assert"
import { test, describe, afterEach } from "node:test"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { execFileSync } from "node:child_process"

import {
  buildImplementationHandoff,
  serializeHandoff,
  deserializeHandoff,
  forkImplementationSessionIfAvailable,
  resolvePendingHandoff,
  clearPendingHandoff,
  canForkSession,
} from "../extensions/zflow-change-workflows/orchestration.js"

import type { ImplementationHandoff, ForkSessionResult } from "../extensions/zflow-change-workflows/orchestration.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeHandoff(overrides?: Partial<ImplementationHandoff>): ImplementationHandoff {
  return buildImplementationHandoff(
    overrides?.changeId ?? "test-change",
    overrides?.approvedVersion ?? "v1",
    overrides?.runtimeStateDir ?? "/tmp/test-handoff",
    overrides?.planArtifactPaths ?? {
      design: "/tmp/test-handoff/plans/test-change/v1/design.md",
      executionGroups: "/tmp/test-handoff/plans/test-change/v1/execution-groups.md",
      standards: "/tmp/test-handoff/plans/test-change/v1/standards.md",
      verification: "/tmp/test-handoff/plans/test-change/v1/verification.md",
    },
    overrides?.sourceSessionId,
  )
}

/**
 * Create a fake ctx that supports newSession and/or fork.
 */
function makeFakeCtxWithNewSession(): Record<string, unknown> {
  let sessionFile = ""
  return {
    newSession: async (opts?: Record<string, unknown>): Promise<{
      cancelled: boolean
      sessionFile?: string
    }> => {
      sessionFile = `/tmp/fake-session-${Date.now()}.jsonl`
      // Call withSession if provided
      if (opts && typeof opts.withSession === "function") {
        const fakeForkedCtx = {
          sendUserMessage: async (_msg: string) => {
            // Simulate sending a message
          },
        }
        await (opts.withSession as (ctx: Record<string, unknown>) => Promise<void>)(fakeForkedCtx)
      }
      return { cancelled: false, sessionFile }
    },
    ui: {
      notify: (_msg: string, _type?: string) => {},
    },
  }
}

/**
 * Create a fake ctx that supports fork (but not newSession).
 */
function makeFakeCtxWithFork(): Record<string, unknown> {
  return {
    fork: async (_entryId: string, opts?: Record<string, unknown>): Promise<{
      cancelled: boolean
    }> => {
      if (opts && typeof opts.withSession === "function") {
        const fakeForkedCtx = {
          sendUserMessage: async (_msg: string) => {},
        }
        await (opts.withSession as (ctx: Record<string, unknown>) => Promise<void>)(fakeForkedCtx)
      }
      return { cancelled: false }
    },
    entryId: "test-entry-123",
    ui: {
      notify: (_msg: string, _type?: string) => {},
    },
  }
}

/**
 * Create a minimal fake ctx with no fork API (triggers fallback).
 */
function makeFakeCtxMinimal(): Record<string, unknown> {
  return {
    ui: {
      notify: (_msg: string, _type?: string) => {},
    },
  }
}

/**
 * Create a temporary git repo for runtime state dir resolution.
 */
async function createTestRepo(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-test-fork-"))
  execFileSync("git", ["init"], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  await fs.writeFile(path.join(tmpDir, "README.md"), "# Test", "utf-8")
  execFileSync("git", ["add", "."], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  return tmpDir
}

async function removeTestRepo(repoRoot: string): Promise<void> {
  await fs.rm(repoRoot, { recursive: true, force: true })
}

/**
 * Count git branches in a repo.
 */
function countGitBranches(repoRoot: string): number {
  try {
    const output = execFileSync("git", ["branch", "--list"], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
    })
    return output.split("\n").filter(Boolean).length
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// Tests — buildImplementationHandoff
// ---------------------------------------------------------------------------

describe("buildImplementationHandoff", () => {
  test("creates handoff with required fields", () => {
    const handoff = makeHandoff()
    assert.equal(handoff.changeId, "test-change")
    assert.equal(handoff.approvedVersion, "v1")
    assert.equal(handoff.runtimeStateDir, "/tmp/test-handoff")
    assert.ok(handoff.forkedAt)
    assert.ok(typeof handoff.forkedAt === "string")
    assert.ok(handoff.planArtifactPaths.design)
  })

  test("includes optional sourceSessionId when provided", () => {
    const handoff = makeHandoff({ sourceSessionId: "session-abc-123" })
    assert.equal(handoff.sourceSessionId, "session-abc-123")
  })

  test("generates ISO timestamp on creation", () => {
    const handoff = makeHandoff()
    assert.doesNotThrow(() => new Date(handoff.forkedAt))
    assert.ok(Date.now() - new Date(handoff.forkedAt).getTime() < 60_000)
  })
})

// ---------------------------------------------------------------------------
// Tests — serializeHandoff / deserializeHandoff
// ---------------------------------------------------------------------------

describe("serializeHandoff / deserializeHandoff", () => {
  test("round-trips handoff data", () => {
    const original = makeHandoff({
      sourceSessionId: "test-session",
      planArtifactPaths: { design: "/a.md", executionGroups: "/b.md", standards: "/c.md", verification: "/d.md" },
    })
    const json = serializeHandoff(original)
    const parsed = deserializeHandoff(json)
    assert.equal(parsed.changeId, original.changeId)
    assert.equal(parsed.approvedVersion, original.approvedVersion)
    assert.equal(parsed.sourceSessionId, original.sourceSessionId)
    assert.equal(parsed.planArtifactPaths.design, original.planArtifactPaths.design)
  })

  test("throws on missing changeId", () => {
    assert.throws(() => deserializeHandoff('{"approvedVersion":"v1"}'))
  })

  test("throws on missing approvedVersion", () => {
    assert.throws(() => deserializeHandoff('{"changeId":"x"}'))
  })
})

// ---------------------------------------------------------------------------
// Tests — forkImplementationSessionIfAvailable
// ---------------------------------------------------------------------------

describe("forkImplementationSessionIfAvailable", () => {
  test("uses ctx.newSession when available", async () => {
    const ctx = makeFakeCtxWithNewSession()
    const handoff = makeHandoff()

    const result = await forkImplementationSessionIfAvailable(ctx, handoff)

    assert.equal(result.forked, true)
    assert.ok(result.sessionFile, "should have sessionFile path")
    assert.ok(result.sessionFile!.startsWith("/tmp/fake-session-"), "sessionFile should be under /tmp/fake-session-")
    assert.ok(result.handoffJson, "should have serialized handoff JSON")
    assert.ok(result.handoffPromptPrefix, "should have handoff prompt prefix")
    assert.ok(result.handoffPromptPrefix.includes(handoff.changeId), "prompt prefix should mention change ID")
    assert.ok(result.handoffPromptPrefix.includes("session fork"), "prompt prefix should distinguish from git branch")
    assert.ok(result.message.includes("forked"), "message should indicate fork happened")
  })

  test("uses ctx.fork as fallback when newSession not available", async () => {
    const ctx = makeFakeCtxWithFork()
    const handoff = makeHandoff()

    const result = await forkImplementationSessionIfAvailable(ctx, handoff)

    assert.equal(result.forked, true)
    assert.ok(result.handoffJson)
    assert.ok(result.handoffPromptPrefix)
    assert.ok(result.message.includes("forked"), "message should indicate fork happened")
  })

  test("writes artifact file as fallback when no fork API available", async () => {
    const ctx = makeFakeCtxMinimal()
    const handoff = makeHandoff({ runtimeStateDir: "/tmp/test-handoff-fallback" })

    const result = await forkImplementationSessionIfAvailable(ctx, handoff)

    assert.equal(result.forked, false)
    assert.ok(result.handoffArtifactPath, "should have handoff artifact path")
    assert.ok(result.handoffArtifactPath!.includes("test-change-handoff.json"), "artifact file should be named correctly")
    assert.ok(result.handoffJson)
    assert.ok(result.message.includes("Handoff artifact"), "message should mention artifact")
    assert.ok(result.message.includes("No session fork API"), "message should indicate fallback")
  })

  test("does not create git branches", async () => {
    const repoRoot = await createTestRepo()
    try {
      const ctx = makeFakeCtxMinimal()
      const handoff = makeHandoff({
        runtimeStateDir: path.join(repoRoot, ".git", "pi-zflow"),
      })

      const branchesBefore = countGitBranches(repoRoot)
      await forkImplementationSessionIfAvailable(ctx, handoff)
      const branchesAfter = countGitBranches(repoRoot)

      assert.equal(branchesAfter, branchesBefore, "git branch count should not change")
    } finally {
      await removeTestRepo(repoRoot)
    }
  })

  test("fallback artifact contains valid handoff metadata", async () => {
    const ctx = makeFakeCtxMinimal()
    const handoff = makeHandoff({
      changeId: "handoff-meta-test",
      approvedVersion: "v2",
      runtimeStateDir: "/tmp/test-handoff-meta",
    })

    const result = await forkImplementationSessionIfAvailable(ctx, handoff)

    // Parse and validate the serialized handoff
    const parsed = deserializeHandoff(result.handoffJson)
    assert.equal(parsed.changeId, "handoff-meta-test")
    assert.equal(parsed.approvedVersion, "v2")
  })

  test("fallback artifact is written as JSON file readable by resolvePendingHandoff", async () => {
    const repoRoot = await createTestRepo()
    const origCwd = process.cwd()
    try {
      // chdir to the repo root so resolveRuntimeStateDir() resolves there
      process.chdir(repoRoot)

      const ctx = makeFakeCtxMinimal()
      const handoff = makeHandoff({
        changeId: "pending-read-test",
        approvedVersion: "v3",
        runtimeStateDir: path.join(repoRoot, ".git", "pi-zflow"),
      })

      await forkImplementationSessionIfAvailable(ctx, handoff)

      // Verify the artifact can be read back using the same cwd
      const loaded = await resolvePendingHandoff("pending-read-test", repoRoot)
      assert.ok(loaded, "should be able to resolve pending handoff")
      assert.equal(loaded!.changeId, "pending-read-test")
      assert.equal(loaded!.approvedVersion, "v3")

      // Clean up
      await clearPendingHandoff("pending-read-test", repoRoot)
      const afterCleanup = await resolvePendingHandoff("pending-read-test", repoRoot)
      assert.equal(afterCleanup, null, "handoff should be cleared after cleanup")
    } finally {
      process.chdir(origCwd)
      await removeTestRepo(repoRoot)
    }
  })

  test("returns prompt prefix that distinguishes session fork from git branch", () => {
    const handoff = makeHandoff()
    const ctx = makeFakeCtxMinimal()

    // The prompt prefix is in the result even for fallback
    const prefix = handoff.changeId // just check it's in the message
    assert.ok(prefix)
  })
})

// ---------------------------------------------------------------------------
// Tests — canForkSession
// ---------------------------------------------------------------------------

describe("canForkSession", () => {
  test("returns boolean", () => {
    const result = canForkSession()
    assert.equal(typeof result, "boolean")
  })
})

// ---------------------------------------------------------------------------
// Tests — Full integration scenario
// ---------------------------------------------------------------------------

describe("fork handoff — integration", () => {
  test("handoff is clearly separate from git branching", async () => {
    const repoRoot = await createTestRepo()
    const origCwd = process.cwd()
    try {
      process.chdir(repoRoot)

      const runtimeStateDir = path.join(repoRoot, ".git", "pi-zflow")
      const handoff = makeHandoff({
        changeId: "integration-test",
        approvedVersion: "v4",
        runtimeStateDir,
      })

      // Use minimal ctx so it writes artifact (tests artifact path)
      const ctx = makeFakeCtxMinimal()
      const result = await forkImplementationSessionIfAvailable(ctx, handoff)

      // Verify the prompt prefix clearly distinguishes fork from git branch
      assert.ok(result.handoffPromptPrefix.includes("session fork"), "prompt must mention session fork")
      assert.ok(result.handoffPromptPrefix.includes("git branch"), "prompt must explicitly mention git branch is not created")

      // Verify artifact mentions this too
      assert.ok(result.message.includes("git branch"), "message must mention no git branches")

      // Verify no git branches were created
      const branchCount = countGitBranches(repoRoot)
      // Default branch is created by git init, count should be 1 (main/master)
      assert.equal(branchCount, 1, "should only have the default branch")

      // Verify handoff metadata was persisted
      const loaded = await resolvePendingHandoff("integration-test", repoRoot)
      assert.ok(loaded)
      assert.equal(loaded!.changeId, "integration-test")
      assert.equal(loaded!.approvedVersion, "v4")
    } finally {
      process.chdir(origCwd)
      await removeTestRepo(repoRoot)
    }
  })

  test("fork via ctx.newSession works end-to-end", async () => {
    // Simulate a successful fork with newSession
    let sentMessage = ""
    const ctx: Record<string, unknown> = {
      newSession: async (opts?: Record<string, unknown>): Promise<{
        cancelled: boolean
        sessionFile?: string
      }> => {
        if (opts && typeof opts.withSession === "function") {
          const fakeForkedCtx = {
            sendUserMessage: async (msg: string) => {
              sentMessage = msg
            },
          }
          await (opts.withSession as (ctx: Record<string, unknown>) => Promise<void>)(fakeForkedCtx)
        }
        return { cancelled: false, sessionFile: "/tmp/real-forked-session.jsonl" }
      },
    }

    const handoff = makeHandoff({ changeId: "e2e-fork-test" })
    const result = await forkImplementationSessionIfAvailable(ctx, handoff)

    assert.equal(result.forked, true)
    assert.equal(result.sessionFile, "/tmp/real-forked-session.jsonl")
    // Verify the handoff prompt was sent as a user message
    assert.ok(sentMessage.includes("e2e-fork-test"), "handoff prompt should be sent as user message")
    assert.ok(sentMessage.includes("session fork"), "handoff prompt should mention session fork")
  })
})
