/**
 * pi-zflow-review extension entrypoint
 *
 * Registers `/zflow-review-code` and `/zflow-review-pr <url>` commands.
 *
 * TODO(phase-6): Implement review flows.
 *   - claim("review", ...) via getZflowRegistry()
 *   - provide("review", reviewService) with:
 *     - Multi-provider plan review orchestration
 *     - Code review workflows
 *     - PR/MR diff-only review
 *     - Findings parsing/writing helpers
 *   - Guard against duplicate loads: check registry.has("review") before claiming
 *   - Register `/zflow-review-code`, `/zflow-review-pr <url>` commands
 *   - See findings.ts, pr.ts, chunking.ts
 *
 * Related: synthesizer agent (zflow.synthesizer) consolidates review findings.
 */
import type { Extension } from "@earendil-works/pi-coding-agent"

const extension: Extension = {
  name: "pi-zflow-review",
  version: "0.1.0",
  activate() {
    // Registration logic will be added in Phase 6
  },
}

export default extension
