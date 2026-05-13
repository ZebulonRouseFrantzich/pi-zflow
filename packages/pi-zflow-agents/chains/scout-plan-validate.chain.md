---
name: scout-plan-validate
package: zflow
description: |
  Exploration → planning → validation → conditional plan review.
  Builtin `scout` explores the codebase, planner-frontier produces
  structured artifacts, plan-validator checks structural correctness,
  and plan reviewers verify correctness/integration/feasibility when
  the plan is complex or high-risk.
---

## Orchestrator notes — conditional plan-review stages

The plan-review stages at the end of this chain (`zflow.plan-review-correctness`
and `zflow.plan-review-feasibility`) are **conditional** — the orchestrator
should only include them when the plan's `reviewTags` are not `standard`.

| reviewTags value         | Reviewers to include                                             |
| ------------------------ | ---------------------------------------------------------------- |
| `standard`               | None — skip plan-review stages entirely                          |
| `logic`                  | `zflow.plan-review-correctness`                                  |
| `system`                 | `zflow.plan-review-correctness`, `zflow.plan-review-feasibility` |
| `logic,system` (or both) | Both reviewers                                                   |

The condition is evaluated by the orchestrator before dispatching this chain.
When the chain is run without plan-review stages, it terminates after
`zflow.plan-validator` (the structural validation result is the final output).
When plan-review stages are included, `zflow.plan-validator` output is passed
as context alongside the planning artifacts.

---

## scout

output: context.md
reads: false
progress: true

Explore the codebase for the requested change. Read relevant files,
search for patterns, identify affected modules, and produce a structured
context handoff (`context.md`) that the planner can use.

Focus on:

- The specific files, modules, and patterns relevant to the change request.
- Existing tests, types, and API contracts that the plan must respect.
- Dependencies and constraints that affect feasibility.

## zflow.planner-frontier

reads: context.md, change.md
progress: true

Read the scout's context handoff and any RuneContext change doc. Then
produce the four planning artifacts (design, execution-groups, standards,
verification) using `zflow_write_plan_artifact`.

Follow the rules from `change-doc-workflow` skill:

- ≤7 files per group, ≤3 phases.
- Every group has dependencies, assigned agent, scoped verification.
- Decisions must be complete before writing artifacts.
- RuneContext docs take precedence when present.

## zflow.plan-validator

reads: false
output: false

Validate the planning artifacts for completeness, internal consistency,
and structural rule adherence. Check that all four artifacts exist,
groups respect file/phase limits, dependencies are consistent, and
verification steps are concrete.

Return a structured validation report (PASS / FAIL / CONDITIONAL-PASS).
If FAIL, stop and return the report for replanning.

## zflow.plan-review-correctness

reads: false
output: false
skills: change-doc-workflow, runecontext-workflow

Review the planning artifacts for logical correctness. This step runs
only for complex or high-risk plans (determined by the orchestrator).
Checks that the design addresses the change request, dependencies are
sound, and edge cases are accounted for.

Findings reported as structured markdown with severity levels.

## zflow.plan-review-feasibility

reads: false
output: false
skills: change-doc-workflow, code-skeleton, repository-map

Review the planning artifacts for practical feasibility. Verifies file
and path existence, module structure alignment, and effort realism.
This step runs only for complex or high-risk plans.
