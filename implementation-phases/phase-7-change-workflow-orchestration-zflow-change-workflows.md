# Phase 7 — Change Workflow Orchestration (`pi-zflow-change-workflows` / `zflow-change-workflows`)

Status: planning artifact only. Do not implement until Zeb gives explicit approval to start implementation.

Package-family requirement: Before implementing this phase, read `package-split-details.md` and factor its modular package ownership, package-relative path convention, namespaced command/tool policy, and extension-coexistence rules into every task below.

## Phase goal

Implement the main formal workflow package, `pi-zflow-change-workflows`, that turns lower-level pieces from earlier phases into a coherent Pi-native operator experience.

This package owns the command UX for:

- formal `/zflow-change-prepare <change-path>` planning workflow
- formal `/zflow-change-implement <change-path>` implementation workflow
- cleanup and recovery entrypoint `/zflow-clean`
- optional audit/fix workflow entrypoints if implemented: `/zflow-change-audit <change-path>` and `/zflow-change-fix <change-path>`

It coordinates with, but does not own:

- `pi-zflow-plan-mode` for ad-hoc read-only `/zflow-plan` mode
- `pi-zflow-review` for `/zflow-review-code` and `/zflow-review-pr <url>`
- `pi-zflow-agents` for `/zflow-setup-agents` and `/zflow-update-agents`
- `pi-zflow-artifacts` for runtime path/state helper APIs
- `pi-zflow-runecontext` for RuneContext detection/resolution

It must own formal workflow state transitions, resume/recovery flow, session handoff, plan version lifecycle, verification/fix-loop orchestration, and human decision checkpoints.

## Scope and phase dependencies

### Depends on
- Phase 0 foundation contracts and runtime paths
- Phase 1 package skeletons and prompts/skills/agents from `pi-zflow-agents`
- Phase 2 `Profile.ensureResolved()` and lane-health handling from `pi-zflow-profiles`
- Phase 3 RuneContext detection/resolution from `pi-zflow-runecontext`
- Phase 4 chain and subagent integration
- Phase 5 worktree/apply-back/drift machinery
- Phase 6 review system from `pi-zflow-review`
- `pi-zflow-artifacts` runtime path/state helper APIs

### Enables
- The full intended user workflow of the harness

## Must-preserve decisions from the master plan

1. Extension commands are the primary UX.
2. `/zflow-plan` is a lightweight safety affordance, not the canonical durable planning workflow.
3. `/zflow-change-prepare <change-path>` is the canonical path for durable plans.
4. Planner agents must never modify source code.
5. Plans are versioned under `<runtime-state-dir>/plans/{change-id}/v{n}/` and approved versions are immutable once execution starts.
6. `plan-state.json` and `run.json` must explicitly track lifecycle state.
7. Default approval handoff should fork into a fresh implementation session file.
8. The handoff is a Pi session handoff, not automatic git branch creation.
9. Canonical plan artifacts and transient execution tracking are separate concerns.
10. In RuneContext mode, canonical RuneContext docs remain the source of truth and `execution-groups.md` is derived.
11. Final verification runs before code review unless Zeb explicitly skips it.
12. Review happens only after final verification passes by default.
13. Structured human checkpoints should use `pi-interview`.
14. A failure log must be maintained at `<runtime-state-dir>/failure-log.md`.
15. Cleanup/resume must be file/state driven, not transcript driven.
16. Runtime artifacts must remain outside the working tree and outside RuneContext portable trees.
17. `/zflow-clean` plus TTL cleanup is required to avoid indefinite artifact buildup.
18. Mode-specific prompt fragments and runtime reminders must be injected by workflow state, while safety-critical rules are enforced by tools/extensions.
19. Runtime reminders must be short, factual, and tied to authoritative state/artifact paths rather than becoming a second source of truth.
20. `pi-zflow-change-workflows` must remain individually installable while integrating with the umbrella suite through shared registry services.
21. Companion package commands (`/zflow-plan`, `/zflow-review-*`, `/zflow-setup-agents`) must be delegated to their owner packages rather than reimplemented here.
22. No generic command aliases or built-in tool overrides are registered by default.

## Shared context needed inside this phase

### Command surface and owner packages

