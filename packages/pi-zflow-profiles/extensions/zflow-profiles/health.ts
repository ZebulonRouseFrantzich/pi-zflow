/**
 * health.ts — Lane-health preflight and runtime failure handling.
 *
 * Provides the health-checking layer that expensive workflow phases
 * (plan review, worker dispatch, final code review, synthesis) call
 * before executing to verify that resolved lanes are still available.
 *
 * ## Health preflight
 *
 * `preflightLaneHealth()` checks each lane's resolved model against
 * the current model registry to verify continued availability before
 * an expensive phase runs.
 *
 * ## Runtime failure handling
 *
 * `handleLaneFailure()` implements the five-step recovery policy:
 *   1. Agent tries its own fallbackModels first
 *   2. If still unhealthy, re-resolve lane to the next preferred
 *      candidate and retry once
 *   3. If required lane still unavailable, stop and ask Zeb
 *   4. If optional reviewer lane still unavailable, skip, record
 *      in manifest, continue
 *   5. Never silently degrade `worker-strong` to `worker-cheap`
 *
 * ## Design rules
 *
 * - Conservative lane downgrades (worker-strong -> worker-cheap) are
 *   explicitly recorded as health degrations, never silently accepted.
 * - Re-resolution skips the currently failing model and tries the next
 *   candidate in the `preferredModels` list.
 * - Optional lane failures return a skip action; required lane failures
 *   throw an error after all recovery attempts are exhausted.
 *
 * @module pi-zflow-profiles/health
 */

import type {
  ResolvedProfile,
  ResolvedLane,
  ModelRegistry,
  ModelInfo,
  NormalizedProfileDefinition,
} from "./profiles.js"

import { CONSERVATIVE_LANES } from "./capabilities.js"
import { validateLaneCandidate } from "./capabilities.js"

// ── Health status types ─────────────────────────────────────────

/**
 * The health status of a single lane at a point in time.
 *
 * - `healthy`: The lane's model is available in the registry and
 *   authenticated.
 * - `degraded`: The lane's model is still usable but with a reduced
 *   capability (e.g., thinking downgrade, or the model changed during
 *   re-resolution to a less powerful model but not across lane class
 *   boundaries).
 * - `unhealthy`: The lane's model is no longer available or
 *   authenticated, and no fallback resolved.
 */
export type LaneHealthStatus = "healthy" | "degraded" | "unhealthy"

/**
 * Result of checking a single lane's health.
 */
export interface HealthCheckResult {
  /** Lane name (e.g. "planning-frontier"). */
  lane: string
  /** Health status after check. */
  status: LaneHealthStatus
  /** The resolved model identifier for this lane, or `null` if unresolved. */
  model: string | null
  /** Human-readable message describing the health state. */
  message?: string
}

/**
 * Aggregate report from a lane-health preflight check.
 */
export interface LaneHealthReport {
  /** Per-lane health check results. */
  results: HealthCheckResult[]
  /**
   * `true` when all checked lanes are healthy (no degradation or
   * unhealthy lanes).
   */
  allHealthy: boolean
  /** Names of lanes that are degraded (model changed but lane works). */
  degradedLanes: string[]
  /** Names of lanes that are unhealthy (no available model). */
  unhealthyLanes: string[]
}

/**
 * Possible outcomes of a runtime lane failure recovery attempt.
 *
 * The action tells the calling workflow what happened so it can
 * decide how to proceed (retry, skip, or abort).
 */
export type FailureRecoveryAction =
  /**
   * The agent's own fallbackModels succeeded — no lane change needed.
   */
  | "recovered-via-agent-fallback"
  /**
   * The lane was re-resolved to a different model in its
   * preferredModels list and the cache was updated.
   */
  | "recovered-via-reresolution"
  /**
   * The lane is optional and all recovery attempts failed — the
   * caller should skip this reviewer step and continue.
   */
  | "skip-optional-reviewer"
  /**
   * The lane is required and all recovery attempts failed — the
   * caller must stop and ask the user for guidance.
   */
  | "unrecoverable-required"

/**
 * Detailed result of a failure recovery attempt.
 */
export interface FailureRecoveryResult {
  /** The recovery action that was taken. */
  action: FailureRecoveryAction
  /**
   * If the lane was re-resolved, the new model identifier and
   * updated resolved lane info.
   */
  reresolvedLane?: ResolvedLane
  /** Human-readable description of what happened. */
  message: string
}

// ── Lane health check helpers ───────────────────────────────────

