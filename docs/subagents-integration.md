# Subagent Integration

> Detailed documentation of the `pi-subagents` integration boundary for
> pi-zflow workflow packages. This document describes how workflow packages
> configure, invoke, and consume output from `pi-subagents` without
> reimplementing subagent execution.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Discovery Paths](#discovery-paths)
3. [Launch Config Injection](#launch-config-injection)
4. [Prompt Assembly](#prompt-assembly)
5. [Chain Invocation](#chain-invocation)
6. [Output Consumption](#output-consumption)
7. [Override Conventions](#override-conventions)
8. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        pi-subagents (runtime)                        │
│                                                                      │
│  Discovery:   ~/.pi/agent/agents/zflow/*.md                          │
│               ~/.pi/agent/chains/zflow/*.chain.md                    │
│                                                                      │
│  API:         /run <agent> [overrides...]                             │
│               /chain <chain-name> [inputs...]                         │
│               subagent({ agent, model, maxOutput, ... })              │
│                                                                      │
│  Capabilities: single/parallel/chain execution, worktrees,           │
│                background runs, child contexts, artifact capture     │
└──────────────────────┬──────────────────────────────────────────────┘
                       │  invokes via Pi runtime API
                       │
┌──────────────────────▼──────────────────────────────────────────────┐
│                     pi-zflow (workflow layer)                        │
│                                                                      │
│  Configuration: profile bindings, prompt fragments, chain choices    │
│  Launch helpers: build launch configs from resolved profile          │
│  Output handling: persist output via pi-zflow-artifacts              │
└─────────────────────────────────────────────────────────────────────┘
```

## Discovery Paths

### Agent discovery

`pi-subagents` discovers agents by reading markdown files from:

| Scope         | Path                              | Created by                            |
| ------------- | --------------------------------- | ------------------------------------- |
| User-level    | `~/.pi/agent/agents/zflow/*.md`   | `/zflow-setup-agents`                 |
| Project-level | `<project>/.pi/agents/zflow/*.md` | `/zflow-setup-agents --scope project` |

Each file's `---` frontmatter defines the agent name (e.g. `name: planner-frontier`)
and the `package: zflow` field enables scoped resolution as `zflow.planner-frontier`.

### Chain discovery

`pi-subagents` discovers chains from:

| Scope         | Path                                    | Created by                            |
| ------------- | --------------------------------------- | ------------------------------------- |
| User-level    | `~/.pi/agent/chains/zflow/*.chain.md`   | `/zflow-setup-agents`                 |
| Project-level | `<project>/.pi/chains/zflow/*.chain.md` | `/zflow-setup-agents --scope project` |

Chain files use `---` frontmatter with `name` and `package: zflow` for scoped names.

### Install manifest

The install manifest at `~/.pi/agent/zflow/install-manifest.json` tracks which
files were installed, their hashes, and the package version. This enables
idempotent updates and user-edit protection.

## Launch Config Injection

Workflow packages do **not** parse agent markdown frontmatter at launch time.
Instead, they build launch configs from resolved profile bindings.

### Data flow

```
1. pi-zflow-profiles resolves active profile
   → produces ResolvedProfile with agentBindings[agentName]

2. Workflow package reads binding for the target agent:
   {
     agent: "zflow.planner-frontier",
     lane: "planning-frontier",
     resolvedModel: "openai-codex/gpt-5.4",
     tools: "read, grep, find, ls, bash, zflow_write_plan_artifact, web_search, fetch_content, subagent",
     maxOutput: 12000,
     maxSubagentDepth: 1
   }

3. Workflow package converts to launch override:
   {
     agent: "zflow.planner-frontier",
     model: "openai-codex/gpt-5.4",
     tools: "read, grep, find, ls, bash, zflow_write_plan_artifact, web_search, fetch_content, subagent",
     maxOutput: 12000,
     maxSubagentDepth: 1,
     systemPrompt: (mode+reminder assembled prompt)
   }

4. Workflow package passes this config to pi-subagents via
   subagent({...}) or chain invocation
```

### LaunchConfig interface

```ts
interface LaunchConfig {
  agent: string; // runtime name (e.g. "zflow.planner-frontier")
  model: string; // resolved model ID
  tools?: string; // comma-separated tool allowlist
  maxOutput?: number; // token limit
  maxSubagentDepth?: number; // recursion limit
  thinking?: "low" | "medium" | "high";
  systemPrompt?: string; // assembled prompt context
}
```

### Override resolution precedence

1. Hardcoded workflow defaults (lowest priority)
2. Agent frontmatter defaults (from `~/.pi/agent/agents/zflow/`)
3. Profile binding overrides (from `active-profile.json`)
4. Explicit launch-time override (highest priority)

### Builtin agent override conventions

For builtin agents (`scout`, `context-builder`), the profile binding supplies
overrides rather than agent markdown files:

```json
{
  "scout": {
    "lane": "scout-cheap",
    "tools": "read, grep, find, ls, bash",
    "maxOutput": 6000,
    "maxSubagentDepth": 0
  }
}
```

These overrides are injected at launch time without modifying the builtin markdown.

## Prompt Assembly

The prompt passed to a subagent at launch time is assembled from fragments,
not loaded as a single giant instruction bundle.

### Assembly function

```ts
function assembleSubagentPrompt(
  rolePrompt: string,
  mode?: string,
  reminders?: string[],
  activeStateConstraints?: string,
): string;
```

### Assembly rules

1. **Role prompt always included** — from the agent's markdown frontmatter or
   the assembled role description.
2. **Mode fragment included only when required** — e.g. `change-prepare` mode
   fragment is only included during `/zflow-change-prepare`.
3. **Runtime reminders included only when active** — e.g. `approved-plan-loaded`
   is only included after a plan is approved.
4. **Root orchestrator constitution excluded** — the orchestrator constitution
   is for the main harness, not blindly pasted into subagents. Only distilled
   role-relevant invariants are passed if needed.
5. **Active constraints appended last** — safety/state constraints appear at
   the end of the assembled prompt to reduce ambiguity.

### Prompt structure

```
<role prompt>              — always present, defines the agent's purpose
<mode fragment>            — present only when the workflow state requires it
<runtime reminders>        — present only for active state events
<active constraints>       — appended last when they change allowed behavior
```

### What NOT to do

- ❌ Do not load all mode fragments into every subagent
- ❌ Do not paste the full root-orchestrator constitution into subagent prompts
- ❌ Do not paste the full skill catalog as prompt text
- ❌ Do not include contradictory mode instructions simultaneously

## Chain Invocation

### Chain types

| Chain                  | Purpose                                                    | Internal/External       |
| ---------------------- | ---------------------------------------------------------- | ----------------------- |
| `scout-plan-validate`  | Exploration → planning → validation → optional plan review | Internal building block |
| `plan-review-swarm`    | Parallel plan review swarm for high-risk plans             | Internal building block |
| `parallel-review`      | Multi-angle code review with synthesis                     | Internal building block |
| `implement-and-review` | Implementation → verification → review                     | Internal building block |
| `plan-and-implement`   | Full end-to-end change workflow                            | Internal building block |

### Chain vs direct invocation

Use **chains** when the sequence is defined and stable (the chain file is the
source of truth). Use **direct subagent invocation** when the workflow needs
runtime-condition logic between stages (e.g. conditional branching based on
validation result, retry loops).

### Workflow packages invoke chains via

```
/chain zflow.scout-plan-validate inputs={...}
```

Or programmatically via `pi-subagents` chain API when available.

## Output Consumption

### Report-style agents

Report-style agents (`scout`, `repo-mapper`, `verifier`, review agents,
`plan-review` agents, `synthesizer`) return structured markdown as their output.
The orchestrator persists this output into the runtime state directory through
`pi-zflow-artifacts`.

**Output pattern:**

```markdown
# Findings

Severity: major
Location: src/foo.ts:42
Evidence: ...
Recommendation: ...
```

### Implementation agents

Implementation agents (`implement-routine`, `implement-hard`) make file edits
and write changes via `edit`, `write`, and mutation-capable `bash`. Their
output is the diff or applied changes, not structured markdown reports.

### Output flow

```
subagent output → workflow package receives output text
               → workflow package determines output type
               → report output → persisted via pi-zflow-artifacts
               → implementation output → diff captured, applied back
```

### maxOutput limits

Every agent has a configured `maxOutput` limit enforced at launch time:

| Agent(s)                                                                                                     | maxOutput |
| ------------------------------------------------------------------------------------------------------------ | --------- |
| `scout`, `plan-validator`, `context-builder`, `verifier`, `repo-mapper`                                      | 6000      |
| `implement-routine`, `review-integration`, `review-security`, `plan-review-integration`                      | 8000      |
| `implement-hard`, `review-correctness`, `review-logic`, `plan-review-correctness`, `plan-review-feasibility` | 10000     |
| `planner-frontier`, `synthesizer`, `review-system`                                                           | 12000     |

### maxSubagentDepth limits

| Agent(s)                   | maxSubagentDepth | Rationale                                               |
| -------------------------- | ---------------- | ------------------------------------------------------- |
| `zflow.planner-frontier`   | 1                | May spawn `scout` for broad exploration                 |
| All other `zflow.*` agents | 0                | Workers and reviewers should not spawn nested subagents |

## Override Conventions

### When to use overrides

Override the agent's default frontmatter at launch time when:

- The profile binding specifies a different model than the frontmatter default
- The workflow state requires different tools (e.g. restrict write tools during planning)
- The workflow requires a different `maxOutput` or `maxSubagentDepth` for a specific step
- The workflow needs to inject a mode-specific or reminder-specific prompt fragment

### When NOT to use overrides

- Do not override to change the agent's core role or behavior — that belongs in
  the agent markdown file
- Do not override to work around a missing capability — extend the agent definition
  or create a new agent
- Do not override builtins to fork them — reuse builtins with minimal overrides

## Troubleshooting

### Agent not found at runtime

If `pi-subagents` cannot find a `zflow.*` agent at runtime:

1. Verify agent markdown exists: `ls ~/.pi/agent/agents/zflow/<name>.md`
2. Re-run install: `/zflow-setup-agents`
3. Check install manifest: `cat ~/.pi/agent/zflow/install-manifest.json`
4. Verify agent frontmatter has `package: zflow` and a valid `name`

### Chain not found

If a chain is not discoverable:

1. Verify chain file exists: `ls ~/.pi/agent/chains/zflow/<name>.chain.md`
2. Re-run install: `/zflow-setup-agents`
3. Check chain frontmatter has `package: zflow` and a valid `name`
4. Note: chain names may include or exclude the `zflow.` prefix depending on
   how `pi-subagents` resolves them in the current Pi version

### Override not taking effect

If a launch override does not appear to affect subagent behavior:

1. Verify the override key matches the subagent API parameter name (e.g. `model`, not `resolvedModel`)
2. Check that the override is being passed to the subagent call, not just constructed
3. Confirm that `pi-subagents` supports the override parameter (e.g. `maxSubagentDepth` may require a recent version)
4. Verify that the frontmatter default does not take precedence — if `systemPromptMode: replace`, the override prompt replaces the frontmatter entirely

### Profile binding not resolving

If `resolvedModel` is null for an agent binding:

1. Run `/zflow-profile validate` to check profile health
2. Verify the lane exists in the active profile
3. Check that at least one model in the lane's `preferredModels` is available
4. Run `pi --list-models` to verify model availability
5. Check `~/.pi/agent/zflow/active-profile.json` for the resolved state
