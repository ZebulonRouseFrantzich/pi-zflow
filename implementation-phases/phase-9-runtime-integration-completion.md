# Phase 9 — Runtime Integration Completion

## Phase goal

Close the remaining runtime integration items that were intentionally deferred after the gap-closure pass:

1. Native `pi-subagents` `worktree: true` dispatch and apply-back.
2. RuneContext canonical document population.
3. Real `zflow.synthesizer` invocation.
4. PR review line-number preservation, triage, and export/submission flow.

These items are all integration work: most helper modules already exist, but the command/runtime paths must call them in the correct order with Pi-compatible APIs.

## Research findings

### Pi extension API constraints

Relevant Pi APIs from `@earendil-works/pi-coding-agent`:

- Custom tools are registered with `pi.registerTool({ name, parameters, execute })`.
- Extensions can list active/all tools with `pi.getActiveTools()` / `pi.getAllTools()`.
- `ToolInfo` returned by `getAllTools()` contains name, description, parameters, and source info only.
- There is **no public `ExtensionAPI.executeTool()`** or equivalent for one extension to directly call another extension's registered tool.
- Persistent session state can be written with `pi.appendEntry(customType, data)` and later inspected through `ctx.sessionManager.getEntries()`.
- Tool interception uses `pi.on("tool_call", ...)` with `{ block, reason }`.

### `pi-subagents` facts

`pi-subagents@0.24.2` registers a `subagent` tool in `src/extension/index.ts`.

The documented tool payload supports:

```ts
// Parallel worktree isolation
{
  tasks: [
    { agent: "worker", task: "Implement auth" },
    { agent: "worker", task: "Implement API" }
  ],
  worktree: true
}
```

It also supports:

- `agent`, `task` for single-agent runs.
- `tasks`, `concurrency`, `worktree` for top-level parallel runs.
- `chain` for sequential/fan-out chains.
- `model`, `skill`, `output`, `outputMode`, `cwd`, `maxOutput`, `context`, `async`, `clarify`.

Important limitation for this repository:

- `pi-subagents` does **not** currently expose a documented public extension service that another package can call.
- Its executor exists internally as `createSubagentExecutor(...)`, but using that would mean importing internal package paths and recreating private extension state/config. That is brittle and should not be the default integration contract.

### Recommended integration contract

`pi-zflow-change-workflows` should support a narrow dispatch service interface via `pi-zflow-core` registry:

```ts
interface ZflowSubagentDispatchService {
  runAgent(input: {
    agent: string;
    task: string;
    cwd?: string;
    model?: string;
    output?: string | false;
    outputMode?: "inline" | "file-only";
    maxOutput?: { lines?: number; bytes?: number };
    context?: "fresh" | "fork";
  }): Promise<{ rawOutput: string; outputPath?: string; ok: boolean }>;

  runParallel(input: {
    tasks: Array<{
      agent: string;
      task: string;
      cwd?: string;
      model?: string;
      output?: string | false;
      outputMode?: "inline" | "file-only";
    }>;
    cwd?: string;
    concurrency?: number;
    worktree?: boolean;
    context?: "fresh" | "fork";
    maxOutput?: { lines?: number; bytes?: number };
  }): Promise<{
    ok: boolean;
    results: Array<{
      agent: string;
      rawOutput: string;
      outputPath?: string;
      ok: boolean;
    }>;
  }>;
}
```

### Decision: zflow-owned bridge package, no upstream proposal yet

We will not propose or require a `pi-subagents` public dispatch service during
this phase. Instead, pi-zflow will own a small adapter package that registers
the `zflow-dispatch` capability against the shared zflow registry.

Package decision:

- Add `packages/pi-zflow-subagents-bridge`.
- The bridge package owns only adaptation between zflow's typed
  `DispatchService` interface and whatever dispatch implementation is available.
