/**
 * pi-zflow-core
 *
 * Shared types, config schemas, registry, version constants, and common utilities.
 * This package is a library only — it must never register Pi extensions, tools, commands, or UI.
 */

// Version constants — single source of truth for version pins
export const PI_ZFLOW_VERSION = "0.1.0" as const
export const PI_ZFLOW_CORE_VERSION = "0.1.0" as const
export const PI_ZFLOW_ARTIFACTS_VERSION = "0.1.0" as const
export const PI_ZFLOW_PROFILES_VERSION = "0.1.0" as const
export const PI_ZFLOW_PLAN_MODE_VERSION = "0.1.0" as const
export const PI_ZFLOW_AGENTS_VERSION = "0.1.0" as const
export const PI_ZFLOW_REVIEW_VERSION = "0.1.0" as const
export const PI_ZFLOW_CHANGE_WORKFLOWS_VERSION = "0.1.0" as const
export const PI_ZFLOW_RUNECONTEXT_VERSION = "0.1.0" as const
export const PI_ZFLOW_COMPACTION_VERSION = "0.1.0" as const

// Minimum supported Pi version (provisional until Phase 0 smoke testing)
export const PI_MINIMUM_VERSION = "0.74.0" as const

// Re-export runtime path resolvers and cleanup defaults
// These are also importable directly from "pi-zflow-core/runtime-paths"
export {
  DEFAULT_STALE_ARTIFACT_TTL_DAYS,
  DEFAULT_FAILED_WORKTREE_RETENTION_DAYS,
  resolveGitDir,
  inGitRepo,
  resolveRuntimeStateDir,
  resolveUserStateDir,
} from "./runtime-paths.js"

// Re-export user directory bootstrap helpers
// Also importable directly from "pi-zflow-core/user-dirs"
export {
  USER_STATE_BASE,
  USER_AGENTS_DIR,
  USER_CHAINS_DIR,
  INSTALL_MANIFEST_PATH,
  ACTIVE_PROFILE_PATH,
  ensureUserDirs,
  checkUserDirs,
  resolveAgentInstallScope,
} from "./user-dirs.js"

// Re-export worktree setup hook types, contract, and runner
// Also importable directly from "pi-zflow-core/worktree-setup-hook"
export {
  DEFAULT_HOOK_TIMEOUT_MS,
  runWorktreeSetupHook,
  classifyRepo,
} from "./worktree-setup-hook.js"

export type {
  WorktreeSetupHookContext,
  WorktreeSetupHookResult,
  WorktreeSetupHookFn,
  WorktreeSetupHookConfig,
  RepoClass,
} from "./worktree-setup-hook.js"

// Re-export path guard types, policy types, and core functions
// Also importable directly from "pi-zflow-core/path-guard"
export {
  DEFAULT_ALLOWED_ROOTS,
  DEFAULT_BLOCKED_PATTERNS,
  DEFAULT_SYMLINK_SAFETY,
  defaultPlannerArtifactPolicy,
  realpathSafe,
  isWithinAllowedRoots,
  matchesBlockedPatterns,
  canWrite,
  resolveSentinelPolicy,
} from "./path-guard.js"

export type {
  SentinelPolicy,
  AllowedRoot,
  BlockedPattern,
  SymlinkSafetyConfig,
  PlannerArtifactPolicy,
  WriteIntent,
  PathGuardContext,
  CanWriteResult,
} from "./path-guard.js"

// Re-export shared capability registry
// Also importable directly from "pi-zflow-core/registry"
export {
  getZflowRegistry,
  resetZflowRegistry,
  ZflowRegistry,
  MissingCapabilityError,
  IncompatibleCapabilityError,
  areVersionsCompatible,
} from "./registry.js"

export type {
  CapabilityClaim,
  RegisteredCapability,
  CapabilityChangeListener,
  CapabilityChangeEvent,
  RegistryDiagnostic,
  CompatibilityMode,
} from "./registry.js"

// Re-export diagnostic helpers
// Also importable directly from "pi-zflow-core/diagnostics"
export {
  formatDiagnostic,
  printRegistryDiagnostics,
  checkCapabilityConflict,
  formatMissingCapability,
  checkCommandCollision,
  printCapabilitySummary,
} from "./diagnostics.js"

// Re-export shared config schemas (types only)
// Also importable directly from "pi-zflow-core/schemas"
export type {
  LaneBinding,
  ProfileLane,
  Profile,
  ProfilesConfig,
  AgentDefinition,
  ChainDefinition,
  InstallManifest,
  ToolRegistration,
} from "./schemas.js"

// Re-export namespaced identifier helpers
// Also importable directly from "pi-zflow-core/ids"
export {
  COMMAND_PREFIX,
  TOOL_PREFIX,
  EVENT_PREFIX,
  SESSION_ENTRY_PREFIX,
  STATUS_KEY_PREFIX,
  MESSAGE_TYPE_PREFIX,
  BUILTIN_TOOLS,
  command,
  tool,
  event,
  sessionEntryType,
  statusKey,
  messageType,
  checkBuiltinToolCollision,
  checkCommandNaming,
  checkToolNaming,
} from "./ids.js"

// Re-export platform documentation builder
// Also importable directly from "pi-zflow-core/platform-docs"
export {
  buildPlatformDocsSection,
  isPlatformDocsInjected,
  DEFAULT_DOCS_MARKER,
} from "./platform-docs.js"

export type {
  PiDocPaths,
  ZflowDocPaths,
  PlatformDocsOptions,
} from "./platform-docs.js"
