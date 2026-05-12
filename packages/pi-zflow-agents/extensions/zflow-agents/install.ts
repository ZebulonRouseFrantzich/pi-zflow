/**
 * install.ts — Agent/chain markdown installation and update logic.
 *
 * **Phase 1 placeholder.**
 * The full install implementation will be part of Phase 4.
 *
 * TODO(phase-4): Implement agent/chain install flow.
 *   - Discover agent `.md` files from `agents/` directory
 *   - Discover chain `.md` files from `chains/` directory
 *   - Copy to `~/.pi/agent/agents/zflow/` and `~/.pi/agent/chains/zflow/`
 *   - Idempotent: skip files that haven't changed (compare hash/mtime)
 *   - `--force` flag to overwrite user-local edits
 *   - Update detection: compare installed manifest version vs package version
 *   - Support project-local scope opt-in (`.pi/agents/`, `.pi/chains/`)
 *   - Record deployed files in install manifest (see manifest.ts)
 *
 * @module pi-zflow-agents/install
 */

export {}
