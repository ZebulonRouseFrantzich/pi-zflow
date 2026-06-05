# Future Idea — Grill-Me-Enhanced Change Intake for `/zflow-change-plan` and `/zflow-change-prepare`

> Status: future-ideas planning artifact only.
> Do not implement until explicitly approved.

## Important policy note

This document proposes a **zflow-owned adaptation** of the popular community
skill [`grill-me`](https://github.com/mattpocock/skills/blob/main/skills/productivity/grill-me/SKILL.md).

It should **not** be adopted as a verbatim external skill dependency and should
**not** bypass existing ownership rules in the pi-zflow foundation.

In particular:

- `pi-interview` remains the **human-in-the-loop owner** for interactive user prompts
- `pi-zflow-agents` remains the owner for zflow skills and prompt assets
- `pi-zflow-change-workflows` remains the owner for `/zflow-change-plan` and `/zflow-change-prepare`
- `pi-zflow-artifacts` remains the owner for runtime-state storage and checkpoint artifacts
- `pi-zflow-compaction` remains the owner for post-compaction reminder behavior

This idea is about introducing a **zflow-specific intake/interview capability**
that borrows the best workflow qualities of `grill-me` while fitting the
artifact-first zflow lifecycle.

## Purpose

Improve the quality of early planning for `/zflow-change-plan` and
`/zflow-change-prepare` by adding a structured, persistent, repo-aware
interview flow that:

1. explores missing decisions more deeply than the current simple prompt intake
2. writes checkpoint artifacts under `.zflow/` so progress survives compaction
3. keeps the durable `plan.md` one-pager concise
4. ensures richer planning context is carried into the full prepare-stage
   artifact set and is **not lost**
5. supports adaptive interview depth by default, with explicit `--depth`
   override support

## Why this is worth considering

The current planning flow already has strong foundations:

- `/zflow-change-plan` creates a durable human-reviewed `plan.md` entrypoint
- `/zflow-change-prepare` creates the formal versioned planning artifacts
- `pi-interview` already exists for structured HITL capture
- `pi-zflow-artifacts` already provides zflow-owned runtime-state storage
- `pi-zflow-compaction` already handles compaction reminders and file-backed rereads

However, the current intake experience is still relatively thin at the start of
planning:

- `/zflow-change-plan` currently asks for a basic description and optional change id
- the planning agent is expected to infer a strong one-pager mostly from repo exploration + a short prompt seed
- richer user intent, tradeoffs, exclusions, rollout constraints, and edge-case decisions may remain under-captured
- if a long planning conversation compacts before the important decisions are
  turned into durable artifacts, some nuance may be lost from active context

A zflow-specific `grill-me` adaptation would improve this by capturing planning
intent as a **persistent intake artifact stream**, instead of relying only on
transient conversation context.

## External inspiration: what is useful about `grill-me`

The upstream `grill-me` skill is intentionally simple and strong:

- interview the user relentlessly about a plan/design
- walk down each decision branch one at a time
- provide a recommended answer with each question
- prefer codebase exploration when a question can be answered from the repo

Those behaviors are a strong fit for zflow planning, especially for:

- clarifying scope boundaries
- surfacing hidden assumptions
- resolving dependencies between decisions
- avoiding unnecessary user questions when the repo already contains evidence

## Why zflow needs a customized version instead of raw reuse

A direct reuse of `grill-me` would be insufficient for zflow because zflow also
needs:

- file-backed checkpointing under `.zflow/`
- explicit separation between **one-pager summary** and **full retained context**
- carry-forward of interview output from `/zflow-change-plan` into `/zflow-change-prepare`
- depth policy that can be dynamic by default and explicitly overridden via command flag
- integration with RuneContext precedence and artifact-first planning policy
- compaction-safe reread behavior for canonical intake artifacts

## Repository fit

This proposal aligns with current pi-zflow decisions:

- artifact-first planning already exists in `pi-zflow-change-workflows`
- runtime-state durability already exists in `pi-zflow-artifacts`
- human-in-the-loop routing already exists via `pi-interview`
- skill ownership already exists in `pi-zflow-agents`
- compaction reread policy already exists in `docs/compaction-reread-policy.md`
- prompt/skill boundary discipline already exists in `docs/prompt-boundary-policy.md` and `docs/skill-loading-policy.md`

This proposal should **not** introduce:

- a hidden long-term memory system
- a second HITL package that competes with `pi-interview`
- raw prompt transcript persistence by default as the only source of truth
- a giant always-loaded interview prompt bundle
- a second durable change-doc system that competes with `plan.md` or RuneContext

## Relationship to the current command model

### Current `/zflow-change-plan`

Today, `/zflow-change-plan` primarily produces:

- a durable `plan.md` entrypoint in `docs/zflow-changes/{changeId}/plan.md`
- repo analysis artifacts like repo map and reconnaissance
- a draft one-pager body produced by the planning agent

### Current `/zflow-change-prepare`

Today, `/zflow-change-prepare` primarily produces:

- formal versioned planning artifacts under `<runtime-state-dir>/plans/{changeId}/{planVersion}/`
- validation, review, and publish flow for the five required plan artifacts

### Proposed enhancement

The future intake layer would sit **between raw user request and durable plan generation**.

Conceptually:

```text
user request / change seed
  └─→ adaptive grill interview
       ├─→ checkpoint artifacts in .zflow/
       ├─→ concise one-pager input for plan.md
       └─→ retained rich prepare-context artifact
            └─→ /zflow-change-plan writes plan.md
            └─→ /zflow-change-prepare reads retained context and generates fuller artifacts
```

## Goals

1. Improve one-pager `plan.md` quality without making it bloated.
2. Preserve richer intake context beyond what belongs in the one-pager.
3. Ensure intake context survives compaction, resume, and longer planning sessions.
4. Make `/zflow-change-prepare` consume the retained intake context so it is not lost.
5. Support adaptive questioning depth by default.
6. Support explicit `--depth` override for both commands.
7. Prefer repo evidence over unnecessary user questioning where possible.
8. Keep the implementation aligned with current ownership boundaries.

## Non-goals

- Do not turn `plan.md` into a full interview transcript.
- Do not make every planning session exhaustive by default.
- Do not create a second canonical durable change doc that competes with RuneContext or `plan.md`.
- Do not bypass `pi-interview` for structured questioning.
- Do not require raw conversation history to reconstruct the intake.
- Do not make prepare depend on unstructured transcript text alone.

## Proposed ownership

| Concern                                        | Owning package              | Responsibilities                                                                                                |
| ---------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Zflow-specific `grill-me` adaptation           | `pi-zflow-agents`           | Custom skill markdown, related prompt fragments, possibly a planner-specific intake skill or helper asset       |
| Command integration and depth policy           | `pi-zflow-change-workflows` | Invoke intake flow from `/zflow-change-plan` and `/zflow-change-prepare`, parse `--depth`, manage handoff rules |
| Interview UI and answer capture                | `pi-interview`              | Structured question presentation and response collection                                                        |
| Checkpoint artifacts and carry-forward context | `pi-zflow-artifacts`        | Storage paths, atomic writes, lifecycle helpers for intake checkpoints and prepare-context artifacts            |
| Post-compaction reread reminders               | `pi-zflow-compaction`       | Ensure intake checkpoint artifacts are reread after compaction when planning resumes                            |
| RuneContext-aware intake merging               | `pi-zflow-runecontext`      | Ensure canonical RuneContext documents still take precedence when present                                       |

## Design principles

1. **Artifact-first, not transcript-first** — important intake context must become files quickly.
2. **One-pager stays concise** — `plan.md` remains a durable entrypoint, not a full interview log.
3. **No lost context** — retained context must survive compaction and be reusable by prepare.
4. **Ask only what matters** — favor repo evidence before asking the user.
5. **Depth adapts to risk** — default behavior should not over-interview trivial changes.
6. **Versioned planning stays authoritative** — prepare artifacts remain the formal execution contract.
7. **Clear boundary between summary and carry-forward context** — not every detail belongs in every artifact.

## Proposed skill behavior

The customized zflow skill should keep the core strengths of `grill-me` while
adding zflow-specific obligations.

### Base behavior retained from `grill-me`

- Ask one question at a time.
- Provide a recommended answer with each question.
- Walk the decision tree branch by branch.
- If the question can be answered by repo exploration, explore the repo instead.

### New zflow-specific behavior

- After each meaningful step, write a checkpoint artifact.
- Distinguish between:
  - **one-pager-worthy information**
  - **carry-forward planning context**
  - **open unresolved questions**
- Maintain a normalized decision log, not just freeform Q/A text.
- Emit a prepare-context artifact that `/zflow-change-prepare` can consume.
- Track current interview depth mode and stopping rationale.
- Emit explicit evidence references when a question was answered by repo exploration.

## Core design model

The intake system should produce **two planning views** from the same interview.

### 1. One-pager summary view

This is the material that belongs in durable `plan.md`.

Examples:

- summary of the requested change
- success criteria
- scope in / scope out
- relevant codebase areas
- key constraints
- major decisions
- high-level risks
- high-level execution outline
- verification approach
- only the most material open questions

### 2. Retained prepare-context view

This is the richer context that should **not** be lost even if it does not all
fit in `plan.md`.

Examples:

- alternative approaches considered and rejected
- branch-by-branch clarifications gathered during the interview
- role and stakeholder assumptions
- rollout nuance and environment assumptions
- non-primary edge cases
- evidence-backed answers derived from repo reads
- user preference details too fine-grained for the one-pager
- question lineage showing why a later decision was asked

The retained prepare-context view should be file-backed and loadable by
`/zflow-change-prepare`.

## Proposed artifact model

The intake flow should persist its state under zflow runtime state.

### Suggested pre-prepare paths

```text
<runtime-state-dir>/plans/{changeId}/intake/intake-state.json
<runtime-state-dir>/plans/{changeId}/intake/interview-log.jsonl
<runtime-state-dir>/plans/{changeId}/intake/checkpoints/checkpoint-0001.md
<runtime-state-dir>/plans/{changeId}/intake/checkpoints/checkpoint-0002.md
<runtime-state-dir>/plans/{changeId}/intake/decision-log.md
<runtime-state-dir>/plans/{changeId}/intake/prepare-context.md
<runtime-state-dir>/plans/{changeId}/intake/one-pager-input.md
```

### Suggested versioned snapshot paths during prepare

```text
<runtime-state-dir>/plans/{changeId}/v{planVersion}/intake-context.md
<runtime-state-dir>/plans/{changeId}/v{planVersion}/intake-decisions.json
```

This preserves both:

- the evolving pre-prepare intake state
- the exact intake snapshot used to generate a given formal plan version

## Suggested data model

### Intake state

```ts
interface ZflowChangeIntakeState {
  changeId: string;
  sourceMode: "adhoc" | "runecontext";
  depthMode: "dynamic" | "shallow" | "standard" | "deep" | "exhaustive";
  status: "active" | "paused" | "ready-for-plan" | "ready-for-prepare";
  askedQuestionCount: number;
  resolvedDecisionCount: number;
  unresolvedQuestionCount: number;
  latestCheckpointPath: string | null;
  planDocPath: string | null;
  prepareContextPath: string | null;
  lastUpdatedAt: string;
}
```

### Interview log entry

```ts
interface ZflowChangeIntakeLogEntry {
  id: string;
  timestamp: string;
  kind: "question" | "answer" | "repo-evidence" | "decision" | "checkpoint";
  branch: string;
  summary: string;
  recommendation?: string | null;
  evidencePaths?: string[];
  carryForward: "one-pager" | "prepare-only" | "both" | "none";
}
```

### Depth decision metadata

```ts
interface ZflowChangeIntakeDepthDecision {
  mode: "dynamic" | "shallow" | "standard" | "deep" | "exhaustive";
  reason: string;
  riskSignals: string[];
  branchExpansionAllowed: boolean;
}
```

## Checkpoint policy

Checkpointing is central to this idea.

### When to checkpoint

The system should checkpoint after:

- each answered user question
- each repo-derived answer that materially changes the plan
- each closed decision branch
- each depth escalation or de-escalation event
- before and after compaction-sensitive transitions
- before handing off from `/zflow-change-plan` output generation into prepare consumption

### What a checkpoint should contain

Each checkpoint should be a compact, rereadable artifact containing:

- the current decision summary
- key unresolved questions
- latest evidence-backed findings
- current depth mode
- what belongs in the one-pager so far
- what must be carried forward to prepare
- the latest canonical artifact pointers

### Why this matters for compaction

If compaction occurs, the agent should be able to reread:

- `intake-state.json`
- latest checkpoint markdown
- `decision-log.md`
- `prepare-context.md`

and continue without depending on the compressed conversation summary.

## One-pager boundary policy

The durable `plan.md` should remain a **one-pager-plus** artifact rather than a
planning dump.

### Include in `plan.md`

- the best concise statement of intent
- critical scope boundaries
- key design decisions
- high-level risks and verification strategy
- the most decision-shaping open questions

### Exclude from `plan.md`

- full Q/A transcript
- every explored branch
- every secondary preference note
- all rejected alternatives in exhaustive detail
- transient or low-value exploration noise

### Preserve elsewhere

Anything excluded from `plan.md` but still useful for full planning should go to
`prepare-context.md` and the intake checkpoint stream.

## How `/zflow-change-plan` would use the future intake flow

### Proposed sequence

1. Resolve change seed and initial description.
2. Start zflow-specific grill interview.
3. Explore repo evidence before asking the user where possible.
4. Persist checkpoints after each material branch/decision.
5. Generate `one-pager-input.md` from normalized intake state.
6. Draft durable `plan.md` from the one-pager input, not from the raw interview alone.
7. Persist `prepare-context.md` for later prepare-stage consumption.

### Intended result

`/zflow-change-plan` becomes better at producing a strong durable one-pager
without needing to embed all planning nuance inside the one-pager itself.

## How `/zflow-change-prepare` would use the future intake flow

### Proposed sequence

1. Read durable `plan.md`.
2. Read retained intake artifacts (`prepare-context.md`, checkpoints, decision log).
3. If coverage appears insufficient, optionally continue the interview using the existing intake state rather than starting over.
4. Snapshot the intake context into the selected plan version.
5. Generate the full planning artifact set using both the one-pager and retained intake context.

### Why this is important

This ensures the additional context collected during the intake interview is not
lost just because it was intentionally excluded from the concise one-pager.

## Dynamic depth model

Depth should be **dynamic by default**.

### Default behavior

The system should begin with a moderate interview posture and adjust based on:

- ambiguity of the request
- scope size and cross-cutting impact
- presence of risky categories (auth, schema, migrations, rollout, compatibility)
- amount of repo evidence available
- number of unresolved branches still affecting planning quality
- whether the change is RuneContext-backed or purely ad hoc

### Suggested depth levels

```text
dynamic      - adaptive default
shallow      - minimal clarifications only
standard     - balanced planning interview
deep         - aggressively walk important branches
exhaustive   - near-relentless branch exploration
```

### Suggested stop conditions for `dynamic`

Dynamic mode should stop when the system has enough confidence that:

1. the one-pager can be drafted well
2. the remaining unresolved items are either low-risk or already captured as explicit open questions
3. further questioning would have diminishing returns

### Explicit flag override

If `--depth` is supplied, that value should override dynamic behavior for the
command invocation.

Suggested examples:

```text
/zflow-change-plan add authz audit trail --depth deep
/zflow-change-prepare feature-x --depth shallow
```

### Flag semantics

- explicit `--depth` applies to the current run only
- if omitted, default remains `dynamic`
- if prepare continues a previously started intake, explicit `--depth` should override the stored dynamic/default mode for the resumed session

## Suggested command-surface changes if approved

### `/zflow-change-plan`

Potential additions:

- `--depth <mode>`
- optional later: `--skip-intake`
- optional later: `--resume-intake`

### `/zflow-change-prepare`

Potential additions:

- `--depth <mode>`
- optional later: `--continue-intake`
- optional later: `--prepare-from-intake-only` (future re-evaluation only)

The first pass does **not** require all optional flags. The important initial
surface is `--depth`.

## RuneContext interaction

When RuneContext is present:

- RuneContext documents remain canonical
- the intake flow should ask clarifying questions only about what RuneContext does not already settle
- repo evidence and RuneContext docs should be used before asking the user redundant questions
- retained prepare-context should explain how interview-derived nuance supplements canonical docs without competing with them

## Compaction interaction

This future idea should explicitly integrate with compaction policy.

After compaction during an intake-heavy session:

- the latest intake checkpoint should be treated as a canonical artifact for reread
- the next planning agent should reread intake-state + latest checkpoint + prepare-context before continuing
- the compaction summary should never be the only preserved copy of the intake discussion

This is essential for long change-intake sessions.

## Possible staged rollout

## Stage 1 — skill adaptation and checkpoint skeleton

- add zflow-owned `grill-me`-inspired skill under `pi-zflow-agents`
- define intake checkpoint artifact paths
- support manual invocation or hidden internal use for `/zflow-change-plan`
- persist normalized Q/A + decision log

## Stage 2 — `/zflow-change-plan` integration

- invoke adaptive intake before drafting `plan.md`
- generate `one-pager-input.md`
- keep `plan.md` concise
- persist `prepare-context.md`

## Stage 3 — `/zflow-change-prepare` carry-forward integration

- read retained intake artifacts automatically
- snapshot intake context into the selected plan version
- use retained context when generating the five required planning artifacts

## Stage 4 — adaptive-depth tuning

- add `--depth` flag support
- implement dynamic heuristics and stop conditions
- add diagnostics for why depth escalated or stopped

## Stage 5 — compaction-aware resume polish

- add explicit reread reminders for intake artifacts after compaction
- improve status/doctor output for active intake state
- support interruption/resume without losing branch coverage

## Suggested documentation updates if approved

- `README.md` — mention richer change-intake support for planning commands
- `docs/compaction-reread-policy.md` — include intake checkpoint artifacts in reread guidance
- `docs/prompt-boundary-policy.md` — clarify one-pager vs retained intake-context boundary
- `docs/skill-loading-policy.md` — document how the zflow `grill-me` adaptation is loaded and scoped
- `docs/subagents-integration.md` — document how intake context feeds planner launches

## Suggested tests

### Unit tests

- dynamic depth stops when required decision coverage is met
- explicit `--depth` overrides dynamic behavior
- one-pager projection excludes prepare-only material
- artifact writers checkpoint atomically and deterministically
- repo-derived answers are recorded distinctly from user answers

### Integration tests

- `/zflow-change-plan` writes intake checkpoints and a concise `plan.md`
- `/zflow-change-prepare` consumes retained intake context from a previous plan run
- compaction during intake does not lose the current decision state
- resumed prepare uses the stored intake snapshot for the chosen plan version
- RuneContext-backed planning does not duplicate canonical decisions unnecessarily

### Manual validation

- run a long planning interview until compaction occurs, then continue and confirm no material intake context is lost
- compare `plan.md` before/after the intake feature and verify it becomes sharper without becoming bloated
- verify prepare artifacts contain richer details than the one-pager alone while preserving traceability back to retained intake context

## Risks and tradeoffs

| Risk                                                       | Mitigation                                                                                    |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| The interview becomes annoying or too long                 | Dynamic default depth with clear stop conditions                                              |
| `plan.md` becomes bloated                                  | Enforce strict one-pager boundary and project richer context separately                       |
| Additional context becomes a hidden second source of truth | Make retained context explicit, file-backed, and subordinate to formal versioned artifacts    |
| Compaction still loses important nuance                    | Checkpoint after every material branch and reread canonical intake artifacts after compaction |
| RuneContext projects get duplicate questioning             | Prefer canonical docs and repo evidence before asking                                         |
| Prepare consumes too much noisy context                    | Use normalized decision log + prepare-context projection instead of raw interview transcript  |

## Open questions

1. Should the retained intake context remain runtime-only, or should some subset publish to repo-visible durable docs as an optional supplemental artifact?
2. Should the custom skill be assigned directly to `planner-frontier`, or should a dedicated intake agent own it and hand off to the planner?
3. Should `--depth` accept only named modes, or also numeric aliases?
4. Should `/zflow-change-prepare` automatically reopen questioning when retained context coverage is weak, or only when explicitly requested?
5. What is the minimum checkpoint granularity that preserves enough context without creating excessive artifact churn?

## Approval checklist for future implementation

Before implementation begins, confirm:

- the exact artifact path contract for intake checkpoints
- the one-pager vs retained-context boundary policy
- the `--depth` flag values and default behavior
- whether prepare must snapshot intake context into every version directory
- how compaction reread behavior should treat intake artifacts
- whether the retained intake context remains runtime-only or partially durable-published
- whether the custom skill is planner-owned or handled by a dedicated intake role
