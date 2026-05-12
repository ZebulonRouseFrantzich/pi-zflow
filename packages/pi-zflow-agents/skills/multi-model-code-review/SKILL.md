---
name: multi-model-code-review
description: |
  Reviewer roles, severity classification, structured findings format,
  and synthesis rules for adversarial multi-angle code and plan review.
---

# Multi-Model Code Review

Use this skill when performing or synthesising code review findings, either as
a single reviewer or as part of a parallel review swarm.

## Reviewer Roles

Each review angle is assigned to a distinct agent role. The standard set:

| Role            | Focus                                                                                   | Agent name                 |
| --------------- | --------------------------------------------------------------------------------------- | -------------------------- |
| **Correctness** | Logic errors, edge cases, type safety, concurrency, regressions                         | `zflow.review-correctness` |
| **Integration** | API contracts, cross-module coupling, data flow, dependency usage                       | `zflow.review-integration` |
| **Security**    | Injection, auth/authorisation, secrets exposure, input validation, privilege escalation | `zflow.review-security`    |
| **Logic**       | Algorithm soundness, state transitions, invariant preservation, off-by-one, termination | `zflow.review-logic`       |
| **System**      | Performance, scalability, observability, resilience, resource leaks, configuration      | `zflow.review-system`      |

Additional roles (`plan-review-correctness`, `plan-review-integration`,
`plan-review-feasibility`) review planning artifacts rather than code — they
check plan completeness, consistency with project patterns, and practical
feasibility.

## Severity Scheme

All findings use one of four severity levels:

| Severity     | Meaning                                                                                               | Required action                    |
| ------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------- |
| **critical** | Definite bug, security hole, or correctness failure that will cause incorrect behaviour in production | Must fix before merge              |
| **major**    | Likely bug, violation of documented contract, or significant maintainability concern                  | Should fix before merge            |
| **minor**    | Style deviation, potential (not confirmed) issue, or code that is correct but hard to follow          | Fix if convenient; otherwise defer |
| **nit**      | Personal preference, trivial formatting, or speculative improvement                                   | Leave to author's discretion       |

## Structured Findings Format

Each finding should be reported as a structured markdown block:

```markdown
### {severity}: {brief title}

- **File**: `path/to/file.ts` (line N)
- **Role**: {reviewer role name}
- **Observation**: What the code does and why it is a concern.
- **Impact**: What could go wrong (concrete scenario).
- **Suggestion**: How to fix or mitigate (specific, not generic).
- **Plan adherence**: Does the finding relate to a deviation from the approved
  plan? If yes, reference the relevant plan group.
```

Do not include code blocks larger than 15 lines. Reference exact file paths and
line numbers.

## Synthesis Rules

When multiple reviewers produce findings, a **synthesizer** agent merges them:

1. **De-duplicate** — if two reviewers flag the same issue (same file, same
   concern), keep the most detailed entry and credit both reviewers.
2. **Record support/dissent** — note which reviewers agree or disagree on each
   finding. Disagreement is valuable signal, not noise.
3. **Group by severity** — present findings in order: critical, major, minor,
   nit.
4. **Coverage notes** — mention any angles that were not reviewed (e.g.
   "security review was skipped" or "performance not evaluated for cold-start
   path").
5. **Final recommendation** — summarise what must be fixed, what should be
   fixed, and what is optional, with a go/no-go recommendation.

## What Reviewers Do NOT Do

- Reviewers **never edit source files** or write patches. They produce findings.
- Reviewers **never create or modify plan artifacts**.
- Reviewers **never execute code** from untrusted PRs unless explicitly
  instructed and the PR source is trusted.
- Reviewers **do not reduce severity** of their own findings — the synthesizer
  may reclassify.
