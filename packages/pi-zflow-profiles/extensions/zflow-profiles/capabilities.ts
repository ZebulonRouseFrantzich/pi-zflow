/**
 * capabilities.ts — Model capability and thinking compatibility checks.
 *
 * Defines the formal capability-checking layer that the lane resolution
 * engine uses to evaluate candidate models. Checking more than model-name
 * existence ensures that resolved models can actually perform the role.
 *
 * ## Compatibility dimensions
 *
 * 1. **Tool use** — Does the model support tool/function calling?
 * 2. **Text I/O** — Does the model support text input and output?
 * 3. **Thinking capability** — Does the model's reasoning depth match
 *    the lane's requirement (with acceptable clamping rules)?
 * 4. **Output-window sufficiency** — Can the model produce enough output
 *    tokens for the agent's role?
 * 5. **Context-window sufficiency** — Does the model have enough context
 *    space for the workflow?
 *
 * ## Policy rules
 *
 * - Conservative lanes (`planning-frontier`, `worker-strong`,
 *   `review-security`, `synthesis-frontier`) reject thinking downgrades.
 * - Non-conservative lanes may accept a thinking downgrade with a warning.
 * - Output-window insufficiency is a hard reject: if the model cannot
 *   produce the required output, it is not accepted.
 *
 * @module pi-zflow-profiles/capabilities
 */

