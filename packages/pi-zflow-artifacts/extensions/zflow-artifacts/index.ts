/**
 * pi-zflow-artifacts extension entrypoint
 *
 * Registers the `zflow_write_plan_artifact` tool and runtime path helpers.
 *
 * TODO(phase-2): Implement actual tool registration.
 *   - claim("artifacts", ...) via getZflowRegistry()
 *   - provide("artifacts", artifactService) with path resolvers + tool registrations
 *   - Guard against duplicate loads: check registry.has("artifacts") before claiming
 *   - Register /zflow-write-plan-artifact command (or keep it as tool-only)
 */
import type { Extension } from "@earendil-works/pi-coding-agent"

const extension: Extension = {
  name: "pi-zflow-artifacts",
  version: "0.1.0",
  activate() {
    // Registration logic will be added in Phase 2
    // See src/state-index.ts, src/plan-state.ts, src/run-state.ts,
    // src/cleanup-metadata.ts, src/write-plan-artifact.ts
  },
}

export default extension
