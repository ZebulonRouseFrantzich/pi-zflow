/**
 * state.ts — Plan-mode state tracking (active/inactive) and transition guards.
 *
 * Tracks ad-hoc read-only planning mode state. This is orthogonal to
 * formal durable planning artifacts — it only controls the current shell
 * session's tool restrictions and prompt reminders.
 *
 * ## States
 *
 * - `inactive` — normal mutation-enabled mode
 * - `active` — plan mode is active; tool restrictions and bash policy apply
 *
 * State is maintained in a module-level variable that persists for the
 * lifetime of the Pi extension. Since Pi extensions reload on restart,
 * this is functionally correct — plan mode does not survive a restart,
 * which is the safe default.
 *
 * ## Usage
 *
 * ```ts
 * import { activatePlanMode, deactivatePlanMode, isPlanModeActive } from "./state.js"
 *
 * activatePlanMode("zflow-plan")
 * console.log(isPlanModeActive())  // true
 * deactivatePlanMode()
 * ```
 *
 * @module pi-zflow-plan-mode/state
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The two possible plan-mode states. */
export type PlanModeState = "inactive" | "active"

/**
 * Full status descriptor for plan mode.
 */
export interface PlanModeStatus {
  /** Current state */
  state: PlanModeState
  /** ISO 8601 timestamp when plan mode was activated, or null if inactive */
  activatedAt: string | null
  /** Which command or source activated plan mode (e.g. "zflow-plan") */
  activationSource: string | null
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let _state: PlanModeState = "inactive"
let _activatedAt: string | null = null
let _activationSource: string | null = null

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the current plan-mode status.
 */
export function getPlanModeStatus(): PlanModeStatus {
  return {
    state: _state,
    activatedAt: _activatedAt,
    activationSource: _activationSource,
  }
}

/**
 * Activate plan mode.
 *
 * Sets state to `active`, records the current ISO timestamp and the
 * activation source. If already active, this is a no-op (returns the
 * current status).
 *
 * @param source - A human-readable source identifier (e.g. "zflow-plan").
 * @returns The updated status.
 */
export function activatePlanMode(source: string): PlanModeStatus {
  if (_state === "active") {
    return getPlanModeStatus()
  }

  _state = "active"
  _activatedAt = new Date().toISOString()
  _activationSource = source

  return getPlanModeStatus()
}

/**
 * Deactivate plan mode.
 *
 * Resets state to `inactive`. If already inactive, this is a no-op.
 *
 * @returns The updated status.
 */
export function deactivatePlanMode(): PlanModeStatus {
  _state = "inactive"
  _activatedAt = null
  _activationSource = null

  return getPlanModeStatus()
}

/**
 * Convenience check for whether plan mode is active.
 */
export function isPlanModeActive(): boolean {
  return _state === "active"
}

/**
 * Reset plan mode to its default state (inactive).
 *
 * Primarily useful for testing. Resets all internal state.
 */
export function resetPlanMode(): void {
  _state = "inactive"
  _activatedAt = null
  _activationSource = null
}
