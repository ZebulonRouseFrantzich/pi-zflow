/**
 * pi-zflow-profiles extension entrypoint
 *
 * Registers `/zflow-profile` commands and profile/lane resolution services.
 * Provides the `activateProfile()` entrypoint for persisting resolved profile
 * state to the user-local cache (`~/.pi/agent/zflow/active-profile.json`).
 *
 * ## Phase 2 — Profile loading and activation
 *
 * On activation, the extension:
 *   1. Claims the "profiles" capability via `getZflowRegistry()`.
 *   2. Provides a profile service with `loadProfiles()`, `activateProfile()`,
 *      resolution, and capability-checking helpers.
 *   3. Guards against duplicate loads — if "profiles" is already claimed
 *      by a compatible provider, it no-ops.
 *   4. Exposes the profile service for sibling packages via the registry.
 *
 * @module pi-zflow-profiles/index
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { getZflowRegistry, type CapabilityClaim } from "pi-zflow-core"
import { PI_ZFLOW_PROFILES_VERSION } from "pi-zflow-core"

import {
  validateLaneCandidate,
  checkCapabilityRequirements,
} from "./capabilities.js"

import {
  resolveProfile,
  resolveLane,
  resolveProfileLanes,
  resolveAgentBindings,
  hasUnresolvedRequiredLanes,
  getLaneStatusSummary,
  isModelThinkingCompatible,
} from "./model-resolution.js"

import type { ModelRegistry, ResolvedProfile } from "./profiles.js"
import {
  loadProfiles,
  loadProfilesSync,
  resolveProfileSource,
  resolveProjectProfilePath,
  resolveUserProfilePath,
  fileExists,
  fileExistsSync,
  validateProfilesFile,
  parseProfilesFile,
  parseProfilesFileJson,
  normalizeLaneDefinition,
  normalizeAgentBinding,
  normalizeProfileDefinition,
  normalizeProfilesFile,
  ProfileValidationError,
  ProfileFileNotFoundError,
  writeActiveProfileCache,
  readActiveProfileCache,
  buildActiveProfileCache,
  computeHash,
  computeEnvironmentFingerprint,
  DEFAULT_CACHE_TTL_MINUTES,
} from "./profiles.js"

import * as fs from "node:fs/promises"

// Re-export the public profile API so sibling packages or extensions
// can import from "pi-zflow-profiles" directly.
export {
  loadProfiles,
  loadProfilesSync,
  resolveProfileSource,
  resolveProjectProfilePath,
  resolveUserProfilePath,
  fileExists,
  fileExistsSync,
  validateProfilesFile,
  parseProfilesFile,
  parseProfilesFileJson,
  normalizeLaneDefinition,
  normalizeAgentBinding,
  normalizeProfileDefinition,
  normalizeProfilesFile,
  ProfileValidationError,
  ProfileFileNotFoundError,
  writeActiveProfileCache,
  readActiveProfileCache,
  buildActiveProfileCache,
  computeHash,
  computeEnvironmentFingerprint,
  DEFAULT_CACHE_TTL_MINUTES,
} from "./profiles.js"

// Re-export the lane resolution API
export {
  resolveLane,
  resolveProfileLanes,
  resolveAgentBindings,
  resolveProfile,
  hasUnresolvedRequiredLanes,
  getLaneStatusSummary,
  isModelThinkingCompatible,
  CONSERVATIVE_LANES,
} from "./model-resolution.js"

// Re-export the capability checking API
export {
  checkThinkingCompatibility,
  checkOutputWindowSufficiency,
  checkContextWindowSufficiency,
  checkCapabilityRequirements,
  validateLaneCandidate,
} from "./capabilities.js"

export type {
  LaneDefinition,
  AgentBinding,
  ProfileDefinition,
  ProfilesFile,
  NormalizedLaneDefinition,
  NormalizedAgentBinding,
  NormalizedProfileDefinition,
  NormalizedProfilesFile,
  ValidationResult,
  ValidationMessage,
  ValidationSeverity,
  ParsedProfilesFile,
  LoadedProfiles,
  ModelInfo,
  ModelRegistry,
  ModelCapabilityProfile,
  CapabilityRequirements,
  ResolvedLane,
  ResolvedAgentBinding,
  ResolvedProfile,
  LaneStatus,
  ActiveProfileCache,
  CachedResolvedLane,
  CachedAgentBinding,
} from "./profiles.js"

export type {
  ThinkingCompatibilityResult,
  OutputWindowResult,
  ContextWindowResult,
  CapabilityCheckResult,
} from "./capabilities.js"

export type {
  ThinkingCheckResult,
} from "./model-resolution.js"

// ── Profile service interface ───────────────────────────────────

/**
 * Service interface exposed through the zflow registry for sibling
 * packages that need profile loading without importing the profiles
 * module directly.
 */
