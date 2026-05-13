---
name: implement-and-review
package: zflow
description: |
  Context-builder → implementation → verification → code review pipeline.
  Analyses analogous code patterns, executes a plan group, runs scoped
  verification, then reviews the result with a multi-angle swarm.
  This chain is a per-execution-group building block; the orchestrator
  invokes it once for each group in the approved plan.
---

## builtin:context-builder

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

Execute the assigned implementation group from the approved plan.
Read tests before modifying source. Implement using the plan's
design and standards. Run scoped verification from the plan.
Report what was done, what passed/failed, and any observations.

If the plan is infeasible, file a deviation report and stop.

## zflow.verifier

reads: false
output: false

Run the scoped verification steps from the approved plan on the
implemented changes. Execute each command exactly as specified,
compare against expected outcomes, and report pass/fail with evidence.

## zflow.review-correctness

reads: false
output: false

Review the implementation for correctness: logic errors, edge cases,
type safety, regressions. Read the planning documents before reviewing.
Return structured findings with severity.

## zflow.review-integration

reads: false
output: false

Review the implementation for integration soundness: API contracts,
cross-module coupling, data flow, pattern consistency. Read the
planning documents before reviewing. Return structured findings.

## zflow.synthesizer

reads: false
output: review-findings.md

Synthesise reviewer findings. Deduplicate, record support/dissent,
group by severity, note coverage gaps, produce recommendation.