- The bridge must not register competing orchestration commands or tools.
- The bridge must not override the built-in `subagent` tool.
- The bridge must not import private `pi-subagents/src/...` internals by default.
- If no supported public dispatch backend is available, the bridge provides
  clear diagnostics/unavailable results instead of pretending dispatch worked.

The bridge is intentionally a zflow package, not a request for pi-subagents to
change. After pi-zflow workflows are proven in real use, we can revisit whether
an upstream pi-subagents service would be worthwhile.

Until an operational backend is available, implementation should:

1. Use injected/registry dispatch services when available.
2. Let `pi-zflow-subagents-bridge` claim `zflow-dispatch` only when it can
   provide an implementation or a deliberately unavailable diagnostic service.
3. Fail fast with actionable guidance when a real dispatch service is required but unavailable.
4. Avoid silently marking workflows complete without dispatch/apply-back.

This closes the safety gap while keeping the integration point stable inside
pi-zflow. No pi-subagents upstream proposal is part of this phase.

Implementation update: after the bridge seam was added, the local fork at
`/home/zeb/code/pi/pi-subagents-zflow` gained a public
`pi-subagents/zflow-bridge` export. `pi-zflow-subagents-bridge` now attempts to
load that backend for operational dispatch and falls back to diagnostic
unavailable results when the fork/backend is missing.

## Item 0 — `pi-zflow-subagents-bridge`

### Required behavior

The bridge package provides the runtime location where dispatch integration is
configured and diagnosed.

1. Add a new workspace package: `packages/pi-zflow-subagents-bridge`.
2. Register an extension under `extensions/zflow-subagents-bridge/index.ts`.
3. Claim/provide the `zflow-dispatch` capability using the shared registry.
4. Export a service implementing `DispatchService` from
   `pi-zflow-core/dispatch-service`.
5. In the first implementation, support an explicit diagnostic/unavailable
   backend with actionable messages:
   - confirm that Pi cannot execute another extension's registered tool;
   - confirm that pi-subagents currently exposes `subagent` as a tool only;
   - tell the user to use manual dispatch or install/configure a compatible
     zflow dispatch backend when one exists.
6. Provide a simple test/fake backend hook for package tests only; production
   must not silently fake worker execution.
7. Add the bridge to the umbrella `pi-zflow` package dependencies and `pi`
   extension paths.
8. Update package ownership docs to show that the bridge owns only dispatch
   adaptation and not orchestration.

### Acceptance criteria

- Loading the bridge is idempotent and duplicate-safe.
- The bridge registers/provides `zflow-dispatch` with a service matching
  `DispatchService`.
- `runAgent()` and `runParallel()` return `ok: false` with actionable guidance
  when no operational backend is available.
- The bridge package has activation/service tests.
- Umbrella `pi-zflow` includes the bridge extension path.
- No private `pi-subagents/src/...` import exists in the bridge by default.

## Item 1 — Native worktree dispatch and apply-back

### Required behavior

`/zflow-change-implement <change-id>` must execute this lifecycle:

1. Resolve approved plan and artifact paths.
2. Parse `execution-groups.md` into execution group objects.
3. Reject dirty primary worktrees unless `--force` is explicitly provided.
4. Validate file ownership and dependency ordering.
5. Validate/run `worktreeSetupHook` when configured.
6. Call `prepareWorktreeImplementationRun()`.
7. Dispatch groups with `worktree: true` through a real dispatch service.
8. Capture worker outputs, changed files, scoped verification, and patch artifacts.
9. Require scoped verification for each group; missing/failed verification blocks finalization.
10. Call `finalizeWorktreeImplementationRun()` to apply patches atomically in topological order.
11. Only after apply-back succeeds, run final verification and code review.
12. On failure/conflict, retain worktrees/patches and update state-index/run.json.

### Implementation notes

