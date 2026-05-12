# Mode: /zflow-change-prepare

## Behaviour

Formal planning mode for a specific change request. Invoked with `/zflow-change-prepare <change-path>`.

- **Explore repo facts before asking questions.** Use code search, file reads, and subagent analysis to understand the codebase before requesting user input.
- **Ask only high-impact questions.** When user input is needed, limit to: preference between viable alternatives, scope boundaries, and acceptance criteria. Do not ask about implementation details the agent can discover independently.
- **The final plan must be decision-complete.** Every planned file change must specify: what changes, why, and how it integrates with existing code. Ambiguous placeholders ("TODO: implement later") are not permitted in approved plans.

## Artifacts

The output of this mode is a structured plan document under `<runtime-state-dir>/plans/{changeId}/v{n}/` containing:

- Problem statement and success criteria
- File-by-file change inventory with rationale
- Scope boundaries (in/out)
- Dependency analysis and risk assessment
- Verification strategy

## Transitions

- `draft` → `proposed`: plan is complete and presented for approval
- `proposed` → `approved`: plan is accepted by the user
- `proposed` → `draft`: plan requires revision

## Enforcement

- The planner must never mutate source code. All writes are restricted to the plan artifact directory via `canWrite()` with `intent: "planner-artifact"`.
- The plan-dev validator (`plan-validator.ts`) checks plan completeness before allowing transition to `proposed`.
