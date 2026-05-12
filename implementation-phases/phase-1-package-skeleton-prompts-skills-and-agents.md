# Phase 1 — Package Skeleton, Prompts, Skills, and Agents

Status: planning artifact only. Do not implement until Zeb gives explicit approval to start implementation.

Package-family requirement: Before implementing this phase, read `package-split-details.md` and factor its modular package ownership, package-relative path convention, namespaced command/tool policy, and extension-coexistence rules into every task below.

## Phase goal

Create the reusable `pi-zflow` package-family structure and all non-runtime code assets that later phases depend on:

- workspace root and package manifests
- individually installable child package directories
- extension directories
- prompt templates
- skills
- custom agent definitions
- chain file placeholders
- install/update strategy for agents and chains

This phase defines the static shape of the harness. Later phases fill in behavior.

## Scope and phase dependencies

### Depends on

- Phase 0 foundation decisions

### Enables

- Phase 2 (`zflow-profiles`) implementation
- Phase 3 (`pi-runecontext`) implementation
- Phase 4 subagent/chains wiring
- Phase 6 review/swarm configuration
- Phase 7 workflow orchestration
- Phase 8 context-management skills and compaction integration

## Must-preserve decisions from the master plan

1. The package extends and orchestrates `pi-subagents`; it does not replace it.
2. Extension commands are the primary workflow UX.
3. Prompt templates are supplementary operator helpers and must not shadow extension command names.
4. Builtin `scout` and builtin `context-builder` should be reused via overrides where possible.
5. Custom agents use Pi native YAML frontmatter and runtime names under `package: zflow`.
6. Agent and chain files are not declared in the package manifest; they must be installed into Pi discovery locations.
7. Planner roles must never modify source code.
8. Report-style agents should return structured output; the orchestrator persists it.
9. `zflow_write_plan_artifact` is a narrow planner-only tool, not a general file writer.
10. Skills should be small and focused rather than one giant instruction file.
11. RuneContext support lives in its own extension plus focused skill.
12. The system prompt system is modular: compact root-orchestrator constitution, mode-specific fragments, role-specific agent prompts, runtime reminders, and deterministic enforcement.
13. Prompt fragments are package implementation assets, not user-facing slash-command prompt templates.
14. Agent prompts are narrow role contracts and should not inherit a giant generic instruction bundle.
15. `pi-zflow` must be modular: child packages are individually installable, and the umbrella package loads them together.
16. Default commands/tools are namespaced; short command aliases are opt-in only.
17. Default packages must not override built-in Pi tools, and reusable logic should be API-first via `pi-zflow-core`.

## Shared context for this phase

### Target package-family layout

Phase 1 creates the static skeleton for the modular `pi-zflow` package family. Read `package-split-details.md` before implementing this phase; that document is the source of truth for package ownership, package-relative paths, and install/filter behavior.

The repository should be a workspace with separately publishable packages:

```text
pi-zflow/
  package.json                            # workspace/dev scripts; may be private
  README.md
  pi-config-implementation-plan.md
  implementation-phases/
    package-split-details.md
  packages/
    pi-zflow-core/
      package.json
      src/
        index.ts
        registry.ts
        diagnostics.ts
        schemas.ts
        ids.ts
    pi-zflow-artifacts/
      package.json
      extensions/zflow-artifacts/index.ts
      src/
        artifact-paths.ts
        state-index.ts
        plan-state.ts
        run-state.ts
        cleanup-metadata.ts
        write-plan-artifact.ts
    pi-zflow-profiles/
      package.json
      extensions/zflow-profiles/index.ts
      extensions/zflow-profiles/profiles.ts
      extensions/zflow-profiles/model-resolution.ts
      extensions/zflow-profiles/health.ts
      config/profiles.example.json
    pi-zflow-plan-mode/
      package.json
      extensions/zflow-plan-mode/index.ts
      extensions/zflow-plan-mode/state.ts
      extensions/zflow-plan-mode/bash-policy.ts
    pi-zflow-agents/
      package.json
      extensions/zflow-agents/index.ts
      extensions/zflow-agents/install.ts
      extensions/zflow-agents/manifest.ts
      prompts/
        zflow-draft-change-prepare.md
        zflow-draft-change-capture-decisions.md
        zflow-draft-change-implement.md
        zflow-draft-change-audit.md
        zflow-draft-change-fix.md
        zflow-draft-review-pr.md
        zflow-docs-standards-audit.md
        zflow-standards-template.md
      prompt-fragments/
        root-orchestrator.md
        modes/plan-mode.md
        modes/change-prepare.md
        modes/change-implement.md
        modes/review-pr.md
        modes/zflow-clean.md
        reminders/tool-denied.md
        reminders/plan-mode-active.md
        reminders/approved-plan-loaded.md
        reminders/drift-detected.md
        reminders/compaction-handoff.md
        reminders/external-file-change.md
        reminders/verification-status.md
      skills/
        change-doc-workflow/SKILL.md
        runecontext-workflow/SKILL.md
        implementation-orchestration/SKILL.md
        multi-model-code-review/SKILL.md
        code-skeleton/SKILL.md
        plan-drift-protocol/SKILL.md
        repository-map/SKILL.md
      agents/
        planner-frontier.md
        plan-validator.md
        implement-routine.md
        implement-hard.md
        verifier.md
        plan-review-correctness.md
        plan-review-integration.md
        plan-review-feasibility.md
        review-correctness.md
        review-integration.md
        review-security.md
        review-logic.md
        review-system.md
        synthesizer.md
        repo-mapper.md
      chains/
        plan-and-implement.chain.md
        parallel-review.chain.md
        implement-and-review.chain.md
        scout-plan-validate.chain.md
    pi-zflow-review/
      package.json
      extensions/zflow-review/index.ts
      extensions/zflow-review/findings.ts
      extensions/zflow-review/pr.ts
      extensions/zflow-review/chunking.ts
    pi-zflow-change-workflows/
      package.json
      extensions/zflow-change-workflows/index.ts
      extensions/zflow-change-workflows/orchestration.ts
      extensions/zflow-change-workflows/apply-back.ts
      extensions/zflow-change-workflows/verification.ts
      extensions/zflow-change-workflows/plan-validator.ts
      extensions/zflow-change-workflows/path-guard.ts
      extensions/zflow-change-workflows/failure-log.ts
    pi-zflow-runecontext/
      package.json
      extensions/pi-runecontext/index.ts
      extensions/pi-runecontext/detect.ts
      extensions/pi-runecontext/resolve-change.ts
      extensions/pi-runecontext/runectx.ts
    pi-zflow-compaction/
      package.json
      extensions/zflow-compaction/index.ts
    pi-zflow/
      package.json                            # umbrella package manifest
```

