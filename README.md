# pi-zflow

A modular Pi harness customization suite — profiles, planning safety, review workflows, change orchestration, runtime artifacts, RuneContext integration, and compaction hooks.

## Architecture

pi-zflow is a monorepo of individually installable Pi packages:

| Package                     | Type                | Description                                                                                                |
| --------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `pi-zflow-core`             | library             | Shared types, registry, version constants                                                                  |
| `pi-zflow-artifacts`        | Pi extension        | Runtime state paths, artifact helpers, `zflow_write_plan_artifact` tool                                    |
| `pi-zflow-profiles`         | Pi extension        | Profile/lane resolution, `/zflow-profile` commands                                                         |
| `pi-zflow-plan-mode`        | Pi extension        | Ad-hoc read-only planning mode, `/zflow-plan` commands                                                     |
| `pi-zflow-agents`           | Pi extension        | Custom agent markdown, chains, skills, prompts, setup/update commands                                      |
| `pi-zflow-review`           | Pi extension        | Plan/code/PR review workflows, `/zflow-review-code`, `/zflow-review-pr`                                    |
| `pi-zflow-change-workflows` | Pi extension        | Formal prepare/implement orchestration, `/zflow-change-prepare`, `/zflow-change-implement`, `/zflow-clean` |
| `pi-zflow-runecontext`      | Pi extension        | RuneContext integration                                                                                    |
| `pi-zflow-compaction`       | Pi extension        | Proactive compaction hooks                                                                                 |
| `pi-zflow`                  | umbrella Pi package | Bundles the suite                                                                                          |

## Version policy

### Supported Pi version

- **Provisional minimum**: `0.74.0` (before Phase 0 smoke testing)
- **Confirmed minimum**: `<pending Phase 0 smoke testing>`
- **Last tested**: `<pending Phase 0 smoke testing>`

The minimum Pi version must be tested against:

- [ ] Extension loading
- [ ] Chain discovery
- [ ] `pi-subagents` runtime
- [ ] Session hooks needed by `pi-zflow-compaction` / `zflow-compaction`
- [ ] Active tool restrictions needed by `/zflow-plan`

### Pin policy

**No floating `latest` pins.** Every dependency in the foundation stack and every child package reference must have an exact version or exact git ref. This applies to:

- `package.json` `dependencies` and `peerDependencies` in all packages
- Installation commands in bootstrap scripts
- Any documentation that references installable URLs

Version pins are recorded in two places:

1. `package.json` manifests (the machine-readable source of truth)
2. `docs/foundation-versions.md` (the human-readable policy record)

### Child package pin record

| Child package               | Current pin             | Status            |
| --------------------------- | ----------------------- | ----------------- |
| `pi-zflow-core`             | `0.1.0` (workspace ref) | local development |
| `pi-zflow-artifacts`        | `0.1.0` (workspace ref) | local development |
| `pi-zflow-profiles`         | `0.1.0` (workspace ref) | local development |
| `pi-zflow-plan-mode`        | `0.1.0` (workspace ref) | local development |
| `pi-zflow-agents`           | `0.1.0` (workspace ref) | local development |
| `pi-zflow-review`           | `0.1.0` (workspace ref) | local development |
| `pi-zflow-change-workflows` | `0.1.0` (workspace ref) | local development |
| `pi-zflow-runecontext`      | `0.1.0` (workspace ref) | local development |
| `pi-zflow-compaction`       | `0.1.0` (workspace ref) | local development |
| `pi-zflow`                  | `0.1.0` (workspace ref) | local development |

### Foundation package pins

| Package                 | Pinned version | Status                                       |
| ----------------------- | -------------- | -------------------------------------------- |
| `pi-subagents`          | `0.24.2`       | pre-install (provisional, verify in Phase 0) |
| `pi-rtk-optimizer`      | `0.7.1`        | pre-install (provisional, verify in Phase 0) |
| `pi-intercom`           | `0.6.0`        | pre-install (provisional, verify in Phase 0) |
| `pi-web-access`         | `0.10.7`       | pre-install (provisional, verify in Phase 0) |
| `pi-interview`          | `0.8.7`        | pre-install (provisional, verify in Phase 0) |
| `pi-mono-sentinel`      | `1.11.0`       | pre-install (provisional, verify in Phase 0) |
| `pi-mono-context-guard` | `1.7.3`        | pre-install (provisional, verify in Phase 0) |
| `pi-mono-multi-edit`    | `1.7.3`        | pre-install (provisional, verify in Phase 0) |
| `pi-mono-auto-fix`      | `0.3.1`        | pre-install (provisional, verify in Phase 0) |

### Optional package pin record

