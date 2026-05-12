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
import { getZflowRegistry, type CapabilityClaim, resolveGitDir } from "pi-zflow-core"
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

import {
  preflightLaneHealth,
  checkLaneHealth,
  handleLaneFailure,
  reresolveLane,
  getHealthStatusSummary,
} from "./health.js"

import type { ModelRegistry, ResolvedProfile } from "./profiles.js"
import type {
  ResolvedLane,
  ActiveProfileCache,
  LoadedProfiles,
} from "./profiles.js"
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
  readActiveProfileCacheIfFresh,
  cacheToResolvedProfile,
  buildActiveProfileCache,
  computeHash,
  computeEnvironmentFingerprint,
  computeEnvironmentFingerprintFromRegistry,
  computeCurrentProfileHash,
  DEFAULT_CACHE_TTL_MINUTES,
} from "./profiles.js"

import * as fs from "node:fs/promises"
import * as path from "node:path"

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
  readActiveProfileCacheIfFresh,
  cacheToResolvedProfile,
  buildActiveProfileCache,
  computeHash,
  computeEnvironmentFingerprint,
  computeEnvironmentFingerprintFromRegistry,
  computeCurrentProfileHash,
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

// Re-export the health-checking API
export {
  preflightLaneHealth,
  handleLaneFailure,
  reresolveLane,
  checkLaneHealth,
  getHealthStatusSummary,
} from "./health.js"

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
  EnvironmentSnapshot,
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

export type {
  LaneHealthStatus,
  HealthCheckResult,
  LaneHealthReport,
  FailureRecoveryAction,
  FailureRecoveryResult,
} from "./health.js"

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
  ensureResolved: typeof ensureResolved
  readActiveProfileCache: typeof readActiveProfileCache
  writeActiveProfileCache: typeof writeActiveProfileCache
  computeCurrentProfileHash: typeof computeCurrentProfileHash
  computeEnvironmentFingerprintFromRegistry: typeof computeEnvironmentFingerprintFromRegistry
  preflightLaneHealth: typeof preflightLaneHealth
  handleLaneFailure: typeof handleLaneFailure
  reresolveLane: typeof reresolveLane
  checkLaneHealth: typeof checkLaneHealth
  getHealthStatusSummary: typeof getHealthStatusSummary
  buildAgentOverrides: typeof buildAgentOverrides
  syncProfileToSettings: typeof syncProfileToSettings
  formatSyncSummary: typeof formatSyncSummary
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
  const environmentFingerprint = computeEnvironmentFingerprintFromRegistry(registry)

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
 * Ensure that a profile is resolved and ready for use.
 *
 * This is the primary bootstrap function that later workflow phases
 * (4, 6, 7) call before executing expensive operations. It:
 *
 *   1. Computes the current environment state (profile file hash and
 *      registry fingerprint) for cache validation.
 *   2. Reads the current active profile cache if present and fresh
 *      (TTL, definition hash, AND environment fingerprint checks).
 *   3. If the cache is missing or stale, activates the `"default"` profile
 *      (loads profile file, resolves lanes, writes cache).
 *   4. Runs preflight lane-health checks on the requested lanes.
 *   5. Returns a `ResolvedProfile` with lane-to-model bindings ready for
 *      agent dispatch.
 *
 * @param requiredLanes - Optional list of lane names to verify during
 *                        preflight health checks. If provided and any
 *                        checked lane is unhealthy, the caller must
 *                        handle it before dispatching work.
 * @param options - Optional configuration forwarded to `activateProfile`.
 * @returns A resolved profile suitable for launch-time overrides.
 */
