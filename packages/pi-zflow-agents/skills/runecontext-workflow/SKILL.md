---
name: runecontext-workflow
description: |
  RuneContext change-document flavors, canonical precedence rules, status
  handling, and how agents should interact with RuneContext documents during
  planning and implementation.
---

# RuneContext Workflow

Use this skill when the repository uses **RuneContext** change documents (files
such as `change.md` or similar structured change descriptions) to govern
planning and implementation. RuneContext documents are the canonical source of
truth for approved change scope.

## RuneContext Flavors

RuneContext documents come in several flavors, distinguished by their
frontmatter or file naming:

| Flavor              | Purpose                                                  | Typical file                         |
| ------------------- | -------------------------------------------------------- | ------------------------------------ |
| **Planning**        | Describes a proposed change before implementation starts | `change.md` or `proposal.md`         |
| **Active**          | Describes an in-progress change with approved scope      | `change.md` with `status: active`    |
| **Completed**       | Documents a finished change for historical reference     | `change.md` with `status: completed` |
| **Decision record** | Captures a single architectural decision                 | `adr/*.md`                           |
| **Review**          | Structured review of a planned or completed change       | `review/*.md`                        |

## Canonical Precedence

When multiple documents describe the same change, precedence is:

1. **Active RuneContext doc** (`status: active`) — highest authority
2. **Approved plan artifact** (under `<runtime-state-dir>/plans/`) — operational
   contract for implementers
3. **Planning RuneContext doc** (`status: planning`) — guiding but not final
4. **Ad-hoc user request** — lowest precedence, should be formalised

Agents **must** check for a RuneContext document before starting planning work.
If found, its decisions are the starting point and may only be refined (not
overridden) through the approved plan artifact.

## Status Handling

| Status      | Meaning                                  | Agent behaviour                                           |
| ----------- | ---------------------------------------- | --------------------------------------------------------- |
| `planning`  | Change is being scoped                   | Read to understand proposal; plan against it              |
| `active`    | Change is approved and being implemented | Use as authoritative scope; deviation requires replanning |
| `completed` | Change is done                           | Read for historical context only; do not reopen           |
| `draft`     | Early, not yet ready for planning        | Ask user if they want to formalise it                     |
| `stale`     | Superseded or abandoned                  | Ignore; check for newer version                           |

## Canonical Doc Detection

Look for RuneContext documents in:

- `<project-root>/change.md`
- `<project-root>/docs/change.md`
- `<project-root>/.rune/change.md`
- `<project-root>/changes/*.md` (for multi-change repos)
- Any file with a `rune` or `change` frontmatter field

Use `read` or `find` to locate them. If multiple exist, the one with
`status: active` wins. If none has `active` status, the most recent
`planning`-status doc is the best starting point.

## Interaction Rules for Agents

- **Planners**: Always check for RuneContext doc first. Treat it as canonical
  input; your plan artifact formalises it.
- **Implementers**: Read the RuneContext doc + approved plan artifact before
  starting work. If the plan contradicts the RuneContext doc, flag a deviation.
- **Reviewers**: Check plan adherence against both the RuneContext doc and the
  plan artifact.
- **All agents**: Treat `status: completed` docs as read-only. Do not suggest
  reopening them unless explicitly asked.
