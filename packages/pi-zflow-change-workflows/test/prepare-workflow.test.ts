/**
 * prepare-workflow.test.ts — Unit tests for Task 7.5 prepare workflow.
 */
import * as assert from "node:assert"
import { test, describe } from "node:test"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { execFileSync } from "node:child_process"

import {
  runChangePrepareWorkflow,
  updatePlanState,
  bumpPlanVersion,
  markPlanVersionState,
  writeDurablePlanDoc,
} from "../extensions/zflow-change-workflows/orchestration.js"
import { resetZflowRegistry } from "pi-zflow-core"
import { getZflowRegistry } from "pi-zflow-core/registry"

import type {
  PrepareWorkflowOptions,
} from "../extensions/zflow-change-workflows/orchestration.js"

const COMPLETE_PLAN_BODY = [
  "## Summary",
  "",
  "Deliver a read-only Oracle and MSSQL entitlements plan that keeps durable planning in one reviewed plan.md file.",
  "",
  "## Goals / Success Criteria",
  "",
  "- Draft a single reviewed durable plan.md.",
  "- Preserve immutable prepared plan versions under docs/zflow-changes/<id>/<version>/.",
  "",
  "## Scope In",
  "",
  "- Durable planning workflow changes.",
  "- Prepare-time compilation of versioned artifacts.",
  "",
  "## Scope Out",
  "",
  "- Source-code implementation for the target business change.",
  "",
  "## Relevant codebase areas",
  "",
  "- packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/index.ts",
  "- packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts",
  "",
  "## Constraints",
  "",
  "- Keep .zflow as runtime state.",
  "- Keep plan.md human-reviewable.",
  "",
  "## Decisions",
  "",
  "- plan.md is the durable reviewed intake document.",
  "- prepare expands plan.md into versioned artifacts.",
  "",
  "## Risks / Unknowns",
  "",
  "- The plan drafter must produce stable section headings for downstream validation.",
  "",
  "## Proposed execution outline",
  "",
  "1. Read repo-map and reconnaissance.\n2. Draft detailed plan.md.\n3. Review plan.md.\n4. Compile versioned artifacts during prepare.",
  "",
  "## Verification approach",
  "",
  "- Run targeted change-workflow tests covering plan drafting and prepare compilation.",
  "",
  "## Open questions",
  "",
  "- None at this stage.",
].join("\n")

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Create a temporary directory initialized as a git repo so that runtime
 * state path resolution works correctly (git-dir based).
 */