### Package-relative path convention

Detailed tasks below may still list paths such as `extensions/zflow-profiles/index.ts` or `agents/planner-frontier.md`. Unless a path is explicitly rooted at `packages/<package-name>/`, treat it as relative to the owner package defined in `package-split-details.md`.

Examples:

- `extensions/zflow-profiles/index.ts` means `packages/pi-zflow-profiles/extensions/zflow-profiles/index.ts`.
- `extensions/zflow-change-workflows/orchestration.ts` means `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`.
- `agents/planner-frontier.md` means `packages/pi-zflow-agents/agents/planner-frontier.md`.
- `config/profiles.example.json` means `packages/pi-zflow-profiles/config/profiles.example.json`.

### Package manifest contract

The umbrella package manifest lives in `packages/pi-zflow/package.json` and bundles child packages:

```json
{
  "name": "pi-zflow",
  "keywords": ["pi-package", "pi-zflow"],
  "dependencies": {
    "pi-zflow-core": "<PIN>",
    "pi-zflow-artifacts": "<PIN>",
    "pi-zflow-profiles": "<PIN>",
    "pi-zflow-plan-mode": "<PIN>",
    "pi-zflow-agents": "<PIN>",
    "pi-zflow-review": "<PIN>",
    "pi-zflow-change-workflows": "<PIN>",
    "pi-zflow-runecontext": "<PIN>",
    "pi-zflow-compaction": "<PIN>"
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
    "skills": ["node_modules/pi-zflow-agents/skills"],
    "prompts": ["node_modules/pi-zflow-agents/prompts"]
  }
}
```

Each child package that owns Pi resources must also be directly installable with its own `pi` manifest. `pi-zflow-core` is the exception: it is a library-only package and must not register Pi resources.

Important: there is no native `agents` or `chains` manifest key, so those assets remain installed separately by `pi-zflow-agents`.

Important: `prompt-fragments/` is intentionally not included in any `pi.prompts` manifest. These files are consumed by extensions, agent prompts, and runtime reminder injection. They must not appear as slash-command prompt templates.

### Extension coexistence contract for this phase

- All public commands, custom tools, custom message types, status/widget keys, event names, and session custom entry types must be namespaced with `zflow`.
- Short command aliases are not created in Phase 1 and must remain opt-in if added later.
- Default packages must not override built-in Pi tools.
- Reusable code should go into package library exports and `pi-zflow-core`; extension entrypoints should be thin adapters.
- Every extension skeleton should plan for idempotent registration and duplicate-load detection through the shared registry.

### Agent frontmatter fields used throughout the harness

| Field                   | Meaning                                                   |
| ----------------------- | --------------------------------------------------------- |
| `name`                  | frontmatter name                                          |
| `package`               | set to `zflow` so runtime name becomes `zflow.<name>`     |
| `description`           | operator/discovery text                                   |
| `tools`                 | allowlisted tool set                                      |
| `model`                 | placeholder default; runtime lane resolution can override |
| `fallbackModels`        | provider/model fallback list                              |
| `thinking`              | `low`, `medium`, `high`                                   |
| `systemPromptMode`      | usually `replace` for strongly-scoped roles               |
| `inheritProjectContext` | whether to keep project guidance such as `AGENTS.md`      |
| `inheritSkills`         | keep false by default unless explicitly needed            |
| `skills`                | focused skill injection                                   |
| `maxSubagentDepth`      | prevent uncontrolled delegation                           |
| `maxOutput`             | cap token/output growth                                   |

