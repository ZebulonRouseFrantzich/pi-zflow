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
