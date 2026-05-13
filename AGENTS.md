# AGENTS.md

Instructions for AI coding agents working in this repository. Keep changes small, testable, and aligned with the existing phase plans.

## Project snapshot

`pi-zflow` is a Node/TypeScript npm-workspace monorepo for Pi harness customization packages.

- Root workspace: `package.json`, `package-lock.json`, `packages/*`
- Runtime target: Node.js `>=22`
- Module style: ESM TypeScript (`"type": "module"`); source imports use `.js` extensions
- Test runner: built-in `node:test` via `tsx`
- Package manager: npm workspaces; keep `package-lock.json` in sync

## High-value references

Read the relevant docs before editing behavior:

- `README.md` — package overview, version policy, install flow
- `docs/architecture/package-ownership.md` — canonical ownership, naming, and overlap rules
- `implementation-phases/README.md` and `implementation-phases/phase-*.md` — planned work and acceptance criteria
- `docs/foundation-versions.md` — pinned dependency policy
- `docs/path-guard-policy.md`, `docs/worktree-setup-hook-policy.md`, `docs/subagents-integration.md` — subsystem policies
- Pi API docs, when changing Pi extension behavior: `/home/zeb/.nvm/versions/node/v24.11.1/lib/node_modules/@earendil-works/pi-coding-agent/README.md` and `docs/`

## Package map

- `packages/pi-zflow-core` — shared library only; no Pi commands, tools, UI, or extension registration
- `packages/pi-zflow-artifacts` — runtime state paths, plan/run/review artifacts, `zflow_write_plan_artifact`
- `packages/pi-zflow-profiles` — profile/lane/model resolution and `/zflow-profile*`
- `packages/pi-zflow-plan-mode` — read-only planning mode and `/zflow-plan*`
- `packages/pi-zflow-agents` — bundled agents, chains, skills, prompt assets, setup/update commands
- `packages/pi-zflow-review` — plan/code/PR review orchestration and findings
- `packages/pi-zflow-change-workflows` — prepare/implement workflows, worktrees, apply-back, cleanup
- `packages/pi-zflow-runecontext` — RuneContext detection and change-doc resolution
- `packages/pi-zflow-compaction` — compaction hooks and handoff reminders
- `packages/pi-zflow` — umbrella package that exposes child package resources

## Commands

Use the narrowest command that validates your change:

```bash
npm install
npm run test:core
npm run test:all
npx tsx --test packages/<package>/test/*.test.ts
npx tsx --test packages/<package>/test/<file>.test.ts
```

Notes:

- `npm test` delegates to `npm run test:all`.
- There is no separate build/lint script currently configured at the root.
- Prefer `rg` for search. If shell `find` is shimmed and rejects predicates, use `/usr/bin/find`.

## Coding conventions

- Match existing style: double quotes, no semicolons, 2-space indentation.
- Keep TypeScript ESM imports explicit; local relative imports should end in `.js`.
- Prefer named exports and small pure helpers with direct unit tests.
- Tests use `node:test` and `node:assert`; place tests beside package under `packages/<pkg>/test/`.
- Do not modify `node_modules/` or generated/runtime state artifacts.
- Update docs when changing commands, package ownership, install flow, or user-visible behavior.

## Non-negotiable project rules

- Follow the single-owner policy in `docs/architecture/package-ownership.md`.
- Do not add competing orchestration, review, HITL, compaction, or checkpoint packages without explicit approval.
- Do not override built-in Pi tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, etc.) by default.
- Register only namespaced default commands/tools (`/zflow-*`, `zflow_*`). Short aliases are opt-in only.
- Keep `pi-zflow-core` library-only.
- No floating `latest` pins. Use exact dependency versions or exact git refs, except documented Pi host `peerDependencies: "*"`.
- Extensions must tolerate duplicate loading and fail fast with actionable messages on incompatible capability claims.

## Workflow expectations

1. Identify the owning package before editing.
2. Read the package tests and relevant policy/phase docs.
3. Add or update tests for behavior changes.
4. Run targeted tests first; run `npm run test:all` for cross-package or manifest changes.
5. In the final response, summarize changed files and validation performed.

If a requested change conflicts with these instructions or the policy docs, stop and ask for clarification.
