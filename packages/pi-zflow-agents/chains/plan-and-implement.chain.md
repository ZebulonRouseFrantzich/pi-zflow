---
name: plan-and-implement
package: zflow
description: |
  End-to-end formal change workflow: explore, plan, validate,
  implement, verify, and apply-back. This is the full artifact-first
  lifecycle suitable for production changes.
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
