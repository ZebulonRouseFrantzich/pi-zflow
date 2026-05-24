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

### Implementation Tasks

Each group also has a corresponding section in `implementation-tasks.md` with
detailed task-level specs including:

- **Objective** — what this group changes and why
- **Scope** — explicitly included and excluded changes
- **Likely files touched** — table of file paths, operations, and notes
- **Context to read first** — specific files, tests, or patterns to understand
  before implementing
- **Implementation checklist** — ordered steps for implementation
- **Pseudocode/examples** — illustrative code snippets showing the approach
- **Acceptance criteria** — concrete pass/fail conditions
- **Scoped verification** — specific commands and expected outcomes
- **Self-checks** — items to verify before reporting completion
- **Drift triggers** — conditions that should stop and escalate to replanning

Workers should read both the group spec in `execution-groups.md` and the
corresponding task spec in `implementation-tasks.md` before starting work.

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
2. **Read the implementation task spec** — read the group's section in
   `implementation-tasks.md` for detailed context, pseudocode, acceptance
   criteria, self-checks, and drift triggers.
3. **Read tests first** — before modifying source, read related tests to
   understand expected behaviour and edge cases.
4. **Read existing source** — understand current implementation before changing.
5. **Implement** — make the changes described in the group spec and task spec.
   Do not refactor unrelated code or introduce speculative abstractions.
6. **Run scoped verification** — execute the commands listed in the group's
   verification steps.
7. **Run self-checks** — verify the implementation against the task's
   self-check list before reporting done.
8. **Report** — summarise what was done, what passed/failed, and any
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
