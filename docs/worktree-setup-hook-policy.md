# `worktreeSetupHook` Policy — Per-Repo Worktree Bootstrap

> **Canonical policy document.** Phase 0, Task 0.9.
> Defines when target repos need worktree bootstrap/setup, the fail-fast rule,
> the hook contract, and the generic template set that the pi-zflow package ships.

## Objective

Some repos require generated files, symlink hydration, env stub generation, or
similar setup **inside** isolated git worktrees before worker subagents can operate
correctly. This document defines:

1. Which repo classes **need** a `worktreeSetupHook`.
2. The **fail-fast rule** when setup is required but no hook is configured.
3. The **hook contract** (interface, lifecycle, return values).
4. The **generic hook templates** that pi-zflow ships — and what must **not** be baked
   into the package.

## Core principle: per-repo, not package-baked

> **The hook is always per-repo configuration.**
> pi-zflow ships **generic templates** that users copy, adapt, and commit to their repo.
> No repo-specific hook logic is ever baked into the pi-zflow package itself.

This means:

- A repo's `.pi/zflow/worktree-setup-hook.sh` is version-controlled alongside the code.
- Different branches can have different hooks.
- The hook is reviewable in every PR that modifies it.
- pi-zflow never guesses what setup a repo needs.

## Decision table — does this repo need a `worktreeSetupHook`?

| Repo trait                                                        | Needs hook?    | Why                                                                                     | Example                                 |
| ----------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------- | --------------------------------------- |
| Plain TS/JS repo, deps metadata checked in, no generated files    | Usually **no** | `npm ci` or `pnpm install --frozen-lockfile` works without extra steps                  | Simple library, CLI tool                |
| Monorepo with generated package links / bootstrap                 | **Yes**        | Workspace tools may need `pnpm install` before linking or `pnpm rebuild` after checkout | pnpm workspace, Lerna monorepo          |
| Repo with `.env.example` → `.env` stub generation                 | **Yes**        | The app requires a `.env` file to start or lint; the hook copies the example            | Web app, API service                    |
| Repo that needs code generation (prisma, graphql, protobuf)       | **Yes**        | Generated files are `.gitignore`d; the hook must regenerate them                        | Prisma schema → client, GraphQL codegen |
| Repo with symlinked dependencies (e.g. `npm link` style)          | **Yes**        | Symlinks break across worktree boundaries; hook must re-hydrate them                    | Local package development               |
| Repo with custom build bootstrap (e.g. `make bootstrap`, `cmake`) | **Yes**        | The build system requires a setup step before first compile                             | C/C++ project with CMake                |
| Unknown / undetermined                                            | **Ask**        | The system cannot guess. User must classify the repo or opt out explicitly              | New or unusual project structure        |

### Edge cases

| Scenario                                                                                                | Policy                                                                                                                     |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Repo has no `worktreeSetupHook` but setup is needed                                                     | ❌ **Worker dispatch fails immediately** with actionable guidance                                                          |
| Repo has a `worktreeSetupHook` that is stale/broken                                                     | ✅ Worker dispatch proceeds (hook failure = worktree failure); user must fix the hook                                      |
| Repo has a `worktreeSetupHook` but the hook file is missing from the worktree checkout                  | ❌ **Fail fast** — the hook path is relative to the repo root; if the file isn't committed, it won't exist in the worktree |
| Repo has a hook configured but the worktree is used for a non-standard purpose (e.g., read-only review) | ✅ Hook is skipped if the worktree is opened in read-only mode (the worker only needs to read, not build)                  |
| Multiple hooks needed (e.g., workspace + env stub)                                                      | ✅ The hook script can run multiple steps; or use a `"module"`-runtime hook that imports helpers                           |

## Fail-fast rule

> If a repo **requires** setup (classified as "yes" in the decision table) and
> has **no `worktreeSetupHook` configured**, worker dispatch must fail immediately
> with:
>
> 1. An actionable error message naming the likely repo class.
> 2. A pointer to the generic hook templates shipped with pi-zflow.
> 3. The exact command to copy the matching template into the repo.

### Failure message template

```
worktreeSetupHook required but not configured.

This repo appears to be a <repo-class> (detected via <heuristic>).
Isolated worktrees may not work correctly without setup steps
(e.g. installing dependencies, generating files, hydrating symlinks).

To configure a hook:
  1. Copy the matching template:
     cp <template-path> .pi/zflow/worktree-setup-hook.sh
  2. Edit the script to match your repo's exact setup steps.
  3. Commit the hook:
     git add .pi/zflow/worktree-setup-hook.sh && git commit -m "add worktree setup hook"
  4. Retry the operation.

If this repo does NOT need worktree setup, set:
  { "worktreeSetupHook": null }
in your pi-zflow config to suppress this check.

Available templates: <list-of-templates>
```

## Hook contract

