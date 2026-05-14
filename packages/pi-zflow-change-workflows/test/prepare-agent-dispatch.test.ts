/**
 * prepare-agent-dispatch.test.ts — Tests for prepare-agent dispatch hooks.
 *
 * Covers:
 * - `runPrepareAgentsIfAvailable` with no registry service (unavailable path)
 * - `runPrepareAgentsIfAvailable` with a fake registry service that writes
 *   plan artifacts
 * - Wired behaviour via `runChangePrepareWorkflow` recording the
 *   unavailable status in plan-state runtimeMetadata
 */
import * as assert from "node:assert"
import { test, describe } from "node:test"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { execFileSync } from "node:child_process"

import {
  runChangePrepareWorkflow,
  runPrepareAgentsIfAvailable,
} from "../extensions/zflow-change-workflows/orchestration.js"
import type {
  PrepareAgentDispatchResult,
} from "../extensions/zflow-change-workflows/orchestration.js"

import { resolvePlanStatePath, resolvePlanVersionDir, resolveRepoMapPath, resolveReconnaissancePath } from "pi-zflow-artifacts/artifact-paths"
import { getZflowRegistry, resetZflowRegistry } from "pi-zflow-core/registry"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function createTestRepo(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-test-agent-dispatch-"))
  execFileSync("git", ["init"], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  // Create an initial commit so git rev-parse HEAD works
  await fs.writeFile(path.join(tmpDir, "README.md"), "# Test Repo", "utf-8")
  execFileSync("git", ["add", "."], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  return tmpDir
}

async function removeTestRepo(repoRoot: string): Promise<void> {
  await fs.rm(repoRoot, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Tests: runPrepareAgentsIfAvailable — unavailable path
// ---------------------------------------------------------------------------

describe("runPrepareAgentsIfAvailable — unavailable service path", () => {
  test("returns agentDispatchStatus 'unavailable' when no registry service has dispatch methods", async () => {
    // Reset registry to ensure no stale services
    resetZflowRegistry()

    const repoRoot = await createTestRepo()
    try {
      // First create plan state via the workflow
      await runChangePrepareWorkflow({ cwd: repoRoot, changeId: "test-unavailable" })

      // Call runPrepareAgentsIfAvailable — no agent services are registered
      const result = await runPrepareAgentsIfAvailable("test-unavailable", "v1", repoRoot)

      assert.strictEqual(result.dispatched, false)
      assert.strictEqual(result.agentDispatchStatus, "unavailable")
      assert.strictEqual(result.producedOutputs.length, 0)
      assert.strictEqual(result.serviceName, undefined)
      assert.strictEqual(result.methodUsed, undefined)

      // Verify plan-state.json has the unavailable marker
      const planStatePath = resolvePlanStatePath("test-unavailable", repoRoot)
      const planState = JSON.parse(await fs.readFile(planStatePath, "utf-8"))
      assert.ok(planState.runtimeMetadata, "runtimeMetadata should exist")
      assert.strictEqual(planState.runtimeMetadata.agentDispatchStatus, "unavailable")
      assert.ok(planState.runtimeMetadata.agentCheckedAt, "agentCheckedAt should be set")
    } finally {
      await removeTestRepo(repoRoot)
    }
  })
})

// ---------------------------------------------------------------------------
// Tests: runPrepareAgentsIfAvailable — fake service path
// ---------------------------------------------------------------------------

describe("runPrepareAgentsIfAvailable — fake service path", () => {
  test("dispatches via a registry service exposing a dispatch method", async () => {
    resetZflowRegistry()

    const repoRoot = await createTestRepo()
    try {
      // Register a fake "orchestration" capability with a dispatch method
      const registry = getZflowRegistry()
      registry.claim({
        capability: "orchestration",
        version: "0.1.0",
        provider: "test",
        sourcePath: import.meta.url,
      })
      registry.provide("orchestration", {
        dispatch: async (ctx: {
          changeId: string
          planVersion: string
          cwd: string
          artifactPaths: Record<string, string>
        }) => {
          // Simulate an agent that writes a design.md artifact
          const dir = path.dirname(ctx.artifactPaths.design)
          await fs.mkdir(dir, { recursive: true })
          await fs.writeFile(ctx.artifactPaths.design, "# Agent-Generated Design\n\nContent from fake dispatch service.", "utf-8")
          await fs.writeFile(ctx.artifactPaths.executionGroups, "# Execution Groups\n\nAgent-generated groups.", "utf-8")
        },
      })

      // Create plan state first
      await runChangePrepareWorkflow({ cwd: repoRoot, changeId: "test-fake-service" })

      // Call runPrepareAgentsIfAvailable
      const result = await runPrepareAgentsIfAvailable("test-fake-service", "v1", repoRoot)

      assert.strictEqual(result.dispatched, true)
      assert.strictEqual(result.agentDispatchStatus, "dispatched")
      assert.strictEqual(result.serviceName, "orchestration")
      assert.strictEqual(result.methodUsed, "dispatch")
      assert.ok(result.producedOutputs.length >= 2, "should have produced at least 2 output files")

      // Verify artifacts were actually written
      const versionDir = resolvePlanVersionDir("test-fake-service", "v1", repoRoot)
      const designContent = await fs.readFile(path.join(versionDir, "design.md"), "utf-8")
      assert.ok(designContent.includes("Agent-Generated Design"), "design.md should have agent-generated content")

      const egContent = await fs.readFile(path.join(versionDir, "execution-groups.md"), "utf-8")
      assert.ok(egContent.includes("Agent-generated groups"), "execution-groups.md should have agent-generated content")

      // Verify plan-state.json has the dispatched marker
      const planStatePath = resolvePlanStatePath("test-fake-service", repoRoot)
      const planState = JSON.parse(await fs.readFile(planStatePath, "utf-8"))
      assert.ok(planState.runtimeMetadata, "runtimeMetadata should exist")
      assert.strictEqual(planState.runtimeMetadata.agentDispatchStatus, "dispatched")
      assert.strictEqual(planState.runtimeMetadata.agentDispatchService, "orchestration")
      assert.strictEqual(planState.runtimeMetadata.agentDispatchMethod, "dispatch")
      assert.ok(planState.runtimeMetadata.agentDispatchedAt, "agentDispatchedAt should be set")
    } finally {
      await removeTestRepo(repoRoot)
    }
  })

  test("falls through when registry service has no dispatch methods", async () => {
    resetZflowRegistry()

    const repoRoot = await createTestRepo()
    try {
      // Register a service that has NO dispatch methods
      const registry = getZflowRegistry()
      registry.claim({
        capability: "agents",
        version: "0.1.0",
        provider: "test",
        sourcePath: import.meta.url,
      })
      registry.provide("agents", {
        checkInstallStatus: async () => ({ installed: true }),
        formatInstallSummary: () => "installed",
      })

      await runChangePrepareWorkflow({ cwd: repoRoot, changeId: "test-no-dispatch-methods" })

      const result = await runPrepareAgentsIfAvailable("test-no-dispatch-methods", "v1", repoRoot)

      // Should report unavailable because no dispatch methods were found
      assert.strictEqual(result.dispatched, false)
      assert.strictEqual(result.agentDispatchStatus, "unavailable")
      assert.strictEqual(result.producedOutputs.length, 0)

      // Verify plan-state reflects unavailable
      const planStatePath = resolvePlanStatePath("test-no-dispatch-methods", repoRoot)
      const planState = JSON.parse(await fs.readFile(planStatePath, "utf-8"))
      assert.strictEqual(planState.runtimeMetadata.agentDispatchStatus, "unavailable")
    } finally {
      await removeTestRepo(repoRoot)
    }
  })

  test("reports failure when dispatch method throws", async () => {
    resetZflowRegistry()

    const repoRoot = await createTestRepo()
    try {
      const registry = getZflowRegistry()
      registry.claim({
        capability: "agent-runtime",
        version: "0.1.0",
        provider: "test",
        sourcePath: import.meta.url,
      })
      registry.provide("agent-runtime", {
        runAgent: async (_ctx: unknown) => {
          throw new Error("Intentional dispatch failure for testing")
        },
      })

      await runChangePrepareWorkflow({ cwd: repoRoot, changeId: "test-dispatch-fail" })

      const result = await runPrepareAgentsIfAvailable("test-dispatch-fail", "v1", repoRoot)

      assert.strictEqual(result.dispatched, false)
      assert.strictEqual(result.agentDispatchStatus, "failed")
      assert.strictEqual(result.serviceName, "agent-runtime")
      assert.strictEqual(result.methodUsed, "runAgent")
      assert.ok(result.error, "should include error message")
      assert.ok(result.error!.includes("Intentional dispatch failure"), "error should contain original message")

      // Verify plan-state records the failure
      const planStatePath = resolvePlanStatePath("test-dispatch-fail", repoRoot)
      const planState = JSON.parse(await fs.readFile(planStatePath, "utf-8"))
      assert.strictEqual(planState.runtimeMetadata.agentDispatchStatus, "failed")
      assert.strictEqual(planState.runtimeMetadata.agentDispatchService, "agent-runtime")
      assert.ok(planState.runtimeMetadata.agentDispatchError, "agentDispatchError should be set")
      assert.ok(planState.runtimeMetadata.agentDispatchError!.includes("Intentional dispatch failure"))
    } finally {
      await removeTestRepo(repoRoot)
    }
  })

  test("detects runSubagent method as compatible dispatch method", async () => {
    resetZflowRegistry()

    const repoRoot = await createTestRepo()
    try {
      const registry = getZflowRegistry()
      registry.claim({
        capability: "subagent",
        version: "0.1.0",
        provider: "test",
        sourcePath: import.meta.url,
      })
      registry.provide("subagent", {
        subagent: async (ctx: { artifactPaths?: Record<string, string> }) => {
          // Write a standards artifact
          if (ctx.artifactPaths?.standards) {
            await fs.mkdir(path.dirname(ctx.artifactPaths.standards), { recursive: true })
            await fs.writeFile(ctx.artifactPaths.standards, "# Agent Standards\n\nContent from subagent.", "utf-8")
          }
        },
      })

      await runChangePrepareWorkflow({ cwd: repoRoot, changeId: "test-subagent-method" })

      const result = await runPrepareAgentsIfAvailable("test-subagent-method", "v1", repoRoot)

      assert.strictEqual(result.dispatched, true)
      assert.strictEqual(result.agentDispatchStatus, "dispatched")
      assert.strictEqual(result.serviceName, "subagent")
      assert.strictEqual(result.methodUsed, "subagent")

      // Verify the artifact was written
      const versionDir = resolvePlanVersionDir("test-subagent-method", "v1", repoRoot)
      const standardsContent = await fs.readFile(path.join(versionDir, "standards.md"), "utf-8")
      assert.ok(standardsContent.includes("Agent Standards"))
    } finally {
      await removeTestRepo(repoRoot)
    }
  })
})

// ---------------------------------------------------------------------------
// Tests: Wired into runChangePrepareWorkflow
// ---------------------------------------------------------------------------

describe("runChangePrepareWorkflow — agent dispatch wiring", () => {
  test("records agentDispatchStatus unavailable in plan-state runtimeMetadata via full workflow", async () => {
    resetZflowRegistry()

    const repoRoot = await createTestRepo()
    try {
      // Run the full prepare workflow with no agent service registered
      const result = await runChangePrepareWorkflow({
        cwd: repoRoot,
        changeId: "test-workflow-unavailable",
      })

      // After workflow returns, the plan-state should have been updated
      // by the internal call to runPrepareAgentsIfAvailable
      const planState = JSON.parse(await fs.readFile(result.planStatePath, "utf-8"))

      // runtimeMetadata should now contain the agent dispatch status
      assert.ok(planState.runtimeMetadata, "runtimeMetadata should exist")
      assert.strictEqual(planState.runtimeMetadata.agentDispatchStatus, "unavailable")

      // The repoMapPath/reconnaissancePath are only in the returned
      // initialPlanState object, not in the persisted plan-state (existing
      // behaviour — the caller uses the return value for those paths).
      assert.ok(result.initialPlanState.runtimeMetadata, "returned initialPlanState should have runtimeMetadata")
      assert.ok(result.initialPlanState.runtimeMetadata!.repoMapPath, "repoMapPath should be set in returned object")
      assert.ok(result.initialPlanState.runtimeMetadata!.reconnaissancePath, "reconnaissancePath should be set in returned object")
    } finally {
      await removeTestRepo(repoRoot)
    }
  })

  test("does not interfere with existing runtimeMetadata fields", async () => {
    resetZflowRegistry()

    const repoRoot = await createTestRepo()
    try {
      // Verify that agentDispatchStatus merges cleanly without clobbering
      const result = await runChangePrepareWorkflow({
        cwd: repoRoot,
        changeId: "test-metadata-merge",
      })

      const planState = JSON.parse(await fs.readFile(result.planStatePath, "utf-8"))

      // New agent dispatch field should be added alongside any existing fields
      assert.strictEqual(planState.runtimeMetadata.agentDispatchStatus, "unavailable")

      // The returned object still has repoMapPath/reconnaissancePath
      assert.ok(result.initialPlanState.runtimeMetadata!.repoMapPath, "repoMapPath should still exist in returned object")
      assert.ok(result.initialPlanState.runtimeMetadata!.reconnaissancePath, "reconnaissancePath should still exist in returned object")
    } finally {
      await removeTestRepo(repoRoot)
    }
  })
})
