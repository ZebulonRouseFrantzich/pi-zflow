# Phase 5 — Worktree Isolation & Apply-Back

Status: planning artifact only. Do not implement until Zeb gives explicit approval to start implementation.

Package-family requirement: Before implementing this phase, read `package-split-details.md` and factor its modular package ownership, package-relative path convention, namespaced command/tool policy, and extension-coexistence rules into every task below.

## Phase goal

Implement safe parallel execution of logical task groups using `pi-subagents` native worktree support, plus the custom orchestration logic needed to:

- validate clean-tree and file-ownership preconditions
- launch one worktree per logical task group by default
- record worktree and run metadata for recovery
- apply group patches back atomically in dependency order
- handle conflicts without leaving partial results behind
- enforce the Plan Drift Protocol when the approved plan is infeasible
- support retained debugging artifacts and cleanup tracking

This phase is critical because it turns the planning system into a robust parallel implementation workflow instead of a best-effort patch pile.

## Scope and phase dependencies

### Depends on
- Phase 0 cleanup/worktree policy and path-safety decisions
- Phase 1 `pi-zflow-agents` worker agent prompts and plan-drift skill
- Phase 4 subagent wiring and chain behavior
- `pi-zflow-artifacts` runtime state/path helpers
- `pi-zflow-change-workflows` as the owner package for worktree/apply-back orchestration

### Enables
- Phase 7 full `/zflow-change-implement` orchestration
- reliable bounded verification/fix loops against applied changes

## Must-preserve decisions from the master plan

1. Use `pi-subagents` native `worktree: true`; do not build custom worktree cloning from scratch.
2. Worktrees are per logical task group by default.
3. The primary worktree must be clean before parallel execution.
4. Overlapping file ownership must be validated; conflicting groups run sequentially or fail planning validation.
5. `worktreeSetupHook` is supported for repos that need setup inside temp worktrees; ship generic templates, but keep actual hooks per-repo configuration.
6. If a repo needs setup and no hook is configured, fail fast.
7. Workers may create temporary commits for checkpointing.
8. Apply-back uses binary-safe patch replay with `git apply --3way --index --binary` in topological group order.
9. Apply-back is atomic: if any group fails, reset the primary worktree/index to the pre-apply snapshot.
10. Branch-aware merge/cherry-pick apply-back is deferred; keep the patch-replay implementation behind a clean strategy interface so it can be added later if needed.
11. Approved plans are immutable once workers are dispatched.
12. If plan infeasibility is discovered, workers stop, file deviation reports, and the orchestrator replans into a new version.
13. Successful worktrees should be cleaned immediately; stale retained artifacts are handled by cleanup policy and `/zflow-clean`.
14. Worktree/apply-back code belongs in `pi-zflow-change-workflows`; durable path/state helpers belong in `pi-zflow-artifacts`.
15. This phase must not add built-in tool overrides or generic command aliases.

## Shared context needed inside this phase

### `pi-subagents` native worktree behavior being relied on

- creates temp worktrees under `/tmp/pi-worktree-{runId}-{index}`
- branches from `HEAD`
- symlinks `node_modules/`
- requires a clean working tree
- captures diff stats and patch artifacts
- cleans up in `finally` blocks

### Additional custom behavior we must add

1. clean-tree preflight
2. untracked overlap detection
3. explicit file-ownership validation from `execution-groups.md`
4. `run.json` pre-apply snapshot and recovery metadata
5. topological apply-back in dependency order
6. atomic rollback on any apply failure
7. Plan Drift Protocol with deviation reports and optional `pi-intercom`
8. cleanup tracking for retained worktrees/patches

### Key runtime files in this phase

- `<runtime-state-dir>/runs/{run-id}/run.json`
- `<runtime-state-dir>/plans/{change-id}/deviations/{plan-version}/{group}-{worker}.md`
- `<runtime-state-dir>/plans/{change-id}/deviations/{plan-version}/deviation-summary.md`
- `<runtime-state-dir>/state-index.json`

## Deliverables

- worktree preflight logic
- group-overlap validator
- `worktreeSetupHook` integration
- per-run metadata recorder
- apply-back engine with atomic rollback
- Plan Drift Protocol implementation
- retained-artifact tracking and cleanup metadata updates

## Tasks

---

### Task 5.1 — Implement clean-tree and untracked-overlap preflight

#### Objective
Block parallel worktree execution unless the primary worktree is in a safe state.

