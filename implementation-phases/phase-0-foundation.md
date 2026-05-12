# Phase 0 — Foundation

Status: implemented and smoke-tested in `pi-zflow` branch `phase/0_foundation` on 2026-05-12. See `/home/zeb/code/pi/pi-zflow/docs/phase-0-smoke-test-report.md` and `/home/zeb/code/pi/pi-zflow/docs/machine-preflight-report.md`.

Package-family requirement: Before implementing this phase, read `package-split-details.md` and factor its modular package ownership, package-relative path convention, namespaced command/tool policy, and extension-coexistence rules into every task below.

## Phase goal

Establish the non-negotiable runtime foundation for the Pi harness customization so every later phase builds on a tested, pinned, non-overlapping dependency stack.

This phase is not just "install some packages." It locks down:

- the exact dependency stack and minimum Pi version
- runtime state locations and cleanup policy
- the default `default` profile assumption
- package ownership boundaries so overlapping tools do not compete
- machine/tooling prerequisites (`rtk`, `gh`, `glab`, `runectx`)
- safety defaults for path guarding and worktree setup
- default user-level installation locations for agents/chains

If this phase is sloppy, every later phase becomes unstable.

## Scope and phase dependencies

### Depends on
- Nothing. This is the first implementation phase.

### Enables
- All later phases
- Lane resolution and profile activation in Phase 2
- RuneContext integration in Phase 3
- Parallel worktree execution in Phase 5
- Review and PR review in Phase 6
- Full orchestration in Phase 7
- Compaction and context management in Phase 8

## Must-preserve decisions from the master plan

These decisions must be treated as requirements while implementing this phase:

1. `pi-subagents` is the orchestration owner. Do not build a competing subagent runner.
2. `pi-rtk-optimizer` is the first-pass compaction/output optimization owner.
3. `pi-web-access` is the first-pass external research owner.
4. `pi-interview` is the first-pass human-in-the-loop owner.
5. `pi-zflow-profiles` / `zflow-profiles` will be the profile/model-routing owner.
6. `pi-zflow-plan-mode` / `zflow-plan-mode` will be the planning safety owner.
7. The first profile is named `default`.
8. Runtime state must live outside the working tree under `<runtime-state-dir> = <git-dir>/pi-zflow/`.
9. User-local activation state must live under `<user-state-dir> = ~/.pi/agent/zflow/`.
10. Do not install `pi-mono-review` in the first-pass foundation.
11. Do not install `pi-mono-ask-user-question` in the first-pass foundation.
12. If `pi-rewind-hook` is enabled, it must be the only rewind/checkpoint system enabled by default.
13. Exact tested version pins are required for foundation dependencies; use Pi `0.74.0` as the provisional minimum until Phase 0 smoke testing confirms or raises it.
14. The planner must never modify source code.
15. Worktree isolation will use `pi-subagents` native `worktree: true` support, not a custom implementation.
16. `pi-zflow` is a modular package family; foundation/version records must track child package pins as well as external dependencies.
17. Public `pi-zflow` commands/tools are namespaced by default, and short aliases are opt-in only.
18. Default `pi-zflow` packages must not override built-in Pi tools.

## Shared context needed by later phases

### Runtime state layout

Every later phase assumes this directory contract:

```text
<runtime-state-dir>/
  state-index.json
  repo-map.md
  reconnaissance.md
  failure-log.md
  review/
    code-review-findings.md
    pr-review-{id}.md
  plans/{change-id}/
    plan-state.json
    v{n}/
      design.md
      execution-groups.md
      standards.md
      verification.md
      plan-review-findings.md
    deviations/{plan-version}/
      ...deviation reports...
  runs/{run-id}/
    run.json
```

Rules to preserve:

- Runtime state must not dirty the repo working tree.
- Runtime files must not live inside portable `runecontext/` trees.
- Recovery must work from files/state, not transcript memory.

### User-level install locations

The plan assumes default installation of agents/chains at the user level:

```text
~/.pi/agent/agents/zflow/              # user-level agent files
~/.pi/agent/chains/zflow/              # user-level chain files
~/.pi/agent/zflow/install-manifest.json # installed asset manifest
~/.pi/agent/zflow/active-profile.json   # user-local active profile cache
```

Project-local `.pi/agents/` and `.pi/chains/` are opt-in only.

### pi-zflow package-family foundation

The first implementation pass should create/test the modular child package set described in `package-split-details.md`:

- `pi-zflow-core` — shared API/registry library
- `pi-zflow-artifacts` — runtime state/artifact helpers and `zflow_write_plan_artifact`
- `pi-zflow-profiles` — profile/lane resolution
- `pi-zflow-plan-mode` — ad-hoc read-only planning safety
- `pi-zflow-agents` — agents/chains/skills/prompts and setup/update commands
- `pi-zflow-review` — plan/code/PR review workflows
- `pi-zflow-change-workflows` — formal prepare/implement orchestration and cleanup
- `pi-zflow-runecontext` — RuneContext integration
- `pi-zflow-compaction` — compaction hooks
- `pi-zflow` — umbrella package that bundles and exposes the suite

Phase 0 version records must include exact pins/refs for both external foundation packages and internal child packages once they are publishable or locally referenced.

### Foundation dependency set

#### Required

```bash
pi install npm:pi-subagents@<PIN>
pi install npm:pi-rtk-optimizer@<PIN>
pi install npm:pi-intercom@<PIN>
```

#### Recommended first-pass set

```bash
pi install npm:pi-web-access@<PIN>
pi install npm:pi-interview@<PIN>
pi install npm:pi-mono-sentinel@<PIN>
pi install npm:pi-mono-context-guard@<PIN>
pi install npm:pi-mono-multi-edit@<PIN>
pi install npm:pi-mono-auto-fix@<PIN>
```

#### Optional/selective

```bash
pi install npm:@benvargas/pi-openai-verbosity@<PIN>
pi install npm:@benvargas/pi-synthetic-provider@<PIN>
pi install npm:pi-rewind-hook@<PIN>
```

### Machine prerequisite checks

The foundation phase must verify and record:

- `rtk` presence for command rewriting
- `gh` presence if `/zflow-review-pr` GitHub support is desired
- `glab` presence if `/zflow-review-pr` GitLab support is desired
- `gh auth status` and `glab auth status` if inline review comment submission is desired
- `runectx` presence if RuneContext integration is desired
- baseline model availability for the initial `default` profile

### Path safety baseline

Before later mutation-capable phases exist, decide the default mutation allowlist roots:

- resolved project/repo root
- active temp worktree roots
- approved plan-artifact runtime directories for `zflow_write_plan_artifact`

And the default denied targets:

- `.git/`
- `node_modules/`
- `.env*`
- obvious credential/secret files
- user-home dotfiles
- any symlink or `..` traversal escape

## Deliverables

Create or record the following foundation artifacts/configuration decisions:

- `implementation-phases/phase-0-foundation.md` (this plan doc)
- a dependency/version pin record location, likely one of:
  - `README.md` section
  - `docs/foundation-versions.md`
  - `package.json` with pinned dependencies once implementation starts
- a cleanup policy record, including default TTL and retained-failure duration
- a machine-preflight checklist document or bootstrap script target
- initial user-level agent/chain directory creation logic target
- a baseline profile fixture target: `packages/pi-zflow-profiles/config/profiles.example.json`
- a package-family/version pin record that includes every child package in `package-split-details.md`

## Tasks

---

### Task 0.1 — Record exact version policy and minimum Pi version

#### Objective
Create the source of truth for exact version pins and the minimum supported Pi version.

#### Files to create/update
- workspace `package.json` and child `packages/*/package.json` files (when package skeleton exists)
- `README.md`
- optionally `docs/foundation-versions.md`

#### Implementation details
- Do not leave first-pass automation on floating `latest`.
- Use Pi `0.74.0` as the provisional minimum for the first implementation pass.
- Record exact package versions or exact git refs after smoke testing the foundation stack.
- Confirm Pi `0.74.0` or raise the minimum Pi version based on a tested prototype.
- Record a minimum Pi version that has been tested with:
  - extension loading
  - chain discovery
  - `pi-subagents` runtime
  - session hooks needed by `pi-zflow-compaction` / `zflow-compaction`
  - active tool restrictions needed by `/zflow-plan`

#### Suggested content structure

```markdown
## Supported Pi version
- Provisional minimum before smoke test: 0.74.0
- Confirmed minimum after smoke test: <pi-version>

## Foundation package pins
- pi-subagents: <exact-version-or-git-ref>
- pi-rtk-optimizer: <exact-version-or-git-ref>
- pi-intercom: <exact-version-or-git-ref>
...

## pi-zflow child package pins / local refs
- pi-zflow-core: <exact-version-or-local-ref>
- pi-zflow-artifacts: <exact-version-or-local-ref>
- pi-zflow-profiles: <exact-version-or-local-ref>
- pi-zflow-plan-mode: <exact-version-or-local-ref>
- pi-zflow-agents: <exact-version-or-local-ref>
- pi-zflow-review: <exact-version-or-local-ref>
- pi-zflow-change-workflows: <exact-version-or-local-ref>
- pi-zflow-runecontext: <exact-version-or-local-ref>
- pi-zflow-compaction: <exact-version-or-local-ref>
- pi-zflow: <exact-version-or-local-ref>
```

