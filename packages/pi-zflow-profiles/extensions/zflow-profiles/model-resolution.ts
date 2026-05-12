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
 *    - Capability requirements are satisfied (tools, text, etc.)
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
  ModelInfo,
  ResolvedLane,
  ResolvedAgentBinding,
  ResolvedProfile,
  LaneStatus,
} from "./profiles.js"

// ── Constants ───────────────────────────────────────────────────

/** Thinking capability levels mapped to numeric values for comparison. */
const THINKING_SCORE: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
}

/**
 * Lane names where thinking downgrades are NOT acceptable.
 * These are roles that genuinely require the requested reasoning depth.
 */
export const CONSERVATIVE_LANES = new Set<string>([
  "planning-frontier",
  "worker-strong",
  "review-security",
  "synthesis-frontier",
])

// ── Thinking compatibility ───────────────────────────────────────

/**
 * Result of a thinking compatibility check.
 */
export interface ThinkingCheckResult {
  /** Whether the model's thinking capability is acceptable. */
  compatible: boolean
  /**
   * The effective thinking level after clamping.
   * - If model's capability >= requested → model's capability (may be higher)
   * - If model's capability < requested and acceptable → model's capability
   * - If incompatible → the originally requested level (not used)
   */
  effectiveLevel: "low" | "medium" | "high"
  /** Human-readable reason if clamped or incompatible. */
  reason: string
}

/**
 * Map a thinking level string to its numeric score.
 */
function scoreThinking(level: string): number {
  return THINKING_SCORE[level] ?? 0
}

/**
 * Check whether a model's thinking capability is compatible with a
 * lane's requested thinking level.
 *
 * Rules:
 * - If the lane does not specify a thinking level → always compatible,
 *   effective level defaults to `DEFAULT_THINKING` ("medium").
 * - If the model's capability is >= requested → compatible (clamping up
 *   is always acceptable; more reasoning is fine).
 * - If the model's capability is < requested → the downgrade is only
 *   acceptable for non-conservative lanes.
 *
 * @param model - The candidate model's info.
 * @param requestedLevel - The thinking level requested by the lane (optional).
 * @param isConservative - Whether the lane is conservative (rejects downgrades).
 * @returns The compatibility check result.
 */
export function isModelThinkingCompatible(
  model: ModelInfo,
  requestedLevel?: "low" | "medium" | "high",
  isConservative: boolean = false,
): ThinkingCheckResult {
  // No request → always compatible, use model's capability or default
  if (!requestedLevel) {
    return {
      compatible: true,
      effectiveLevel: model.thinkingCapability,
      reason: "",
    }
  }

  const requestedScore = scoreThinking(requestedLevel)
  const modelScore = scoreThinking(model.thinkingCapability)

  // Model meets or exceeds requested level → compatible (clamp up is fine)
  if (modelScore >= requestedScore) {
    const reason =
      modelScore > requestedScore
        ? `Model "${model.id}" provides "${model.thinkingCapability}" thinking (exceeds requested "${requestedLevel}") — acceptable overprovisioning.`
        : ""
    return {
      compatible: true,
      effectiveLevel: model.thinkingCapability,
      reason,
    }
  }

  // Model falls short of requested level
  if (isConservative) {
    return {
      compatible: false,
      effectiveLevel: requestedLevel,
      reason: `Conservative lane requires "${requestedLevel}" thinking, but model "${model.id}" only provides "${model.thinkingCapability}". Downgrade not permitted for this lane.`,
    }
  }

  // Non-conservative lane: accept with warning
  return {
    compatible: true,
    effectiveLevel: model.thinkingCapability,
    reason: `Accepted: model "${model.id}" provides "${model.thinkingCapability}" thinking (requested "${requestedLevel}") — acceptable clamp for non-conservative lane.`,
  }
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
 * Checks performed:
 *   1. Model exists in the registry.
 *   2. Model is authenticated/available.
 *   3. Model supports tools and text.
 *   4. Thinking compatibility (with clamping rules).
 *
 * @param modelId - The candidate model identifier.
 * @param registry - The model registry to query.
 * @param lane - The lane definition being resolved.
 * @param laneName - The lane name (for conservative detection).
 * @returns Check result with reasons for rejection.
 */
function checkCandidate(
  modelId: string,
  registry: ModelRegistry,
  lane: NormalizedLaneDefinition,
  laneName: string,
): CandidateCheckResult {
  const reasons: string[] = []

  // 1. Model exists
  const model = registry.getModel(modelId)
  if (!model) {
    reasons.push(`Model "${modelId}" not found in registry`)
    return { valid: false, reasons }
  }

  // 2. Authentication
  if (!model.authenticated) {
    reasons.push(`Model "${modelId}" is not authenticated`)
    // Still check other capabilities so all reasons are gathered,
    // but authentication failure alone is enough to reject.
  }

  // 3. Capability checks
  if (!model.supportsTools) {
    reasons.push(`Model "${modelId}" does not support tool calling`)
  }
  if (!model.supportsText) {
    reasons.push(`Model "${modelId}" does not support text input/output`)
  }

  // If fundamental capabilities are missing → reject immediately
  if (!model.authenticated || !model.supportsTools || !model.supportsText) {
    return { valid: false, reasons }
  }

  // 4. Thinking compatibility
  const isConservative = CONSERVATIVE_LANES.has(laneName)
  const thinkingCheck = isModelThinkingCompatible(
    model,
    lane.thinking,
    isConservative,
  )
  if (!thinkingCheck.compatible) {
    reasons.push(thinkingCheck.reason)
    return { valid: false, reasons }
  }

  return { valid: true, reasons }
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
 * @returns The resolved lane result.
 */
export function resolveLane(
  laneName: string,
  lane: NormalizedLaneDefinition,
  registry: ModelRegistry,
): ResolvedLane {
  // Walk preferredModels in order
  for (const modelId of lane.preferredModels) {
    const check = checkCandidate(modelId, registry, lane, laneName)
    if (check.valid) {
      // Determine effective thinking level from the model
      const model = registry.getModel(modelId)!
      const isConservative = CONSERVATIVE_LANES.has(laneName)
      const thinkingCheck = isModelThinkingCompatible(
        model,
        lane.thinking,
        isConservative,
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
    const check = checkCandidate(modelId, registry, lane, laneName)
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
  const resolved: Record<string, ResolvedLane> = {}
  for (const [laneName, lane] of Object.entries(profile.lanes)) {
    resolved[laneName] = resolveLane(laneName, lane, registry)
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
