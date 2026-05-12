---
name: plan-review-swarm
package: zflow
description: |
  Parallel plan-review swarm. Runs all three plan-review agents
  (correctness, integration, feasibility) concurrently against the
  planning artifacts, then synthesises findings into a consolidated
  plan-review report.
---

## zflow.plan-review-correctness

output: false
progress: false

Review the planning artifacts for logical correctness. Check that the
design addresses the change request, execution groups produce the
intended outcome, dependencies are sound, and edge cases are accounted
for. Read all four artifacts before reviewing.

Use severity: critical / major / minor / nit.
Return structured findings.

## zflow.plan-review-integration

output: false
progress: false

Review the planning artifacts for integration soundness. Check that
the plan accounts for cross-module impacts, API contracts, data flow
between changed areas, and consistency with existing architecture.
Use the repository-map skill to orient yourself.

Use severity: critical / major / minor / nit.
Return structured findings.

## zflow.plan-review-feasibility

output: false
progress: false

Review the planning artifacts for practical feasibility. Verify that
referenced files and paths actually exist, the module structure
aligns with the planned approach, and the effort is realistic. Use
the code-skeleton and repository-map skills.

Use severity: critical / major / minor / nit.
Return structured findings with evidence.

## zflow.plan-validator

output: false
progress: false

Run a structural validation pass on the planning artifacts. Check
that all four artifacts exist, groups respect ≤7 files and ≤3 phases,
dependencies are consistent, and verification steps are concrete.
Report PASS / FAIL / CONDITIONAL-PASS.

## zflow.synthesizer

reads: false
output: plan-review-findings.md

Synthesise all plan-review findings into a consolidated report.
Deduplicate, record support/dissent, group by severity, note coverage
gaps, produce a go/no-go or conditional-go recommendation for the
plan.
