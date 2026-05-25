# Code Context

## Files Retrieved

1. `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/index.ts` (lines 3883–4460) — `resolveApplyBackWithSubagent` function definition and coverage repair logic
2. `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/index.ts` (lines 3642–3715) — `autoRestoreSimpleAdditions` coverage repair helper
3. `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/index.ts` (lines 3716–3740) — `buildCoverageRepairPrompt` helper
4. `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/coverage-verifier.ts` (lines 1–559) — Full coverage verifier module: types, parsing, verification, report generation
5. `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/integration-merge-strategy.ts` (lines 547–620) — Coverage verification call site in integration merge strategy

## Key Code

### `resolveApplyBackWithSubagent` (index.ts, lines 3883–4460)

Full signature:

```ts
async function resolveApplyBackWithSubagent(
  runId: string,
  ctx: InterviewableContext,
  progress?: {
    onProgress?: (message: string) => void;
    onPhase?: (
      id: string,
      title: string,
      message: string,
      status?: "running" | "completed" | "failed",
    ) => void;
    onSubagent?: (
      id: string,
      update: Partial<Omit<WorkflowSubagentSnapshot, "id" | "startedAt">>,
    ) => void;
  },
): Promise<void>;
```

**High-level flow:**

1. **Prepare phase** (lines 3903–3972): Resolves integration worktree path, cleans stale merge/rebase/cherry-pick state, rolls back up to 5 zflow-generated marker commits (`/^(?:zflow: (?:auto-restored .*missing file|snapshot pre-continuation|coverage repair))/`), and if conflict markers still remain, dispatches a cleanup resolver subagent (`zflow.implement-hard`).
2. **Resolver dispatch** (lines 3995–4035): Gets `DispatchService` via registry, resolves model via `resolveWorkflowModel("zflow.implement-hard")`, starts a `ResolverWorktreeObserver`, and begins a heartbeat interval.
3. **Integration continuation loop** (lines 4038–4185): Iterates over remaining group branches, merges each into the integration worktree. On merge conflict (up to `MAX_CONFLICT_RESOLUTIONS = 3`), dispatches a focused resolver subagent for that specific group. Handles transport errors by calling `finalizeMarkerFreeResolution`. Commits any uncommitted changes after all groups are merged.
4. **Conflict marker verification** (lines 4195–4213): Greps for `<<<<<<<` / `=======` / `>>>>>>>` markers. If found, persists metadata and throws.
5. **Capture resolved patch** (lines 4215–4230): Generates binary diff from `baseCommit` to `HEAD` in integration worktree, writes to `_subagent-resolved.patch`.
6. **Coverage verification** (lines 4232–4400): Calls `generateCoverageReport(coverageInputs, integrationWorktreePath, baseCommit)`. If `!coverageReport.allCovered`:
   - Collects all missing files across uncovered groups
   - Calls `autoRestoreSimpleAdditions(...)` to auto-restore simple missing file additions
   - If restored > 0, commits, re-runs coverage, updates report
   - If still not covered, persists metadata and throws with repair instructions
7. **Apply to primary** (lines 4402–4450): Verifies primary worktree is clean, applies resolved patch via `git apply --3way --index --binary`, commits, updates run metadata and ledger.

### `autoRestoreSimpleAdditions` (index.ts, lines 3642–3715)

```ts
async function autoRestoreSimpleAdditions(
  missingFiles: string[],
  groups: Array<{ groupId: string }>,
  patchesDir: string,
  integrationWorktreePath: string,
): Promise<number>;
```

For each missing file, iterates through group patches, finds the `diff --git a/<file>` section, extracts added lines from hunks, writes the file to the integration worktree, and stages it. Returns count of restored files.

### `buildCoverageRepairPrompt` (index.ts, lines 3716–3740)

Builds a natural-language prompt instructing a subagent to repair coverage gaps by adding missing content from original intent.

### Coverage Verifier Module (coverage-verifier.ts, lines 1–559)

**Key types:**

```ts
export interface GroupHunk {
  file: string;
  content: string;
  kind: "add" | "delete" | "modify";
  originalLines?: { start: number; count: number };
}

export interface GroupCoverage {
  groupId: string;
  originalHunks: GroupHunk[];
  preservedHunks: GroupHunk[];
  transformedHunks: Array<{ original: GroupHunk; explanation: string }>;
  missingHunks: GroupHunk[];
  covered: boolean;
  summary: string;
}

export interface CoverageReport {
  groups: GroupCoverage[];
  allCovered: boolean;
  groupsCovered: number;
  totalGroups: number;
  summary: string;
}
```

**Key exported functions:**

- `parsePatchHunks(patchContent: string): GroupHunk[]` — Parses unified diff into per-hunk structures
- `verifyGroupCoverage(groupId, patchPath, mergedRepoRoot, baseCommit): Promise<GroupCoverage>` — Verifies a single group's patch against merged result. Classifies each hunk as preserved/transformed/missing. Deletions checked by verifying removed lines are gone; additions/modifications checked via `linesAppearInDiff` (80% threshold).
- `generateCoverageReport(groups, mergedRepoRoot, baseCommit): Promise<CoverageReport>` — Iterates all groups, calls `verifyGroupCoverage`, aggregates results.

### Coverage verification in integration-merge-strategy.ts (lines 547–620)

```ts
const coverageReport = await generateCoverageReport(
  groupCoverageInputs,
  worktreePath,
  baseCommit,
);
```

Returns `{ success: false, coverageReport, error: "Coverage verification failed..." }` when `!coverageReport.allCovered`, with `resolvableByAgent` flag set if some groups are covered.

## Architecture

The apply-back resolution is a multi-phase pipeline:

1. **Integration worktree** exists from a prior smart cascade (preserves branches per group)
2. **`resolveApplyBackWithSubagent`** cleans up stale state, then enters a loop merging group branches one by one into the integration worktree
3. **Conflicts** are dispatched to a `zflow.implement-hard` subagent via `DispatchService.runAgent()`, limited to 3 total resolution attempts
4. **After all groups merged**, the resolved diff is captured as a binary patch
5. **Coverage verification** (`coverage-verifier.ts`) parses each group's original patch into hunks and checks they exist in the merged diff — tolerant of line shifts and adaptations
6. **Coverage repair**: simple missing additions are auto-restored by extracting file content from patches; complex failures require re-running the command
7. The verified resolved patch is applied to the primary worktree via `git apply --3way`

The coverage verifier is also used independently in `integration-merge-strategy.ts` for the standard (non-subagent) merge path.

## Start Here

`packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/index.ts` — line 3883: `resolveApplyBackWithSubagent`. This is the entry point. For coverage logic specifically, start at line 4232 (the `generateCoverageReport` call and repair flow).

## Supervisor coordination

No coordination needed. All requested information was found and reported.
