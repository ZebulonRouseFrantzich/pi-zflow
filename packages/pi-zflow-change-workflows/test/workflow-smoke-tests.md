# pi-zflow-change-workflows — Smoke-test scenarios

This document describes end-to-end test recipes for the full workflow
command surface. These are **manual smoke tests** intended to verify
that the complete system works as a coherent whole.

> **Prerequisites:**
> - pi-zflow-change-workflows is installed as a Pi extension
> - pi-zflow-agents is installed and agents are set up (`/zflow-setup-agents`)
> - A git repository with profiles configured

---

## Scenario 1: Enter/Exit `/zflow-plan`

**Goal:** Verify ad-hoc read-only plan mode can be toggled.

1. In a project directory, run:
   ```
   /zflow-plan
   ```
   **Expected:** Plan mode becomes active. A plan-mode widget/status
   indicator is visible. Attempting `write` or `edit` tool calls is
   blocked by the bash policy.

2. Run:
   ```
   /zflow-plan status
   ```
   **Expected:** Shows plan mode is active with the timestamp of
   activation.

3. Run:
   ```
   /zflow-plan exit
   ```
   **Expected:** Plan mode exits. Write tools become available again.

**Pass criteria:** User can enter, inspect, and exit plan mode cleanly.

---

## Scenario 2: Run `/zflow-change-prepare` on an ad-hoc change

**Goal:** Verify the formal planning workflow produces durable artifacts.

1. Run:
   ```
   /zflow-change-prepare feature-x
   ```
   **Expected:**
   - Profile resolution completes (`Profile.ensureResolved()`)
   - No unfinished runs are detected (clean workspace)
   - Change folder is resolved as `feature-x`
   - Repo mapping runs, reconnaissance is written to
     `<runtime-state-dir>/reconnaissance.md`
   - Planner produces artifact files under
     `<runtime-state-dir>/plans/feature-x/v1/`
   - Validation runs, marking plan version `validated`
   - Plan-review tier is determined and swarm runs (if tier != standard)
   - Approval gate presents approve / revise / cancel choices
   - On approve, plan state is marked `approved` in `plan-state.json`

2. Verify the created plan structure:
   ```
   ls -la <git-dir>/pi-zflow/plans/feature-x/v1/
   ```
   **Expected:** At minimum, `design.md`, `execution-groups.md`,
   `standards.md`, and `verification.md` exist.

3. Verify `plan-state.json`:
   ```
   cat <git-dir>/pi-zflow/plans/feature-x/plan-state.json
   ```
   **Expected:** `lifecycleState` is `"approved"`, `currentVersion` is
   `"v1"`, `approvedVersion` is `"v1"`.

**Pass criteria:** Planning produces versioned, file-backed artifacts
that survive session restart.

---

## Scenario 3: Run `/zflow-change-prepare` in RuneContext mode

**Goal:** Verify RuneContext detection and canonical doc resolution.

1. Ensure the workspace has an active RuneContext (change doc).
2. Run:
   ```
   /zflow-change-prepare
   ```
   (Without a change path — detects from RuneContext.)
   **Expected:**
   - RuneContext is detected via `pi-zflow-runecontext`
   - Canonical source docs are resolved and read
   - `execution-groups.md` is marked as derived
   - Planning proceeds normally but adapts to RuneContext conventions
   - Plan artifacts include references to the source change doc

**Pass criteria:** Planning adapts to RuneContext mode with correctly
derived execution groups.

---

## Scenario 4: Approve and fork implementation session

**Goal:** Verify the default handoff creates a new Pi session file.

1. Complete Scenario 2 (approved plan exists for `feature-x`).
2. On the approval gate, select "Fork implementation session."
   **Expected:**
   - A new Pi session file is created (forked from current session)
   - The session metadata includes `changeId`, `approvedVersion`,
     `runtimeStateDir`, and `sourceSession`
   - The original planning session remains available for inspection/resume
   - No git branches are created

3. In the forked session, verify the handoff context:
   - The model should start with `/zflow-change-implement` mode active
   - The `approved-plan-loaded` reminder should include artifact paths

**Pass criteria:** Forked handoff is the default and clearly separate
from git branching.

---

## Scenario 5: Run `/zflow-change-implement` through verification

**Goal:** Execute the full implement/verify/review lifecycle.

