# Future Idea — Cache-Stable Prompt Assembly

> Status: future-ideas planning artifact only.
> Do not implement until explicitly approved.

## Purpose

Increase provider prompt-cache hit rates and reduce token cost by making the
stable portion of pi-zflow prompts more byte-stable across turns, while moving
volatile state and reminders out of the cacheable prefix.

This idea is intended to improve cost, latency, and long-session stability
without changing pi-zflow's core artifact-first workflow model.

## Why this is worth considering

pi-zflow already has several strong prompt-building primitives:

- `APPEND_SYSTEM.md` + root constitution
- mode-specific prompt fragments
- runtime reminder fragments
- compaction handoff injection
- explicit file-backed canonical artifacts
- profile-aware agent launch configuration

Those pieces are modular, but they are not yet explicitly organized around a
"stable prefix vs volatile suffix" cache model. As a result, small changes in
reminders, diagnostic injections, or workflow state may unnecessarily bust the
provider-side prompt cache.

## Repository fit

This proposal aligns with existing pi-zflow design decisions:

- prompt modularity already exists in `pi-zflow-agents`
- compaction reminder ownership already exists in `pi-zflow-compaction`
- profile/lane awareness already exists in `pi-zflow-profiles`
- prompt/document boundary discipline already exists in `docs/prompt-boundary-policy.md`

This proposal should **not** introduce:

- a giant monolithic system prompt
- hidden long-term memory injection
- default provider transport overrides
- opaque prompt rewriting that makes debugging difficult

## Goals

1. Maximize cache reuse for stable prompt content.
2. Reduce unnecessary cache invalidation from volatile reminders and runtime state.
3. Make prompt-shape changes measurable and diagnosable.
4. Preserve pi-zflow's modular prompt-fragment architecture.
5. Keep canonical artifacts file-backed rather than inlining more data into prompts.

## Non-goals

- Do not replace the current prompt-fragment architecture with one giant prompt.
- Do not add a generic memory system.
- Do not add provider-specific prompt transport hacks by default.
- Do not make prompt assembly so dynamic that it becomes hard to reason about.
- Do not capture raw prompt text by default for diagnostics.

## Proposed ownership

| Concern | Owning package | Responsibilities |
| --- | --- | --- |
| Stable/volatile prompt classification | `pi-zflow-agents` | Classify fragments and assembly inputs by cache sensitivity |
| Prompt normalization + fingerprinting | `pi-zflow-core` | Shared hashing, normalization, and diff helpers |
| Reminder placement after compaction | `pi-zflow-compaction` | Ensure reminder injection does not churn the stable prefix unnecessarily |
| Provider-aware guidance | `pi-zflow-profiles` | Detect cache-sensitive profiles and emit guidance/doctor diagnostics |

## Core design model

The prompt pipeline should explicitly distinguish between:

### Stable prompt prefix

Content that should remain byte-stable for as long as possible within the same
session, workflow mode, and role.

Examples:

- root orchestrator constitution
- platform documentation section
- agent role contract
- stable skill guidance
- stable mode fragment content
- stable workflow invariants
- profile/tooling guidance that only changes on actual profile changes

### Volatile prompt suffix or ephemeral state

Content that changes frequently and should not invalidate the stable prefix.

Examples:

- compaction-handoff reminder
- approved-plan-loaded reminder
- drift-detected reminder
- verification-status reminder
- transient diagnostics
- counters, timestamps, and one-turn notices
- turn-local workflow hints

## Stable vs volatile classification rules

### Stable by default

A prompt element belongs in the stable prefix when all of the following are true:

1. It changes rarely within a session.
2. It is role- or mode-defining rather than event-driven.
3. It is safe to reuse for multiple turns without recomputation.
4. It does not contain turn-local runtime state.

### Volatile by default

A prompt element belongs in the volatile layer when any of the following are true:

1. It is triggered by an event.
2. It depends on the latest tool output.
3. It changes with compaction, verification, or drift state.
4. It contains timestamps, counters, or session-local diagnostics.

## Prompt assembly pipeline

The intended assembly model is:

1. Resolve stable prompt inputs.
2. Normalize them into a canonical order and formatting shape.
3. Compute a stable prompt fingerprint.
4. Snapshot the stable prompt for reuse.
5. Append a small volatile layer when needed.
6. Record whether the stable fingerprint changed.

### Conceptual structure

```text
[stable prefix snapshot]
  + root constitution
  + docs section
  + role contract
  + stable mode fragment
  + stable skill guidance

[volatile additions]
  + current reminder(s)
  + transient diagnostics
  + verification or drift state
  + compaction handoff note
```

## Stable prompt snapshot lifecycle

A stable prompt snapshot should be created or refreshed when one of these
meaningful invalidators occurs:

- session start
- active mode entry/exit
- agent role change
- active profile change
- selected tool surface changes materially
- prompt fragment source file changes
- explicit reload or settings refresh

The snapshot should **not** be refreshed merely because:

