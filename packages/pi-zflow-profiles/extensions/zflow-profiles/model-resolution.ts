/**
 * model-resolution.ts — Lane resolution engine.
 *
 * Turns logical lane definitions (`NormalizedLaneDefinition`) into
 * concrete machine-usable model bindings (`ResolvedLane`) by walking
 * the `preferredModels` list and selecting the first candidate that
 * passes all capability and availability checks.
 *
 * ## Resolution algorithm (per lane)
 *
 * 1. Walk `preferredModels` in order.
 * 2. For each candidate, check:
 *    - Model exists in the runtime registry
 *    - Authentication/config is present
 *    - Capability requirements are satisfied (tools, text, output window, etc.)
 *    - Thinking level is compatible (or acceptable clamping)
 * 3. First valid candidate wins.
 * 4. If no candidate resolves:
 *    - Required lane → `unresolved-required` (activation must fail)
 *    - Optional lane → `disabled-optional` (warning, continue)
 *
 * ## Design rules
 *
 * - Required unresolved lanes must cause activation failure.
 * - Optional unresolved lanes are disabled with a recorded reason.
 * - `worker-strong` must never silently degrade to `worker-cheap`.
 * - Conservative lanes reject thinking downgrades.
 *
 * @module pi-zflow-profiles/model-resolution
 */

import type {
  NormalizedLaneDefinition,
  NormalizedProfileDefinition,
  NormalizedAgentBinding,
  ModelRegistry,
  ResolvedLane,
  ResolvedAgentBinding,
  ResolvedProfile,
  CapabilityRequirements,
} from "./profiles.js"

import {
  validateLaneCandidate,
  checkThinkingCompatibility,
  CONSERVATIVE_LANES,
} from "./capabilities.js"

// Re-export for backward compatibility with consumers from Task 2.3
export { CONSERVATIVE_LANES } from "./capabilities.js"
export type { ThinkingCompatibilityResult } from "./capabilities.js"

/**
 * Legacy wrapper for `checkThinkingCompatibility`.
 *
 * @deprecated Use `checkThinkingCompatibility` from the capabilities module instead.
 */
import { checkThinkingCompatibility as _checkThinking } from "./capabilities.js"
import type { ModelInfo } from "./profiles.js"
export function isModelThinkingCompatible(
  model: ModelInfo,
  requestedLevel?: "low" | "medium" | "high",
  isConservative: boolean = false,
): ThinkingCompatibilityResult {
  return _checkThinking(
    model.thinkingCapability,
    requestedLevel,
    isConservative,
    model.id,
  )
}

// ── Candidate validation ────────────────────────────────────────

/**
 * Result of checking a single candidate model against lane requirements.
 */
interface CandidateCheckResult {
  valid: boolean
  reasons: string[]
}

/**
 * Validate a candidate model against lane requirements.
 *
 * Delegates to `validateLaneCandidate` from the capabilities module for
 * the actual availability and capability checks.
 *
 * @param modelId - The candidate model identifier.
 * @param registry - The model registry to query.
 * @param lane - The lane definition being resolved.
 * @param laneName - The lane name (for conservative detection).
 * @param bindingConstraints - Optional aggregate constraints from agent
 *        bindings bound to this lane.
 * @returns Check result with reasons for rejection.
 */
function checkCandidate(
  modelId: string,
  registry: ModelRegistry,
  lane: NormalizedLaneDefinition,
  laneName: string,
  bindingConstraints?: { maxOutput?: number; maxSubagentDepth?: number },
): CandidateCheckResult {
  const model = registry.getModel(modelId)

  // Build capability requirements from the lane definition
  const requirements: CapabilityRequirements = {
    requiresTools: true,
    requiresText: true,
    requiredThinking: lane.thinking,
    isConservativeLane: CONSERVATIVE_LANES.has(laneName),
    // Incorporate agent binding constraints: the model must be able to
    // produce enough output tokens for the most demanding agent bound to
    // this lane.
    minOutput: bindingConstraints?.maxOutput,
  }

  const result = validateLaneCandidate(modelId, model, requirements)
  return { valid: result.valid, reasons: result.reasons }
}

// ── Single lane resolution ───────────────────────────────────────

