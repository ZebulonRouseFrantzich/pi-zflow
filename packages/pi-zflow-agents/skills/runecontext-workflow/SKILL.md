---
name: runecontext-workflow
description: |
  RuneContext change-document flavors, canonical precedence rules, reading
  rules, and how agents should interact with RuneContext documents during
  planning, implementation, and review.
---

# RuneContext Workflow

Use this skill when the repository uses **RuneContext** change documents to
govern planning, implementation, and review. RuneContext documents are the
canonical source of truth for approved change scope within a RuneContext-managed
repo.

## RuneContext Flavors

RuneContext recognises two change-document **flavours**, distinguished by which
files are present in the change folder:

### Plain flavor

A minimal set of documents suitable for simple changes:

```
CHANGE_IN_QUESTION/
  proposal.md         — What change is proposed and why
  design.md           — How the change will be implemented
  standards.md        — Conventions and standards to follow
  verification.md     — Acceptance criteria and test expectations
  status.yaml         — Current lifecycle status (machine-readable)
```

### Verified flavor

An extended set that adds task grouping and reference linking for changes
requiring stronger traceability:

```
CHANGE_IN_QUESTION/
  proposal.md         — What change is proposed and why
  design.md           — How the change will be implemented
  standards.md        — Conventions and standards to follow
  references.md       — External references, RFCs, related changes
  tasks.md            — Task breakdown grouped by implementation phase
  verification.md     — Acceptance criteria and test expectations
  status.yaml         — Current lifecycle status (machine-readable)
```

### Flavour detection

The flavour is determined at resolution time by checking for the presence of
`tasks.md`:

| `tasks.md` present? | Detected flavour | Also requires   |
| ------------------- | ---------------- | --------------- |
| Yes                 | `"verified"`     | `references.md` |
| No                  | `"plain"`        | (no extra)      |

## Canonical Precedence

When multiple documents describe the same change, precedence is:

1. **RuneContext change documents** (proposal.md, design.md, standards.md,
   verification.md, tasks.md if present, references.md if present, status.yaml)
   — highest authority, always the source of truth for approved scope.
2. **Versioned plan artifacts** under `<runtime-state-dir>/plans/{change-id}/v{n}/`
   — operational contract for implementers, derived from (1) but may be
   more detailed.
3. **Derived orchestration aids** (execution-groups.md, widgets, runtime status)
   — lowest precedence, may be regenerated from (1) and (2).

Agents **must** read the RuneContext change documents before starting planning
or implementation work. If a plan artifact contradicts the RuneContext
documents, the RuneContext documents win and the divergence must be flagged.

## Reading Rules

When loading canonical documents from a resolved RuneContext change:

| Rule                               | Description                                                                                                                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Always read `status.yaml`**      | Parsed as structured YAML (not raw text). Contains the lifecycle status ("draft", "active", "review", "completed", etc.) and may include metadata (author, priority, reviewers, dates). |
| **Always read `standards.md`**     | Every flavour includes this file. It constrains how the implementation must be carried out.                                                                                             |
| **Conditional: `tasks.md`**        | If present (verified flavour), read and use it directly for task grouping and verification ordering.                                                                                    |
| **Derived hints: no `tasks.md`**   | If absent (plain flavour), derive task-group hints from `proposal.md + design.md + verification.md` together. Do not expect a task breakdown.                                           |
| **Conditional: `references.md`**   | If present (verified flavour), read it for external reference material.                                                                                                                 |
| **Always read all core documents** | `proposal.md`, `design.md`, `standards.md`, `verification.md`, and `status.yaml` are always present regardless of flavour.                                                              |

### Implementation notes

- The `readRuneContextDocs()` function (from `pi-zflow-runecontext`) implements
  these rules automatically. It reads required files in parallel and parses
  `status.yaml` using the `yaml` library.
- Downstream consumers receive a `RuneDocs` object where optional fields
  (`tasks`, `references`) are `null` when absent.

## Status Handling

| Status      | Meaning                                  | Agent behaviour                                           |
| ----------- | ---------------------------------------- | --------------------------------------------------------- |
| `planning`  | Change is being scoped                   | Read to understand proposal; plan against it              |
| `active`    | Change is approved and being implemented | Use as authoritative scope; deviation requires replanning |
| `review`    | Change is under review                   | Read for context; do not modify without approval          |
| `completed` | Change is done                           | Read for historical context only; do not reopen           |
| `draft`     | Early, not yet ready for planning        | Ask user if they want to formalise it                     |
| `stale`     | Superseded or abandoned                  | Ignore; check for newer version                           |

## Interaction Rules for Agents

- **Planners**: Always read the RuneContext documents first. Treat them as
  canonical input; your plan artifact formalises them with additional detail.
- **Implementers**: Read the RuneContext documents **and** the approved plan
  artifact before starting work. If the plan contradicts the RuneContext
  documents, flag a deviation.
- **Reviewers**: Check plan adherence against both the RuneContext documents
  and the plan artifact.
- **All agents**: Treat `status: completed` docs as read-only. Do not suggest
  reopening them unless explicitly asked.

## Common Pitfalls

| Pitfall                                                            | Why it's wrong                                                                                                                       | Correct approach                                                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Assuming `tasks.md` always exists                                  | Plain flavour changes do not have `tasks.md`. Code that assumes it exists will fail at runtime.                                      | Check the detected flavour or use the `tasks` field which is `null` for plain flavour.                       |
| Reading `status.yaml` as raw text                                  | `status.yaml` contains structured data that drives agent behaviour. Raw-text comparison of `status` values is fragile.               | Parse as YAML and access fields directly (e.g. `docs.status.status`).                                        |
| Treating plan artifacts as higher precedence than RuneContext docs | Plan artifacts are _derived_ from the canonical RuneContext documents. If they diverge, the RuneContext documents are authoritative. | RuneContext docs always win. Flag any divergence.                                                            |
| Using `verification.md` as task list                               | Verification criteria are not the same as task groupings.                                                                            | In plain flavour, derive task hints from proposal + design + verification _together_, not just verification. |
| Silently skipping optional documents                               | `references.md` and `tasks.md` are present only in verified flavour. Silently skipping them when they exist loses information.       | Always check for optional files; the reader handles this automatically.                                      |
