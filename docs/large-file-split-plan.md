# Large File Split Plan

Date: 2026-05-28

## Purpose

Capture a proposed refactor plan for splitting the largest source files in this repository into folders, subfolders, and smaller modules **without removing functionality**.

This plan is based on current file size, visible responsibility boundaries, and the existing package ownership rules in `docs/architecture/package-ownership.md`.

## Goals

- Reduce very large files into smaller, single-purpose modules
- Preserve existing package ownership and behavior
- Keep current public entrypoints stable where possible
- Make testing more targeted by mirroring source-module boundaries in test layout
- Refactor incrementally so changes remain reviewable and low-risk

## Non-goals

- No package ownership changes
- No behavior changes as part of the split itself
- No new overlapping orchestration/review/profile packages
- No manifest-entry churn unless required

## Highest-priority split targets

| File | LOC | Main issue |
| --- | ---: | --- |
| `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts` | 9782 | Many unrelated workflow responsibilities in one file |
| `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/index.ts` | 7795 | Extension activation, UI, interview flow, dispatch, resume, and command handling are mixed |
| `packages/pi-zflow-profiles/extensions/zflow-profiles/index.ts` | 1564 | Service API, command routing, footer/status, and settings sync are mixed |
| `packages/pi-zflow-profiles/extensions/zflow-profiles/profiles.ts` | 1535 | Types, validation, source loading, cache, and environment fingerprint logic are mixed |
| `packages/pi-zflow-subagents-bridge/extensions/zflow-subagents-bridge/index.ts` | 1401 | Fallback service, compat backend, git/worktree helpers, and activation are mixed |
| `packages/pi-zflow-profiles/extensions/zflow-profiles/configure-wizard.ts` | 1222 | Controller, input handling, rendering, and persistence are mixed |
| `packages/pi-zflow-review/extensions/zflow-review/orchestration.ts` | 1135 | Code review and PR review orchestration are combined |
| `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/apply-back.ts` | 1145 | Multiple apply-back strategies and recovery logic are combined |
| `packages/pi-zflow-review/extensions/zflow-review/findings.ts` | 1079 | Tier logic, formatting, and persistence are combined |
| `packages/pi-zflow-review/extensions/zflow-review/plan-review.ts` | 1056 | Retry, reviewer dispatch, synthesis, gating, and persistence are combined |
| `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/plan-artifact-validator.ts` | 1042 | Validation, parsing, ownership checks, and repair logic are combined |
| `packages/pi-zflow-core/src/path-guard.ts` | 826 | Types, defaults, path resolution, matching, and policy loading are combined |

## Package-level priorities

1. `pi-zflow-change-workflows`
2. `pi-zflow-profiles`
3. `pi-zflow-review`
4. `pi-zflow-subagents-bridge`
5. Secondary cleanup in `pi-zflow-core`, `pi-zflow-agents`, and large tests

---

## 1. `pi-zflow-change-workflows`

This is the clearest first target. It contains the largest concentration of oversized runtime files and mixed responsibilities.

### Proposed structure

```text
packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/
  index.ts                        # thin extension entrypoint only

  activation/
    register-commands.ts
    tool-guards.ts
    prompt-injection.ts
    progress-renderer.ts

  commands/
    change-plan.ts
    change-prepare.ts
    change-implement.ts
    change-audit.ts
    change-fix.ts
    clean.ts
    resolve-apply-back.ts

  interview/
    structured-interview.ts
    decision-parsing.ts
    question-builders.ts

  dispatch/
    group-ledger.ts
    partial-run.ts
    wave-dispatch.ts
    dispatch-service.ts
    resolver-worktree.ts
    coverage-repair.ts

  orchestration/
    index.ts                      # barrel for compatibility
    execution-groups.ts
    launch-plan.ts
    review-manifest.ts
    resume.ts
    cleanup.ts
    audit.ts

    planning/
      change-plan.ts
      change-prepare.ts
      plan-state.ts
      plan-validation.ts
      durable-plan-doc.ts
      publish-plan-artifacts.ts

    implementation/
      run-change-implement.ts
      prepare-run.ts
      finalize-run.ts
      handoff.ts
      drift.ts
      post-start-sequence.ts
      verification-finalize.ts
      code-review-finalize.ts
      complete-workflow.ts

    fix/
      config.ts
      findings.ts
      selection-questions.ts
      plan.ts
      subagent-resolution.ts

    repo-analysis/
      repo-map.ts
      reconnaissance.ts
      compaction-reanchor.ts
      worktree-setup-detection.ts
```

### Specific large-file split guidance

#### `orchestration.ts`