```text
/zflow-plan                           # owned by pi-zflow-plan-mode; Phase 7 verifies integration
/zflow-plan status                    # owned by pi-zflow-plan-mode
/zflow-plan exit                      # owned by pi-zflow-plan-mode
/zflow-change-prepare <change-path>   # owned by pi-zflow-change-workflows
/zflow-change-implement <change-path> # owned by pi-zflow-change-workflows
/zflow-change-audit <change-path>     # optional, owned by pi-zflow-change-workflows if implemented
/zflow-change-fix <change-path>       # optional, owned by pi-zflow-change-workflows if implemented
/zflow-review-code                    # owned by pi-zflow-review; Phase 7 invokes/delegates
/zflow-review-pr <url>                # owned by pi-zflow-review
/zflow-clean                          # owned by pi-zflow-change-workflows
/zflow-setup-agents                   # owned by pi-zflow-agents; Phase 7 may call/check it
/zflow-update-agents                  # owned by pi-zflow-agents
```

Short aliases are optional and disabled by default; this phase must not assume aliases exist.

### Prompt fragments consumed by workflow packages

Phase 1 creates these prompt-fragment assets in `pi-zflow-agents`. Phase 7 and companion owner packages are responsible for loading/injecting the relevant fragments at the right times:

- `prompt-fragments/root-orchestrator.md`
- `prompt-fragments/modes/plan-mode.md`
- `prompt-fragments/modes/change-prepare.md`
- `prompt-fragments/modes/change-implement.md`
- `prompt-fragments/modes/review-pr.md`
- `prompt-fragments/modes/zflow-clean.md`
- `prompt-fragments/reminders/tool-denied.md`
- `prompt-fragments/reminders/plan-mode-active.md`
- `prompt-fragments/reminders/approved-plan-loaded.md`
- `prompt-fragments/reminders/drift-detected.md`
- `prompt-fragments/reminders/compaction-handoff.md`
- `prompt-fragments/reminders/external-file-change.md`
- `prompt-fragments/reminders/verification-status.md`

Injection rules:

- inject only fragments that match the active command/mode/state
- keep reminders short and state-specific
- include authoritative paths, IDs, and statuses when useful for re-anchoring
- never let reminders replace canonical plan artifacts, `plan-state.json`, `run.json`, or review findings
- pair safety reminders with actual active-tool/path-guard enforcement

### Runtime files coordinated by this package through `pi-zflow-artifacts`

`pi-zflow-artifacts` owns path/schema helpers; `pi-zflow-change-workflows` coordinates lifecycle updates for formal workflow state.

- `<runtime-state-dir>/state-index.json`
- `<runtime-state-dir>/failure-log.md`
- `<runtime-state-dir>/repo-map.md`
- `<runtime-state-dir>/reconnaissance.md`
- `<runtime-state-dir>/plans/{change-id}/plan-state.json`
- `<runtime-state-dir>/plans/{change-id}/v{n}/...`
- `<runtime-state-dir>/runs/{run-id}/run.json`
- `<runtime-state-dir>/review/code-review-findings.md`
- `<runtime-state-dir>/review/pr-review-{id}.md`

### Plan lifecycle states

- `draft`
- `validated`
- `reviewed`
- `approved`
- `executing`
- `drifted`
- `superseded`
- `completed`
- `cancelled`

### Transient run phases

- `planning`
- `reviewing`
- `executing`
- `applying`
- `verifying`
- `cleanup-pending`
- `apply-back-conflicted`
- `drift-pending`

### Verification command resolution policy used by this extension

Verification command precedence must be:

1. `verificationCommand` from the active profile
2. explicit shared repo config if later supported (for example under a `zflow` key in `.pi/settings.json`)
3. auto-detection in this exact order:
   - `just ci-fast` when `justfile` exists and the recipe exists
   - `npm test` when `package.json` has a `test` script
   - `make check` or `make test` when `Makefile` exists
   - `cargo test` when `Cargo.toml` exists
   - `pytest` when `pyproject.toml` or `setup.py` exists
   - otherwise prompt the user or explicitly skip verification

Additional rules:

- if auto-detected, tell Zeb which command was detected before running it
- verification logs/findings must redact secret-looking strings
- use existing environment/CLI auth where present; never ask the model to invent credentials
- if Zeb explicitly skips final verification, subsequent review must be marked advisory in the findings context

## Deliverables

