import * as assert from "node:assert"
import { describe, test } from "node:test"

import {
  backfillImplementationTasksLikelyFiles,
  canonicalizeExecutionGroupsAgentFields,
  canonicalizeImplementationTasksAgentFields,
  normalizeImplementationAgentName,
  type ImplementationAgentGuidance,
} from "../extensions/zflow-change-workflows/orchestration/implementation-agents.js"

const WORKER_GUIDANCE: ImplementationAgentGuidance = {
  roleLabels: ["backend-api", "sdk-client", "cli-integrations"],
  availableAgents: ["planner", "worker"],
  implementationAgents: ["worker"],
  defaultAgent: "worker",
  complexAgent: "worker",
}

describe("implementation agent guidance helpers", () => {
  test("maps canonical role labels to the default real implementation agent", () => {
    const resolution = normalizeImplementationAgentName("backend-api", WORKER_GUIDANCE)
    assert.equal(resolution.resolved, "worker")
    assert.equal(resolution.roleLabel, "backend-api")
    assert.equal(resolution.reason, "role-label")
  })

  test("normalizes zflow agent aliases to discoverable short names", () => {
    const resolution = normalizeImplementationAgentName("zflow.worker", WORKER_GUIDANCE)
    assert.equal(resolution.resolved, "worker")
    assert.equal(resolution.reason, "alias")
  })

  test("canonicalizes execution-groups owner labels into role label plus agent", () => {
    const raw = [
      "# Execution Groups",
      "",
      "## Group 1: Backend work",
      "",
      "- **Files:** src/backend.ts",
      "- **Owner agent:** backend-api",
      "- **Dependencies:** none",
      "- **Scoped verification:** npm test -- backend",
      "- **Parallelizable:** true",
    ].join("\n")

    const canonical = canonicalizeExecutionGroupsAgentFields(raw, WORKER_GUIDANCE)
    assert.equal(canonical.changed, true)
    assert.match(canonical.content, /\*\*Role label:\*\* backend-api/)
    assert.match(canonical.content, /\*\*Agent:\*\* worker/)
  })

  test("canonicalizes implementation-task assigned agents into role label plus agent", () => {
    const raw = [
      "# Implementation Tasks",
      "",
      "## Group 1: Backend work",
      "",
      "Group ID: `group-1`  ",
      "Assigned agent: `backend-api`  ",
      "Dependencies: none",
    ].join("\n")

    const canonical = canonicalizeImplementationTasksAgentFields(raw, WORKER_GUIDANCE)
    assert.equal(canonical.changed, true)
    assert.match(canonical.content, /Assigned role label: `backend-api`/)
    assert.match(canonical.content, /Assigned agent: `worker`/)
  })

  test("backfills placeholder likely-files rows from execution groups", () => {
    const executionGroups = [
      "# Execution Groups",
      "",
      "## Group 1: Backend work",
      "",
      "- **Files:** src/backend.ts, src/backend.test.ts",
      "- **Agent:** worker",
      "- **Dependencies:** none",
      "- **Scoped verification:** npm test -- backend",
      "- **Parallelizable:** true",
    ].join("\n")

    const implementationTasks = [
      "# Implementation Tasks",
      "",
      "## Group 1: Backend work",
      "",
      "Group ID: `group-1`  ",
      "Assigned agent: `worker`  ",
      "Dependencies: none",
      "",
      "### Likely files touched",
      "",
      "| File | Operation | Reason | Notes |",
      "| --- | --- | --- | --- |",
      "| `No files listed in execution-groups.md; stop and report a plan-quality gap before editing.` | modify | Required by group-1 scope | Follow existing local patterns before editing |",
      "",
      "### Context to read first",
      "- `design.md`",
    ].join("\n")

    const canonical = backfillImplementationTasksLikelyFiles(implementationTasks, executionGroups)
    assert.equal(canonical.changed, true)
    assert.match(canonical.content, /`src\/backend\.ts`/)
    assert.match(canonical.content, /`src\/backend\.test\.ts`/)
    assert.doesNotMatch(canonical.content, /No files listed in execution-groups\.md/)
  })
})
