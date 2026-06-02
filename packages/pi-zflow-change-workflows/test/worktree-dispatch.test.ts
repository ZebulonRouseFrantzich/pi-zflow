/**
 * worktree-dispatch.test.ts — Unit tests for Task 5.4 worktree dispatch.
 */
import * as assert from "node:assert"
import { test, describe } from "node:test"

import {
  buildWorkerTask,
  buildWorktreeDispatchPlan,
  coalesceConnectedGroups,
  parseExecutionGroupsMd,
} from "../extensions/zflow-change-workflows/orchestration.js"

import type {
  DispatchExecutionGroup,
  WorktreeDispatchConfig,
} from "../extensions/zflow-change-workflows/orchestration.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeGroup(
  id: string,
  files: string[],
  deps: string[] = [],
  agent = "zflow.implement-routine",
  taskPrompt = "",
  scopedVerification?: string,
  coalescedFrom?: string[],
): DispatchExecutionGroup {
  return { id, agent, files, dependencies: deps, taskPrompt, scopedVerification, coalescedFrom }
}

function makeConfig(
  runId = "test-run-001",
  repoRoot = "/tmp/test-repo",
  changeId = "ch42",
  planVersion = "v1",
): WorktreeDispatchConfig {
  return { runId, repoRoot, changeId, planVersion }
}

// ---------------------------------------------------------------------------
// buildWorkerTask
// ---------------------------------------------------------------------------

describe("buildWorkerTask", () => {
  test("includes group id and scope in prompt", () => {
    const group = makeGroup("group-1", ["src/foo.ts", "src/bar.ts"])
    const config = makeConfig()
    const task = buildWorkerTask(group, config)

    assert.ok(task.includes("group-1"))
    assert.ok(task.includes("src/foo.ts"))
    assert.ok(task.includes("src/bar.ts"))
    assert.ok(task.includes("zflow.implement-routine"))
  })

  test("includes run context", () => {
    const group = makeGroup("group-1", ["src/foo.ts"])
    const config = makeConfig("my-run", "/my/repo", "ch99", "v2")
    const task = buildWorkerTask(group, config)

    assert.ok(task.includes("my-run"))
    assert.ok(task.includes("/my/repo"))
    assert.ok(task.includes("ch99"))
    assert.ok(task.includes("v2"))
  })

  test("includes dependencies section when specified", () => {
    const group = makeGroup("group-2", ["src/bar.ts"], ["group-1"])
    const config = makeConfig()
    const task = buildWorkerTask(group, config)

    assert.ok(task.includes("Dependencies"))
    assert.ok(task.includes("group-1"))
  })

  test("omits dependencies section when empty", () => {
    const group = makeGroup("group-1", ["src/foo.ts"])
    const config = makeConfig()
    const task = buildWorkerTask(group, config)

    assert.ok(!task.includes("## Dependencies"))
  })

  test("includes scoped verification command when specified", () => {
    const group = makeGroup("group-1", ["src/foo.ts"], [], "zflow.implement-routine", "", "npm test -- src/foo.test.ts")
    const config = makeConfig()
    const task = buildWorkerTask(group, config)

    assert.ok(task.includes("Scoped verification"))
    assert.ok(task.includes("npm test -- src/foo.test.ts"))
    // Single-command uses "the following command" (singular)
    assert.ok(task.includes("the following command"))
  })

  test("renders multi-command verification separately for coalesced groups", () => {
    const group = makeGroup(
      "group-1~group-2",
      ["src/a.ts", "src/b.ts"],
      [],
      "zflow.implement-routine",
      "Multi-group task",
      "pnpm typecheck\npnpm test\npnpm lint",
      ["group-1", "group-2"],
    )
    const config = makeConfig()
    const task = buildWorkerTask(group, config)

    // Multi-command uses "each of the following" (plural)
    assert.ok(task.includes("each of the following"))
    // Each command rendered in its own code fence
    assert.ok(task.includes("pnpm typecheck"))
    assert.ok(task.includes("pnpm test"))
    assert.ok(task.includes("pnpm lint"))
    // Has numbering
    assert.ok(task.includes("Verification 1"))
    assert.ok(task.includes("Verification 2"))
    assert.ok(task.includes("Verification 3"))
    // No shell-chained verification command in code fences
    const fenceBlocks = task.match(/```bash\n[\s\S]*?\n```/g) || []
    for (const block of fenceBlocks) {
      assert.ok(!block.includes("&&"), `Code fence block should not contain &&: ${block.slice(0, 80)}`)
    }
  })

  test("includes plan artifact paths when provided", () => {
    const group = makeGroup("group-1", ["src/foo.ts"])
    const config = makeConfig()
    const task = buildWorkerTask(group, config, {
      design: "/path/to/design.md",
      "execution-groups": "/path/to/groups.md",
    })

    assert.ok(task.includes("/path/to/design.md"))
    assert.ok(task.includes("/path/to/groups.md"))
  })

  test("includes worker rules section", () => {
    const group = makeGroup("group-1", ["src/foo.ts"])
    const config = makeConfig()
    const task = buildWorkerTask(group, config)

    assert.ok(task.includes("Rules"))
    assert.ok(task.includes("ONLY modify files"))
    assert.ok(task.includes("deviation report"))
    assert.ok(task.includes("temporary commits"))
    assert.ok(task.includes("scoped verification"))
  })

  test("includes output format instructions", () => {
    const group = makeGroup("group-1", ["src/foo.ts"])
    const config = makeConfig()
    const task = buildWorkerTask(group, config)

    assert.ok(task.includes("Output format"))
    assert.ok(task.includes("Summary of changes"))
    assert.ok(task.includes("List of changed files"))
  })

  test("includes narrow coordination contract and fallback intercom target when provided", () => {
    const group = makeGroup("group-1", ["src/foo.ts"])
    const config = {
      ...makeConfig(),
      orchestratorTarget: "zflow-implement-feat-auth-deadbeef",
    }
    const task = buildWorkerTask(group, config)

    assert.ok(task.includes("Control-plane coordination"))
    assert.ok(task.includes("contact_supervisor"))
    assert.ok(task.includes("DRIFT_DETECTED"))
    assert.ok(task.includes("NEED_CLARIFICATION"))
    assert.ok(task.includes("zflow-implement-feat-auth-deadbeef"))
  })
})

