# Phase 6 — Multi-Provider Review (`zflow-review`)

Status: planning artifact only. Do not implement until Zeb gives explicit approval to start implementation.

Package-family requirement: Before implementing this phase, read `package-split-details.md` and factor its modular package ownership, package-relative path convention, namespaced command/tool policy, and extension-coexistence rules into every task below.

## Phase goal

Implement the review system inside the individually installable `pi-zflow-review` package for both internal changes and external PR/MR diffs using parallel reviewer agents plus a synthesizer that writes structured findings files.

This phase covers two closely related capabilities:

1. **Internal plan review and code review** driven by planning documents and diffs.
2. **External PR/MR review** driven by diff-only fetch through `gh` / `glab` without executing untrusted code.

## Scope and phase dependencies

### Depends on
- Phase 1 review agent prompts and synthesizer from `pi-zflow-agents`
- Phase 2 lane resolution and required-vs-optional reviewer policy from `pi-zflow-profiles`
- Phase 4 review chain wiring and reviewer-manifest structure
- Phase 5 implementation/apply-back flow for internal code review inputs
- `pi-zflow-artifacts` review findings path helpers

### Enables
- Phase 7 `/zflow-review-code`, `/zflow-review-pr`, plan-review gating, and post-verification review workflows

## Must-preserve decisions from the master plan

1. Review output for internal code review must be written to `<runtime-state-dir>/review/code-review-findings.md`.
2. Review findings use severity levels `critical`, `major`, `minor`, `nit`.
3. Raw reviewer output lives in `pi-subagents` artifacts; the findings file contains a structured summary.
4. Reviewers must read planning documents before reviewing diffs for internal reviews.
5. The synthesizer, not extension code, consolidates findings.
6. Reviewer support, reviewer dissent, and coverage notes must be preserved.
7. Core code reviewers are correctness, integration, and security.
8. Optional specialty reviewers are logic and system.
9. Optional reviewer absence must be recorded explicitly, not treated as silent success.
10. Required reviewer/synthesizer failures retry once after lane re-resolution; if still failing, ask Zeb.
11. Plan review is conditional by tier and uses review tags from `execution-groups.md`.
12. External PR/MR review is diff-only in the first pass.
13. Do not execute untrusted PR code automatically.
14. `/zflow-review-pr` uses direct `gh api` / `glab api`, not `pi-mono-review`.
15. Large PRs must be chunked without losing original line-number mapping.
16. Curated inline comment submission should use `pi-interview` for triage before `gh` / `glab` submission.
17. Review prompts are narrow role contracts assembled with the relevant review mode fragment and runtime verification-status reminder.
18. External PR/MR review must include the `review-pr` mode fragment so the diff-only/no-execution boundary is explicit.
19. `pi-zflow-review` must be usable standalone for users who only want review workflows, while integrating with the umbrella via the shared registry.
20. Review commands are namespaced (`/zflow-review-code`, `/zflow-review-pr`) and no generic `/review-*` aliases are registered by default.
21. Review logic must not override built-in tools or own unrelated rendering behavior.

## Shared context needed inside this phase

### Internal review inputs
- diff bundle
- `design.md`
- `execution-groups.md`
- `standards.md`
- `verification.md`
- verification results from the final verifier
- reviewer manifest

Additional rules:
- there is no separate first-pass "accepted findings" handoff layer; the primary orchestrator consumes the consolidated findings file directly and proposes a fix plan
- if Zeb explicitly skips final verification, the review context and findings file must state that review is advisory rather than release-gating
- review prompt assembly must include the `verification-status` reminder when final verification was skipped, failed, or is unknown
- internal reviewers receive planning docs plus diff bundle; external PR/MR reviewers receive diff chunks plus explicit diff-only/no-execution instructions

### Plan review tiers

| Tag | Plan review action |
|---|---|
| `standard` | skip plan-review swarm after validation |
| `logic` | correctness + integration |
| `system` | correctness + integration + feasibility |
| `logic,system` | full plan-review swarm |

### Code review tiers

| Tier | Core reviewers | Conditional reviewers |
|---|---|---|
| `standard` | correctness, integration, security | — |
| `+logic` | correctness, integration, security | logic |
| `+system` | correctness, integration, security | system |
| `+full` | correctness, integration, security | logic + system |