### Agent installation method context

The package includes agent and chain source files, but the default operational path is user-level install/update:

- install agents into `~/.pi/agent/agents/zflow/`
- install chains into `~/.pi/agent/chains/zflow/`
- track install state in `~/.pi/agent/zflow/install-manifest.json`
- make setup idempotent
- if package version drifts, offer update instead of silently overwriting local edits

## Deliverables

By the end of this phase, the package family should at least contain:

- workspace `package.json`
- `packages/pi-zflow/package.json` umbrella manifest
- child package manifests for every owned module
- `packages/pi-zflow-core` shared library skeleton
- top-level `README.md`
- extension folder skeletons with placeholder `index.ts`
- prompt template markdown files under `pi-zflow-agents`
- non-command prompt-fragment markdown files for root/mode/reminder assembly under `pi-zflow-agents`
- skill directories with `SKILL.md` under `pi-zflow-agents`
- custom agent markdown files with frontmatter and system prompts under `pi-zflow-agents`
- chain markdown skeletons under `pi-zflow-agents`
- `config/profiles.example.json` under `pi-zflow-profiles`
- agent/chains install strategy documentation
- duplicate-registration/registry strategy documentation from `package-split-details.md`

## Tasks

---

### Task 1.1 — Create the workspace root, child packages, and Pi manifests

#### Objective

Create the static package-family skeleton so each capability can be installed individually and the umbrella `pi-zflow` package can load the full suite.

#### Files to create

- workspace root `package.json`
- top-level `README.md`
- `packages/pi-zflow/package.json` umbrella manifest
- `packages/pi-zflow-core/package.json`
- child package manifests for `pi-zflow-artifacts`, `pi-zflow-profiles`, `pi-zflow-plan-mode`, `pi-zflow-agents`, `pi-zflow-review`, `pi-zflow-change-workflows`, `pi-zflow-runecontext`, and `pi-zflow-compaction`

#### Implementation details

- The root workspace package may be private; the published full-suite package is `packages/pi-zflow` with npm name `pi-zflow`.
- The umbrella manifest must expose child package resources through `node_modules/<child-package>/...` paths and list child packages in both `dependencies` and `bundledDependencies`.
- Each child package with Pi resources must include a valid `pi` manifest so it is independently installable.
- `pi-zflow-core` is library-only and must not declare Pi resources.
- Do not add unsupported `agents`/`chains` manifest keys.
- `README.md` should document package-family purpose, install flow, package filtering, individual package install flow, and agent/chains installation behavior.

#### Example umbrella `package.json`

Use the umbrella manifest pattern from `package-split-details.md` and the Shared Context section above. Exact package versions/refs are placeholders until Phase 0 pinning is complete.

#### Acceptance criteria

- The workspace contains all child packages listed in `package-split-details.md`.
- The umbrella package can expose child package extensions/skills/prompts through its `pi` manifest.
- Each child package that owns Pi resources can be installed by itself.
- No unsupported manifest assumptions exist.

---

### Task 1.1A — Create `pi-zflow-core` shared API and registry skeleton

#### Objective

Create the API-first composition layer that lets `pi-zflow` child packages cooperate without relying on event-bus request/response patterns or duplicate implementation logic.

#### Files to create

- `packages/pi-zflow-core/src/index.ts`
- `packages/pi-zflow-core/src/registry.ts`
- `packages/pi-zflow-core/src/diagnostics.ts`
- `packages/pi-zflow-core/src/schemas.ts`
- `packages/pi-zflow-core/src/ids.ts`

#### Implementation details

- The registry must be backed by `globalThis` so duplicate physical installs of `pi-zflow-core` still share one capability map.
- Provide conceptual operations for `claim`, `provide`, `get`, `optional`, and diagnostics as described in `package-split-details.md`.
- Export only reusable types/helpers; do not register commands, tools, event handlers, or UI from `pi-zflow-core`.
- Include package/version constants and namespaced identifier helpers for commands, tools, message types, events, status keys, and session custom entry types.

#### Acceptance criteria

- Child packages can import a stable core API surface.
- Duplicate-load and incompatible-capability behavior is specified in code comments/TODOs before feature implementation.
- `pi-zflow-core` has no Pi manifest/resources and no import-time side effects beyond initializing the global registry object.

---

### Task 1.2 — Create extension skeleton directories and placeholder entrypoints

#### Objective

Lay down the extension structure that later phases will populate with real behavior.

#### Files to create

