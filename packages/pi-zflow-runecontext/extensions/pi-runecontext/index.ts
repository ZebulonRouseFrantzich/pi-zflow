/**
 * pi-zflow-runecontext extension entrypoint
 *
 * Registers RuneContext detection, change-doc parsing, and canonical doc
 * resolution services. Note the extension directory is `pi-runecontext`
 * (not `zflow-runecontext`) for consistency with the canonical tool naming.
 *
 * TODO(phase-3): Implement RuneContext integration.
 *   - claim("runecontext", ...) via getZflowRegistry()
 *   - provide("runecontext", runeContextService) with:
 *     - Detecting RuneContext roots in the project
 *     - Resolving change docs and parsing both supported document flavors
 *     - Status/transition mapping
 *     - Prompt-with-preview write-back support
 *   - Guard against duplicate loads: check registry.has("runecontext")
 *   - No required public command in v1; may expose `/zflow-runecontext status`
 *   - See detect.ts, resolve-change.ts, runectx.ts
 */
import type { Extension } from "@earendil-works/pi-coding-agent"

const extension: Extension = {
  name: "pi-zflow-runecontext",
  version: "0.1.0",
  activate() {
    // Registration logic will be added in Phase 3
  },
}

export default extension
