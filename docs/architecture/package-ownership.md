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

## Extension coexistence rules

1. **API-first, extension-second.** Reusable logic lives in library exports (from `pi-zflow-core` or the feature package). Pi extension entry points are thin adapters.
2. **No default built-in overrides.** (Repeated for emphasis.)
3. **Separate rendering from execution.** Renderer packages own visuals only; they must not own tool execution.
4. **Namespaced public surface.** Commands, custom tools, custom message types, status keys, widget keys, event names, and session entry types use `zflow` prefixes.
5. **Single owner per concern.** No two packages may own the same concern. Use the ownership map above to determine the canonical owner.
6. **No event-bus RPC.** Use direct library APIs or the shared registry. `pi.events` is for notifications only.
7. **Idempotent registration.** Every extension must tolerate being loaded twice and no-op when an equivalent compatible capability is already registered.
8. **Capability conflict detection.** If an incompatible capability is already claimed, fail fast with a clear message naming both packages and suggesting package filtering or removal.
9. **Mode-local side effects.** Changes to active tools, widgets, status lines, or model/thinking settings must be scoped to the active command/mode and restored when the mode exits.
10. **Package filtering friendly.** Each child Pi package should work when loaded alone. The umbrella manifest must make it possible to include/exclude resources with Pi package filters.

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
