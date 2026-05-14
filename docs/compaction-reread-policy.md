# Compaction Reread Policy

> **Canonical reference for file-backed artifact rereading after compaction.**
> Enforced by the `compaction-handoff` reminder injected after every compaction cycle.

## Core rule

**Compaction may summarize earlier context, but canonical artifacts remain file-backed and should be reread explicitly when exact wording, paths, or implementation details matter.**

The compaction summary produced by `pi-zflow-compaction` / `zflow-compaction` serves as a lightweight orientation aid — it helps the model reorient quickly after context is compressed. It is **not** an authoritative source for:

- Exact file paths and directory names
- Precise function signatures or type definitions
- Approved plan wording, acceptance criteria, or constraints
- Current plan-state phase transitions or completion flags
- Failure-log entries that influence the next attempt

## Canonical artifacts

The following artifacts are **canonical** — they remain as files on disk and must be reread explicitly when their contents are needed for decisions.

### Mandatory rereads (every agent after compaction)

These artifacts contain information essential for continuing work safely.

| Artifact       | File path                               | Purpose                                                  |
| -------------- | --------------------------------------- | -------------------------------------------------------- |
| Plan state     | `<runtime-state-dir>/plan-state.json`   | Current phase, completion flags, version, change ID      |
| Approved plan  | `<runtime-state-dir>/approved-plan.md`  | Exact decisions, acceptance criteria, scope constraints  |
| Repo map       | `<runtime-state-dir>/repo-map.md`       | Current project structure and module locations           |
| Reconnaissance | `<runtime-state-dir>/reconnaissance.md` | Codebase exploration results, conventions, patterns      |
| Failure log    | `<runtime-state-dir>/failure-log.md`    | Recent failures, root causes, prevention recommendations |

### Optional rereads (role-specific)

These artifacts are relevant to specific agent roles after compaction.

| Artifact        | File path                                 | Relevant roles                        |
| --------------- | ----------------------------------------- | ------------------------------------- |
| Review findings | `<runtime-state-dir>/findings.md`         | Code-review agents, synthesizer       |
| Workflow state  | `<runtime-state-dir>/workflow-state.json` | Orchestrator, change-implement agents |

## Reread timing

### After every compaction cycle

Every agent that starts processing after a compaction has completed **must** reread the mandatory artifacts listed above before making decisions that depend on exact artifact content.

### After session resume

When a session is resumed from disk (e.g. after a restart or worktree switch), the same reread requirements apply — do not rely on in-memory or cached summaries of artifact content.

### During the same session (no compaction)

Artifact rereads are not required when no compaction has occurred since the agent started or since the last full artifact read. Agents may rely on their in-context artifact content for the duration of a single uninterrupted turn sequence.

## Mode and reminder restoration

After compaction, the active workflow mode and prompt-reminder state must be restored from runtime metadata **before** continuing. The `pi-zflow-compaction` extension injects the `compaction-handoff` reminder into the next `before_agent_start` event.

The reminder instructs the agent to:

1. Reread canonical file-backed artifacts for exact details
2. Restore the active mode fragment and runtime reminders from metadata
3. Continue the workflow without assuming the compaction summary is exhaustive

## How the policy is enforced

| Layer            | Mechanism                                                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extension hooks  | `pi-zflow-compaction` registers `session_before_compact` and `session_compact` hooks that flag compaction completion                                 |
| Prompt injection | On the next `before_agent_start`, the `compaction-handoff` reminder is appended to the system prompt                                                 |
| Agent guidance   | Agents are trained via skills and role prompts to treat canonical artifacts as authoritative and to reread them after receiving the handoff reminder |
| Documentation    | This policy document provides the reference for all layers                                                                                           |

## Relationship between summary and artifacts

```
Compaction summary                    File-backed artifacts
─────────────────────────             ────────────────────────
Quick orientation                     Authoritative source
May be incomplete or vague            Exact wording, paths, details
Good for "what was discussed"         Good for "what exactly does this say"
Faster to read (summarized)           Requires explicit tool call
```

The model should read the compaction summary for context, then reread specific artifacts when making decisions that depend on exact content.

## Example workflow after compaction

1. Compaction cycle completes
2. `pi-zflow-compaction` sets `pendingCompactionHandoff = true`
3. Next agent starts → receives `compaction-handoff` reminder in system prompt
4. Agent reads the compaction summary for orientation
5. Agent rereads `plan-state.json` and `approved-plan.md` for exact decisions
6. If relevant, agent rereads `repo-map.md` and `reconnaissance.md` for structure
7. Agent continues the workflow with file-backed accuracy

## See also

- `packages/pi-zflow-compaction/extensions/zflow-compaction/index.ts` — extension that enforces this policy
- `packages/pi-zflow-agents/prompt-fragments/reminders/compaction-handoff.md` — the injected reminder content
- `docs/context-guard-policy.md` — prevention layer that reduces waste before compaction
- `docs/rtk-optimizer-config.md` — output compaction configuration