- working workflow command implementations
- runtime-state persistence and recovery helpers
- `/zflow-plan` mode safety enforcement
- formal planning workflow orchestration
- formal implementation workflow orchestration
- cleanup and failure-log support
- structured human-checkpoint integration via `pi-interview`

## Tasks

---

### Task 7.1 — Integrate runtime path helpers and state-file bootstrap from `pi-zflow-artifacts`

#### Objective
Give the workflow extension one authoritative way to resolve all runtime-state locations via `pi-zflow-artifacts`.

#### Files to create/update
- `packages/pi-zflow-artifacts/src/artifact-paths.ts`
- `packages/pi-zflow-artifacts/src/state-index.ts`
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/index.ts`

#### Required helpers

```ts
resolveRuntimeStateDir(repoRoot)
resolveStateIndexPath(repoRoot)
resolvePlanStatePath(repoRoot, changeId)
resolvePlanVersionDir(repoRoot, changeId, version)
resolveRunPath(repoRoot, runId)
resolveReviewFindingsPath(repoRoot)
resolveFailureLogPath(repoRoot)
```

#### Important rules
- use `<git-dir>/pi-zflow/` when in git
- fallback to temp dir + stable cwd hash when not in git
- create parent dirs idempotently
- runtime artifacts must not dirty the working tree

#### Acceptance criteria
- Every workflow command uses the same path resolver.

---

### Task 7.2 — Implement `state-index.json` lifecycle and unfinished-run discovery

#### Objective
Make workflow resume and cleanup decisions state-driven.

#### Files to create/update
- `packages/pi-zflow-artifacts/src/state-index.ts`
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/index.ts`

#### Required `state-index.json` responsibilities
- unfinished runs
- retained worktrees/artifacts
- cleanup metadata
- last-known phase per change

#### Command-entry behavior
- on startup or workflow command entry, read `state-index.json`
- if unfinished work exists for the same change, offer resume / abandon / inspect / cleanup choices

#### Example pseudocode

```ts
const pending = stateIndex.changes[changeId]?.unfinishedRuns ?? []
if (pending.length) {
  return promptResumeChoices(pending)
}
```

#### Acceptance criteria
- Resume/cleanup decisions do not depend on transcript memory.

---

### Task 7.3 — Implement ad-hoc `/zflow-plan` mode state and command handling in `pi-zflow-plan-mode`

#### Objective
Add the lightweight read-only planning safety toggle in its owner package and expose state for workflow integration.

#### Files to create/update
- `packages/pi-zflow-plan-mode/extensions/zflow-plan-mode/index.ts`
- `packages/pi-zflow-plan-mode/extensions/zflow-plan-mode/state.ts`
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/index.ts` (integration/status checks only)

#### Commands
- `/zflow-plan`
- `/zflow-plan status`
- `/zflow-plan exit`

#### Required state behavior
- persist mode state across resume/reload via extension-managed session state
- display visible footer/widget status while active
- inject the `plan-mode-active` runtime reminder while active
- keep ad-hoc plan mode orthogonal to formal durable planning artifacts

#### Acceptance criteria
- Users can enter, inspect, and exit plan mode cleanly.
- The active prompt/reminder state makes it clear that user requests to implement are treated as planning requests until plan mode exits.

---

### Task 7.4 — Implement `/zflow-plan` tool restriction and restricted-bash enforcement in `pi-zflow-plan-mode`

#### Objective
Actually prevent source mutation while ad-hoc plan mode is active.

#### Files to create/update
- `packages/pi-zflow-plan-mode/extensions/zflow-plan-mode/index.ts`
- `packages/pi-zflow-plan-mode/extensions/zflow-plan-mode/bash-policy.ts`

#### Required behavior
- use `pi.setActiveTools(...)` to reduce tools to read-only exploration + structured question helpers
- block `edit` and `write`
- intercept tool calls to reject mutating bash even if the model attempts it

#### Bash patterns to reject
- redirection `>` and `>>`
- `tee`
- package installs
- editors
- git write commands
- `mv`, `rm`, destructive file ops
- pipelines that write to disk unless explicitly allowlisted

#### Example pseudocode

```ts
function isAllowedPlanModeBash(cmd) {
  if (/[>]{1,2}|\btee\b/.test(cmd)) return false
  if (/\b(git commit|git add|git checkout|rm|mv|npm install|pnpm add)\b/.test(cmd)) return false
  return true
}
```

#### Acceptance criteria
- Plan mode is enforced by tool policy, not just prompt instructions.

---

### Task 7.4A — Implement mode-fragment and runtime-reminder injection

#### Objective
Make workflow state visible to the model through concise prompt fragments while keeping state files and tool guards authoritative.

#### Files to create/update
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/index.ts`
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`
- maybe `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/prompt-fragments.ts`
- `packages/pi-zflow-plan-mode/extensions/zflow-plan-mode/index.ts`
- prompt fragment source assets in `packages/pi-zflow-agents/prompt-fragments/`

#### Required behavior
- load prompt fragments from package assets
- inject the root-orchestrator constitution into the main workflow/orchestrator context where supported
- inject mode fragments for active workflow commands
- inject runtime reminders when events occur or state changes
- remove/deactivate stale reminders when the mode/state ends
- log or expose assembled prompt state for debugging if practical

#### Required reminders and triggers

| Reminder | Trigger |
|---|---|
| `tool-denied` | a tool call or hook is denied/blocked |
| `plan-mode-active` | `/zflow-plan` mode is active |
| `approved-plan-loaded` | `/zflow-change-implement` loads an approved plan version |
| `drift-detected` | run enters `drift-pending` |
| `compaction-handoff` | session compaction occurs or a compacted session resumes |
| `external-file-change` | hook/file watcher reports user/linter modification |
| `verification-status` | final verification passes, fails, is skipped, or review is advisory |

#### Acceptance criteria
- Prompt state follows workflow state and does not linger after a mode exits.
- Runtime reminders are concise and include authoritative file/state paths when useful.
- Reminders never replace canonical artifacts or runtime state as the source of truth.

---

### Task 7.5 — Implement `/zflow-change-prepare <change-path>` orchestration

#### Objective
Make the formal planning workflow fully file-backed and durable.

#### Files to create/update
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/index.ts`