import type {
  ModelInfo,
  ModelCapabilityProfile,
  CapabilityRequirements,
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
export const CONSERVATIVE_LANES: ReadonlySet<string> = new Set<string>([
  "planning-frontier",
  "worker-strong",
  "review-security",
  "synthesis-frontier",
])

// ── Thinking compatibility ──────────────────────────────────────

/**
 * Result of a thinking compatibility check.
 */
export interface ThinkingCompatibilityResult {
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
 * requested thinking level.
 *
 * Rules:
 * - If no level is requested → always compatible with no warning.
 * - If the model's capability meets or exceeds the requested level →
 *   compatible (clamping up is always acceptable).
 * - If the model's capability falls short AND the lane is conservative →
 *   incompatible.
 * - If the model's capability falls short AND the lane is NOT conservative
 *   → compatible with a warning (acceptable clamp for non-critical roles).
 *
 * @param modelThinking - The model's maximum thinking capability.
 * @param requestedLevel - The thinking level requested (optional).
 * @param isConservative - Whether the lane is conservative (rejects downgrades).
 * @param modelId - Model identifier for diagnostic messages.
 * @returns The compatibility check result.
 */
export function checkThinkingCompatibility(
  modelThinking: "low" | "medium" | "high",
  requestedLevel?: "low" | "medium" | "high",
  isConservative: boolean = false,
  modelId: string = "<unknown>",
): ThinkingCompatibilityResult {
  // No request → always compatible
  if (!requestedLevel) {
    return {
      compatible: true,
      effectiveLevel: modelThinking,
      reason: "",
    }
  }

  const requestedScore = scoreThinking(requestedLevel)
  const modelScore = scoreThinking(modelThinking)

  // Model meets or exceeds requested level → compatible (clamp up is fine)
  if (modelScore >= requestedScore) {
    const reason =
      modelScore > requestedScore
        ? `Model "${modelId}" provides "${modelThinking}" thinking (exceeds requested "${requestedLevel}") — acceptable overprovisioning.`
        : ""
    return {
      compatible: true,
      effectiveLevel: modelThinking,
      reason,
    }
  }

  // Model falls short of requested level
  if (isConservative) {
    return {
      compatible: false,
      effectiveLevel: requestedLevel,
      reason: `Conservative lane requires "${requestedLevel}" thinking, but model "${modelId}" only provides "${modelThinking}". Downgrade not permitted for this lane.`,
    }
  }

  // Non-conservative lane: accept with warning
  return {
    compatible: true,
    effectiveLevel: modelThinking,
    reason: `Accepted: model "${modelId}" provides "${modelThinking}" thinking (requested "${requestedLevel}") — acceptable clamp for non-conservative lane.`,
  }
}

// ── Output window sufficiency ──────────────────────────────────

/**
 * Result of an output-window sufficiency check.
 */
export interface OutputWindowResult {
  /** Whether the model's output window is sufficient. */
  sufficient: boolean
  /** Human-readable reason if insufficient. */
  reason: string
}

/**
 * Check whether a model's max output is sufficient for the required
 * output size.
 *
 * Rules:
 * - If the model does not advertise a max output (undefined) → assumed
 *   sufficient (conservative assumption).
 * - If the requirement is not specified (undefined) → always sufficient.
 * - Otherwise, the model's maxOutput must be >= required minOutput.
 *
 * @param modelMaxOutput - The model's maximum output tokens (undefined = unknown).
 * @param requiredMinOutput - The minimum output tokens required (undefined = none).
 * @param modelId - Model identifier for diagnostic messages.
 * @returns The check result.
 */
export function checkOutputWindowSufficiency(
  modelMaxOutput: number | undefined,
  requiredMinOutput: number | undefined,
  modelId: string = "<unknown>",
): OutputWindowResult {
  // No requirement → always sufficient
  if (requiredMinOutput === undefined) {
    return { sufficient: true, reason: "" }
  }

  // Model doesn't advertise max output → assume sufficient
  if (modelMaxOutput === undefined) {
    return { sufficient: true, reason: "" }
  }

  if (modelMaxOutput >= requiredMinOutput) {
    return { sufficient: true, reason: "" }
  }

  return {
    sufficient: false,
    reason: `Model "${modelId}" has max output of ${modelMaxOutput} tokens, but ${requiredMinOutput} tokens are required for this role.`,
  }
}

// ── Context window sufficiency ─────────────────────────────────

/**
 * Result of a context-window sufficiency check.
 */
export interface ContextWindowResult {
  /** Whether the model's context window is sufficient. */
  sufficient: boolean
  /** Human-readable reason if insufficient. */
  reason: string
}

/**
 * Check whether a model's context window is sufficient for the
 * required context size.
 *
 * Rules:
 * - If the model does not advertise a context window (undefined) →
 *   assumed sufficient.
 * - If the requirement is not specified (undefined) → always sufficient.
 * - Otherwise, the model's contextWindow must be >= required minContext.
 *
 * @param modelContextWindow - The model's context window size (undefined = unknown).
 * @param requiredMinContext - The minimum context size required (undefined = none).
 * @param modelId - Model identifier for diagnostic messages.
 * @returns The check result.
 */
export function checkContextWindowSufficiency(
  modelContextWindow: number | undefined,
  requiredMinContext: number | undefined,
  modelId: string = "<unknown>",
): ContextWindowResult {
  // No requirement → always sufficient
  if (requiredMinContext === undefined) {
    return { sufficient: true, reason: "" }
  }

  // Model doesn't advertise context window → assume sufficient
  if (modelContextWindow === undefined) {
    return { sufficient: true, reason: "" }
  }

  if (modelContextWindow >= requiredMinContext) {
    return { sufficient: true, reason: "" }
  }

  return {
    sufficient: false,
    reason: `Model "${modelId}" has context window of ${modelContextWindow} tokens, but ${requiredMinContext} tokens are required for this role.`,
  }
}

// ── Full capability requirements check ─────────────────────────

/**
 * Result of checking a model against capability requirements.
 */
export interface CapabilityCheckResult {
  /** Whether the model satisfies all requirements. */
  compatible: boolean
  /** Effective thinking level after clamping. */
  effectiveThinking: "low" | "medium" | "high"
  /** Human-readable reasons for any failures. */
  reasons: string[]
}

/**
 * Full capability check: evaluate a model against a full set of
 * capability requirements.
 *
 * Checks, in order:
 *   1. Tool use support
 *   2. Text I/O support
 *   3. Thinking compatibility (with clamping rules)
 *   4. Output window sufficiency
 *   5. Context window sufficiency
 *
 * All checks are performed and all reasons are collected, even after
 * failures, so the caller gets a complete diagnostic picture.
 *
 * @param model - The model's capability profile.
 * @param requirements - The capability requirements.
 * @returns The full check result.
 */
export function checkCapabilityRequirements(
  model: ModelCapabilityProfile | ModelInfo,
  requirements: CapabilityRequirements,
): CapabilityCheckResult {
  const reasons: string[] = []
  let effectiveThinking: "low" | "medium" | "high" = model.thinkingCapability

  // 1. Tool use support
  if (requirements.requiresTools && !model.supportsTools) {
    reasons.push(
      `Model "${model.id}" does not support tool calling (required).`,
    )
  }

  // 2. Text I/O support
  if (requirements.requiresText && !model.supportsText) {
    reasons.push(
      `Model "${model.id}" does not support text input/output (required).`,
    )
  }

  // 3. Thinking compatibility
  if (requirements.requiredThinking !== undefined) {
    const thinkingResult = checkThinkingCompatibility(
      model.thinkingCapability,
      requirements.requiredThinking,
      requirements.isConservativeLane,
      model.id,
    )

    if (!thinkingResult.compatible) {
      reasons.push(thinkingResult.reason)
    }
    // Track effective thinking regardless of compatibility
    effectiveThinking = thinkingResult.effectiveLevel
  }

  // 4. Output window sufficiency
  const outputResult = checkOutputWindowSufficiency(
    "maxOutput" in model ? model.maxOutput : undefined,
    requirements.minOutput,
    model.id,
  )
  if (!outputResult.sufficient) {
    reasons.push(outputResult.reason)
  }

  // 5. Context window sufficiency
  const contextResult = checkContextWindowSufficiency(
    "contextWindow" in model ? model.contextWindow : undefined,
    requirements.minContextWindow,
    model.id,
  )
  if (!contextResult.sufficient) {
    reasons.push(contextResult.reason)
  }

  return {
    compatible: reasons.length === 0,
    effectiveThinking,
    reasons,
  }
}

// ── Lane candidate validation (composite) ───────────────────────

/**
 * Full lane candidate validation: checks model availability AND
 * capability requirements.
 *
 * This is the composite check that the resolution engine calls for
 * each candidate in a lane's `preferredModels` list.
 *
 * @param modelId - The candidate model identifier.
 * @param model - The model info from the registry (or undefined if unknown).
 * @param requirements - The capability requirements for this lane.
 * @returns The complete check result.
 */
export function validateLaneCandidate(
  modelId: string,
  model: ModelInfo | undefined,
  requirements: CapabilityRequirements,
): { valid: boolean; reasons: string[] } {
  const reasons: string[] = []

  // 1. Model exists in the registry
  if (!model) {
    reasons.push(`Model "${modelId}" not found in registry.`)
    return { valid: false, reasons }
  }

  // 2. Authentication
  if (!model.authenticated) {
    reasons.push(`Model "${modelId}" is not authenticated.`)
    // Continue checking to collect all reasons
  }

  // 3. Capability requirements
  const capResult = checkCapabilityRequirements(model, requirements)
  reasons.push(...capResult.reasons)

  return {
    valid: reasons.length === 0,
    reasons,
  }
}
