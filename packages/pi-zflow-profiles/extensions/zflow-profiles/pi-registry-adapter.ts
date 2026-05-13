/**
 * pi-registry-adapter.ts — Pi runtime model registry adapter.
 *
 * Converts the Pi harness's `ctx.modelRegistry` (from ExtensionCommandContext)
 * into the local `ModelRegistry` interface so lane resolution can use
 * real runtime model data for availability, authentication, and capability
 * checks.
 *
 * ## Usage
 *
 * Inside a command or event handler:
 *
 * ```ts
 * const registry = createPiModelRegistryAdapter(ctx.modelRegistry)
 * const resolved = await activateProfile("default", { repoRoot, registry })
 * ```
 *
 * The adapter maps Pi model objects to `ModelInfo` entries:
 *   - `model.provider + "/" + model.id` → full model identifier
 *   - Pi models do not currently expose a tool-support flag; treat them as tool-capable by default
 *   - `model.reasoning` → thinking capability (high if true)
 *   - `model.contextWindow` → context window size
 *   - `model.maxTokens` → max output tokens
 *   - `piRegistry.hasConfiguredAuth(model)` → authentication status
 *
 * @module pi-zflow-profiles/pi-registry-adapter
 */

import type { ModelRegistry, ModelInfo } from "./profiles.js"
import { computeHash } from "./profiles.js"

/**
 * Minimal interface for the Pi runtime model registry that this adapter
 * depends on. Mirrors the relevant methods of the actual Pi ModelRegistry
 * class so the adapter can be constructed from real Pi extension contexts
 * as well as from mocks in tests.
 */
export interface PiModelRegistryLike {
  /**
   * Get all models registered in the Pi runtime (built-in + custom).
   * Includes models that may not have auth configured yet.
   */
  getAll(): Array<{
    provider: string
    id: string
    api?: string
    baseUrl?: string
    reasoning?: boolean
    input?: string[]
    contextWindow?: number
    maxTokens?: number
    [key: string]: unknown
  }>

  /**
   * Check whether the user has authentication configured for a model.
   * Returns `true` if the model can be used right now.
   */
  hasConfiguredAuth(model: {
    provider: string
    id: string
    [key: string]: unknown
  }): boolean
}

/**
 * Create a local `ModelRegistry` adapter from a Pi runtime model registry.
 *
 * The adapter:
 *   - Builds an in-memory cache of Pi models keyed by `provider/id`.
 *   - Maps Pi model fields to `ModelInfo` for lane resolution.
 *   - Supports model enumeration via `getAllModels()` for fingerprinting.
 *
 * Values are snapshotted at adapter creation time. If the Pi registry
 * changes later (provider registration/unregistration), create a new
 * adapter to reflect the changes.
 *
 * @param piRegistry - The Pi runtime model registry (from ctx.modelRegistry).
 * @returns A local `ModelRegistry` suitable for lane resolution.
 */
export function createPiModelRegistryAdapter(
  piRegistry: PiModelRegistryLike,
): ModelRegistry {
  const models = new Map<string, ModelInfo>()

  const piModels = piRegistry.getAll()
  for (const piModel of piModels) {
    const id = `${piModel.provider}/${piModel.id}`
    const authenticated = piRegistry.hasConfiguredAuth(piModel)

    models.set(id, {
      id,
      provider: piModel.provider,
      api: piModel.api,
      baseUrl: piModel.baseUrl,
      // Pi's Model.input describes content modalities ("text"/"image"),
      // not tool capability. The current Pi model schema does not expose a
      // per-model tool-support flag, so default to tool-capable unless a
      // future explicit `supportsTools: false` field is present.
      supportsTools: (piModel as { supportsTools?: boolean }).supportsTools !== false,
      supportsText: piModel.input?.includes("text") ?? true,
      thinkingCapability: piModel.reasoning ? "high" : "medium",
      authenticated,
      contextWindow: piModel.contextWindow,
      maxOutput: piModel.maxTokens,
    })
  }

  return {
    getModel(modelId: string): ModelInfo | undefined {
      return models.get(modelId)
    },
    getAllModels(): ModelInfo[] {
      return Array.from(models.values())
    },
  }
}

/**
 * Adapter-aware environment fingerprinting.
 *
 * Uses `getAllModels()` from the adapter (if available) to produce
 * a hash of model IDs and their auth status. Falls back to trying
 * the legacy `listModels()` duck-type, then to an empty string.
 *
 * @param registry - The local ModelRegistry (may have getAllModels).
 * @returns Hex-encoded fingerprint, or empty string if unavailable.
 */
export function computeFingerprintFromAdapter(
  registry: ModelRegistry,
): string {
  // Prefer the standard getAllModels() method
  if (typeof (registry as any).getAllModels === "function") {
    try {
      const allModels = (registry as any).getAllModels() as ModelInfo[]
      const sorted = [...allModels].sort((a, b) => a.id.localeCompare(b.id))
      const canonical = sorted
        .map((m) => `${m.id}:${m.provider ?? ""}:${m.api ?? ""}:${m.baseUrl ?? ""}:${m.authenticated}:${m.supportsTools}:${m.thinkingCapability}${m.contextWindow ? `:ctx${m.contextWindow}` : ""}${m.maxOutput ? `:out${m.maxOutput}` : ""}`)
        .join("\n")
      return computeHash(canonical)
    } catch {
      return ""
    }
  }

  // Fall back to legacy listModels duck-type
  if (typeof (registry as any).listModels === "function") {
    try {
      const ids = (registry as any).listModels() as string[]
      const sorted = [...ids].sort()
      return computeHash(sorted.join("\n"))
    } catch {
      return ""
    }
  }

  return ""
}