#### Required step sequence
1. `Profile.ensureResolved()`
2. check unfinished planning/review runs in `state-index.json`
3. resolve the change folder or active change
4. detect RuneContext via `pi-runecontext`
5. resolve and read canonical source docs
6. run `zflow.repo-mapper` or reuse fresh cached repo map
7. run builtin `scout` and persist `<runtime-state-dir>/reconnaissance.md`
8. inject the `change-prepare` mode fragment for the formal planning run
9. invoke `zflow.planner-frontier` to write versioned artifacts under the next `v{n}`
10. mark plan version `draft`
11. run `zflow.plan-validator`
12. if validation passes, mark `validated`
13. determine plan-review tier and build manifest
14. run conditional plan-review swarm
15. if major/critical findings exist, request revision and create `v{n+1}`
16. use `pi-interview` to present approve / revise / cancel
17. if approved, set `approvedVersion` and mark plan `approved`
18. present handoff choices:
   - fork implementation session (default)
   - implement in current session
   - dispatch background workers
19. stop after handoff selection unless immediate implementation was explicitly requested

#### Acceptance criteria
- Planning no longer depends on chat transcript copying.

---

### Task 7.6 — Implement plan versioning and `plan-state.json` updates

#### Objective
Track plan evolution explicitly and immutably.

#### Files to create/update
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`
- `artifact-paths.ts`

#### Required `plan-state.json` fields

```json
{
  "changeId": "...",
  "currentVersion": "v3",
  "approvedVersion": "v2",
  "lifecycleState": "approved",
  "runeContext": {
    "enabled": true,
    "changePath": "..."
  },
  "versions": {
    "v1": { "state": "superseded" },
    "v2": { "state": "approved" },
    "v3": { "state": "draft" }
  }
}
```

#### Important rules
- never edit approved versions in place once workers are dispatched
- revisions create new version dirs
- old versions remain for audit

#### Acceptance criteria
- Plan state is explicit, versioned, and resumable.

---

### Task 7.7 — Implement structured approval/revision/cancel gates with `pi-interview`

#### Objective
Use structured human-in-the-loop interactions at critical control points.

#### Files to create/update
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/index.ts`

#### Required planning gate choices
- approve this plan version
- request revisions
- cancel

#### Required implementation/review gate choices
- after review findings: select findings to fix / dismiss
- on plan drift: approve amendment / cancel / inspect retained artifacts
- on final verification failure: run bounded auto-fix loop vs manual review

#### Example interaction payload

