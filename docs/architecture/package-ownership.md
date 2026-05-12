# Package Ownership and Overlap-Avoidance Policy

> **Canonical reference for single-owner package policy.**
> Every concern in the pi-zflow foundation has exactly one owner package.
> No later phase or contribution may add a second package that overlaps an owned concern
> unless the phase explicitly documents the overlap, the reason, and the coexistence strategy.

## Policy statement

The pi-zflow foundation is built on a strict single-owner model:

- **One concern, one owner.** If a capability is already owned, do not add a competing package.
- **No default built-in overrides.** No pi-zflow child package may override built-in Pi tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, etc.) in any default configuration.
- **No generic command aliases.** Short aliases (`/plan`, `/profile`, `/review-pr`, `/change-prepare`) are opt-in only and must never be registered by default.
- **Extension coexistence.** Every extension must tolerate being loaded twice (umbrella + standalone), must use namespaced (`zflow-*`) commands and tools, and must fail fast with an actionable message if an incompatible capability is already claimed.

## Ownership map

| Concern | Owner package(s) | Details | Prohibited competitors |
|---|---|---|---|
| **Orchestration** (subagent delegation, worktrees, background runs) | `pi-subagents` | The only subagent runner allowed in the foundation. Worktree isolation uses `pi-subagents` native `worktree: true` support. | `pi-fork`, `pi-minimal-subagent`, `PiSwarm`, any other subagent runner |
| **Compaction / output optimization** | `pi-rtk-optimizer` + `pi-zflow-compaction` | `pi-rtk-optimizer` owns first-pass command rewriting and output compaction. `pi-zflow-compaction` owns `session_before_compact` hooks and compaction handoff reminders. | No other package may register overlapping compaction hooks or compete with `session_before_compact` |
| **External research / web access** | `pi-web-access` | First-pass research owner for web searches, URL fetching, GitHub content, YouTube transcripts, and code search. | None in the first-pass foundation |
| **Human-in-the-loop** | `pi-interview` | First-pass HITL owner for interactive user prompts and decision capture. | `pi-mono-ask-user-question` (excluded) |
| **Profile / lane / model routing** | `pi-zflow-profiles` | Profile loading, lane resolution, active-profile cache, profile health checks. Commands: `/zflow-profile`, `/zflow-profile list`, `/zflow-profile switch`, `/zflow-profile validate` | No other package may own profile/lane state or activation cache |
| **Planning safety / read-only mode** | `pi-zflow-plan-mode` | Ad-hoc read-only planning mode, active-tool restriction, restricted bash policy, mode status. Commands: `/zflow-plan`, `/zflow-plan status`, `/zflow-plan exit` | No other package may independently toggle or own the planning safety mode |
| **Runtime artifacts / state paths** | `pi-zflow-artifacts` | `<runtime-state-dir>` resolution, `<user-state-dir>` helpers, plan/run/review path builders, atomic artifact writes, cleanup metadata. Tool: `zflow_write_plan_artifact` | None |
| **Review flows** | `pi-zflow-review` | Plan-review swarm invocation, internal code-review orchestration, external PR/MR diff review, findings schema/normalization. Commands: `/zflow-review-code`, `/zflow-review-pr <url>` | `pi-mono-review` (excluded from v1 foundation) |
| **Recovery / checkpoint** | runtime artifacts; optionally `pi-rewind-hook` | If `pi-rewind-hook` is enabled, no other rewind/checkpoint package may be active by default. Recovery always uses `runtime-state-dir` files first. | No other checkpoint package when `pi-rewind-hook` is enabled |
| **Shared library / registry** | `pi-zflow-core` | Shared TypeScript types, config schemas, registry, service interfaces, package/version helpers. No Pi extensions, commands, tools, or UI. | None (library-only package) |
| **Agent/chain assets** | `pi-zflow-agents` | Custom agent markdown, chains, skills, prompt templates, prompt fragments, install manifest. Commands: `/zflow-setup-agents`, `/zflow-update-agents` | None |
| **Formal change orchestration** | `pi-zflow-change-workflows` | Plan lifecycle, implementation workflow, verification/fix loops, apply-back, cleanup. Commands: `/zflow-change-prepare <change-path>`, `/zflow-change-implement <change-path>`, `/zflow-clean` | None |
| **RuneContext integration** | `pi-zflow-runecontext` | RuneContext detection, change-doc flavor parsing, canonical doc resolution, prompt-with-preview write-back support | None |
| **Umbrella bundling** | `pi-zflow` | Bundles all child packages, exposes their Pi resources via `bundledDependencies` and umbrella `pi` manifest | None (consumes child packages) |

## Explicit exclusions from first-pass foundation

The following packages and capabilities are **intentionally excluded** from the v1 foundation.
They must not be added during Phase 0 or Phase 1 without explicit re-evaluation and approval.

| Excluded entity | Reason | Alternative |
|---|---|---|
| `pi-mono-review` | `pi-zflow-review` owns all review flows in v1 | Use `pi-zflow-review` |
| `pi-mono-ask-user-question` | `pi-interview` owns all HITL interactions in v1 | Use `pi-interview` |
| `pi-fork` | Competing orchestration owner — `pi-subagents` is the only runner | Use `pi-subagents` |
| `pi-minimal-subagent` | Competing orchestration owner — `pi-subagents` is the only runner | Use `pi-subagents` |
| `PiSwarm` | Competing orchestration owner — `pi-subagents` is the only runner | Use `pi-subagents` |
| `codemapper` stack | Not part of the indexed-navigation foundation; re-evaluate if needed later | None in v1 |
| Built-in Pi tool overrides | No `pi-zflow` child package may override `read`, `bash`, `edit`, `write`, etc. by default | Use event interception or narrow custom tools |
| Generic command aliases | `/plan`, `/profile`, `/review-pr`, `/change-prepare` are opt-in only | Use canonical `/zflow-*` commands by default |