Natural extraction boundaries already exist:

- execution-group parsing
- launch-plan builders
- resume and recovery flows
- cleanup and audit workflows
- fix orchestration
- plan and prepare flows
- handoff and fork/session logic
- implementation workflow
- post-start verification/review/completion flow
- durable plan document logic

#### `index.ts`

This file should become a thin activation file that only:

- claims capability
- registers hooks
- registers commands
- imports helpers from submodules

Natural extraction boundaries:

- path helpers
- progress renderer / workflow cards
- structured interview helper
- group ledger
- partial/resume dispatch
- resolver worktree inspection and repair helpers
- tool-call path guard wiring
- command handlers

### Compatibility rule

Keep these paths stable and convert them into wrappers or barrels:

- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/index.ts`

That preserves current imports and extension manifest paths while allowing internal movement.

---

## 2. `pi-zflow-profiles`

### Proposed structure

```text
packages/pi-zflow-profiles/extensions/zflow-profiles/
  index.ts                        # thin activation + public exports
  service.ts
  footer-status.ts
  settings-sync.ts

  commands/
    profile-command.ts
    default-view.ts
    show-view.ts
    lanes-view.ts
    refresh.ts
    sync-project.ts

  configure-wizard/
    index.ts
    controller.ts
    input.ts
    navigation.ts
    lane-editor.ts
    agent-editor.ts
    review-screen.ts
    render.ts
    persistence.ts
```

```text
packages/pi-zflow-profiles/extensions/zflow-profiles/profiles/
  index.ts
  schema.ts
  validation.ts
  normalization.ts
  source-paths.ts
  loading.ts
  active-profile-cache.ts
  environment-fingerprint.ts
  cache-rebuild.ts
```

```text
packages/pi-zflow-profiles/extensions/zflow-profiles/health/
  index.ts
  lane-health.ts
  reresolution.ts
  failure-handling.ts
```

```text
packages/pi-zflow-profiles/extensions/zflow-profiles/tui/
  model-groups.ts
  wizard-state.ts
  select-items.ts
  guidance.ts
```

### Specific large-file split guidance

#### `profiles.ts`

Split into four responsibility areas:

- schema/types
- validation/normalization
- source-path and file loading
- cache/environment fingerprint handling

#### `index.ts`

Split into:

- activation and registry service
- command routing
- profile summary/detail formatting
- settings sync helpers
- footer/status integration

#### `configure-wizard.ts`

Split into:

- controller/state machine
- keyboard and navigation handling
- lane editing
- agent editing
- rendering
- persistence

---

## 3. `pi-zflow-review`

### Proposed structure

```text
packages/pi-zflow-review/extensions/zflow-review/
  index.ts

  orchestration/
    index.ts
    shared-types.ts
    reviewer-output.ts
    code-review.ts
    pr-review.ts
    model-resolution.ts
    progress-events.ts

  findings/
    index.ts
    tier-maps.ts
    code-tier-selection.ts
    severity-formatting.ts
    traceability.ts
    persist-code-review.ts
    persist-pr-review.ts

  plan-review/
    index.ts
    retry.ts
    reviewer-runner.ts
    synthesize.ts
    gating.ts
    persistence.ts
    run-plan-review.ts

  pr/
    index.ts
    url.ts
    api-commands.ts
    metadata-parsing.ts
    file-parsing.ts
    diff-fetch.ts
    auth.ts
    comment-submission.ts
```

### Specific large-file split guidance

- `orchestration.ts` should separate code review and PR review orchestration
- `findings.ts` should separate tier mapping, severity formatting, and persistence
- `plan-review.ts` should separate retry, reviewer execution, synthesis, gating, and persistence
- `pr.ts` should separate URL parsing, API command generation, diff/file parsing, auth, and submission

---

## 4. `pi-zflow-subagents-bridge`

### Proposed structure

```text
packages/pi-zflow-subagents-bridge/extensions/zflow-subagents-bridge/
  index.ts

  activation.ts
  unavailable-dispatch-service.ts
  subagents-dispatch-service.ts

  compat/
    index.ts
    module-loader.ts
    progress-mapping.ts
    concurrency.ts
    git-utils.ts
    patch-capture.ts
    workspace-plans.ts
    worktree-setup.ts
    worktree-execution.ts
    verification.ts
```

### Specific large-file split guidance

Separate these concerns:

- unavailable fallback service
- operational dispatch service
- compat-module loader and adapter
- concurrency helpers
- git/worktree utilities
- patch capture and verification
- extension activation

---

## 5. Secondary but worthwhile splits

### `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/apply-back.ts`

```text
apply-back/
  index.ts
  shared-types.ts
  lifecycle.ts
  strategies/
    patch-replay.ts
    structured-merge.ts
    integration-worktree-merge.ts
  recovery.ts
