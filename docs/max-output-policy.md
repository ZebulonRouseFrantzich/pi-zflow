# maxOutput Enforcement Policy

> **Core rule: No agent launch without a known and valid `maxOutput`.**
> Every subagent invocation must have a bounded output limit. This is
> not optional — it protects context windows, prevents runaway output,
> and keeps long-session costs predictable.

## Motivation

Without explicit `maxOutput` limits on every agent, a single subagent
can consume the entire context window with one verbose response. This
defeats the multi-layered context management strategy (prevention +
compaction + scoped context + bounded outputs) and makes long sessions
unreliable.

The Phase 8 plan requires that `maxOutput` caps are **operational**,
not just documented. This policy defines how that is enforced at every
layer of the pi-zflow launch chain.

## Expected values by role

These values come from the Phase 4 plan and are defined in
`EXPECTED_MAX_OUTPUT` in `packages/pi-zflow-profiles/src/output-limits.ts`.

| Tier                  | Agent                           | `maxOutput` |
| --------------------- | ------------------------------- | ----------- |
| **Planning**          | `zflow.planner-frontier`        | 12,000      |
|                       | `zflow.plan-validator`          | 6,000       |
|                       | `zflow.repo-mapper`             | 6,000       |
| **Implementation**    | `zflow.implement-hard`          | 10,000      |
|                       | `zflow.implement-routine`       | 8,000       |
|                       | `zflow.verifier`                | 6,000       |
| **Code review**       | `zflow.review-correctness`      | 10,000      |
|                       | `zflow.review-integration`      | 8,000       |
|                       | `zflow.review-security`         | 8,000       |
|                       | `zflow.review-logic`            | 10,000      |
|                       | `zflow.review-system`           | 12,000      |
| **Plan review**       | `zflow.plan-review-correctness` | 10,000      |
|                       | `zflow.plan-review-integration` | 8,000       |
|                       | `zflow.plan-review-feasibility` | 10,000      |
| **Synthesis**         | `zflow.synthesizer`             | 12,000      |
| **Builtin (scout)**   | `builtin:scout`                 | 6,000       |
| **Builtin (context)** | `builtin:context-builder`       | 6,000       |

### Range summary

- Planning tier: 6,000–12,000
- Implementation tier: 6,000–10,000
- Review tier: 6,000–12,000
- Synthesis tier: 12,000
- Builtin agents: 6,000

## Enforcement flow

The enforcement chain has four steps. Every subagent launch passes
through all of them.

### 1. Agent frontmatter declares `maxOutput` (or omits it)

Agent markdown files in `packages/pi-zflow-agents/agents/` may declare
a `maxOutput` value in their frontmatter. This value is the agent's
self-declared limit and is used as a starting point for resolution.

```yaml
---
name: implement-routine
maxOutput: 8000
---
```

If omitted, the value will be filled in at step 3 from the expected
defaults.

### 2. Profile binding may override `maxOutput`

The active profile (from `pi-zflow-profiles`) may specify a
per-agent `maxOutput` override through `agentBindings`. When present,
this override takes precedence over the agent frontmatter value.

```ts
// Example profile binding
"zflow.planner-frontier": {
  model: "openai-codex/gpt-4o",
  maxOutput: 12000,
}
```

### 3. `applyDefaultMaxOutput()` fills in missing values

The `applyDefaultMaxOutput()` function in `output-limits.ts` does the
following:

- If `maxOutput` is **not set** (undefined): applies the expected
  default from `EXPECTED_MAX_OUTPUT`.
- If `maxOutput` is **set and matches** the expected value: passes
  through.
- If `maxOutput` is **set but does NOT match** the expected value:
  throws an error with an actionable message.
- If the agent is **unknown** (not in `EXPECTED_MAX_OUTPUT`): throws
  an error.

This function is called by `buildSubagentLaunchPlan()` in
`pi-zflow-change-workflows/orchestration.ts` before every agent launch.

### 4. `validateMaxOutput()` provides additional validation

The `validateMaxOutput()` function returns a detailed result object
rather than throwing, which is useful for:

- Collecting all validation errors before reporting them
- Producing clear diagnostic output during profile validation
- Testing and debugging

The strict variant `validateMaxOutputStrict()` throws on the first
failure and is useful for runtime guard checks.

## How to add a new agent

When adding a new agent to pi-zflow:

1. **Pick a reasonable `maxOutput` value** based on the agent's role
   and expected output complexity.
2. **Add an entry to `EXPECTED_MAX_OUTPUT`** in
   `packages/pi-zflow-profiles/src/output-limits.ts`.
3. **Optionally declare `maxOutput`** in the agent's frontmatter
   (recommended for self-documentation).
4. **Run the output-limits tests** to verify the new value is
   accepted: `npx tsx --test packages/pi-zflow-profiles/test/output-limits.test.ts`

### Value selection guidelines

| Agent type                            | Typical range | Notes                                 |
| ------------------------------------- | ------------- | ------------------------------------- |
| Planner / synthesizer                 | 12,000        | Long-form analysis and plan documents |
| Reviewer (correctness, logic, system) | 10,000        | Detailed code review with findings    |
| Reviewer (integration, security)      | 8,000         | Focused reviews, narrower scope       |
| Implementer (hard)                    | 10,000        | Complex implementation tasks          |
| Implementer (routine)                 | 8,000         | Standard implementation tasks         |
| Verifier / validator                  | 6,000         | Short structured output               |
| Scout / mapper                        | 6,000         | Concise reconnaissance output         |
| Reminder / mode fragment              | —             | No subagent launch needed             |

## Relationship to context window management

`maxOutput` is one layer in the multi-layered context management
strategy:

1. **Prevention** (`pi-mono-context-guard`) — prevents waste before it
   enters context.
2. **Compaction** (`pi-rtk-optimizer` + `pi-zflow-compaction`) —
   reduces existing context.
3. **Bounded output** (this policy) — caps how much each agent can
   produce in a single invocation.
4. **Focused skills** — inject only what is needed.
5. **Scout reconnaissance** — lazy-loading, not full dumps.
6. **Canonical artifact rereads** — prefer file-backed state over
   summarised memory.

Without step 3, a single overly verbose agent response can consume
the entire token budget saved by steps 1, 2, 4, 5, and 6.

## Enforcement guarantees

- Every call to `buildSubagentLaunchPlan()` invokes
  `applyDefaultMaxOutput()` before returning.
- Unknown agents without an `EXPECTED_MAX_OUTPUT` entry will be
  rejected at launch time.
- Mismatched values (frontmatter says 6000, plan says 8000) are
  caught with an actionable error message.
- The `enforceOutputLimits()` function can batch-validate all agents
  in a profile at once.
- There is no code path that launches a subagent without going through
  the enforcement chain.

## Testing

To verify maxOutput enforcement is working:

```bash
# Run the dedicated output-limits test suite
npx tsx --test packages/pi-zflow-profiles/test/output-limits.test.ts

# Run the policy document validation test
npx tsx --test packages/pi-zflow-profiles/test/max-output-policy.test.ts
```

## Future tuning

`maxOutput` values may be tuned over time as usage patterns emerge.
When tuning:

- Stay within the bounded ranges for the agent's role.
- Update `EXPECTED_MAX_OUTPUT` in `output-limits.ts`.
- Update this policy document to reflect the new values.
- Update all agent frontmatter files that declare `maxOutput` explicitly.
- Run the full output-limits test suite after changes.
