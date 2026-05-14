/**
 * pi-zflow-plan-mode
 *
 * Sticky ad-hoc read-only planning mode, active-tool restriction,
 * restricted bash policy, and /zflow-plan commands.
 */
export const PACKAGE_VERSION = "0.1.0" as const

// Re-export plan-mode state helpers
// Also importable directly from "pi-zflow-plan-mode/state"
export {
  getPlanModeStatus,
  activatePlanMode,
  deactivatePlanMode,
  isPlanModeActive,
  resetPlanMode,
} from "../extensions/zflow-plan-mode/state.js"

export type {
  PlanModeState,
  PlanModeStatus,
} from "../extensions/zflow-plan-mode/state.js"