/**
 * Check whether a specific model in a specific lane is still healthy.
 *
 * For a lane to be healthy:
 *   1. A model must be resolved (not null).
 *   2. The model must exist in the current registry.
 *   3. The model must be authenticated.
 *
 * When no registry is provided, resolved lanes are assumed healthy
 * (we can only check by querying the registry).
 *
 * @param laneName - The lane name (for diagnostics).
 * @param modelId - The resolved model identifier.
 * @param registry - Optional model registry to check availability.
 * @returns A health check result.
 */
function checkLaneModelHealth(
  laneName: string,
  modelId: string | null,
  registry?: ModelRegistry,
): HealthCheckResult {
  // No model resolved
  if (modelId === null) {
    return {
      lane: laneName,
      status: "unhealthy",
      model: null,
      message: "No model resolved for this lane",
    }
  }

  // No registry to check against — assume healthy
  if (!registry) {
    return {
      lane: laneName,
      status: "healthy",
      model: modelId,
    }
  }

  // Check model exists in registry
  const model = registry.getModel(modelId)
  if (!model) {
    return {
      lane: laneName,
      status: "unhealthy",
      model: modelId,
      message: `Model "${modelId}" is no longer available in the model registry`,
    }
  }

  // Check model is authenticated
  if (!model.authenticated) {
    return {
      lane: laneName,
      status: "unhealthy",
      model: modelId,
      message: `Model "${modelId}" is no longer authenticated`,
    }
  }

  // Everything looks good
  return {
    lane: laneName,
    status: "healthy",
    model: modelId,
  }
}

// ── Preflight health check ──────────────────────────────────────

/**
 * Run a lane-health preflight check on a resolved profile.
 *
 * Checks each resolved lane's model against the current registry
 * to verify continued availability before expensive workflow phases.
 *
 * When `requiredLanes` is provided, only those lanes are checked.
 * Otherwise all resolved lanes are checked.
 *
 * This should be called before:
 *   - Plan review
 *   - Worker dispatch
 *   - Final code review
 *   - Synthesis
 *
 * @param resolved - The resolved profile to check.
 * @param registry - Optional model registry. When provided, lane models
 *                   are verified against it. When omitted, models are
 *                   assumed healthy (caller should provide a registry
 *                   for meaningful checks).
 * @param requiredLanes - Optional subset of lanes to check. When omitted,
 *                        all lanes are checked.
 * @returns A `LaneHealthReport` summarising the health of all checked lanes.
 */
export function preflightLaneHealth(
  resolved: ResolvedProfile,
  registry?: ModelRegistry,
  requiredLanes?: string[],
): LaneHealthReport {
  const lanesToCheck = requiredLanes ??
    Object.keys(resolved.resolvedLanes)

  const results: HealthCheckResult[] = []
  const degradedLanes: string[] = []
  const unhealthyLanes: string[] = []

  for (const laneName of lanesToCheck) {
    const lane = resolved.resolvedLanes[laneName]

    if (!lane) {
      // Lane not found in resolved profile
      results.push({
        lane: laneName,
        status: "unhealthy",
        model: null,
        message: `Lane "${laneName}" is not defined in the resolved profile`,
      })
      unhealthyLanes.push(laneName)
      continue
    }

    const check = checkLaneModelHealth(laneName, lane.model, registry)

    // Detect degraded state: lane was resolved but model no longer
    // matches the originally resolved model's capability class.
    // A lane is degraded if its model changed during re-resolution
    // but still works (e.g., different model in same class).
    // For preflight, we only detect unhealthy — degradation tracking
    // happens during re-resolution.
    switch (check.status) {
      case "healthy":
        results.push(check)
        break
      case "unhealthy":
        results.push(check)
        unhealthyLanes.push(laneName)
        break
      default:
        results.push(check)
        if (check.status === "degraded") degradedLanes.push(laneName)
    }
  }

  return {
    results,
    allHealthy: unhealthyLanes.length === 0 && degradedLanes.length === 0,
    degradedLanes,
    unhealthyLanes,
  }
}

// ── Lane re-resolution ──────────────────────────────────────────

/**
 * Re-resolve a lane, skipping the currently-resolved model(s).
 *
 * This is called when a lane's current model fails at runtime.
 * It walks the lane's `preferredModels` list, skipping any models
 * in `skipModels`, and tries to find the next valid candidate.
 *
 * The lane definition is obtained from the profile definition that
 * was used during original resolution.
 *
 * @param laneName - The lane to re-resolve.
 * @param profileDef - The normalized profile definition containing
 *                     the lane's `preferredModels`.
 * @param registry - The model registry for capability lookups.
 * @param skipModels - Set of model identifiers to skip (typically
 *                     the currently failing model).
 * @returns The newly resolved lane, or `null` if no further
 *          candidates are valid.
 */
