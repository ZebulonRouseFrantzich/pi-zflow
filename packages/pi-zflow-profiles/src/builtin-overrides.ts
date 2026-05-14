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

// ── Web access tool validation ────────────────────────────────

/**
 * Web-access tool identifiers used by pi-web-access.
 */
const WEB_ACCESS_TOOLS = new Set([
  "web_search",
  "code_search",
  "fetch_content",
  "get_search_content",
])

/**
 * Roles that are allowed to have web-access tools.
 */
const ROLES_ALLOWED_WEB_ACCESS = new Set([
  "planner-frontier",
  "plan-review",
  "review-correctness",
  "review-integration",
  "review-security",
  "review-logic",
  "review-system",
  "synthesizer",
])

/**
 * Result of a web-access tool validation.
 */
export interface WebAccessValidationResult {
  valid: boolean
  agentName: string
  allowed: boolean
  reason?: string
}

/**
 * Validate that an agent's tool list respects the web-access role policy.
 *
 * Implementation, verifier, and repo-mapper roles must not have web-access
 * tools. Planner/reviewer/research roles may have them.
 *
 * @param agentName - The agent runtime name (e.g. "zflow.planner-frontier").
 * @param tools - Comma-separated tool string or array from profile binding.
 * @returns A validation result.
 */
export function validateWebAccessScope(
  agentName: string,
  tools: string | string[] | undefined,
): WebAccessValidationResult {
  if (!tools) {
    return { valid: true, agentName, allowed: true }
  }

  const toolList = Array.isArray(tools) ? tools : tools.split(",").map(t => t.trim())
  const hasWebTools = toolList.some(t => WEB_ACCESS_TOOLS.has(t))

  if (!hasWebTools) {
    return { valid: true, agentName, allowed: true }
  }

  // Strip namespace for role matching
  const shortName = agentName
    .replace("zflow.", "")
    .replace("builtin:", "")

  // Check if this role is allowed web access
  let allowed = false
  for (const allowedRole of ROLES_ALLOWED_WEB_ACCESS) {
    if (shortName.includes(allowedRole) || shortName === allowedRole) {
      allowed = true
      break
    }
  }

  if (allowed) {
    return { valid: true, agentName, allowed: true }
  }

  return {
    valid: false,
    agentName,
    allowed: false,
    reason:
      `Agent "${agentName}" has web-access tools (${[...toolList].filter(t => WEB_ACCESS_TOOLS.has(t)).join(", ")}) ` +
      `but is not in an allowed role. Web-access is restricted to planner/review/research roles. ` +
      `Remove the web-access tools from the agent frontmatter or profile binding.`,
  }
}

/**
 * Validate web-access scope for every agent in a set of launch configs.
 *
 * @param configs - A record of agent name → LaunchAgentConfig.
 * @returns Record of validation results.
 */
export function validateAllWebAccessScopes(
  configs: Record<string, LaunchAgentConfig>,
): Record<string, WebAccessValidationResult> {
  const results: Record<string, WebAccessValidationResult> = {}

  for (const [agentName, config] of Object.entries(configs)) {
    results[agentName] = validateWebAccessScope(agentName, config.tools)
  }

  return results
}

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
 * Builtin `context-builder` override configuration.
 *
 * The context-builder provides analogous code examples for worker
 * preparation. It runs cheap and fast with read-only tools.
 *
 * - lane: `scout-cheap` — maps to a cheap/fast model lane
 * - tools: read, grep, find, ls — exploration tools only (no bash)
 * - maxOutput: 6000 — bounded output for focused example extraction
 * - returns 2–3 analogous code examples with signatures/snippets, not full file dumps
 */
export const BUILTIN_CONTEXT_BUILDER_OVERRIDE: BuiltinOverrideDefinition = {
  name: "builtin-context-builder",
  description:
    "Builtin context-builder reused via override. Lane: scout-cheap, " +
    "tools: read/grep/find/ls, maxOutput: 6000.",
  override: {
    lane: "scout-cheap",
    tools: "read, grep, find, ls",
    maxOutput: 6000,
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
  "context-builder": BUILTIN_CONTEXT_BUILDER_OVERRIDE,
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
