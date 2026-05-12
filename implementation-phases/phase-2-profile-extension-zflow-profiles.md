# Phase 2 — Profile Extension (`pi-zflow-profiles` / `zflow-profiles`)

Status: planning artifact only. Do not implement until Zeb gives explicit approval to start implementation.

Package-family requirement: Before implementing this phase, read `package-split-details.md` and factor its modular package ownership, package-relative path convention, namespaced command/tool policy, and extension-coexistence rules into every task below.

## Phase goal

Implement the `zflow-profiles` extension inside the individually installable `pi-zflow-profiles` package so the harness uses logical lanes first and resolves real provider/model IDs at runtime.

This phase replaces config-file rewriting as the default model-selection mechanism. The extension must:

- activate the first `default` profile
- resolve each logical lane to a real model on the current machine
- cache the resolved mapping in user-local state
- expose commands for inspection/refresh/sync
- run lane-health checks before expensive workflow phases
- enforce required-vs-optional lane behavior

The design goal is portability: shared logical profile definitions, machine-local resolved model mappings.

## Scope and phase dependencies

### Depends on
- Phase 0 foundation decisions, especially exact pins, model availability checks, and user-state paths
- Phase 1 package skeleton and `packages/pi-zflow-profiles/config/profiles.example.json`
- `pi-zflow-core` registry/service skeleton from Phase 1

### Enables
- Phase 4 agent binding and chain wiring
- Phase 6 reviewer lane selection and retry behavior
- Phase 7 workflow bootstrap via `Profile.ensureResolved()`

## Must-preserve decisions from the master plan

1. The first profile is named `default`.
2. Profiles use logical lanes first; concrete models are resolved at runtime.
3. Active profile state lives in `<user-state-dir>/active-profile.json` by default.
4. Shared logical profile definitions live in `.pi/zflow-profiles.json` or `~/.pi/agent/zflow-profiles.json` fallback.
5. Default activation must not rewrite tracked project files.
6. `/zflow-profile sync-project` is an explicit opt-in action for writing resolved overrides into `.pi/settings.json`.
7. Required lanes must fail activation/preflight if unresolved.
8. Optional lanes may be disabled with an explicit warning.
9. Before expensive phases, run lane-health checks.
10. On transient runtime lane failure, use agent `fallbackModels` first, then re-resolve the lane and retry once.
11. `worker-strong` must not silently degrade to `worker-cheap` without Zeb's explicit approval.
12. External extensions may read the user-local active profile cache; intra-package extensions can import a shared lookup module.
13. `pi-zflow-profiles` must be installable by itself and must expose profile services through `pi-zflow-core` registry interfaces for other `pi-zflow` packages.
14. The extension must tolerate duplicate loading via standalone + umbrella installs and no-op/warn according to `package-split-details.md`.

## Shared context needed inside this phase

### Profile file locations

- project-shared logical definitions: `.pi/zflow-profiles.json`
- global fallback logical definitions: `~/.pi/agent/zflow-profiles.json`
- user-local resolved active profile cache: `~/.pi/agent/zflow/active-profile.json`

### Command surface

```text
/zflow-profile
/zflow-profile default
/zflow-profile show
/zflow-profile lanes
/zflow-profile refresh
/zflow-profile sync-project
```

### Initial lane set to support

At minimum, Phase 2 must support the lanes already defined by the plan:

- `scout-cheap`
- `planning-frontier`
- `worker-cheap`
- `worker-strong`
- `review-correctness`
- `review-integration`
- `review-security`
- `review-logic` (optional)
- `review-system` (optional)
- `synthesis-frontier`

### Initial agent bindings to support

The profile schema must support bindings for:

- builtin `scout`
- `zflow.planner-frontier`
- `zflow.plan-validator`
- builtin `context-builder`
- `zflow.implement-routine`
- `zflow.implement-hard`
- `zflow.verifier`
- all review agents
- `zflow.synthesizer`
- `zflow.repo-mapper`

### Resolution algorithm requirements

For each lane:

1. Walk `preferredModels` in order.
2. Candidate is valid only if:
   - it exists in the runtime model registry
   - auth/config is present
   - capability requirements are satisfied
3. Clamp thinking level only when the downgrade is acceptable.
4. First valid candidate wins.
5. If no candidate resolves:
   - fail if required
   - disable and warn if optional

