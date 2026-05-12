# Phase 3 — RuneContext Integration (`pi-zflow-runecontext` / `pi-runecontext`)

Status: planning artifact only. Do not implement until Zeb gives explicit approval to start implementation.

Package-family requirement: Before implementing this phase, read `package-split-details.md` and factor its modular package ownership, package-relative path convention, namespaced command/tool policy, and extension-coexistence rules into every task below.

## Phase goal

Implement the `pi-runecontext` extension inside the individually installable `pi-zflow-runecontext` package so the harness can detect RuneContext-managed repos, resolve the active change, read canonical change documents correctly, and keep orchestration artifacts separate from RuneContext’s portable source-of-truth tree.

This phase is about respecting canonical requirements, not inventing a second planning system.

## Scope and phase dependencies

### Depends on
- Phase 0 prerequisite decisions including `runectx` availability checks and runtime-state placement
- Phase 1 package skeleton and dedicated RuneContext extension/skill structure
- `pi-zflow-core` registry/service skeleton
- `pi-zflow-artifacts` path helpers for runtime artifact separation

### Enables
- Phase 7 formal `/zflow-change-prepare` and `/zflow-change-implement` flows in RuneContext repos
- Phase 6 plan review and code review against canonical RuneContext docs
- Correct derivation of `execution-groups.md` in RuneContext mode

## Must-preserve decisions from the master plan

1. RuneContext support lives in its own extension plus focused skill.
2. When RuneContext is present, RuneContext docs are canonical.
3. The harness must understand both RuneContext flavors: `plain` and `verified`.
4. `status.yaml` must always be read.
5. `standards.md` must always be read before implementation or review.
6. If `tasks.md` exists, use it for task grouping and verification; otherwise derive tasks from the other docs.
7. In RuneContext mode, `execution-groups.md` is derived, not canonical.
8. Runtime/orchestration artifacts must never be written into the portable `runecontext/` tree.
9. If an approved amendment changes canonical requirements, write back through `pi-runecontext` before regenerating derived artifacts.
10. Status mapping from harness workflow states to `status.yaml` must be conservative; when ambiguous, keep rich state in runtime metadata instead of overwriting canonical status.
11. `pi-zflow-runecontext` must be usable as an optional standalone package and expose its detection/resolution service through the shared registry.
12. Generic workflow code must call the RuneContext service instead of embedding RuneContext parsing directly.

## Shared context needed inside this phase

### RuneContext flavors to support

#### Plain flavor

```text
CHANGE_IN_QUESTION/
  proposal.md
  design.md
  standards.md
  verification.md
  status.yaml
```

#### Verified flavor

```text
CHANGE_IN_QUESTION/
  proposal.md
  design.md
  standards.md
  references.md
  tasks.md
  verification.md
  status.yaml
```

### Canonical precedence in RuneContext mode

1. RuneContext change docs:
   - `proposal.md`
   - `design.md`
   - `standards.md`
   - `verification.md`
   - `tasks.md` if present
   - `references.md` if present
   - `status.yaml`
2. Versioned plan artifacts under `<runtime-state-dir>/plans/{change-id}/v{n}/`
3. Derived orchestration aids such as `execution-groups.md`, widgets, runtime status displays

### Runtime artifacts that remain outside RuneContext

- plan versions under `<runtime-state-dir>/plans/...`
- `execution-groups.md` derivative output
- deviation reports
- `plan-state.json`
- `run.json`
- review findings
- repo map and reconnaissance

### Status mapping policy to preserve

| Harness state | RuneContext write-back policy |
|---|---|
| `draft`, `validated`, `reviewed` | runtime-only by default |
| `approved` | automatically offer a `pi-interview` write-back preview, then write only after explicit approval and only if the project schema clearly supports it |
| `executing`, `drifted`, `superseded` | runtime-only |
| `completed` | automatically offer a `pi-interview` write-back preview, then write only after explicit approval and only if the project schema clearly supports it |
| `cancelled` | runtime-only unless clear schema equivalent exists |

If the status vocabulary is ambiguous, preserve `status.yaml` and store richer state only in runtime metadata. Never silently mutate RuneContext docs. Future config may expose `off | prompt | auto`, but the default is `prompt`.

## Deliverables

- RuneContext repo detection helper
- change-resolution helper for active/current change folder
- canonical document reader for both flavors
- precedence and derivation logic for `execution-groups.md`
- conservative status-mapping helper
- canonical-doc write-back path for approved amendments when needed
- clear contract between `pi-runecontext` and `zflow-change-workflows`

