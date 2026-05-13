/**
 * worktree-dispatch.test.ts — Unit tests for Task 5.4 worktree dispatch.
 */
import * as assert from "node:assert"
import { test, describe } from "node:test"

import {
  buildWorkerTask,
  buildWorktreeDispatchPlan,
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
): DispatchExecutionGroup {
  return { id, agent, files, dependencies: deps, taskPrompt, scopedVerification }
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
