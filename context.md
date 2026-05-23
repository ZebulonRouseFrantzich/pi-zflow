# Code Context — `Dispatch error: findAgent is not defined`

## Files Retrieved

1. **`vendor/pi-subagents-zflow/src/zflow-bridge.ts`** (lines 58, 307, 335, 364, 432, 553)
   - Canonical location where `findAgent` is defined (line 58) and referenced (lines 307, 364, 432, 553).
   - The "Dispatch error:" prefix is generated in catch blocks at lines 335, 457, and 568.
2. **`packages/pi-zflow-subagents-bridge/extensions/zflow-subagents-bridge/index.ts`** (lines 170–225, 260–280)
   - Bridge extension activation: dynamic-imports `pi-subagents/zflow-bridge`, wraps it in `SubagentsDispatchService`, and registers it in the zflow registry.
   - Its own catch blocks at lines 177 and 221 also produce "Dispatch error:" / "Parallel dispatch error:" messages.
3. **`packages/pi-zflow-subagents-bridge/src/index.ts`** (full file, 45 lines)
   - Package barrel: re-exports types from `pi-zflow-core/dispatch-service` and help metadata.
4. **`packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/index.ts`** (lines 2395–2430, 2444, 2578, 2706, 3896, 4068)
   - `/zflow-change-implement` command handler: calls `tryGetDispatchServiceViaRegistry()` to get the `DispatchService`, then calls `dispatchService.runParallel({ worktree: true })`.
5. **`packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`** (full file)
   - `parseExecutionGroupsMd()`, `prepareWorktreeImplementationRun()`, `finalizeWorktreeImplementationRun()` — parses execution groups and builds the dispatch task list.
6. **`node_modules/pi-subagents/src/zflow-bridge.ts`** (lines 58, 307, 364, 432, 553)
   - The npm-installed (tarball from fork) copy of the bridge. Contains the same `findAgent` definition and references.
7. **`packages/pi-zflow-review/orchestration.ts`** (lines 631–632, 686, 691)
   - Review orchestration also uses `DispatchService` and has its own "dispatch error:" catch blocks, but these are lowercase and produce `findings: []` output — a different error path from the `/zflow-change-implement` flow.

## Key Code

### `findAgent` definition (`vendor/pi-subagents-zflow/src/zflow-bridge.ts`, line 58)

```ts
function findAgent(
  agents: AgentConfig[],
  name: string,
): AgentConfig | undefined {
  // Try exact match first, then prefix match for builtin: prefix
  return agents.find((a) => a.name === name || a.name === `builtin:${name}`);
}
```

This is a **module-private** function (not exported). It takes a pre-discovered `agents` array and a name string, returning the matching `AgentConfig` or `undefined`.

### `findAgent` usage sites (same file)

| Line | Context                      | Description                                                                                                                                                           |
| ---- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 307  | `runAgent()`                 | `const agent = findAgent(agents, input.agent)` — resolves agent before running. If `undefined`, returns a structured "Unknown agent" error (NOT a catch-block error). |
| 335  | `runAgent()` catch           | `error: "Dispatch error: ..." ` — wraps any exception from `runSync()`.                                                                                               |
| 364  | `runParallel()`              | `if (!findAgent(agents, task.agent))` — pre-validates all agents exist before dispatching.                                                                            |
| 432  | `runParallelWithWorktrees()` | `const resolvedAgent = findAgent(agents, task.agent)!` — non-null assertion inside per-task worktree execution closure.                                               |
| 553  | `runParallelConcurrent()`    | `const resolvedAgent = findAgent(agents, task.agent)!` — same pattern, non-null assertion inside per-task concurrent execution closure.                               |

### Error propagation chain for `/zflow-change-implement`

```
/zflow-change-implement command handler
  → tryGetDispatchServiceViaRegistry()  [index.ts:3896 / 4068]
    → registry.get(DISPATCH_SERVICE_CAPABILITY) → SubagentsDispatchService
  → dispatchService.runParallel({ tasks, worktree: true })  [index.ts:2578]
    → SubagentsDispatchService.runParallel() [bridge extension index.ts:205]
      → this.backend.runParallel()  [calls into zflow-bridge.ts]
        → runParallelWithWorktrees() [zflow-bridge.ts:410]
          → findAgent(agents, task.agent)!  [line 432]
          → runSync(cwd, agents, resolvedAgent.name, task.task, options)
            → [any exception here] caught at line 457
              → returns { error: `Worktree dispatch error: ${err.message}` }
    → SubagentsDispatchService catches any upstream exception
      → returns { error: `Dispatch error: ${err.message}` }  [bridge extension index.ts:221]
```

### Bridge extension activation (`extensions/zflow-subagents-bridge/index.ts`, lines 265–280)

```ts
try {
  const { createZflowDispatchService } =
    await import("pi-subagents/zflow-bridge");
  const backend = createZflowDispatchService();
  service = new SubagentsDispatchService(backend);
} catch {
  service = new UnavailableDispatchService();
}
registry.provide(DISPATCH_SERVICE_CAPABILITY, service);
```

## Architecture

The dispatch pipeline has three layers:

1. **Registry layer** (`pi-zflow-core/registry`): The zflow registry holds a `DispatchService` by capability name `"zflow-dispatch"`. Any package can claim/provide this capability.

