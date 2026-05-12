# Phase 8 — Context Management Optimization

Status: planning artifact only. Do not implement until Zeb gives explicit approval to start implementation.

Package-family requirement: Before implementing this phase, read `package-split-details.md` and factor its modular package ownership, package-relative path convention, namespaced command/tool policy, and extension-coexistence rules into every task below.

## Phase goal

Optimize the harness for long-running, multi-agent coding sessions by combining prevention, compaction, scoped context construction, and canonical file-backed artifact rereads.

This phase is not optional polish. It protects cost, latency, and model reliability once the workflow orchestration from earlier phases is in place.

## Scope and phase dependencies

### Depends on
- Phase 0 foundation dependency decisions (`pi-rtk-optimizer`, `pi-mono-context-guard`, `pi-web-access`)
- Phase 1 `pi-zflow-compaction` extension skeleton and context-oriented skills from `pi-zflow-agents`
- Phase 4 `maxOutput` configuration on agents
- Phase 7 workflow orchestration entrypoints and runtime artifacts
- `pi-zflow-artifacts` path helpers for canonical rereads after compaction

### Enables
- More stable long sessions
- Lower token waste and lower-context failure rates
- Better grounding for planning/review without overloading worker contexts

## Must-preserve decisions from the master plan

1. Context management is multi-layered: prevention + compaction + scout reconnaissance + code skeletons + small skills + repo maps + output limits.
2. `pi-mono-context-guard` is the prevention layer.
3. `pi-rtk-optimizer` + `pi-zflow-compaction` / `zflow-compaction` are the first-pass compaction owners.
4. `rtk` binary is required for command rewriting; if absent, alert the user, but output compaction can still work.
5. Trigger compaction proactively at about 60–70% context usage.
6. Prefer a cheap summarization model for compaction.
7. Canonical artifacts stay file-backed; compaction never replaces explicit rereads of those files.
8. Builtin `scout` provides lazy-loading reconnaissance; its output is advisory, not restrictive.
9. `code-skeleton` and `repository-map` are focused aids for architecture understanding.
10. `pi-web-access` is the only first-pass external research stack and is restricted to planner/review/research roles.
11. Indexed code navigation remains deferred; if later piloted, prefer a thin wrapper around `cymbal`, not the `codemapper` stack.
12. `pi-dcp`, `pi-observational-memory`, `manifest.build`, `nono`, and external memory stacks remain deferred pilots.
13. The prompt system should stay modular and context-efficient: root constitution, mode fragments, role prompts, runtime reminders, focused skills, and canonical artifact rereads instead of one giant always-loaded prompt.
14. `pi-zflow-compaction` must remain independently installable and must coexist with the umbrella suite through the shared registry.
15. Context optimization packages must not override built-in tools by default or take ownership of unrelated rendering behavior.

## Shared context needed inside this phase

### Context-management layers to combine

1. **Prevention** — `pi-mono-context-guard`
2. **Compaction** — `pi-rtk-optimizer` + `pi-zflow-compaction` / `zflow-compaction`
3. **Scout reconnaissance** — cheap curated initial reads
4. **Code skeletons** — signatures/types/exports without implementation bulk
5. **Small focused skills** — load only what is needed
6. **Document boundaries** — prompts/skills structured cleanly
7. **Prompt-fragment assembly** — only active root/mode/reminder fragments are injected
8. **Repository maps** — file-backed compact overview per session
9. **`maxOutput`** — cap subagent output size
10. **Scoped external research** — only for planner/review/research roles

### Important runtime artifacts to rely on after compaction

- `<runtime-state-dir>/repo-map.md`
- `<runtime-state-dir>/reconnaissance.md`
- canonical plan artifacts
- review findings
- failure log
- active prompt-fragment/reminder state when stored in runtime metadata

### What is intentionally deferred

- ContextGem / ExtractThinker
- Langfuse / Helicone
- LLMap/external lazy-loading stacks
- `pi-dcp`, `pi-observational-memory`
- `manifest.build`
- `nono`
- `codemapper` / indexed code nav foundation

## Deliverables

