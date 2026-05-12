---
name: plan-drift-protocol
description: |
  Deviation-report structure, drift detection, and the formal escalation
  path when implementation cannot follow the approved plan.
---

# Plan Drift Protocol

Use this skill when a plan deviation is detected during implementation,
verification, or review. Drift occurs when reality does not match the approved
plan artifact.

## What Constitutes Drift

| Situation                                                                   | Is drift? | Action                                   |
| --------------------------------------------------------------------------- | --------- | ---------------------------------------- |
| A file cannot be changed as described because actual code structure differs | Yes       | File deviation report                    |
| A dependency is missing or incompatible                                     | Yes       | File deviation report                    |
| The planned approach introduces a regression or breaks tests                | Yes       | File deviation report                    |
| Scope needs to expand beyond the assigned group's files                     | Yes       | File deviation report                    |
| A better approach is found that still satisfies the plan's goals            | No        | Proceed but document the approach choice |
| A minor variable name differs from the plan's example                       | No        | Not drift; implementation discretion     |
| The verification command fails but the fix is within the group              | No        | Fix and re-run verification              |

## Deviation Report Structure

A deviation report must contain:

```markdown
# Deviation Report

**Change ID**: {changeId}
**Plan Version**: {planVersion}
**Group**: {group number or name}
**Reported by**: {agent name}
**Status**: open | resolved | superseded

## What was planned

{Excerpt from the approved plan: what was supposed to happen}

## What was found

{Actual situation: code structure, constraints, or failures encountered}

## Impact

{What changes are needed to the plan. Which groups are affected.}

## Proposed resolution

{Specific suggestion for how the plan should be updated. This is a
recommendation, not a binding change.}

## Verification

{How the proposed resolution could be verified once implemented}
```

### Status Flow

1. **open** — newly filed deviation, not yet reviewed
2. **resolved** — a new plan version has been created that addresses the
   deviation
3. **superseded** — the deviation is no longer relevant (e.g., the plan was
   abandoned)

## When to File a Deviation Report

File a deviation report **immediately** upon discovering drift:

- **During implementation**: if the planned approach does not work given actual
  code. Stop working and file the report.
- **During verification**: if a verification step fails in a way that cannot be
  fixed within the group's scope. File the report instead of working around the
  failure.
- **During review**: if a reviewer identifies a discrepancy between the plan and
  the implementation that indicates the plan was incomplete or incorrect.
  Flag it, do not fix it.

## What Happens After Filing

1. The orchestrator receives the deviation report.
2. The planner (or a replanning pass) creates a new plan version (e.g. `v2`)
   that incorporates the deviation.
3. All affected groups are reassigned based on the new plan.
4. The deviation report is closed with a reference to the new plan version.

**Do not** continue implementing after filing a deviation. The plan must be
updated first.

## Drift Prevention

- Read the full group spec before starting implementation — not just the task
  description.
- Read tests before modifying source. Tests reveal edge cases the plan may not
  mention.
- When in doubt about scope boundaries, ask rather than assume.
- Use scoped verification from the plan, not ad-hoc checks.
- If a file outside the group needs modification, stop and file a deviation.
  Do not "just make a small fix" outside scope.