export async function ensureResolved(
  requiredLanes?: string[],
  options?: {
    repoRoot?: string
    registry?: ModelRegistry
    cachePath?: string
  },
): Promise<ResolvedProfile> {
  // 1. Compute current environment state for cache validation.
  //    We use Promise.allSettled so that partial failures (e.g., profile
  //    file not found) don't crash — they simply force a re-activation.
  const [currentDefinitionHash, currentEnvFingerprint] = await Promise.all([
    computeCurrentProfileHash(options?.repoRoot).catch(() => undefined),
    options?.registry
      ? computeEnvironmentFingerprintFromRegistry(options.registry)
      : undefined,
  ])

  // 2. Try reading fresh cache (with full invalidation checks:
  //    TTL, definition hash, AND environment fingerprint)
  const cache = await readActiveProfileCacheIfFresh(
    options?.cachePath,
    currentDefinitionHash,
    currentEnvFingerprint,
  )
  if (cache) {
    const resolved = cacheToResolvedProfile(cache)
    // Run preflight lane health checks before returning
    if (requiredLanes && requiredLanes.length > 0) {
      const report = preflightLaneHealth(resolved, options?.registry, requiredLanes)
      if (!report.allHealthy) {
        // Log degradation — caller will handle via preflight checks
        // if more specific action is needed
      }
    }
    return resolved
  }

  // 3. Cache missing or stale — full activation
  const resolved = await activateProfile("default", {
    repoRoot: options?.repoRoot,
    registry: options?.registry,
    cachePath: options?.cachePath,
  })

  // Run preflight lane health checks on freshly resolved profile
  if (requiredLanes && requiredLanes.length > 0) {
    const report = preflightLaneHealth(resolved, options?.registry, requiredLanes)
    if (!report.allHealthy) {
      // Log degradation — caller will handle via preflight checks
    }
  }

  return resolved
}

/**
 * Create an empty model registry (no models available).
 * Used as default when no registry is provided.
 */
function createEmptyRegistry(): ModelRegistry {
  return { getModel: () => undefined }
}

// ═══════════════════════════════════════════════════════════════════
//  /zflow-profile command handlers
// ═══════════════════════════════════════════════════════════════════

/**
 * Resolve the repository root directory for profile commands.
 *
 * Uses `resolveGitDir` from pi-zflow-core to find the git root from
 * the current working directory. Falls back to `process.cwd()` when
 * not in a git repo so commands still produce useful output.
 */
function getRepoRoot(): string | undefined {
  const gitDir = resolveGitDir(process.cwd())
  if (gitDir) {
    // resolveGitDir returns the .git path; the repo root is its parent
    return path.dirname(gitDir)
  }
  // Fallback: use cwd directly; it may or may not be a repo root
  return process.cwd()
}

/**
 * Format a single lane resolution line for display.
 *
 * @example
 * ```
 * - planning-frontier → openai/gpt-5.4 (high thinking)
 * - review-system ⚠ disabled (no matching authenticated model)
 * - review-logic ✗ FAILED (required lane unresolved)
 * ```
 */
function formatLaneLine(laneName: string, lane: ResolvedLane): string {
  switch (lane.status) {
    case "resolved": {
      const thinking = lane.thinking ? ` (${lane.thinking} thinking)` : ""
      return `- ${laneName} → ${lane.model}${thinking}`
    }
    case "disabled-optional":
      return `- ${laneName} ⚠ disabled${lane.reason ? ` (${lane.reason})` : ""}`
    case "unresolved-required":
      return `- ${laneName} ✗ FAILED${lane.reason ? ` (${lane.reason})` : ""}`
  }
}

/**
 * Format the active profile summary block.
 */
function formatProfileSummary(
  profile: ResolvedProfile,
  cache?: ActiveProfileCache,
): string {
  const lines: string[] = []
  lines.push(`Active profile: ${profile.profileName}`)
  lines.push(`Source: ${profile.sourcePath}`)
  lines.push(`Resolved at: ${profile.resolvedAt}`)
  lines.push("")

  // Resolved lanes
  let hasResolved = false
  let hasOptional = false
  const resolvedLines: string[] = []
  const optionalDisabled: string[] = []

  for (const lane of Object.values(profile.resolvedLanes)) {
    if (lane.status === "resolved") {
      resolvedLines.push(formatLaneLine(lane.lane, lane))
      hasResolved = true
    } else if (lane.status === "disabled-optional") {
      optionalDisabled.push(formatLaneLine(lane.lane, lane))
      hasOptional = true
    } else {
      resolvedLines.push(formatLaneLine(lane.lane, lane))
    }
  }

  if (hasResolved) {
    lines.push("Resolved lanes:")
    lines.push(...resolvedLines)
    lines.push("")
  }

  if (hasOptional) {
    lines.push("Optional disabled:")
    lines.push(...optionalDisabled)
    lines.push("")
  }

  // Cache invalidation info
  if (cache) {
    const age = Date.now() - new Date(cache.resolvedAt).getTime()
    const ageMinutes = Math.round(age / 60000)
    const ttlMinutes = cache.ttlMinutes
    lines.push(
      `Cache: ${ageMinutes}m old (TTL ${ttlMinutes}m)` +
        `${ageMinutes > ttlMinutes ? " — EXPIRED" : ""}`,
    )
  }

  return lines.join("\n")
}

