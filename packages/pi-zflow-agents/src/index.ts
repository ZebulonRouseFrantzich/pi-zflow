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

// Agent discovery
export {
  installAgents,
  installChains,
  installAll,
  writeInstallManifest,
  readInstallManifest,
  getInstalledAgents,
  getInstalledChains,
  getAgentPath,
  getChainPath,
  verifyDiscovery,
  uninstallAll,
} from "./agent-discovery.js"

export type {
  InstallOptions,
  InstallResult,
  InstalledAgentInfo,
  InstalledChainInfo,
  DiscoveryVerificationResult,
} from "./agent-discovery.js"

// Output conventions
export {
  getAgentRole,
  getOutputConvention,
  getOutputInstructions,
  getOrchestratorOutputInstructions,
  isKnownAgent,
  getReportAgents,
  getImplementationAgents,
  getHybridAgents,
  REPORT_AGENTS,
  IMPLEMENTATION_AGENTS,
  HYBRID_AGENTS,
  ALL_AGENTS,
  OUTPUT_CONVENTIONS,
} from "./output-conventions.js"

export type {
  AgentRole,
  OutputConvention,
} from "./output-conventions.js"

// Prompt fragment loading (async helpers for hook injection)
export {
  loadFragment,
  buildReminderInjection,
  buildModeInjection,
  fragmentExists,
} from "./prompt-fragments.js"

export type {
  ModeFragment,
} from "./prompt-fragments.js"
