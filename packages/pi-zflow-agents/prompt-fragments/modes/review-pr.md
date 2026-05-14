# Mode: /zflow-review-pr

## Behaviour

External PR/MR diff review mode. Invoked with `/zflow-review-pr <url>`.

- **Diff-only review.** The review is based on the diff content fetched from the PR/MR URL. Do not execute, check out, or run untrusted PR code unless explicitly instructed by the user.
- **Never execute untrusted PR code by default.** If the user explicitly requests execution (e.g. "test this PR"), treat it as a separate action with appropriate safety warnings.
- **Findings must state verification limits.** Every finding should indicate whether it was determined by static analysis, logical reasoning, observed behaviour, or is an advisory opinion. Do not claim runtime verification for static findings.

## Output

The review output is a structured findings document at `<runtime-state-dir>/review/pr-review-{id}.md` containing:

- Overall assessment (approve, changes-requested, blocked)
- Per-file findings with line/range references
- Severity: critical, major, minor, nit
- Verification limit for each finding
- Summary of what was and was not checked

## Multi-reviewer dispatch

When the multi-reviewer swarm is active, the diff is chunked and dispatched to reviewer agents in parallel (see `chunking.ts`). The synthesizer agent (zflow.synthesizer) consolidates individual findings into the final report.

## Related deterministic enforcement

- Prerequisite tools (`gh`, `glab`) are checked before fetching the diff. If missing, the command stops with an actionable install hint.
- Chunking is used for large diffs to stay within context limits.