// ---------------------------------------------------------------------------
// coalesceConnectedGroups
// ---------------------------------------------------------------------------

describe("coalesceConnectedGroups", () => {
  test("coalesces groups that share files when independent (no dependency path)", () => {
    // Groups sharing a file but with a dependency edge (group-2 -> group-1)
    // should NOT be coalesced; the apply-back will sequence patches correctly.
    const groups = [
      makeGroup("group-1", ["src/app.ts", "src/env.ts"], [], "zflow.implement-routine", "Foundation", "pnpm typecheck"),
      makeGroup("group-2", ["src/app.ts", "src/routes.ts"], ["group-1"], "zflow.implement-routine", "Routes", "pnpm test"),
      makeGroup("group-3", ["test/app.test.ts"], ["group-2"], "zflow.implement-routine", "Tests", "pnpm test"),
    ]

    const coalesced = coalesceConnectedGroups(groups)

    // group-1 and group-2 share src/app.ts but have dependency ordering (2->1),
    // so they are NOT coalesced. group-3 has no file overlap → separate.
    assert.equal(coalesced.length, 3)
    assert.equal(coalesced[0].id, "group-1")
    assert.equal(coalesced[1].id, "group-2")
    assert.deepEqual(coalesced[1].dependencies, ["group-1"])
    assert.equal(coalesced[2].id, "group-3")
    assert.deepEqual(coalesced[2].dependencies, ["group-2"])
  })

  test("coalesces independent groups that share files but have no dependency path", () => {
    // Two groups sharing a file with no dependency edge between them
    // MUST be coalesced to avoid incompatible git patches from the same base.
    const groups = [
      makeGroup("group-a", ["src/shared.ts", "src/feature-a.ts"], [], "zflow.implement-routine", "Feature A", "pnpm test -- featureA"),
      makeGroup("group-b", ["src/shared.ts", "src/feature-b.ts"], [], "zflow.implement-routine", "Feature B", "pnpm test -- featureB"),
    ]

    const coalesced = coalesceConnectedGroups(groups)

    assert.equal(coalesced.length, 1)
    assert.equal(coalesced[0].id, "group-a~group-b")
    assert.deepEqual(coalesced[0].coalescedFrom, ["group-a", "group-b"])
    assert.deepEqual(coalesced[0].files, ["src/shared.ts", "src/feature-a.ts", "src/feature-b.ts"])
    assert.deepEqual(coalesced[0].dependencies, [])
  })

  test("does not coalesce dependency chains without file overlap", () => {
    const groups = [
      makeGroup("group-1", ["src/a.ts"]),
      makeGroup("group-2", ["src/b.ts"], ["group-1"]),
      makeGroup("group-3", ["src/c.ts"], ["group-2"]),
      makeGroup("group-4", ["src/d.ts"], ["group-3"]),
    ]

    const coalesced = coalesceConnectedGroups(groups)

    assert.deepEqual(coalesced.map(g => g.id), ["group-1", "group-2", "group-3", "group-4"])
  })

  test("does not implicitly coalesce planner-declared shared-staging groups", () => {
    const groups = [
      {
        ...makeGroup("group-a", ["src/shared.ts"], [], "zflow.implement-routine", "Shared task A", "pnpm test -- a"),
        executionMode: "shared-staging" as const,
        workspaceId: "auth-cluster",
        workspaceConcurrency: "serialized" as const,
      },
      {
        ...makeGroup("group-b", ["src/shared.ts"], [], "zflow.implement-routine", "Shared task B", "pnpm test -- b"),
        executionMode: "shared-staging" as const,
        workspaceId: "auth-cluster",
        workspaceConcurrency: "serialized" as const,
      },
    ]

    const coalesced = coalesceConnectedGroups(groups)

    assert.deepEqual(coalesced.map(g => g.id), ["group-a", "group-b"])
  })
})