#### Files to create/update
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`
- maybe `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/git-preflight.ts`

#### Required checks
- `git status --porcelain` is empty for tracked changes
- untracked files do not overlap planned output paths
- current branch/HEAD are captured for recovery metadata

#### Example pseudocode

```ts
async function assertCleanPrimaryTree(repoRoot, plannedPaths) {
  const status = await gitPorcelain(repoRoot)
  if (status.trackedChanges.length > 0) throw new Error("Primary worktree must be clean before parallel execution")
  const overlappingUntracked = status.untracked.filter(p => plannedPaths.has(p))
  if (overlappingUntracked.length) throw new Error(`Untracked files overlap planned outputs: ${overlappingUntracked.join(", ")}`)
}
```

#### Acceptance criteria
- Dirty primary trees are rejected before any worktree dispatch.

---

### Task 5.2 — Validate file ownership boundaries and dependency order from `execution-groups.md`

#### Objective
Prevent conflicting parallel writes before workers are launched.

#### Files to create/update
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`
- maybe `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/plan-validator.ts`

#### Inputs from the plan
- exact file operations by group
- group dependencies
- assigned agents
- scoped verification entries

#### Validation rules
- no overlapping claimed files in groups marked parallelizable
- if overlap exists and dependency order is explicit, schedule sequentially
- if overlap exists and sequencing is ambiguous, fail before dispatch

#### Example pseudocode

```ts
function detectOwnershipConflicts(groups) {
  const owners = new Map<string, string[]>()
  for (const group of groups) {
    for (const file of group.files) owners.set(file, [...(owners.get(file) ?? []), group.id])
  }
  return [...owners.entries()].filter(([, ids]) => ids.length > 1)
}
```

#### Acceptance criteria
- Parallel groups cannot accidentally claim the same file without explicit sequencing.

---

### Task 5.3 — Add `run.json` creation and pre-apply snapshot recording

#### Objective
Create recovery-grade run metadata before launching workers or applying patches.

#### Files to create/update
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`
- `packages/pi-zflow-artifacts/src/artifact-paths.ts`

#### Required `run.json` content

```json
{
  "runId": "...",
  "repoRoot": "...",
  "branch": "feature/foo",
  "head": "<sha>",
  "changeId": "...",
  "planVersion": "v1",
  "phase": "executing",
  "preApplySnapshot": {
    "head": "<sha>",
    "indexState": "...",
    "recoveryRef": "refs/zflow/recovery/<run-id>"
  },
  "groups": [],
  "applyBack": { "status": "pending" },
  "verification": { "status": "pending" },
  "retainedArtifacts": []
}
```

#### Important rule
- Recovery metadata must be file-backed; do not rely on transcript memory.

#### Acceptance criteria
- Every implementation run records enough state to resume or unwind safely.

---

### Task 5.4 — Integrate `worktree: true` dispatch per logical task group

#### Objective
Launch workers in isolated temp worktrees using native `pi-subagents` behavior.

#### Files to create/update
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`
- chain definitions if needed

#### Inputs per group
- assigned worker agent
- group-specific task prompt
- canonical plan artifacts
- context-builder examples
- scoped verification command

#### Example subagent launch shape

```ts
await subagents.parallel({
  worktree: true,
  tasks: groups.map(group => ({
    agent: group.assignedAgent,
    task: buildWorkerTask(group),
  }))
})
```

#### Acceptance criteria
- Each logical task group runs in its own isolated worktree by default.

---

### Task 5.5 — Implement `worktreeSetupHook` support with fail-fast behavior

#### Objective
Support repos that need bootstrap/setup inside temporary worktrees.

#### Files to create/update
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`
- project config docs/examples

#### Required behavior
- detect whether the repo declares a `worktreeSetupHook`
- ship generic hook templates/examples for common repo classes, but do not bake repo-specific setup into the package
- if the repo is known to require setup and no hook is configured, fail immediately with guidance and a pointer to the templates
- if a hook is configured, run it for each created worktree
- helper files created by the hook must be excluded from diff capture and must not hide tracked-file mutations

#### Example hook contract

```ts
interface WorktreeSetupHookResult {
  createdFiles?: string[]
  ignoredPaths?: string[]
  notes?: string[]
}
```

#### Example pseudocode

```ts
if (repoNeedsWorktreeSetup(repoRoot) && !config.worktreeSetupHook) {
  throw new Error("This repo requires worktreeSetupHook, but none is configured")
}
```

#### Acceptance criteria
- Hook use is explicit and non-magical.
- Missing hook produces an actionable failure.
- Generic templates exist, but real hook activation is per-repo configuration.

---

### Task 5.6 — Capture worker outputs, changed-file manifests, and patch artifacts

#### Objective
Normalize the metadata produced by each worktree run so apply-back and recovery can reason over it.

#### Files to create/update
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`
- maybe `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/apply-back.ts`

#### Required per-group metadata
- group id/name
- assigned agent
- worktree path
- base commit
- worktree head commit/ref
- changed files
- patch artifact path
- scoped verification result
- retained/not-retained status

#### Example metadata shape

