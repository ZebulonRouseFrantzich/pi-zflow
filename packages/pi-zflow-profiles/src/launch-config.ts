/**
 * launch-config.ts — Resolved-agent launch config generation.
 *
 * Takes an active profile's resolved lane mappings and produces
 * launch-time agent overrides for `pi-subagents`.
 *
 * ## Usage
 *
 * ```ts
 * import { buildLaunchConfig, buildAllLaunchConfigs }
 *   from "pi-zflow-profiles/launch-config"
 *
 * const config = buildLaunchConfig(
 *   "zflow.planner-frontier",
 *   resolvedProfile,
 * )
 * // → { agent: "zflow.planner-frontier", model: "openai/gpt-5.4", ... }
 *
 * const all = buildAllLaunchConfigs(resolvedProfile)
 * // → { "zflow.planner-frontier": { ... }, "zflow.implement-routine": { ... } }
 * ```
 *
 * ## Design rules
 *
 * - All agent launches are driven by resolved runtime bindings, not hardcoded
 *   model IDs. If the binding has no resolved model, the agent is skipped
 *   (returns null) rather than falling back to a hardcoded default.
 * - Tools, maxOutput, and maxSubagentDepth from the binding take precedence
 *   over agent frontmatter defaults. The profile is the source of truth for
 *   launch-time overrides.
 * - Thinking level is inherited from the resolved lane when the agent binding
 *   does not specify it explicitly.
 *
 * @module pi-zflow-profiles/launch-config
 */

import type { ResolvedProfile } from "../extensions/zflow-profiles/profiles.js"

// ── Launch config type ──────────────────────────────────────────

/**
 * Launch-time agent configuration for `pi-subagents`.
 *
 * This is the shape that the orchestration layer passes to subagent launch
 * helpers. All fields are optional except `agent` and `model` — if `model`
 * is null (binding unresolved), the launch should be skipped.
 */
export interface LaunchAgentConfig {
  /** Agent runtime name (e.g. "zflow.planner-frontier"). */
  agent: string
  /** Concrete model identifier resolved from the active profile. */
  model: string
  /** Comma-separated list of tools the agent is allowed to use. */
  tools?: string
  /** Maximum total output tokens for this agent. */
  maxOutput?: number
  /** Maximum depth of subagent nesting. */
  maxSubagentDepth?: number
  /** Thinking/reasoning effort level. */
  thinking?: "low" | "medium" | "high"
}

// ── Launch config builders ──────────────────────────────────────

/**
 * Build a launch config for a single agent from the resolved profile.
 *
 * @param agentName - The agent runtime name (e.g. "zflow.planner-frontier").
 * @param resolvedProfile - The fully resolved active profile.
 * @returns A `LaunchAgentConfig` if the agent binding exists and has a
 *          resolved model, or `null` if the agent is not bound or its
 *          lane could not resolve a model.
 */
export function buildLaunchConfig(
  agentName: string,
  resolvedProfile: ResolvedProfile,
): LaunchAgentConfig | null {
  const binding = resolvedProfile.agentBindings[agentName]
  if (!binding) {
    return null
  }

  // If the lane could not resolve a model, skip launch
  if (!binding.resolvedModel) {
    return null
  }

  // Look up the resolved lane to inherit thinking level when the binding
  // does not override it explicitly
  const resolvedLane = resolvedProfile.resolvedLanes[binding.lane]

  return {
    agent: agentName,
    model: binding.resolvedModel,
    // Binding-level override falls back to lane-level thinking
    tools: binding.tools,
    maxOutput: binding.maxOutput,
    maxSubagentDepth: binding.maxSubagentDepth,
    thinking: resolvedLane?.thinking,
  }
}

/**
 * Build launch configs for every agent in the resolved profile.
 *
 * Agents whose lanes could not resolve are omitted from the result.
 *
 * @param resolvedProfile - The fully resolved active profile.
 * @returns A record of agent name → `LaunchAgentConfig` for all agents
 *          that have a resolved model binding.
 */
export function buildAllLaunchConfigs(
  resolvedProfile: ResolvedProfile,
): Record<string, LaunchAgentConfig> {
  const configs: Record<string, LaunchAgentConfig> = {}

  for (const agentName of Object.keys(resolvedProfile.agentBindings)) {
    const config = buildLaunchConfig(agentName, resolvedProfile)
    if (config !== null) {
      configs[agentName] = config
    }
  }

  return configs
}

// ── Launch config validation ────────────────────────────────────

/**
 * Validate that a launch config has all required fields populated.
 *
 * Strict mode enforces that `model`, `tools`, `maxOutput`, `maxSubagentDepth`,
 * and `thinking` are all present. Normal mode only checks `agent` and `model`.
 *
 * @param config - The launch config to validate.
 * @param strict - When true, enforces all optional fields are present.
 * @returns `true` if the config is valid.
 */
export function validateLaunchConfig(
  config: LaunchAgentConfig,
  strict: boolean = false,
): boolean {
  if (!config.agent || !config.model) {
    return false
  }
  if (strict) {
    if (!config.tools) return false
    if (config.maxOutput === undefined || config.maxOutput === null) return false
    if (config.maxSubagentDepth === undefined || config.maxSubagentDepth === null) return false
    if (!config.thinking) return false
  }
  return true
}
