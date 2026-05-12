/**
 * install.ts — Agent/chain markdown installation and update logic.
 *
 * ## Overview
 *
 * pi-zflow ships agent and chain markdown files inside the `pi-zflow-agents`
 * package. Because Pi does not have native `agents` or `chains` manifest keys,
 * these files must be **copied** into Pi-subagents discovery directories so
 * they become available via `/run`, `/chain`, `subagent(...)`, etc.
 *
 * Two commands orchestrate this process:
 * - `/zflow-setup-agents` — first-time installation
 * - `/zflow-update-agents` — refresh when the package version changes
 *
 * ## Source directories
 *
 * All files are relative to the `pi-zflow-agents` package root:
 *
 * | Resource | Source path |
 * |---|---|
 * | Agent files | `<pkg-root>/agents/*.md` |
 * | Chain files | `<pkg-root>/chains/*.chain.md` |
 * | Skill files | `<pkg-root>/skills/*/SKILL.md` |
 *
 * ## Install targets
 *
 * | Resource | User-level target | Project-level target (opt-in) |
 * |---|---|---|
 * | Agents | `~/.pi/agent/agents/zflow/` | `<project>/.pi/agents/zflow/` |
 * | Chains | `~/.pi/agent/chains/zflow/` | `<project>/.pi/chains/zflow/` |
 * | Manifest | `~/.pi/agent/zflow/install-manifest.json` | (not project-scoped) |
 *
 * ## Idempotent copy logic
 *
 * For each source file:
 *
 * 1. Compute SHA-256 hash of the source file content.
 * 2. If the target file exists:
 *    a. Compute hash of the target file.
 *    b. If hashes match → skip (file is identical, no copy needed).
 *    c. If hashes differ AND the manifest shows this version deployed →
 *       user has edited the file; skip unless `--force` is passed.
 *    d. If hashes differ AND the manifest shows an older version →
 *       overwrite (this is an update, not a user edit).
 * 3. If the target file does not exist → copy source to target.
 * 4. After copying, update the install manifest.
 *
 * ## `--force` flag
 *
 * When `--force` is passed, all source files are copied regardless of hash
 * comparison. User edits are overwritten. The user is warned before the
 * operation proceeds.
 *
 * ## Update detection
 *
 * On `/zflow-update-agents`:
 * 1. Read the install manifest from `~/.pi/agent/zflow/install-manifest.json`.
 * 2. Compare `manifest.version` against the current `pi-zflow-agents`
 *    package version (from `package.json`).
 * 3. If versions match → nothing to do. Report "already up to date".
 * 4. If versions differ → perform idempotent copy (see above). Hash-matching
 *    protects user edits that haven't changed between versions.
 * 5. After update, write the new version and timestamp to the manifest.
 *
 * ## Project-local scope (opt-in)
 *
 * By default, agents/chains install to user-level directories. Project-local
 * installation is opt-in:
 *
 * - If `<project>/.pi/agents/` or `<project>/.pi/chains/` exists, offer to
 *   install there instead.
 * - The user can explicitly pass `--scope project` to force project-local
 *   installation.
 * - If generated assets are copied into a repo, they should be gitignored
 *   unless intentionally curated/shared.
 *
 * ## What gets installed
 *
 * ### Agents
 *
 * Every `.md` file in `agents/` that is NOT a `.chain.md` file. Currently:
 * - planner-frontier.md, plan-validator.md
 * - implement-routine.md, implement-hard.md, verifier.md
 * - plan-review-correctness.md, plan-review-integration.md, plan-review-feasibility.md
 * - review-correctness.md, review-integration.md, review-security.md,
 *   review-logic.md, review-system.md
 * - synthesizer.md, repo-mapper.md
 *
 * Builtin agents (`scout`, `context-builder`) are NOT installed — they are
 * reused from Pi's builtin set (see Builtin agent reuse strategy in README).
 *
 * ### Chains
 *
 * Every `.chain.md` file in `chains/`. Currently:
 * - scout-plan-validate.chain.md, plan-and-implement.chain.md
 * - parallel-review.chain.md, implement-and-review.chain.md
 * - plan-review-swarm.chain.md
 *
 * ### Skills
 *
 * Skill directories (`skills/*/`) are NOT copied during agent installation.
 * Skills are loaded by Pi via the package manifest's `pi.skills` key and do
 * not need filesystem-level deployment.
 *
 * ## Error handling
 *
 * - If the source `agents/` or `chains/` directory is missing, emit a warning
 *   and continue (no files to install).
 * - If the target directory cannot be created (permission denied), emit an
 *   actionable error with the full path.
 * - If a single file copy fails, log the error and continue with remaining
 *   files. Report the failure count at the end.
 *
 * @module pi-zflow-agents/install
 */

export {}