// ---------------------------------------------------------------------------
// buildWorktreeDispatchPlan
// ---------------------------------------------------------------------------

describe("buildWorktreeDispatchPlan", () => {
  test("returns one task per group", () => {
    const groups = [
      makeGroup("group-1", ["src/a.ts"]),
      makeGroup("group-2", ["src/b.ts"]),
    ]
    const config = makeConfig()
    const tasks = buildWorktreeDispatchPlan(groups, config)

    assert.equal(tasks.length, 2)
  })

  test("each task has correct groupId and agent", () => {
    const groups = [
      makeGroup("group-1", ["src/a.ts"], [], "zflow.implement-routine"),
      makeGroup("group-2", ["src/b.ts"], [], "zflow.implement-hard"),
    ]
    const config = makeConfig()
    const tasks = buildWorktreeDispatchPlan(groups, config)

    assert.equal(tasks[0].groupId, "group-1")
    assert.equal(tasks[0].agent, "zflow.implement-routine")
    assert.equal(tasks[1].groupId, "group-2")
    assert.equal(tasks[1].agent, "zflow.implement-hard")
  })

  test("each task has claimedFiles from the group", () => {
    const groups = [
      makeGroup("group-1", ["src/a.ts", "src/b.ts"]),
      makeGroup("group-2", ["src/c.ts"]),
    ]
    const config = makeConfig()
    const tasks = buildWorktreeDispatchPlan(groups, config)

    assert.deepEqual(tasks[0].claimedFiles, ["src/a.ts", "src/b.ts"])
    assert.deepEqual(tasks[1].claimedFiles, ["src/c.ts"])
  })

  test("propagates dependencies and worktree strategy metadata", () => {
    const groups = [{
      ...makeGroup("group-1", ["src/a.ts"], ["group-0"], "zflow.implement-routine", "Shared staged task", "npm test"),
      executionMode: "shared-staging" as const,
      workspaceId: "auth-cluster",
      workspaceConcurrency: "serialized" as const,
      baseStrategy: "dependency-lineage" as const,
      executionRationale: "needs shared type context",
    }]
    const config = makeConfig()
    const tasks = buildWorktreeDispatchPlan(groups, config)

    assert.deepEqual(tasks[0].dependencies, ["group-0"])
    assert.equal(tasks[0].worktreeStrategy?.mode, "shared-staging")
    assert.equal(tasks[0].worktreeStrategy?.workspaceId, "auth-cluster")
    assert.equal(tasks[0].worktreeStrategy?.workspaceConcurrency, "serialized")
    assert.equal(tasks[0].worktreeStrategy?.baseStrategy, "dependency-lineage")
  })

  test("each task has a scopedVerification when provided", () => {
    const groups = [
      makeGroup("group-1", ["src/a.ts"], [], "zflow.implement-routine", "", "npm test"),
    ]
    const config = makeConfig()
    const tasks = buildWorktreeDispatchPlan(groups, config)

    assert.equal(tasks[0].scopedVerification, "npm test")
  })

  test("each task has an output relative path", () => {
    const groups = [
      makeGroup("group-1", ["src/a.ts"]),
      makeGroup("group-2", ["src/b.ts"]),
    ]
    const config = makeConfig()
    const tasks = buildWorktreeDispatchPlan(groups, config)

    assert.ok(tasks[0].outputRelativePath.startsWith("worktree-results/"))
    assert.ok(tasks[0].outputRelativePath.endsWith("-result.md"))
  })

  test("task prompts are populated from buildWorkerTask", () => {
    const groups = [
      makeGroup("group-1", ["src/a.ts"]),
    ]
    const config = makeConfig()
    const tasks = buildWorktreeDispatchPlan(groups, config)

    assert.ok(tasks[0].task.length > 50)
    assert.ok(tasks[0].task.includes("group-1"))
    assert.ok(tasks[0].task.includes("test-run-001"))
  })

  test("passes plan artifacts to buildWorkerTask", () => {
    const groups = [
      makeGroup("group-1", ["src/a.ts"]),
    ]
    const config = makeConfig()
    const artifacts = { design: "/path/to/design.md" }
    const tasks = buildWorktreeDispatchPlan(groups, config, artifacts)

    assert.ok(tasks[0].task.includes("/path/to/design.md"))
  })

  test("returns empty array for no groups", () => {
    const config = makeConfig()
    const tasks = buildWorktreeDispatchPlan([], config)
    assert.equal(tasks.length, 0)
  })
})