```json
{
  "decision": "approve",
  "changeId": "feature-x",
  "version": "v2"
}
```

#### Acceptance criteria
- Key workflow forks use structured HITL flows, not freeform prompt text alone.

---

### Task 7.8 — Implement default implementation-session fork handoff

#### Objective
Preserve planning-session auditability while giving implementation a cleaner session context.

#### Files to create/update
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`

#### Required behavior
- fork/clone the current planning leaf into a new Pi session file
- record approved plan pointer (`changeId`, `approvedVersion`, runtime-state path)
- keep planning session available via session tree/resume
- do not create git branches automatically

#### Example pseudocode

```ts
const implSession = await ctx.fork(currentLeafId, { position: "at" })
await attachSessionMetadata(implSession, {
  changeId,
  approvedVersion,
  runtimeStateDir,
  sourceSession: currentSessionId,
})
```

#### Acceptance criteria
- Forked handoff is the default and is clearly separate from git branching.

---

### Task 7.9 — Implement `/zflow-change-implement <change-path>` orchestration

#### Objective
Drive the approved-plan execution lifecycle end to end.

#### Files to create/update
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/index.ts`

#### Required step sequence
1. `Profile.ensureResolved()` and lane-health preflight
2. check unfinished execution runs
3. resolve change and approved plan
4. if no approved plan exists, route to `/zflow-change-prepare` and stop unless approved
5. default to a forked implementation session
6. load canonical planning artifacts
7. inject the `change-implement` mode fragment plus `approved-plan-loaded` reminder with approved artifact paths
8. create `run.json`, set plan state `executing`
9. validate non-overlapping file ownership / ordering
10. verify primary worktree clean
11. verify `worktreeSetupHook` if needed
12. run `context-builder`
13. launch worktree-isolated groups
14. require worker-scoped verification
15. collect patches and metadata
16. apply back atomically
17. run `auto-fix`
18. resolve the authoritative verification command using the extension's precedence rules (profile → repo config → exact auto-detect order)
19. run final verifier
20. inject/update `verification-status` reminder based on pass/fail/skipped state
21. if final verification fails, enter bounded fix loop or manual choice
22. only after final verification passes, run code review
23. if Zeb explicitly skips final verification, record that the review is advisory before running it
24. read findings and propose fix plan
25. if fixes are approved, delegate fixes and rerun verification
26. on success, mark plan `completed`, finalize retention/cleanup state, and check in with Zeb

#### Acceptance criteria
- `/zflow-change-implement` follows the master plan’s execution order exactly.

---

### Task 7.10 — Implement bounded final-verification fix-loop orchestration

#### Objective
Provide limited automated recovery from verification failures without thrashing.

#### Files to create/update
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/verification.ts`
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`

#### Required policy
- default bound: max 3 fix iterations or about 15 minutes, whichever comes first
- start with the cheapest suitable worker lane/model
- stop and ask Zeb after the bound is exhausted
- support analysis-only mode if chosen

#### Example pseudocode

```ts
for (let i = 0; i < 3 && elapsedMinutes < 15; i++) {
  const result = await runVerifier()
  if (result.pass) return result
  await runTargetedFixIteration(result)
}
throw new Error("Verification fix loop exhausted")
```

#### Acceptance criteria
- Fix loops are bounded and policy-driven.

---

### Task 7.11 — Implement plan-drift handling within the orchestrated workflow

#### Objective
Tie Phase 5 deviation reporting into the main user-visible workflow.

#### Files to create/update
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`

#### Required behavior
- when run enters `drift-pending`, halt dependent execution
- inject the `drift-detected` runtime reminder with deviation-report paths
- synthesize deviation reports
- present Zeb with structured choices
- if amendment is approved, create `v{n+1}`, rerun validation/review, then restart execution
- mark previous executing plan as `drifted` or `superseded` as appropriate

#### Acceptance criteria
- Plan drift is resolved through versioned replanning, not in-place improvisation.

---

### Task 7.12 — Integrate `/zflow-review-code` behavior from `pi-zflow-review`

#### Objective
Expose internal code review as a direct command from its owner package and as a delegated post-implementation orchestration step.

#### Files to create/update
- `packages/pi-zflow-review/extensions/zflow-review/index.ts`
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/index.ts` (delegate/integration only)