- `packages/pi-zflow-artifacts/extensions/zflow-artifacts/index.ts`
- `packages/pi-zflow-artifacts/src/artifact-paths.ts`
- `packages/pi-zflow-artifacts/src/state-index.ts`
- `packages/pi-zflow-artifacts/src/plan-state.ts`
- `packages/pi-zflow-artifacts/src/run-state.ts`
- `packages/pi-zflow-artifacts/src/cleanup-metadata.ts`
- `packages/pi-zflow-artifacts/src/write-plan-artifact.ts`
- `packages/pi-zflow-profiles/extensions/zflow-profiles/index.ts`
- `packages/pi-zflow-profiles/extensions/zflow-profiles/profiles.ts`
- `packages/pi-zflow-profiles/extensions/zflow-profiles/model-resolution.ts`
- `packages/pi-zflow-profiles/extensions/zflow-profiles/health.ts`
- `packages/pi-zflow-plan-mode/extensions/zflow-plan-mode/index.ts`
- `packages/pi-zflow-plan-mode/extensions/zflow-plan-mode/state.ts`
- `packages/pi-zflow-plan-mode/extensions/zflow-plan-mode/bash-policy.ts`
- `packages/pi-zflow-agents/extensions/zflow-agents/index.ts`
- `packages/pi-zflow-agents/extensions/zflow-agents/install.ts`
- `packages/pi-zflow-agents/extensions/zflow-agents/manifest.ts`
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/index.ts`
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/apply-back.ts`
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/verification.ts`
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/plan-validator.ts`
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/path-guard.ts`
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/failure-log.ts`
- `packages/pi-zflow-review/extensions/zflow-review/index.ts`
- `packages/pi-zflow-review/extensions/zflow-review/findings.ts`
- `packages/pi-zflow-review/extensions/zflow-review/pr.ts`
- `packages/pi-zflow-review/extensions/zflow-review/chunking.ts`
- `packages/pi-zflow-compaction/extensions/zflow-compaction/index.ts`
- `packages/pi-zflow-runecontext/extensions/pi-runecontext/index.ts`
- `packages/pi-zflow-runecontext/extensions/pi-runecontext/detect.ts`
- `packages/pi-zflow-runecontext/extensions/pi-runecontext/resolve-change.ts`
- `packages/pi-zflow-runecontext/extensions/pi-runecontext/runectx.ts`

#### Implementation details

- Each extension should export a minimal registration stub and TODO comments for later phases.
- Keep RuneContext code isolated in `packages/pi-zflow-runecontext/extensions/pi-runecontext/`.
- Shared utilities should start in `pi-zflow-core` or the owning child package library, not in ad-hoc cross-package imports.
- Each skeleton should include TODOs for registry claim/provide behavior and duplicate-load guards.

#### Example placeholder

```ts
export default function registerZflowProfilesExtension(pi) {
  // Implemented in Phase 2
}
```

#### Acceptance criteria

- All planned extensions have a concrete file location in their owning child package.
- The file layout matches the plan document and `package-split-details.md`.

---

### Task 1.3 — Create prompt templates with non-conflicting operator names

#### Objective

Provide supplementary prompt helpers without competing with extension commands.

#### Files to create

- `prompts/zflow-draft-change-prepare.md`
- `prompts/zflow-draft-change-capture-decisions.md`
- `prompts/zflow-draft-change-implement.md`
- `prompts/zflow-draft-change-audit.md`
- `prompts/zflow-draft-change-fix.md`
- `prompts/zflow-draft-review-pr.md`
- `prompts/zflow-docs-standards-audit.md`
- `prompts/zflow-standards-template.md`

#### Naming rule

- Extension commands keep canonical workflow names like `/zflow-change-prepare`.
- Prompt helpers must use names like `/zflow-draft-change-prepare` so there is no UX collision.

#### Template requirements

- each prompt should say when to use it
- each should explicitly state it is a helper, not the canonical automation flow
- `zflow-standards-template.md` should help the planner produce `standards.md`

#### Example header pattern

```markdown
# /zflow-draft-change-prepare

Use this helper to draft a plan request before the formal `/zflow-change-prepare <change-path>` workflow exists or when manually refining a change request.
```

#### Acceptance criteria

- No prompt name conflicts with planned extension command names.
- Each prompt has a clear use case.

---

### Task 1.3A — Create non-command prompt-fragment assets

#### Objective

Create the modular prompt system assets that later phases assemble into the active harness prompt without turning them into slash commands.

#### Files to create

- `prompt-fragments/root-orchestrator.md`
- `prompt-fragments/modes/plan-mode.md`
- `prompt-fragments/modes/change-prepare.md`
- `prompt-fragments/modes/change-implement.md`
- `prompt-fragments/modes/review-pr.md`
- `prompt-fragments/modes/zflow-clean.md`
- `prompt-fragments/reminders/tool-denied.md`
- `prompt-fragments/reminders/plan-mode-active.md`
- `prompt-fragments/reminders/approved-plan-loaded.md`
- `prompt-fragments/reminders/drift-detected.md`
- `prompt-fragments/reminders/compaction-handoff.md`
- `prompt-fragments/reminders/external-file-change.md`
- `prompt-fragments/reminders/verification-status.md`

