# /zflow-draft-review-pr

## When to use this helper

Use this prompt helper to manually review a pull request or merge request **before** the formal `/zflow-review-pr <url>` extension command exists, or when you want a structured code review outside the automated reviewer-swarm flow.

This is a **drafting helper**, not the canonical automation flow. The formal `/zflow-review-pr` command (when available) provides multi-model reviewer dispatch, structured findings synthesis, and optional inline comment posting. Use this helper for quick manual reviews, ad-hoc code quality checks, or environments where the extension is not installed.

## Usage

1. Provide the PR/MR diff or branch name to review.
2. Invoke with `/zflow-draft-review-pr` and optionally specify review focus areas (correctness, security, style, integration, etc.).
3. The assistant will produce a structured review covering:
   - Overall assessment
   - Per-file findings with line references
   - Severity-graded issues (blocking, major, minor, advisory)
   - Verification limits (what was and was not checked)

## Review scope

When reviewing, consider:

- **Correctness**: does the code do what it intends?
- **Security**: are there injection risks, exposed secrets, or unsafe patterns?
- **Integration**: does the change work with existing interfaces?
- **Style**: does it follow project conventions?
- **Testing**: are there adequate tests for the change?
- **Performance**: are there obvious performance concerns?

## Important

- External PR/MR reviews are **diff-only** by default. Do not execute untrusted PR code unless explicitly instructed.
- Findings must state their verification limits (e.g. "static analysis only, not runtime-tested").
- If the PR is large, focus on the most impactful issues rather than exhaustive enumeration.

## Related

- Formal workflow: `/zflow-review-pr <url>` (when available)
- Code review: `/zflow-review-code` (when available)