#### Required behavior
- resolve repo root and review baseline
- ensure final verification status is known or explicitly skipped/advisory
- if final verification was skipped by explicit user choice, pass that context through so the findings file marks the review as advisory rather than release-gating
- invoke `zflow-review` internal code-review flow
- persist findings to `<runtime-state-dir>/review/code-review-findings.md`

#### Acceptance criteria
- Internal review can be run as an explicit command, not just as a substep of `/zflow-change-implement`.

---

### Task 7.13 — Integrate `/zflow-review-pr <url>` behavior from `pi-zflow-review`

#### Objective
Expose external diff-only PR/MR review from its owner package and let the main workflow delegate to it when needed.

#### Files to create/update
- `packages/pi-zflow-review/extensions/zflow-review/index.ts`
- `packages/pi-zflow-review/extensions/zflow-review/pr.ts`
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/index.ts` (delegate/integration only)

#### Required behavior
- parse URL
- run host/auth preflight as needed
- invoke diff-only external review pipeline
- persist findings to `<runtime-state-dir>/review/pr-review-{id}.md`
- offer triage/submission when possible

#### Acceptance criteria
- External review command is available from the main extension UX.

---

### Task 7.14 — Implement `/zflow-change-audit` and `/zflow-change-fix` command wrappers

#### Objective
Provide explicit user-facing hooks for reviewing a change and applying follow-up fixes.

#### Files to create/update
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/index.ts`
- `packages/pi-zflow-agents/prompts/zflow-draft-change-audit.md`
- `packages/pi-zflow-agents/prompts/zflow-draft-change-fix.md`

#### Suggested behavior

##### `/zflow-change-audit <change-path>`
- resolve approved/completed change context
- load plan + verification + latest findings
- run or rerun review if requested
- present summarized status and recommended next actions

##### `/zflow-change-fix <change-path>`
- load selected findings or verification failures
- build a focused fix plan
- dispatch targeted implementation/fix flow
- rerun verification and review as needed

#### Acceptance criteria
- Audit/fix commands are more than aliases; they are focused workflow wrappers.

---

### Task 7.15 — Implement failure-log append and read-before-similar-task behavior

#### Objective
Preserve lessons learned from replans, verification failures, and workflow breakdowns.

#### Files to create/update
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`
- maybe `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/failure-log.ts`

#### Required log format

```markdown
## 2026-05-11T12:00:00Z: Apply-back conflict on auth task group
- **Expected**: group patch applies cleanly after Group 1
- **Actual**: `git apply --3way` failed on src/auth/config.ts
- **Root cause**: plan-quality
- **Fix applied**: revised execution groups to make config changes sequential
- **Prevention**: validate overlapping config ownership during plan validation
```

#### Required behavior
- append after replanning, manual intervention, or bad output events
- read recent relevant entries before planning similar tasks if feasible

#### Acceptance criteria
- Failure log is maintained as a runtime artifact and influences later planning.

---

### Task 7.16 — Implement `/zflow-clean` and TTL-based cleanup policy

#### Objective
Prevent stale runtime artifacts and orphaned worktrees from growing forever.

#### Files to create/update
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/index.ts`
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`

#### Required command options
- `--dry-run`
- `--orphans`
- `--older-than <days>`

#### Required cleanup targets
- stale retained worktrees
- expired patch artifacts
- old run metadata beyond retention policy when safe
- obsolete runtime temp artifacts

#### Default retention policy
- stale runtime/patch artifacts: 14-day TTL
- failed/interrupted worktrees: 7-day retention by default
- successful temp worktrees: remove immediately after verified apply-back unless an explicit keep/debug option is used

#### Important rule
- successful worktrees are removed immediately; `/zflow-clean` is for leftovers and TTL cleanup
- `--dry-run` must preview what would be deleted before destructive cleanup

#### Acceptance criteria
- Cleanup is explicit and state-driven.

---

### Task 7.17 — Implement startup/resume recovery flows

#### Objective
Handle interrupted planning/execution/review sessions without transcript archaeology.

#### Files to create/update
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/index.ts`
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`

#### Required behaviors
- detect unfinished runs on command entry
- if apply-back status unknown, restore pre-apply snapshot before retry
- surface orphan paths if cleanup previously failed
- present resume / abandon / inspect / cleanup choices

#### Acceptance criteria
- Resume is based on `state-index.json`, `plan-state.json`, and `run.json`.

---

### Task 7.18 — Implement path-aware guard integration for mutation-capable workflows

#### Objective
Enforce safety beyond prompt instructions for planner/worker/report roles.

#### Files to create/update
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`
- maybe `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/path-guard.ts`

