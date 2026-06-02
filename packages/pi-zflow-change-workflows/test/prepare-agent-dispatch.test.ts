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
  writeDurablePlanDoc,
} from "../extensions/zflow-change-workflows/orchestration.js"
import type {
  PrepareAgentDispatchResult,
} from "../extensions/zflow-change-workflows/orchestration.js"

import { resolvePlanStatePath, resolvePlanVersionDir, resolveRepoMapPath, resolveReconnaissancePath } from "pi-zflow-artifacts/artifact-paths"
import { getZflowRegistry, resetZflowRegistry } from "pi-zflow-core/registry"
import { DISPATCH_SERVICE_CAPABILITY } from "pi-zflow-core/dispatch-service"

const COMPLETE_PLAN_BODY = [
  "## Summary",
  "",
  "Use a durable plan entrypoint and preserve immutable version directories for prepared artifacts.",
  "",
  "## Goals / Success Criteria",
  "",
  "- Prepare consumes plan.md context.",
  "- Versioned docs remain immutable.",
  "",
  "## Scope In",
  "",
  "- Durable plan.md loading during prepare.",
  "",
  "## Scope Out",
  "",
  "- Source implementation for the target business change.",
  "",
  "## Relevant codebase areas",
  "",
  "- packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts",
  "- docs/zflow-changes/durable-plan-dispatch/plan.md",
  "",
  "## Constraints",
  "",
  "- Keep .zflow runtime-only.",
  "",
  "## Decisions",
  "",
  "- plan.md is the durable intake doc.",
  "",
  "## Risks / Unknowns",
  "",
  "- Planner dispatch must receive durable plan context explicitly.",
  "",
  "## Proposed execution outline",
  "",
  "1. Read durable plan.md.\n2. Feed it into planner dispatch.\n3. Generate versioned docs.",
  "",
  "## Verification approach",
  "",
  "- Run targeted prepare-agent dispatch tests.",
  "",
  "## Open questions",
  "",
  "- None.",
].join("\n")

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
  test("dispatches planner-frontier via zflow-dispatch runAgent with a real agent task", async () => {
    resetZflowRegistry()

    const repoRoot = await createTestRepo()
    try {
      const registry = getZflowRegistry()
      let receivedInput: any = null
      registry.claim({
        capability: DISPATCH_SERVICE_CAPABILITY,
        version: "0.1.0",
        provider: "test-dispatch",
        sourcePath: import.meta.url,
      })
      registry.provide(DISPATCH_SERVICE_CAPABILITY, {
        name: "test-dispatch",
        runAgent: async (input: any) => {
          receivedInput = input
          const versionDir = resolvePlanVersionDir("test-zflow-dispatch", "v1", repoRoot)
          await fs.mkdir(versionDir, { recursive: true })
          await fs.writeFile(path.join(versionDir, "design.md"), "# Design\n", "utf-8")
          await fs.writeFile(path.join(versionDir, "execution-groups.md"), "# Execution Groups\n", "utf-8")
          await fs.writeFile(path.join(versionDir, "standards.md"), "# Standards\n", "utf-8")
          await fs.writeFile(path.join(versionDir, "verification.md"), "# Verification\n", "utf-8")
          return { ok: true, rawOutput: "done", outputPath: path.join(versionDir, "planner-frontier-output.md") }
        },
        runParallel: async () => ({ ok: true, results: [] }),
      })
      registry.claim({
        capability: "profiles",
        version: "0.1.0",
        provider: "test-profiles",
        sourcePath: import.meta.url,
      })
      registry.provide("profiles", {
        getResolvedAgentBinding: async (agentName: string) => ({
          agent: agentName,
          resolvedModel: "openai-codex/gpt-5.4",
        }),
      })

      await runChangePrepareWorkflow({ cwd: repoRoot, changeId: "test-zflow-dispatch" })
      const result = await runPrepareAgentsIfAvailable(
        "test-zflow-dispatch",
        "v1",
        repoRoot,
        "docs/change.md",
        "normal idea file",
      )

      assert.strictEqual(result.dispatched, true)
      assert.strictEqual(result.agentDispatchStatus, "dispatched")
      assert.strictEqual(result.serviceName, DISPATCH_SERVICE_CAPABILITY)
      assert.strictEqual(result.methodUsed, "runAgent")
      assert.strictEqual(receivedInput.agent, "zflow.planner-frontier")
      assert.strictEqual(receivedInput.model, "openai-codex/gpt-5.4")
      assert.match(receivedInput.task, /changeId `test-zflow-dispatch`/)
      assert.match(receivedInput.task, /Change input path: docs\/change\.md/)
      assert.match(receivedInput.task, /Additional user notes: normal idea file/)
    } finally {
      await removeTestRepo(repoRoot)
    }
  })

  test("canonicalizes role labels into real implementation agents in generated artifacts", async () => {
    resetZflowRegistry()

    const repoRoot = await createTestRepo()
    try {
      const registry = getZflowRegistry()
      let receivedInput: any = null
      registry.claim({
        capability: DISPATCH_SERVICE_CAPABILITY,
        version: "0.1.0",
        provider: "test-dispatch",
        sourcePath: import.meta.url,
      })
      registry.provide(DISPATCH_SERVICE_CAPABILITY, {
        name: "test-dispatch",
        listAgents: async () => ["planner", "worker"],
        runAgent: async (input: any) => {
          receivedInput = input
          const versionDir = resolvePlanVersionDir("test-canonicalize-agents", "v1", repoRoot)
          await fs.mkdir(versionDir, { recursive: true })
          await fs.writeFile(path.join(versionDir, "design.md"), "# Design\n\nDetailed design body.\n", "utf-8")
          await fs.writeFile(path.join(versionDir, "execution-groups.md"), [
            "# Execution Groups",
            "",
            "## Group 1: Backend work",
            "",
            "- **Files:** src/backend.ts",
            "- **Owner agent:** backend-api",
            "- **Dependencies:** none",
            "- **Scoped verification:** npm test -- backend",
            "- **Parallelizable:** true",
            "",
          ].join("\n"), "utf-8")
          await fs.writeFile(path.join(versionDir, "standards.md"), "# Standards\n\nDetailed standards body.\n", "utf-8")
          await fs.writeFile(path.join(versionDir, "verification.md"), "# Verification\n\n```bash\nnpm test -- backend\n```\n", "utf-8")
          await fs.writeFile(path.join(versionDir, "implementation-tasks.md"), [
            "# Implementation Tasks",
            "",
            "## Group 1: Backend work",
            "",
            "Group ID: `group-1`  ",
            "Assigned agent: `backend-api`  ",
            "Dependencies: none",
            "",
            "### Objective",
            "Implement backend work.",
            "",
            "### Scope",
            "Included: backend work only.",
            "",
            "### Likely files touched",
            "- src/backend.ts",
            "",
            "### Context to read first",
            "- src/backend.ts",
            "",
            "### Implementation checklist",
            "1. Read the code.",
            "2. Make the change.",
            "",
            "### Pseudocode / implementation sketch",
            "- Update the backend path.",
            "",
            "### Acceptance criteria",
            "- Backend verification passes.",
            "",
            "### Scoped verification",
            "- npm test -- backend",
            "",
            "### Self-check before completion",
            "- Confirm only backend scope changed.",
            "",
            "### Drift triggers",
            "- Missing backend file.",
          ].join("\n"), "utf-8")
          return { ok: true, rawOutput: "done", outputPath: path.join(versionDir, "planner-frontier-output.md") }
        },
        runParallel: async () => ({ ok: true, results: [] }),
      })
      registry.claim({
        capability: "profiles",
        version: "0.1.0",
        provider: "test-profiles",
        sourcePath: import.meta.url,
      })
      registry.provide("profiles", {
        getResolvedAgentBinding: async (agentName: string) => ({
          agent: agentName,
          resolvedModel: "openai-codex/gpt-5.4",
        }),
      })

      await runChangePrepareWorkflow({ cwd: repoRoot, changeId: "test-canonicalize-agents" })
      const result = await runPrepareAgentsIfAvailable("test-canonicalize-agents", "v1", repoRoot)

      assert.strictEqual(result.dispatched, true)
      assert.match(receivedInput.task, /Use ONLY these real implementation agent names in `\*\*Agent:\*\*`: `worker`/)
      assert.match(receivedInput.task, /Do NOT put role labels like `backend-api`, `sdk-client`, or `cli-integrations` in `\*\*Agent:\*\*`/)

      const versionDir = resolvePlanVersionDir("test-canonicalize-agents", "v1", repoRoot)
      const executionGroups = await fs.readFile(path.join(versionDir, "execution-groups.md"), "utf-8")
      assert.match(executionGroups, /\*\*Role label:\*\* backend-api/)
      assert.match(executionGroups, /\*\*Agent:\*\* worker/)
      assert.doesNotMatch(executionGroups, /\*\*Owner agent:\*\* backend-api/)

      const implementationTasks = await fs.readFile(path.join(versionDir, "implementation-tasks.md"), "utf-8")
      assert.match(implementationTasks, /Assigned role label: `backend-api`/)
      assert.match(implementationTasks, /Assigned agent: `worker`/)

      const planStatePath = resolvePlanStatePath("test-canonicalize-agents", repoRoot)
      const planState = JSON.parse(await fs.readFile(planStatePath, "utf-8"))
      assert.deepStrictEqual(planState.runtimeMetadata.availableImplementationAgents, ["worker"])
      assert.deepStrictEqual(planState.runtimeMetadata.canonicalRoleLabels, ["backend-api", "sdk-client", "cli-integrations"])
    } finally {
      await removeTestRepo(repoRoot)
    }
  })

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

  test("includes durable plan.md context in planner dispatch tasks", async () => {
    resetZflowRegistry()

    const repoRoot = await createTestRepo()
    let receivedInput: any = null
    try {
      const registry = getZflowRegistry()
      registry.claim({
        capability: DISPATCH_SERVICE_CAPABILITY,
        version: "0.1.0",
        provider: "test-dispatch",
        sourcePath: import.meta.url,
      })
      registry.provide(DISPATCH_SERVICE_CAPABILITY, {
        name: "test-dispatch",
        runAgent: async (input: any) => {
          receivedInput ??= input
          const versionDir = resolvePlanVersionDir("durable-plan-dispatch", "v1", repoRoot)
          await fs.mkdir(versionDir, { recursive: true })
          await fs.writeFile(
            path.join(versionDir, "design.md"),
            "# Design\n\nThis design preserves the durable plan entrypoint and keeps immutable version directories for prepared artifacts.",
            "utf-8",
          )
          await fs.writeFile(
            path.join(versionDir, "execution-groups.md"),
            [
              "# Execution Groups",
              "",
              "## Group 1: Durable plan plumbing",
              "",
              "- **Files:** docs/zflow-changes/durable-plan-dispatch/plan.md, packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts",
              "- **Scoped verification:** npx tsx --test packages/pi-zflow-change-workflows/test/draft-plan-doc.test.ts",
              "- **Agent:** zflow.implement-routine",
              "- **Dependencies:** none",
              "- **Parallelizable:** false",
              "",
              "Update prepare to consume durable plan.md context while preserving immutable versioned outputs.",
            ].join("\n"),
            "utf-8",
          )
          await fs.writeFile(
            path.join(versionDir, "standards.md"),
            "# Standards\n\nKeep plan.md human-reviewable, keep .zflow runtime-only, and keep prepared versions immutable.",
            "utf-8",
          )
          await fs.writeFile(
            path.join(versionDir, "verification.md"),
            "# Verification\n\n```bash\nnpx tsx --test packages/pi-zflow-change-workflows/test/draft-plan-doc.test.ts\n```",
            "utf-8",
          )
          await fs.writeFile(
            path.join(versionDir, "implementation-tasks.md"),
            [
              "# Implementation Tasks",
              "",
              "## Group 1: Durable plan plumbing",
              "",
              "### Objective",
              "Consume plan.md during prepare without replacing immutable version directories.",
              "",
              "### Checklist",
              "1. Read durable plan.md.",
              "2. Feed its content into planner dispatch.",
              "3. Preserve versioned prepared docs.",
            ].join("\n"),
            "utf-8",
          )
          return { ok: true, rawOutput: "done" }
        },
        runParallel: async () => ({ ok: true, results: [] }),
      })
      registry.claim({
        capability: "profiles",
        version: "0.1.0",
        provider: "test-profiles",
        sourcePath: import.meta.url,
      })
      registry.provide("profiles", {
        getResolvedAgentBinding: async (agentName: string) => ({
          agent: agentName,
          resolvedModel: "openai-codex/gpt-5.4",
        }),
      })

      const durablePlanPath = await writeDurablePlanDoc("durable-plan-dispatch", {
        changeId: "durable-plan-dispatch",
      }, {
        repoRoot,
        bodyContent: COMPLETE_PLAN_BODY,
      })

      const result = await runChangePrepareWorkflow({
        cwd: repoRoot,
        changeId: "durable-plan-dispatch",
        prepareNotes: "manual note",
      })

      const planState = JSON.parse(await fs.readFile(result.planStatePath, "utf-8"))
      assert.strictEqual(planState.runtimeMetadata.durablePlanDocPath, durablePlanPath)
      assert.match(receivedInput.task, /Durable draft plan.md path:/)
      assert.match(receivedInput.task, /Use a durable plan entrypoint and preserve immutable version directories for prepared artifacts\./)
      assert.match(receivedInput.task, /manual note/)
    } finally {
      await removeTestRepo(repoRoot)
    }
  })
})