#### Root-orchestrator requirements

The root prompt must be a compact constitution, not a full procedure manual. It is delivered via `APPEND_SYSTEM.md` (not `SYSTEM.md`) so Pi's default dynamic tool listings, guidelines, and documentation paths remain intact. It should cover:

- tool discipline: inspect codebase facts, prefer dedicated tools, respect denied tool calls
- truthfulness: distinguish done, verified, failed, skipped, blocked, unverified, and advisory
- safety: protect secrets/denied paths, do not overwrite user changes, confirm destructive or outward-facing actions
- workflow boundaries: formal changes use the artifact-first lifecycle; planning cannot mutate source; workers execute approved groups only
- context discipline: gather enough context to act, use subagents for broad/high-volume work, reread canonical artifacts after compaction
- engineering judgment: prefer existing patterns, keep scope tight, avoid speculative abstractions and compatibility shims
- communication: concise phase-change updates and final summaries with verification/residual risk
- platform documentation awareness: a brief invariant stating that when asked about Pi or pi-zflow internals, the model must read canonical documentation before implementing or advising. The exact paths and cross-references are injected dynamically by the harness extension (see Task 1.3B); the static fragment only states the invariant.

#### Mode-fragment requirements

- `/zflow-plan`: sticky read-only mode; source mutation forbidden until explicit exit; user requests to implement are treated as planning requests while active.
- `/zflow-change-prepare`: formal planning; explore repo facts before asking; ask only for high-impact preferences/tradeoffs; final plan must be decision-complete.
- `/zflow-change-implement`: execute only an approved immutable plan version; drift creates deviation reports and versioned replanning.
- `/zflow-review-pr`: external PR/MR review is diff-only; never execute untrusted PR code by default; findings must state verification limits.
- `/zflow-clean`: cleanup is state-driven, previewable, and tied to TTL/retained-artifact metadata.

#### Runtime-reminder requirements

Runtime reminders must be short, factual, and state-specific. They should mention authoritative file paths where relevant and must not become a second source of planning truth.

Required reminder purposes:

- tool denied: adjust approach and do not retry verbatim
- plan mode active: read-only exploration only
- approved plan loaded: use the approved plan version as the implementation contract
- drift detected: stop dependent execution and file deviation reports
- compaction handoff: reread canonical artifacts for exact decisions
- external file change: treat as user/linter work; do not revert unless asked
- verification status: release-gating vs advisory review status

#### Acceptance criteria

- Prompt fragments exist outside `prompts/` so Pi does not expose them as slash commands.
- Root/mode/reminder fragments are concise, non-overlapping, and explicitly designed for assembly by later phases.
- Safety-critical prompt rules identify the corresponding deterministic enforcement point where one exists or is planned.
- The root-orchestrator fragment includes the platform-documentation-awareness invariant (Decision 70 from the master plan).

---

### Task 1.3B — Implement dynamic platform-documentation injection via extension

#### Objective

Ensure Pi and pi-zflow self-documentation awareness is preserved and enhanced when the harness appends its root constitution to the default system prompt via `APPEND_SYSTEM.md`.

#### Background

Pi's default system prompt hardcodes absolute paths to its own installed documentation (`README.md`, `docs/`, `examples/`). Because the harness delivers its root constitution through `APPEND_SYSTEM.md` rather than `SYSTEM.md`, Pi's default dynamic tool listings, guidelines, and built-in documentation paths remain intact. The `before_agent_start` handler then appends pi-zflow-specific documentation paths on top of this preserved baseline, ensuring the model never hallucinates Pi or pi-zflow APIs.

#### Files to create

- `packages/pi-zflow-core/src/platform-docs.ts` (or equivalent in the most appropriate child package) — helper that builds the injected text.
- Extension code in the relevant `pi-zflow` extension (e.g., `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/index.ts` or a new lightweight extension) subscribing to `before_agent_start`.

#### Implementation details

- Import `getReadmePath()`, `getDocsPath()`, `getExamplesPath()` from `@earendil-works/pi-coding-agent` at runtime to resolve Pi's own documentation locations.
- Resolve pi-zflow documentation relative to the extension's `__dirname` or package root:
  - repo-level plan: `<repo-root>/pi-config-implementation-plan.md`
  - package split contract: `<repo-root>/implementation-phases/package-split-details.md`
  - agents: `packages/pi-zflow-agents/agents/`
  - prompt fragments: `packages/pi-zflow-agents/prompt-fragments/`
  - skills: `packages/pi-zflow-agents/skills/`
- Build a markdown section like:

  ```markdown
  ## Platform Documentation

  Pi documentation (read when asked about pi itself, its SDK, extensions, themes, skills, or TUI):

  - Main documentation: <absolute-path-to-README.md>
  - Additional docs: <absolute-path-to-docs/>
  - Examples: <absolute-path-to-examples/> (extensions, custom tools, SDK)
  - When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)

  Pi Zflow documentation (read when asked about zflow itself, its packages, agents, or workflows):

  - Implementation plan: <absolute-path>
  - Package split contract: <absolute-path>
  - Agent definitions: <absolute-path-to-agents/>
  - Prompt fragments: <absolute-path-to-prompt-fragments/>
  - Skills: <absolute-path-to-skills/>

  When working on pi or pi-zflow topics, read the docs and examples, and follow .md cross-references before implementing.
  ```