## Tasks

---

### Task 3.1 — Implement RuneContext repo detection

#### Objective
Detect whether the current repo/workspace should be treated as RuneContext-managed.

#### Files to create/update
- `packages/pi-zflow-runecontext/extensions/pi-runecontext/detect.ts`
- `packages/pi-zflow-runecontext/extensions/pi-runecontext/index.ts`

#### Detection sources
- presence of `runecontext.yaml`
- successful `runectx status`
- optionally other explicit RuneContext markers agreed by the project

#### Example pseudocode

```ts
async function detectRuneContext(repoRoot: string) {
  if (await exists(path.join(repoRoot, "runecontext.yaml"))) return { enabled: true, source: "runecontext.yaml" }
  const status = await tryRun("runectx status", { cwd: repoRoot })
  if (status.ok) return { enabled: true, source: "runectx status" }
  return { enabled: false }
}
```

#### Behavior rules
- Missing `runectx` should not break non-RuneContext repos.
- Detection result should explain why RuneContext mode is or is not active.

#### Acceptance criteria
- Detection works without false-positive dependence on a single marker.

---

### Task 3.2 — Resolve the active change path and change identifier

#### Objective
Given user input or ambient repo context, resolve which RuneContext change folder is canonical.

#### Files to create/update
- `packages/pi-zflow-runecontext/extensions/pi-runecontext/resolve-change.ts`
- `packages/pi-zflow-runecontext/extensions/pi-runecontext/index.ts`

#### Inputs to support
- explicit `/zflow-change-prepare <change-path>` or `/zflow-change-implement <change-path>` path
- active current working directory inside a change folder
- optional `runectx` helper output if available

#### Output contract

```ts
interface ResolvedRuneChange {
  changeId: string
  changePath: string
  flavor: "plain" | "verified"
  files: {
    proposal: string
    design: string
    standards: string
    verification: string
    status: string
    tasks?: string
    references?: string
  }
}
```

#### Important rules
- `changeId` should include enough workspace/package context to avoid monorepo collisions.
- Validate required files for the detected flavor.

#### Acceptance criteria
- Explicit and implicit change resolution both work.
- The resulting `changeId` is safe to use in runtime-state paths.

---

### Task 3.3 — Implement canonical-doc reader for both RuneContext flavors

#### Objective
Load the correct set of canonical docs for planning, implementation, and review.

#### Files to create/update
- `packages/pi-zflow-runecontext/extensions/pi-runecontext/resolve-change.ts`
- `skills/runecontext-workflow/SKILL.md`

#### Reading rules
- always read `status.yaml`
- always read `standards.md`
- if `tasks.md` exists, use it directly for task grouping/verification
- if `tasks.md` does not exist, derive task group hints from `proposal.md + design.md + verification.md`
- read `references.md` when present for verified flavor

#### Example pseudocode

```ts
async function readRuneContextDocs(change: ResolvedRuneChange) {
  const docs = {
    proposal: await readFile(change.files.proposal),
    design: await readFile(change.files.design),
    standards: await readFile(change.files.standards),
    verification: await readFile(change.files.verification),
    status: parseYaml(await readFile(change.files.status)),
    tasks: change.files.tasks ? await readFile(change.files.tasks) : null,
    references: change.files.references ? await readFile(change.files.references) : null,
  }
  return docs
}
```

#### Acceptance criteria
- Both flavors are handled correctly.
- The reader never assumes `tasks.md` exists.

---

### Task 3.4 — Implement canonical-vs-derived precedence utilities

#### Objective
Prevent derived orchestration artifacts from competing with RuneContext source documents.

#### Files to create/update
- `packages/pi-zflow-runecontext/extensions/pi-runecontext/index.ts`
- `skills/runecontext-workflow/SKILL.md`
- later integration points in `zflow-change-workflows`

#### Required behavior
- mark canonical docs as the source of requirements
- treat `execution-groups.md` as derived in RuneContext mode
- if a plan drift or amendment implies requirement changes, write to canonical docs first after approval, then regenerate derivatives

#### Example decision helper

```ts
function getRequirementsSource(mode: "runecontext" | "adhoc") {
  return mode === "runecontext"
    ? "canonical-runecontext-docs"
    : "versioned-plan-artifacts"
}
```

#### Acceptance criteria
- No implementation path treats `execution-groups.md` as canonical in RuneContext mode.

