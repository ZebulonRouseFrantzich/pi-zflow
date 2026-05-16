/**
 * pi-zflow-subagents-bridge — Dispatch adaptation package.
 *
 * Owns the `zflow-dispatch` capability registration in the shared zflow
 * registry.  Provides a `DispatchService` implementation that bridges
 * between pi-zflow's typed dispatch interface and whatever runtime
 * dispatch backend is available.
 *
 * ## Design
 *
 * This package does NOT orchestrate or run subagents. It only adapts.
 * The extension attempts to load `pi-subagents/zflow-bridge` from the
 * zflow fork for operational dispatch. If that backend is unavailable,
 * it falls back to an explicit diagnostic service rather than faking
 * successful execution.
 *
 * @module pi-zflow-subagents-bridge
 */

export { PI_ZFLOW_SUBAGENTS_BRIDGE_VERSION } from "pi-zflow-core"

/**
 * Re-exported from canonical definition in pi-zflow-core.
 * Single source of truth for bridge version constant.
 */

export type {
  DispatchService,
  AgentDispatchInput,
  AgentDispatchResult,
  ParallelTaskInput,
  ParallelTaskResult,
  ParallelDispatchInput,
  ParallelDispatchResult,
} from "pi-zflow-core/dispatch-service"

export { DISPATCH_SERVICE_CAPABILITY } from "pi-zflow-core/dispatch-service"
