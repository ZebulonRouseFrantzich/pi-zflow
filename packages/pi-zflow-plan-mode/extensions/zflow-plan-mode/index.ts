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
import type { Extension } from "@earendil-works/pi-coding-agent"

const extension: Extension = {
  name: "pi-zflow-plan-mode",
  version: "0.1.0",
  activate() {
    // Registration logic will be added in Phase 2
  },
}

export default extension
