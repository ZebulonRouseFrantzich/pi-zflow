/**
 * pi-zflow-change-workflows extension entrypoint
 *
 * Phase 4 milestones:
 * - orchestration.ts now wires Phase 4 infrastructure into dispatchable helpers:
 *   - `buildSubagentLaunchPlan` — resolves profile bindings, assembles prompts,
 *     attaches output conventions, validates limits
 *   - `buildWorkflowExecutionPlan` — composes agent/chain steps for each workflow phase
 *   - `createSwarmManifest` — creates reviewer manifests with tier-based selection
 *   - `getOutputRoute` — maps agent output to correct persistence target
 *
 * TODO(phase-7): Register extension commands and service.
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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export default function activateZflowChangeWorkflowsExtension(pi: ExtensionAPI): void {
  // Registration logic will be added in Phase 7
}