---

### Task 3.5 — Implement `execution-groups.md` derivation rules for RuneContext mode

#### Objective
Generate dispatch-oriented execution groups from canonical RuneContext docs without introducing new requirements.

#### Files to create/update
- `packages/pi-zflow-runecontext/extensions/pi-runecontext/index.ts`
- later integration target: `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`

#### Derivation sources
- `tasks.md` if present
- otherwise `proposal.md`, `design.md`, `verification.md`, and `standards.md`

#### Derivation rules
- every file operation in derived groups must map back to canonical requirements
- do not add requirements absent from canonical docs
- preserve explicit dependencies and verification where provided
- if canonical docs are under-specified, mark uncertainty rather than inventing unsupported requirements

#### Example pseudocode

```ts
function deriveExecutionGroupsFromRuneDocs(docs) {
  const taskInputs = docs.tasks ? parseTasks(docs.tasks) : inferTasks(docs.proposal, docs.design, docs.verification)
  return buildExecutionGroups(taskInputs, { standards: docs.standards, forbidNewRequirements: true })
}
```

#### Acceptance criteria
- Derived groups remain traceable back to canonical docs.

---

### Task 3.6 — Implement conservative status mapping and write-back helpers

#### Objective
Support optional status synchronization without corrupting canonical `status.yaml` semantics.

#### Files to create/update
- `packages/pi-zflow-runecontext/extensions/pi-runecontext/runectx.ts`
- `packages/pi-zflow-runecontext/extensions/pi-runecontext/index.ts`

#### Required behavior
- do not auto-overwrite ambiguous statuses
- support optional mapping only when the target schema clearly supports it
- otherwise store richer state in runtime metadata only

#### Example pseudocode

```ts
function mapHarnessStateToRuneStatus(harnessState, allowedStatuses) {
  const explicitMap = {
    approved: allowedStatuses.includes("approved") ? "approved" : null,
    completed: allowedStatuses.includes("implemented") ? "implemented" : null,
  }
  return explicitMap[harnessState] ?? null
}
```

#### Acceptance criteria
- Ambiguity results in runtime-only recording, not lossy canonical overwrite.

---

### Task 3.7 — Implement approved-amendment write-back flow

#### Objective
Handle the case where plan drift or plan review reveals a real change to canonical requirements.

#### Files to create/update
- `packages/pi-zflow-runecontext/extensions/pi-runecontext/runectx.ts`
- later orchestration hooks in `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`

#### Required sequence
1. produce amendment artifact under `<runtime-state-dir>`
2. get approval
3. write approved amendment back to canonical RuneContext docs via `pi-runecontext`
4. record whether write-back succeeded or was deferred
5. regenerate `execution-groups.md`

#### Important rule
- Never regenerate `execution-groups.md` first and hope that becomes the new source of truth.

#### Example pseudocode

```ts
async function applyApprovedRuneContextAmendment(amendment) {
  await writeCanonicalDocs(amendment.docChanges)
  await regenerateDerivedExecutionGroups(amendment.changeId)
  await recordWriteBackStatus(amendment.changeId, "completed")
}
```

#### Acceptance criteria
- Canonical-doc write-back happens before derived artifact regeneration.

---

### Task 3.8 — Keep runtime/orchestration artifacts outside the RuneContext tree

#### Objective
Prevent pollution of portable change-doc directories.

#### Files to create/update
- `packages/pi-zflow-runecontext/extensions/pi-runecontext/index.ts`
- `packages/pi-zflow-artifacts/src/artifact-paths.ts` (later)

#### Forbidden writes inside RuneContext tree
- `run.json`
- `plan-state.json`
- `state-index.json`
- review findings
- deviation reports
- repo map
- reconnaissance
- transient execution checklists/widgets

#### Allowed writes inside RuneContext tree
- only canonical RuneContext doc updates explicitly routed through `pi-runecontext`, and only when approved

#### Acceptance criteria
- There is no code path that places runtime manifests inside `runecontext/`.

---

### Task 3.9 — Add RuneContext-specific skill guidance and examples

#### Objective
Make the agent behavior safe when RuneContext is active.

#### Files to create/update
- `skills/runecontext-workflow/SKILL.md`
- maybe prompt references in `agents/planner-frontier.md`

#### Skill content to include
- both flavor structures
- precedence rules
- `status.yaml` reading requirement
- `standards.md` reading requirement
- tasks-vs-derived grouping behavior
- canonical amendment/write-back process
- examples of what not to do (`execution-groups.md` must not become the new requirement source)