- Append this section in `before_agent_start` via the extension API.
- Guard against duplicate injection if multiple extensions run the same handler.
- Only inject when the active tool set includes `read`; if `read` is disabled, skip injection or emit a short advisory.

#### Acceptance criteria

- The injected documentation section is present in the effective system prompt when `APPEND_SYSTEM.md` is active.
- If a user later adds a `SYSTEM.md` that fully replaces the default prompt, the extension still backfills documentation paths via `before_agent_start`.
- Paths are accurate for the current install (global npm, local dev, or git clone).
- The extension does not crash if `@earendil-works/pi-coding-agent` exports change shape; graceful degradation (skip injection, log warning) is acceptable.
- Subagents spawned by the harness receive the same documentation awareness because they inherit the same system prompt assembly path.

---

### Task 1.4 — Create focused skills and define their responsibilities

#### Objective

Add small, reusable skill files instead of one monolithic instruction set.

#### Files to create

- `skills/change-doc-workflow/SKILL.md`
- `skills/runecontext-workflow/SKILL.md`
- `skills/implementation-orchestration/SKILL.md`
- `skills/multi-model-code-review/SKILL.md`
- `skills/code-skeleton/SKILL.md`
- `skills/plan-drift-protocol/SKILL.md`
- `skills/repository-map/SKILL.md`

#### Skill responsibilities

| Skill                          | Purpose                                                            |
| ------------------------------ | ------------------------------------------------------------------ |
| `change-doc-workflow`          | ad-hoc/non-RuneContext change docs, planning-artifact expectations |
| `runecontext-workflow`         | RuneContext flavors, canonical precedence, status handling         |
| `implementation-orchestration` | execution groups, task ownership, worker discipline                |
| `multi-model-code-review`      | reviewer roles, severity scheme, synthesis rules                   |
| `code-skeleton`                | compact module maps/signatures without full source                 |
| `plan-drift-protocol`          | deviation report structure and drift handling                      |
| `repository-map`               | repo map generation and usage                                      |

#### Implementation details

- Each skill should be readable in isolation.
- Any shared assumptions referenced by multiple tasks should be duplicated or explicitly referenced inside the same skill.
- Skills should be specific enough to inject directly into agents via frontmatter.

#### Acceptance criteria

- All listed skills exist.
- Skills have narrow, non-overlapping scopes.

---

### Task 1.5 — Create the agent file set using native Pi YAML frontmatter

#### Objective

Define every custom agent needed by the plan as a discoverable markdown file.

#### Files to create

- `agents/planner-frontier.md`
- `agents/plan-validator.md`
- `agents/implement-routine.md`
- `agents/implement-hard.md`
- `agents/verifier.md`
- `agents/plan-review-correctness.md`
- `agents/plan-review-integration.md`
- `agents/plan-review-feasibility.md`
- `agents/review-correctness.md`
- `agents/review-integration.md`
- `agents/review-security.md`
- `agents/review-logic.md`
- `agents/review-system.md`
- `agents/synthesizer.md`
- `agents/repo-mapper.md`

#### Frontmatter baseline example

```markdown
---
name: planner-frontier
package: zflow
description: Produce versioned planning artifacts for a requested change
tools: read, grep, find, ls, bash, zflow_write_plan_artifact
thinking: high
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
skills: change-doc-workflow, runecontext-workflow
maxSubagentDepth: 1
maxOutput: 12000
---
```

#### Implementation details

- Use `package: zflow` everywhere so runtime names resolve as `zflow.<name>`.
- Model IDs in frontmatter are placeholders; runtime profile resolution will override them.
- Set `inheritSkills: false` by default and add explicit focused skills.
- Use `maxSubagentDepth: 0` unless the role truly needs delegation.
- Treat each agent prompt as a narrow role contract; do not paste the full root prompt into every agent.

#### Acceptance criteria

- Every planned custom agent exists as a file.
- Frontmatter uses the agreed field set.

---

### Task 1.6 — Write complete system prompts for each agent role

#### Objective

Turn the role definitions from the main plan into concrete agent prompts that work as narrow role contracts inside the modular prompt system.

#### Agents requiring prompts

- `zflow.planner-frontier`
- `zflow.plan-validator`
- `zflow.implement-routine`
- `zflow.implement-hard`
- `zflow.verifier`
- all plan review agents
- all code review agents
- `zflow.synthesizer`
- `zflow.repo-mapper`

#### Must-preserve prompt rules

##### Planner

- writes plan artifacts only
- never edits source files
- includes exact file operations, dependencies, assigned agent, `reviewTags`, scoped verification, expected verification
- keeps groups to ≤7 files and ≤3 phases
- treats RuneContext docs as canonical when present