### Cache invalidation triggers

Re-resolve when any of these occurs:

- profile definition changes
- registry/provider config changes
- auth availability changes
- cache TTL expires
- `/zflow-profile refresh`
- runtime lane health check fails

## Deliverables

- functioning `pi-zflow-profiles` / `zflow-profiles` extension
- profile loader and validator
- lane resolution engine
- active-profile cache writer/reader
- command handlers for the `/zflow-profile` command family
- lane-health preflight helpers for other extensions
- optional `.pi/settings.json` sync writer
- visible active-profile status/footer integration

## Tasks

---

### Task 2.1 — Define the profile schema and validation layer

#### Objective
Create the TypeScript types and runtime validation for logical profile definitions.

#### Files to create/update
- `packages/pi-zflow-profiles/extensions/zflow-profiles/profiles.ts`
- `config/profiles.example.json`
- optional `packages/pi-zflow-profiles/extensions/zflow-profiles/schema.ts`

#### Required schema shape

```ts
interface LaneDefinition {
  required?: boolean
  optional?: boolean
  thinking?: "low" | "medium" | "high"
  preferredModels: string[]
}

interface AgentBinding {
  lane: string
  optional?: boolean
  tools?: string
  maxOutput?: number
  maxSubagentDepth?: number
}

interface ProfileDefinition {
  description?: string
  verificationCommand?: string
  lanes: Record<string, LaneDefinition>
  agentBindings: Record<string, AgentBinding>
}

interface ProfilesFile {
  [profileName: string]: ProfileDefinition
}
```

#### Validation rules
- require `default` profile in the initial implementation
- every binding lane must exist in `lanes`
- every lane must have a non-empty `preferredModels` list
- forbid both `required` and `optional` if they conflict semantically
- normalize omitted `required`/`optional` flags into a consistent internal form

#### Example pseudocode

```ts
function validateProfilesFile(data: unknown): ProfilesFile {
  const parsed = parseJson(data)
  assert(parsed.default, "Missing default profile")
  for (const [name, profile] of Object.entries(parsed)) {
    for (const [laneName, lane] of Object.entries(profile.lanes)) {
      assert(Array.isArray(lane.preferredModels) && lane.preferredModels.length > 0)
    }
    for (const [agentName, binding] of Object.entries(profile.agentBindings)) {
      assert(profile.lanes[binding.lane], `Agent ${agentName} references unknown lane ${binding.lane}`)
    }
  }
  return parsed as ProfilesFile
}
```

#### Acceptance criteria
- Invalid profile files fail with actionable messages.
- The example config validates cleanly.

---

### Task 2.2 — Implement profile file loading with project-local override and user fallback

#### Objective
Resolve where logical profile definitions come from.

#### Files to create/update
- `packages/pi-zflow-profiles/extensions/zflow-profiles/profiles.ts`
- `packages/pi-zflow-profiles/extensions/zflow-profiles/index.ts`

#### Resolution order
1. `.pi/zflow-profiles.json` in the active repo
2. `~/.pi/agent/zflow-profiles.json` as fallback

#### Behavior rules
- Use repo-local shared definitions when present.
- Fall back cleanly to the user-level file when repo-local does not exist.
- Surface the chosen source path in `/zflow-profile show` output.

#### Example pseudocode

```ts
async function loadProfiles(repoRoot?: string) {
  const projectPath = repoRoot ? path.join(repoRoot, ".pi", "zflow-profiles.json") : null
  const userPath = path.join(os.homedir(), ".pi/agent/zflow-profiles.json")

  const source = await exists(projectPath) ? projectPath : userPath
  const raw = await fs.readFile(source, "utf8")
  return { source, profiles: validateProfilesFile(JSON.parse(raw)) }
}
```

#### Acceptance criteria
- Loader chooses the correct file deterministically.
- Missing project file does not break fallback.

---

### Task 2.3 — Build the lane resolution engine

#### Objective
Turn logical lane definitions into concrete machine-usable model bindings.

#### Files to create/update
- `packages/pi-zflow-profiles/extensions/zflow-profiles/profiles.ts`
- optional `packages/pi-zflow-profiles/extensions/zflow-profiles/model-resolution.ts`

#### Required inputs
- validated logical profile definition
- runtime model registry / `pi --list-models`
- auth/config availability signals
- capability requirements by lane and/or agent binding

