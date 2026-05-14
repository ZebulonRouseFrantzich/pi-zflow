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

- **Provisional minimum**: `0.74.0`
- **Confirmed minimum**: `0.74.0` (tested 2026-05-12)
- **Last tested**: `0.74.0` (2026-05-12)

See `docs/phase-0-smoke-test-report.md` for full smoke test details.

The minimum Pi version has been tested against:

- [x] Extension loading — all 9 foundation packages load
- [x] Chain discovery — user directories exist for agent/chain placement
- [x] `pi-subagents` runtime — extension registered, subagent help displayed
- [x] Session hooks needed by `pi-zflow-compaction` / `zflow-compaction` — Pi extension docs confirm compaction events (implementation deferred to Phase 8)
- [x] Active tool restrictions needed by `/zflow-plan` — Pi extension docs confirm `pi.setActiveTools()` support (implementation deferred to Phase 2)

### Package publication status

All child packages in `packages/*` are currently marked `"private": true`.
This is intentional for local development — it prevents accidental publication
before the Phase 1 asset skeleton is stable and tested. The modular boundaries,
inter-package import paths, and `pi` manifest keys are designed for independent
publishability. When the team is ready to publish, remove `"private": true`
from the relevant child `package.json` files and publish each scoped npm
package independently, following the staged approach in `package-split-details.md`.

### Pin policy

**No floating `latest` pins.** Every dependency in the foundation stack and every child package reference must have an exact version or exact git ref. This applies to:

- `package.json` `dependencies` in all packages
- Installation commands in bootstrap scripts
- Any documentation that references installable URLs

**Exceptions:**

