/**
 * pi-zflow-change-workflows extension entrypoint
 *
 * Registers `/zflow-change-prepare`, `/zflow-change-implement`, `/zflow-clean` commands.
 *
 * TODO(phase-7): Implement change workflow orchestration.
 *   - claim("change-workflows", ...) via getZflowRegistry()
 *   - provide("change-workflows", changeWorkflowService) with:
 *     - Artifact-first prepare/implement lifecycle
 *     - Worktree execution orchestration
 *     - Verification/fix loops
 *     - Apply-back strategy coordination
 *     - Cleanup UX
 *   - Guard against duplicate loads: check registry.has("change-workflows")
 *   - Register `/zflow-change-prepare <change-path>`, `/zflow-change-implement <change-path>`,
 *     `/zflow-clean` commands
 *   - See orchestration.ts, apply-back.ts, verification.ts, plan-validator.ts,
 *     path-guard.ts, failure-log.ts
 */
import type { Extension } from "@earendil-works/pi-coding-agent"

const extension: Extension = {
  name: "pi-zflow-change-workflows",
  version: "0.1.0",
  activate() {
    // Registration logic will be added in Phase 7
  },
}

export default extension