export interface ProfileService {
  loadProfiles(repoRoot?: string): ReturnType<typeof loadProfiles>
  loadProfilesSync(repoRoot?: string): ReturnType<typeof loadProfilesSync>
  resolveProfileSource(repoRoot?: string): ReturnType<typeof resolveProfileSource>
  resolveLane: typeof resolveLane
  resolveProfileLanes: typeof resolveProfileLanes
  resolveAgentBindings: typeof resolveAgentBindings
  resolveProfile: typeof resolveProfile
  hasUnresolvedRequiredLanes: typeof hasUnresolvedRequiredLanes
  getLaneStatusSummary: typeof getLaneStatusSummary
  validateLaneCandidate: typeof validateLaneCandidate
  checkCapabilityRequirements: typeof checkCapabilityRequirements
  activateProfile: typeof activateProfile
  readActiveProfileCache: typeof readActiveProfileCache
  writeActiveProfileCache: typeof writeActiveProfileCache
}

// ── Capability name ─────────────────────────────────────────────

/** Well-known capability name for profile services. */
export const PROFILES_CAPABILITY = "profiles" as const

// ── Active profile activation ───────────────────────────────────

/**
 * Activate a named profile: load, resolve, cache, and return.
 *
 * This is the primary entrypoint for making a profile operational.
 * It:
 *   1. Resolves the profile source file (project-local or user fallback).
 *   2. Reads the raw file content and computes a `definitionHash` for
 *      cache invalidation.
 *   3. Parses and validates the profile definitions.
 *   4. Looks up the requested profile by name.
 *   5. Resolves all lanes and agent bindings against the given model
 *      registry.
 *   6. Computes an `environmentFingerprint` from the registry.
 *   7. Writes the complete cache atomically to
 *      `~/.pi/agent/zflow/active-profile.json`.
 *   8. Returns the resolved profile for immediate use.
 *
 * @param profileName - The name of the profile to activate (e.g. "default").
 * @param options - Optional configuration.
 * @param options.repoRoot - Repository root for project-local profile lookup.
 * @param options.registry - Model registry for lane resolution.
 * @param options.cachePath - Override cache file path.
 * @param options.ttlMinutes - Cache TTL in minutes (defaults to 15).
 * @returns The fully resolved profile.
 * @throws {ProfileFileNotFoundError} If no profile file is found.
 * @throws {ProfileValidationError} If the profile file is invalid.
 * @throws {Error} If the named profile does not exist.
 */
