/**
 * pi-zflow-profiles — shared lane lookup API
 *
 * Direct-import helpers for sibling packages that depend on
 * `pi-zflow-profiles` and want to consume resolved profile data
 * without going through the zflow registry.
 *
 * ## Usage
 *
 * ```ts
 * import { getResolvedAgentBinding, getResolvedLane }
 *   from "pi-zflow-profiles"
 *
 * const binding = await getResolvedAgentBinding("zflow.planner-frontier")
 * if (binding?.resolvedModel) {
 *   console.log(`Agent uses model: ${binding.resolvedModel}`)
 * }
 * ```
 *
 * ## Registry access
 *
 * Sibling packages that load as Pi extensions can also access profile
 * services through the shared zflow registry:
 *
 * ```ts
 * import { getZflowRegistry } from "pi-zflow-core"
 * const profiles = getZflowRegistry().get("profiles")
 * const binding = await profiles.getResolvedAgentBinding("zflow.planner-frontier")
 * ```
 *
 * Both paths provide the same functionality. The direct-import path is
 * simpler when the caller already has `pi-zflow-profiles` as a dependency.
 *
 * ## File-backed fallback
 *
 * External tools or packages that cannot access either the registry or
 * the npm dependency can read `~/.pi/agent/zflow/active-profile.json`
 * directly. That file contains the full resolved profile with all lane
 * mappings and agent bindings.
 *
 * @module pi-zflow-profiles/api
 */

// Re-export the shared lookup functions from the extension module
export {
  getResolvedAgentBinding,
  getResolvedLane,
  ensureResolved,
} from "../extensions/zflow-profiles/index.js"

// Re-export types consumers will need
export type {
  ResolvedAgentBinding,
  ResolvedLane,
  ResolvedProfile,
  LaneStatus,
  ActiveProfileCache,
} from "../extensions/zflow-profiles/profiles.js"

export type {
  LaneHealthReport,
  HealthCheckResult,
} from "../extensions/zflow-profiles/health.js"