##### Implementers

- read tests before modifying source
- stop on infeasible plan and file a deviation report
- run planner-specified scoped verification
- use sanitized temporary worktree commits
- prefer `multi-edit` for multi-file groups

##### Reviewers

- read planning documents before reviewing diffs
- primary job is checking plan adherence
- use severity `critical|major|minor|nit`
- return structured markdown, not file writes

##### Synthesizer

- reason over actual reviewer set from the manifest
- de-duplicate findings
- record support/dissent and coverage notes

#### Acceptance criteria

- Prompt bodies reflect the master plan rules.
- No agent prompt contradicts cross-phase safety rules or mode fragments.
- Agent prompts do not duplicate the full root-orchestrator constitution; they assume the orchestrator/extension will inject relevant root/mode/reminder context.
- Safety-critical role rules point to deterministic enforcement where available, such as path guards, active-tool restrictions, or narrow custom tools.

---

### Task 1.7 — Define the planner-only `zflow_write_plan_artifact` tool contract in implementation docs

#### Objective

Capture the exact contract for the narrow custom planner write tool so later implementation does not become a path-escape hole.

#### Files to document in

- `README.md`
- agent prompt comments
- implementation target: `packages/pi-zflow-artifacts/src/artifact-paths.ts`, `packages/pi-zflow-artifacts/src/write-plan-artifact.ts`, and `packages/pi-zflow-artifacts/extensions/zflow-artifacts/index.ts`

#### Required contract

| Field         | Meaning                                                          |
| ------------- | ---------------------------------------------------------------- |
| `changeId`    | resolved safe change identifier                                  |
| `planVersion` | safe version label like `v1`                                     |
| `artifact`    | one of `design`, `execution-groups`, `standards`, `verification` |
| `content`     | markdown body                                                    |

#### Required safety rules

- destination path must normalize to `<runtime-state-dir>/plans/{changeId}/{planVersion}/{artifact}.md`
- reject separators, `..`, arbitrary filenames
- overwrite only approved artifact kinds
- atomic write (temp file + rename)
- record artifact hash/mtime in runtime metadata
- planner/replan roles only

#### Example pseudocode

```ts
function writePlanArtifact({ changeId, planVersion, artifact, content }) {
  assertSafeChangeId(changeId);
  assert(/^v\d+$/.test(planVersion));
  assert(
    ["design", "execution-groups", "standards", "verification"].includes(
      artifact,
    ),
  );
  const target = resolvePlanArtifactPath(changeId, planVersion, artifact);
  atomicWrite(target, content);
  recordArtifactMetadata(changeId, planVersion, artifact, hash(content));
}
```

#### Acceptance criteria

- Tool contract is fully specified before code implementation starts.

---

### Task 1.8 — Create chain file skeletons as internal building blocks

#### Objective

Create chain definitions that later phases will wire up, while preserving the rule that chains are not the primary user-facing workflow UX.

#### Files to create

- `chains/scout-plan-validate.chain.md`
- `chains/plan-and-implement.chain.md`
- `chains/parallel-review.chain.md`
- `chains/implement-and-review.chain.md`
- optionally `chains/plan-review-chain.chain.md` or equivalent if you want the plan-review swarm as a separate reusable chain file

#### Chain intent

| Chain                  | Purpose                                                                   |
| ---------------------- | ------------------------------------------------------------------------- |
| `scout-plan-validate`  | scout → planner → validator → conditional plan review                     |
| `plan-and-implement`   | end-to-end formal flow                                                    |
| `parallel-review`      | correctness + integration + security (+ optional reviewers) → synthesizer |
| `implement-and-review` | implementation → verifier → review                                        |

#### Implementation details

- Keep chains reusable internal building blocks.
- Do not present them as the main workflow instead of extension commands.

#### Acceptance criteria

- Chain files exist with documented intent and placeholders.

---

### Task 1.9 — Reuse builtin `scout` and `context-builder` via overrides instead of copying

#### Objective

Avoid unnecessary duplication while still customizing role behavior.

#### Files to create/update

- documentation in `README.md`
- later configuration target in profile bindings or subagent overrides

#### Implementation details

- Do not create custom `scout.md` or `context-builder.md` unless real evidence later proves the builtins are insufficient.
- Plan to override their system prompts/tool limits/bindings through configuration.

#### Example note

```markdown
Builtin `scout` and builtin `context-builder` are reused and overridden; they are not forked into `zflow.*` agents unless a later requirement forces it.
```

#### Acceptance criteria

- The default strategy clearly prefers overrides over forks.

---

### Task 1.10 — Create `config/profiles.example.json`

#### Objective

Add a checked-in logical profile example that later Phase 2 code can load.

#### File to create

- `packages/pi-zflow-profiles/config/profiles.example.json`

#### Required content

- `default` profile only for v1
- logical lanes only, not machine-specific resolved models
- sample `verificationCommand`
- `agentBindings` for all planned agents
- optional lanes marked optional