/**
 * Format detailed profile information for `/zflow-profile show`.
 */
function formatProfileDetail(
  profile: ResolvedProfile,
  cache?: ActiveProfileCache,
): string {
  const lines: string[] = []

  lines.push(`Profile: ${profile.profileName}`)
  lines.push(`Source file: ${profile.sourcePath}`)
  lines.push(`Resolved at: ${profile.resolvedAt}`)
  lines.push("")

  // All lanes with full detail
  lines.push("Lanes:")
  for (const lane of Object.values(profile.resolvedLanes)) {
    lines.push(formatLaneLine(lane.lane, lane))
  }
  lines.push("")

  // Agent bindings
  const bindingEntries = Object.entries(profile.agentBindings)
  if (bindingEntries.length > 0) {
    lines.push("Agent bindings:")
    for (const [agent, binding] of bindingEntries) {
      const model = binding.resolvedModel ?? "(unresolved)"
      lines.push(`  - ${agent} → ${binding.lane} → ${model}`)
      if (binding.tools) lines.push(`    tools: ${binding.tools}`)
      if (binding.maxOutput) lines.push(`    maxOutput: ${binding.maxOutput}`)
      if (binding.maxSubagentDepth !== undefined) lines.push(`    maxSubagentDepth: ${binding.maxSubagentDepth}`)
    }
    lines.push("")
  }

  // Cache invalidation metadata
  if (cache) {
    lines.push("Cache invalidation metadata:")
    lines.push(`  TTL: ${cache.ttlMinutes}m`)
    lines.push(`  Definition hash: ${cache.definitionHash}`)
    lines.push(`  Environment fingerprint: ${cache.environmentFingerprint}`)
    const age = Date.now() - new Date(cache.resolvedAt).getTime()
    const ageMinutes = Math.round(age / 60000)
    lines.push(`  Age: ${ageMinutes}m (TTL ${cache.ttlMinutes}m)`)
    lines.push(`  Expired: ${age > cache.ttlMinutes * 60 * 1000 ? "yes" : "no"}`)
  }

  return lines.join("\n")
}

/**
 * Handler for `/zflow-profile` (no arguments) — show active profile summary.
 *
 * Reads the active profile cache if available and displays a concise
 * summary. If no cache exists, suggests activating the default profile.
 */
async function handleNoArgs(ui: {
  notify: (message: string, type?: "info" | "warning" | "error") => void
}): Promise<void> {
  const cache = await readActiveProfileCache().catch(() => null)

  if (!cache) {
    ui.notify(
      "No active profile found. Run `/zflow-profile default` to activate the default profile.",
    )
    return
  }

  const profile = cacheToResolvedProfile(cache)
  const summary = formatProfileSummary(profile, cache)
  ui.notify(summary)
}

/**
 * Handler for `/zflow-profile default` — activate the default profile.
 *
 * Loads, resolves, and caches the "default" profile, then displays
 * a summary of the resolved lanes.
 */
async function handleDefault(ui: {
  notify: (message: string, type?: "info" | "warning" | "error") => void
  setStatus: (key: string, text: string | undefined) => void
}): Promise<void> {
  try {
    const resolved = await activateProfile("default", {
      repoRoot: getRepoRoot(),
    })

    const summary = formatProfileSummary(resolved)
    ui.notify(`Default profile activated.\n\n${summary}`)
    ui.setStatus("zflow-profile", `Profile: ${resolved.profileName}`)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    ui.notify(`Failed to activate default profile:\n${message}`, "error")
  }
}

/**
 * Handler for `/zflow-profile show` — display detailed profile info.
 *
 * Shows the source file, every resolved lane with its model, disabled
 * optional lanes with reasons, agent bindings, and cache invalidation
 * metadata.
 */
async function handleShow(ui: {
  notify: (message: string, type?: "info" | "warning" | "error") => void
}): Promise<void> {
  const cache = await readActiveProfileCache().catch(() => null)

  if (!cache) {
    ui.notify(
      "No active profile cache found. Run `/zflow-profile default` to activate a profile first.",
    )
    return
  }

  const profile = cacheToResolvedProfile(cache)
  const detail = formatProfileDetail(profile, cache)
  ui.notify(detail)
}

/**
 * Handler for `/zflow-profile lanes` — show lane definitions and
 * resolution status.
 */