// ---------------------------------------------------------------------------
// parseExecutionGroupsMd
// ---------------------------------------------------------------------------

describe("parseExecutionGroupsMd", () => {
  test("parses a valid execution-groups.md content", () => {
    const content = [
      "# Execution Groups",
      "",
      "## Group 1: Implement authentication",
      "",
      "- **Files:** src/auth/login.ts, src/auth/logout.ts",
      "- **Agent:** zflow.implement-routine",
      "- **Dependencies:** group-0",
      "- **Verification:** npm test -- src/auth/",
      "- **Parallelizable:** true",
      "",
    ].join("\n")

    const groups = parseExecutionGroupsMd(content)

    assert.equal(groups.length, 1)
    assert.equal(groups[0].id, "group-1")
    assert.deepStrictEqual(groups[0].files, ["src/auth/login.ts", "src/auth/logout.ts"])
    assert.equal(groups[0].agent, "zflow.implement-routine")
    assert.deepStrictEqual(groups[0].dependencies, ["group-0"])
    assert.equal(groups[0].scopedVerification, "npm test -- src/auth/")
    assert.equal(groups[0].parallelizable, true)
    assert.equal(groups[0].executionMode, "isolated")
    assert.equal(groups[0].workspaceConcurrency, "serialized")
    assert.equal(groups[0].baseStrategy, "head")
  })

  test("parses advanced execution strategy fields", () => {
    const content = [
      "## Group 2: Shared route + handler work",
      "",
      "- **Files:** src/routes.ts, src/handler.ts",
      "- **Agent:** zflow.implement-hard",
      "- **Dependencies:** group-1",
      "- **Scoped verification:** npm test -- route-handler",
      "- **Parallelizable:** false",
      "- **Execution mode:** shared-staging",
      "- **Workspace ID:** auth-route-cluster",
      "- **Workspace concurrency:** concurrent",
      "- **Base strategy:** dependency-lineage",
      "- **Execution rationale:** backend route and frontend handler need shared type feedback before apply-back",
      "",
    ].join("\n")

    const groups = parseExecutionGroupsMd(content)

    assert.equal(groups.length, 1)
    assert.equal(groups[0].executionMode, "shared-staging")
    assert.equal(groups[0].workspaceId, "auth-route-cluster")
    assert.equal(groups[0].workspaceConcurrency, "concurrent")
    assert.equal(groups[0].baseStrategy, "dependency-lineage")
    assert.match(groups[0].executionRationale ?? "", /shared type feedback/)
  })

  test("parses multiple groups", () => {
    const content = [
      "# Execution Groups",
      "",
      "## Group 1: Auth",
      "",
      "- **Files:** src/auth.ts",
      "- **Agent:** zflow.implement-routine",
      "",
      "## Group 2: API",
      "",
      "- **Files:** src/api.ts",
      "- **Agent:** zflow.implement-hard",
      "- **Dependencies:** group-1",
      "- **Verification:** npm test",
      "",
    ].join("\n")

    const groups = parseExecutionGroupsMd(content)

    assert.equal(groups.length, 2)
    assert.equal(groups[0].id, "group-1")
    assert.equal(groups[0].agent, "zflow.implement-routine")
    assert.equal(groups[1].id, "group-2")
    assert.equal(groups[1].agent, "zflow.implement-hard")
    assert.deepStrictEqual(groups[1].dependencies, ["group-1"])
  })

  test("preserves G-prefixed dependency ids for Group G headings", () => {
    const content = [
      "# Execution Groups",
      "",
      "### Group G1 — Backend logic",
      "",
      "- **Files:** src/backend.ts",
      "- **Agent:** worker",
      "- **Dependencies:** none",
      "- **Verification:** npm test -- backend",
      "",
      "### Group G2 — Endpoint wrapper",
      "",
      "- **Files:** src/wrapper.ts",
      "- **Agent:** worker",
      "- **Dependencies:** G1",
      "- **Verification:** npm test -- wrapper",
      "",
    ].join("\n")

    const groups = parseExecutionGroupsMd(content)

    assert.equal(groups.length, 2)
    assert.equal(groups[0].id, "group-g1")
    assert.equal(groups[1].id, "group-g2")
    assert.deepStrictEqual(groups[1].dependencies, ["group-g1"])
  })

  test("parses bold 'Files touched' headers and ignores prose-only verification bullets", () => {
    const content = [
      "# Execution Groups",
      "",
      "### Group G2 — Endpoint wrapper",
      "",
      "- **Files touched (≤7):**",
      "  1. `customer-accessible-apis/functionapps/license-manager/get-oracle-current-entitlements/get-oracle-current-entitlements.ts`",
      "  2. `customer-accessible-apis/functionapps/license-manager/get-oracle-current-entitlements/function.json`",
      "- **Dependencies:** `G1`",
      "- **Scoped verification:**",
      "  - `cd customer-accessible-apis && yarn tsc-all`",
      "  - manual request validation against function signatures for required `company` and `accountId` parameters",
      "  - Both endpoints build successfully and expose the intended read-only Oracle payloads.",
      "",
    ].join("\n")

    const groups = parseExecutionGroupsMd(content)

    assert.equal(groups.length, 1)
    assert.equal(groups[0].id, "group-g2")
    assert.deepStrictEqual(groups[0].dependencies, ["group-g1"])
    assert.deepStrictEqual(groups[0].files, [
      "customer-accessible-apis/functionapps/license-manager/get-oracle-current-entitlements/get-oracle-current-entitlements.ts",
      "customer-accessible-apis/functionapps/license-manager/get-oracle-current-entitlements/function.json",
    ])
    assert.equal(groups[0].scopedVerification, "cd customer-accessible-apis && yarn tsc-all")
  })

  test("returns empty array for empty content", () => {
    const groups = parseExecutionGroupsMd("")
    assert.equal(groups.length, 0)
  })

  test("returns empty array for content with no group headings", () => {
    const groups = parseExecutionGroupsMd("# No groups here\n\nJust some text")
    assert.equal(groups.length, 0)
  })

  test("handles optional fields gracefully", () => {
    const content = [
      "## Group 1: Minimal",
      "",
      "- **Files:** src/file.ts",
      "- **Agent:** zflow.implement-routine",
      "",
    ].join("\n")

    const groups = parseExecutionGroupsMd(content)

    assert.equal(groups.length, 1)
    assert.equal(groups[0].id, "group-1")
    assert.deepStrictEqual(groups[0].dependencies, [])
    assert.equal(groups[0].scopedVerification, undefined)
    assert.equal(groups[0].parallelizable, true)
  })

  test("uses default agent when not specified", () => {
    const content = [
      "## Group 1: No agent specified",
      "",
      "- **Files:** src/file.ts",
      "",
    ].join("\n")

    const groups = parseExecutionGroupsMd(content)

    assert.equal(groups.length, 1)
    assert.equal(groups[0].agent, "zflow.implement-routine")
  })
})