#### Acceptance criteria

- Example file mirrors the plan’s profile structure closely enough to serve as the starting implementation fixture.

---

### Task 1.11 — Design idempotent agent/chain installation and update flows

#### Objective

Specify how packaged agent and chain source files become discoverable by `pi-subagents`.

#### Planned commands

- `/zflow-setup-agents`
- `/zflow-update-agents`

#### Files/locations involved

- source: `packages/pi-zflow-agents/agents/`, `packages/pi-zflow-agents/chains/`
- install targets:
  - `~/.pi/agent/agents/zflow/`
  - `~/.pi/agent/chains/zflow/`
- manifest:
  - `~/.pi/agent/zflow/install-manifest.json`

#### Required install-manifest fields

```json
{
  "packageVersion": "<version>",
  "source": "<path-or-package-ref>",
  "installedAgents": ["planner-frontier.md"],
  "installedChains": ["parallel-review.chain.md"],
  "updatedAt": "<timestamp>"
}
```

#### Behavior rules

- setup is idempotent
- on version drift, offer update instead of silently overwriting local changes
- project-local install is opt-in only
- if generated assets are copied into a repo, gitignore them unless intentionally curated/shared

#### Acceptance criteria

- Install/update behavior is specified in enough detail for implementation.

---

### Task 1.12 — Add package-level documentation tying the asset set together

#### Objective

Make the package understandable to a future implementer without reopening the master plan each time.

#### Files to update

- `README.md`

#### README topics to include

- package-family purpose and architecture
- umbrella vs individual child package installation
- package filtering examples
- extension list and responsibilities
- prompt templates vs command naming rule
- prompt-fragment architecture and why fragments are not auto-discovered prompts
- **system prompt delivery: `APPEND_SYSTEM.md` vs `SYSTEM.md`** — explain that the root constitution is appended to preserve Pi's dynamic tool listings and guidelines, while `SYSTEM.md` replacement is reserved for narrowly scoped agent roles
- skill list and role
- agent list and runtime naming
- chain list and internal-building-block rule
- install/update method for agents and chains
- shared registry / duplicate-load behavior
- no default built-in tool override policy
- note that the planner is source-read-only

#### Acceptance criteria

- A developer can inspect `README.md` and understand the asset layout and intended runtime behavior.

## Phase exit checklist

- [x] Workspace and child package `package.json` files exist with correct `pi` manifest keys where applicable.
- [x] `pi-zflow-core` exists as a library-only package with no Pi resources.
- [x] Umbrella `packages/pi-zflow/package.json` exposes child resources through bundled dependencies.
- [x] All extension skeleton directories/files exist in their owning child packages.
- [x] Prompt templates exist and do not shadow command names.
- [x] Non-command prompt fragments exist for root/mode/reminder assembly and are outside `pi.prompts` discovery.
- [x] The root-orchestrator fragment includes the platform-documentation-awareness invariant (Decision 70).
- [x] A dynamic platform-documentation injection mechanism is designed (Task 1.3B) so Pi and pi-zflow documentation paths are preserved when using `APPEND_SYSTEM.md` and backfilled if a user later supplies a `SYSTEM.md` replacement.
- [x] Focused skills exist for each planned concern.
- [x] All custom agents exist as markdown files with YAML frontmatter.
- [x] Agent prompts reflect the rules from the master plan and remain narrow role contracts.
- [x] `zflow_write_plan_artifact` contract is documented.
- [x] Chain file skeletons exist.
- [x] Builtin `scout` and `context-builder` reuse strategy is documented.
- [x] `packages/pi-zflow-profiles/config/profiles.example.json` exists.
- [x] Agent/chain install-update flow is specified in `pi-zflow-agents` terms.
- [x] Registry/duplicate-load/coexistence expectations are documented.
- [x] `README.md` explains the package-family structure clearly.

Validation notes (2026-05-12): verified by auditing the current branch diff, running extension-shape tests, executing the platform-documentation injection handler, confirming required repo-level docs are present, and running a scripted checklist validation covering package manifests, extension files, prompts, prompt fragments, skills, agents, chains, config, and README documentation. Core workspace tests pass with 143 tests, 0 failures via `npm run test:all`.

## Handoff notes for later phases

- Phase 2 will implement `pi-zflow-profiles` and consume `packages/pi-zflow-profiles/config/profiles.example.json`.
- Phase 3 will implement `pi-zflow-runecontext` and rely on the separated directory structure established here.
- Phase 4 will wire the `pi-zflow-agents` agent set and chain set into working subagent configuration.
- Phase 6 will consume review agent definitions from `pi-zflow-agents` and review orchestration from `pi-zflow-review`.
- Phase 7 will implement workflow commands in `pi-zflow-change-workflows` and use `/zflow-setup-agents` from `pi-zflow-agents`.
- Phase 8 will fill in `pi-zflow-compaction` and use the `code-skeleton`/`repository-map` skills from `pi-zflow-agents`.
