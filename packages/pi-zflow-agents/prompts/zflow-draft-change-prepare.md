# /zflow-draft-change-prepare

## When to use this helper

Use this prompt helper to brainstorm or manually refine a change request before you commit it to the formal workflow.

This is a **drafting helper**, not the canonical automation flow. The formal workflow now uses `/zflow-change-plan` to create or update `docs/zflow-changes/<changeId>/plan.md`, then `/zflow-change-prepare` to generate versioned plan artifacts. Use this helper for early-stage exploration, brainstorming, or when working in an environment where the extension is not installed.

## Usage

1. Start a new conversation or fresh session.
2. Invoke with `/zflow-draft-change-prepare` and describe the change you want to plan.
3. The assistant will guide you through:
   - Problem definition and success criteria
   - Scope boundaries (what is in/out)
   - File-by-file change inventory
   - Dependency and risk assessment
4. The output is a structured plan draft suitable for review and refinement.
5. When you are ready to enter the formal workflow, use `/zflow-change-plan <description|change-id|path> [-- notes]`.

## Output structure

A well-formed change plan should include:

- **Change identifier**: a short name (e.g. `ch42` or `feat-auth`)
- **Problem statement**: what is being solved and why
- **Success criteria**: how we know the change is complete
- **Scope**: explicit in/out list
- **Implementation sketch**: file-by-file changes with rationale
- **Risks and unknowns**: dependencies, breaking changes, migration needs
- **Review checklist**: what to verify before implementation

## Related

- Formal workflow: `/zflow-change-plan <description|change-id|path> [-- notes]` then `/zflow-change-prepare <change-path>`
- Capture decisions: `/zflow-draft-change-capture-decisions`
- Standards template: `/zflow-standards-template`