- a reminder fired
- diagnostics changed
- compaction occurred
- a timestamp or counter changed
- a single tool result changed

## Fingerprinting and normalization

`pi-zflow-core` should provide helpers that normalize and hash stable prompt
inputs so pi-zflow can tell whether the cacheable prefix truly changed.

### Normalization expectations

Normalization should account for:

- line ending normalization
- whitespace normalization where safe
- deterministic section ordering
- deterministic tool list ordering if rendered into prompt text
- deterministic docs path section rendering
- deterministic fragment concatenation order

### Suggested metadata shape

```ts
interface ZflowPromptFingerprint {
  agentName: string
  mode: string | null
  profileName: string | null
  stableFragmentIds: string[]
  skillIds: string[]
  toolSurfaceHash: string | null
  docsSectionHash: string | null
  stablePromptHash: string
}
```

This metadata should be safe to log without storing raw prompt text.

## Reminder placement policy

Runtime reminders should be treated as volatile by default.

### Preferred behavior

- keep stable mode instructions in the stable prefix
- inject runtime reminders as a smaller append-only volatile layer
- prefer message-style injection or clearly delimited reminder sections over
  rewriting the whole stable prompt body

### High-priority reminder classes

These should be explicitly reviewed for cache friendliness:

- `compaction-handoff`
- `approved-plan-loaded`
- `drift-detected`
- `verification-status`
- tool-denied and external-file-change reminders

## Compaction interaction

Compaction is a known cache-sensitive event.

After compaction:

- the stable role/mode prompt should remain reusable if the mode and role did
  not actually change
- only the handoff/reminder layer should change
- file-backed canonical artifacts remain authoritative and must still be reread

The compaction summary should not become part of a growing stable system prompt.

## Provider strategy

This future idea intentionally prioritizes **generic cache-stability work** over
provider-specific overrides.

### First pass

- stabilize prompt shape
- measure cache behavior
- diagnose invalidators

### Optional later pass

Only if justified by actual profile/provider usage, consider provider-specific
optimizations for lanes that benefit from them.

This is especially relevant if Anthropic-compatible lanes become common, but is
not required to deliver value for current zflow profiles.

## Proposed staged rollout

### Stage 1 — classification and instrumentation

- add stable/volatile classifications to prompt-fragment loading and assembly
- add stable prompt fingerprint calculation
- surface fingerprint changes in diagnostics

### Stage 2 — snapshot assembly

- store a stable prompt snapshot per session/mode/role
- reuse the snapshot until a true invalidator occurs
- separate volatile reminder injection from stable prefix generation

### Stage 3 — provider-aware recommendations

- teach profile diagnostics to flag cache-hostile prompt shapes
- add doctor output explaining frequent prompt invalidations
- optionally recommend additional provider-specific tuning when warranted

## Suggested documentation updates if approved

- `README.md` — mention cache-stable prompt assembly as a context/cost strategy
- `docs/prompt-boundary-policy.md` — add stable vs volatile prompt rules
- `docs/compaction-reread-policy.md` — clarify that reminders should not churn the stable prefix
- `docs/skill-loading-policy.md` — clarify how skill injection interacts with prompt stability
- `docs/subagents-integration.md` — document stable prompt snapshot use in launch assembly

## Suggested tests

### Unit tests

- stable prompt fingerprint unchanged when only reminder content changes
- stable prompt fingerprint changes when role/mode/profile truly changes
- normalization produces deterministic hashes for semantically identical content
- fragment ordering remains deterministic

### Integration tests

- repeated turns in the same mode reuse the stable prompt fingerprint
- compaction injects handoff without regenerating the stable prefix unnecessarily
- profile switch invalidates the snapshot exactly once
- role switch invalidates the snapshot exactly once

### Manual validation

- compare cache read/write behavior before and after prompt-stability changes
- inspect doctor output for real cache-busting causes
- verify reminder content is still visible and effective after separation

## Risks and tradeoffs

| Risk | Mitigation |
| --- | --- |
| Over-normalization changes meaning | Normalize only formatting, ordering, and deterministic metadata |
| Hidden prompt state becomes hard to debug | Expose stable fingerprint and assembly diagnostics |
| Reminder separation weakens behavioral steering | Keep reminder injection explicit and inspectable |
| Snapshot reuse causes stale instructions | Invalidate on mode/role/profile/tool-surface changes |

## Open questions

1. Should stable prompt snapshots be persisted only in-memory, or also recorded in runtime metadata for resume diagnostics?
2. Should the stable fingerprint be exposed in `/zflow-help doctor`, a dedicated cache command, or both?
3. Which reminder classes are important enough to remain in system prompt text versus message-level injection?
4. Should planner/reviewer roles use stricter stability rules than general orchestrator turns?

## Approval checklist for future implementation

Before implementation begins, confirm:

- the exact stable/volatile classification policy
- the fingerprint schema and storage location
- the invalidator list
- how reminder injection should be represented at runtime
- which diagnostics surfaces must expose prompt-cache stability metadata