```json
{
  "groupId": "group-2",
  "agent": "zflow.implement-hard",
  "worktreePath": "/tmp/pi-worktree-run123-2",
  "baseCommit": "abc123",
  "headCommit": "def456",
  "changedFiles": ["src/foo.ts", "test/foo.test.ts"],
  "patchPath": ".../group-2.patch",
  "scopedVerification": { "status": "pass", "command": "npm test -- foo" }
}
```

#### Acceptance criteria
- Apply-back logic has normalized, file-backed inputs for every group.

---

### Task 5.7 — Implement topological apply-back ordering

#### Objective
Apply groups to the primary worktree in dependency order, not arbitrary completion order.

#### Files to create/update
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/apply-back.ts`

#### Inputs
- execution-group dependency graph
- patch artifacts
- changed-file manifests

#### Required behavior
- compute topological order from `execution-groups.md`
- groups without dependencies can be applied in any stable deterministic order
- dependent groups must apply after prerequisites

#### Example pseudocode

```ts
const orderedGroups = topoSort(groups, g => g.dependencies)
for (const group of orderedGroups) {
  await applyPatch(group.patchPath)
}
```

#### Acceptance criteria
- Apply order is deterministic and dependency-aware.

---

### Task 5.8 — Implement atomic apply-back with rollback to the pre-apply snapshot

#### Objective
Guarantee all-or-nothing application of the batch of worker results.

#### Files to create/update
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/apply-back.ts`
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`

#### Required algorithm
1. record pre-apply snapshot and recovery ref in `run.json`
2. select the first-pass apply-back strategy: atomic patch replay
3. iterate groups in topological order
4. apply each patch with `git apply --3way --index --binary`
5. if all succeed, drop recovery marker and mark apply complete
6. if any fail:
   - abort remaining applies
   - hard-reset the primary worktree/index to the pre-apply snapshot
   - leave no partial success behind
   - mark run `apply-back-conflicted`
   - surface failing group, files, patch path, and retained worktree path if any

#### Example pseudocode

```ts
try {
  for (const group of orderedGroups) {
    await exec(`git apply --3way --index --binary ${shellQuote(group.patchPath)}`)
  }
  await markApplySuccess(runId)
} catch (err) {
  await resetToPreApplySnapshot(run.preApplySnapshot)
  await markApplyConflict(runId, err, failingGroup)
  throw err
}
```

#### Acceptance criteria
- Failed apply-back never leaves the primary worktree partially applied.
- Apply-back is structured behind a strategy boundary so a future branch-aware merge/cherry-pick implementation can be added without rewriting orchestration.

---

### Task 5.9 — Enforce worker-scoped verification before completion

#### Objective
Make workers verify their own logical group before the orchestrator accepts their output.

#### Files to create/update
- worker prompts
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`

#### Behavior rules
- workers must run the planner-authored `Scoped verification` command for their group
- if the plan omitted it, workers stop and report a plan-quality gap
- verification logs/artifacts must be ignored or cleaned before diff capture

#### Example pseudocode

```ts
if (!group.scopedVerification) {
  throw new Error(`Group ${group.id} is missing Scoped verification; stop and report plan-quality gap`)
}
```

#### Acceptance criteria
- Workers do not invent repo-wide verification commands.

---

### Task 5.10 — Implement the structured Plan Drift Protocol

#### Objective
Handle infeasible approved plans without improvisation.

#### Files to create/update
- `packages/pi-zflow-agents/skills/plan-drift-protocol/SKILL.md`
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`
- maybe `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/deviations.ts`

#### Required worker behavior
1. stop making source edits
2. write deviation report to `<runtime-state-dir>/plans/{change-id}/deviations/{plan-version}/{group}-{worker}.md`
3. report:
   - plan version
   - group/worker identity
   - specific infeasible instruction
   - actual code structure found
   - blocking conflict or missing dependency
   - suggested minimal amendment
   - files inspected/affected
   - whether local edits were reverted or retained
4. revert/discard local edits unless retention was explicitly requested

#### Example deviation report template

```markdown
# Deviation Report
Plan version: v2
Group: Group 3
Worker: zflow.implement-hard
Infeasible instruction: "Modify existing FooService in src/foo.ts"
Actual structure found: `FooService` does not exist; equivalent logic lives in src/core/foo-service.ts
Blocking conflict: execution group targets the wrong module boundary
Suggested amendment: update Group 3 paths and dependency notes to target src/core/foo-service.ts
Files inspected:
- src/foo.ts
- src/core/foo-service.ts
Local edits reverted: yes
```

#### Acceptance criteria
- Drift produces structured artifacts, not ad-hoc chat explanations.

---

### Task 5.11 — Integrate `pi-intercom` signaling for mid-flight drift reporting

#### Objective
Allow workers to notify the orchestrator immediately when drift is detected.

#### Files to create/update
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`

