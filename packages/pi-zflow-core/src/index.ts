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