```

### `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/plan-artifact-validator.ts`

```text
plan-artifact-validator/
  index.ts
  shared-types.ts
  patterns.ts
  artifact-io.ts
  validate-execution-groups.ts
  validate-implementation-tasks.ts
  validate-simple-artifacts.ts
  ownership-validation.ts
  repair.ts
```

### `packages/pi-zflow-core/src/path-guard.ts`

```text
packages/pi-zflow-core/src/path-guard/
  index.ts
  types.ts
  defaults.ts
  realpath-safe.ts
  allowed-roots.ts
  blocked-patterns.ts
  can-write.ts
  sentinel-policy.ts
```

### `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/path-guard.ts`

```text
path-guard/
  index.ts
  guard-intents.ts
  write-guard.ts
  bash-guard.ts
  shell-tokenizer.ts
  reminder-text.ts
```

---

## Test layout follow-up

Large tests should be split in parallel with the code. Mirror the source structure so each test file covers a narrow responsibility.

### Candidate test splits

- `packages/pi-zflow-review/test/plan-review.test.ts`
- `packages/pi-zflow-profiles/test/activation.test.ts`
- `packages/pi-zflow-change-workflows/test/plan-artifact-validator.test.ts`
- `packages/pi-zflow-review/test/code-review-findings.test.ts`
- `packages/pi-zflow-change-workflows/test/prepare-full-workflow.test.ts`

### Example test layout

```text
packages/pi-zflow-review/test/plan-review/
  retry.test.ts
  gating.test.ts
  synthesis.test.ts
  persistence.test.ts
```

```text
packages/pi-zflow-profiles/test/configure-wizard/
  navigation.test.ts
  lane-editor.test.ts
  agent-editor.test.ts
  persistence.test.ts
```

```text
packages/pi-zflow-change-workflows/test/plan-artifact-validator/
  execution-groups.test.ts
  implementation-tasks.test.ts
  simple-artifacts.test.ts
  repair.test.ts
```

---

## Docs follow-up

If documentation splitting is desired later, the largest candidates are:

- `README.md`
- `pi-config-implementation-plan.md`
- `implementation-phases/phase-1-package-skeleton-prompts-skills-and-agents.md`
- `implementation-phases/phase-7-change-workflow-orchestration-zflow-change-workflows.md`
- `docs/smoke-tests.md`

### Suggested documentation strategy

- keep `README.md` as the overview and index
- move deep sections into focused docs under `docs/`
- split very large planning docs into a subfolder such as `docs/implementation-plan/`
- do **not** split generated files like `package-lock.json`

---

## Recommended execution order

1. Split `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/index.ts`
2. Split `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`
3. Split `packages/pi-zflow-profiles/extensions/zflow-profiles/profiles.ts`
4. Split `packages/pi-zflow-profiles/extensions/zflow-profiles/configure-wizard.ts`
5. Split `packages/pi-zflow-review/extensions/zflow-review/orchestration.ts`
6. Split `packages/pi-zflow-review/extensions/zflow-review/findings.ts`
7. Split `packages/pi-zflow-review/extensions/zflow-review/plan-review.ts`
8. Split `packages/pi-zflow-subagents-bridge/extensions/zflow-subagents-bridge/index.ts`
9. Split secondary files: `apply-back.ts`, `plan-artifact-validator.ts`, `path-guard.ts`
10. Split corresponding tests as each source area is refactored

---

## Refactor guardrails

- Preserve package ownership boundaries from `docs/architecture/package-ownership.md`
- Keep extension entrypoints stable where possible
- Prefer internal barrels/re-exports before changing external import paths
- Preserve Node/TypeScript ESM import style with explicit `.js` extensions
- Split tests alongside source files
- Prefer small, incremental refactors over one large move
- Run targeted tests after each package-level split

## Practical strategy

For each package:

1. Introduce a folder and internal barrel
2. Move one coherent responsibility at a time
3. Re-export from the old top-level file if needed
4. Update imports internally
5. Split or add focused tests
6. Run the narrowest relevant test command
7. Only then move to the next responsibility block

## Summary

The most valuable work is to split the internals of:

- `pi-zflow-change-workflows`
- `pi-zflow-profiles`
- `pi-zflow-review`
- `pi-zflow-subagents-bridge`

The proposed approach keeps behavior intact, preserves package ownership, and reduces the current concentration of logic in a small number of very large files.
