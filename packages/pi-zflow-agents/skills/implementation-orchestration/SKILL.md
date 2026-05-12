---
name: implementation-orchestration
description: |
  Execution-group discipline, task ownership, worker behaviour, and the
  deviation protocol for multi-agent implementation workflows.
---

# Implementation Orchestration

Use this skill when orchestrating implementer agents (workers) that execute
approved plan groups, or when acting as an implementer yourself.

## Execution Groups

The planner divides the approved change into **execution groups**, each
captured in the `execution-groups.md` plan artifact. Each group specifies:

- **Assigned agent** — which implementer executes this group
- **Task description** — what to do
- **Files touched** — exact file paths
- **Dependencies** — groups that must complete first
- **Review tags** — aspects a reviewer should check (e.g. `security`, `perf`)
- **Scoped verification** — concrete commands and expected outcomes
- **Expected verification** — pass/fail criteria

### Group Constraints

- Each group touches **≤7 files**. If a change requires more, split into
  multiple groups.
- The plan has **≤3 phases** (milestones). Groups within a phase can run in
  parallel if they have no interdependencies.
- Groups in different phases are sequential; phase N+1 starts only after all
  groups in phase N are verified.

## Task Ownership

- Each worker owns **exactly one group** at a time.
- A worker must not modify files outside its assigned group unless the plan
  explicitly permits shared setup/teardown.
- If a group is too large or complex, the worker files a deviation report (see
  `plan-drift-protocol` skill) instead of silently expanding scope.

## Worker Discipline

When executing a group, follow this sequence:

1. **Read the group spec** — understand the task, files, dependencies, and
   verification from `execution-groups.md`.
2. **Read tests first** — before modifying source, read related tests to
   understand expected behaviour and edge cases.
3. **Read existing source** — understand current implementation before changing.
4. **Implement** — make the changes described in the group spec. Do not refactor
   unrelated code or introduce speculative abstractions.
5. **Run scoped verification** — execute the commands listed in the group's
   verification steps.
6. **Report** — summarise what was done, what passed/failed, and any
   observations.

### Tool Guidance

- Prefer `multi-edit` (via the `edit` tool with `patch` or `multi` parameter)
  for multi-file groups.
- Use `bash` for verification commands.
- Use `grep`/`rg`/`find` for navigation — not full `read` of every file if a
  targeted search suffices.

## Deviation Protocol

If a worker encounters a situation where the plan group is infeasible:

1. **Stop executing** the group immediately. Do not continue with partial or
   modified scope.
2. **File a deviation report** — see `plan-drift-protocol` for structure.
3. **Return the deviation report** to the orchestrator. Do not attempt to
   replan unilaterally.
4. The orchestrator (or planner) will create a new plan version that addresses
   the deviation.

Examples of infeasibility:

- The planned approach doesn't work given actual code structure.
- A dependency is missing or incompatible.
- The change requires modifying files outside the assigned group.
- The verification steps cannot pass with the planned implementation.