1. Ensure an approved plan exists (Scenario 2).
2. Run:
   ```
   /zflow-change-implement feature-x
   ```
   **Expected:**
   - Profile resolution and lane-health preflight pass
   - No unfinished runs exist
   - Approved plan is loaded from `plan-state.json`
   - Run metadata is created (`<runtime-state-dir>/runs/*/run.json`)
   - Plan state transitions to `executing`
   - Clean-tree preflight passes
   - Execution groups are dispatched to worktrees (parallel + sequential)
   - Worker-scoped verification runs per group
   - Patches are collected and applied back atomically
   - Final verification runs (auto-detected or profile-configured)
   - If verification passes, code review runs
   - On success, plan state transitions to `completed`
   - State index is updated

3. Verify artifacts:
   ```
   ls -la <git-dir>/pi-zflow/runs/
   ```
   **Expected:** At least one run directory exists with `run.json`.

**Pass criteria:** `/zflow-change-implement` follows the master plan's
execution order end to end.

---

## Scenario 6: Trigger drift and confirm version-bumped replanning

**Goal:** Verify plan-drift detection creates a new plan version.

1. While an implementation run is in progress, simulate a deviation
   (e.g., modify a file that a worker expected unchanged).
2. **Expected:**
   - Run enters `drift-pending` phase
   - `drift-detected` runtime reminder is injected
   - Deviation reports are written
   - When drift resolution is presented:
     - Select "Approve Amendment"
   - A new `v{n+1}` version is created
   - Previous executing plan is marked `drifted` or `superseded`
   - Validation and review re-run on the new version
   - Execution restarts from the new version

3. Verify versioning:
   ```
   cat <git-dir>/pi-zflow/plans/feature-x/plan-state.json
   ```
   **Expected:** `versions` includes both `v1` (superseded) and `v2`
   (approved). `currentVersion` is `"v2"`.

**Pass criteria:** Drift is resolved through versioned replanning, not
in-place improvisation.

---

## Scenario 7: Run `/zflow-review-code`

**Goal:** Verify internal code review works as a standalone command.

1. Make some local changes in a branch.
2. Run:
   ```
   /zflow-review-code
   ```
   **Expected:**
   - Repo root and review baseline are resolved
   - Diff is computed against the baseline
   - Code-review tier is determined from context
   - Reviewer manifest is built
   - Reviewer prompts are dispatched (or diagnostic if no runner)
   - Findings are persisted to
     `<runtime-state-dir>/review/code-review-findings.md`

3. Verify findings:
   ```
   cat <git-dir>/pi-zflow/review/code-review-findings.md
   ```
   **Expected:** Structured findings with severity, title, and
   recommendations.

**Pass criteria:** Internal review runs as an explicit command and
produces findings.

---

## Scenario 8: Run `/zflow-review-pr <url>`

**Goal:** Verify external PR/MR diff review works.

1. Run:
   ```
   /zflow-review-pr https://github.com/owner/repo/pull/42
   ```
   **Expected:**
   - URL is parsed and validated
   - Host platform is detected (GitHub/GitLab)
   - Auth status is checked (gh/glab CLI)
   - Diff is fetched (or diagnostic if no auth)
   - Reviewer prompts are built with diff-only instructions
   - Findings are persisted to
     `<runtime-state-dir>/review/pr-review-{id}.md`

**Pass criteria:** External review command is available and produces
findings.

---

## Scenario 9: Run `/zflow-clean --dry-run`

**Goal:** Verify cleanup is explicit and state-driven.

1. Run:
   ```
   /zflow-clean --dry-run
   ```
   **Expected:**
   - Scans `<runtime-state-dir>` for stale artifacts
   - Cross-references against `state-index.json`
   - Reports what would be cleaned without deleting anything
   - Shows artifact paths, ages, and cleanup reasons

2. Run (if actual cleanup is desired):
   ```
   /zflow-clean --orphans --older-than 14
   ```
   **Expected:** Cleans orphaned worktrees and artifacts older than
   14 days. Reports count of cleaned items.

**Pass criteria:** Cleanup is explicit, previewable with `--dry-run`,
and state-driven.

---

## Scenario 10: Resume after interruption

**Goal:** Verify state-driven resume works.

1. Start a `/zflow-change-implement` run but interrupt it (e.g., close
   the Pi session).
2. Reopen the session and run:
   ```
   /zflow-change-prepare feature-x
   ```
   (Or any workflow command.)
   **Expected:**
   - `detectResumeContext()` finds the unfinished run in `state-index.json`
   - Resume prompt presents choices: resume / abandon / inspect / cleanup
   - Selecting "resume" picks up from the interrupted phase
   - Selecting "abandon" marks the run as abandoned

**Pass criteria:** Resume is based on `state-index.json`, `plan-state.json`,
and `run.json` — not transcript memory.
