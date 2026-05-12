# /zflow-draft-change-implement

## When to use this helper

Use this prompt helper to manually implement a change from an approved plan **before** the formal `/zflow-change-implement <change-path>` extension command exists, or when you need to implement outside the automated worktree execution flow.

This is a **drafting helper**, not the canonical automation flow. The formal `/zflow-change-implement` command (when available) provides worktree isolation, verification/fix loops, deviation tracking, and automated apply-back. Use this helper for simple changes, exploratory implementation, or environments where the extension is not installed.

## Usage

1. Ensure you have an approved plan (produced by `/zflow-change-prepare` or `/zflow-draft-change-prepare`).
2. Invoke with `/zflow-draft-change-implement` and reference the approved plan.
3. The assistant will:
   - Walk through each planned change in order
   - Implement changes with appropriate tool usage
   - Verify each change against the plan's success criteria
   - Note any deviations for follow-up
4. Review the implementation summary and verify all changes are correct.

## Important

- Do not deviate from the approved plan. If you discover a better approach, stop and create a deviation note.
- Implement one change at a time and verify before moving to the next.
- If a change cannot be completed as planned, document the blocker and suggest a revision.

## Related

- Change preparation: `/zflow-draft-change-prepare`
- Audit implementation: `/zflow-draft-change-audit`
- Fix issues: `/zflow-draft-change-fix`
- Formal workflow: `/zflow-change-implement <change-path>` (when available)