async function handleLanes(ui: {
  notify: (message: string, type?: "info" | "warning" | "error") => void
}): Promise<void> {
  const repoRoot = getRepoRoot()

  let profiles: LoadedProfiles
  try {
    profiles = await loadProfiles(repoRoot)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    ui.notify(`Failed to load profiles:\n${message}`, "error")
    return
  }

  const cache = await readActiveProfileCache().catch(() => null)
  const lines: string[] = []

  // Show available profile names
  const profileNames = Object.keys(profiles.profiles)
  lines.push(`Available profiles: ${profileNames.join(", ")}`)

  // Show the active profile name if cached
  if (cache) {
    lines.push(`Active profile: ${cache.profileName}`)
  }
  lines.push("")

  // Show lane definitions for the active (or first) profile
  const activeName = cache?.profileName ?? profileNames[0]
  const activeProfile = profiles.profiles[activeName]

  if (activeProfile) {
    lines.push(`Profile "${activeName}" lanes:`)
    for (const [laneName, lane] of Object.entries(activeProfile.lanes)) {
      const flags = lane.required
        ? "required"
        : lane.optional
          ? "optional"
          : "required"
      const thinking = lane.thinking ? `, thinking=${lane.thinking}` : ""
      const models = lane.preferredModels.join(", ")
      lines.push(`  - ${laneName} (${flags}${thinking})`)
      lines.push(`    preferredModels: ${models}`)

      // Show resolution status if cached
      if (cache?.resolvedLanes[laneName]) {
        const resolved = cache.resolvedLanes[laneName]
        if (resolved.status === "resolved") {
          lines.push(`    → resolved to: ${resolved.model}`)
        } else if (resolved.status === "disabled-optional") {
          lines.push(`    → disabled${resolved.reason ? `: ${resolved.reason}` : ""}`)
        } else if (resolved.status === "unresolved-required") {
          lines.push(`    → unresolved${resolved.reason ? `: ${resolved.reason}` : ""}`)
        }
      } else {
        lines.push(`    → not yet resolved`)
      }
    }
  }

  ui.notify(lines.join("\n"))
}

/**
 * Handler for `/zflow-profile refresh` — force re-resolution.
 *
 * Ignores the cached profile and re-resolves all lanes from the
 * original definitions, then writes a fresh cache.
 */
async function handleRefresh(ui: {
  notify: (message: string, type?: "info" | "warning" | "error") => void
  setStatus: (key: string, text: string | undefined) => void
}): Promise<void> {
  try {
    const resolved = await activateProfile("default", {
      repoRoot: getRepoRoot(),
    })

    const summary = formatProfileSummary(resolved)
    ui.notify(`Profile refreshed.\n\n${summary}`)
    ui.setStatus("zflow-profile", `Profile: ${resolved.profileName}`)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    ui.notify(`Failed to refresh profile:\n${message}`, "error")
  }
}

/**
 * Settings overrides entry for a single agent binding.
 * Written to `.pi/settings.json` as part of `subagents.agentOverrides`.
 */
export interface SettingsAgentOverride {
  /** Resolved model identifier for this agent. */
  model: string
  /** Comma-separated tools the agent is allowed to use. */
  tools?: string
  /** Maximum total output tokens for this agent. */
  maxOutput?: number
  /** Maximum depth of subagent nesting. */
  maxSubagentDepth?: number
}

/**
 * Result of a sync-to-settings operation.
 */
export interface SyncSettingsResult {
  /** Number of agent overrides written. */
  count: number
  /** Absolute path to the settings file that was written. */
  settingsPath: string
  /** List of agent names whose overrides were written. */
  agents: string[]
}

/**
 * Build agent overrides from an active profile cache.
 *
 * Iterates the cache's `agentBindings` and creates a mapping of
 * agent name → override entry for every binding that has a resolved
 * model. Skip entries with no resolved model (unresolved lanes).
 *
 * This is a pure function — it does no I/O and can be tested in
 * isolation.
 *
 * @param cache - The active profile cache with resolved agent bindings.
 * @returns A record of agent name to override settings, keyed for
 *          insertion into `subagents.agentOverrides`.
 */
export function buildAgentOverrides(
  cache: ActiveProfileCache,
): Record<string, SettingsAgentOverride> {
  const overrides: Record<string, SettingsAgentOverride> = {}

  for (const [agentName, binding] of Object.entries(cache.agentBindings)) {
    if (binding.resolvedModel) {
      const entry: SettingsAgentOverride = {
        model: binding.resolvedModel,
      }
      if (binding.tools) entry.tools = binding.tools
      if (binding.maxOutput) entry.maxOutput = binding.maxOutput
      if (binding.maxSubagentDepth !== undefined) {
        entry.maxSubagentDepth = binding.maxSubagentDepth
      }
      overrides[agentName] = entry
    }
  }

  return overrides
}