### Trigger rules to preserve

#### Add `zflow.review-logic` when ANY match
- `reviewTags: logic`
- `verification.md` mentions performance/complexity requirements
- modified files indicate algorithmic/performance/concurrency risk
- planner explicitly flags algorithmic risk

#### Add `zflow.review-system` when ANY match
- `reviewTags: system`
- >10 files changed or >3 directories touched
- cross-module dependencies listed
- public API changes present
- migration/schema/config changes present

### Review prompt assembly requirements

- code-review agents receive their role prompt plus internal-review context, planning docs, diff bundle, reviewer-manifest context where needed, and verification-status reminder
- plan-review agents receive planning artifacts only, not implementation diffs
- external PR/MR review agents receive the `review-pr` mode fragment and must not suggest running untrusted PR code as part of first-pass review
- synthesizer receives the reviewer manifest and must reason over actual executed/skipped/failed reviewer sets
- prompt assembly remains separate from deterministic safety: the extension must enforce diff-only external review behavior regardless of prompt adherence

## Deliverables

- `pi-zflow-review` / `zflow-review` extension or command wrapper around review chains
- reviewer-manifest creation and update logic
- plan-review execution flow and findings persistence
- code-review execution flow and findings persistence
- PR/MR diff fetch + chunk + review + triage + optional submission pipeline

## Tasks

---

### Task 6.1 — Implement reviewer-manifest creation for plan review and code review

#### Objective
Standardize how requested, executed, skipped, and failed reviewer coverage is represented.

#### Files to create/update
- `packages/pi-zflow-review/extensions/zflow-review/findings.ts`
- `packages/pi-zflow-review/extensions/zflow-review/index.ts`

#### Required manifest shape

```json
{
  "mode": "plan-review",
  "tier": "system",
  "requestedReviewers": ["correctness", "integration", "feasibility"],
  "executedReviewers": ["correctness", "integration"],
  "skippedReviewers": [
    { "name": "feasibility", "reason": "lane unavailable" }
  ],
  "failedReviewers": [],
  "runId": "run-123"
}
```

#### Acceptance criteria
- Manifest supports both internal plan review and code review.
- Synthesizer can infer real coverage from it.

---

### Task 6.2 — Implement tier selection for plan review

#### Objective
Use `execution-groups.md` review tags to decide when to run expensive plan-review swarms.

#### Files to create/update
- `packages/pi-zflow-review/extensions/zflow-review/index.ts`
- maybe `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/plan-validator.ts`

#### Rules
- `standard`: skip swarm after validation
- `logic`: correctness + integration
- `system`: correctness + integration + feasibility
- `logic,system`: full set

#### Example pseudocode

```ts
function choosePlanReviewTier(groups) {
  const tags = new Set(groups.flatMap(g => g.reviewTags))
  if (tags.has("logic") && tags.has("system")) return "logic,system"
  if (tags.has("system")) return "system"
  if (tags.has("logic")) return "logic"
  return "standard"
}
```

#### Acceptance criteria
- Plan-review selection matches the master plan exactly.

---

### Task 6.3 — Implement plan-review execution flow and gating

#### Objective
Run parallel planning-doc reviewers when required and block approval on major findings.

#### Files to create/update
- `packages/pi-zflow-review/extensions/zflow-review/index.ts`
- `chains/plan-review-chain.chain.md`

#### Required flow
1. run `zflow.plan-validator` first
2. if validation fails, stop and return for revision
3. build reviewer manifest
4. run requested reviewers in parallel with `worktree: false`
5. collect raw outputs into artifacts
6. run `zflow.synthesizer`
7. persist `<runtime-state-dir>/plans/{change-id}/v{n}/plan-review-findings.md`
8. if synthesized findings contain any `critical` or `major`, return to planner for revision
9. only `minor`/`nit` may proceed to approval

#### Example gating pseudocode

```ts
if (findings.summary.critical > 0 || findings.summary.major > 0) {
  return { action: "revise-plan", nextVersion: incrementVersion(currentVersion) }
}
```

#### Acceptance criteria
- Plan approval is gated by synthesized severity, not raw reviewer noise.

---

### Task 6.4 — Implement required-vs-optional reviewer retry behavior

