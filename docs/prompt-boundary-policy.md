# Prompt Boundary Policy

> **Canonical reference for maintaining clear instruction/data boundaries in prompts, skills, and prompt fragments.**
> Every prompt file, skill markdown, agent definition, and prompt fragment must follow these rules to reduce parsing ambiguity for LLMs and keep context-loading efficient.

## Why prompt boundaries matter

LLMs parse prompts linearly. When instructions, input data, examples, and constraints are mixed without clear structural delimiters, the model may:

- Interpret example data as normative instructions
- Fail to distinguish between the active mode's rules and general constitution rules
- Treat artifact content as system-level directives rather than input data
- Miss constraints buried inside prose paragraphs

Clear boundaries prevent these failure modes and make prompt loading more modular — each fragment is independently readable and can be injected or omitted without ambiguity.

## Formatting rules

### Rule 1: Separate instructions from input data

Use markdown headings (`##`, `###`) and/or XML-style tags to distinguish what the agent _must follow_ from what the agent _is told to read_.

**Good:**

```markdown
## Instructions

Implement only the approved plan groups.

## Input Artifacts

<plan-artifact>
{plan content from file}
</plan-artifact>
```

**Avoid:**

```markdown
Implement only the approved plan groups. Here is the plan: ...
```

### Rule 2: Keep examples distinct from normative instructions

Examples explain format or behaviour; they are not instructions themselves. Use code blocks, blockquotes, or a dedicated "## Examples" section.

**Good:**

````markdown
## Output Format

Return a structured report with these fields:

- `status`: one of `passed`, `failed`, `skipped`
- `details`: free-text summary of what was done

## Example

```markdown
- **status**: passed
- **details**: Implemented auth middleware, all 6 tests pass.
```
````

````

**Avoid:**
```markdown
Return a structured report. Example: status: passed, details: Implemented auth middleware.
````

### Rule 3: Use explicit labels for artifacts passed in

When artifact content is included in the prompt stream, wrap it with a labelled marker that is visually distinct from the surrounding instructions.

Supported labelling patterns:

- Markdown heading: `## Plan Artifact`
- XML-style tags: `<plan>...</plan>`
- Combined: `## Input Artifact` followed by `<artifact>...</artifact>`

### Rule 4: Put active mode/state constraints in clearly labelled sections

Mode-specific restrictions (e.g. "read-only", "no mutations", "deviation protocol") must be in a dedicated section rather than buried inside a general workflow description.

**Good:**

```markdown
## Mode Constraints

- No source file mutations. Allowed tools: read, grep, find, ls, bash.
- Plan artifact writes are permitted under `<runtime-state-dir>/plans/`.
```

### Rule 5: Avoid duplicating root-orchestrator rules

The root orchestrator constitution (`root-orchestrator.md`) is always loaded for every agent. Do not copy its rules into individual agent prompts, skills, or mode fragments unless:

- The role specifically needs the invariant restated because misapplication would be costly (e.g. safety rules for implementers)
- The fragment is loaded independently of the root constitution (e.g. standalone skill invocation via `/skills`)

## Example structures

### Agent prompt structure

```markdown
---
frontmatter: metadata
---

## Role

Brief statement of what this agent does.

## Core rules

Non-negotiable behavioural constraints.

## Workflow

Step-by-step execution flow. May reference sections from the plan or other artifacts.

## Input Artifacts

<approved-plan>
{relevant excerpts}
</approved-plan>

## Constraints

Mode-specific restrictions (when applicable).

## Communication

How and what to report back.
```

### Skill file structure

````markdown
---
name: skill-name
description: |
  Brief description of what this skill provides.
---

# Skill Name

Single-paragraph summary of when and why to use this skill.

## When to Use

- Scenario 1 — why
- Scenario 2 — why

## Format

Detailed description of expected output format or behaviour.

### Sub-section (if needed)

Additional formatting rules.

## Examples

```markdown
Example output demonstrating the format.
```
````

## Relationship to Other Skills

How this skill relates to other skills in the catalog (if applicable).

````

### Mode fragment structure

```markdown
# Mode: /zflow-{mode-name}

## Behaviour

What this mode does, when it activates, and how it changes agent behaviour.

## Restrictions

What the agent must NOT do while this mode is active.

## Verification (if applicable)

How to verify work done in this mode.

## Enforcement

How the restrictions are enforced (technical or procedural).
````

### Reminder fragment structure

```markdown
**Reminder title.** Single paragraph describing the reminder, including
reference paths or actions the agent should take. Self-contained and
actionable without referencing other documents.
```

Reminders must be:

- **Short**: under 700 characters
- **Single-purpose**: one reminder per fragment
- **Self-contained**: the model can act on it without reading additional files (paths included inline)

## Visual distinction hierarchy

The pi-zflow prompt system has three layers of visual distinction:

| Layer                   | Visual boundary                            | When loaded                                                        | Example files                                                    |
| ----------------------- | ------------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| **Root constitution**   | `##` headings, top-level                   | Always, on every agent start                                       | `root-orchestrator.md`                                           |
| **Mode fragments**      | `#` or `##` heading, `## Mode Constraints` | When workflow mode is active                                       | `modes/change-implement.md`, `modes/plan-mode.md`                |
| **Reminder fragments**  | Single bold sentence + optional body       | Injected contextually (e.g. after compaction, when drift detected) | `reminders/compaction-handoff.md`, `reminders/drift-detected.md` |
| **Canonical artifacts** | File path reference, never inlined         | Reread after compaction by agent choice                            | `repo-map.md`, `reconnaissance.md`, `plan-state.json`            |

### Design rules for the hierarchy

1. **No layer duplicates another.** If a rule appears in the root constitution, do not repeat it in a mode fragment. If a reminder repeats a mode restriction, remove it and rely on the mode fragment instead.
2. **Canonical artifacts are always file-backed.** Never inline a canonical artifact into a prompt fragment or skill. Reference it by path so the model can reread it when needed.
3. **Reminders are transient and contextual.** They target a specific situation (compaction, drift, tool denial). One reminder per situation. Do not compose multi-reminder bundles that are always injected.
4. **Mode fragments are injected based on workflow state.** Do not inherit all mode fragments into every agent. Load only the mode that matches the current workflow phase.

## Enforcement

- All new agent markdown files must follow the structure in "Agent prompt structure" above.
- All new skill files must follow the structure in "Skill file structure" above.
- All new prompt fragments must follow the structure in "Mode / Reminder fragment structure" above.
- Pull requests adding or modifying prompt files should be reviewed for boundary clarity.
- The `inheritSkills: false` default (enforced by the skill-loading policy) prevents accidental duplication across agents.
