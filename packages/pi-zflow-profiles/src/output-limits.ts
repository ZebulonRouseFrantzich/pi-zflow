/**
 * output-limits.ts — MaxOutput validation and enforcement.
 *
 * Prevents runaway output by ensuring every agent has a correct
 * `maxOutput` value aligned with the plan's required targets.
 * When no maxOutput is configured, the enforcement layer applies
 * the plan's default for that agent role.
 *
 * ## Design rules from the master plan
 *
 * - All agents must have bounded outputs.
 * - maxOutput values must match the plan's required targets per role.
 * - Launch-time overrides from the active profile take precedence over
 *   agent frontmatter defaults, but must still satisfy validation.
 * - Builtin agents (scout, context-builder) use their override configs
 *   which already set maxOutput.
 *
 * ## Usage
 *
 * ```ts
 * import { validateMaxOutput, enforceOutputLimits, getDefaultMaxOutput }
 *   from "pi-zflow-profiles"
 *
 * // Validate individual agent
 * validateMaxOutput("zflow.planner-frontier", 12000)  // passes
 * validateMaxOutput("zflow.verifier", 12000)           // throws
 *
 * // Apply defaults and validate all configs
 * const safe = enforceOutputLimits(configs)
 * ```
 *
 * @module pi-zflow-profiles/output-limits
 */

import type { LaunchAgentConfig } from "./launch-config.js"

// ── Constants ───────────────────────────────────────────────────

/**
 * Expected maxOutput values per agent, as specified in the Phase 4 plan.
 *
 * Keyed by agent runtime name (e.g. "zflow.planner-frontier").
 * The `builtin-scout` and `builtin-context-builder` entries serve as
 * a reference; their values are applied through the builtin-overrides
 * module rather than this enforcement layer.
 */
export const EXPECTED_MAX_OUTPUT: Record<string, number> = {
  // Planning tier
  "zflow.planner-frontier": 12000,
  "zflow.plan-validator": 6000,
  "zflow.repo-mapper": 6000,

  // Implementation tier
  "zflow.implement-routine": 8000,
  "zflow.implement-hard": 10000,
  "zflow.verifier": 6000,

  // Code review tier
  "zflow.review-correctness": 10000,
  "zflow.review-integration": 8000,
  "zflow.review-security": 8000,
  "zflow.review-logic": 10000,
  "zflow.review-system": 12000,

  // Plan review tier
  "zflow.plan-review-correctness": 10000,
  "zflow.plan-review-integration": 8000,
  "zflow.plan-review-feasibility": 10000,

  // Synthesis tier
  "zflow.synthesizer": 12000,

  // Builtin agents (reference; enforced via builtin-overrides module).
  // Support both historical dash names and Pi runtime colon names.
  "builtin-scout": 6000,
  "builtin-context-builder": 6000,
  "builtin:scout": 6000,
  "builtin:context-builder": 6000,
} as const

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Strip namespace prefixes from an agent name, returning just the short name.
 *
 * Handles `zflow.*` (e.g. "zflow.planner-frontier" → "planner-frontier"),
 * `builtin:*` (e.g. "builtin:scout" → "scout"), and historical
 * `builtin-*` (e.g. "builtin-scout" → "scout") prefixes.
 */
function shortName(agentName: string): string {
  let name = agentName
  if (name.startsWith("zflow.")) name = name.slice(6)
  if (name.startsWith("builtin:")) name = name.slice(8)
  if (name.startsWith("builtin-")) name = name.slice(8)
  return name
}

/**
 * Look up the expected maxOutput for an agent name, trying the full
 * dotted name first and falling back to the short name.
 */
function lookupExpected(name: string): number | undefined {
  // Try the full name as-is first (e.g. "zflow.planner-frontier")
  if (name in EXPECTED_MAX_OUTPUT) {
    return EXPECTED_MAX_OUTPUT[name]
  }
  // Try the short name (e.g. "planner-frontier")
  const short = shortName(name)
  if (short !== name && short in EXPECTED_MAX_OUTPUT) {
    return EXPECTED_MAX_OUTPUT[short]
  }
  // Try with zflow. prefix (e.g. if someone passes "planner-frontier")
  const prefixed = `zflow.${name}`
  if (prefixed !== name && prefixed in EXPECTED_MAX_OUTPUT) {
    return EXPECTED_MAX_OUTPUT[prefixed]
  }
  return undefined
}

// ── Default resolution ──────────────────────────────────────────

/**
 * Get the expected default maxOutput for a given agent.
 *
 * Returns the plan's target value for known agents, or `undefined`
 * for unknown agents (which will be rejected by validation).
 *
 * @param agentName - The agent runtime name (e.g. "zflow.planner-frontier").
 * @returns The expected maxOutput, or undefined if unknown.
 */
export function getDefaultMaxOutput(agentName: string): number | undefined {
  return lookupExpected(agentName)
}

// ── Validation ──────────────────────────────────────────────────

/**
 * Result of a maxOutput validation.
 */
export interface MaxOutputValidationResult {
  valid: boolean
  agentName: string
  configuredOutput: number | undefined
  expectedOutput: number | undefined
  errors: string[]
}

