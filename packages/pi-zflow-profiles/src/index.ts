/**
 * pi-zflow-profiles
 *
 * Logical profile loading, lane resolution, active profile cache,
 * profile health checks, and /zflow-profile commands.
 *
 * ## Direct imports
 *
 * Sibling packages can import helpers directly:
 *
 * ```ts
 * import { getResolvedAgentBinding, getResolvedLane }
 *   from "pi-zflow-profiles"
 * ```
 *
 * Or use the shared zflow registry:
 *
 * ```ts
 * import { getZflowRegistry } from "pi-zflow-core"
 * const profiles = getZflowRegistry().get("profiles")
 * ```
 */
export const PACKAGE_VERSION = "0.1.0" as const

// Re-export the public API for direct import by sibling packages
export {
  getResolvedAgentBinding,
  getResolvedLane,
  ensureResolved,
} from "./api.js"

export type {
  ResolvedAgentBinding,
  ResolvedLane,
  ResolvedProfile,
  LaneStatus,
  ActiveProfileCache,
} from "../extensions/zflow-profiles/profiles.js"

// Launch config generation
export {
  buildLaunchConfig,
  buildAllLaunchConfigs,
  validateLaunchConfig,
} from "./launch-config.js"

export type {
  LaunchAgentConfig,
} from "./launch-config.js"

// Builtin agent overrides
export {
  getBuiltinOverride,
  applyBuiltinOverride,
  hasBuiltinOverride,
  getAllBuiltinOverrides,
  getBuiltinOverrideValues,
  BUILTIN_SCOUT_OVERRIDE,
  BUILTIN_CONTEXT_BUILDER_OVERRIDE,
} from "./builtin-overrides.js"

export type {
  BuiltinAgentOverride,
  BuiltinOverrideDefinition,
} from "./builtin-overrides.js"

// Depth enforcement
export {
  validateMaxSubagentDepth,
  getDefaultMaxSubagentDepth,
  enforceDepthLimits,
  applyDefaultMaxSubagentDepth,
  KNOWN_DEPTH_OVERRIDES,
} from "./depth-enforcement.js"