async function createTestRepo(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-test-prepare-"))
  execFileSync("git", ["init"], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  // Configure minimal git user for any future git ops
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  return tmpDir
}

/**
 * Clean up a temporary test repo.
 */
async function removeTestRepo(repoRoot: string): Promise<void> {
  await fs.rm(repoRoot, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runChangePrepareWorkflow", () => {
  test("forwards profile resolution options to the profiles service", async () => {
    const repoRoot = await createTestRepo()
    resetZflowRegistry()
    try {
      let receivedOptions: Record<string, unknown> | undefined
      const registry = getZflowRegistry()
      registry.claim({
        capability: "profiles",
        version: "0.1.0",
        provider: "pi-zflow-profiles",
        sourcePath: "test",
        compatibilityMode: "compatible",
      })
      registry.provide("profiles", {
        ensureResolved: async (_requiredLanes?: string[], options?: Record<string, unknown>) => {
          receivedOptions = options
        },
      })

      const modelRegistry = { marker: "live-model-registry" }
      await runChangePrepareWorkflow({
        cwd: repoRoot,
        changeId: "test-profile-options",
        profileResolutionOptions: {
          repoRoot,
          registry: modelRegistry,
        },
      })

      assert.equal(receivedOptions?.repoRoot, repoRoot)
      assert.equal(receivedOptions?.registry, modelRegistry)
    } finally {
      resetZflowRegistry()
      await removeTestRepo(repoRoot)
    }
  })

  test("creates plan-state.json with draft status", async () => {
    const repoRoot = await createTestRepo()
    try {
      const result = await runChangePrepareWorkflow({
        cwd: repoRoot,
        changeId: "test-feat",
      })

      assert.ok(result.changeId, "changeId should be set")
      assert.strictEqual(result.changeId, "test-feat")
      assert.strictEqual(result.planVersion, "v1")
      assert.ok(result.planStatePath, "planStatePath should be set")
      assert.ok(result.artifactPaths, "artifactPaths should be set")
      assert.ok(result.artifactPaths.design, "design artifact path should be set")
      assert.ok(result.artifactPaths.executionGroups, "executionGroups artifact path should be set")
      assert.ok(result.artifactPaths.standards, "standards artifact path should be set")
      assert.ok(result.artifactPaths.verification, "verification artifact path should be set")

      // Verify plan-state.json was created
      const planStateContent = await fs.readFile(result.planStatePath, "utf-8")
      const planState = JSON.parse(planStateContent)
      assert.strictEqual(planState.lifecycleState, "draft")
      assert.strictEqual(planState.currentVersion, "v1")
      assert.strictEqual(planState.approvedVersion, null)
      assert.ok(planState.versions.v1)
      assert.strictEqual(planState.versions.v1.state, "draft")
    } finally {
      await removeTestRepo(repoRoot)
    }
  })

  test("creates version v1 directory with canonical artifact paths", async () => {
    const repoRoot = await createTestRepo()
    try {
      const result = await runChangePrepareWorkflow({
        cwd: repoRoot,
        changeId: "test-artifacts",
      })

      // Verify version directory was created
      const versionDir = path.dirname(result.artifactPaths.design)
      const dirEntries = await fs.readdir(versionDir)
      // Directory should exist and be empty (artifacts written later by agents)
      assert.ok(dirEntries.length === 0, "version dir should be empty initially")
    } finally {
      await removeTestRepo(repoRoot)
    }
  })

  test("adds state-index entry for the plan", async () => {
    const repoRoot = await createTestRepo()
    try {
      const result = await runChangePrepareWorkflow({
        cwd: repoRoot,
        changeId: "test-index-entry",
      })

      // Verify state-index.json was created with the plan entry
      const stateIndexPath = path.join(repoRoot, ".zflow", "state-index.json")
      const stateIndexContent = await fs.readFile(stateIndexPath, "utf-8")
      const stateIndex = JSON.parse(stateIndexContent)
      const planEntry = stateIndex.entries.find(
        (e: { type: string; id: string }) =>
          e.type === "plan" && e.id === `plan-test-index-entry-v1`,
      )
      assert.ok(planEntry, "plan entry should exist in state index")
      assert.strictEqual(planEntry.status, "draft")
      assert.strictEqual(planEntry.metadata.changeId, "test-index-entry")
    } finally {
      await removeTestRepo(repoRoot)
    }
  })

  test("generates change ID from changePath when not provided", async () => {
    const repoRoot = await createTestRepo()
    try {
      const result = await runChangePrepareWorkflow({
        cwd: repoRoot,
        changePath: "my-feature-change",
      })

      assert.ok(result.changeId, "changeId should be generated")
      assert.strictEqual(result.changeId, "my-feature")
    } finally {
      await removeTestRepo(repoRoot)
    }
  })

  test("generates semantic change ID from change document basename", async () => {
    const repoRoot = await createTestRepo()
    try {
      const result = await runChangePrepareWorkflow({
        cwd: repoRoot,
        changePath: "@docs/change-ideas/cloudflare-target-architecture-combined-spec.md",
      })

      assert.strictEqual(result.changeId, "cloudflare-target-architecture")
    } finally {
      await removeTestRepo(repoRoot)
    }
  })

  test("generates timestamp-only change ID when nothing provided", async () => {
    const repoRoot = await createTestRepo()
    try {
      const result = await runChangePrepareWorkflow({
        cwd: repoRoot,
      })

      assert.ok(result.changeId, "changeId should be generated")
      assert.ok(result.changeId.startsWith("change-"), "changeId should start with 'change-'")
    } finally {
      await removeTestRepo(repoRoot)
    }
  })

  test("warns about unfinished work when changeId has pending runs", async () => {
    const repoRoot = await createTestRepo()
    try {
      // First call — creates plan
      await runChangePrepareWorkflow({
        cwd: repoRoot,
        changeId: "unfinished-test",
      })

      // Second call with same changeId — should log warning about unfinished work
      // (this shouldn't throw)
      const result = await runChangePrepareWorkflow({
        cwd: repoRoot,
        changeId: "unfinished-test",
      })

      assert.strictEqual(result.changeId, "unfinished-test")
    } finally {
      await removeTestRepo(repoRoot)
    }
  })

  test("records durable plan path in runtime metadata when plan.md exists", async () => {
    const repoRoot = await createTestRepo()
    try {
      const planDocPath = await writeDurablePlanDoc("durable-plan-metadata", {
        changeId: "durable-plan-metadata",
      }, {
        repoRoot,
        bodyContent: COMPLETE_PLAN_BODY,
      })

      const result = await runChangePrepareWorkflow({
        cwd: repoRoot,
        changeId: "durable-plan-metadata",
      })

      const planState = JSON.parse(await fs.readFile(result.planStatePath, "utf-8"))
      assert.strictEqual(planState.runtimeMetadata.durablePlanDocPath, planDocPath)
      assert.strictEqual(result.initialPlanState.runtimeMetadata?.durablePlanDocPath, planDocPath)
    } finally {
      await removeTestRepo(repoRoot)
    }
  })

  test("rejects invalid durable plan frontmatter before prepare proceeds", async () => {
    const repoRoot = await createTestRepo()
    try {
      const planDocPath = path.join(repoRoot, "docs", "zflow-changes", "invalid-frontmatter", "plan.md")
      await fs.mkdir(path.dirname(planDocPath), { recursive: true })
      await fs.writeFile(planDocPath, [
        "---",
        "schemaVersion: 2",
        "changeId: invalid-frontmatter",
        "status: draft",
        "sourceMode: adhoc",
        "currentVersion: not-a-version",
        "approvedVersion: null",
        "---",
        "# Plan",
      ].join("\n"), "utf-8")

      await assert.rejects(
        runChangePrepareWorkflow({
          cwd: repoRoot,
          changeId: "invalid-frontmatter",
        }),
        /Durable draft plan frontmatter is invalid/,
      )
    } finally {
      await removeTestRepo(repoRoot)
    }
  })
})

describe("updatePlanState", () => {
  test("updates lifecycle state", async () => {
    const repoRoot = await createTestRepo()
    try {
      // Create initial plan state
      const result = await runChangePrepareWorkflow({
        cwd: repoRoot,
        changeId: "update-test",
      })

      // Update lifecycle state
      await updatePlanState("update-test", {
        lifecycleState: "validated",
      }, repoRoot)

      // Verify update
      const planStateContent = await fs.readFile(result.planStatePath, "utf-8")
      const planState = JSON.parse(planStateContent)
      assert.strictEqual(planState.lifecycleState, "validated")
    } finally {
      await removeTestRepo(repoRoot)
    }
  })

  test("updates approvedVersion and lifecycle state", async () => {
    const repoRoot = await createTestRepo()
    try {
      const result = await runChangePrepareWorkflow({
        cwd: repoRoot,
        changeId: "approve-test",
      })

      // Approve the plan
      await updatePlanState("approve-test", {
        approvedVersion: "v1",
        lifecycleState: "approved",
      }, repoRoot)

      // Verify using the planStatePath returned by runChangePrepareWorkflow
      const planState = JSON.parse(await fs.readFile(result.planStatePath, "utf-8"))
      assert.strictEqual(planState.approvedVersion, "v1")
      assert.strictEqual(planState.lifecycleState, "approved")
    } finally {
      await removeTestRepo(repoRoot)
    }
  })
})