- configured `pi-mono-context-guard`
- configured `pi-rtk-optimizer`
- working `pi-zflow-compaction` / `zflow-compaction` hook ownership
- repo-map and reconnaissance caching policy
- role-scoped external research policy
- explicit canonical reread policy after compaction
- failure-log readback support for similar tasks

## Tasks

---

### Task 8.1 — Configure `pi-mono-context-guard` as the prevention layer

#### Objective
Reduce waste before it enters the transcript/context.

#### Files to create/update
- package/bootstrap docs
- context-guard config if supported
- workflow integration docs

#### Required behavior to rely on
- default `read` limit injection (e.g. `limit: 120`) when omitted
- deduplicate unchanged identical reads within a session/process
- bound raw `rg` in bash (e.g. append `| head -60`)
- invalidate dedup cache when files change

#### Important nuance
- Dedup cache is a per-session/per-process optimization, not a correctness guarantee across separate subagent processes or worktrees.

#### Example policy note

```markdown
Context guard may suppress duplicate reads in the same process, but subagents must still be able to reread files after modifications or across isolated worktrees.
```

#### Acceptance criteria
- Prevention rules are configured and documented.

---

### Task 8.2 — Configure `pi-rtk-optimizer` for command rewriting and output compaction

#### Objective
Enable command/output compaction with safe defaults for coding workflows.

#### Files to create/update
- package/bootstrap docs
- `packages/pi-zflow-compaction/extensions/zflow-compaction/index.ts`
- maybe optimizer config file if supported

#### Required optimizer features to enable
- ANSI stripping
- test aggregation
- build filtering
- git output compaction
- linter aggregation
- search grouping
- smart truncation
- hard truncation around ~12k chars

#### Required defaults
- keep `readCompaction` disabled by default to preserve exact file reads for editing workflows
- enable `sourceCodeFiltering` only in aggressive cost-saving mode, not by default

#### Acceptance criteria
- Compaction is aggressive on noisy tool output but conservative on exact source reads.

---

### Task 8.3 — Implement `rtk` binary presence check and user alerting

#### Objective
Handle the case where optimizer rewriting cannot occur because the CLI dependency is missing.

#### Files to create/update
- startup/bootstrap checks
- `packages/pi-zflow-compaction/extensions/zflow-compaction/index.ts`

#### Required behavior
- check for `rtk` at startup or first optimizer use
- if missing, alert the user with exact guidance
- continue using output compaction even when rewriting is unavailable

#### Required alert wording (or equivalent)
- `Install rtk for command rewriting. Output compaction will still work without it.`

#### Acceptance criteria
- Missing `rtk` degrades gracefully and visibly.

---

### Task 8.4 — Make `pi-zflow-compaction` / `zflow-compaction` own the `session_before_compact` hook

#### Objective
Give the harness a single clear owner for compaction timing and policy.

#### Files to create/update
- `packages/pi-zflow-compaction/extensions/zflow-compaction/index.ts`

#### Required behavior
- register the `session_before_compact` hook
- trigger compaction around 60–70% context usage
- use a cheap summarization model where possible
- preserve references to canonical artifact paths so future steps can reread them directly
- preserve active workflow mode and prompt-reminder state enough that Phase 7 can re-inject the right fragments after compaction

#### Example pseudocode

```ts
onSessionBeforeCompact(async (ctx) => {
  if (ctx.usageRatio < 0.6) return
  return compactSession({
    model: chooseCheapCompactionModel(),
    preserveArtifacts: [repoMapPath, reconnaissancePath, activePlanPaths],
  })
})
```

#### Acceptance criteria
- Compaction triggers proactively rather than only at overflow.

---

### Task 8.5 — Implement canonical artifact reread policy after compaction

#### Objective
Prevent summarized transcript memory from becoming the authoritative source of requirements.

