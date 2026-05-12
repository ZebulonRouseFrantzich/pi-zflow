# Foundation Version Policy and Pin Record

> **Source of truth for exact version pins and minimum Pi version.**
> This document is the human-readable policy record. Machine-readable pins live in `package.json` manifests.

## Supported Pi version

| Field | Value |
|---|---|
| Provisional minimum before Phase 0 smoke testing | `0.74.0` |
| Confirmed minimum after Phase 0 smoke testing | `<pending>` |
| Last tested Pi version | `<pending>` |
| Testing date | `<pending>` |

### Smoke test checklist for Pi minimum version

- [ ] Extension loading — install and load a pi-zflow child package extension
- [ ] Chain discovery — `pi-subagents` discovers chains from `~/.pi/agent/chains/zflow/`
- [ ] `pi-subagents` runtime — subagent subprocess runs with the correct extension context
- [ ] Session hooks — `session_before_compact` hook fires correctly for `pi-zflow-compaction`
- [ ] Active tool restrictions — `/zflow-plan` mode restricts tools and restores them on exit

### Notes
- If any checklist item fails, raise the minimum Pi version to the next stable release and retest.
- Once confirmed, update this record and `README.md` with the confirmed minimum.

---

## Foundation package pins

These are the exact versions tested and approved for the first-pass foundation stack.
All pins must be exact — no `^`, `~`, or `latest` ranges.

### Required packages

| Package | Exact version/ref | Source | Status |
|---|---|---|---|
| `pi-subagents` | `0.24.2` | npm | ✅ installed — extension entry point verified |
| `pi-rtk-optimizer` | `0.7.1` | npm | ✅ installed — extension entry point verified |
| `pi-intercom` | `0.6.0` | npm | ✅ installed — extension entry point verified |

### Recommended first-pass packages

| Package | Exact version/ref | Source | Status |
|---|---|---|---|
| `pi-web-access` | `0.10.7` | npm | ✅ installed — extension entry point verified |
| `pi-interview` | `0.8.7` | npm | ✅ installed — extension entry point verified |
| `pi-mono-sentinel` | `1.11.0` | npm | ✅ installed — extension entry point verified |
| `pi-mono-context-guard` | `1.7.3` | npm | ✅ installed — extension entry point verified |
| `pi-mono-multi-edit` | `1.7.3` | npm | ✅ installed — extension entry point verified |
| `pi-mono-auto-fix` | `0.3.1` | npm | ✅ installed — extension entry point verified |

### Optional packages

| Package | Exact version/ref | Source | Condition for install |
|---|---|---|---|
| `@benvargas/pi-openai-verbosity` | `<TBD>` | npm | Install when any active lane uses `openai-codex` |
| `@benvargas/pi-synthetic-provider` | `<TBD>` | npm | Later cost/diversity optimization only — deferred |
| `pi-rewind-hook` | `<TBD>` | npm | Optional recovery; mutually exclusive with other checkpoint packages |

### Optional package policy

#### `@benvargas/pi-openai-verbosity`

- **Condition**: recommend installation when profile resolution detects `openai-codex` lanes.
- **Scope**: recommendation only; never force-install.
- **Timing**: evaluated at profile/lane resolution time by `pi-zflow-profiles`.
- **Version pin**: `<TBD>` — set after smoke testing with Codex provider.

#### `@benvargas/pi-synthetic-provider`

- **Condition**: deferred until cost optimization or diversity routing is a concrete requirement.
- **Scope**: not part of first-pass foundation; no install or recommendation logic in Phase 0/1.
- **Version pin**: `<TBD>` — set when implementation begins.

#### `pi-rewind-hook`

- **Condition**: install only on explicit user opt-in (`config.enableRewindHook` or equivalent).
- **Exclusivity rule**: if enabled, no other checkpoint/rewind package may be active.
  - Conflict detection must happen **before** installation.
  - On conflict, fail fast with an actionable message naming the conflicting package.
- **Version pin**: `<TBD>` — set after smoke testing recovery hooks.

#### Rewind exclusivity — enforcement rules

1. Before installing `pi-rewind-hook`, scan all active packages for checkpoint-capable hooks.
2. If any are found, abort installation with a message:
   > "Cannot enable pi-rewind-hook: `<name>` is already active. Remove or disable `<name>` before enabling rewind/checkpoint support."
3. The exclusivity check must cover `session_before_compact` hooks and any package registering checkpoint/undo/redo functionality.
4. If `pi-rewind-hook` is later disabled, the exclusivity constraint is lifted.

See `docs/architecture/package-ownership.md` for the full optional package policy and pseudocode.

---

## pi-zflow child package pins / local refs

All child packages are currently in local development (`0.1.0`, workspace-referenced).
When any child package is published to npm, update this record with the exact published version.