#### Acceptance criteria
- Every foundation dependency has an exact version/ref.
- Pi `0.74.0` is recorded as the provisional minimum before testing.
- The confirmed minimum Pi version is documented after prototype smoke testing.
- No install automation uses `latest` for the core harness.

---

### Task 0.2 — Lock the first-pass package stack and overlap-avoidance policy

#### Objective
Make the single-owner package policy explicit in implementation artifacts so later work does not accidentally add overlapping packages.

#### Files to create/update
- `README.md`
- optionally `docs/architecture/package-ownership.md`

#### Required ownership mapping

- orchestration owner: `pi-subagents`
- compaction owner: `pi-rtk-optimizer` + `pi-zflow-compaction`
- research owner: `pi-web-access`
- HITL owner: `pi-interview`
- profile owner: `pi-zflow-profiles`
- planning safety owner: `pi-zflow-plan-mode`
- artifact/runtime owner: `pi-zflow-artifacts`
- recovery owner: runtime artifacts; optionally `pi-rewind-hook` if enabled

#### Explicit exclusions to document

- no `pi-mono-review` in v1 foundation
- no `pi-mono-ask-user-question`
- no competing orchestration owner (`pi-fork`, `pi-minimal-subagent`, `PiSwarm`, etc.)
- no `codemapper` stack as indexed-navigation foundation
- no default built-in Pi tool overrides in any `pi-zflow` child package
- no generic command aliases unless explicitly enabled by the user

#### Example doc snippet

```markdown
## Overlap avoidance
Do not add a second orchestration package. `pi-subagents` owns delegation, worktrees, and background runs.
```

#### Acceptance criteria
- Single-owner rules are written down in an implementation-facing artifact.
- Explicit deferrals/exclusions are documented.

---

### Task 0.3 — Install and verify required foundation packages

#### Objective
Install the first-pass required packages at the user level so they apply to the main harness and subagent subprocesses.

#### Files/locations involved
- `~/.pi/agent/extensions/` (installed package location managed by Pi)
- implementation notes in `README.md` or bootstrap docs

#### Installation commands

```bash
pi install npm:pi-subagents@<PIN>
pi install npm:pi-rtk-optimizer@<PIN>
pi install npm:pi-intercom@<PIN>
pi install npm:pi-web-access@<PIN>
pi install npm:pi-interview@<PIN>
pi install npm:pi-mono-sentinel@<PIN>
pi install npm:pi-mono-context-guard@<PIN>
pi install npm:pi-mono-multi-edit@<PIN>
pi install npm:pi-mono-auto-fix@<PIN>
```

#### Implementation details
- Install at user scope, not repo-local, unless a later repo-specific override is intentional.
- After install, validate each extension/package loads.
- Record failures in the bootstrap notes.

#### Acceptance criteria
- All required packages install cleanly.
- Install scope is user-level.
- Package load is verified.

---

### Task 0.4 — Add optional package policy and conditional installation rules

#### Objective
Document exactly when optional packages should be installed.

#### Optional packages and conditions
- `@benvargas/pi-openai-verbosity`: install/recommend when any active lane uses `openai-codex`
- `@benvargas/pi-synthetic-provider`: later cost/diversity optimization only
- `pi-rewind-hook`: optional recovery layer; if enabled, no other rewind/checkpoint package may be active by default

#### Pseudocode

```ts
if (profileUsesCodexLanes(activeProfile)) {
  recommendInstall("@benvargas/pi-openai-verbosity")
}

if (config.enableRewindHook) {
  assertNoOtherCheckpointPackagesEnabled()
  install("pi-rewind-hook")
}
```

#### Acceptance criteria
- Optional package criteria are explicit.
- Rewind exclusivity rule is documented.

---

### Task 0.5 — Implement machine prerequisite checks and bootstrap report design

#### Objective
Design the preflight checks that Phase 7 workflow commands will call before expensive operations.