/**
 * Validate that an agent's maxOutput matches the plan's expected value.
 *
 * Returns a validation result with error details rather than throwing,
 * so callers can collect all validation errors before reporting them.
 *
 * @param agentName - The agent runtime name.
 * @param output - The configured maxOutput value (undefined means not set).
 * @returns A validation result with error details.
 */
export function validateMaxOutput(
  agentName: string,
  output: number | undefined,
): MaxOutputValidationResult {
  const errors: string[] = []
  const expected = lookupExpected(agentName)

  if (expected === undefined) {
    errors.push(
      `Unknown agent "${agentName}": no expected maxOutput value defined. ` +
        `Add an entry to EXPECTED_MAX_OUTPUT in output-limits.ts or correct the agent name.`,
    )
    return {
      valid: false,
      agentName,
      configuredOutput: output,
      expectedOutput: undefined,
      errors,
    }
  }

  if (output === undefined) {
    errors.push(
      `Agent "${agentName}" has no maxOutput configured. ` +
        `Expected ${expected}. Set maxOutput in the agent frontmatter or profile binding.`,
    )
    return {
      valid: false,
      agentName,
      configuredOutput: undefined,
      expectedOutput: expected,
      errors,
    }
  }

  if (output !== expected) {
    errors.push(
      `Invalid maxOutput for "${agentName}": expected ${expected}, got ${output}. ` +
        `Update the agent frontmatter or profile binding to use ${expected}.`,
    )
    return {
      valid: false,
      agentName,
      configuredOutput: output,
      expectedOutput: expected,
      errors,
    }
  }

  return {
    valid: true,
    agentName,
    configuredOutput: output,
    expectedOutput: expected,
    errors: [],
  }
}

/**
 * Validate that an agent's maxOutput matches the plan's expected value.
 *
 * Throws on first validation failure. Use `validateMaxOutput` for
 * batched collection.
 *
 * @param agentName - The agent runtime name.
 * @param output - The configured maxOutput value.
 * @throws {Error} If the maxOutput is missing or does not match expectations.
 */
export function validateMaxOutputStrict(
  agentName: string,
  output: number | undefined,
): void {
  const result = validateMaxOutput(agentName, output)
  if (!result.valid) {
    throw new Error(result.errors.join(" "))
  }
}

/**
 * Validate maxOutput for every agent in a set of configs.
 *
 * Returns all validation results, including valid ones, so callers
 * can inspect the full picture.
 *
 * @param configs - A record of agent name → LaunchAgentConfig.
 * @returns A record of agent name → validation result.
 */
export function validateAllMaxOutputs(
  configs: Record<string, LaunchAgentConfig>,
): Record<string, MaxOutputValidationResult> {
  const results: Record<string, MaxOutputValidationResult> = {}

  for (const [agentName, config] of Object.entries(configs)) {
    results[agentName] = validateMaxOutput(agentName, config.maxOutput)
  }

  return results
}

// ── Enforcement ─────────────────────────────────────────────────

/**
 * Apply the expected maxOutput to a single launch config if it is not
 * already set, then validate it.
 *
 * @param config - The launch config to normalize.
 * @returns A new config with maxOutput populated and validated.
 * @throws {Error} If the config's maxOutput is present but does not match
 *         the expected value, or if the agent is unknown.
 */
export function applyDefaultMaxOutput(
  config: LaunchAgentConfig,
): LaunchAgentConfig {
  const expected = lookupExpected(config.agent)

  if (expected === undefined) {
    throw new Error(
      `Cannot apply maxOutput for unknown agent "${config.agent}". ` +
        `No expected maxOutput value is defined in EXPECTED_MAX_OUTPUT.`,
    )
  }

  const output = config.maxOutput ?? expected

  // If the user explicitly set a wrong value, reject it
  if (config.maxOutput !== undefined && config.maxOutput !== expected) {
    throw new Error(
      `Invalid maxOutput for "${config.agent}": ` +
        `expected ${expected}, got ${config.maxOutput}. ` +
        `Set maxOutput to ${expected} in the agent frontmatter or profile binding ` +
        `or omit it to use the default.`,
    )
  }

  return {
    ...config,
    maxOutput: output,
  }
}

/**
 * Enforce output limits across a set of launch configs.
 *
 * For each config:
 * 1. If maxOutput is not set, apply the default for that agent.
 * 2. If maxOutput is set, validate it matches expectations.
 * 3. Throw if any config fails validation.
 *
 * @param configs - A record of agent name → launch config.
 * @returns A new record with all maxOutput values populated and valid.
 * @throws {Error} If any config has an invalid or missing maxOutput for
 *         an unknown agent, or if the configured value does not match.
 */
export function enforceOutputLimits(
  configs: Record<string, LaunchAgentConfig>,
): Record<string, LaunchAgentConfig> {
  const result: Record<string, LaunchAgentConfig> = {}

  for (const [agentName, config] of Object.entries(configs)) {
    result[agentName] = applyDefaultMaxOutput(config)
  }

  return result
}
