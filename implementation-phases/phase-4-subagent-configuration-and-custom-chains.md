# Phase 4 — Subagent Configuration & Custom Chains

Status: planning artifact only. Do not implement until Zeb gives explicit approval to start implementation.

Package-family requirement: Before implementing this phase, read `package-split-details.md` and factor its modular package ownership, package-relative path convention, namespaced command/tool policy, and extension-coexistence rules into every task below.

## Phase goal

Configure `pi-subagents` as the actual orchestration runtime for planning, validation, implementation, verification, and review, using the agent definitions and chain assets created in Phase 1 and the lane resolution machinery from Phase 2.

This phase is where the package becomes operationally wired to `pi-subagents`, but still without reimplementing subagent execution itself.

## Scope and phase dependencies

### Depends on
- Phase 0 foundation and package ownership rules
- Phase 1 `pi-zflow-agents` agent/skill/chain assets
- Phase 2 resolved profile bindings from `pi-zflow-profiles`
- `package-split-details.md` package-relative path and duplicate-load rules

### Enables
- Phase 5 worktree-parallel implementation
- Phase 6 parallel plan review and code review
- Phase 7 workflow orchestration commands

## Must-preserve decisions from the master plan

1. `pi-subagents` is the orchestration owner.
2. Builtin `scout` and builtin `context-builder` should be reused via overrides where possible.
3. Chains are reusable internal building blocks, not a second competing user workflow UX.
4. Agent frontmatter uses native Pi YAML metadata.
5. `maxSubagentDepth` should default to `0` unless explicitly needed.
6. `planner-frontier` may spawn `scout`, but ordinary workers/reviewers should not spawn nested subagents.
7. `maxOutput` limits must be configured on all agents.
8. Conditional plan-review and review swarms must reason over actual reviewer sets rather than assuming fixed participants.
9. Worktree use for implementation groups should rely on `pi-subagents` native `worktree: true` in later phases.
10. Review/raw report agents return structured output; the orchestrator persists it.
11. Agent prompts are narrow role contracts assembled with only the root/mode/reminder fragments needed for the active workflow state.
12. Prompt assembly must not create a giant always-loaded instruction bundle.
13. Agent and chain assets are owned by `pi-zflow-agents`; orchestration packages consume them through install/discovery, not by copying them.
14. Subagent launch helpers must use namespaced `zflow.*` runtime agent names and should be package-filter friendly.

## Shared context needed inside this phase

### Agent set to wire up

| Agent | Role |
|---|---|
| builtin `scout` | recon |
| `zflow.planner-frontier` | planning |
| `zflow.plan-validator` | plan validation |
| builtin `context-builder` | reference example extraction |
| `zflow.implement-routine` | routine implementation |
| `zflow.implement-hard` | complex implementation |
| `zflow.verifier` | authoritative verification |
| `zflow.review-correctness` | core code review |
| `zflow.review-integration` | core code review |
| `zflow.review-security` | core code review |
| `zflow.review-logic` | optional specialty review |
| `zflow.review-system` | optional specialty review |
| `zflow.synthesizer` | findings synthesis |
| `zflow.repo-mapper` | repo map generation |
| `zflow.plan-review-correctness` | plan review |
| `zflow.plan-review-integration` | plan review |
| `zflow.plan-review-feasibility` | optional system-tier plan review |

### Chain set to wire up

- `scout-plan-validate`
- `plan-and-implement`
- `parallel-review`
- `implement-and-review`
- `plan-review-chain` or equivalent reusable plan-review composition

### Required maxOutput targets

- `planner-frontier`, `synthesizer`: ~12000
- `implement-hard`, `review-correctness`, `review-logic`, `plan-review-correctness`, `plan-review-feasibility`: ~10000
- `implement-routine`, `review-integration`, `review-security`, `plan-review-integration`: ~8000
- `scout`, `plan-validator`, `context-builder`, `verifier`, `repo-mapper`: ~6000
- `review-system`: ~12000

### Prompt assembly context

Phase 1 creates static prompt fragments and agent prompts. This phase wires them into launch-time subagent configuration.

Rules to preserve:

- The root-orchestrator constitution is for the main harness/orchestrator by default, not blindly pasted into every subagent.
- Each subagent receives its role prompt plus only the mode/reminder fragments required for its current workflow state.
- Examples and input artifacts must be clearly separated from normative instructions.
- The active mode or workflow state should appear near the end of the assembled prompt when it materially changes allowed behavior.
- Prompt assembly is advisory for safety; extension/tool/path guards remain the enforcement layer.

### Task-to-agent assignment rules that later dispatch must honor