export async function activateProfile(
  profileName: string,
  options?: {
    repoRoot?: string
    registry?: ModelRegistry
    cachePath?: string
    ttlMinutes?: number
  },
): Promise<ResolvedProfile> {
  // 1. Resolve the source path
  const source = await resolveProfileSource(options?.repoRoot)

  // 2. Read raw content and compute definition hash
  const rawContent = await fs.readFile(source, "utf8")
  const definitionHash = computeHash(rawContent)

  // 3. Parse and validate
  const { profiles } = parseProfilesFileJson(rawContent)

  // 4. Get the named profile
  const profileDef = profiles[profileName]
  if (!profileDef) {
    throw new Error(
      `Profile "${profileName}" not found in ${source}. ` +
        `Available profiles: ${Object.keys(profiles).join(", ")}`,
    )
  }

  // 5. Resolve all lanes
  const registry = options?.registry ?? createEmptyRegistry()
  const resolved = resolveProfile(profileName, profileDef, source, registry)

  // 6. Compute environment fingerprint from the registry
  const modelIds = extractModelIdsFromRegistry(registry)
  const environmentFingerprint = computeEnvironmentFingerprint(modelIds)

  // 7. Build and write cache
  const cache = buildActiveProfileCache(
    profileName,
    source,
    resolved,
    definitionHash,
    environmentFingerprint,
    options?.ttlMinutes ?? DEFAULT_CACHE_TTL_MINUTES,
  )
  await writeActiveProfileCache(cache, options?.cachePath)

  return resolved
}

/**
 * Create an empty model registry (no models available).
 * Used as default when no registry is provided.
 */
function createEmptyRegistry(): ModelRegistry {
  return { getModel: () => undefined }
}

/**
 * Extract all known model IDs from a registry for fingerprinting.
 * Iterates by trying common model IDs — for a real registry this
 * should use a proper `listModels()` API.
 *
 * For fingerprinting purposes, we rely on the caller providing a
 * registry that supports listing. If the registry has a `listModels`
 * method (not required by the interface), use it; otherwise return
 * an empty array.
 */
function extractModelIdsFromRegistry(registry: ModelRegistry): string[] {
  // Dynamically detect if the registry exposes a way to list models.
  // The standard ModelRegistry interface only has getModel(), but
  // real implementations may also have listModels() or enumerate().
  const r = registry as Record<string, unknown>
  if (typeof r.listModels === "function") {
    try {
      const ids = (r as any).listModels() as string[]
      return Array.isArray(ids) ? ids : []
    } catch {
      return []
    }
  }
  // Fallback: return empty array — caller should provide a registry
  // with listModels support for meaningful fingerprints.
  return []
}

// ── Extension activation ────────────────────────────────────────

/**
 * Activate the pi-zflow-profiles extension.
 *
 * Called by the Pi harness when the extension loads. This function:
 *   1. Claims the "profiles" capability in the shared zflow registry.
 *   2. Provides profile-loading services for sibling packages.
 *   3. Handles duplicate loads gracefully (no-op if already claimed
 *      by the same or compatible provider).
 *
 * @param pi - The Pi extension API provided by the harness.
 */
export default function activateZflowProfilesExtension(pi: ExtensionAPI): void {
  const registry = getZflowRegistry()

  // ── Build the capability claim ────────────────────────────────
  const claim: CapabilityClaim = {
    capability: PROFILES_CAPABILITY,
    version: PI_ZFLOW_PROFILES_VERSION,
    provider: "pi-zflow-profiles",
    sourcePath: import.meta.url,
    compatibilityMode: "compatible",
  }

  // ── Claim the capability ──────────────────────────────────────
  const registered = registry.claim(claim)

  // If claim returns null, an incompatible provider already owns this
  // capability — do not register anything.
  if (!registered) {
    // A diagnostic was already emitted by the registry.
    return
  }

  // ── Build and provide the profile service ─────────────────────
  const profileService: ProfileService = {
    loadProfiles,
    loadProfilesSync,
    resolveProfileSource,
    resolveLane,
    resolveProfileLanes,
    resolveAgentBindings,
    resolveProfile,
    hasUnresolvedRequiredLanes,
    getLaneStatusSummary,
    validateLaneCandidate,
    checkCapabilityRequirements,
    activateProfile,
    readActiveProfileCache,
    writeActiveProfileCache,
  }

  registry.provide(PROFILES_CAPABILITY, profileService)
}
