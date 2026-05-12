# /zflow-draft-change-audit

## When to use this helper

Use this prompt helper to audit an implemented change against its original plan. This is useful for verifying that an implementation matches the approved scope, identifying unintended side effects, and generating a completeness report.

This is a **drafting helper**, not the canonical automation flow. The formal `/zflow-change-implement` workflow (when available) includes automated verification and deviation tracking as part of the implementation lifecycle. Use this helper for manual post-implementation review or when verifying work done outside the formal flow.

## Usage

1. Invoke with `/zflow-draft-change-audit` and reference both the original plan and the implemented changes.
2. The assistant will compare each planned change against what was actually implemented, noting:
   - Changes that match the plan
   - Changes that deviate from the plan (with deviation details)
   - Changes in the plan that were not implemented
   - Changes implemented that were not in the plan
3. The output is an audit report with a completeness score and actionable findings.

## Output structure

- **Change reference**: the plan or change request being audited
- **Scope match**: how well the implementation matches the planned scope
- **Deviations found**: each deviation with details
- **Side effects**: unintended changes detected
- **Unimplemented items**: planned work not completed
- **Completeness assessment**: summary judgement with gaps identified
- **Recommendations**: next steps to close gaps

## Related

- Change implementation draft: `/zflow-draft-change-implement`
- Fix issues: `/zflow-draft-change-fix`
