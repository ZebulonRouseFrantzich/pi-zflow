/**
 * pi-zflow-agents
 *
 * Custom agent markdown, chains, skills, prompt templates,
 * prompt fragments, agent/chain setup/update commands, and
 * prompt-fragment assembly for subagent launches.
 */
export const PACKAGE_VERSION = "0.1.0" as const

// Prompt assembly
export {
  assemblePrompt,
  checkModeConflicts,
  listAvailableModes,
  listAvailableReminders,
} from "./prompt-assembly.js"

export type {
  PromptAssemblyInput,
  AssembledPrompt,
  WorkflowMode,
  ReminderId,
} from "./prompt-assembly.js"
