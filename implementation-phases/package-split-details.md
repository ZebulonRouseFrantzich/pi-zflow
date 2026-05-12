# pi-zflow Package Split Details

Status: planning artifact only. This document is normative for implementation. Every phase document must be read together with this file before code is written.

## Purpose

`pi-zflow` should be usable as both:

1. a full harness suite installed with one command, and
2. a set of independently installable Pi packages for users who want only one capability.

The implementation must therefore be built as a package family from the start, even if the first publication ships only the umbrella package.

This document preserves the detailed implementation plan while changing the packaging shape from one monolithic package to a modular, composable package family.

## Pi packaging facts to respect

Pi supports modularity through existing package mechanisms:

- A Pi package can declare `extensions`, `skills`, `prompts`, and `themes` in `package.json` under the `pi` key.
- Pi packages can be installed from npm, git, or local paths.
- Package filtering can narrow which resources load from a package.
- `pi config` can enable/disable resources from installed packages and local directories.
- Pi does **not** have native `agents` or `chains` package manifest keys. Agent and chain assets must still be installed into `.pi/agents` / `.pi/chains` or `~/.pi/agent/agents` / `~/.pi/agent/chains` for `pi-subagents` discovery.
- Umbrella packages can bundle other Pi packages as npm dependencies, list them in `bundledDependencies`, and expose their resources via `node_modules/<child-package>/...` paths in the umbrella `pi` manifest.
- Pi loads packages with separate module roots, so duplicate package installs can exist. `pi-zflow` must defend against duplicate registration explicitly.

## Package family overview

The repository name and full-suite package name remain `pi-zflow`.

The implementation repo should be a workspace/monorepo with individually publishable packages:

```text
pi-zflow/                                # repository root, not necessarily the published package root
  package.json                            # workspace/dev scripts; may be private
  pi-config-implementation-plan.md
  implementation-phases/
  packages/
    pi-zflow-core/                        # shared library, no Pi resources
    pi-zflow-artifacts/                   # runtime paths/state + planner artifact tool
    pi-zflow-profiles/                    # profile/lane resolution
    pi-zflow-plan-mode/                   # ad-hoc read-only planning mode
    pi-zflow-agents/                      # agents/chains/skills/prompts/prompt fragments + setup command
    pi-zflow-review/                      # plan/code/PR review flows
    pi-zflow-change-workflows/            # formal prepare/implement orchestration
    pi-zflow-runecontext/                 # RuneContext integration
    pi-zflow-compaction/                  # custom compaction/session hooks
    pi-zflow/                             # umbrella Pi package that loads the suite
```

The top-level repository may publish `packages/pi-zflow` as the npm package named `pi-zflow`. The root workspace package should not be confused with the umbrella package.

## Publication strategy

The first implementation pass does **not** have to publish every child package independently. It should still structure the repository as if they are independently publishable.

Recommended staged approach:

1. Implement all child packages in the workspace with real package names and manifests.
2. During local development, use workspace/local path references and install the umbrella via a local path.
3. Publish only the umbrella first if that is simpler, but keep child package boundaries intact.
4. When demand appears for a standalone capability, publish that child package without moving files or changing public APIs.
5. Keep semver/pin records for child packages even before publication so future split publishing does not become a breaking refactor.

## Package ownership map

| Package | Type | Owns | Canonical commands/tools | Required by umbrella |
|---|---|---|---|---|
| `pi-zflow-core` | library only | shared TypeScript types, config schemas, registry, service interfaces, package/version helpers, common validation | none | yes |
| `pi-zflow-artifacts` | Pi package + library | runtime state path resolution, plan/run/review artifact helpers, atomic writes, cleanup metadata helpers, planner artifact write tool | tool: `zflow_write_plan_artifact` | yes |
| `pi-zflow-profiles` | Pi package + library | logical profile loading, lane resolution, active profile cache, profile health | `/zflow-profile ...` | yes |
| `pi-zflow-plan-mode` | Pi package | sticky ad-hoc read-only mode, active-tool restriction, restricted bash policy | `/zflow-plan`, `/zflow-plan status`, `/zflow-plan exit` | yes |
| `pi-zflow-agents` | Pi package + assets | custom agent markdown, chains, skills, prompt templates, prompt fragments, agent/chain install/update flow | `/zflow-setup-agents`, `/zflow-update-agents`, prompt helpers `/zflow-draft-*` | yes |
| `pi-zflow-review` | Pi package + library | multi-provider plan review, code review, PR/MR diff review, findings parsing/writing helpers | `/zflow-review-code`, `/zflow-review-pr <url>` | yes |
| `pi-zflow-change-workflows` | Pi package | formal artifact-first orchestration, plan lifecycle, implementation workflow, verification/fix loops, apply-back orchestration, cleanup UX | `/zflow-change-prepare <change-path>`, `/zflow-change-implement <change-path>`, `/zflow-clean` | yes |
| `pi-zflow-runecontext` | Pi package + library | RuneContext detection, change-doc flavor parsing, canonical doc resolution, prompt-with-preview write-back support | no required public command in v1; may expose `/zflow-runecontext status` later | yes if RuneContext support remains first-pass |
| `pi-zflow-compaction` | Pi package | proactive/custom compaction hook, compaction handoff reminders | no required public command in v1 | yes |
| `pi-zflow-renderers` | optional/deferred Pi package | visual renderers only, no tool execution changes | optional commands only | no, deferred |

