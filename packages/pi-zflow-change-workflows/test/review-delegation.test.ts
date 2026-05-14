/**
 * review-delegation.test.ts — Tests for review service delegation in orchestration.ts
 *
 * Verifies that `runPlanReview` and `finalizeCodeReview` correctly call
 * the canonical `runPlanReview` and `runCodeReview` methods on the registry
 * review service, and that they degrade gracefully when no service is available.
 */
import * as assert from "node:assert"
import { test, describe, afterEach } from "node:test"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { execFileSync } from "node:child_process"

import { getZflowRegistry, resetZflowRegistry } from "pi-zflow-core"
import { resolvePlanStatePath, resolvePlanArtifactPath, resolveRunStatePath, resolveStateIndexPath } from "pi-zflow-artifacts/artifact-paths"
import { loadStateIndex } from "pi-zflow-artifacts/state-index"

import {
  runChangePrepareWorkflow,
  runPlanReview,
  approvePlanVersion,
  runChangeImplementWorkflow,
  finalizeCodeReview,
  completeWorkflow,
} from "../extensions/zflow-change-workflows/orchestration.js"

// ── Helpers ──────────────────────────────────────────────────────

async function createTestRepo(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-test-review-"))
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

async function writeValidPlanArtifacts(versionDir: string): Promise<void> {
  await fs.mkdir(versionDir, { recursive: true })
  await fs.writeFile(path.join(versionDir, "design.md"), "# Design\nReal design content", "utf-8")
  await fs.writeFile(path.join(versionDir, "execution-groups.md"), "# Execution Groups\nReal execution groups", "utf-8")
  await fs.writeFile(path.join(versionDir, "standards.md"), "# Standards\nReal standards content", "utf-8")
  await fs.writeFile(path.join(versionDir, "verification.md"), "# Verification\nReal verification plan", "utf-8")
}

// ── Stub review service ──────────────────────────────────────────

/**
 * Create a minimal stub review service that records calls to runPlanReview
 * and runCodeReview, and returns predictable results.
 */
function createStubReviewService() {
  const calls: { method: string; args: unknown[] }[] = []

  const service = {
    runPlanReview(input: unknown) {
      calls.push({ method: "runPlanReview", args: [input] })
      return Promise.resolve({
        action: "approve" as const,
        findingsPath: "/tmp/stub-plan-review.md",
        tier: "standard",
        severity: { critical: 0, major: 0, minor: 1, nit: 2 },
        coverageNotes: ["Stub review completed."],
        manifest: { mode: "plan-review", tier: "standard", reviewers: [] },
      })
    },
    runCodeReview(input: unknown) {
      calls.push({ method: "runCodeReview", args: [input] })
      return Promise.resolve({
        findingsPath: "/tmp/stub-code-review.md",
        tier: "standard",
        severity: { critical: 0, major: 0, minor: 2, nit: 3 },
        coverageNotes: ["Stub code review completed."],
        manifest: { mode: "code-review", tier: "standard", reviewers: [] },
      })
    },
    // Old names that should NOT be called after the fix
    planReview(_changeId: string, _planVersion: string, _cwd?: string) {
      calls.push({ method: "planReview (old)", args: [_changeId, _planVersion, _cwd] })
      return Promise.resolve({ pass: true, findingsPath: "/tmp/old.md", summary: "old" })
    },
    codeReview(_runId: string, _changeId: string, _cwd?: string) {
      calls.push({ method: "codeReview (old)", args: [_runId, _changeId, _cwd] })
      return Promise.resolve({ pass: true, findingsPath: "/tmp/old.md", summary: "old" })
    },
  }

  return { service, calls }
}

// ── Registry lifecycle ───────────────────────────────────────────

describe("runPlanReview — registry delegation", () => {
  afterEach(() => {
    resetZflowRegistry()
  })

  test("calls canonical runPlanReview on review service when present", async () => {
    const repoRoot = await createTestRepo()
    try {
      // Register the review capability with a stub service
      const registry = getZflowRegistry()
      registry.claim({ capability: "review", version: "0.1.0", provider: "test" })
      const { service, calls } = createStubReviewService()
      registry.provide("review", service)

      // Prepare plan artifacts
      const result = await runChangePrepareWorkflow({
        cwd: repoRoot,
        changeId: "test-plan-review-delegation",
      })

      const versionDir = path.dirname(result.artifactPaths.design)
      await writeValidPlanArtifacts(versionDir)

      // Call runPlanReview
      const reviewResult = await runPlanReview("test-plan-review-delegation", "v1", repoRoot)

      // Verify it delegated to the canonical method
      assert.strictEqual(calls.length, 1, "should make exactly one service call")
      assert.strictEqual(calls[0].method, "runPlanReview", "should call runPlanReview, not planReview")

      // Verify the input was built correctly
      const input = calls[0].args[0] as Record<string, unknown>
      assert.strictEqual(input.changeId, "test-plan-review-delegation")
      assert.strictEqual(input.planVersion, "v1")
      assert.ok(Array.isArray(input.executionGroups))
      assert.ok(input.planningArtifacts)
      assert.strictEqual(typeof (input.planningArtifacts as Record<string, string>).design, "string")
      assert.strictEqual(typeof (input.planningArtifacts as Record<string, string>).executionGroups, "string")

      // Verify return value is mapped correctly
      assert.strictEqual(reviewResult.pass, true)
      assert.strictEqual(reviewResult.reviewFindingsPath, "/tmp/stub-plan-review.md")
      assert.ok(reviewResult.summary)
    } finally {
      await removeTestRepo(repoRoot)
    }
  })

  test("returns pass=false when review service action is not approve", async () => {
    const registry = getZflowRegistry()
    registry.claim({ capability: "review", version: "0.1.0", provider: "test" })

    // Stub that returns "revise-plan"
    const failingService = {
      runPlanReview(_input: unknown) {
        return Promise.resolve({
          action: "revise-plan" as const,
          findingsPath: "/tmp/revised.md",
          tier: "standard",
          severity: { critical: 1, major: 0, minor: 0, nit: 0 },
          coverageNotes: ["Issues found."],
          manifest: { mode: "plan-review", tier: "standard", reviewers: [] },
          nextVersion: "v2" as const,
        })
      },
    }
    registry.provide("review", failingService)

    const reviewResult = await runPlanReview("test-failing", "v1")
    assert.strictEqual(reviewResult.pass, false)
    assert.strictEqual(reviewResult.reviewFindingsPath, "/tmp/revised.md")
    assert.ok(reviewResult.summary.includes("revise-plan"))
  })

  test("fallback when no review service is registered", async () => {
    // Don't register anything — should gracefully degrade
    const repoRoot = await createTestRepo()
    try {
      const reviewResult = await runPlanReview("test-no-service", "v1", repoRoot)
      assert.strictEqual(reviewResult.pass, true)
      assert.ok(reviewResult.reviewFindingsPath)
      assert.ok(reviewResult.reviewFindingsPath!.includes("plan-review"))
      assert.ok(reviewResult.summary.includes("no review service"))
    } finally {
      await removeTestRepo(repoRoot)
    }
  })

  test("fallback when review capability is claimed but no service provided", async () => {
    const registry = getZflowRegistry()
    registry.claim({ capability: "review", version: "0.1.0", provider: "test" })
    // Don't provide the service — optional() returns undefined

    const reviewResult = await runPlanReview("test-not-provided", "v1")
    assert.strictEqual(reviewResult.pass, true)
    assert.ok(reviewResult.summary.includes("no review service"))
  })

  test("handles service that throws", async () => {
    const registry = getZflowRegistry()
    registry.claim({ capability: "review", version: "0.1.0", provider: "test" })
    registry.provide("review", {
      runPlanReview() {
        throw new Error("review explosion")
      },
    })

    const reviewResult = await runPlanReview("test-error", "v1")
    assert.strictEqual(reviewResult.pass, false)
    assert.ok(reviewResult.summary.includes("review explosion"))
  })
})

// ── finalizeCodeReview tests ─────────────────────────────────────

describe("finalizeCodeReview — registry delegation", () => {
  afterEach(() => {
    resetZflowRegistry()
  })

  test("calls canonical runCodeReview on review service when present", async () => {
    const repoRoot = await createTestRepo()
    try {
      // Prepare and implement to create a run
      await runChangePrepareWorkflow({
        cwd: repoRoot,
        changeId: "test-code-review-delegation",
      })
      await approvePlanVersion("test-code-review-delegation", "v1", repoRoot)

      const implResult = await runChangeImplementWorkflow({
        cwd: repoRoot,
        changeId: "test-code-review-delegation",
      })

      // Now register the stub review service
      const registry = getZflowRegistry()
      registry.claim({ capability: "review", version: "0.1.0", provider: "test" })
      const { service, calls } = createStubReviewService()
      registry.provide("review", service)

      // Call finalizeCodeReview
      const codeReviewResult = await finalizeCodeReview(implResult.runId, repoRoot)

      // Verify it delegated to the canonical method
      assert.strictEqual(calls.length, 1, "should make exactly one service call")
      assert.strictEqual(calls[0].method, "runCodeReview", "should call runCodeReview, not codeReview")

      // Verify input shape
      const input = calls[0].args[0] as Record<string, unknown>
      assert.strictEqual(input.source, "Implementation of test-code-review-delegation")
      assert.ok(input.repoPath)
      assert.ok(input.planningArtifacts)
      assert.strictEqual((input.planningArtifacts as Record<string, string>).design, resolvePlanArtifactPath("test-code-review-delegation", "v1", "design", repoRoot))
      assert.strictEqual(input.verificationStatus, "pending")

      // Verify return value
      assert.strictEqual(codeReviewResult.pass, true)
      assert.strictEqual(codeReviewResult.findingsPath, "/tmp/stub-code-review.md")
      assert.ok(codeReviewResult.summary)
    } finally {
      await removeTestRepo(repoRoot)
    }
  })

  test("returns pass=false when code review finds critical or major issues", async () => {
    const repoRoot = await createTestRepo()
    try {
      await runChangePrepareWorkflow({
        cwd: repoRoot,
        changeId: "test-code-review-failing",
      })
      await approvePlanVersion("test-code-review-failing", "v1", repoRoot)
      const implResult = await runChangeImplementWorkflow({
        cwd: repoRoot,
        changeId: "test-code-review-failing",
      })

      const registry = getZflowRegistry()
      registry.claim({ capability: "review", version: "0.1.0", provider: "test" })
      registry.provide("review", {
        runCodeReview(_input: unknown) {
          return Promise.resolve({
            findingsPath: "/tmp/failing-review.md",
            tier: "standard",
            severity: { critical: 1, major: 2, minor: 3, nit: 4 },
            coverageNotes: ["Issues found."],
            manifest: { mode: "code-review", tier: "standard", reviewers: [] },
          })
        },
      })

      const result = await finalizeCodeReview(implResult.runId, repoRoot)
      assert.strictEqual(result.pass, false)
      assert.ok(result.summary.includes("1 critical"))
      assert.ok(result.summary.includes("2 major"))
      assert.ok(result.summary.includes("3 minor"))
    } finally {
      await removeTestRepo(repoRoot)
    }
  })

  test("fallback when no review service is registered", async () => {
    const repoRoot = await createTestRepo()
    try {
      await runChangePrepareWorkflow({
        cwd: repoRoot,
        changeId: "test-code-review-fallback",
      })
      await approvePlanVersion("test-code-review-fallback", "v1", repoRoot)
      const implResult = await runChangeImplementWorkflow({
        cwd: repoRoot,
        changeId: "test-code-review-fallback",
      })

      // Don't register review service
      const result = await finalizeCodeReview(implResult.runId, repoRoot)
      assert.strictEqual(result.pass, true)
      assert.ok(result.summary.includes("no review service"))
    } finally {
      await removeTestRepo(repoRoot)
    }
  })

  test("handles service that throws", async () => {
    const repoRoot = await createTestRepo()
    try {
      await runChangePrepareWorkflow({
        cwd: repoRoot,
        changeId: "test-code-review-error",
      })
      await approvePlanVersion("test-code-review-error", "v1", repoRoot)
      const implResult = await runChangeImplementWorkflow({
        cwd: repoRoot,
        changeId: "test-code-review-error",
      })

      const registry = getZflowRegistry()
      registry.claim({ capability: "review", version: "0.1.0", provider: "test" })
      registry.provide("review", {
        runCodeReview() {
          throw new Error("code review explosion")
        },
      })

      const result = await finalizeCodeReview(implResult.runId, repoRoot)
      assert.strictEqual(result.pass, false)
      assert.ok(result.summary.includes("code review explosion"))
    } finally {
      await removeTestRepo(repoRoot)
    }
  })
})