#### Objective
Handle reviewer lane/runtime failures without silently reducing coverage.

#### Files to create/update
- `packages/pi-zflow-review/extensions/zflow-review/index.ts`

#### Required behavior
- required plan reviewers: correctness, integration, synthesizer
- optional plan reviewer: feasibility
- core code reviewers: correctness, integration, security
- optional code reviewers: logic, system
- on required failure: retry once after lane re-resolution; if still failing, ask Zeb
- on optional failure: record skip/failure and continue with reduced-coverage notes

#### Example pseudocode

```ts
async function runReviewerWithPolicy(reviewer) {
  try {
    return await runReviewer(reviewer)
  } catch (err) {
    await rereresolveLaneForReviewer(reviewer)
    try {
      return await runReviewer(reviewer)
    } catch (retryErr) {
      if (reviewer.required) throw retryErr
      return { skipped: true, reason: "retry-failed" }
    }
  }
}
```

#### Acceptance criteria
- Coverage loss is visible and policy-driven.

---

### Task 6.5 — Implement synthesized findings persistence for internal code review

#### Objective
Write the canonical internal review findings file in the required location and format.

#### Files to create/update
- `packages/pi-zflow-review/extensions/zflow-review/findings.ts`
- `packages/pi-zflow-review/extensions/zflow-review/index.ts`

#### Target file
- `<runtime-state-dir>/review/code-review-findings.md`

#### Required sections
- source / repo path / branch / base ref / generated time / run ID
- reviewed changes list
- verification context
- coverage notes
- findings summary by severity
- severity sections with structured findings

#### Example finding entry

```markdown
### Missing validation on CLI input
Reviewer support: security, correctness
Reviewer dissent: integration
Evidence: src/cli.ts lines 44-58 accept unsanitized path input
Why it matters: path traversal may be possible when called from automation
Failure mode: attacker-controlled relative path escapes intended root
Recommendation: normalize and enforce allowlisted roots before file access
```

#### Acceptance criteria
- Findings file format matches the plan and is written to the exact required path.

---

### Task 6.6 — Implement internal code-review tier selection and trigger rules

#### Objective
Add specialty reviewers only when the change merits them.

#### Files to create/update
- `packages/pi-zflow-review/extensions/zflow-review/index.ts`

#### Inputs to examine
- `execution-groups.md` review tags
- `verification.md`
- changed files and directories
- planner metadata if available

#### Example pseudocode

```ts
function chooseCodeReviewTier(ctx) {
  const addLogic = hasLogicTag(ctx) || mentionsPerformance(ctx.verification) || modifiedFilesMatchLogicKeywords(ctx.files)
  const addSystem = hasSystemTag(ctx) || touchesManyFiles(ctx) || hasPublicApiChanges(ctx)
  if (addLogic && addSystem) return "+full"
  if (addLogic) return "+logic"
  if (addSystem) return "+system"
  return "standard"
}
```

#### Acceptance criteria
- Logic/system reviewers are added according to the documented trigger rules.

---

### Task 6.7 — Ensure reviewers receive planning documents before reviewing internal diffs

#### Objective
Enforce the key review principle that implementation is evaluated against the plan first.

#### Files to create/update
- reviewer prompts
- `packages/pi-zflow-review/extensions/zflow-review/index.ts`

#### Required context to pass
- `design.md`
- `execution-groups.md`
- `standards.md`
- `verification.md`
- diff bundle
- verification status

#### Important rule
- Novel defect detection is secondary; plan adherence is primary.

#### Acceptance criteria
- No internal reviewer launches without plan documents in context.

---

### Task 6.8 — Implement `zflow.synthesizer` invocation and weighting guidance

#### Objective
Use the synthesizer to merge reviewer results instead of hardcoding merge logic in the extension.

#### Files to create/update
- `packages/pi-zflow-review/extensions/zflow-review/index.ts`
- `agents/synthesizer.md`

#### Required synthesis behavior
- de-duplicate same-root-cause findings
- retain highest well-evidenced severity
- note reviewer dissent explicitly
- downgrade weak single-reviewer observations to `nit`
- use specialty weighting:
  - logic reviewer weighs more on algorithm/performance
  - system reviewer weighs more on cross-module impact