## Dependency rules

- `pi-zflow-core` must never register Pi extensions, tools, commands, or UI. It is a library for composition.
- Feature packages may depend on `pi-zflow-core` and on other feature package libraries when the dependency is required.
- Optional integrations must be detected through the shared registry and fail with actionable messages if missing.
- `pi-zflow-change-workflows` may require `profiles`, `artifacts`, and `agents`; it should integrate with `review`, `runecontext`, and `compaction` when present.
- `pi-zflow-review` may require `profiles`, `artifacts`, and `agents` for the full reviewer/synthesizer workflow.
- Do not create hidden runtime dependencies through the event bus. Use direct imports for required library APIs and registry lookup for optional runtime services.

## Umbrella package manifest pattern

The umbrella `packages/pi-zflow/package.json` should bundle child packages and expose their Pi resources explicitly.

```json
{
  "name": "pi-zflow",
  "keywords": ["pi-package", "pi-zflow"],
  "dependencies": {
    "pi-zflow-core": "<PIN>",
    "pi-zflow-artifacts": "0.1.0",
    "pi-zflow-profiles": "0.1.0",
    "pi-zflow-plan-mode": "0.1.0",
    "pi-zflow-agents": "0.1.0",
    "pi-zflow-review": "0.1.0",
    "pi-zflow-change-workflows": "0.1.0",
    "pi-zflow-runecontext": "0.1.0",
    "pi-zflow-compaction": "0.1.0"
  },
  "bundledDependencies": [
    "pi-zflow-core",
    "pi-zflow-artifacts",
    "pi-zflow-profiles",
    "pi-zflow-plan-mode",
    "pi-zflow-agents",
    "pi-zflow-review",
    "pi-zflow-change-workflows",
    "pi-zflow-runecontext",
    "pi-zflow-compaction"
  ],
  "pi": {
    "extensions": [
      "node_modules/pi-zflow-artifacts/extensions",
      "node_modules/pi-zflow-profiles/extensions",
      "node_modules/pi-zflow-plan-mode/extensions",
      "node_modules/pi-zflow-agents/extensions",
      "node_modules/pi-zflow-review/extensions",
      "node_modules/pi-zflow-change-workflows/extensions",
      "node_modules/pi-zflow-runecontext/extensions",
      "node_modules/pi-zflow-compaction/extensions"
    ],
    "skills": [
      "node_modules/pi-zflow-agents/skills"
    ],
    "prompts": [
      "node_modules/pi-zflow-agents/prompts"
    ]
  }
}
```

Exact versions/refs must be pinned during implementation. The example versions above are placeholders.

## Child package manifest pattern

Each individually installable feature package should be a valid Pi package by itself when it owns Pi resources.

Example for `pi-zflow-profiles`:

```json
{
  "name": "pi-zflow-profiles",
  "keywords": ["pi-package", "pi-zflow"],
  "dependencies": {
    "pi-zflow-core": "0.1.0"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  },
  "pi": {
    "extensions": ["./extensions"],
    "prompts": [],
    "skills": []
  }
}
```

Packages with no prompts or skills may omit those keys or set them to empty arrays. Be explicit when clarity helps package filtering.

Every extension child package that imports Pi SDK/core packages should follow Pi package guidance: list `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`, and `typebox` as `peerDependencies` with `"*"` when imported, rather than bundling Pi's core packages.

## Package-relative path convention

Phase documents may still use paths like `extensions/zflow-profiles/index.ts` to avoid burying every task in workspace noise.

Unless a path is explicitly rooted at `packages/<package-name>/`, treat it as relative to the owning package in the ownership map above.

Examples:

- `extensions/zflow-profiles/index.ts` means `packages/pi-zflow-profiles/extensions/zflow-profiles/index.ts`.
- `extensions/zflow-change-workflows/orchestration.ts` means `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`.
- `agents/planner-frontier.md` means `packages/pi-zflow-agents/agents/planner-frontier.md`.
- `prompt-fragments/root-orchestrator.md` means `packages/pi-zflow-agents/prompt-fragments/root-orchestrator.md`.
- `config/profiles.example.json` means `packages/pi-zflow-profiles/config/profiles.example.json` unless a phase explicitly places a copy elsewhere for examples/tests.

