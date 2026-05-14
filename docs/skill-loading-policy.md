# Skill and Prompt-Fragment Loading Policy

> **Canonical policy for keeping skills and prompt fragments small, focused, and loaded on demand.**

## Core rule

**Inject only needed focused skills into each agent.**  
Do not turn the skill catalog or prompt-fragment directory into a giant always-inherited prompt bundle.

Skills and prompt fragments are targeted, role-specific context building blocks. They must remain small, independently loadable, and explicitly assigned to agents whose role requires them.

---

## Inheritance defaults

### `inheritSkills: false`

All pi-zflow agents use `inheritSkills: false` by default. This means:

- No agent automatically inherits every skill in the catalog
- Each agent must explicitly declare required skills in its frontmatter `skills:` field
- Skills are injected only when an agent starts, based on its declared needs

This is enforced across all agents:

| Agent                     | `inheritSkills` | Declared skills                                                    |
| ------------------------- | --------------- | ------------------------------------------------------------------ |
| `implement-routine`       | `false`         | `implementation-orchestration, code-skeleton`                      |
| `implement-hard`          | `false`         | `implementation-orchestration, code-skeleton, plan-drift-protocol` |
| `planner-frontier`        | `false`         | `change-doc-workflow, runecontext-workflow`                        |
| `plan-validator`          | `false`         | `change-doc-workflow`                                              |
| `plan-review-correctness` | `false`         | `change-doc-workflow, runecontext-workflow`                        |
| `plan-review-feasibility` | `false`         | `change-doc-workflow, code-skeleton, repository-map`               |
| `plan-review-integration` | `false`         | `change-doc-workflow, repository-map`                              |
| `repo-mapper`             | `false`         | `repository-map`                                                   |
| `review-correctness`      | `false`         | `multi-model-code-review`                                          |
| `review-integration`      | `false`         | `multi-model-code-review`                                          |
| `review-logic`            | `false`         | `multi-model-code-review`                                          |
| `review-security`         | `false`         | `multi-model-code-review`                                          |
| `review-system`           | `false`         | `multi-model-code-review`                                          |
| `synthesizer`             | `false`         | `multi-model-code-review`                                          |
| `verifier`                | `false`         | `implementation-orchestration`                                     |

---

## When skills SHOULD be loaded

- **Role relevance** — when an agent's role specifically requires the knowledge encoded in that skill (e.g. `repository-map` skill for `repo-mapper` agent, `multi-model-code-review` for reviewers)
- **Explicit frontmatter** — via the `skills:` field in agent definition frontmatter
- **On-demand injection** — via the `loadFragment()` helper from `pi-zflow-agents` in `before_agent_start` hooks, when dynamic conditions require a skill that the agent doesn't normally use
- **After compaction** — when a reread of canonical state could benefit from skeleton or repo-map knowledge

## When skills should NOT be loaded

- **As always-inherited background knowledge** — no agent should inherit all skills unconditionally
- **Into agents whose role doesn't need them** — implementation workers do not need review workflow skills; reviewers do not need implementation orchestration skills
- **Into implementation agents unnecessarily** — workers (implement-routine, implement-hard, verifier) should focus on code, not meta-workflow knowledge. Only load the skills they explicitly need for their task
- **When context is tight** — prefer loading a single targeted skill over multiple general ones

---

## Size budgets

### Skill files

| Budget              | Rule                                                                         |
| ------------------- | ---------------------------------------------------------------------------- |
| **Target**          | Each skill `SKILL.md` should be **under 5KB**                                |
| **Warning**         | Skills between 5KB–10KB should be reviewed for unnecessary content           |
| **Action required** | Skills over 10KB should be split into focused sub-skills or prompt fragments |

### Current skill sizes

| Skill                          | Size   | Status                                                                                                                                                                                                             |
| ------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `change-doc-workflow`          | 4.4KB  | ✅ Under 5KB                                                                                                                                                                                                       |
| `code-skeleton`                | 3.4KB  | ✅ Under 5KB                                                                                                                                                                                                       |
| `implementation-orchestration` | 3.4KB  | ✅ Under 5KB                                                                                                                                                                                                       |
| `multi-model-code-review`      | 4.5KB  | ✅ Under 5KB                                                                                                                                                                                                       |
| `plan-drift-protocol`          | 4.1KB  | ✅ Under 5KB                                                                                                                                                                                                       |
| `repository-map`               | 3.6KB  | ✅ Under 5KB                                                                                                                                                                                                       |
| `runecontext-workflow`         | 29.5KB | ⚠️ **Known outlier** — covers RuneContext detection, change-doc parsing, and write-back. Loaded **only** for planner-frontier and plan-review-correctness. Consider splitting when RuneContext features stabilize. |

### Prompt fragment sizes

| Category               | Budget             | Current state                                         |
| ---------------------- | ------------------ | ----------------------------------------------------- |
| **Mode fragments**     | **Under 2KB** each | ✅ All 7 mode fragments are under 2KB (949B–1.6KB)    |
| **Reminder fragments** | **Under 1KB** each | ✅ All 7 reminder fragments are under 1KB (242B–660B) |
| **Root orchestrator**  | Under 5KB          | ✅ 4.4KB — within budget                              |

---

## Loading mechanism

### Agent startup flow

1. Pi extension loader activates `pi-zflow-agents` extension
2. `before_agent_start` hook fires
3. The hook reads the agent's frontmatter `skills:` field
4. Only those explicitly declared skills are loaded and injected into the system prompt
5. Prompt fragments are loaded on demand based on active workflow `mode` and runtime `reminders`
6. Fragments are injected via `loadFragment()` from `pi-zflow-agents/prompt-fragments`

### On-demand loading via hooks

```ts
import { loadFragment } from "pi-zflow-agents";

pi.on("before_agent_start", async (event) => {
  // Only load what this specific agent needs
  if (event.agentName === "zflow.planner-frontier") {
    const planModeFragment = await loadFragment("plan-mode");
    return {
      systemPrompt: event.systemPrompt + `\n\n${planModeFragment}`,
    };
  }
  return {};
});
```

### Prompt-fragment loading

Fragments are loaded individually, not as a bundle:

- **Mode fragments** (`prompt-fragments/modes/`): loaded only when the corresponding workflow mode is active
- **Reminder fragments** (`prompt-fragments/reminders/`): loaded only when the corresponding runtime condition is active
- **Root orchestrator** (`prompt-fragments/root-orchestrator.md`): loaded once at startup as the constitution

---

## Relationship between layers

```text
Root orchestrator (always loaded)
├── Mode fragment (loaded when mode is active)
│   └── Agent role prompt (agent markdown)
│       └── Selected skills (from frontmatter skills: field)
└── Reminder fragments (loaded when conditions are active)
```

Each layer is independently injectable and scoped to its role. No layer should duplicate rules from another layer unless the role specifically needs the invariant restated.

---

## Review and enforcement

- **Code review**: changes to skill files or prompt fragments should verify size budgets are maintained
- **Phase checks**: the phase exit checklist for context-management phases includes verifying skill and fragment sizes
- **CI**: a test (`skill-loading-policy.test.ts`) validates that all prompt fragments stay within their budgets and flags outlier skill files for review
