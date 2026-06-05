/**
 * workflow-state.ts — in-memory workflow mode and reminder state.
 */

import type {
  ReminderId,
  ModeFragment,
} from "../prompt-fragments.js"

let _activeWorkflowMode: ModeFragment | null = null
let _activeReminders: Set<ReminderId> = new Set()

/**
 * Set the current active workflow mode.
 * The before_agent_start hook will inject the corresponding mode fragment.
 */
export function setActiveWorkflowMode(mode: ModeFragment | null): void {
  _activeWorkflowMode = mode
}

/**
 * Get the current active workflow mode.
 */
export function getActiveWorkflowMode(): ModeFragment | null {
  return _activeWorkflowMode
}

/**
 * Whether workflow-scoped tool guards should currently be active.
 *
 * The change-workflows path guard is intentionally scoped to active zflow
 * workflow modes so ordinary non-zflow conversations keep the normal Pi bash
 * experience.
 */
export function isWorkflowToolGuardActive(): boolean {
  return _activeWorkflowMode !== null
}

/**
 * Activate a runtime reminder. Duplicates are ignored.
 */
export function addReminder(reminder: ReminderId): void {
  _activeReminders.add(reminder)
}

/**
 * Deactivate a runtime reminder.
 */
export function removeReminder(reminder: ReminderId): void {
  _activeReminders.delete(reminder)
}

/**
 * Get all currently active reminders.
 */
export function getActiveReminders(): ReminderId[] {
  return [..._activeReminders]
}

/**
 * Clear all active reminders.
 */
export function clearReminders(): void {
  _activeReminders.clear()
}

/**
 * Reset both mode and reminders (clean slate).
 */
export function resetWorkflowState(): void {
  _activeWorkflowMode = null
  _activeReminders.clear()
}