This convention lets existing detailed task lists remain precise without losing the new package split.

## Canonical command naming and alias policy

All public commands owned by `pi-zflow` must be namespaced by default.

Canonical commands:

```text
/zflow-profile
/zflow-plan
/zflow-change-prepare <change-path>
/zflow-change-implement <change-path>
/zflow-review-code
/zflow-review-pr <url>
/zflow-clean
/zflow-setup-agents
/zflow-update-agents
```

Prompt helper templates should also be namespaced:

```text
/zflow-draft-change-prepare
/zflow-draft-change-capture-decisions
/zflow-draft-change-implement
/zflow-draft-change-audit
/zflow-draft-change-fix
/zflow-draft-review-pr
/zflow-docs-standards-audit
/zflow-standards-template
```

Short aliases such as `/plan`, `/change-prepare`, `/review-pr`, or `/profile` are optional compatibility conveniences. They must be disabled by default or registered only after explicit user opt-in. If implemented, the alias registration must check for existing commands and avoid shadowing another package.

## Tool naming and built-in tool policy

- Custom tools must use namespaced names, e.g. `zflow_write_plan_artifact`.
- Do not override built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) by default.
- Prefer event interception, narrow custom tools, and active-tool restriction over replacing built-in tool implementations.
- If a future package intentionally overrides a built-in tool, it must be opt-in, documented as incompatible with other wrappers of that tool, and separated from the default umbrella install.
- Mutation-capable custom tools must participate in Pi's file mutation queue when they mutate files.
- Tool output must follow Pi truncation guidance and return stable `details` shapes for rendering/state reconstruction.

## Extension-coexistence design rules

These rules directly address the known Pi ecosystem pain where extensions conflict because they combine execution, rendering, policy, and UX in one uncomposable extension.

1. **API-first, extension-second**: reusable logic lives in library exports from `pi-zflow-core` or the feature package. The Pi extension entrypoint should be a thin adapter that registers commands/tools/hooks.
2. **No default built-in overrides**: default packages must not replace built-in tools or renderers.
3. **Separate rendering from execution**: any future renderer package must not own tool execution. It should be optional and may be excluded from the umbrella if it risks conflicts.
4. **Namespaced public surface**: commands, custom tools, custom message types, status keys, widget keys, event names, and session custom entry types must use `zflow` prefixes.
5. **Single owner per concern**: keep the existing ownership model. For example, plan-mode owns active-tool restriction; profiles owns lane resolution; artifacts owns plan artifact writes; review owns findings synthesis orchestration.
6. **No event-bus RPC as a core API**: use direct library APIs or the shared registry. `pi.events` is only for notifications.
7. **Idempotent registration**: every extension must tolerate being loaded twice through umbrella + standalone installs and should no-op or warn when an equivalent compatible capability is already registered.
8. **Capability conflict detection**: if an incompatible capability is already claimed, fail fast with a clear message that names both packages and suggests package filtering or removal.
9. **Mode-local side effects**: changes to active tools, widgets, status lines, editor UI, or model/thinking settings must be scoped to the active command/mode and restored when the mode exits.
10. **Package filtering friendly**: each feature package should still make sense when loaded alone, and the umbrella manifest should make it possible to include/exclude resources with Pi package filters.

## Shared registry contract

`pi-zflow-core` should expose a registry backed by `globalThis` so it works even when multiple physical copies of `pi-zflow-core` are loaded through different package roots.

Conceptual API:

```ts
const registry = getZflowRegistry()

registry.claim({
  capability: "profiles",
  version: "1.0.0",
  provider: "pi-zflow-profiles",
  sourcePath: import.meta.url
})

registry.provide("profiles", profileService)
registry.get("profiles")
registry.optional("review")
registry.onChange("profiles", listener)
```

Required behavior:

- Same package/capability/version loaded twice: no-op or return the existing service.
- Compatible provider already loaded: no-op and record both sources for diagnostics.
- Incompatible provider/version already loaded: emit a clear diagnostic and do not register conflicting hooks/tools/commands.
- Required missing dependency: command should stop with an actionable message naming the package to install.
- Optional missing dependency: command should degrade only where the phase plan explicitly permits reduced coverage.

Registry state must not replace durable workflow state. Runtime recovery still uses `<runtime-state-dir>` and `<user-state-dir>`.

## Event naming policy

Events are notifications only. Names must be prefixed:

```text
zflow:profileChanged
zflow:planModeChanged
zflow:planApproved
zflow:reviewCompleted
zflow:workflowStateChanged
zflow:compactionHandoff
```

Do not implement request/response workflows on top of `pi.events`. That pattern is hard to reason about across extension load order and was explicitly called out as a Pi ecosystem pain point.