#### Acceptance criteria
- The extension delegates consolidation to `zflow.synthesizer` rather than implementing bespoke severity-merge code.

---

### Task 6.9 — Preserve raw reviewer outputs in artifact directories and keep findings files summarized

#### Objective
Separate raw reviewer evidence from the operator-facing consolidated report.

#### Files to create/update
- `packages/pi-zflow-review/extensions/zflow-review/index.ts`
- `packages/pi-zflow-review/extensions/zflow-review/findings.ts`

#### Required behavior
- keep reviewer raw outputs in `pi-subagents` artifact directories
- findings file should contain summaries and pointers, not concatenated raw outputs
- preserve enough identifiers to trace a finding back to its raw reviewer artifact

#### Acceptance criteria
- Findings files stay readable while raw evidence remains available.

---

### Task 6.10 — Implement diff baseline resolution for internal review

#### Objective
Allow internal code review to compare against the correct base.

#### Files to create/update
- `packages/pi-zflow-review/extensions/zflow-review/index.ts`

#### Supported baselines
- default `main`
- `HEAD`
- merge-base with `main`
- arbitrary branch/ref when explicitly chosen

#### Example pseudocode

```ts
function resolveReviewBase(input) {
  return input.baseRef ?? "main"
}
```

#### Acceptance criteria
- Review can target the default baseline and explicit overrides.

---

### Task 6.11 — Implement `/zflow-review-pr <url>` parsing and host detection

#### Objective
Support external GitHub/GitLab PR/MR review via direct CLI/API integration.

#### Files to create/update
- `packages/pi-zflow-review/extensions/zflow-review/index.ts`
- maybe `packages/pi-zflow-review/extensions/zflow-review/pr.ts`

#### Required inputs to parse
- GitHub PR URL
- GitLab MR URL

#### Output contract

```ts
interface ResolvedPrTarget {
  platform: "github" | "gitlab"
  owner: string
  repo: string
  number: number
  url: string
}
```

#### Acceptance criteria
- URL parsing identifies host and target coordinates correctly.

---

### Task 6.12 — Implement diff-only external PR/MR fetch using `gh api` / `glab api`

#### Objective
Fetch all review inputs without checking out or executing untrusted code.

#### Files to create/update
- `packages/pi-zflow-review/extensions/zflow-review/pr.ts`

#### Required fetch data
- metadata: title, description, state, head SHA, base SHA
- changed files
- patch hunks with line-number annotations

#### Important safety rule
- do not run tests/builds/checkouts from PR code by default

#### Example pseudocode

```ts
if (target.platform === "github") {
  const pr = await ghApi(`/repos/${owner}/${repo}/pulls/${number}`)
  const files = await ghApi(`/repos/${owner}/${repo}/pulls/${number}/files`)
}
```

#### Acceptance criteria
- PR/MR review input is fully diff-based and host-authenticated where needed.

---

### Task 6.13 — Implement large-diff chunking with line-number preservation

#### Objective
Handle large PRs without losing the ability to submit accurate inline comments.

#### Files to create/update
- `packages/pi-zflow-review/extensions/zflow-review/pr.ts`
- maybe `packages/pi-zflow-review/extensions/zflow-review/chunking.ts`

#### Required behavior
- chunk by file groups when diff exceeds review limits
- preserve original file paths and right-side/new-side line numbers
- synthesize chunk findings back into one report

#### Example chunk structure

```json
{
  "chunkId": "chunk-2",
  "files": [
    {
      "path": "src/foo.ts",
      "patch": "@@ ...",
      "lineMap": { "reviewLine": 87, "diffRightLine": 112 }
    }
  ]
}
```

#### Acceptance criteria
- Chunking does not break inline comment submission coordinates.

---

### Task 6.14 — Implement external PR findings file generation

#### Objective
Produce a structured exportable review file for PR/MR review results.

#### Files to create/update
- `packages/pi-zflow-review/extensions/zflow-review/findings.ts`

#### Target path
- `<runtime-state-dir>/review/pr-review-{id}.md`

#### Required sections
- PR URL, platform, head/base SHA, generated timestamp
- coverage notes including diff-only/chunked/submission availability
- severity summary
- findings with file/line references and submit checkboxes

