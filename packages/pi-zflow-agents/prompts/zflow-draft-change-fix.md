# /zflow-draft-change-fix

## When to use this helper

Use this prompt helper to address issues found during an implementation audit or review. This is useful for making targeted fixes to an implemented change without re-running the full implementation flow.

This is a **drafting helper**, not the canonical automation flow. The formal `/zflow-change-implement` workflow (when available) includes automated fix loops as part of the verification stage. Use this helper for manual fixup after an audit, or when addressing review feedback.

## Usage

1. Invoke with `/zflow-draft-change-fix` and describe the issue to fix, ideally referencing the audit report produced by `/zflow-draft-change-audit`.
2. The assistant will:
   - Understand the issue and its root cause
   - Propose a targeted fix
   - Implement the fix with minimal scope
   - Verify the fix resolves the original issue without introducing new problems
3. Review the fix and confirm it is complete before proceeding.

## Guidance

- Keep fixes narrow: change only what is needed to resolve the specific issue.
- If the fix reveals a larger problem, stop and flag it for replanning.
- After fixing, re-run audit to confirm the implementation is back on track.

## Related

- Change audit: `/zflow-draft-change-audit`
- Change implementation draft: `/zflow-draft-change-implement`
