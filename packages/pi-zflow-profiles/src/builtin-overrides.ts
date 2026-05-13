/**
 * builtin-overrides.ts — Override configurations for builtin pi-subagents agents.
 *
 * Builtin agents like `scout` and `context-builder` are reused via
 * override configuration rather than being forked or reimplemented.
 * This module defines those overrides and provides helpers to merge
 * them with resolved profile launch configs.
 *
 * ## Design rules
 *
 * - Overrides follow the same shape as `LaunchAgentConfig` but are
 *   partial — they only specify the fields that differ from defaults.
 * - Overrides are applied ON TOP of the resolved launch config from the
 *   profile. Profile bindings take precedence where they conflict.
 * - Unknown builtins return `null` from `getBuiltinOverride`.
 * - New builtin overrides should be added here and exported.
 *
 * ## Usage
 *
 * ```ts
 * import { getBuiltinOverride, applyBuiltinOverride } from "pi-zflow-profiles"
 *
 * const override = getBuiltinOverride("scout")
 * if (override) {
 *   const finalConfig = applyBuiltinOverride(baseConfig, override)
 * }
 * ```
 *
 * @module pi-zflow-profiles/builtin-overrides
 */

import type { LaunchAgentConfig } from "./launch-config.js"

// ── Types ───────────────────────────────────────────────────────

/**
 * Override configuration for a builtin pi-subagents agent.
 *
 * Partial shape that fills in or overrides fields from the resolved
 * profile's `LaunchAgentConfig`. All fields are optional; only the
 * fields specified will be applied.
 */
export interface BuiltinAgentOverride {
  /** Lane to use for this agent (e.g. "scout-cheap"). */
  lane?: string
  /** Comma-separated list of tools to allow. */
  tools?: string
  /** Maximum total output tokens. */
  maxOutput?: number
  /** Maximum subagent nesting depth. */
  maxSubagentDepth?: number
}

/**
 * Full override definition including metadata.
 */
export interface BuiltinOverrideDefinition {
  /** Human-readable name for the override. */
  name: string
  /** Description of what the override does and why. */
  description: string
  /** The actual override values. */
  override: BuiltinAgentOverride
}

// ── Builtin override registry ───────────────────────────────────

/**
 * Builtin `scout` override configuration.
 *
 * The scout is the reconnaissance agent used for codebase exploration
 * before planning or implementation. It runs cheap and fast with no
 * subagent nesting.
 *
 * - lane: `scout-cheap` — maps to a cheap/fast model lane
 * - tools: read, grep, find, ls, bash — exploration tools only
 * - maxOutput: 6000 — bounded output for focused reconnaissance
 * - maxSubagentDepth: 0 — no nested subagents
 */
export const BUILTIN_SCOUT_OVERRIDE: BuiltinOverrideDefinition = {
  name: "builtin-scout",
  description:
    "Builtin scout reused via override. Lane: scout-cheap, " +
    "tools: read/grep/find/ls/bash, maxOutput: 6000, maxSubagentDepth: 0.",
  override: {
    lane: "scout-cheap",
    tools: "read, grep, find, ls, bash",
    maxOutput: 6000,
    maxSubagentDepth: 0,
  },
}

/**
 * Registry of all builtin agent overrides.
 *
 * Keyed by the pi-subagents builtin agent name (e.g. "scout", "context-builder").
 * Add new builtin overrides here as they are implemented.
 */
const BUILTIN_OVERRIDE_REGISTRY: Record<string, BuiltinOverrideDefinition> = {
  scout: BUILTIN_SCOUT_OVERRIDE,
}

// ── Public helpers ──────────────────────────────────────────────

/**
 * Get the override definition for a builtin agent by name.
 *
 * @param agentName - The pi-subagents builtin agent name (e.g. "scout").
 * @returns The override definition, or `null` if no override is registered
 *          for the given agent name.
 */
export function getBuiltinOverride(
  agentName: string,
): BuiltinOverrideDefinition | null {
  return BUILTIN_OVERRIDE_REGISTRY[agentName] ?? null
}

/**
 * Apply a builtin override on top of a resolved launch config.
 *
 * Fields from the override are merged into the base config. The base
 * config's values take precedence for `tools`, `maxOutput`, and
 * `maxSubagentDepth` — the override only fills in missing values.
 *
 * The `lane` field from the override is informational and not part of
 * the `LaunchAgentConfig` type, so it is passed through via the
 * return value's `agent` field metadata comment.
 *
 * @param baseConfig - The resolved launch config from the profile.
 * @param overrideDef - The builtin override definition to apply.
 * @returns A new `LaunchAgentConfig` with override values merged.
 */
export function applyBuiltinOverride(
  baseConfig: LaunchAgentConfig,
  overrideDef: BuiltinOverrideDefinition,
): LaunchAgentConfig {
  const ov = overrideDef.override
  return {
    agent: baseConfig.agent,
    model: baseConfig.model,
    tools: baseConfig.tools ?? ov.tools,
    maxOutput: baseConfig.maxOutput ?? ov.maxOutput,
    maxSubagentDepth: baseConfig.maxSubagentDepth ?? ov.maxSubagentDepth,
    thinking: baseConfig.thinking,
  }
}

/**
 * Check whether a given builtin agent name has a registered override.
 *
 * @param agentName - The pi-subagents builtin agent name.
 * @returns `true` if an override is registered for this agent.
 */
export function hasBuiltinOverride(agentName: string): boolean {
  return agentName in BUILTIN_OVERRIDE_REGISTRY
}

/**
 * Get all registered builtin override definitions.
 *
 * @returns A record of agent name → override definition.
 */
export function getAllBuiltinOverrides(): Record<
  string,
  BuiltinOverrideDefinition
> {
  return { ...BUILTIN_OVERRIDE_REGISTRY }
}

/**
 * Get a simplified override shape (just the override values, no metadata)
 * for consumption by the orchestration layer.
 *
 * @param agentName - The pi-subagents builtin agent name.
 * @returns The `BuiltinAgentOverride` values, or `null` if not registered.
 */
export function getBuiltinOverrideValues(
  agentName: string,
): BuiltinAgentOverride | null {
  const def = BUILTIN_OVERRIDE_REGISTRY[agentName]
  return def ? { ...def.override } : null
}
