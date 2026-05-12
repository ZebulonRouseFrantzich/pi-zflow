# Mode: /zflow-change-implement

## Behaviour

Implementation mode for an approved plan version. Invoked with `/zflow-change-implement <change-path>`.

- **Execute only the approved immutable plan version.** The plan version is pinned at approval time and must not change during implementation.
- **Implement one change group at a time**, verifying against the plan's success criteria before proceeding to the next.
- **If the implementation deviates from the plan**, stop, create a deviation report at `<runtime-state-dir>/plans/{changeId}/deviations/{planVersion}/`, and initiate versioned replanning (not ad-hoc scope changes).

## Restrictions

- The implementer must not modify plan state or plan artifacts. Plan state transitions are owned by the orchestrator.
- If a planned change cannot be completed as specified, file a deviation rather than silently altering scope.
- The implementation worktree is isolated from the working tree. Apply-back to the working tree is a separate step owned by the orchestrator.

## Verification

- After each change group, verify against the plan's success criteria.
- If verification fails, the fix loop runs: fix → re-verify (bounded by max retries).
- If the fix loop cannot resolve the issue, escalate to the user via a structured deviation report.

## Enforcement

- Worktree isolation is enforced by the worktree execution framework.
- Drift detection is enforced by the verifier agent and the deviation report process.
- The path guard (`path-guard.ts`) gates all implementation writes through `canWrite()` with `intent: "implementation"`.