| Package                            | Pinned version | Condition                                                                             |
| ---------------------------------- | -------------- | ------------------------------------------------------------------------------------- |
| `@benvargas/pi-openai-verbosity`   | `<TBD>`        | install when any active lane uses `openai-codex`                                      |
| `@benvargas/pi-synthetic-provider` | `<TBD>`        | later cost/diversity optimization only                                                |
| `pi-rewind-hook`                   | `<TBD>`        | optional recovery layer; if enabled, no other rewind/checkpoint package may be active |

## Optional package policy

### Conditional installation rules

#### `@benvargas/pi-openai-verbosity`

**Condition**: recommend installation when any active lane in the resolved default profile uses `openai-codex` as its provider.

**Purpose**: Reduces verbosity in OpenAI Codex responses, making tool output more concise and readable.

**Implementation logic**:

```ts
// In pi-zflow-profiles or bootstrap:
if (profileUsesCodexLanes(activeProfile)) {
  recommendInstall("@benvargas/pi-openai-verbosity");
  // recommendation is advisory only — user decides whether to install
}
```

**Notes**:

- Detection happens at profile resolution time (when `pi-zflow-profiles` resolves the active profile).
- If no `openai-codex` lanes are in use, the package is not needed.
- Installation remains user-optional even when recommended.

#### `@benvargas/pi-synthetic-provider`

**Condition**: later cost/diversity optimization only. Not for the first-pass foundation.

**Purpose**: Provides synthetic provider support for cost optimization and model diversity in multi-model workflows.

**Implementation logic**:

```ts
// Deferred — no install logic in Phase 0 or Phase 1.
// When implemented: evaluate if cost optimization or diversity routing is needed
// before automatically recommending.
```

**Notes**:

- Excluded from the first-pass foundation intentionally.
- Should be revisited when cost optimization or model diversity routing becomes a requirement.

#### `pi-rewind-hook`

**Condition**: install only when the user explicitly enables recovery/checkpoint functionality in their configuration.

**Purpose**: Optional recovery layer that provides rewind/checkpoint capability for failed or interrupted operations.

**Exclusivity rule (enforced)**:

```ts
if (config.enableRewindHook) {
  assertNoOtherCheckpointPackagesEnabled();
  // Fail fast with an actionable message naming the conflicting package
  install("pi-rewind-hook");
}
```

**Rewind exclusivity rule**: If `pi-rewind-hook` is enabled, **no other rewind or checkpoint package may be active** in the same Pi configuration. This includes:

- Any package that registers `session_before_compact` hooks for checkpointing
- Competing undo/redo or recovery systems
- Alternative checkpoint mechanisms not owned by `pi-rewind-hook`

If a conflict is detected, the system must fail fast with an actionable message naming both the requesting and conflicting packages, and suggesting package filtering or removal.

### Pin update policy for optional packages

- Pins remain `<TBD>` until smoke-tested alongside the foundation stack.
- Before first recommendation or automated install, set the exact version pin and update this record.

## Overlap avoidance

**Single-owner policy.** Every concern has exactly one owner package. Do not add a second package that overlaps an owned concern.

### Ownership map

| Concern                                                | Owner                                          | Semantics                                                                                                                                                           |
| ------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orchestration (delegation, worktrees, background runs) | `pi-subagents`                                 | Only subagent runner allowed. No `pi-fork`, `pi-minimal-subagent`, `PiSwarm`, or any other runner.                                                                  |
| Compaction / output optimization                       | `pi-rtk-optimizer` + `pi-zflow-compaction`     | `pi-rtk-optimizer` owns first-pass compaction; `pi-zflow-compaction` owns session-before-compact hooks. No other package may register overlapping compaction hooks. |
| External research / web access                         | `pi-web-access`                                | First-pass research owner. No competitor in the foundation stack.                                                                                                   |
| Human-in-the-loop                                      | `pi-interview`                                 | HITL owner. `pi-mono-ask-user-question` is explicitly excluded from the v1 foundation.                                                                              |
| Profile / lane / model routing                         | `pi-zflow-profiles`                            | Profile loading, lane resolution, active-profile cache. No other package may own profile/lane state.                                                                |
| Planning safety / read-only mode                       | `pi-zflow-plan-mode`                           | Ad-hoc read-only planning mode, active-tool restriction. No other package may independently toggle planning safety.                                                 |
| Runtime artifacts / state paths                        | `pi-zflow-artifacts`                           | Runtime state path resolution, plan/run/review artifact helpers, `zflow_write_plan_artifact` tool.                                                                  |
| Review flows                                           | `pi-zflow-review`                              | Plan/code/PR review orchestration. `pi-mono-review` is explicitly excluded from the v1 foundation.                                                                  |
| Recovery / checkpoint                                  | runtime artifacts; optionally `pi-rewind-hook` | If `pi-rewind-hook` is enabled, no other rewind/checkpoint package may be active by default.                                                                        |