### Execution lifecycle

```
1. pi-subagents creates a fresh git worktree (branch from HEAD)
2. pi-zflow-change-workflows detects the worktree
3. ┌─ [IF hook is configured] ──────────────────────────┐
   │   runWorktreeSetupHook(config, context)            │
   │   ├── success → worker dispatch proceeds           │
   │   └── failure → worktree is marked failed          │
   └────────────────────────────────────────────────────┘
4. ┌─ [IF hook is REQUIRED but NOT configured] ─────────┐
   │   Fail immediately with actionable message         │
   └────────────────────────────────────────────────────┘
5. Worker subagent starts inside the prepared worktree
```

### Hook context (passed to every hook)

| Field          | Type                      | Description                                   |
| -------------- | ------------------------- | --------------------------------------------- |
| `worktreeRoot` | `string`                  | Absolute path to the worktree root            |
| `repoRoot`     | `string`                  | Absolute path to the original repo root       |
| `ref`          | `string`                  | Git branch or ref checked out in the worktree |
| `meta`         | `Record<string, string>?` | Arbitrary metadata (run id, lane name, etc.)  |

### Hook return value

| Field            | Type      | Description                                 |
| ---------------- | --------- | ------------------------------------------- |
| `success`        | `boolean` | Whether the hook completed                  |
| `message`        | `string`  | Human-readable result / failure description |
| `error.exitCode` | `number?` | Shell exit code (if applicable)             |
| `error.stderr`   | `string?` | Captured stderr (if applicable)             |
| `error.hint`     | `string?` | User-facing resolution hint                 |

### Supported runtimes

| Runtime             | Execution                                    | Best for                                    |
| ------------------- | -------------------------------------------- | ------------------------------------------- |
| `"shell"` (default) | `bash <script> <worktreeRoot>`               | Simple shell commands (cp, npm install, ln) |
| `"node"`            | `node <script> <worktreeRoot>`               | Cross-platform logic, Node.js API access    |
| `"module"`          | In-process `import()` of `.mjs`/`.ts` module | Shared TypeScript types, async workflows    |

### Hook configuration

The hook is declared in the repo's pi-zflow configuration file
(e.g., `pi-zflow.config.json` or `.pi/zflow/config.json`):

```jsonc
{
  "worktreeSetupHook": {
    "script": ".pi/zflow/worktree-setup-hook.sh",
    "runtime": "shell",
    "timeoutMs": 60000,
    "description": "Install workspace dependencies and link packages",
  },
}
```

To explicitly disable the hook check for a repo that does not need setup:

```jsonc
{
  "worktreeSetupHook": null,
}
```

## Template files

pi-zflow ships the following generic hook templates under
`packages/pi-zflow-change-workflows/templates/worktree-setup-hooks/`:

| Template file                | Repo class              | What it does                                   |
| ---------------------------- | ----------------------- | ---------------------------------------------- |
| `generic-node-ci.sh`         | Plain TS/JS             | `npm ci` or `pnpm install --frozen-lockfile`   |
| `generic-pnpm-workspace.mjs` | pnpm workspace monorepo | `pnpm install`, `pnpm rebuild`                 |
| `generic-env-stub.sh`        | Env stub needed         | Copy `.env.example` → `.env`                   |
| `generic-codegen.sh`         | Code generation needed  | Run `prisma generate`, `graphql-codegen`, etc. |

## TypeScript types / importable reference

The full hook contract is defined in `pi-zflow-core`:

```
packages/pi-zflow-core/src/worktree-setup-hook.ts
```

Key exports:

- `WorktreeSetupHookContext` — context passed to every hook
- `WorktreeSetupHookResult` — expected return value
- `WorktreeSetupHookFn` — TypeScript function signature for module hooks
- `WorktreeSetupHookConfig` — how a repo declares its hook
- `runWorktreeSetupHook()` — the single entry point that worker dispatch calls
- `classifyRepo()` — heuristic classifier for the decision table
- `RepoClass` — union of repo trait categories

## What must NOT be baked into the package

- ❌ No repo-specific hook script is embedded in any pi-zflow package.
- ❌ No hardcoded path like `node_modules/` cleanup or `dist/` removal.
- ❌ No implicit assumption about package manager (`npm` vs `pnpm` vs `yarn`).
- ❌ No guessing of build commands for unknown repo classes — the system asks.

## Related

- `packages/pi-zflow-core/src/worktree-setup-hook.ts` — TypeScript contract and `runWorktreeSetupHook()` runner
- `packages/pi-zflow-change-workflows/templates/worktree-setup-hooks/` — Generic hook templates
- `packages/pi-zflow-change-workflows/README.md` — Worktree execution and cleanup integration
- `docs/architecture/package-ownership.md` — Overlap-avoidance policy
- Phase 5 implementation — parallel worktree execution