#### Example entry

```markdown
### Missing null guard in webhook parser
File: src/webhook.ts
Lines: 120-127
Evidence: diff introduces direct access to `payload.event.id` before `payload.event` is checked
Recommendation: guard `payload.event` before field access
Submit: [ ]
```

#### Acceptance criteria
- PR findings file format matches the plan.

---

### Task 6.15 — Implement `pi-interview`-backed triage before comment submission

#### Objective
Let Zeb select/edit/dismiss findings before inline comments are sent to a hosted PR/MR.

#### Files to create/update
- `packages/pi-zflow-review/extensions/zflow-review/index.ts`
- integration with `pi-interview`

#### Required triage actions
- select findings to submit
- dismiss findings
- edit wording before submission
- export without submission if auth/permissions are missing

#### Example interaction shape

```json
{
  "findingId": "major-2",
  "action": "submit",
  "editedBody": "Please add input validation here because..."
}
```

#### Acceptance criteria
- Inline comment submission is curated, not automatic.

---

### Task 6.16 — Implement auth/permission checks and graceful export-only fallback

#### Objective
Handle missing CLI auth/permissions cleanly for hosted review submission.

#### Files to create/update
- `packages/pi-zflow-review/extensions/zflow-review/pr.ts`
- `packages/pi-zflow-review/extensions/zflow-review/index.ts`

#### Required checks
- `gh auth status` when GitHub submission is requested
- `glab auth status` when GitLab submission is requested

#### Required fallback
- if auth/permissions are missing, generate findings file only
- clearly state why submission was skipped

#### Acceptance criteria
- Missing auth never blocks offline findings generation.

---

### Task 6.17 — Add review-mode-specific prompts/context for external diff-only review

#### Objective
Avoid confusing reviewers by sending internal-plan instructions when no plan exists.

#### Files to create/update
- reviewer prompts or wrapper prompts
- `packages/pi-zflow-review/extensions/zflow-review/index.ts`

#### Behavior rules
- internal review: reviewers get planning docs + diff, with plan-adherence as the primary task
- external PR review: reviewers get diff only, with pure defect/security/integration detection as the task
- preserve severity scheme across both modes

#### Acceptance criteria
- Reviewer instructions differ appropriately between internal and external review modes.

---

### Task 6.18 — Add tests/smoke procedures for internal and external review paths

#### Objective
Prove the review stack works before the orchestration layer depends on it heavily.

#### Files to create later
- `packages/pi-zflow-review/test/*.test.ts`
- fixture diffs and fixture manifests

#### Cases to cover
- standard internal review
- `+logic` and `+system` reviewer selection
- required reviewer retry path
- optional reviewer skip path
- synthesizer de-duplication and dissent capture
- GitHub PR URL parsing
- GitLab MR URL parsing
- large-diff chunking preserves line mappings
- export-only fallback when auth missing

#### Acceptance criteria
- Review behavior is testable for both internal and external paths.

## Phase exit checklist

- [ ] Reviewer-manifest generation exists.
- [ ] Plan-review tier selection exists.
- [ ] Plan-review flow and gating are implemented.
- [ ] Reviewer retry/skip policy is implemented.
- [ ] Internal code-review findings write to the required path/format.
- [ ] Code-review tier selection and trigger rules exist.
- [ ] Internal reviewers receive planning docs before diffs.
- [ ] `zflow.synthesizer` is used for consolidation.
- [ ] Raw reviewer outputs remain in artifact directories.
- [ ] Diff baseline resolution exists.
- [ ] `/zflow-review-pr` URL parsing and host detection exist.
- [ ] PR/MR review fetch is diff-only via `gh` / `glab`.
- [ ] Large-diff chunking preserves line numbers.
- [ ] PR findings file generation exists.
- [ ] `pi-interview` triage exists before submission.
- [ ] Auth/permission fallback to export-only works.
- [ ] Internal vs external review prompts differ correctly.
- [ ] Tests/smoke procedures are planned or implemented.

## Handoff notes for later phases

- Phase 7 will call plan review during `/zflow-change-prepare`, code review after final verification, and `/zflow-review-pr` directly from the workflow extension.
- The review findings formats defined here should be treated as canonical outputs for human triage and follow-up fixes.
