/**
 * pi-zflow-profiles extension entrypoint
 *
 * Registers `/zflow-profile` commands and profile/lane resolution services.
 *
 * ## Phase 2 — Profile loading
 *
 * On activation, the extension:
 *   1. Claims the "profiles" capability via `getZflowRegistry()`.
 *   2. Provides a profile service with `loadProfiles()` and helpers.
 *   3. Guards against duplicate loads — if "profiles" is already claimed
 *      by a compatible provider, it no-ops.
 *   4. Exposes the profile service for sibling packages via the registry.
 *
 * ## Phase 2 — Later tasks will add
 *   - `/zflow-profile ...` command handlers (Task 2.9)
 *   - Active profile cache (Task 2.5)
 *   - Lane resolution engine (Task 2.3)
 *   - Lane health checks (Task 2.8)
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
}

// ── Capability name ─────────────────────────────────────────────

/** Well-known capability name for profile services. */
export const PROFILES_CAPABILITY = "profiles" as const

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
  }

  registry.provide(PROFILES_CAPABILITY, profileService)
}