/**
 * Resolve a single logical lane to a concrete model.
 *
 * Walks the lane's `preferredModels` list in order and returns the
 * first candidate that passes all checks.
 *
 * @param laneName - The lane name (e.g., "planning-frontier").
 * @param lane - The normalized lane definition.
 * @param registry - The model registry for capability lookups.
 * @param bindingConstraints - Optional aggregate constraints from agent
 *        bindings bound to this lane (e.g., maxOutput).
 * @returns The resolved lane result.
 */
export function resolveLane(
  laneName: string,
  lane: NormalizedLaneDefinition,
  registry: ModelRegistry,
  bindingConstraints?: { maxOutput?: number; maxSubagentDepth?: number },
): ResolvedLane {
  // Walk preferredModels in order
  for (const modelId of lane.preferredModels) {
    const check = checkCandidate(modelId, registry, lane, laneName, bindingConstraints)
    if (check.valid) {
      // Determine effective thinking level from the model
      const model = registry.getModel(modelId)!
      const isConservative = CONSERVATIVE_LANES.has(laneName)
      const thinkingCheck = checkThinkingCompatibility(
        model.thinkingCapability,
        lane.thinking,
        isConservative,
        model.id,
      )

      return {
        lane: laneName,
        model: modelId,
        required: lane.required,
        optional: lane.optional,
        thinking: thinkingCheck.effectiveLevel,
        status: "resolved",
        reason: thinkingCheck.reason || undefined,
      }
    }
  }

  // No candidate resolved
  const allReasons: string[] = []
  for (const modelId of lane.preferredModels) {
    const check = checkCandidate(modelId, registry, lane, laneName, bindingConstraints)
    allReasons.push(...check.reasons)
  }

  const uniqueReasons = [...new Set(allReasons)]
  const reason = uniqueReasons.length > 0
    ? uniqueReasons.join("; ")
    : "No preferred models defined for this lane"

  if (!lane.optional) {
    return {
      lane: laneName,
      model: null,
      required: true,
      optional: false,
      thinking: lane.thinking,
      status: "unresolved-required",
      reason: `Required lane unresolved: ${reason}`,
    }
  }

  return {
    lane: laneName,
    model: null,
    required: false,
    optional: true,
    thinking: lane.thinking,
    status: "disabled-optional",
    reason: `Optional lane disabled: ${reason}`,
  }
}

// ── Resolve all lanes in a profile ──────────────────────────────

/**
 * Aggregate agent binding constraints for each lane.
 *
 * For each lane, looks at all agent bindings that reference it and
 * computes the maximum `maxOutput` and `maxSubagentDepth` values.
 * These become capability constraints on the lane's model candidate
 * selection: the chosen model must be capable enough for the most
 * demanding agent bound to that lane.
 *
 * @param profile - The normalized profile definition.
 * @returns A map of lane name to aggregated binding constraints.
 */
function aggregateBindingConstraints(
  profile: NormalizedProfileDefinition,
): Record<string, { maxOutput?: number; maxSubagentDepth?: number }> {
  const constraints: Record<
    string,
    { maxOutput?: number; maxSubagentDepth?: number }
  > = {}

  for (const binding of Object.values(profile.agentBindings)) {
    const existing = constraints[binding.lane] ?? {}
    const maxOutput =
      binding.maxOutput !== undefined
        ? Math.max(existing.maxOutput ?? 0, binding.maxOutput)
        : existing.maxOutput
    const maxSubagentDepth =
      binding.maxSubagentDepth !== undefined
        ? Math.max(existing.maxSubagentDepth ?? 0, binding.maxSubagentDepth)
        : existing.maxSubagentDepth
    constraints[binding.lane] = {
      ...(maxOutput !== undefined ? { maxOutput } : {}),
      ...(maxSubagentDepth !== undefined ? { maxSubagentDepth } : {}),
    }
  }

  return constraints
}

/**
 * Resolve all lanes defined in a profile.
 *
 * @param profile - The normalized profile definition.
 * @param registry - The model registry for capability lookups.
 * @returns A record of lane name → resolved lane result.
 */
