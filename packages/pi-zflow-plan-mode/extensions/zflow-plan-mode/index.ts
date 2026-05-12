/**
 * pi-zflow-plan-mode extension entrypoint
 *
 * Registers `/zflow-plan` commands, active-tool restriction, and read-only bash policy.
 *
 * TODO(phase-2): Implement planning mode.
 *   - claim("plan-mode", ...) via getZflowRegistry()
 *   - provide("plan-mode", planModeService) with:
 *     - Active-tool reduction while mode is active
 *     - Restricted read-only bash policy
 *     - Mode status/reminders
 *   - Guard against duplicate loads: check registry.has("plan-mode") before claiming
 *   - Register `/zflow-plan`, `/zflow-plan status`, `/zflow-plan exit` commands
 *   - See state.ts, bash-policy.ts
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export default function activateZflowPlanModeExtension(pi: ExtensionAPI): void {
  // Registration logic will be added in Phase 2
}