#### Required behavior
- if `pi-intercom` is installed, workers send a signal on first drift detection
- orchestrator marks run `drift-pending`
- opens a short collection window for additional deviation reports
- halts new dependent dispatch
- may let already-safe independent groups finish read-only logging/verification if that causes no new source mutation

#### Fallback behavior
- if `pi-intercom` is unavailable, workers still write deviation reports and mark tasks blocked

#### Acceptance criteria
- Drift handling works with or without intercom, with better responsiveness when intercom exists.

---

### Task 5.12 — Synthesize deviation reports into a summary artifact

#### Objective
Make replanning easier by consolidating simultaneous deviations.

#### Files to create/update
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`
- maybe `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/deviations.ts`

#### Output file
- `<runtime-state-dir>/plans/{change-id}/deviations/{plan-version}/deviation-summary.md`

#### Summary content
- run id
- affected groups
- common root causes
- whether local edits were retained anywhere
- proposed minimal plan amendments
- recommendation: replan / cancel / inspect retained artifacts

#### Acceptance criteria
- Multiple deviation reports collapse into a replan-friendly summary.

---

### Task 5.13 — Support retained worktrees/patches for debugging and track them for cleanup

#### Objective
Allow failed/conflicted runs to preserve artifacts temporarily without creating permanent clutter.

#### Files to create/update
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`
- `state-index.json` and `run.json` update logic

#### Required metadata
- retained worktree paths
- retained patch paths
- reason for retention
- cleanup deadline/TTL
- default failed/interrupted worktree retention: 7 days
- default stale runtime/patch-artifact TTL: 14 days

#### Example `run.json` excerpt

```json
{
  "retainedArtifacts": [
    {
      "type": "worktree",
      "path": "/tmp/pi-worktree-run123-2",
      "reason": "apply-back-conflict",
      "expiresAt": "<created-at-plus-7-days>"
    }
  ]
}
```

#### Acceptance criteria
- Retained artifacts are tracked explicitly and are discoverable by `/zflow-clean` later.

---

### Task 5.14 — Define worker editing and temporary commit policy in operational helpers

#### Objective
Translate the plan’s worker guidance into executable workflow rules.

#### Files to create/update
- worker prompts
- orchestration helpers

#### Rules to preserve
- prefer `multi-edit` batch mode for multi-file groups
- use patch mode for complex refactors
- temporary commit format: `[pi-worker] <group>: <step>`
- final user commit happens later in the primary worktree
- temporary worktree commits are disposable

#### Acceptance criteria
- Worker execution instructions and collection logic align with the plan’s commit/editing rules.

---

### Task 5.15 — Add recovery and resume support for apply-back edge cases

#### Objective
Make crashes during apply-back or cleanup recoverable from state files.

#### Files to create/update
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/apply-back.ts`

#### Required recovery behavior
- if apply-back status is unknown/incomplete, restore primary tree to pre-apply snapshot before retrying
- surface orphaned worktree paths from previous failures
- permit resume/abandon/inspect/cleanup choices

#### Acceptance criteria
- Apply-back recovery does not depend on transcript archaeology.

## Resolved apply-back hardening decision

- Do not build branch-aware merge/cherry-pick apply-back in the first-pass implementation.
- First-pass apply-back remains atomic binary-safe patch replay in topological order with rollback to the pre-apply snapshot on conflict.
- Implement the apply-back code behind a clean strategy interface so branch-aware merge/cherry-pick can be added later if real repos prove patch replay too brittle.

## Phase exit checklist

- [ ] Clean-tree and untracked-overlap preflight exists.
- [ ] File ownership and dependency validation exists.
- [ ] `run.json` records recovery-grade metadata.
- [ ] Worktree dispatch uses native `pi-subagents` worktrees.
- [ ] `worktreeSetupHook` support, generic templates, and fail-fast behavior exist.
- [ ] Per-group patch/manifest metadata is captured.
- [ ] Apply-back order is dependency-aware.
- [ ] Apply-back is atomic patch replay with rollback on failure and a strategy boundary for future branch-aware hardening.
- [ ] Worker-scoped verification is enforced.
- [ ] Plan Drift Protocol is implemented.
- [ ] `pi-intercom` drift signaling is integrated with fallback behavior.
- [ ] Deviation summaries are synthesized.
- [ ] Retained artifacts are tracked for cleanup.
- [ ] Worker edit/temp-commit policy is operationalized.
- [ ] Resume/recovery logic covers apply-back edge cases.

## Handoff notes for later phases

- Phase 7 will call this machinery during `/zflow-change-implement`.
- Phase 6 review should only run after this phase’s apply-back and final verification succeed.
- `/zflow-clean` in Phase 7 must understand the retained-artifact metadata defined here.