| Criterion | Assigned agent |
|---|---|
| ≤3 files, well-understood pattern, no new abstractions | `zflow.implement-routine` |
| >3 files, novel algorithm, cross-module coordination, security-sensitive | `zflow.implement-hard` |
| refactoring existing core abstractions | `zflow.implement-hard` |
| simple CRUD, boilerplate, config changes | `zflow.implement-routine` |

These rules should be encoded in planner output expectations and respected by dispatch logic; the workflow should not arbitrarily swap a `zflow.implement-hard` group to `zflow.implement-routine` just to save cost.

## Deliverables

- subagent configuration strategy tied to the active profile
- overrides for builtin `scout` and builtin `context-builder`
- working chain definitions for planning/review/orchestration building blocks
- launch helpers that inject resolved model/tool/maxOutput bindings
- reviewer-manifest and output conventions for review swarms

## Tasks

---

### Task 4.1 — Design the `pi-subagents` integration boundary

#### Objective
Make explicit where `pi-zflow` stops and `pi-subagents` begins.

#### Files to create/update
- `README.md`
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts` (later consumer)
- `packages/pi-zflow-agents/README.md` or equivalent agent/chains documentation
- optional `docs/subagents-integration.md`

#### Responsibilities owned by `pi-subagents`
- single/parallel/chain execution
- background runs
- child contexts / forked contexts
- agent discovery
- worktree creation/cleanup
- artifact capture

#### Responsibilities owned by `pi-zflow` packages
- `pi-zflow-agents`: owning agent/chain/prompt/skill source assets and setup/update installation
- `pi-zflow-profiles`: resolving agent bindings and lanes
- `pi-zflow-change-workflows` / `pi-zflow-review`: choosing which agents/chains to run
- workflow packages: building prompts/inputs/manifests, enforcing workflow policy, processing/retrying failures
- `pi-zflow-artifacts`: persisting runtime state and synthesized findings paths

#### Anti-goal
- Do not build a custom runner for parallel subagents or worktrees.

#### Acceptance criteria
- The division of responsibility is documented and reflected in code organization.

---

### Task 4.2 — Implement resolved-agent launch config generation

#### Objective
Take the active profile’s resolved lane mappings and produce launch-time agent overrides.

#### Files to create/update
- `packages/pi-zflow-profiles/extensions/zflow-profiles/index.ts`
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`
- maybe `packages/pi-zflow-core/src/subagent-launch.ts` or an owner-package helper if it should not be shared

#### Inputs
- `active-profile.json`
- agent frontmatter defaults
- workflow-specific needs (e.g. worktree on/off, output mode, specific reads)

#### Output shape

```ts
interface LaunchAgentConfig {
  agent: string
  model: string
  tools?: string
  maxOutput?: number
  maxSubagentDepth?: number
  thinking?: "low" | "medium" | "high"
}
```

#### Example pseudocode

```ts
function buildLaunchConfig(agentName, resolvedProfile) {
  const binding = resolvedProfile.agentBindings[agentName]
  return {
    agent: agentName,
    model: binding.resolvedModel,
    tools: binding.tools,
    maxOutput: binding.maxOutput,
    maxSubagentDepth: binding.maxSubagentDepth,
    thinking: binding.thinking,
  }
}
```

#### Acceptance criteria
- All agent launches are driven by resolved runtime bindings, not hardcoded model IDs.

---

### Task 4.2A — Implement prompt-fragment assembly for subagent launches

#### Objective
Assemble the minimum prompt context needed for each role and workflow state without creating a giant always-loaded prompt.