export function reresolveLane(
  laneName: string,
  profileDef: NormalizedProfileDefinition,
  registry: ModelRegistry,
  skipModels: string[],
): ResolvedLane | null {
  const laneDef = profileDef.lanes[laneName]
  if (!laneDef) {
    return null
  }

  // Build a set of models to skip (the currently failing one, plus
  // any others that should be excluded)
  const skipSet = new Set(skipModels)

  // Walk preferredModels, skipping the failing model(s)
  const remaining = laneDef.preferredModels.filter(
    (modelId) => !skipSet.has(modelId),
  )

  if (remaining.length === 0) {
    return null
  }

  // Aggregate binding constraints for this lane. Runtime re-resolution
  // must respect the same output constraints as initial resolution.
  const maxOutput = Object.values(profileDef.agentBindings)
    .filter((binding) => binding.lane === laneName)
    .reduce<number | undefined>((max, binding) => {
      if (binding.maxOutput === undefined) return max
      return Math.max(max ?? 0, binding.maxOutput)
    }, undefined)

  // Use the existing candidate validation policy. Since resolveLane is in
  // model-resolution.ts, we replicate the core loop here to avoid a circular
  // dependency, including the binding-derived output requirement.
  for (const modelId of remaining) {
    const model = registry.getModel(modelId)

    // Quick capability check
    const isConservative = (CONSERVATIVE_LANES as ReadonlySet<string>).has(laneName)
    const requirements = {
      requiresTools: true,
      requiresText: true,
      requiredThinking: laneDef.thinking,
      isConservativeLane: isConservative,
      minOutput: maxOutput,
    }

    const validation = validateLaneCandidate(modelId, model, requirements)
    if (validation.valid) {
      // Determine effective thinking level
      const modelThinking = model?.thinkingCapability ?? "medium"
      const requestedScore =
        laneDef.thinking === "high" ? 3
        : laneDef.thinking === "medium" ? 2
        : laneDef.thinking === "low" ? 1
        : 0
      const modelScore =
        modelThinking === "high" ? 3
        : modelThinking === "medium" ? 2
        : 1

      let effectiveLevel = laneDef.thinking ?? "medium"
      let reason: string | undefined

      if (modelScore >= requestedScore || !requestedScore) {
        // Model meets or exceeds requested thinking — no clamping issue
        effectiveLevel = modelThinking
        reason = undefined
      } else if (isConservative) {
        // Conservative lane rejects downgrade
        continue
      } else {
        // Non-conservative lane: accept with warning
        effectiveLevel = modelThinking
        reason = `Model "${modelId}" has ${modelThinking} thinking but "${laneName}" requested ${laneDef.thinking ?? "medium"}; acceptable clamp for non-conservative lane`
      }

      // Check for worker-strong degrading to worker-cheap
      if (laneName === "worker-strong" && modelId.includes("cheap")) {
        // Never silently degrade worker-strong to any "cheap"-class model
        continue
      }

      return {
        lane: laneName,
        model: modelId,
        required: laneDef.required,
        optional: laneDef.optional,
        thinking: effectiveLevel,
        status: "resolved",
        reason,
      }
    }
  }

  return null
}

// ── Runtime failure handling ────────────────────────────────────

/**
 * Handle a runtime lane failure using the five-step recovery policy.
 *
 * This function is called when an agent's lane model fails at runtime
 * (e.g., the model returns an error, times out, or is unavailable).
 * It implements the policy:
 *
 * 1. Check if the agent has its own fallbackModels that succeeded
 *    (handled by the agent framework, reported via `agentFallbackOk`).
 * 2. Re-resolve the lane to the next preferred candidate.
 * 3. If required lane still unavailable → `unrecoverable-required`.
 * 4. If optional reviewer lane still unavailable → `skip-optional-reviewer`.
 * 5. Never silently degrade `worker-strong` to `worker-cheap`.
 *
 * When re-resolution succeeds, the function optionally calls
 * `onReresolve` so the caller can update the active profile cache
 * with the new lane mapping.
 *
 * @param agentName - The name of the agent that experienced the failure.
 * @param laneName - The name of the lane that failed.
 * @param error - The error that occurred.
 * @param resolved - The current resolved profile.
 * @param registry - The model registry for re-resolution.
 * @param profileDef - The normalized profile definition (needed for
 *                     re-resolution).
 * @param options - Optional configuration.
 * @param options.agentFallbackOk - Whether the agent's own fallbackModels
 *        succeeded (default: `false`).
 * @param options.onReresolve - Callback invoked when re-resolution
 *        succeeds; receives the lane name and new model identifier.
 *        Used to persist the change (e.g., update cache).
 * @returns The recovery result with action and updated lane info.
 */