#### Required outputs

```ts
interface ResolvedLane {
  lane: string
  model: string | null
  required: boolean
  optional: boolean
  thinking?: "low" | "medium" | "high"
  status: "resolved" | "disabled-optional" | "unresolved-required"
  reason?: string
}
```

#### Core resolution algorithm

```ts
for (const candidate of lane.preferredModels) {
  if (!modelExists(candidate)) continue
  if (!authAvailable(candidate)) continue
  if (!capabilitiesCompatible(candidate, laneNeeds)) continue
  if (!thinkingCompatible(candidate, lane.thinking)) {
    if (!acceptableThinkingClamp(candidate, lane.thinking)) continue
  }
  return resolved(candidate)
}
```

#### Important rules
- first valid candidate wins
- required unresolved lanes fail activation
- optional unresolved lanes are disabled and recorded
- do not silently change lane class (`worker-strong` → `worker-cheap` is not allowed)

#### Acceptance criteria
- Required and optional lane behavior matches the plan.
- Resolution result clearly records reasons for failures/skips.

---

### Task 2.4 — Define capability and thinking compatibility checks

#### Objective
Avoid selecting technically incompatible models just because the model name exists.

#### Files to create/update
- `packages/pi-zflow-profiles/extensions/zflow-profiles/profiles.ts`
- optional `packages/pi-zflow-profiles/extensions/zflow-profiles/capabilities.ts`

#### Compatibility dimensions to evaluate
- tool use support
- text input/output support
- reasoning/thinking support or acceptable fallback behavior
- context/output constraints relevant to the role

#### Policy details
- If the lane requests a thinking level and the selected model cannot satisfy it, clamp only when the downgrade is acceptable.
- Be conservative for `planning-frontier`, `worker-strong`, `review-security`, and `synthesis-frontier`.
- Do not accept a candidate just because it is cheap if it cannot perform the lane’s job.

#### Example pseudocode

```ts
function isLaneCandidateValid(candidate, lane, agentBinding) {
  return (
    candidate.supportsTools &&
    candidate.supportsText &&
    thinkingAllowed(candidate, lane.thinking) &&
    outputWindowSufficient(candidate, agentBinding.maxOutput)
  )
}
```

#### Acceptance criteria
- Resolution logic checks more than model-name existence.

---

### Task 2.5 — Implement active profile activation and user-local cache writing

#### Objective
Persist resolved profile state in a machine-local cache used by workflow entrypoints.

#### Files to create/update
- `packages/pi-zflow-profiles/extensions/zflow-profiles/index.ts`
- `packages/pi-zflow-profiles/extensions/zflow-profiles/profiles.ts`

#### Cache location
- `~/.pi/agent/zflow/active-profile.json`

#### Required cache contents

```json
{
  "profileName": "default",
  "sourcePath": ".pi/zflow-profiles.json",
  "resolvedAt": "2026-05-11T00:00:00Z",
  "ttlMinutes": 15,
  "definitionHash": "...",
  "environmentFingerprint": "...",
  "resolvedLanes": {
    "planning-frontier": {
      "model": "github-copilot/gpt-5.4",
      "thinking": "high",
      "status": "resolved"
    },
    "review-system": {
      "model": null,
      "status": "disabled-optional",
      "reason": "no matching authenticated model"
    }
  },
  "agentBindings": {
    "zflow.planner-frontier": {
      "lane": "planning-frontier",
      "resolvedModel": "github-copilot/gpt-5.4",
      "tools": "read, grep, find, ls, bash, zflow_write_plan_artifact",
      "maxOutput": 12000,
      "maxSubagentDepth": 1
    }
  }
}
```

#### Behavior rules
- cache write must be atomic
- include invalidation metadata
- expose enough information for debugging lane resolution and for cross-extension reads

#### Acceptance criteria
- Activation writes a complete cache file.
- Optional-disabled lanes are recorded explicitly.

---

### Task 2.6 — Implement `Profile.ensureResolved()` for other workflows

#### Objective
Provide the shared bootstrap entrypoint every expensive workflow uses before running.

#### Files to create/update
- `packages/pi-zflow-profiles/extensions/zflow-profiles/index.ts`
- maybe `packages/pi-zflow-profiles/extensions/zflow-profiles/api.ts`