### Explicit exclusions from first-pass foundation

- ❌ `pi-mono-review` — excluded from v1 foundation; `pi-zflow-review` owns review
- ❌ `pi-mono-ask-user-question` — excluded from v1 foundation; `pi-interview` owns HITL
- ❌ Any competing orchestration owner (`pi-fork`, `pi-minimal-subagent`, `PiSwarm`, etc.)
- ❌ `codemapper` stack as indexed-navigation foundation
- ❌ Default overrides of built-in Pi tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) in any `pi-zflow` child package
- ❌ Generic command aliases unless explicitly enabled by the user

### Command and tool naming policy

- All public commands **must** be namespaced: `/zflow-*`
- All custom tools **must** be namespaced: `zflow_*`
- Short aliases (`/plan`, `/profile`, `/review-pr`, `/change-prepare`) are opt-in only
- No child package may register short aliases by default
- Alias registration must check for existing commands and avoid shadowing another package
- No child package may override built-in Pi tools in any default configuration

> See `docs/architecture/package-ownership.md` for the full canonical ownership and exclusion policy.
> See `docs/foundation-versions.md` for version pins and the complete foundation record.

## Foundation install record

Installed by Phase 0 Task 0.3 on 2026-05-12. All packages are at user scope (no local `.pi/` override).

### Required packages

| Package            | Version  | Install status | Extension entry point      |
| ------------------ | -------- | -------------- | -------------------------- |
| `pi-subagents`     | `0.24.2` | ✅ installed   | `./src/extension/index.ts` |
| `pi-rtk-optimizer` | `0.7.1`  | ✅ installed   | `./index.ts`               |
| `pi-intercom`      | `0.6.0`  | ✅ installed   | `./index.ts`               |

### Recommended first-pass packages

| Package                 | Version  | Install status | Extension entry point |
| ----------------------- | -------- | -------------- | --------------------- |
| `pi-web-access`         | `0.10.7` | ✅ installed   | `./index.ts`          |
| `pi-interview`          | `0.8.7`  | ✅ installed   | `./index.ts`          |
| `pi-mono-sentinel`      | `1.11.0` | ✅ installed   | `./index.ts`          |
| `pi-mono-context-guard` | `1.7.3`  | ✅ installed   | `./index.ts`          |
| `pi-mono-multi-edit`    | `1.7.3`  | ✅ installed   | `./index.ts`          |
| `pi-mono-auto-fix`      | `0.3.1`  | ✅ installed   | `./index.ts`          |

### Install notes

- Pi version at install time: `0.74.0`
- All packages installed via `pi install npm:<pkg>@<pin>` (user scope, no `-l` flag)
- No install failures. All 9 extension entry points verified present on disk.
- `pi list` and `~/.pi/agent/settings.json` both confirm registration.
- **Known issue**: running multiple `pi install` commands concurrently may cause some packages to be installed at the npm level but not registered in Pi `settings.json`. If a package appears in `npm root -g` but not in `pi list`, re-run `pi uninstall <pkg>` followed by `pi install <pkg>` for that package.
- Deprecation warnings encountered for `@mariozechner/*` packages (used by transitive dependencies); these are informational only.

## Machine prerequisite checks

See `docs/bootstrap-checks.md` for the full preflight check design. The following checks are required
before expensive operations:

| Tool / check       | Scope                  | Effect if missing                       |
| ------------------ | ---------------------- | --------------------------------------- |
| `rtk --version`    | Always                 | Warning (output compaction unavailable) |
| `gh --version`     | PR review (GitHub)     | Blocks PR submission                    |
| `glab --version`   | PR review (GitLab)     | Blocks MR submission                    |
| `gh auth status`   | Inline GitHub comments | Blocks comment submission               |
| `glab auth status` | Inline GitLab comments | Blocks comment submission               |
| `runectx status`   | RuneContext mode       | Blocks RuneContext flows                |
| `pi --list-models` | Profile activation     | Blocks profile activation               |

Failure messages are specific and actionable — each names the missing tool, provides an install hint,
and explains what functionality is affected.

## Default profile

The initial baseline profile fixture is at `packages/pi-zflow-profiles/config/profiles.example.json`.
Feasibility was validated against the live model registry — see `docs/default-profile-feasibility.md`.

**Resolved lanes** (validated 2026-05-12):

