---
name: change-doc-workflow
description: |
  Ad-hoc and non-RuneContext change documentation for planning-artifact
  creation. Covers artifact structure, decision-completeness expectations,
  and the relationship between change docs and the artifact-first lifecycle.
---

# Change Doc Workflow

Use this skill when producing or consuming planning artifacts that are **not**
governed by a RuneContext change document. RuneContext-governed changes should
use the `runecontext-workflow` skill instead.

## When to Use

- **Ad-hoc planning** — the user asks for a change without a formal RuneContext
  doc already present in the repository.
- **Supplementing existing docs** — a RuneContext doc exists but the planning
  artifact needs to capture decisions, constraints, or execution groups not
  covered by the canonical doc.
- **Non-RuneContext projects** — the repository does not use RuneContext at all;
  all planning flows through this skill.

## Planning Artifact Structure

Each planning artifact has five required parts, written as separate markdown
files under `<runtime-state-dir>/plans/{changeId}/{planVersion}/`:

| Artifact                  | Purpose                                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `design.md`               | Problem statement, solution approach, architecture decisions, affected modules, open questions resolved during planning                                                                                       |
| `execution-groups.md`     | Ordered groups of file operations, each with: owner agent, task description, files touched, dependencies, `reviewTags`, scoped verification steps, expected verification outcome, and optional explicit execution strategy fields for advanced orchestration |
| `standards.md`            | Project conventions, patterns to follow/examples to match, linting/testing expectations, and any non-negotiable quality gates                                                                                 |
| `verification.md`         | How each group is verified: commands to run, manual checks, expected output, failure criteria                                                                                                                 |
| `implementation-tasks.md` | Per-group detailed implementation task specs: likely files touched, context to read, implementation checklist, pseudocode/examples, acceptance criteria, scoped verification, self-checks, and drift triggers |

### Grouping Rules

- Each execution group must touch **≤7 files**.
- A plan must have **≤3 phases** (a phase is a sequence of groups that share a
  milestone).
- Every group must list its **dependencies** (groups that must complete first).
- Every group must specify a **scoped verification** step — not a vague
  "run tests" but concrete commands and expected results.
- Default execution is **isolated** worktree per group. Advanced execution
  strategy fields are optional and should be used sparingly:
  - `Execution mode: isolated | shared-staging`
  - `Workspace ID: <id>` (required for `shared-staging`)
  - `Workspace concurrency: serialized | concurrent` (default `serialized`)
  - `Base strategy: head | dependency-lineage` (default `head`)
  - `Execution rationale: <reason>` (required for any non-default strategy)
- `dependency-lineage` should only be used when a downstream group genuinely
  needs dependency changes present before final apply-back.
- `shared-staging` should only be used when multiple groups need shared
  filesystem/type feedback and should usually start with `serialized`
  concurrency rather than `concurrent`.

## Decision-Completeness

Before a plan is considered ready for approval, the planner must resolve:

- **What** is being changed (scope boundaries, included and excluded files)
- **Why** the change is needed (problem or requirement reference)
- **How** it will be implemented (approach, tradeoffs made)
- **Who** implements each group (assigned agent)
- **Verification** criteria for each group
- **Risks** or open items with owners

If any of these is unresolved, the planner must ask the user via `interview`
rather than guessing.

## Relationship to the Artifact-First Lifecycle

The change-doc workflow is the **planning input** to the artifact-first lifecycle:

```
Change doc (or user request)
  └─→ Planner produces artifacts (design, execution-groups, standards, verification)
      └─→ Plan validator checks completeness and consistency
          └─→ User approves plan (or requests revision)
              └─→ Workers execute approved groups
                  └─→ Verifier confirms each group
```

The planner writes plan artifacts only, not source files. Source mutation is
handled by implementer agents in later phases.

## Key Conventions

- `changeId` should be short, kebab-case, and descriptive (e.g. `add-auth-flow`).
- `planVersion` follows `v1`, `v2`, etc. Replanning increments the version.
- Never mutate a plan artifact after approval. If change is needed, create a new
  plan version and obsolete the previous one.
- RuneContext docs, when present, take precedence over ad-hoc change requests.
  Treat their decisions as canonical starting points.