#### Behavior
`Profile.ensureResolved()` should:

1. read the current cache if present
2. determine whether the cache is still fresh and valid
3. re-resolve if stale/invalid/missing
4. run lane-health checks for the lanes needed by the caller
5. return a resolved profile object suitable for launch-time overrides

#### Example pseudocode

```ts
async function ensureResolved(requiredLanes?: string[]) {
  const cache = await readActiveProfileCacheIfFresh()
  const active = cache ?? await activateProfile("default")
  await preflightLaneHealth(active, requiredLanes)
  return active
}
```

#### Acceptance criteria
- Later phases can call a single bootstrap function instead of duplicating resolution logic.

---

### Task 2.7 — Implement cache invalidation logic and environment fingerprinting

#### Objective
Ensure `active-profile.json` is treated as a convenience cache, not permanent truth.

#### Files to create/update
- `packages/pi-zflow-profiles/extensions/zflow-profiles/profiles.ts`

#### Invalidation inputs to record
- profile definition hash
- provider/model registry fingerprint
- relevant auth fingerprint
- `resolvedAt` timestamp / TTL

#### Events that must trigger invalidation
- profile file changed
- registry/provider config changed
- auth state changed
- TTL expiry
- `/zflow-profile refresh`
- runtime lane-health failure

#### Example pseudocode

```ts
function isCacheValid(cache, currentEnv) {
  if (Date.now() > cache.expiresAt) return false
  if (cache.definitionHash !== currentEnv.definitionHash) return false
  if (cache.environmentFingerprint !== currentEnv.environmentFingerprint) return false
  return true
}
```

#### Acceptance criteria
- Cache invalidates on all required events.
- Stale lane mappings cannot linger indefinitely.

---

### Task 2.8 — Build lane-health preflight and runtime failure handling

#### Objective
Make expensive phases robust to real-world provider instability.

#### Files to create/update
- `packages/pi-zflow-profiles/extensions/zflow-profiles/profiles.ts`
- maybe `packages/pi-zflow-profiles/extensions/zflow-profiles/health.ts`

#### Health preflight should run before
- plan review
- worker dispatch
- final code review
- synthesis

#### Runtime failure policy to implement
1. agent tries its own `fallbackModels` first
2. if still unhealthy, re-resolve lane to next preferred candidate and retry once
3. if required lane still unavailable, stop and ask Zeb
4. if optional reviewer lane still unavailable, skip, record in manifest, continue
5. never silently degrade `worker-strong` to `worker-cheap`

#### Example pseudocode

```ts
async function handleLaneFailure(agentName, laneName, error) {
  if (await agentFallbackSucceeded(agentName)) return "recovered-via-agent-fallback"
  const rerouted = await reresolveLane(laneName)
  if (rerouted) return "recovered-via-reresolution"
  if (isOptionalLane(laneName)) return "skip-optional-reviewer"
  throw new Error(`Required lane failed: ${laneName}`)
}
```

#### Acceptance criteria
- Runtime lane failure behavior is deterministic and visible.

---

### Task 2.9 — Implement the `/zflow-profile` command family

#### Objective
Expose profile lifecycle and diagnostics to the user.

#### Files to create/update
- `packages/pi-zflow-profiles/extensions/zflow-profiles/index.ts`

#### Commands and behaviors

##### `/zflow-profile`
- show active profile summary
- if no active profile, suggest `/zflow-profile default`

##### `/zflow-profile default`
- activate the `default` profile
- resolve lanes
- write cache
- update footer/status

##### `/zflow-profile show`
- display source file, resolved lane mapping, disabled optional lanes, timestamps, invalidation info

##### `/zflow-profile lanes`
- show lane definitions and resolution status

##### `/zflow-profile refresh`
- force re-resolution regardless of cache freshness

##### `/zflow-profile sync-project`
- explicitly write resolved overrides into `.pi/settings.json`
- must be opt-in and clearly indicate it mutates project config

#### Example output

```text
Active profile: default
Source: .pi/zflow-profiles.json
Resolved lanes:
- planning-frontier -> github-copilot/gpt-5.4 (high)
- worker-strong -> github-copilot/gpt-5.3-codex (high)
Optional disabled:
- review-system (no matching authenticated model)
```

#### Acceptance criteria
- All six commands exist and match the plan behavior.

---