#### Files to create/update
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`
- `packages/pi-zflow-compaction/extensions/zflow-compaction/index.ts`
- agent guidance if needed

#### Required policy
- after compaction, planner/worker/reviewer/orchestrator may reread:
  - plan artifacts
  - repo map
  - reconnaissance
  - findings files
  - failure log
  - active workflow state and prompt-reminder metadata
- inject the `compaction-handoff` reminder after compaction/resume so the model knows to reread file-backed artifacts for exact details
- do not assume compaction summary is enough for exact implementation decisions

#### Example rule snippet

```markdown
Compaction may summarize earlier context, but canonical artifacts remain file-backed and should be reread explicitly when exact wording/path/details matter. The active mode/reminder state must be restored from runtime metadata before continuing.
```

#### Acceptance criteria
- The workflow reanchors itself on file-backed artifacts after compaction.

---

### Task 8.6 — Tune scout reconnaissance for concise, high-signal output

#### Objective
Use scout as a lazy-loading guide rather than a giant repo dump.

#### Files to create/update
- scout override prompt/config
- workflow orchestration prompts

#### Required scout output qualities
- curated file list
- architecture summary
- current patterns/conventions
- test structure/build steps
- hidden constraints
- concise output within `maxOutput`

#### Important rule
- scout output is advisory, not restrictive; workers may read additional files if required.

#### Acceptance criteria
- Scout helps narrow context without blocking necessary follow-up reads.

---

### Task 8.7 — Implement `code-skeleton` usage for low-cost architecture understanding

#### Objective
Provide compact code structure summaries without expensive full-source reads.

#### Files to create/update
- `skills/code-skeleton/SKILL.md`
- orchestration logic that invokes the skill when useful

#### Expected outputs
- exports
- function/class/type signatures
- docstrings/comments if useful
- no large implementation bodies

#### Example pseudo-output

```markdown
## src/auth/service.ts
Exports:
- `createAuthService(config: AuthConfig): AuthService`
Types:
- `AuthConfig { issuer: string; audience: string }`
- `AuthService { verify(token: string): Promise<UserClaims> }`
```

#### Acceptance criteria
- The skill is usable for planning/recon without bloating context.

---

### Task 8.8 — Implement repository-map generation, caching, and freshness checks

#### Objective
Keep a compact repo overview available to planners and workers.

#### Files to create/update
- `agents/repo-mapper.md`
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`

#### Required output path
- `<runtime-state-dir>/repo-map.md`

#### Required output content
- directory tree (max depth ~3)
- key module exports/class hierarchies
- module dependency graph
- entry points and config files
- under ~200 lines

#### Caching policy
- reuse when a structural hash or freshness signal indicates it is still current
- regenerate when repo structure changes significantly

#### Acceptance criteria
- Repo maps are concise, file-backed, and reused when fresh.

---

### Task 8.9 — Cache and reuse reconnaissance output safely

#### Objective
Avoid repeating expensive codebase recon when nothing relevant has changed.

#### Files to create/update
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`

#### Required output path
- `<runtime-state-dir>/reconnaissance.md`

#### Reuse conditions
- repo structure and key source paths unchanged enough to trust the cache
- planning context still targets the same change or a sufficiently similar area

#### Important rule
- stale recon must be regenerated; do not trust old cached summaries blindly

#### Acceptance criteria
- Reconnaissance caching exists but respects freshness.

---

### Task 8.10 — Keep skills and prompt fragments small and load them on demand

#### Objective
Avoid giant always-loaded instruction bundles.

#### Files to create/update
- skill definitions
- agent frontmatter `skills:` entries
- command docs

#### Implementation rules
- inject only needed focused skills into each agent
- inject only prompt fragments that match the active mode/state/role
- do not turn the skill catalog or prompt-fragment directory into a giant always-inherited prompt
- keep `inheritSkills: false` by default

#### Acceptance criteria
- Skill loading remains selective and role-specific.
- Prompt-fragment loading remains mode/state-specific and does not bloat unrelated sessions.

---

### Task 8.11 — Maintain clear prompt/document boundaries

#### Objective
Reduce instruction/data confusion inside prompts and skill files.

#### Files to create/update
- prompts
- skills
- agent markdown files

#### Formatting rules
- separate instructions from input data with markdown headers and/or XML-style tags
- keep examples distinct from normative instructions
- use explicit labels for artifacts being passed in
- put active mode/state constraints in clearly labeled sections
- avoid duplicating root-orchestrator rules inside every skill/agent unless the role specifically needs the invariant restated

#### Example structure

```markdown
## Instructions
...

