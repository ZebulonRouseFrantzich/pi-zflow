# pi-zflow-agents

Agent and chain source assets for the pi-zflow suite. This package owns the
canonical agent markdown files, chain definitions, skills, prompts, prompt
fragments, and the install/update commands that deploy them into
`pi-subagents` discovery directories.

## Ownership

| Concern               | Details                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------- |
| **Agent markdown**    | Canonical `.md` files in `agents/` defining each `zflow.*` agent                          |
| **Chain definitions** | `.chain.md` files in `chains/` composing reusable orchestration sequences                 |
| **Skills**            | Skill directories in `skills/` loaded by Pi via the package manifest                      |
| **Prompt templates**  | `/zflow-draft-*` helpers in `prompts/` for generating structured content                  |
| **Prompt fragments**  | Modular mode/reminder/root fragments in `prompt-fragments/` for assembly at launch time   |
| **Install/update**    | Commands `/zflow-setup-agents` and `/zflow-update-agents` (in `extensions/zflow-agents/`) |

## Relationship with `pi-subagents`

`pi-zflow-agents` **does not execute agents**. It provides the source assets
that `pi-subagents` discovers and runs. The division is:

```
pi-zflow-agents                    pi-subagents
───────────────                    ────────────
creates agent .md files      →    discovers from ~/.pi/agent/agents/zflow/
creates chain .chain.md files →    discovers from ~/.pi/agent/chains/zflow/
owns install manifest        →    reads agent frontmatter for defaults
provides prompt fragments     →    workflow layer assembles into launch prompts
```

## Install flow

### First-time setup

Run `/zflow-setup-agents` to copy agent and chain markdown files into
`pi-subagents` discovery directories:

| Resource | Source (`pi-zflow-agents/`) | Target (`~/.pi/agent/`) |
| -------- | --------------------------- | ----------------------- |
| Agents   | `agents/*.md`               | `agents/zflow/`         |
| Chains   | `chains/*.chain.md`         | `chains/zflow/`         |

Builtin agents (`scout`, `context-builder`) are **not** installed — they are
reused from Pi's builtin set with override configuration at launch time.

### Updates

Run `/zflow-update-agents` to refresh when the package version changes.
The idempotent copy logic protects user edits from being silently overwritten.

### What gets installed

**Agents** (every `.md` in `agents/` that is NOT a `.chain.md`):

- `zflow.planner-frontier` — planning agent
- `zflow.plan-validator` — plan validation
- `zflow.implement-routine` — routine implementation
- `zflow.implement-hard` — complex implementation
- `zflow.verifier` — authoritative verification
- `zflow.plan-review-correctness` — plan correctness review
- `zflow.plan-review-integration` — plan integration review
- `zflow.plan-review-feasibility` — plan feasibility review
- `zflow.review-correctness` — code correctness review
- `zflow.review-integration` — code integration review
- `zflow.review-security` — code security review
- `zflow.review-logic` — code logic review (optional)
- `zflow.review-system` — code system review (optional)
- `zflow.synthesizer` — findings synthesis
- `zflow.repo-mapper` — repository mapping

**Chains** (every `.chain.md` in `chains/`):

- `scout-plan-validate` — exploration → planning → validation → optional plan review
- `plan-and-implement` — full end-to-end change workflow
- `parallel-review` — multi-angle code review swarm
- `implement-and-review` — implementation → verification → review pipeline
- `plan-review-swarm` — parallel plan-review swarm

**Skills** (loaded via Pi package manifest, not filesystem installation):

- `change-doc-workflow`
- `code-skeleton`
- `implementation-orchestration`
- `multi-model-code-review`
- `plan-drift-protocol`
- `repository-map`
- `runecontext-workflow`

## Prompt fragments

The `prompt-fragments/` directory contains modular instruction fragments that
the workflow layer assembles at launch time. These are **not** installed as
agent markdown — they are consumed by the launch helper (`orchestration.ts` or
a shared prompt-assembly module) to build the minimum context each subagent
needs for its current workflow state.

| Directory                               | Purpose                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------- |
| `prompt-fragments/root-orchestrator.md` | Constitution for the main orchestrator session                                                |
| `prompt-fragments/modes/`               | Mode-specific fragments (change-prepare, change-implement, plan-mode, review-pr, zflow-clean) |
| `prompt-fragments/reminders/`           | State-specific reminders (approved-plan-loaded, compaction-handoff, drift-detected, etc.)     |

## Agent naming convention

All agents use `zflow.<name>` runtime names to avoid collisions with Pi builtins
and other packages. The `zflow.` prefix is consistent across:

- Agent runtime names (e.g. `zflow.planner-frontier`)
- Chain runtime names (e.g. `zflow.scout-plan-validate`)
- Command namespaces (`/zflow-*`)
- Tool namespaces (`zflow_*`)

## Smoke tests

Comprehensive smoke-test procedures for every chain and key agent are documented
in `docs/smoke-tests.md`. Run these after installation or when upgrading Pi to
verify that:

- All agents are discoverable and responsive
- Chain definitions resolve and invoke correctly
- Builtin agent overrides (`scout`, `context-builder`) work as expected
- Output conventions and manifest structures are correct

A [quick validation recipe](../../docs/smoke-tests.md#quick-validation-recipe) is
available for rapid sanity checks without the full test setup.

## See also

- `docs/subagents-integration.md` — detailed `pi-subagents` integration notes
- `docs/smoke-tests.md` — smoke-test procedures for all chains and key agents
- `extensions/zflow-agents/install.ts` — idempotent install/update implementation
- `extensions/zflow-agents/manifest.ts` — install manifest handling