- Existing helpers: `prepareWorktreeImplementationRun()`, `buildWorktreeDispatchPlan()`, `captureGroupResult()`, `finalizeWorktreeImplementationRun()`, `executeApplyBack()`.
- Current command path must stop using `skipDispatchWait: true` as a success path.
- If no dispatch service exists, return `waiting-for-dispatch` or fail with instructions; do **not** complete.

### Acceptance criteria

- A run cannot complete without dispatch artifacts or explicit `--manual-dispatch-complete` style input.
- A dirty primary tree is rejected unless `--force`.
- A fake dispatch service in tests proves the command calls worktree dispatch with `worktree: true`.
- Apply-back is invoked after fake worker patch results.
- Missing scoped verification fails the run.

## Item 2 — RuneContext canonical document population

### Required behavior

When RuneContext mode is detected:

1. `resolveChange()` validates the change folder.
2. `readDocs()` reads canonical RuneContext docs.
3. `plan-state.json` marks `runeContext.canonical = true`.
4. zflow plan artifacts are populated from canonical docs:
   - `design.md` from `proposal.md` or equivalent.
   - `execution-groups.md` derived from `tasks.md` using `deriveExecutionGroupsFromRuneDocs()` when available.
   - `standards.md` from RuneContext `standards.md`.
   - `verification.md` from `references.md`, task acceptance criteria, or status/verification docs.
5. Reviewers receive canonical RuneContext docs first, then derived artifacts.

### Acceptance criteria

- Plain and verified RuneContext fixtures populate the artifact set.
- Missing required RuneContext files fail with actionable errors.
- `execution-groups.md` is marked derived and points to canonical source docs.
- Plan review can detect RuneContext canonical docs from plan-state/runtime metadata.

## Item 3 — Real `zflow.synthesizer` invocation

### Required behavior

Plan/code/PR review should use `zflow.synthesizer` as the authoritative consolidation step when dispatch is available.

1. Build reviewer manifest.
2. Run reviewers.
3. Persist raw reviewer outputs.
4. Dispatch `zflow.synthesizer` with reviewer manifest, raw outputs, coverage notes, and weighting guidance.
5. Parse structured findings from synthesizer output.
6. Gate workflow based on synthesized severity.
7. If synthesizer dispatch is unavailable or fails, required-review flows should escalate rather than silently approving.

### Acceptance criteria

- Tests inject a fake dispatch service and assert `zflow.synthesizer` is called.
- Synthesized output controls approval/revision recommendation.
- Required synthesizer failure returns `needs-zeb`/failed status.
- Local synthesis fallback is only used in explicitly configured test/dev fallback mode.

## Item 4 — PR review line-number preservation, triage, and export/submission

### Required behavior

1. Fetch diff-only PR/MR content without executing untrusted code.
2. Chunk large diffs while preserving line maps.
3. Include file/line coordinate instructions in external reviewer prompts.
4. Require reviewer findings to include file, line, side, severity, title, and body.
5. Merge chunk findings through `mergeChunkFindings()`.
6. Persist PR findings with stable file/line coordinates.
7. If auth/permission is missing, produce an export-only artifact instead of aborting.
8. Before submitting comments, run `pi-interview` triage so the user can approve/edit/dismiss comments.
9. Submit approved comments via `gh api` or `glab api` only after triage.

### Acceptance criteria

- Chunked PR tests preserve line numbers.
- Missing auth writes export artifact and does not fail early.
- Triage flow is invoked before submission.
- Submitted comment payloads include correct path/line/side fields.

## Implementation order

1. Add/standardize the zflow dispatch service interface and fake-dispatch tests.
2. Wire implement workflow to require dispatch/apply-back before final verification.
3. Populate RuneContext artifacts from canonical docs.
4. Wire synthesizer invocation through the same dispatch service.
5. Finish PR line maps, triage, export, and submission.

## Non-goals

- Do not override built-in Pi tools.
- Do not copy/fork pi-subagents internals unless explicitly approved.
- Do not silently downgrade dispatch-required workflows into local helper-only workflows.
- Do not execute untrusted PR code.