## Input Artifacts
<design>
...
</design>
```

#### Acceptance criteria
- Prompt files are structured clearly enough to reduce parsing ambiguity.
- Root/mode/reminder fragments are visually distinct from user data and canonical artifacts.

---

### Task 8.12 — Enforce `maxOutput` limits during actual launches

#### Objective
Make sure the max-output bounds defined earlier are respected at runtime.

#### Files to create/update
- subagent launch helper
- profile bindings validation

#### Required behavior
- no agent launch without a known `maxOutput`
- preserve the plan’s approximate values by role
- allow future tuning but keep within bounded ranges

#### Acceptance criteria
- Output caps are operational, not just documented.

---

### Task 8.13 — Restrict `pi-web-access` tools to planner/review/research roles

#### Objective
Prevent implementation agents from wasting context or drifting into unnecessary external research.

#### Files to create/update
- agent tool allowlists
- profile bindings
- maybe orchestration checks

#### Roles that may receive `pi-web-access` tools
- planner
- plan-review agents
- code-review agents
- dedicated research role if one is later added

#### Roles that should not receive them by default
- `zflow.implement-routine`
- `zflow.implement-hard`
- `zflow.verifier`

#### Acceptance criteria
- External research access is scoped by role as planned.

---

### Task 8.14 — Implement failure-log readback before similar tasks

#### Objective
Use previous mistakes to improve context construction and planning quality.

#### Files to create/update
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`
- failure-log helper

#### Required behavior
- before planning similar tasks, read recent relevant `failure-log.md` entries
- include only the most relevant/high-signal subset in context
- avoid dumping the entire log into every agent prompt

#### Example pseudocode

```ts
const priorFailures = await loadRecentFailureLogEntries({ tags: ["plan-quality", "verification-gap"], limit: 3 })
```

#### Acceptance criteria
- Failure-log context is selective and useful.

---

### Task 8.15 — Explicitly document deferred context/navigation systems

#### Objective
Prevent future implementation drift toward overlapping tools that the plan intentionally deferred.

#### Files to create/update
- `README.md`
- maybe `docs/deferred-pilots.md`

#### Must-document deferrals
- `pi-dcp`
- `pi-observational-memory`
- `manifest.build`
- `nono`
- indexed code navigation foundation
- `codemapper` stack

#### Required note
If indexed code navigation is piloted later, use a thin wrapper around `cymbal` rather than adopting `codemapper` as a foundation.

#### Acceptance criteria
- Deferred items stay explicitly deferred.

---

### Task 8.16 — Add long-session smoke tests and compaction validation scenarios

#### Objective
Prove the optimization layer works under realistic long-running workflows.

#### Files to create later
- test docs/scripts

#### Scenarios to exercise
- long planning session that triggers compaction
- implementation session with many tool outputs and bounded output sizes
- reread of canonical plan artifacts after compaction
- missing `rtk` warning path
- context-guard duplicate-read suppression
- review session with chunked diff and compacted logs

#### Acceptance criteria
- There is at least a manual test recipe for compaction and context behavior in long sessions.

## Phase exit checklist

- [ ] `pi-mono-context-guard` behavior is configured/documented.
- [ ] `pi-rtk-optimizer` compaction settings are configured.
- [ ] Missing `rtk` is handled with a visible warning.
- [ ] `pi-zflow-compaction` / `zflow-compaction` owns `session_before_compact`.
- [ ] Compaction triggers around 60–70% usage.
- [ ] Canonical artifact reread policy is implemented/documented, including compaction-handoff reminder restoration.
- [ ] Scout output is concise and advisory.
- [ ] `code-skeleton` is usable for low-cost architecture summaries.
- [ ] Repo maps are generated, cached, and refreshed when stale.
- [ ] Reconnaissance caching exists with freshness checks.
- [ ] Skill and prompt-fragment loading remains focused and selective.
- [ ] Prompt/document boundaries are clear.
- [ ] `maxOutput` caps are enforced at runtime.
- [ ] `pi-web-access` tools are restricted to planner/review/research roles.
- [ ] Failure-log readback exists.
- [ ] Deferred systems are explicitly documented as deferred.
- [ ] Long-session smoke-test scenarios are documented.

## Handoff notes

- This phase should be tuned after the main workflow exists, but compaction ownership decisions should be made before serious long-session testing.
- Any future experiments with memory/indexing/navigation stacks must be measured against this baseline rather than layered in casually.