- `peerDependencies` for Pi host packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`, `typebox`) use `"*"` to avoid version conflicts between package consumers. This is standard Pi package convention.

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
- **Before first automated recommendation or install, the exact version pin must be set** and this record updated.
- The current advisory documentation (profile fixture, feasibility report) that mentions `@benvargas/pi-openai-verbosity` is informational only. No automation may emit a recommendation or attempt installation until the pin is recorded.
- Documentation references to `<TBD>` optional packages must not be used by any automated install/recommendation code path.

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
- Prompt templates (slash-command helpers) use `/zflow-draft-*` to avoid collision with canonical extension commands (`/zflow-change-*`, `/zflow-review-*`)
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

| Artifact                      | TTL                                                     |
| ----------------------------- | ------------------------------------------------------- |
| Stale runtime/patch artifacts | 14 days (TTL constant defined; cleanup command planned) |
| Failed/interrupted worktrees  | 7 days (TTL constant defined; cleanup command planned)  |
| Successful temp worktrees     | removed immediately after apply-back (unless `--keep`)  |

> Note: The `/zflow-clean` cleanup command is planned as part of the change-workflows package implementation (future phase). The TTL constants are defined in `packages/pi-zflow-core/src/runtime-paths.ts`.

## Path guard / sentinel policy

pi-zflow uses an **allowlist-first** mutation safety model. Every write is gated
by `canWrite()`, which checks the target against configured allowed roots and
denied patterns. See the full policy document at `docs/path-guard-policy.md`.

**Key design points**:

- **Allowlist-first**: Nothing is writable by default. Every write target must be
  explicitly approved.
- **Intent distinction**: Planner artifact writes (`<runtime-state-dir>/plans/**`)
  are separate from implementation writes (source code). The planner must never
  modify source code; implementers must never trample plan state.
- **Denied by default**: `.git/`, `node_modules/`, `.env*`, home dotfiles,
  secret/credential files, and build outputs are blocked.
- **Symlink escape prevention**: Symlinks that resolve outside allowed roots are
  rejected. `..` traversal is detected and blocked.

The shared contract is defined in `packages/pi-zflow-core/src/path-guard.ts` with
the default policy at `packages/pi-zflow-core/config/sentinel-policy.default.json`.

Default blocked patterns (severity: `error`):

```
.git/**, node_modules/**, .env*, **/*.pem, **/*.key,
**/credentials*, **/secrets/**, ~/.ssh/**, ~/.aws/**, ~/.pi/**
```

Soft-blocked (severity: `warn` — allowed with diagnostic):

```
dist/**, .cache/**, .next/**, ~/.config/**
```

## Planner artifact tool: `zflow_write_plan_artifact`

`zflow_write_plan_artifact` is a narrow custom tool available **only to planner
and replan agents** (`zflow.planner-frontier`). It writes structured planning
artifacts under a safe, deterministic path.

### Purpose

Allow planners to produce versioned design documents without any ability to
modify source code. The tool is the **only write mechanism** available to
planner agents — they cannot use `edit`, `write`, or mutation-capable `bash`.

### Contract

| Parameter     | Type   | Validation                                                        | Notes                                                                     |
| ------------- | ------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `changeId`    | string | `assertSafeChangeId()` — kebab-case, alphanumeric + hyphens only  | Uniquely identifies the change (e.g. `add-auth-flow` or `fix-cache-race`) |
| `planVersion` | string | Must match `/^v\d+$/` (e.g. `v1`, `v2`)                           | Plans start at `v1`; replanning increments                                |
| `artifact`    | string | One of: `design`, `execution-groups`, `standards`, `verification` | The four mandatory plan artifact types                                    |
| `content`     | string | Markdown body (no additional validation beyond size limits)       | Full markdown content of the artifact                                     |

### Destination path

```
<runtime-state-dir>/plans/{changeId}/{planVersion}/{artifact}.md
```

Example:

```
/tmp/pi-zflow-<hash>/plans/add-auth-flow/v1/design.md
```

### Safety rules

| Rule                        | Enforcement                                                                                                                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Path confinement**        | The destination must normalise under `<runtime-state-dir>/plans/{changeId}/{planVersion}/`. Path separators in `changeId`, `..` traversal, and arbitrary directory names in `artifact` are rejected. |
| **Artifact type allowlist** | Only the four approved artifact kinds (`design`, `execution-groups`, `standards`, `verification`) are accepted. Any other value is rejected.                                                         |
| **Overwrite policy**        | Only approved plan artifacts may be overwritten. Non-artifact files under `<runtime-state-dir>/plans/` are protected.                                                                                |
| **Atomic write**            | Content is written to a `.tmp` file first, then renamed to the target path. Partial writes are never visible.                                                                                        |
| **Metadata recording**      | After a successful write, the artifact hash (SHA-256) and mtime are recorded in the plan's runtime metadata (`plan-state.json`).                                                                     |
| **Role restriction**        | The tool answers only for planner/replan agents whose allowlisted tools include `zflow_write_plan_artifact`. Currently only `zflow.planner-frontier`.                                                |

### Pseudocode

```ts
function writePlanArtifact({ changeId, planVersion, artifact, content }) {
  assertSafeChangeId(changeId); // kebab-case only
  assert(/^v\d+$/.test(planVersion)); // v1, v2, ...
  assert(
    ["design", "execution-groups", "standards", "verification"].includes(
      artifact,
    ),
  );
  const target = resolvePlanArtifactPath(changeId, planVersion, artifact);
  atomicWrite(target, content); // write .tmp → rename
  recordArtifactMetadata(changeId, planVersion, artifact, hash(content));
}
```

### Implementation targets

- Path resolution: `packages/pi-zflow-artifacts/src/artifact-paths.ts` — `resolvePlanArtifactPath()`
- Tool implementation: `packages/pi-zflow-artifacts/src/write-plan-artifact.ts`
- Tool registration: `packages/pi-zflow-artifacts/extensions/zflow-artifacts/index.ts`

### Related constraints

- The planner must also never use `edit`, `write`, or mutation-capable `bash`.
  This is enforced by the agent's `tools:` frontmatter allowlist and, when plan
  mode is active, by `pi.setActiveTools()`.
- Implementers must never write to plan artifact paths. This is enforced by
  the path guard (`path-guard.ts`) with `canWrite()` intent distinction.

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

## Install flow

### Prerequisites

- Pi agent installed and configured (minimum version 0.74.0)
- Node.js >= 22.0.0

### Install the full umbrella suite

```bash
pi install npm:pi-zflow@<PIN>
```

This installs `packages/pi-zflow` and pulls in all child packages as npm dependencies. The umbrella's `pi` manifest exposes the extensions, skills, and prompts from each child package.

After installation, use `/zflow-setup-agents` to install agent and chain markdown files into Pi discovery directories (see [Agent/chains installation](#agentchains-installation) below).

### Install individual child packages

Each Pi-enabled child package can be installed independently. This is useful when you only need a subset of capabilities.

Examples:

```bash
# Profiles only
pi install npm:pi-zflow-profiles@<PIN>

# Profiles + Plan mode
pi install npm:pi-zflow-profiles@<PIN>
pi install npm:pi-zflow-plan-mode@<PIN>

# Agents/chains/skills only (manual orchestration)
pi install npm:pi-zflow-agents@<PIN>
# Then run /zflow-setup-agents to deploy agents and chains
```

`pi-zflow-core` is a library-only package and is not installed directly as a Pi package. It is pulled in as a dependency by any child package that needs it.

### Package filtering

Pi supports filtering which resources are loaded from an installed package. This is useful when you want the umbrella but only need specific child packages active:

**Example — Pi settings.json (user scope):**

```json
{
  "packages": [
    {
      "source": "npm:pi-zflow@<PIN>",
      "extensions": [
        "node_modules/pi-zflow-profiles/extensions",
        "node_modules/pi-zflow-plan-mode/extensions"
      ],
      "skills": [],
      "prompts": []
    }
  ]
}
```

This loads only the profiles and plan-mode extensions from the umbrella. The `skills` and `prompts` arrays are explicitly set to empty to prevent loading agent skills and prompt templates.

**Filtering by resource type:**

| Filter key   | Effect                                    |
| ------------ | ----------------------------------------- |
| `extensions` | Array of extension paths to load (or all) |
| `skills`     | Array of skill directory paths (or none)  |
| `prompts`    | Array of prompt directory paths (or none) |
| `themes`     | Array of theme paths (or none)            |

Setting a filter key to an empty array `[]` disables loading of that resource type. Omitting the key loads all resources the package declares.

### Agent/chains installation

Pi does not have native `agents` or `chains` manifest keys. Agent and chain markdown files shipped by `pi-zflow-agents` must be installed into Pi subagents discovery directories.

**Default install locations:**

| Resource         | Directory                                 |
| ---------------- | ----------------------------------------- |
| Agent markdown   | `~/.pi/agent/agents/zflow/`               |
| Chain markdown   | `~/.pi/agent/chains/zflow/`               |
| Install manifest | `~/.pi/agent/zflow/install-manifest.json` |

**Install flow:**

1. Install `pi-zflow-agents` (as part of the umbrella or standalone).
2. Run `/zflow-setup-agents` to copy agent and chain files into the Pi discovery directories.
3. Run `/zflow-update-agents` later if the package version changes.

The install commands are:

- **Idempotent** — re-running does not overwrite user-local edits unless `--force` is used.
- **Tracking** — the install manifest at `~/.pi/agent/zflow/install-manifest.json` records which version's files were deployed.
- **Scope** — user-level by default (`~/.pi/agent/...`). Project-local `.pi/agents/` and `.pi/chains/` are opt-in only.

See `packages/pi-zflow-agents/extensions/zflow-agents/install.ts` and `manifest.ts` for the implementation.

## Builtin agent reuse strategy

`pi-zflow` reuses Pi's builtin `scout` and `context-builder` agents **by default**
rather than creating forked `zflow.*` copies. This avoids unnecessary duplication
and ensures compatibility with Pi ecosystem updates.

### What this means

- **No `zflow.scout` or `zflow.context-builder` agent file exists** in
  `packages/pi-zflow-agents/agents/`. The builtin agents are referenced directly
  by runtime name (`scout`, `context-builder`) in chain definitions and
  orchestrator workflows.
- **Customization is done via configuration overrides**, not by forking agent
  files. When a workflow needs a specialised scout or context-builder pass, the
  orchestrator overrides the relevant settings (system prompt fragments,
  tool allowlist, model, thinking level) through the subagent dispatch
  parameters or future profile bindings.

### Override points

Override behaviour is applied at the dispatch level, not by copying agent
files:

| Mechanism                               | Scope           | When to use                                                                                                                                        |
| --------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Subagent `task` string**              | Single dispatch | Add role-specific instructions inline when calling `scout` or `context-builder` for a specific task                                                |
| **Profile `agentBindings`**             | Workflow-wide   | Configure model, thinking, tools for `scout` or `context-builder` per profile/lane (see `packages/pi-zflow-profiles/config/profiles.example.json`) |
| **Future: Agent frontmatter overrides** | Package-level   | If `pi-subagents` gains override-file support, apply custom frontmatter fields without forking the agent file                                      |

### When to fork (rare)

Only fork `scout` or `context-builder` into `zflow.*` agents if:

1. The builtin agent's system prompt cannot be sufficiently redirected via
   dispatch-level overrides.
2. A deterministic enforcement point (e.g., a custom tool restriction) must
   be hardcoded in the agent's frontmatter `tools:` field.
3. The builtin agent is removed or substantially changed in a Pi update that
   breaks the workflow, and a local fork is the only migration path.

No such fork is planned for the v1 foundation. If a fork becomes necessary,
the forked agent must be named `zflow.scout` or `zflow.context-builder` and
stored in `packages/pi-zflow-agents/agents/`.

### Chains referencing builtin agents

The following chain files reference builtin agents directly (not `zflow.*`
variants):

| Chain file                            | Builtin agent used |
| ------------------------------------- | ------------------ |
| `chains/scout-plan-validate.chain.md` | `scout`            |
| `chains/plan-and-implement.chain.md`  | `scout`            |

These references work because `pi-subagents` resolves agent names by searching
discovery directories in priority order: project agents > user agents >
builtin agents. The builtin `scout` and `context-builder` are always
available in the lowest-priority discovery tier.

## System prompt architecture

The harness uses a **modular, multi-layered** system prompt delivery strategy.
Each layer is delivered by a different mechanism and serves a distinct purpose.

### Layer hierarchy

| Layer             | Delivery mechanism                                            | Contents                                                                                                                                                                                           | Scope                                                 |
| ----------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Pi default        | Built into Pi                                                 | Dynamic tool listings, guidelines, documentation paths, global rules                                                                                                                               | Every session                                         |
| Root constitution | `APPEND_SYSTEM.md` (not `SYSTEM.md`)                          | Compact orchestrator constitution: tool discipline, truthfulness taxonomy, safety rules, workflow boundaries, context discipline, engineering judgment, platform-documentation-awareness invariant | Orchestrator and subagents that inherit system prompt |
| Mode fragments    | Injected by extension at mode entry                           | Role-specific behaviour for `/zflow-plan`, `/zflow-change-prepare`, `/zflow-change-implement`, `/zflow-review-pr`, `/zflow-clean`                                                                  | Active during specific modes                          |
| Runtime reminders | Injected by extension on events                               | Short factual reminders for active plan mode, approved plan loaded, drift detected, compaction handoff, tool denied, external file change, verification status                                     | On specific state transitions                         |
| Agent prompts     | Agent markdown body (frontmatter `systemPromptMode: replace`) | Narrow role contract for each `zflow.*` agent; replaces rather than appends                                                                                                                        | The specific agent only                               |

### Why `APPEND_SYSTEM.md` instead of `SYSTEM.md`

- `SYSTEM.md` **replaces** Pi's default system prompt entirely. This would lose
  Pi's dynamic tool listings, guidelines, and built-in documentation paths,
  forcing the harness to replicate all of Pi's default behaviour.
- `APPEND_SYSTEM.md` **appends** to Pi's default prompt. The root constitution
  is added on top of Pi's built-in instructions, preserving tool listings and
  documentation awareness while adding pi-zflow-specific rules.
- When a user supplies their own `SYSTEM.md` (which fully replaces the default),
  the `before_agent_start` extension handler backfills Pi and pi-zflow
  documentation paths into the effective prompt.

### Prompt fragments vs slash-command prompts

Files under `prompt-fragments/` are **not** auto-discovered by Pi's
`pi.prompts` manifest key. They are not slash-command prompt templates.
Instead they are:

- **Root-orchestrator fragment** (`root-orchestrator.md`) — delivered via
  `APPEND_SYSTEM.md` as the compact constitution.
- **Mode fragments** (`modes/` directory) — injected into the prompt by
  the plan-mode and workflow extensions when a mode becomes active.
- **Runtime reminders** (`reminders/` directory) — injected on specific
  events such as plan mode entry, drift detection, or compaction handoff.

This separation ensures that:

- The root constitution stays compact and focused.
- Mode-specific rules only appear when the mode is active.
- Runtime reminders are short, factual, and state-specific.
- No fragment accidentally becomes a user-invokable slash command.

### Planner source-read-only invariant

The planner agent (`zflow.planner-frontier`) is **source-read-only by design**.
It may only use `zflow_write_plan_artifact` to write plan artifacts under
`<runtime-state-dir>/plans/`. It must never use `edit`, `write`, or
mutation-capable `bash`. This invariant is enforced at three levels:

1. **Agent frontmatter** — the planner's `tools:` allowlist includes
   `zflow_write_plan_artifact` but excludes `edit` and `write`.
2. **Custom tool gating** — `zflow_write_plan_artifact` only writes to
   approved plan-artifact paths.
3. **Plan-mode enforcement** — when `/zflow-plan` mode is active,
   `pi.setActiveTools()` restricts the tool set to read-only.

## Skill inventory

Seven focused skills live under `packages/pi-zflow-agents/skills/`. Each is
injectable into agent frontmatter via the `skills:` field.

| Skill                          | Purpose                                                                                                                                                                                   | Used by                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `change-doc-workflow`          | Ad-hoc/non-RuneContext change docs, planning-artifact structure (design, execution-groups, standards, verification), decision-completeness expectations, artifact-first lifecycle         | `zflow.planner-frontier`, `zflow.plan-validator`, plan-review agents                  |
| `runecontext-workflow`         | RuneContext change-document flavors, canonical precedence rules, status handling, detection paths, per-agent interaction rules                                                            | `zflow.planner-frontier`, `zflow.plan-review-correctness`                             |
| `implementation-orchestration` | Execution-group discipline (≤7 files, ≤3 phases), task ownership, worker execution sequence, tool guidance, deviation protocol                                                            | `zflow.implement-routine`, `zflow.implement-hard`, `zflow.verifier`                   |
| `multi-model-code-review`      | Reviewer roles (correctness, integration, security, logic, system), 4-level severity scheme, structured findings format, synthesis rules (deduplication, support/dissent, coverage notes) | All `zflow.review-*` agents, `zflow.synthesizer`                                      |
| `code-skeleton`                | Compact module signatures and structural summaries for planning and context building without reading full source                                                                          | `zflow.implement-routine`, `zflow.implement-hard`, `zflow.plan-review-feasibility`    |
| `plan-drift-protocol`          | Deviation detection, deviation-report structure, filing triggers, post-filing workflow, drift prevention tips                                                                             | `zflow.implement-hard`                                                                |
| `repository-map`               | High-level repo tree overview generation, map format conventions, usage for planning/context/review                                                                                       | `zflow.repo-mapper`, `zflow.plan-review-integration`, `zflow.plan-review-feasibility` |

## Agent and chain overview

### Custom agents (`packages/pi-zflow-agents/agents/`)

All 15 custom agents use `package: zflow` in their frontmatter, making their
runtime names `zflow.<name>`. Each is a narrow role contract with
`systemPromptMode: replace`, explicit `tools:` allowlists, and focused skills.

| Runtime name                    | Role                       | Tools                                                                                      | Skills                                                           |
| ------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `zflow.planner-frontier`        | Planning artifact author   | read, grep, find, ls, bash, zflow_write_plan_artifact, web_search, fetch_content, subagent | change-doc-workflow, runecontext-workflow                        |
| `zflow.plan-validator`          | Plan structural validation | read, grep, find, ls                                                                       | change-doc-workflow                                              |
| `zflow.implement-routine`       | Routine implementation     | read, grep, find, ls, bash, edit, write                                                    | implementation-orchestration, code-skeleton                      |
| `zflow.implement-hard`          | Complex implementation     | read, grep, find, ls, bash, edit, write, subagent                                          | implementation-orchestration, code-skeleton, plan-drift-protocol |
| `zflow.verifier`                | Scoped verification        | read, grep, find, ls, bash                                                                 | implementation-orchestration                                     |
| `zflow.plan-review-correctness` | Plan correctness review    | read, grep, find, ls                                                                       | change-doc-workflow, runecontext-workflow                        |
| `zflow.plan-review-integration` | Plan integration review    | read, grep, find, ls                                                                       | change-doc-workflow, repository-map                              |
| `zflow.plan-review-feasibility` | Plan feasibility review    | read, grep, find, ls, bash                                                                 | change-doc-workflow, code-skeleton, repository-map               |
| `zflow.review-correctness`      | Code correctness review    | read, grep, find, ls                                                                       | multi-model-code-review                                          |
| `zflow.review-integration`      | Code integration review    | read, grep, find, ls                                                                       | multi-model-code-review                                          |
| `zflow.review-security`         | Code security review       | read, grep, find, ls                                                                       | multi-model-code-review                                          |
| `zflow.review-logic`            | Code logic review          | read, grep, find, ls                                                                       | multi-model-code-review                                          |
| `zflow.review-system`           | Code system review         | read, grep, find, ls                                                                       | multi-model-code-review                                          |
| `zflow.synthesizer`             | Findings synthesis         | read, grep, find, ls                                                                       | multi-model-code-review                                          |
| `zflow.repo-mapper`             | Repo map generation        | read, grep, find, ls, bash                                                                 | repository-map                                                   |

See individual files in `packages/pi-zflow-agents/agents/` for the complete
system prompts (role contracts).

### Chain files (`packages/pi-zflow-agents/chains/`)

Chain files are **reusable internal building blocks**, not the primary
user-facing workflow UX. They are invoked by the subagent system and the
orchestrator. The primary workflow UX is the extension command layer
(`/zflow-*` commands).

| Chain                           | Steps                                                                                                              | Purpose                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `scout-plan-validate.chain.md`  | scout → planner → validator → plan-review-correctness → plan-review-feasibility                                    | Exploration → planning → validation → conditional plan review |
| `plan-and-implement.chain.md`   | scout → planner → validator → implement-routine → verifier → review-correctness → review-integration → synthesizer | End-to-end artifact-first lifecycle                           |
| `parallel-review.chain.md`      | 5 concurrent reviewers → synthesizer                                                                               | Multi-angle code review swarm                                 |
| `implement-and-review.chain.md` | implement-routine → verifier → review-correctness → review-integration → synthesizer                               | Implementation → verification → review                        |
| `plan-review-swarm.chain.md`    | 3 plan reviewers + plan-validator → synthesizer                                                                    | Parallel plan-review swarm with structural validation         |

## Shared registry and duplicate-load behavior

`pi-zflow` packages coordinate through a **global shared registry** provided
by `pi-zflow-core`. The registry is backed by `globalThis`, so it works even
when multiple physical copies of `pi-zflow-core` are loaded through different
package roots.

### Registry purpose

The registry (`getZflowRegistry()` from `packages/pi-zflow-core/src/registry.ts`)
prevents conflicting or duplicate registrations when:

- The umbrella package and a standalone child package are both installed.
- Multiple versions of the same child package are present in `node_modules`.
- A user installs `pi-zflow` twice through different package sources.

### Registration protocol

Each Pi extension should follow this sequence on activation:

```ts
const registry = getZflowRegistry();

// 1. Claim the capability — fails fast if incompatible provider already registered
registry.claim({
  capability: "artifacts", // namespaced capability name
  version: "0.1.0", // semver of the capability
  provider: "pi-zflow-artifacts", // package name
  sourcePath: import.meta.url,
});

// 2. Register tools/commands/hooks only after claim succeeds
// 3. Provide the service API for other packages to consume
registry.provide("artifacts", artifactService);
```

### Load resolution outcomes

| Scenario                                         | Behaviour                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| Same package/capability/version loaded twice     | No-op; return existing service                                            |
| Compatible provider already registered           | No-op; record both sources for diagnostics                                |
| Incompatible provider/version already registered | Fail fast with diagnostic naming both packages; suggest package filtering |
| Required capability missing                      | Command stops with actionable message naming the package to install       |
| Optional capability missing                      | Degrade only where explicitly permitted by the phase plan                 |

### Coexistence rules (from package-split-details.md)

- **API-first, extension-second**: reusable logic lives in library exports;
  extension entrypoints are thin adapters.
- **Namespaced public surface**: commands `/zflow-*`, tools `zflow_*`,
  events `zflow:*`.
- **Single owner per concern**: no two packages own the same capability.
- **No event-bus RPC**: use direct library APIs or the registry; `pi.events`
  is only for notifications.
- **Idempotent registration**: every extension tolerates being loaded twice.
- **Mode-local side effects**: changes to active tools, widgets, status lines,
  editor UI, or model/thinking settings are scoped to the active mode and
  restored on exit.
- **Package-filtering friendly**: each feature package makes sense when loaded
  alone; the umbrella manifest supports include/exclude via Pi package filters.

See `packages/pi-zflow-core/src/registry.ts` for the implementation.
See `packages/pi-zflow-core/src/diagnostics.ts` for capability conflict helpers.

## Subagent Integration Boundary

> This section documents the explicit division of responsibility between
> `pi-subagents` (the orchestration runtime) and `pi-zflow` packages (the
> workflow layer). This boundary is a **must-preserve architectural decision**
> and must not be eroded in later phases.

### What `pi-subagents` owns

`pi-subagents` is the **only orchestration runtime** in the foundation. It owns
all subprocess/agent lifecycle and isolation:

| Responsibility                       | Details                                                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| **Single subagent execution**        | Launch and manage one-shot `/run` subagents by runtime name                                                 |
| **Parallel execution**               | Run multiple subagents concurrently within a chain or orchestration step                                    |
| **Chain execution**                  | Sequence subagent stages with dependency ordering, output routing, and conditional branching                |
| **Background runs**                  | Fork and track long-running subagent sessions                                                               |
| **Child contexts / forked contexts** | Create isolated sub-contexts with narrowed prompt, tool, and file-access scope                              |
| **Agent discovery**                  | Resolve agent markdown files from user/project discovery directories (`~/.pi/agent/agents/`, `.pi/agents/`) |
| **Chain discovery**                  | Resolve chain markdown files (`*.chain.md`) from user/project discovery directories                         |
| **Worktree creation/cleanup**        | Create and tear down isolated worktree environments when `worktree: true`                                   |
| **Artifact capture**                 | Capture subagent stdout, stderr, structured output, and written file paths from each run                    |

### What `pi-zflow` packages own

`pi-zflow` packages are the **workflow and configuration layer**. They choose
_which_ agents/chains to run, _how_ to configure them, and _what_ to do with
their output — but they do not implement a runner.

| Package                     | Owns                                                                                                                                       | Integration with `pi-subagents`                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pi-zflow-agents`           | Agent markdown, chain definitions, skills, prompt fragments, and setup/update installation (`/zflow-setup-agents`, `/zflow-update-agents`) | Installs agent `.md` and chain `.chain.md` files into `pi-subagents` discovery directories so they become available via runtime name                                     |
| `pi-zflow-profiles`         | Profile/lane resolution, agent-to-model binding, active profile cache                                                                      | Provides resolved bindings (model, tools, `maxOutput`, `maxSubagentDepth`) that are injected as launch-time overrides when `pi-subagents` starts a subagent              |
| `pi-zflow-change-workflows` | Formal prepare/implement orchestration, plan lifecycle, verification/fix loops, apply-back                                                 | Chooses which agents/chains to invoke, builds launch configs from profile bindings, routes output to `pi-zflow-artifacts` for persistence                                |
| `pi-zflow-review`           | Plan-review and code-review orchestration, PR/MR diff review, findings management                                                          | Assembles reviewer manifests, dispatches review swarms via chains, and persists synthesised findings through the artifact layer                                          |
| `pi-zflow-artifacts`        | Runtime state path resolution, atomic artifact writes, cleanup metadata                                                                    | Persists subagent outputs (plan artifacts, review findings, run state) into `<runtime-state-dir>` — the orchestrator owns _what_ to persist, this owns _how_ and _where_ |
| `pi-zflow-plan-mode`        | Ad-hoc read-only planning mode, active-tool restriction                                                                                    | Does not directly integrate with `pi-subagents`; constrains tool availability for the main session                                                                       |
| `pi-zflow-compaction`       | Proactive compaction hooks and handoff reminders                                                                                           | Owns the `session_before_compact` hook that runs before Pi compacts session history                                                                                      |
| `pi-zflow-runecontext`      | RuneContext detection, change-doc flavor parsing, canonical doc resolution                                                                 | Provides document context that the workflow layer feeds into subagent prompts                                                                                            |
| `pi-zflow-core`             | Shared types, registry, version constants                                                                                                  | Library-only; no direct Pi or subagent integration                                                                                                                       |

### How they connect

The integration follows a strict **config-invoke-store** pattern:

```
┌─────────────────────────────────────────────────────────────────┐
│                      pi-zflow workflow layer                     │
│                                                                  │
│  1. Resolve │ pi-zflow-profiles  │→ resolved agent bindings      │
│  2. Assemble│ pi-zflow-agents    │→ agent/chain markdown files   │
│  3. Build   │ workflow package   │→ launch config + prompt       │
│             │                    │                                │
│             ▼                    │                                │
│  4. Invoke  │ pi-subagents API   │→ runs subagent/chain          │
│             │                    │                                │
│             ▼                    │                                │
│  5. Persist │ pi-zflow-artifacts │→ capture output to state dir   │
│  6. Process │ workflow package   │→ validate, synthesize, retry   │
└─────────────────────────────────────────────────────────────────┘
```

**Key rules:**

- Workflow packages never call `pi-subagents` internals directly — they use the
  public `/run`, `/chain`, `subagent(...)` API that `pi-subagents` exposes to
  the Pi runtime.
- `pi-zflow-agents` installs markdown files into `pi-subagents` discovery paths;
  `pi-subagents` reads and interprets them. The workflow layer does not parse
  agent frontmatter directly — it relies on the profile binding for launch config
  and the chain file for stage ordering.
- The workflow layer builds _launch configs_ (model, tools, `maxOutput`,
  `maxSubagentDepth`) from resolved profile bindings and injects them as
  overrides at invocation time. It does not modify agent markdown files.
- `pi-subagents` owns _how_ a subagent runs (lifecycle, isolation, parallelism);
  `pi-zflow` owns _what_ runs and _why_.

### Anti-goal

**Do not build a custom runner.** There must never be a `pi-zflow-runner`
package or a `pi-zflow`-owned subagent framework. `pi-subagents` is the only
runner. If `pi-subagents` does not support a needed capability, extend
`pi-subagents` or work around it at the workflow layer — do not reimplement
subagent execution.

### Related documentation

- `docs/subagents-integration.md` — detailed integration notes, examples, and
  troubleshooting
- `docs/architecture/package-ownership.md` — canonical single-owner policy
- `packages/pi-zflow-agents/README.md` — agent/chain asset ownership and
  install/discovery flow

## Deferred systems

The following context-management and navigation systems are **intentionally excluded**
from the v1 foundation. They must not be added without explicit
re-evaluation against the Phase 8 baseline:

| System | Status | Alternative |
|--------|--------|-------------|
| `pi-dcp` | Deferred | Compaction summaries + canonical artifact rereads |
| `pi-observational-memory` | Deferred | File-backed artifacts in `<runtime-state-dir>` |
| `manifest.build` | Deferred | Repo maps + code skeletons |
| `nono` | Deferred | Plan validation + deviation protocol + verification loops |
| Indexed code navigation | Deferred | Repo maps + scout + grep/find |
| `codemapper` stack | Deferred | Cymbal wrapper if indexed nav needed later |

See `docs/deferred-pilots.md` for the full deferral details, rationale, and
re-evaluation criteria.

## License

MIT