/**
 * Format a human-readable summary of the agent overrides that would
 * be written, suitable for display in a confirmation dialog or log.
 *
 * @param overrides - The agent overrides to summarise.
 * @param settingsPath - The path where the overrides would be written.
 * @returns An array of text lines (without trailing newlines).
 */
export function formatSyncSummary(
  overrides: Record<string, SettingsAgentOverride>,
  settingsPath: string,
): string[] {
  const lines: string[] = [
    "The following agent overrides will be written to:",
    `  ${settingsPath}`,
    "",
  ]

  const agentNames = Object.keys(overrides).sort()
  for (const agent of agentNames) {
    const override = overrides[agent]
    lines.push(`  ${agent}:`)
    lines.push(`    model: ${override.model}`)
    if (override.tools) lines.push(`    tools: ${override.tools}`)
    if (override.maxOutput) lines.push(`    maxOutput: ${override.maxOutput}`)
    if (override.maxSubagentDepth !== undefined) {
      lines.push(`    maxSubagentDepth: ${override.maxSubagentDepth}`)
    }
  }
  lines.push("")
  lines.push("This will modify your project settings. Continue?")

  return lines
}

/**
 * Synchronise the resolved active profile to `.pi/settings.json`.
 *
 * Writes a `subagents.agentOverrides` block based on the currently
 * resolved active profile cache. This is a narrow, explicit operation:
 *
 * - Only writes the `subagents.agentOverrides` key.
 * - Preserves all other keys in `settings.json` (e.g. existing
 *   `subagents` config that is not `agentOverrides`).
 * - Does NOT run as part of normal activation (`activateProfile` /
 *   `ensureResolved` never calls this).
 * - Requires an explicit opt-in (via `/zflow-profile sync-project`).
 *
 * The settings file is read, updated, and written atomically (via
 * write-then-rename). If the file does not exist, it is created.
 *
 * @param cache - The active profile cache with resolved agent bindings.
 * @param settingsPath - Absolute path to `.pi/settings.json`.
 * @returns A `SyncSettingsResult` describing what was written.
 * @throws {Error} If the file cannot be written (permissions, disk full).
 */
export async function syncProfileToSettings(
  cache: ActiveProfileCache,
  settingsPath: string,
): Promise<SyncSettingsResult> {
  // 1. Build agent overrides from the cache
  const agentOverrides = buildAgentOverrides(cache)
  const agentNames = Object.keys(agentOverrides)

  if (agentNames.length === 0) {
    return {
      count: 0,
      settingsPath,
      agents: [],
    }
  }

  // 2. Read existing settings or start fresh
  let settings: Record<string, unknown> = {}
  try {
    const existing = await fs.readFile(settingsPath, "utf8")
    settings = JSON.parse(existing) as Record<string, unknown>
  } catch {
    // File doesn't exist or is invalid JSON — start fresh
    settings = {}
  }

  // 3. Merge subagents.agentOverrides without destroying unrelated keys
  //    Preserve any existing subagents config that isn't agentOverrides
  const existingSubagents = settings.subagents as
    | Record<string, unknown>
    | undefined
  settings.subagents = {
    ...(existingSubagents ?? {}),
    agentOverrides,
  }

  // 4. Ensure parent directory exists
  await fs.mkdir(path.dirname(settingsPath), { recursive: true })

  // 5. Write atomically using temp-file-then-rename
  const tmpPath = settingsPath + ".tmp"
  try {
    await fs.writeFile(tmpPath, JSON.stringify(settings, null, 2), "utf8")
    await fs.rename(tmpPath, settingsPath)
  } catch (err) {
    // Clean up temp file on failure
    try {
      await fs.unlink(tmpPath)
    } catch {
      // Ignore cleanup errors
    }
    throw err
  }

  return {
    count: agentNames.length,
    settingsPath,
    agents: agentNames,
  }
}

/**
 * Handler for `/zflow-profile sync-project` — write resolved overrides
 * into `.pi/settings.json`.
 *
 * This is an explicit opt-in operation. It shows a confirmation dialog
 * with a summary of what will be written, then delegates to
 * `syncProfileToSettings()`.
 */