export async function handleLaneFailure(
  agentName: string,
  laneName: string,
  error: Error,
  resolved: ResolvedProfile,
  registry: ModelRegistry,
  profileDef: NormalizedProfileDefinition,
  options?: {
    agentFallbackOk?: boolean
    onReresolve?: (lane: string, newModel: string) => void | Promise<void>
  },
): Promise<FailureRecoveryResult> {
  const currentLane = resolved.resolvedLanes[laneName]

  // ── Step 1: Agent fallback ────────────────────────────────────
  if (options?.agentFallbackOk) {
    return {
      action: "recovered-via-agent-fallback",
      message:
        `Agent "${agentName}" lane "${laneName}" recovered via agent's ` +
        `own fallbackModels. Error was: ${error.message}`,
    }
  }

  // ── Step 2: Re-resolve the lane ───────────────────────────────
  const currentModel = currentLane?.model
  const skipModels = currentModel ? [currentModel] : []

  const rerouted = reresolveLane(laneName, profileDef, registry, skipModels)

  if (rerouted && rerouted.status === "resolved") {
    // Re-resolution succeeded — invoke callback if provided
    if (options?.onReresolve && rerouted.model) {
      await options.onReresolve(laneName, rerouted.model)
    }

    return {
      action: "recovered-via-reresolution",
      reresolvedLane: rerouted,
      message:
        `Agent "${agentName}" lane "${laneName}" re-resolved from ` +
        `"${currentModel ?? "none"}" to "${rerouted.model}" after ` +
        `runtime failure: ${error.message}`,
    }
  }

  // ── Step 3/4: Check required vs optional ──────────────────────
  const isOptional =
    currentLane?.optional === true ||
    profileDef.lanes[laneName]?.optional === true

  if (isOptional) {
    return {
      action: "skip-optional-reviewer",
      message:
        `Optional lane "${laneName}" for agent "${agentName}" failed ` +
        `and could not be recovered. Skipping. Error: ${error.message}`,
    }
  }

  // ── Step 5: Required lane — unrecoverable ─────────────────────
  throw new Error(
    `Required lane "${laneName}" for agent "${agentName}" failed ` +
    `and could not be recovered. Error: ${error.message}. ` +
    `Current model: "${currentModel ?? "none"}". ` +
    `No further candidates in preferredModels. ` +
    `Please check your profile configuration at "${resolved.sourcePath}" ` +
    `or run /zflow-profile refresh to re-resolve.`,
  )
}

/**
 * Convenience wrapper that calls `preflightLaneHealth` and returns
 * a boolean indicating whether all required lanes are healthy.
 *
 * This is designed for use in conditional checks before expensive
 * phases:
 *
 * ```ts
 * if (!await checkLaneHealth(profile, registry, ["planning-frontier"])) {
 *   // Handle unhealthy state
 * }
 * ```
 *
 * @param resolved - The resolved profile to check.
 * @param registry - Optional registry for model availability checks.
 * @param requiredLanes - Optional subset of lanes to verify.
 * @returns `true` if all checked lanes are healthy.
 */
export function checkLaneHealth(
  resolved: ResolvedProfile,
  registry?: ModelRegistry,
  requiredLanes?: string[],
): boolean {
  const report = preflightLaneHealth(resolved, registry, requiredLanes)
  return report.allHealthy
}

/**
 * Get a human-readable summary of lane health, suitable for
 * displaying in status output or footers.
 *
 * @param report - The health report to summarise.
 * @returns An array of status lines.
 */
export function getHealthStatusSummary(
  report: LaneHealthReport,
): string[] {
  const lines: string[] = []

  if (report.allHealthy) {
    lines.push("All lanes healthy")
    return lines
  }

  if (report.degradedLanes.length > 0) {
    lines.push(
      `Degraded lanes: ${report.degradedLanes.join(", ")}`,
    )
  }

  if (report.unhealthyLanes.length > 0) {
    lines.push(
      `Unhealthy lanes: ${report.unhealthyLanes.join(", ")}`,
    )
  }

  return lines
}