#### Example rule snippet

```markdown
When RuneContext is present, treat canonical change docs as the requirements source. `execution-groups.md` is dispatch output only.
```

#### Acceptance criteria
- RuneContext-specific safety guidance is available to the planner and workflow layer.

---

### Task 3.10 — Implement failure handling for missing or partial RuneContext inputs

#### Objective
Handle imperfect repos gracefully without degrading correctness.

#### Files to create/update
- `packages/pi-zflow-runecontext/extensions/pi-runecontext/index.ts`
- `packages/pi-zflow-runecontext/extensions/pi-runecontext/resolve-change.ts`

#### Cases to handle
- `runectx` unavailable but repo is otherwise detectable via file markers
- missing `tasks.md` in plain flavor (normal, not an error)
- missing required file for the detected flavor (hard failure)
- unsupported/ambiguous status schema (runtime-only status mapping)
- ambiguous active change resolution (prompt user or require explicit `<change-path>`)

#### Example pseudocode

```ts
if (flavor === "verified" && !files.tasks) {
  throw new Error("Verified RuneContext change is missing tasks.md")
}
```

#### Acceptance criteria
- Failures are specific and actionable.
- Normal plain-flavor behavior is not misclassified as an error.

---

### Task 3.11 — Add tests/fixtures for both RuneContext flavors and status edge cases

#### Objective
Protect the integration contract before the orchestration layer depends on it.

#### Files to create later
- `packages/pi-zflow-runecontext/test/*.test.ts`
- `test/fixtures/runecontext/plain/...`
- `test/fixtures/runecontext/verified/...`

#### Cases to cover
- detection via `runecontext.yaml`
- detection via `runectx status`
- plain flavor resolution
- verified flavor resolution
- missing required file failures
- tasks-derived fallback behavior
- conservative status mapping when schema is ambiguous
- amendment write-back before derived artifact regeneration

#### Acceptance criteria
- Core RuneContext contracts are tested or explicitly test-scripted.

---

### Task 3.12 — Define the integration surface consumed by workflow orchestration

#### Objective
Make it obvious how Phase 7 should call `pi-runecontext`.

#### Files to create/update
- `packages/pi-zflow-runecontext/extensions/pi-runecontext/index.ts`
- `README.md` or inline docs

#### Suggested API surface

```ts
export async function detectRuneContext(repoRoot: string): Promise<RuneContextDetection>
export async function resolveRuneChange(input: { repoRoot: string; changePath?: string }): Promise<ResolvedRuneChange>
export async function readRuneContextDocs(change: ResolvedRuneChange): Promise<RuneDocs>
export async function maybeWriteBackApprovedAmendment(amendment: ApprovedAmendment): Promise<WriteBackResult>
```

#### Acceptance criteria
- Phase 7 can consume `pi-runecontext` without reimplementing detection/resolution logic.

## Resolved write-back decision for this phase

- RuneContext write-back at `approved` and `completed` transitions must default to **automatic offer with explicit approval**: show a `pi-interview` preview, then write only if Zeb approves and the target project schema clearly supports the transition.
- Do not silently mutate RuneContext docs.
- Keep the implementation configurable for later `off | prompt | auto` modes, with `prompt` as the default.

## Phase exit checklist

- [ ] RuneContext repo detection exists.
- [ ] Active change resolution exists.
- [ ] Both plain and verified flavors are handled.
- [ ] Canonical-vs-derived precedence is encoded.
- [ ] `execution-groups.md` derivation rules for RuneContext mode are defined.
- [ ] Conservative status mapping exists, with `approved`/`completed` write-back defaulting to prompt-with-preview.
- [ ] Approved-amendment write-back flow is defined.
- [ ] Runtime artifacts are kept outside the RuneContext tree.
- [ ] RuneContext skill guidance exists.
- [ ] Partial/missing-input failures are handled cleanly.
- [ ] Tests/fixtures are planned or implemented.
- [ ] Workflow-facing APIs are defined.

## Handoff notes for later phases

- Phase 6 reviewers must receive the canonical RuneContext docs first when RuneContext mode is active.
- Phase 7 `/zflow-change-prepare` and `/zflow-change-implement` should call `pi-runecontext` immediately after profile/bootstrap checks.
- Write-back at `approved` or `completed` transitions should use prompt-with-preview by default and stay optional unless the project schema clearly supports it.
