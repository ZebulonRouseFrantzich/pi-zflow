# Implementation Phases Index

These documents break `pi-config-implementation-plan.md` into phase-specific implementation plans.

Status: planning artifacts only. Do not implement until Zeb gives explicit approval.

## Package-split reference

Read `package-split-details.md` before implementing **any** phase. It is the normative reference for the modular `pi-zflow` package family, package-relative path convention, namespaced command/tool policy, and extension-coexistence rules.

## Phase documents

0. `package-split-details.md` — cross-phase modular packaging and coexistence contract
1. `phase-0-foundation.md`
2. `phase-1-package-skeleton-prompts-skills-and-agents.md`
3. `phase-2-profile-extension-zflow-profiles.md`
4. `phase-3-runecontext-integration-pi-runecontext.md`
5. `phase-4-subagent-configuration-and-custom-chains.md`
6. `phase-5-worktree-isolation-and-apply-back.md`
7. `phase-6-multi-provider-review-zflow-review.md`
8. `phase-7-change-workflow-orchestration-zflow-change-workflows.md`
9. `phase-8-context-management-optimization.md`

## Reading order

Read `package-split-details.md` first, then read phase documents in numeric order. Later phase docs assume the decisions and deliverables from earlier phases.

## Cross-cutting rules repeated throughout the phase docs

- `pi-subagents` remains the orchestration owner.
- `pi-zflow` is a modular package family with individually installable child packages and an umbrella suite package.
- `package-split-details.md` is mandatory context for every implementation phase.
- public commands/tools are namespaced by default; short aliases are opt-in only.
- `pi-zflow-profiles` / `zflow-profiles` owns profile/lane resolution.
- `pi-zflow-plan-mode` / `zflow-plan-mode` owns ad-hoc read-only planning safety.
- `pi-zflow-artifacts` owns runtime path helpers and the `zflow_write_plan_artifact` tool.
- `pi-zflow-agents` owns agent/chain/skill/prompt assets and setup/update installation.
- `pi-zflow-review` owns review commands and review orchestration.
- `pi-web-access` is restricted to planner/review/research roles.
- `pi-interview` is the first-pass human-in-the-loop owner.
- runtime artifacts live under `<runtime-state-dir>` and user-local activation state under `<user-state-dir>`.
- approved plans are immutable in place once workers are dispatched.
- planner agents may write planning artifacts only, never source code.
- extension commands are the primary UX; prompts and chains are supplementary/internal.

## Coverage note

`coverage-verification.md` maps the master plan’s major sections to the phase docs and records the final pass review that the phase docs capture the implementation-plan content.