#### Files to create/update
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`
- maybe `packages/pi-zflow-agents/src/prompt-assembly.ts` or `packages/pi-zflow-core/src/prompt-assembly.ts` depending on ownership
- agent launch helper docs

#### Inputs
- role prompt from the agent markdown file
- active workflow mode/state
- relevant prompt fragments from `prompt-fragments/modes/`
- relevant runtime reminders from `prompt-fragments/reminders/`
- canonical artifact paths and manifests
- focused skill list from agent frontmatter

#### Assembly rules
- include role prompt always
- include mode fragment only when the workflow state requires it
- include runtime reminders only when the corresponding event/state is active
- keep the root-orchestrator constitution in the main orchestrator context; only pass distilled role-relevant invariants to subagents if needed
- append active safety/state constraints near the end of the assembled prompt to reduce ambiguity
- never let assembled prompts override deterministic enforcement rules

#### Acceptance criteria
- Subagent prompts are assembled from explicit fragments and can be inspected/debugged.
- Launches avoid loading irrelevant mode fragments or the full skill catalog.
- The assembly helper prevents contradictory mode instructions from being active simultaneously.

---

### Task 4.3 — Reuse builtin `scout` via override configuration

#### Objective
Customize the builtin reconnaissance agent without forking it unnecessarily.

#### Files to create/update
- profile bindings/config
- `README.md`
- maybe a helper inside `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`

#### Override requirements
- lane: `scout-cheap`
- tools: `read, grep, find, ls, bash`
- `maxSubagentDepth: 0`
- `maxOutput: 6000`
- prompt behavior should match the scout system prompt excerpt from the plan

#### Example conceptual override

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

#### Acceptance criteria
- Builtin `scout` is operational with the intended limits and prompt behavior.

---

### Task 4.4 — Reuse builtin `context-builder` via override configuration

#### Objective
Customize the builtin context-builder for worker preparation.

#### Files to create/update
- profile bindings/config
- orchestration helper code

#### Override requirements
- lane: `scout-cheap`
- tools: `read, grep, find, ls`
- `maxOutput: 6000`
- returns 2–3 analogous code examples with signatures/snippets, not full file dumps

#### Acceptance criteria
- Builtin `context-builder` is used instead of a copied custom agent.

---

### Task 4.5 — Wire the custom agent set into subagent discovery and launch paths

#### Objective
Ensure the `zflow.*` agent files created in Phase 1 can actually be discovered and launched by `pi-subagents`.

#### Files to create/update
- agent install flow docs/commands
- later install logic in `pi-zflow-agents` via `/zflow-setup-agents`
- chain install logic similarly

#### Requirements
- user-level install is default
- runtime names must resolve as `zflow.<name>`
- avoid name collisions with builtins

#### Verification steps
- install agent markdown into `~/.pi/agent/agents/zflow/`
- confirm `pi-subagents` can discover them
- launch a dry-run or trivial prompt against one custom agent

#### Acceptance criteria
- Installed `zflow.*` agents are discoverable by name.

---

### Task 4.6 — Create the `scout-plan-validate` chain

#### Objective
Provide a reusable internal chain for formal planning preparation.

#### Files to create/update
- `chains/scout-plan-validate.chain.md`

#### Chain stages
1. builtin `scout`
2. `zflow.planner-frontier`
3. `zflow.plan-validator`
4. conditional plan-review swarm (or a handoff to a plan-review chain)

#### Inputs
- canonical change docs or ad-hoc change request
- repo map path
- reconnaissance output path
- active profile bindings

#### Outputs
- versioned plan artifacts
- validation result
- optional plan-review findings

#### Example pseudocode

```text
scout -> planner-frontier -> plan-validator -> if reviewTags != standard then plan-review-chain
```

#### Acceptance criteria
- Chain stages match the plan’s planning lifecycle.

---

### Task 4.7 — Create the `parallel-review` chain

#### Objective
Provide the reusable internal chain for code-review swarms.

#### Files to create/update
- `chains/parallel-review.chain.md`

#### Base reviewers
- `zflow.review-correctness`
- `zflow.review-integration`
- `zflow.review-security`

#### Optional reviewers
- `zflow.review-logic`
- `zflow.review-system`

#### Final stage
- `zflow.synthesizer`

#### Required context passed to reviewers
- diff bundle
- planning docs for internal review (`design.md`, `execution-groups.md`, `standards.md`, `verification.md`)
- reviewer manifest once available to synthesizer

#### Acceptance criteria
- Chain is structured to support optional reviewers and synthesis.

---

### Task 4.8 — Create the plan-review chain

#### Objective
Provide a reusable plan-review swarm composition for `logic` and `system` changes.

#### Files to create/update
- `chains/plan-review-chain.chain.md` or equivalent reusable definition

#### Required reviewers by tier
- `logic`: correctness + integration
- `system`: correctness + integration + feasibility
- `logic,system`: full set

#### Important behavior
- `worktree: false`
- operates on plan documents, not diffs/worktrees
- synthesizer reasons over actual reviewer set from manifest

#### Acceptance criteria
- Plan-review chain behavior matches the tier rules from the main plan.

---

### Task 4.9 — Create the `implement-and-review` and `plan-and-implement` chains

#### Objective
Capture the main reusable orchestration sequences that workflow commands will call.

#### Files to create/update
- `chains/implement-and-review.chain.md`
- `chains/plan-and-implement.chain.md`

#### `implement-and-review` intent
- context-builder → implementation groups → verifier → code review swarm

#### `plan-and-implement` intent
- planner → validator → conditional plan review → context-builder → implementation → verifier → code review

#### Important note
These chains are internal building blocks. The user-facing entrypoint remains extension commands like `/zflow-change-prepare` and `/zflow-change-implement`.

#### Acceptance criteria
- Chain definitions exist and map clearly to workflow phases.

---

### Task 4.10 — Set and enforce `maxSubagentDepth` correctly per role

#### Objective
Prevent uncontrolled agent recursion and excess complexity.

#### Files to create/update
- agent frontmatter files
- profile bindings
- launch override builder

#### Expected values
- `zflow.planner-frontier`: `1` (may spawn scout)
- everyone else by default: `0`

#### Example validation pseudocode

```ts
function validateDepth(agentName, depth) {
  if (agentName !== "zflow.planner-frontier" && depth !== 0) {
    throw new Error(`${agentName} should not spawn nested subagents by default`)
  }
}
```

#### Acceptance criteria
- Agent recursion limits match the plan.
- Prompt assembly does not encourage nested delegation for agents whose `maxSubagentDepth` is `0`.

---

### Task 4.11 — Set and enforce `maxOutput` on every agent

#### Objective
Prevent runaway output before Phase 8 compaction fully tunes long-session behavior.

#### Files to create/update
- agent frontmatter
- profile bindings
- launch override generation

#### Implementation details
- keep frontmatter values aligned with profile bindings
- allow launch-time override from the active profile when needed
- verify no agent launches without a known `maxOutput`

#### Acceptance criteria
- All agents have bounded outputs.

---

### Task 4.12 — Standardize subagent output handling and artifact persistence expectations

#### Objective
Ensure report-style agents return markdown while the orchestrator persists artifacts in a consistent way.

#### Files to create/update
- agent prompt files
- orchestration docs/helpers

#### Report-style agents
- scout
- repo-mapper
- verifier
- review agents
- plan-review agents
- synthesizer

#### Behavior rules
- agents return structured markdown or structured summaries
- orchestrator persists outputs into runtime-state files or uses `pi-subagents` artifact directories
- implementation agents may edit/write in their assigned worktrees; report agents should not get raw `write`

#### Example output pattern

```markdown
# Findings
Severity: major
Location: src/foo.ts:42
Evidence: ...
Recommendation: ...
```

#### Acceptance criteria
- Output-vs-persistence responsibilities are explicit.
- Report-style prompts remind agents to return structured output and rely on orchestrator persistence rather than writing files.

---

### Task 4.13 — Implement reviewer-manifest shape and swarm input contracts

#### Objective
Define the manifest structure used by plan-review and code-review swarms.

#### Files to create/update
- `packages/pi-zflow-review/extensions/zflow-review/findings.ts`
- maybe shared manifest types

#### Suggested manifest shape

```json
{
  "requestedReviewers": ["correctness", "integration", "security", "logic"],
  "executedReviewers": ["correctness", "integration", "security"],
  "skippedReviewers": [
    { "name": "logic", "reason": "lane unavailable" }
  ],
  "failedReviewers": [],
  "runId": "...",
  "tier": "standard"
}
```

#### Requirements
- support both plan-review and code-review modes
- capture requested/executed/skipped/failed sets
- carry enough data for the synthesizer to reason over actual coverage

#### Acceptance criteria
- The manifest is rich enough for synthesis and operator diagnostics.

---

### Task 4.14 — Add dry-run/smoke-test procedures for each chain and key agent

#### Objective
Make sure chain composition is proven before later phases depend on it.

#### Files to create later
- `README.md` test section
- automated tests if practical

#### Smoke tests to run
- launch `zflow.repo-mapper`
- launch `zflow.plan-validator` on a small fixture
- run `parallel-review` on a synthetic diff bundle
- run `scout-plan-validate` on a fixture change

#### Acceptance criteria
- There is at least a manual smoke-test recipe for every major chain.

## Phase exit checklist

- [ ] `pi-subagents` integration boundary is documented.
- [ ] Launch-time agent override generation exists.
- [ ] Builtin `scout` is reused via override.
- [ ] Builtin `context-builder` is reused via override.
- [ ] Prompt-fragment assembly exists for launch-time role/mode/reminder context.
- [ ] Custom `zflow.*` agents are discoverable by `pi-subagents`.
- [ ] `scout-plan-validate` chain exists.
- [ ] `parallel-review` chain exists.
- [ ] Plan-review chain exists.
- [ ] `implement-and-review` and `plan-and-implement` chains exist.
- [ ] `maxSubagentDepth` values are enforced.
- [ ] `maxOutput` values are enforced.
- [ ] Report-style output handling is standardized.
- [ ] Reviewer-manifest structure is defined.
- [ ] Smoke-test procedures exist.

## Handoff notes for later phases

- Phase 5 will add `worktree: true` and apply-back behavior on top of this subagent foundation.
- Phase 6 will consume the reviewer-manifest contract and review chains.
- Phase 7 will wrap these chains in extension commands and state transitions.
