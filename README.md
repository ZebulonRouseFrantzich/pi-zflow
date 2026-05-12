# pi-zflow

A modular Pi harness customization suite — profiles, planning safety, review workflows, change orchestration, runtime artifacts, RuneContext integration, and compaction hooks.

## Architecture

pi-zflow is a monorepo of individually installable Pi packages:

| Package | Type | Description |
|---|---|---|
| `pi-zflow-core` | library | Shared types, registry, version constants |
| `pi-zflow-artifacts` | Pi extension | Runtime state paths, artifact helpers, `zflow_write_plan_artifact` tool |
| `pi-zflow-profiles` | Pi extension | Profile/lane resolution, `/zflow-profile` commands |
| `pi-zflow-plan-mode` | Pi extension | Ad-hoc read-only planning mode, `/zflow-plan` commands |
| `pi-zflow-agents` | Pi extension | Custom agent markdown, chains, skills, prompts, setup/update commands |
| `pi-zflow-review` | Pi extension | Plan/code/PR review workflows, `/zflow-review-code`, `/zflow-review-pr` |
| `pi-zflow-change-workflows` | Pi extension | Formal prepare/implement orchestration, `/zflow-change-prepare`, `/zflow-change-implement`, `/zflow-clean` |
| `pi-zflow-runecontext` | Pi extension | RuneContext integration |
| `pi-zflow-compaction` | Pi extension | Proactive compaction hooks |
| `pi-zflow` | umbrella Pi package | Bundles the suite |

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

| Child package | Current pin | Status |
|---|---|---|
| `pi-zflow-core` | `0.1.0` (workspace ref) | local development |
| `pi-zflow-artifacts` | `0.1.0` (workspace ref) | local development |
| `pi-zflow-profiles` | `0.1.0` (workspace ref) | local development |
| `pi-zflow-plan-mode` | `0.1.0` (workspace ref) | local development |
| `pi-zflow-agents` | `0.1.0` (workspace ref) | local development |
| `pi-zflow-review` | `0.1.0` (workspace ref) | local development |
| `pi-zflow-change-workflows` | `0.1.0` (workspace ref) | local development |
| `pi-zflow-runecontext` | `0.1.0` (workspace ref) | local development |
| `pi-zflow-compaction` | `0.1.0` (workspace ref) | local development |
| `pi-zflow` | `0.1.0` (workspace ref) | local development |

### Foundation package pins

| Package | Pinned version | Status |
|---|---|---|
| `pi-subagents` | `0.24.2` | pre-install (provisional, verify in Phase 0) |
| `pi-rtk-optimizer` | `0.7.1` | pre-install (provisional, verify in Phase 0) |
| `pi-intercom` | `0.6.0` | pre-install (provisional, verify in Phase 0) |
| `pi-web-access` | `0.10.7` | pre-install (provisional, verify in Phase 0) |
| `pi-interview` | `0.8.7` | pre-install (provisional, verify in Phase 0) |
| `pi-mono-sentinel` | `1.11.0` | pre-install (provisional, verify in Phase 0) |
| `pi-mono-context-guard` | `1.7.3` | pre-install (provisional, verify in Phase 0) |
| `pi-mono-multi-edit` | `1.7.3` | pre-install (provisional, verify in Phase 0) |
| `pi-mono-auto-fix` | `0.3.1` | pre-install (provisional, verify in Phase 0) |

### Optional package pin record

| Package | Pinned version | Condition |
|---|---|---|
| `@benvargas/pi-openai-verbosity` | `<TBD>` | install when any active lane uses `openai-codex` |
| `@benvargas/pi-synthetic-provider` | `<TBD>` | later cost/diversity optimization only |
| `pi-rewind-hook` | `<TBD>` | optional recovery layer; if enabled, no other rewind/checkpoint package may be active |

## Overlap avoidance

See `docs/foundation-versions.md` for the full ownership and exclusion policy.

## License

MIT
