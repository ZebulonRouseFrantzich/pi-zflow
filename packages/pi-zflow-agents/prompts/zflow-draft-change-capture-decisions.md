# /zflow-draft-change-capture-decisions

## When to use this helper

Use this prompt helper to capture and document architectural or design decisions that arise during planning or implementation. This is useful when a decision is made that should be recorded for future reference but does not warrant a full change request.

This is a **drafting helper**, not the canonical automation flow. Decision capture is a manual refinement step; the formal `/zflow-change-prepare` and `/zflow-change-implement` workflows (when available) handle decision tracking as part of the artifact lifecycle.

## Usage

1. Invoke with `/zflow-draft-change-capture-decisions` and describe the decision context.
2. The assistant will help structure the decision record, including:
   - Context and problem statement
   - Alternatives considered
   - Decision rationale
   - Consequences and trade-offs
   - Related decisions or dependencies
3. The output is a decision record suitable for inclusion in project documentation (e.g. `docs/decisions/`).

## Output structure

- **Title**: concise decision name
- **Status**: proposed, accepted, deprecated, superseded
- **Context**: what prompted the decision
- **Decision**: what was decided
- **Alternatives considered**: other approaches and why they were not chosen
- **Consequences**: positive and negative effects
- **Related**: links to related decisions or change plans

## Related

- Change preparation: `/zflow-draft-change-prepare`
- Change implementation draft: `/zflow-draft-change-implement`
