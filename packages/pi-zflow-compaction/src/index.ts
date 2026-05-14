/**
 * pi-zflow-compaction
 *
 * Proactive/custom compaction hooks, compaction handoff reminders,
 * and session_before_compact integration.
 */
export const PACKAGE_VERSION = "0.1.0" as const

// Re-export rtk binary availability check and user alerting
export {
  checkRtkAvailability,
  alertRtkMissing,
  ensureRtkOrAlert,
} from "./rtk-check.js"
export type { RtkCheckResult } from "./rtk-check.js"
