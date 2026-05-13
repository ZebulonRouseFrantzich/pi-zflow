---
name: parallel-review
package: zflow
description: |
  Parallel multi-angle code review swarm. Runs a base set of reviewers
  (correctness, integration, security) concurrently against the current
  changes, then synthesises findings. Optional reviewers (logic, system)
  are included only when the plan's reviewTags or change complexity
  requires deeper algorithmic or system-level analysis.
---

## Orchestrator notes — optional reviewer selection

The base reviewers (`zflow.review-correctness`, `zflow.review-integration`,
`zflow.review-security`) always run. The optional reviewers
(`zflow.review-logic`, `zflow.review-system`) are conditionally included
by the orchestrator:

| Condition                                      | Include logic | Include system |
| ---------------------------------------------- | :-----------: | :------------: |
| Plan reviewTags include `logic`                |      ✅       |       —        |
| Plan reviewTags include `system`               |       —       |       ✅       |
| Plan reviewTags include `logic,system`         |      ✅       |       ✅       |
| Change involves novel algorithms or state      |      ✅       |       —        |
| Change has performance/scalability constraints |       —       |       ✅       |
| Default (simple/boilerplate/CRUD)              |       —       |       —        |

The orchestrator evaluates these conditions before dispatching the chain.
When optional reviewers are excluded, the chain runs with only the base
reviewers plus the synthesizer.

---

## zflow.review-correctness

output: false
progress: false

Review the current code changes for correctness: logic errors, edge
cases, type safety, concurrency issues, regressions. Read the planning
documents and the diff before reviewing.

Use severity: critical / major / minor / nit.
Return structured findings with file paths and line numbers.

## zflow.review-integration

output: false
progress: false

Review the current code changes for integration soundness: API contracts,
cross-module coupling, data flow, pattern consistency. Read the planning
documents and the diff before reviewing.

Use severity: critical / major / minor / nit.
Return structured findings with file paths and line numbers.

## zflow.review-security

output: false
progress: false

Review the current code changes for security concerns: injection vectors,
auth/authorisation gaps, secrets exposure, input validation failures.
Read the planning documents and the diff before reviewing.

Use severity: critical / major / minor / nit.
Return structured findings with file paths and line numbers.

## zflow.review-logic

output: false
progress: false

Review the current code changes for algorithmic soundness: state
transitions, invariant preservation, off-by-one errors, termination.
Read the planning documents and the diff before reviewing.

Use severity: critical / major / minor / nit.
Return structured findings with file paths and line numbers.

## zflow.review-system

output: false
progress: false

Review the current code changes for system-level concerns: performance,
scalability, observability, resilience, resource management. Read the
planning documents and the diff before reviewing.

Use severity: critical / major / minor / nit.
Return structured findings with file paths and line numbers.

## zflow.synthesizer

reads: false
output: review-findings.md

Synthesise all reviewer findings into a consolidated report.
Deduplicate overlapping findings, record support/dissent, group by
severity, note coverage gaps (which reviewers participated and whether
any angles were missed), and produce a go/no-go recommendation.
