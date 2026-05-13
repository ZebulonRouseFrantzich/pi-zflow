/**
 * depth-enforcement.ts — MaxSubagentDepth validation and enforcement.
 *
 * Prevents uncontrolled agent recursion by ensuring every agent has a
 * correct `maxSubagentDepth` value. Only agents with an explicit override
 * (currently `zflow.planner-frontier`) are permitted to spawn nested
 * subagents (depth 1). All other agents default to depth 0.
 *
 * ## Design rules from the master plan
 *
 * - `maxSubagentDepth` should default to `0` unless explicitly needed.
 * - `planner-frontier` may spawn `scout`, but ordinary workers/reviewers
 *   should not spawn nested subagents.
 * - Only `zflow.planner-frontier` gets depth 1; everyone else gets 0.
 * - Prompt assembly must not encourage nested delegation for agents
 *   whose `maxSubagentDepth` is `0`.
 *
 * ## Usage
 *
 * ```ts
 * import {
 *   validateMaxSubagentDepth,
 *   enforceDepthLimits,
 *   getDefaultMaxSubagentDepth,
 * } from "pi-zflow-profiles"
 *
 * // Validate individual agent
 * validateMaxSubagentDepth("zflow.planner-frontier", 1)  // passes
 * validateMaxSubagentDepth("zflow.verifier", 1)          // throws
 *
 * // Apply defaults and validate all configs
 * const safe = enforceDepthLimits(configs)
 * ```
 *
 * @module pi-zflow-profiles/depth-enforcement
 */

import type { LaunchAgentConfig } from "./launch-config.js"

// ── Constants ───────────────────────────────────────────────────

/**
 * Agents permitted to have maxSubagentDepth > 0 and their expected value.
 *
 * Currently only `zflow.planner-frontier` is permitted depth 1 (it may
 * spawn `scout` for reconnaissance). All other agents default to 0.
 *
 * Keyed by agent runtime name in dotted notation (e.g. `zflow.planner-frontier`).
 */
export const KNOWN_DEPTH_OVERRIDES: Record<string, number> = {
  "zflow.planner-frontier": 1,
} as const

// ── Default resolution ──────────────────────────────────────────

/**
 * Get the default maxSubagentDepth for a given agent.
 *
 * Returns 1 for `zflow.planner-frontier`, 0 for all others.
 *
 * @param agentName - The agent runtime name (e.g. "zflow.planner-frontier").
 * @returns The expected default maxSubagentDepth.
 */
export function getDefaultMaxSubagentDepth(agentName: string): number {
  if (agentName in KNOWN_DEPTH_OVERRIDES) {
    return KNOWN_DEPTH_OVERRIDES[agentName]
  }
  return 0
}

// ── Validation ──────────────────────────────────────────────────

/**
 * Validate that an agent's maxSubagentDepth matches its expected value.
 *
 * Throws a descriptive error if the agent is configured with a depth that
 * differs from the plan's expected value. This catches accidental
 * misconfiguration in agent frontmatter or profile bindings.
 *
 * @param agentName - The agent runtime name.
 * @param depth - The configured maxSubagentDepth value.
 * @throws {Error} If the depth is unexpected for this agent role.
 */
export function validateMaxSubagentDepth(
  agentName: string,
  depth: number,
): void {
  const expected = getDefaultMaxSubagentDepth(agentName)

  if (depth !== expected) {
    const roleNote =
      agentName === "zflow.planner-frontier"
        ? "planner-frontier is permitted depth 1 (may spawn scout for reconnaissance)."
        : `${agentName} is a worker/reviewer agent and must not spawn nested subagents.`

    throw new Error(
      `Invalid maxSubagentDepth for ${agentName}: ` +
        `expected ${expected}, got ${depth}. ` +
        `${roleNote} Set maxSubagentDepth to ${expected} in the agent frontmatter or profile binding.`,
    )
  }
}

// ── Enforcement ─────────────────────────────────────────────────

/**
 * Apply the correct default maxSubagentDepth to a single launch config
 * if it is not already set, then validate it.
 *
 * @param config - The launch config to normalize.
 * @returns A new config with maxSubagentDepth populated and validated.
 * @throws {Error} If the config's maxSubagentDepth is present but invalid.
 */
export function applyDefaultMaxSubagentDepth(
  config: LaunchAgentConfig,
): LaunchAgentConfig {
  const depth =
    config.maxSubagentDepth ?? getDefaultMaxSubagentDepth(config.agent)

  validateMaxSubagentDepth(config.agent, depth)

  return {
    ...config,
    maxSubagentDepth: depth,
  }
}

/**
 * Enforce depth limits across a set of launch configs.
 *
 * For each config:
 * 1. If maxSubagentDepth is not set, apply the default for that agent.
 * 2. If maxSubagentDepth is set, validate it matches expectations.
 * 3. Throw if any config fails validation.
 *
 * @param configs - A record of agent name → launch config.
 * @returns A new record with all maxSubagentDepth values populated and valid.
 * @throws {Error} If any config has an invalid maxSubagentDepth.
 */
export function enforceDepthLimits(
  configs: Record<string, LaunchAgentConfig>,
): Record<string, LaunchAgentConfig> {
  const result: Record<string, LaunchAgentConfig> = {}

  for (const [agentName, config] of Object.entries(configs)) {
    result[agentName] = applyDefaultMaxSubagentDepth(config)
  }

  return result
}