#### Files to create later
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/bootstrap.ts` or equivalent
- `packages/pi-zflow-profiles/extensions/zflow-profiles/preflight.ts`
- optional `docs/bootstrap-checks.md`

#### Required checks

1. `rtk --version`
2. `gh --version` and `glab --version`
3. `gh auth status` / `glab auth status` when comment submission is requested
4. `runectx --version` or `runectx status` when RuneContext mode is requested
5. `pi --list-models` or model registry access for the `default` profile lanes

#### Example pseudocode

```ts
async function runBootstrapChecks(opts) {
  return {
    rtk: await checkBinary("rtk"),
    gh: await checkBinary("gh"),
    glab: await checkBinary("glab"),
    ghAuth: opts.needsGithubComments ? await checkGhAuth() : "not-required",
    glabAuth: opts.needsGitlabComments ? await checkGlabAuth() : "not-required",
    runectx: opts.needsRuneContext ? await checkBinary("runectx") : "not-required",
    modelRegistry: await validateDefaultProfileCandidates(),
  }
}
```

#### Behavior rules
- Missing `rtk` must alert the user but should not block output compaction.
- Missing `gh`/`glab` blocks relevant PR review submission flows, not the whole harness.
- Missing `runectx` blocks RuneContext-specific flows only.

#### Acceptance criteria
- Check list covers all required binaries/auth states.
- Failure handling is specific and actionable.

---

### Task 0.6 — Define runtime state paths and cleanup defaults

#### Objective
Create a shared runtime path resolver contract used by all later phases.

#### Files to create later
- `packages/pi-zflow-artifacts/src/artifact-paths.ts`
- optionally `packages/pi-zflow-core/src/runtime-paths.ts` if shared runtime-path helpers are needed beyond `pi-zflow-artifacts`

#### Path contract

```ts
function resolveRuntimeStateDir(repoRoot: string): string
function resolveUserStateDir(): string
function resolvePlanDir(changeId: string, version: string): string
function resolveRunDir(runId: string): string
```

#### Resolution rules
- primary runtime root: `<git-dir>/pi-zflow/`
- fallback outside git: temp dir + stable cwd hash
- user state root: `~/.pi/agent/zflow/`

#### Cleanup defaults
- default TTL for stale runtime/patch artifacts: `14 days`
- failed/interrupted worktree retention: `7 days` by default
- successful temp worktrees: remove immediately after verified apply-back unless an explicit `--keep`/debug option is used
- cleanup command naming: `/zflow-clean`
- `/zflow-clean` must support dry-run inspection before deletion

#### Example pseudocode

```ts
const DEFAULT_STALE_ARTIFACT_TTL_DAYS = 14
const DEFAULT_FAILED_WORKTREE_RETENTION_DAYS = 7

function resolveRuntimeStateDir(cwd: string) {
  if (inGitRepo(cwd)) return path.join(resolveGitDir(cwd), "pi-zflow")
  return path.join(os.tmpdir(), `pi-zflow-${stableHash(cwd)}`)
}
```

#### Acceptance criteria
- Path rules are fully documented.
- TTL/retention defaults are recorded as 14 days for stale runtime/patch artifacts and 7 days for failed/interrupted worktrees.

---

### Task 0.7 — Create default user-level directory bootstrap rules

#### Objective
Decide and document how the package will create user-level directories used by agents, chains, install manifests, and state.

#### Directories

```text
~/.pi/agent/agents/zflow/
~/.pi/agent/chains/zflow/
~/.pi/agent/zflow/
```

#### Implementation details
- Directory creation should be idempotent.
- Do not create project-local `.pi/agents/` or `.pi/chains/` unless the user explicitly requests shared repo-local assets.
- Prepare for later install-manifest files in `~/.pi/agent/zflow/`.

#### Example pseudocode

```ts
for (const dir of requiredDirs) {
  await fs.mkdir(dir, { recursive: true })
}
```

#### Acceptance criteria
- All default directories are documented.
- The user-level-vs-project-local rule is explicit.

---

### Task 0.8 — Validate initial `default` profile feasibility on the current machine

#### Objective
Before building the profile extension, prove that the proposed initial logical lanes can resolve to real models on the target machine.

#### Inputs
- the planned `default` profile lane preferences
- live model registry / `pi --list-models`

#### Required checks
- all required lanes can resolve
- optional reviewer lanes are identified as available/unavailable
- if Codex lanes are used, verbosity defaults are planned

#### Example output shape

```json
{
  "profile": "default",
  "resolvedLanes": {
    "planning-frontier": "github-copilot/gpt-5.4",
    "worker-cheap": "github-copilot/gpt-5.4-mini"
  },
  "optionalUnavailable": ["review-system"],
  "warnings": []
}
```

#### Acceptance criteria
- Required lanes are proven resolvable or Phase 0 blocks with clear action items.

---

### Task 0.9 — Decide `worktreeSetupHook` policy by target repo class

#### Objective
Identify whether target repos need worktree bootstrap/setup and define the fail-fast rule now.

#### Decision rules
- Ship generic `worktreeSetupHook` templates for common repo classes, but keep actual hook behavior per-repo configuration rather than package-baked logic.
- If a repo requires generated files, symlink hydration, env stub generation, or similar setup inside temp worktrees, it must declare `worktreeSetupHook`.
- If setup is required but no hook is configured, worker dispatch must fail immediately with actionable guidance and a pointer to the hook templates.
- Do not guess worktree setup behavior.

#### Example policy table

| Repo trait | Needs `worktreeSetupHook`? | Example |
|---|---:|---|
| plain TS/JS repo with checked-in deps metadata | usually no | simple library |
| monorepo with generated links/bootstrap | yes | workspace with generated package links |
| repo with env stub generation | yes | app requiring `.env.example` copy |

#### Acceptance criteria
- Fail-fast policy is documented.
- Generic hook templates/examples are documented, but no repo-specific hook is baked into the package.
- At least one example hook contract is described for later phases.

---

### Task 0.10 — Define baseline path-guard and sentinel policy inputs

#### Objective
Prepare the configuration contract that later safety/orchestration code will enforce.

#### Files to create later
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/path-guard.ts`
- `packages/pi-zflow-plan-mode/extensions/zflow-plan-mode/bash-policy.ts`
- maybe `config/sentinel-policy.json`