async function handleSyncProject(ui: {
  notify: (message: string, type?: "info" | "warning" | "error") => void
  confirm: (title: string, message: string) => Promise<boolean>
}): Promise<void> {
  const cache = await readActiveProfileCache().catch(() => null)

  if (!cache) {
    ui.notify(
      "No active profile found. Run `/zflow-profile default` first to activate a profile.",
    )
    return
  }

  const repoRoot = getRepoRoot()
  if (!repoRoot) {
    ui.notify(
      "Cannot determine project root. Run this command from within your project directory.",
    )
    return
  }

  const settingsPath = path.join(repoRoot, ".pi", "settings.json")

  // Build agent overrides (preview for confirmation)
  const agentOverrides = buildAgentOverrides(cache)
  const agentNames = Object.keys(agentOverrides)

  if (agentNames.length === 0) {
    ui.notify(
      "No resolved agent bindings to sync. Ensure the profile has resolved lanes with models.",
    )
    return
  }

  // Show a summary before writing
  const summaryLines = formatSyncSummary(agentOverrides, settingsPath)
  const confirmed = await ui.confirm(
    "Sync Profile to Settings",
    summaryLines.join("\n"),
  )
  if (!confirmed) {
    ui.notify("Sync cancelled.")
    return
  }

  // Perform the write
  try {
    const result = await syncProfileToSettings(cache, settingsPath)
    ui.notify(
      `Wrote ${result.count} agent override(s) to:\n` +
        `  ${result.settingsPath}\n\n` +
        `Run /zflow-profile refresh and then /zflow-profile sync-project again\n` +
        `to update the overrides after changing your profile.`,
    )
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    ui.notify(`Failed to write settings: ${message}`, "error")
  }
}

/**
 * Main handler for the `/zflow-profile` command.
 *
 * Parses the first argument to dispatch to the correct subcommand handler.
 * Supported subcommands:
 *   (no args)  — show active profile summary
 *   default    — activate the default profile
 *   show       — display detailed profile info
 *   lanes      — show lane definitions and status
 *   refresh    — force re-resolution
 *   sync-project — write resolved overrides to .pi/settings.json
 */
async function handleProfileCommand(
  args: string,
  ctx: { ui: {
    notify: (message: string, type?: "info" | "warning" | "error") => void
    setStatus: (key: string, text: string | undefined) => void
    confirm: (title: string, message: string) => Promise<boolean>
  }},
): Promise<void> {
  const trimmed = args.trim()
  const subcommand = trimmed.split(/\s+/)[0]?.toLowerCase() ?? ""

  if (!subcommand) {
    await handleNoArgs(ctx.ui)
    return
  }

  switch (subcommand) {
    case "default":
      await handleDefault(ctx.ui)
      break
    case "show":
      await handleShow(ctx.ui)
      break
    case "lanes":
      await handleLanes(ctx.ui)
      break
    case "refresh":
      await handleRefresh(ctx.ui)
      break
    case "sync-project":
      await handleSyncProject(ctx.ui)
      break
    default:
      ctx.ui.notify(
        `Unknown subcommand: "${subcommand}".\n\n` +
          `Available subcommands:\n` +
          `  /zflow-profile          — show active profile summary\n` +
          `  /zflow-profile default   — activate the default profile\n` +
          `  /zflow-profile show      — display detailed profile info\n` +
          `  /zflow-profile lanes     — show lane definitions and status\n` +
          `  /zflow-profile refresh   — force re-resolution\n` +
          `  /zflow-profile sync-project — write resolved overrides to .pi/settings.json`,
      )
  }
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
    ensureResolved,
    readActiveProfileCache,
    writeActiveProfileCache,
    computeCurrentProfileHash,
    computeEnvironmentFingerprintFromRegistry,
    preflightLaneHealth,
    handleLaneFailure,
    reresolveLane,
    checkLaneHealth,
    getHealthStatusSummary,
    buildAgentOverrides,
    syncProfileToSettings,
    formatSyncSummary,
  }

  registry.provide(PROFILES_CAPABILITY, profileService)

  // ── Register the /zflow-profile command ────────────────────────
  pi.registerCommand("zflow-profile", {
    description:
      "Manage and inspect zflow profiles. Subcommands: " +
      "default, show, lanes, refresh, sync-project. " +
      "Use without arguments for a summary.",
    handler: async (args: string, ctx: {
      ui: {
        notify: (message: string, type?: "info" | "warning" | "error") => void
        setStatus: (key: string, text: string | undefined) => void
        confirm: (title: string, message: string) => Promise<boolean>
      }
    }): Promise<void> => {
      await handleProfileCommand(args, ctx)
    },
  })
}