export function resolveProfileLanes(
  profile: NormalizedProfileDefinition,
  registry: ModelRegistry,
): Record<string, ResolvedLane> {
  // Aggregate agent binding constraints so lane resolution considers
  // what the most demanding agent needs
  const bindingConstraints = aggregateBindingConstraints(profile)

  const resolved: Record<string, ResolvedLane> = {}
  for (const [laneName, lane] of Object.entries(profile.lanes)) {
    resolved[laneName] = resolveLane(laneName, lane, registry, bindingConstraints[laneName])
  }
  return resolved
}

// ── Agent binding resolution ────────────────────────────────────

/**
 * Resolve all agent bindings in a profile against their resolved lanes.
 *
 * For each agent binding, looks up the resolved lane and maps the
 * lane's model to the agent binding. If the lane was not resolved,
 * the agent binding gets `resolvedModel: null` and inherits the lane's
 * status.
 *
 * @param profile - The normalized profile definition.
 * @param resolvedLanes - The resolved lanes (output of `resolveProfileLanes`).
 * @returns A record of agent name → resolved agent binding.
 */
export function resolveAgentBindings(
  profile: NormalizedProfileDefinition,
  resolvedLanes: Record<string, ResolvedLane>,
): Record<string, ResolvedAgentBinding> {
  const resolved: Record<string, ResolvedAgentBinding> = {}

  for (const [agentName, binding] of Object.entries(profile.agentBindings)) {
    const laneResult = resolvedLanes[binding.lane]

    if (!laneResult) {
      // Lane not defined in profile (shouldn't happen if validation passed)
      resolved[agentName] = {
        agent: agentName,
        lane: binding.lane,
        resolvedModel: null,
        optional: binding.optional,
        tools: binding.tools,
        maxOutput: binding.maxOutput,
        maxSubagentDepth: binding.maxSubagentDepth,
        status: "unresolved-required",
        reason: `Referenced lane "${binding.lane}" not found in profile lanes`,
      }
      continue
    }

    resolved[agentName] = {
      agent: agentName,
      lane: binding.lane,
      resolvedModel: laneResult.model,
      optional: binding.optional,
      tools: binding.tools,
      maxOutput: binding.maxOutput,
      maxSubagentDepth: binding.maxSubagentDepth,
      status: laneResult.status,
      reason: laneResult.reason,
    }
  }

  return resolved
}

// ── Full profile resolution ─────────────────────────────────────

/**
 * Fully resolve a profile: resolve all lanes and all agent bindings.
 *
 * @param profileName - The name of the profile being resolved.
 * @param profile - The normalized profile definition.
 * @param sourcePath - The file path the profile was loaded from.
 * @param registry - The model registry for capability lookups.
 * @returns The fully resolved profile.
 */
export function resolveProfile(
  profileName: string,
  profile: NormalizedProfileDefinition,
  sourcePath: string,
  registry: ModelRegistry,
): ResolvedProfile {
  const resolvedLanes = resolveProfileLanes(profile, registry)
  const agentBindings = resolveAgentBindings(profile, resolvedLanes)

  return {
    profileName,
    sourcePath,
    resolvedAt: new Date().toISOString(),
    resolvedLanes,
    agentBindings,
  }
}

/**
 * Check whether a resolved profile has any required lanes that failed
 * to resolve.
 *
 * @param resolved - The resolved profile to check.
 * @returns `true` if any required lane is unresolved.
 */
export function hasUnresolvedRequiredLanes(
  resolved: ResolvedProfile,
): boolean {
  return Object.values(resolved.resolvedLanes).some(
    (lane) => lane.status === "unresolved-required",
  )
}

/**
 * Get a human-readable summary of all lane resolution statuses.
 *
 * @param resolved - The resolved profile to summarize.
 * @returns An array of status lines (one per lane).
 */
export function getLaneStatusSummary(
  resolved: ResolvedProfile,
): string[] {
  const lines: string[] = []
  for (const [laneName, lane] of Object.entries(resolved.resolvedLanes)) {
    switch (lane.status) {
      case "resolved":
        lines.push(`- ${laneName} → ${lane.model} (${lane.thinking ?? "medium"})`)
        break
      case "disabled-optional":
        lines.push(`- ${laneName} ⚠ disabled (${lane.reason ?? "optional lane unresolved"})`)
        break
      case "unresolved-required":
        lines.push(`- ${laneName} ✗ FAILED (${lane.reason ?? "required lane unresolved"})`)
        break
    }
  }
  return lines
}