#### Required behavior
- allowlist project root, active worktrees, and planner artifact paths only
- reject writes to `.git`, `node_modules`, `.env*`, obvious secret files, home dotfiles
- reject symlink escapes and traversal
- planner may only write approved plan artifacts via `zflow_write_plan_artifact`
- non-implementation/report agents should return output instead of writing arbitrary files
- when the guard blocks a tool call, inject/use the `tool-denied` reminder and require the model to adjust rather than retry verbatim

#### Acceptance criteria
- Safety is enforced programmatically.

---

### Task 7.19 — Integrate `/zflow-setup-agents` and update checks from `pi-zflow-agents`

#### Objective
Make agent and chain installation manageable from the package that owns agent/chain assets, while allowing the main workflow to check/delegate setup.

#### Files to create/update
- `packages/pi-zflow-agents/extensions/zflow-agents/index.ts`
- `packages/pi-zflow-agents/extensions/zflow-agents/install.ts`
- `packages/pi-zflow-agents/extensions/zflow-agents/manifest.ts`
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/index.ts` (check/delegate only)

#### Required behavior
- create user-level target dirs if absent
- copy or install packaged agent and chain assets
- write `~/.pi/agent/zflow/install-manifest.json`
- be idempotent
- on version drift, recommend `/zflow-update-agents` or equivalent update flow rather than silently overwriting custom edits
- no-op safely if the same compatible agent installer is loaded through both umbrella and standalone packages

#### Acceptance criteria
- Agent installation is operational and repeatable from `pi-zflow-agents` and discoverable by the broader workflow.

---

### Task 7.20 — Add workflow smoke-test scenarios and documentation

#### Objective
Prove that the full command surface works as a coherent system.

#### Files to create later
- `README.md`
- test docs or script targets

#### Scenarios to cover
- enter/exit `/zflow-plan`
- run `/zflow-change-prepare` on an ad-hoc change
- run `/zflow-change-prepare` in RuneContext mode
- approve and fork implementation session
- run `/zflow-change-implement` through verification
- trigger drift and confirm version-bumped replanning
- run `/zflow-review-code`
- run `/zflow-review-pr`
- run `/zflow-clean --dry-run`

#### Acceptance criteria
- There is at least a manual end-to-end test recipe for the entire workflow surface.

## Phase exit checklist

- [ ] Runtime path helpers exist in/through `pi-zflow-artifacts`.
- [ ] `state-index.json` lifecycle and unfinished-run discovery exist.
- [ ] `/zflow-plan`, `/zflow-plan status`, and `/zflow-plan exit` exist in `pi-zflow-plan-mode`.
- [ ] `/zflow-plan` read-only tool enforcement exists in `pi-zflow-plan-mode`.
- [ ] Mode-fragment and runtime-reminder injection exists.
- [ ] `/zflow-change-prepare` orchestration exists.
- [ ] Plan versioning and `plan-state.json` updates exist.
- [ ] Structured `pi-interview` gates exist.
- [ ] Default implementation-session fork handoff exists.
- [ ] `/zflow-change-implement` orchestration exists.
- [ ] Final-verification fix loops are bounded and implemented.
- [ ] Drift handling is integrated into the main workflow.
- [ ] `/zflow-review-code` exists in `pi-zflow-review` and workflow delegation works.
- [ ] `/zflow-review-pr` exists in `pi-zflow-review` and workflow delegation works.
- [ ] `/zflow-change-audit` and `/zflow-change-fix` wrappers exist.
- [ ] Failure-log append/read behavior exists.
- [ ] `/zflow-clean` exists with TTL-based cleanup support.
- [ ] Startup/resume recovery flows exist.
- [ ] Path-aware guard integration exists.
- [ ] `/zflow-setup-agents` exists in `pi-zflow-agents` and workflow setup checks/delegation work.
- [ ] Smoke-test scenarios are documented.

## Handoff notes for later phases

- Phase 8 should plug context compaction and repo-map/recon cache behavior into these workflow entrypoints.
- This phase is where the user-facing harness becomes real; every earlier phase exists to support it.