| Lane                | Provider/model                                                                    | Status                 |
| ------------------- | --------------------------------------------------------------------------------- | ---------------------- |
| `planning-frontier` | `openai-codex/gpt-5.4` (primary), `opencode-go/mimo-v2.5-pro` (fallback)          | ✅ resolved            |
| `worker-cheap`      | `openai-codex/gpt-5.4-mini` (primary), `opencode-go/deepseek-v4-flash` (fallback) | ✅ resolved            |
| `review-system`     | `openai-codex/gpt-5.3-codex` (primary), `opencode-go/qwen3.6-plus` (fallback)     | ✅ resolved (optional) |

Since primary lanes use `openai-codex`, `@benvargas/pi-openai-verbosity` is recommended (see optional package policy).

## Runtime state paths

Runtime state lives outside the working tree. See `docs/foundation-versions.md` for the full path table.

### Core resolvers (`packages/pi-zflow-core/src/runtime-paths.ts`)

- `resolveRuntimeStateDir(cwd?)` → `<git-dir>/pi-zflow/` or `os.tmpdir()/pi-zflow-<hash>/` fallback
- `resolveUserStateDir()` → `~/.pi/agent/zflow/`
- `DEFAULT_STALE_ARTIFACT_TTL_DAYS` = 14 days
- `DEFAULT_FAILED_WORKTREE_RETENTION_DAYS` = 7 days

### Artifact path builders (`packages/pi-zflow-artifacts/src/artifact-paths.ts`)

- `resolvePlanDir(changeId, version)` — plan version directory
- `resolveRunDir(runId)` — run directory
- `resolveStateIndexPath()` — state-index.json
- `resolveReviewDir()` — review directory
- `resolveActiveProfilePath()` — active profile cache
- `resolveInstallManifestPath()` — install manifest
- Plus all other derived paths matching the `docs/foundation-versions.md` layout.

### User-level directories (`packages/pi-zflow-core/src/user-dirs.ts`)

| Directory / File                          | Purpose                                       | Constant                |
| ----------------------------------------- | --------------------------------------------- | ----------------------- |
| `~/.pi/agent/agents/zflow/`               | Agent markdown for `pi-subagents`             | `USER_AGENTS_DIR`       |
| `~/.pi/agent/chains/zflow/`               | Chain markdown for `pi-subagents`             | `USER_CHAINS_DIR`       |
| `~/.pi/agent/zflow/`                      | State base (install manifest, active profile) | `USER_STATE_BASE`       |
| `~/.pi/agent/zflow/install-manifest.json` | Record of installed agents/chains/skills      | `INSTALL_MANIFEST_PATH` |
| `~/.pi/agent/zflow/active-profile.json`   | Active profile cache                          | `ACTIVE_PROFILE_PATH`   |

**Rules**:

- Default scope is **user-level** (`~/.pi/agent/...`).
- Project-local `.pi/agents/` and `.pi/chains/` are **opt-in only**.
- Directory creation is **idempotent** — `ensureUserDirs()` uses `fs.mkdir({ recursive: true })`.

### Cleanup policy

| Artifact                      | TTL                                                    |
| ----------------------------- | ------------------------------------------------------ |
| Stale runtime/patch artifacts | 14 days (`/zflow-clean`)                               |
| Failed/interrupted worktrees  | 7 days (`/zflow-clean`)                                |
| Successful temp worktrees     | removed immediately after apply-back (unless `--keep`) |

## Worktree setup hooks

Some repos need generated files, symlink hydration, env stubs, or other bootstrap inside isolated worktrees.
See the full policy document at `docs/worktree-setup-hook-policy.md`.

**Quick rules**:

- Plain TS/JS repos with checked-in deps → usually **no hook needed**.
- Monorepos with generated links, env stub repos, codegen repos → **hook required**.
- If setup is required but no hook is configured → **worker dispatch fails immediately** with actionable guidance.
- Hooks are **always per-repo configuration** — never baked into the pi-zflow package.

The hook contract is defined in `packages/pi-zflow-core/src/worktree-setup-hook.ts` with types
`WorktreeSetupHookConfig`, `WorktreeSetupHookContext`, `WorktreeSetupHookResult`, and the
`runWorktreeSetupHook()` runner function.

Generic templates are shipped at:

```
packages/pi-zflow-change-workflows/templates/worktree-setup-hooks/
```

| Template                     | For                                         |
| ---------------------------- | ------------------------------------------- |
| `generic-node-ci.sh`         | Plain TS/JS repos                           |
| `generic-pnpm-workspace.mjs` | pnpm workspace monorepos                    |
| `generic-env-stub.sh`        | Env stub generation                         |
| `generic-codegen.sh`         | Code generation (Prisma, GraphQL, protobuf) |

## License

MIT