2. **Bridge layer** (`pi-zflow-subagents-bridge`): On activation, dynamically imports `"pi-subagents/zflow-bridge"` (the fork's `createZflowDispatchService()`). Wraps it in `SubagentsDispatchService` which adds error handling and a name prefix. If the import fails, falls back to `UnavailableDispatchService`.

3. **Backend layer** (`pi-subagents/zflow-bridge` → `vendor/pi-subagents-zflow/src/zflow-bridge.ts`): The actual dispatch logic. `createZflowDispatchService()` returns an object with `runAgent()` and `runParallel()`. Internally it calls `discoverAgents()` to find agents on the filesystem, then `findAgent()` to match the requested agent name, then `runSync()` to spawn `pi` as a child process.

The **npm resolution** chain: `packages/pi-zflow-subagents-bridge/package.json` declares `"pi-subagents": "https://github.com/.../pi-subagents-zflow/archive/7d8463d...tar.gz"` as a dependency. This tarball is installed into `node_modules/pi-subagents`. At runtime, `import("pi-subagents/zflow-bridge")` resolves via the `exports` field to `node_modules/pi-subagents/src/zflow-bridge.ts`. The `vendor/pi-subagents-zflow/` directory is a git submodule reference copy but is NOT what resolves at runtime.

## Why `Dispatch error: findAgent is not defined` Would Occur

`findAgent is not defined` is a **`ReferenceError`**. It means the JavaScript engine cannot find a binding named `findAgent` at the point of call. There are several plausible root causes:

### 1. Most likely: Stale/broken module cache or import resolution at runtime

The `zflow-bridge.ts` file defines `findAgent` as a **module-private** function declaration (line 58). In a properly functioning ESM module, function declarations are hoisted and should always be in scope. However:

- **If the `pi-subagents/zflow-bridge` import resolves to a different or incomplete file** (e.g., a partial build artifact, a missing transpilation step, or a file that was truncated during packaging), the `findAgent` definition could be absent from the evaluated module.
- **If the `node_modules/pi-subagents/src/zflow-bridge.ts` file is loaded via a TypeScript strip-types loader** (Node 22+ `--experimental-strip-types` or `tsx`), and the loader has a bug or caching issue with module-private function declarations, `findAgent` might not be in scope when the closure inside `runParallelWithWorktrees()` or `runParallelConcurrent()` executes.

### 2. Possible: Non-null assertion masking a `null` that throws later

Lines 432 and 553 use `findAgent(agents, task.agent)!`. If `findAgent` returns `undefined` (agent not found), the non-null assertion doesn't throw immediately — it just produces `undefined`. The subsequent `runSync(cwd, agents, resolvedAgent.name, ...)` would then call `.name` on `undefined`, producing a `TypeError: Cannot read properties of undefined (reading 'name')`, NOT a `findAgent is not defined` error. So this is **not** the source of the specific error message.

### 3. Possible: The `createZflowDispatchService` closure captures a stale `agents` variable

In `runParallelWithWorktrees()` (line 432), the closure calls `findAgent(agents, task.agent)!` where `agents` is the parameter passed to the function. If `agents` is empty or the `resolveAgents()` call failed silently, the `findAgent` call would return `undefined` but NOT throw a ReferenceError.

### 4. Possible: Module evaluation order issue with dynamic import

The bridge extension does `await import("pi-subagents/zflow-bridge")` at activation time. If this import fails silently (the catch block at line 276 swallows the error), the `UnavailableDispatchService` is used instead. But if the import partially succeeds — loading some exports but not evaluating the full module — the `createZflowDispatchService` function might reference module-scope variables that aren't initialized.

**The most likely explanation**: The error `"findAgent is not defined"` as a `ReferenceError` in the `"Dispatch error: ..."` wrapping format points to **a runtime module loading issue** where `zflow-bridge.ts` was evaluated in a context where its module-scoped function declarations were not properly hoisted or were stripped. This could happen if:

- The TypeScript source is loaded by a non-standard loader that doesn't handle function declaration hoisting correctly.
- The file was modified or truncated between the `import()` in the bridge extension and the actual call to `runParallel()`.
- A bundling step (if any) incorrectly tree-shook or reordered the module contents.

### Recommended Investigation Steps

1. Check the exact runtime version of `node_modules/pi-subagents/src/zflow-bridge.ts` — verify `findAgent` exists at line 58.
2. Check how Node.js is invoked when running `/zflow-change-implement` — specifically whether `--experimental-strip-types`, `tsx`, or another loader is active.
3. Check if there's a `.tsbuildinfo` or compiled `.js` cache that might shadow the `.ts` source.
4. Add a defensive check in `SubagentsDispatchService.runParallel()` catch block to log the full error stack, not just the message — the stack trace will reveal which module file was actually evaluated.

## Start Here

**`packages/pi-zflow-subagents-bridge/extensions/zflow-subagents-bridge/index.ts`** — this is the bridge extension entry point that dynamically imports the backend and wraps it. Start here to trace the exact import path and error wrapping, then follow the dynamic import to `node_modules/pi-subagents/src/zflow-bridge.ts` where `findAgent` lives.
