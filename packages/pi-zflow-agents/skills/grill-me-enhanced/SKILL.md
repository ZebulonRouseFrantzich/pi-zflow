---
name: grill-me-enhanced
description: |
  Compaction-safe planning intake for pi-zflow change workflows. Use when
  refining `/zflow-change-plan` or `/zflow-change-prepare`, especially when
  you need branch-by-branch questioning, retained context beyond the one-pager,
  and checkpoint artifacts under `.zflow` / runtime state.
---

# Grill Me Enhanced

Use this skill to strengthen zflow change intake before or during planning.

## Core behavior

- Interview the user about the change one branch at a time.
- Provide a recommended answer with each question.
- If a question can be answered from the repository, inspect the repo first.
- Keep the durable `plan.md` concise.
- Preserve richer planning context in file-backed intake artifacts so it is not
  lost during compaction or resume.

## Output boundary

Separate the captured context into two views:

1. **One-pager input** — concise material suitable for the durable `plan.md`
2. **Prepare context** — richer retained context for `/zflow-change-prepare`

Do not force every explored branch into the one-pager.

## Artifact expectations

During intake, write or refresh:

- intake state
- interview log
- checkpoint markdown after meaningful progress
- decision log
- one-pager input
- retained prepare context

These artifacts are canonical for continuing planning after compaction.

## Depth policy

Supported depth modes:

- `dynamic`
- `shallow`
- `standard`
- `deep`
- `exhaustive`

Default to `dynamic` unless the invoking command provided `--depth`.

## zflow-specific rules

- Treat runtime-state intake artifacts as authoritative over transient memory.
- Keep `plan.md` human-reviewable and concise.
- Ensure prepare-stage planning can reread retained intake context.
- Prefer repo evidence before asking the user redundant questions.
- If RuneContext is present, treat canonical RuneContext docs as higher priority
  than ad-hoc interview output.