| Child package | Current ref | Workspace path | Publication status |
|---|---|---|---|
| `pi-zflow-core` | `0.1.0` | `packages/pi-zflow-core` | Local development (workspace) |
| `pi-zflow-artifacts` | `0.1.0` | `packages/pi-zflow-artifacts` | Local development (workspace) |
| `pi-zflow-profiles` | `0.1.0` | `packages/pi-zflow-profiles` | Local development (workspace) |
| `pi-zflow-plan-mode` | `0.1.0` | `packages/pi-zflow-plan-mode` | Local development (workspace) |
| `pi-zflow-agents` | `0.1.0` | `packages/pi-zflow-agents` | Local development (workspace) |
| `pi-zflow-review` | `0.1.0` | `packages/pi-zflow-review` | Local development (workspace) |
| `pi-zflow-change-workflows` | `0.1.0` | `packages/pi-zflow-change-workflows` | Local development (workspace) |
| `pi-zflow-runecontext` | `0.1.0` | `packages/pi-zflow-runecontext` | Local development (workspace) |
| `pi-zflow-compaction` | `0.1.0` | `packages/pi-zflow-compaction` | Local development (workspace) |
| `pi-zflow` | `0.1.0` | `packages/pi-zflow` | Local development (workspace) |

---

## Pin update policy

1. **Before any Phase 0 smoke test**, all pins are provisional. Update pins based on test results.
2. **After Phase 0 smoke testing**, promote pins to confirmed status in this document.
3. **When a child package is published**, update the ref from workspace to `npm:<exact-version>`.
4. **If a foundation package is updated**, record the old pin, the new pin, and the reason for the change.
5. **No automation** — install or bootstrap — may use `latest` for any package in the foundation stack.

### Pin change log

| Date | Package | Old pin | New pin | Reason |
|---|---|---|---|---|
| — | — | — | — | (no changes yet) |

---

## Ownership and overlap-avoidance policy

See `docs/architecture/package-ownership.md` for the canonical ownership map, explicit exclusions, and command/tool naming rules.

### Quick reference

| Concern | Owner | Prohibited competitors |
|---|---|---|
| Orchestration | `pi-subagents` | `pi-fork`, `pi-minimal-subagent`, `PiSwarm` |
| Compaction | `pi-rtk-optimizer` + `pi-zflow-compaction` | overlapping compaction hooks |
| Research | `pi-web-access` | none in foundation |
| Human-in-the-loop | `pi-interview` | `pi-mono-ask-user-question` |
| Profiles | `pi-zflow-profiles` | none |
| Planning safety | `pi-zflow-plan-mode` | none |
| Runtime artifacts | `pi-zflow-artifacts` | none |
| Review | `pi-zflow-review` | `pi-mono-review` |
| Recovery | runtime artifacts; `pi-rewind-hook` (opt) | other checkpoint packages when hook enabled |

---

## Cleanup policy defaults

| Artifact class | Default TTL / retention | Action |
|---|---|---|
| Stale runtime/patch artifacts | 14 days | Auto-clean on `/zflow-clean` |
| Failed/interrupted worktrees | 7 days | Auto-clean on `/zflow-clean` |
| Successful temp worktrees | removed immediately after verified apply-back | Unless `--keep` or debug option used |

See `packages/pi-zflow-change-workflows/` for cleanup command implementation (`/zflow-clean`).

---

## Runtime state paths

| Path | Resolution | Purpose |
|---|---|---|
| `<runtime-state-dir>` | `<git-dir>/pi-zflow/` (or `os.tmpdir()/pi-zflow-<hash>` fallback) | Plan/run/review artifacts, state index |
| `<user-state-dir>` | `~/.pi/agent/zflow/` | Active profile, install manifest |
| `~/.pi/agent/agents/zflow/` | user-level agent files | Agent markdown for `pi-subagents` |
| `~/.pi/agent/chains/zflow/` | user-level chain files | Chain markdown for `pi-subagents` |

Project-local `.pi/agents/` and `.pi/chains/` are opt-in only.

---

## Bootstrap / preflight checklist

Machine prerequisites for Phase 0 and beyond:

| Tool | Required for | Fail action |
|---|---|---|
| `rtk` | Command rewriting / output compaction | Alert; does not block compaction |
| `gh` | GitHub PR review flows (`/zflow-review-pr`) | Blocks PR submission only |
| `glab` | GitLab MR review flows (`/zflow-review-pr`) | Blocks MR submission only |
| `runectx` | RuneContext integration | Blocks RuneContext flows only |
| `pi --list-models` / model registry | Default profile lane resolution | Blocks profile activation |

See Phase 0 Task 0.5 for the full preflight design.