## Command and tool naming rules

### Canonical names (always registered)

```text
/zflow-profile
/zflow-profile list
/zflow-profile switch
/zflow-profile validate
/zflow-plan
/zflow-plan status
/zflow-plan exit
/zflow-change-prepare <change-path>
/zflow-change-implement <change-path>
/zflow-review-code
/zflow-review-pr <url>
/zflow-clean
/zflow-setup-agents
/zflow-update-agents
zflow_write_plan_artifact         (custom tool, not slash-command)
```

### Short aliases (opt-in only)

```text
/plan             →  /zflow-plan
/profile          →  /zflow-profile
/review-pr        →  /zflow-review-pr
/review-code      →  /zflow-review-code
/change-prepare   →  /zflow-change-prepare
/change-implement →  /zflow-change-implement
/clean            →  /zflow-clean
/setup-agents     →  /zflow-setup-agents
/update-agents    →  /zflow-update-agents
```

Rules for alias registration:
1. Aliases must be disabled by default. Enable only through explicit user opt-in (config, flag, or install option).
2. Before registering an alias, check that no other package has already claimed it.
3. If an alias would shadow an existing command, fail with an actionable message naming the conflicting package.

### Built-in tool override prohibition

- No child package may register a tool named `read`, `bash`, `edit`, `write`, `grep`, `find`, or `ls`.
- No child package may replace Pi's built-in implementations of these tools.
- Future packages that intentionally override a built-in tool must be opt-in, documented as incompatible, and separated from the default umbrella install.

## Optional package policy

### Overview

Three packages are designated as optional/selective in the first-pass foundation.
Each has explicit conditions for installation. These rules must be enforced when
profile resolution, bootstrap, or configuration processing triggers package recommendations.

### Conditional installation rules

#### `@benvargas/pi-openai-verbosity`

**Condition**: recommend installation when any active lane in the resolved default profile
uses `openai-codex` as its provider.

**Rationale**: OpenAI Codex responses can be verbose. This package reduces verbosity
in tool output, making it more concise and readable when Codex is the active provider.

**Detection**: profile/lane resolution in `pi-zflow-profiles` should inspect all resolved
lanes for `openai-codex` providers. If found, emit a recommendation advisory.

```ts
// Pseudocode for implementation
function maybeRecommendOpenaiVerbosity(profile: ResolvedProfile): void {
  const usesCodex = Object.values(profile.lanes).some(
    lane => lane.provider === "openai-codex"
  )
  if (usesCodex) {
    logger.info("Recommend installing @benvargas/pi-openai-verbosity for reduced verbosity")
  }
}
```

#### `@benvargas/pi-synthetic-provider`

**Condition**: later cost/diversity optimization only. Excluded from first-pass foundation.

**Rationale**: Synthetic provider support is useful for cost optimization and model diversity
in multi-model workflows, but is not required for the initial implementation.

**Installation guard**: no automated recommendation or installation logic should be added
in Phase 0 or Phase 1. Revisit when cost optimization or diversity routing becomes a
concrete requirement.

#### `pi-rewind-hook`

**Condition**: install only when the user explicitly enables recovery/checkpoint functionality
in their configuration (`config.enableRewindHook` or equivalent).

**Rationale**: Optional recovery layer that provides rewind/checkpoint capability for
failed or interrupted operations. Not all users need recovery hooks.

**Exclusivity rule (enforced)**:

If `pi-rewind-hook` is enabled, **no other rewind or checkpoint package may be active**
in the same Pi configuration. This prohibition covers:

- Any package that registers `session_before_compact` hooks for checkpointing purposes
- Competing undo/redo or recovery systems
- Alternative checkpoint mechanisms not owned by `pi-rewind-hook`

```ts
// Pseudocode for enforcement
function installRewindHook(config: Config): void {
  if (!config.enableRewindHook) return

  const conflict = detectActiveCheckpointPackages()
  if (conflict) {
    throw new Error(
      `Cannot enable pi-rewind-hook: ${conflict.name} is already active. ` +
      `Remove or disable ${conflict.name} before enabling rewind/checkpoint support.`
    )
  }

  install("pi-rewind-hook")
}
```

Detection must happen before installation. If a conflict is found, the system must fail fast
with an actionable message naming both the requesting and conflicting packages, and
suggesting package filtering or removal.

### Related

- `docs/foundation-versions.md` — version pin records for optional packages
- `README.md` — condensed optional package conditions

## Registry contract

All capability ownership and discovery flows through the shared registry provided by `pi-zflow-core`:

```ts
registry.claim({ capability: "profiles", version: "1.0.0", provider: "pi-zflow-profiles", sourcePath: import.meta.url })
registry.provide("profiles", profileService)
registry.get("profiles")
registry.optional("review")
```

- Same capability/version loaded twice → no-op.
- Compatible provider already loaded → no-op, record both sources for diagnostics.
- Incompatible provider already loaded → emit clear diagnostic; do not register conflicting hooks/tools/commands.
- Required missing dependency → command stops with actionable message naming the package to install.
- Optional missing dependency → degrade only where the phase plan explicitly permits reduced coverage.

## Related documents

- `README.md` — project overview with condensed ownership table
- `docs/foundation-versions.md` — version pins, cleanup defaults, runtime path contracts
- `implementation-phases/package-split-details.md` — package family design, umbrella manifest pattern, per-child ownership details
