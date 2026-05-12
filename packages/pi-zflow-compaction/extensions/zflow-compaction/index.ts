/**
 * pi-zflow-compaction extension entrypoint
 *
 * Registers `session_before_compact` hooks and proactive compaction triggers.
 *
 * TODO(phase-8): Implement compaction hooks.
 *   - claim("compaction", ...) via getZflowRegistry()
 *   - provide("compaction", compactionService) with:
 *     - session_before_compact hook registration
 *     - Proactive compaction threshold monitoring
 *     - Compaction handoff reminders
 *     - Reading canonical artifacts after compaction
 *   - Guard against duplicate loads: check registry.has("compaction")
 *   - Must coexist with pi-rtk-optimizer (first-pass compaction owner)
 *   - No required public commands in v1
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export default function activateZflowCompactionExtension(pi: ExtensionAPI): void {
  // Registration logic will be added in Phase 8
}