## Resource ownership details

### `pi-zflow-core`

Owns reusable code only:

- package/version constants
- shared config schemas
- safe identifier validation
- registry implementation
- service interfaces
- common diagnostic helpers
- command collision inspection helpers
- path normalization helpers that do not themselves know project runtime state

No Pi `pi` manifest. No side effects at import time beyond initializing the global registry object.

### `pi-zflow-artifacts`

Owns runtime artifact path and write mechanics:

- `<runtime-state-dir>` resolution
- `<user-state-dir>` helpers when shared by packages
- plan/run/review/failure-log path builders
- atomic markdown writes
- artifact hashes/mtimes
- cleanup metadata schema helpers
- `zflow_write_plan_artifact` tool registration

The planner artifact tool must only write approved plan artifacts under `<runtime-state-dir>/plans/{change-id}/v{n}/`.

### `pi-zflow-profiles`

Owns profile/lane resolution:

- `.pi/zflow-profiles.json`
- `~/.pi/agent/zflow-profiles.json`
- `<user-state-dir>/active-profile.json`
- lane health checks
- `/zflow-profile ...` commands
- service API for other packages to resolve agent bindings

### `pi-zflow-plan-mode`

Owns ad-hoc read-only planning mode:

- `/zflow-plan`, `/zflow-plan status`, `/zflow-plan exit`
- active-tool reduction while mode is active
- restricted read-only bash policy
- mode status/reminders

No other package may independently own the planning safety toggle.

### `pi-zflow-agents`

Owns non-runtime assets:

- custom `zflow.*` agent markdown
- chain markdown
- focused skills
- prompt templates
- prompt fragments
- `/zflow-setup-agents`
- `/zflow-update-agents`
- install manifest at `~/.pi/agent/zflow/install-manifest.json`

The package is individually useful for users who only want the agents/chains and will orchestrate manually.

### `pi-zflow-review`

Owns review flows:

- plan-review swarm invocation helpers
- internal code-review orchestration
- external PR/MR diff-only review
- findings schema/normalization
- reviewer manifest handling
- `/zflow-review-code`
- `/zflow-review-pr <url>`

The extension delegates consolidation to `zflow.synthesizer`; it must not become a bespoke findings-merging model replacement.

### `pi-zflow-change-workflows`

Owns formal orchestration:

- `/zflow-change-prepare <change-path>`
- `/zflow-change-implement <change-path>`
- `/zflow-clean`
- plan state transitions
- implementation session handoff
- worktree execution orchestration
- verification/fix loops
- apply-back strategy coordination
- integration with `pi-zflow-review`, `pi-zflow-runecontext`, and `pi-zflow-compaction` when present

It should call services from `profiles`, `artifacts`, and `agents`; it should not duplicate their internals.

### `pi-zflow-runecontext`

Owns RuneContext-specific behavior:

- detecting RuneContext roots
- resolving change docs
- parsing both supported document flavors
- status/transition mapping
- prompt-with-preview write-back support

Generic workflow code should depend on its service interface rather than embedding RuneContext parsing directly.

### `pi-zflow-compaction`

Owns compaction hooks:

- `session_before_compact`
- proactive compaction thresholds
- compaction handoff reminders
- reading canonical artifacts after compaction

It must coexist with `pi-rtk-optimizer` rather than replacing it.

## Package filtering examples

Install the full suite:

```bash
pi install npm:pi-zflow@<PIN>
```

Install only profiles:

```bash
pi install npm:pi-zflow-profiles@<PIN>
```

Install only plan mode and profiles:

```json
{
  "packages": [
    "npm:pi-zflow-profiles@<PIN>",
    "npm:pi-zflow-plan-mode@<PIN>"
  ]
}
```

Install the umbrella but load only selected resources:

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

This filtering ability is a primary reason to keep each capability in its own child package.

## Required test matrix for modularity

Before considering the package split complete, test at least:

1. each child Pi package installed alone when it is intended to be standalone;
2. umbrella `pi-zflow` installed alone;
3. umbrella installed with filters that load only one or two child resources;
4. umbrella plus one separately installed child package, verifying duplicate registration is safe;
5. missing optional dependencies produce reduced-coverage notes or actionable errors as specified;
6. no child package registers generic command aliases unless explicitly configured;
7. no child package overrides built-in tools in the default configuration.

## Migration note for existing plan text

Any existing plan text that says "the package" now means the relevant owner package from the ownership map, or the umbrella when discussing the full suite.

Any existing plan text that lists `extensions/...`, `agents/...`, `chains/...`, `skills/...`, `prompts/...`, or `prompt-fragments/...` remains valid under the package-relative path convention above.

Any existing plan text that refers to short commands should be understood as the namespaced canonical command unless it explicitly discusses optional aliases.
