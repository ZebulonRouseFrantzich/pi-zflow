# Coverage Verification

Purpose: final-pass check that `pi-config-implementation-plan.md` has been captured in the phase docs under `implementation-phases/`.

Status: verification artifact for planning only.

Package-family requirement: Coverage now includes `package-split-details.md`; that file must be read before every implementation phase.

## Coverage summary

The master plan content is covered across the phase docs as follows.

| Master plan section | Primary phase doc(s) | Notes |
|---|---|---|
| Goals | Phases 0, 7 | Goals are reflected as cross-cutting requirements and workflow priorities rather than copied as a standalone section in every doc. |
| Decisions captured so far | All phases, especially 0, 3, 5, 6, 7, 8 | Decisions were distributed to the phase where they materially affect implementation. |
| Runtime state and artifact locations | Phases 0, 5, 7 | Path contracts, manifests, run metadata, review outputs, cleanup tracking. |
| Foundation dependencies | Phase 0 | Pins, install policy, prerequisites, optional package rules. |
| Package adoption / overlap-avoidance policy | `package-split-details.md`, Phases 0, 1, 8 | Single-owner rules, excluded/deferred packages, package roles, extension-coexistence policy, no default built-in tool overrides. |
| RuneContext change doc structures | Phase 3 | Both flavors, precedence, status mapping, write-back behavior. |
| `execution-groups.md` format/rules | Phases 1, 3, 5, 7 | Planner expectations, RuneContext derivation, ownership validation, dispatch use. |
| Proposed package layout and modular package split | `package-split-details.md`, Phase 1 | Package family, umbrella manifest, child package manifests, package-relative paths, extension/skill/agent/prompt-fragment structure. |
| Planning UX model | Phase 7 (and 1 for prompts) | `/zflow-plan`, `/zflow-change-prepare`, lifecycle, approval, session handoff. |
| Agent definitions / frontmatter / prompts | Phase 1, Phase 4 | File set, role prompts, prompt-fragment assembly, frontmatter, reuse of builtins, launch binding. |
| Profile system | Phase 2 | Schema, commands, resolution, invalidation, health checks, sync-project. |
| Verification command | Phase 7, Phase 2 | Profile-configured command, auto-detect order, verifier orchestration, fix loops. |
| Worktree isolation strategy | Phase 5 | Preflight, worktrees, setup hook, atomic apply-back, drift protocol. |
| Multi-provider plan review | Phase 6, Phase 7 | Tiering, gating, reviewer manifest, synthesizer, approval loop. |
| Multi-provider code review | Phase 6, Phase 7 | Tiering, findings format, support/dissent, baseline handling. |
| External PR/MR review | Phase 6, Phase 7 | Diff-only safety, URL parsing, fetch/chunk/review/triage/submission. |
| Context management strategy | Phase 8 | Prevention, compaction, prompt-fragment selectivity, repo map, recon cache, failure-log readback, research scoping. |
| Change preparation workflow | Phase 7 | Full orchestrated sequence and state transitions. |
| Change implementation workflow | Phases 5 and 7 | Execution, verification, fix loop, drift handling, review. |
| Safety requirements | Phases 0, 1, 5, 6, 7 | Path guard, `zflow_write_plan_artifact`, `/zflow-plan` enforcement, secret handling, untrusted code rules. |
| Error recovery / resume / cleanup | Phases 0, 5, 7 | Recovery index, run state, cleanup, resume, retained artifacts. |
| Failure log | Phases 7, 8 | File format, append policy, selective readback. |
| Implementation phases | Phase docs themselves | Broken out into one document per phase as requested. |
| Agent installation method | Phases 1 and 7 | `/zflow-setup-agents`, install manifest, update behavior, user-level default. |
| System prompt architecture | Phases 1, 4, 7, 8 | Root constitution, mode fragments, role prompts, runtime reminders, prompt assembly, compaction handoff, and enforcement split. |
| Former open questions | Phases 0, 3, 5, 7 | Resolved decisions are distributed to the phases that implement them. |
| Current recommendation summary | All phases | Folded into concrete implementation requirements and checklists. |

## Former open-question coverage

| Former open question from master plan | Resolved decision | Captured in |
|---|---|---|
| exact pins + minimum Pi version after prototype validation | Use Pi `0.74.0` as provisional minimum; Phase 0 smoke-tests and records exact versions/refs plus confirmed minimum. | `phase-0-foundation.md` |
| cleanup TTL and retain-on-failure duration | 14-day stale runtime/patch-artifact TTL; 7-day failed/interrupted worktree retention; successful temp worktrees removed immediately unless explicitly kept. | `phase-0-foundation.md`, `phase-5-worktree-isolation-and-apply-back.md`, `phase-7-change-workflow-orchestration-zflow-change-workflows.md` |
| which target repos need standardized `worktreeSetupHook` examples | Ship generic templates; keep actual hooks per-repo; fail fast when a repo needs setup and lacks a hook. | `phase-0-foundation.md`, `phase-5-worktree-isolation-and-apply-back.md` |
| whether RuneContext write-back at `approved` / `completed` should be opt-in by default | Automatically offer a `pi-interview` preview and require explicit approval; default future config mode is `prompt`. | `phase-3-runecontext-integration-pi-runecontext.md` |
| whether later apply-back hardening should evolve to branch-aware merge/cherry-pick | Defer branch-aware merge/cherry-pick; implement first-pass atomic patch replay behind a strategy boundary. | `phase-5-worktree-isolation-and-apply-back.md` |

## Cross-cutting requirements explicitly preserved in the phase docs

- planner is source-read-only and may write only approved plan artifacts
- approved plan versions are immutable once workers start
- reviewers must read planning docs before reviewing internal diffs
- review severity uses `critical / major / minor / nit`
- `pi-web-access` is scoped away from implementation agents
- `pi-interview` is the structured human-checkpoint mechanism
- runtime state stays outside the working tree and outside RuneContext portable trees
- default handoff is a new implementation session file, not a git branch
- worktree apply-back is atomic with rollback on conflict
- `/zflow-plan` allows non-mutating exploration only
- cleanup and resume are file/state driven, not transcript driven
- system prompting is modular rather than a giant always-loaded prompt
- mode fragments and runtime reminders are injected only when relevant
- safety-critical prompt rules are paired with deterministic tool/path/extension enforcement
- `pi-zflow` is a modular package family with individually installable child packages plus an umbrella package
- public commands/tools are namespaced by default; short aliases are opt-in only
- reusable logic is API-first via `pi-zflow-core`; event bus is notifications-only for core `pi-zflow` interactions
- default `pi-zflow` packages do not override built-in Pi tools or combine execution with optional rendering

## Final pass result

I checked the phase docs against the master plan sections and did not find any remaining uncaptured major implementation topic.

The main plan content is now represented in the phase docs, with cross-cutting rules repeated where they are operationally relevant instead of being isolated in one place.
