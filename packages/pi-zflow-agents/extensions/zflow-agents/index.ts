/**
 * pi-zflow-agents extension entrypoint
 *
 * Registers `/zflow-setup-agents`, `/zflow-update-agents`, and prompt helper commands.
 *
 * TODO(phase-4): Implement agent/chain setup flow.
 *   - claim("agents", ...) via getZflowRegistry()
 *   - provide("agents", agentsService) with:
 *     - Agent/chain markdown discovery from package files
 *     - Install into `~/.pi/agent/agents/zflow/` and `~/.pi/agent/chains/zflow/`
 *     - Install manifest tracking at `~/.pi/agent/zflow/install-manifest.json`
 *     - Update detection and safe upgrade logic
 *   - Guard against duplicate loads: check registry.has("agents") before claiming
 *   - Register `/zflow-setup-agents`, `/zflow-update-agents` commands
 *   - See install.ts, manifest.ts
 */
import type { Extension } from "@earendil-works/pi-coding-agent"

const extension: Extension = {
  name: "pi-zflow-agents",
  version: "0.1.0",
  activate() {
    // Registration logic will be added in Phase 4
  },
}

export default extension
