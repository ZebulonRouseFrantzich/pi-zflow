---
name: plan-and-implement
package: zflow
description: |
  End-to-end formal change workflow: explore, plan, validate,
  prepare context, implement, verify, review, and apply-back.
  This is the full artifact-first lifecycle suitable for production
  changes. The apply-back stage (worktree merge) is deferred to
  Phase 5 and is documented here as a placeholder.
---

## scout

output: context.md
reads: false
progress: true

Explore the codebase and produce a structured context handoff
(`context.md`) covering relevant files, patterns, affected modules,
tests, and constraints.

## zflow.planner-frontier

reads: context.md
progress: true

Read the scout's context and any RuneContext change doc. Produce
the four planning artifacts (design, execution-groups, standards,
verification) using `zflow_write_plan_artifact`.

Follow artifact-first lifecycle rules:

- Decision-complete before writing.
- ≤7 files per group, ≤3 phases.
- Explicit dependencies, assigned agents, scoped verification.

## zflow.plan-validator

reads: false
output: false

Validate planning artifacts. Check all four exist, structural rules
are met, dependencies are consistent, verification is concrete.
Return PASS / FAIL / CONDITIONAL-PASS.

## zflow.plan-review-correctness

reads: false
output: false
conditional: true

Review planning artifacts for logical correctness. This stage runs
only when the plan's reviewTags include "logic" or the orchestrator
determines the plan is complex or high-risk. Check that the design
addresses the change request, dependencies are sound, and edge cases
are accounted for. Return structured findings with severity.

## zflow.plan-review-integration

reads: false
output: false
conditional: true

Review planning artifacts for integration soundness. This stage runs
only when the plan's reviewTags indicate integration-level review is
needed. Check cross-module impacts, API contracts, and data flow
between changed areas. Return structured findings with severity.

## context-builder

reads: false
progress: false

Analyse the codebase for analogous patterns, conventions, and existing
APIs relevant to the implementation group. Return 2–3 focused code
examples with signatures and snippets — not full file dumps. This
context equips the implementation agent with project-specific patterns
to follow.

## zflow.implement-routine

reads: false
progress: true

Execute the first execution group from the approved plan. Read tests
first, implement changes, run scoped verification, report results.
If the plan is infeasible, file a deviation report and stop.

## zflow.verifier

reads: false
output: false

Run scoped verification from the plan's verification steps on the
implemented changes. Report pass/fail with evidence.

## zflow.review-correctness

reads: false
output: false

Review the implemented changes for correctness: logic errors, edge
cases, type safety, regressions. Structured findings with severity.

## zflow.review-integration

reads: false
output: false

Review the implemented changes for integration soundness: API contracts,
cross-module coupling, data flow.

## zflow.synthesizer

reads: false
output: review-findings.md

Synthesise review findings into a consolidated report. Deduplicate,
record support/dissent, note coverage gaps, produce go/no-go
recommendation.

### apply-back

output: false
worktree: true

_This stage is a placeholder for Phase 5 worktree-parallel support._

Apply the worktree changes back to the main branch. When the code
review passes (go recommendation), merge the implementation worktree
changes, update plan artifact statuses, and clean up temporary
worktree directories. When review produces a no-go or conditional-go
with required changes, signal the orchestrator to re-enter the
fix loop.

Implementation notes for Phase 5:

- Uses `pi-subagents` native `worktree: true` for isolated worktrees.
- Reads `review-findings.md` from the prior synthesizer stage to
  determine go/no-go/conditional-go.
- On go: merge worktree to main, update plan status to `applied`.
- On conditional-go: merge changes AND update plan to a new version
  for remaining items.
- On no-go: discard worktree, update plan status to `rejected`.