### Task 2.10 — Implement `.pi/settings.json` sync as an explicit, narrow operation

#### Objective
Allow project-level resolved agent overrides when explicitly requested, without making that the default activation path.

#### Files to create/update
- `packages/pi-zflow-profiles/extensions/zflow-profiles/index.ts`

#### Behavior rules
- only run on `/zflow-profile sync-project`
- write a `subagents.agentOverrides` block based on the currently resolved active profile
- do not silently overwrite unrelated settings
- present a diff/summary before writing if possible

#### Example output shape

```json
{
  "subagents": {
    "agentOverrides": {
      "zflow.planner-frontier": {
        "model": "github-copilot/gpt-5.4",
        "tools": "read, grep, find, ls, bash, zflow_write_plan_artifact",
        "maxOutput": 12000
      }
    }
  }
}
```

#### Acceptance criteria
- Normal activation leaves project settings untouched.
- Sync-project performs only the documented explicit write.

---

### Task 2.11 — Expose shared lane lookup to sibling packages

#### Objective
Allow `pi-zflow-change-workflows`, `pi-zflow-review`, and other package extensions to consume resolved lane info without reparsing profile files.

#### Files to create/update
- `packages/pi-zflow-profiles/extensions/zflow-profiles/index.ts`
- maybe `packages/pi-zflow-profiles/src/api.ts`
- `packages/pi-zflow-core/src/registry.ts` service types if needed

#### Interface requirements
- service registered through `pi-zflow-core` registry for sibling package use
- direct library helper for package imports where appropriate
- file-backed fallback through `active-profile.json` for external readers

#### Example API

```ts
export async function getResolvedAgentBinding(agentName: string): Promise<ResolvedAgentBinding>
export async function ensureResolved(requiredLanes?: string[]): Promise<ResolvedProfile>
```

#### Acceptance criteria
- Later extensions do not need to parse profile files manually.

---

### Task 2.12 — Add Pi footer/status integration for the active profile

#### Objective
Make the active profile visible in normal workflow UX.

#### Files to create/update
- `packages/pi-zflow-profiles/extensions/zflow-profiles/index.ts`

#### Behavior rules
- show active profile name after activation
- optionally include a quick health indicator if a required lane is degraded
- keep the UI concise

#### Example footer labels

```text
Profile: default
Profile: default (1 optional lane disabled)
```

#### Acceptance criteria
- Active profile visibility works without opening `/zflow-profile show` every time.

---

### Task 2.13 — Add tests/fixtures for profile resolution edge cases

#### Objective
Make later workflow phases safe by testing the lane-resolution contract now.

#### Files to create later
- `packages/pi-zflow-profiles/test/*.test.ts` or equivalent
- `test/fixtures/profiles/*.json`

#### Cases to cover
- missing `default`
- binding references unknown lane
- required lane unresolved
- optional lane unresolved
- profile source precedence (project over user fallback)
- cache invalidation on definition hash change
- cache invalidation on TTL expiry
- `worker-strong` not silently downgraded
- sync-project writes only on explicit command

#### Acceptance criteria
- The critical behavior rules are covered by automated tests or explicit test procedures.

## Phase exit checklist

- [ ] Profile schema and validation are implemented.
- [ ] Project-local vs user fallback loading works.
- [ ] Lane resolution algorithm is implemented with capability checks.
- [ ] `active-profile.json` is written atomically in user-local state.
- [ ] `Profile.ensureResolved()` exists for reuse by later phases.
- [ ] Cache invalidation rules are implemented.
- [ ] Lane-health preflight and retry logic are implemented.
- [ ] `/zflow-profile` command family exists.
- [ ] `.pi/settings.json` sync is explicit opt-in only.
- [ ] Shared lane lookup is exposed to sibling extensions.
- [ ] Active profile appears in the footer/status UI.
- [ ] Edge-case tests/fixtures are planned or implemented.

## Handoff notes for later phases

- Phase 4 should consume the resolved `agentBindings` to configure actual subagent launches.
- Phase 6 must use optional-vs-required reviewer lane status in the reviewer manifest.
- Phase 7 must call `Profile.ensureResolved()` before planning, implementation, review, and synthesis phases.
- If OpenAI Codex lanes resolve in practice, Phase 0’s optional `pi-openai-verbosity` recommendation becomes operational here.