#### Policy requirements
- allowlist mutation roots only
- deny `.git`, `node_modules`, `.env*`, home dotfiles, secret-like files
- reject symlink escape and traversal
- distinguish planner-only artifact writes from implementation writes

#### Pseudocode

```ts
function canWrite(targetPath, context) {
  const real = realpathSafe(targetPath)
  if (!isWithinAllowedRoots(real, context.allowedRoots)) return false
  if (matchesBlockedPatterns(real)) return false
  return true
}
```

#### Acceptance criteria
- Inputs needed by the future path guard are defined.
- The allowlist-first model is documented.

## Resolved decisions to carry through implementation

These former open questions are now implementation requirements for Phase 0:

- Use Pi `0.74.0` as the provisional minimum for the first implementation pass; confirm or raise it only after prototype smoke testing.
- Record exact tested package versions or exact git refs for every foundation dependency before shipping automation.
- Use a 14-day TTL for stale runtime/patch artifacts and a 7-day default retention for failed/interrupted worktrees.
- Remove successful temp worktrees immediately after verified apply-back unless an explicit keep/debug option is used.
- Ship generic `worktreeSetupHook` templates, but keep actual hook behavior per-repo. Repos that need setup and lack a hook must fail fast.

## Phase exit checklist

Verified on 2026-05-12 against `/home/zeb/code/pi/pi-zflow` branch `phase/0_foundation`:

- `pi --version` returned `0.74.0`.
- `pi list` showed all 9 foundation packages installed with exact `@<pin>` sources, including `npm:pi-web-access@0.10.7`.
- `npm test` in `/home/zeb/code/pi/pi-zflow` passed 61 tests.
- Machine prerequisite status was recorded in `docs/machine-preflight-report.md`.
- Phase 0 smoke results were recorded in `docs/phase-0-smoke-test-report.md`.

Before Phase 0 is considered complete, verify all of the following:

- [x] Pi `0.74.0` provisional minimum is recorded and the confirmed minimum is documented after smoke testing.
- [x] Exact version pins/refs are chosen for the foundation stack after smoke testing.
- [x] Single-owner/overlap-avoidance rules are recorded.
- [x] Required packages are installed and verified.
- [x] Optional package policy is written down.
- [x] `rtk`, `gh`, `glab`, `runectx`, and model availability checks are designed.
- [x] Runtime-state and user-state directory contracts are defined.
- [x] Cleanup TTL and retained-failure duration are recorded as 14 days and 7 days respectively.
- [x] User-level agent/chain directory bootstrap is specified.
- [x] Initial `default` profile feasibility is tested or blocked with clear actions.
- [x] `worktreeSetupHook` fail-fast policy is documented.
- [x] Baseline path-guard inputs are defined.

## Handoff notes for later phases

- Phase 1 will consume the package layout, install locations, and ownership rules from this phase.
- Phase 2 depends on the validated `default` profile assumptions and model feasibility output.
- Phase 5 depends on the `worktreeSetupHook` policy and cleanup defaults.
- Phase 7 depends on the runtime path resolver and preflight checks defined here.
- Phase 8 depends on the `rtk` requirement and compaction ownership rule decided here.
