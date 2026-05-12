/**
 * profiles.ts — Profile schema, validation, and normalization.
 *
 * Phase 2 implementation of the logical profile definition types and
 * runtime validation layer for pi-zflow-profiles.
 *
 * Schema shape (from Phase 2 task 2.1):
 *   LaneDefinition   — a single logical lane with required/optional flag,
 *                      thinking level, and an ordered list of preferred models
 *   AgentBinding     — maps an agent to a lane with optional constraints
 *   ProfileDefinition — a named profile containing lanes and agent bindings
 *   ProfilesFile     — top-level container keyed by profile name
 *
 * Validation rules:
 *   - The "default" profile must exist.
 *   - Every agent binding must reference a lane that exists in the profile.
 *   - Every lane must have a non-empty `preferredModels` array.
 *   - A lane may not have both `required: true` and `optional: true`.
 *   - Omitted required/optional flags are normalized to a consistent form.
 *
 * @module pi-zflow-profiles/profiles
 */

// ── Public types (raw input form) ───────────────────────────────

/**
 * A single logical lane definition.
 *
 * Lanes are the abstraction layer between role names and concrete
 * provider/model pairs. Resolution walks `preferredModels` in order
 * and picks the first valid candidate.
 */
export interface LaneDefinition {
  /**
   * When true, activation or preflight must fail if this lane cannot
   * be resolved to a concrete model.
   */
  required?: boolean

  /**
   * When true, this lane is nice-to-have. If it cannot resolve, it
   * is disabled with a warning but does not block activation.
   */
  optional?: boolean

  /**
   * Desired thinking/reasoning effort level for models in this lane.
   * - "low":  cheap/quick reasoning (suitable for scout, repo-mapper)
   * - "medium": balanced reasoning (routine implementation, verification)
   * - "high": deep reasoning (planning, security review, hard implementation)
   */
  thinking?: "low" | "medium" | "high"

  /**
   * Ordered list of preferred model identifiers (e.g. "openai/gpt-5.4").
   * Resolution tries each candidate in order until one passes all
   * capability and availability checks.
   */
  preferredModels: string[]
}

/**
 * Binding of a named agent to a logical lane.
 *
 * Agent bindings tell the runtime which lane to use when dispatching
 * work to a particular subagent, along with optional constraints.
 */
export interface AgentBinding {
  /**
   * The lane name this agent should use. Must exist in the profile's
   * `lanes` map.
   */
  lane: string

  /**
   * When true, this agent binding is optional. If the lane fails to
   * resolve, the agent is skipped rather than causing an error.
   */
  optional?: boolean

  /**
   * Comma-separated list of tools the agent is allowed to use.
   * If omitted, the agent uses its default tool set.
   */
  tools?: string

  /**
   * Maximum total output tokens for this agent.
   * If omitted, the agent uses its default or the lane-level default.
   */
  maxOutput?: number

  /**
   * Maximum depth of subagent nesting for this agent.
   * If omitted, the agent uses its default.
   */
  maxSubagentDepth?: number
}

/**
 * A single named profile definition.
 *
 * Profiles bundle logical lane definitions with agent-to-lane bindings,
 * providing a complete, portable model-selection policy.
 */
export interface ProfileDefinition {
  /** Optional human-readable description of this profile. */
  description?: string

  /**
   * Shell command to run for workspace verification (e.g. "npm test").
   * Used by the verification workflow after implementation.
   */
  verificationCommand?: string

  /**
   * Logical lane definitions keyed by lane name.
   * Lane names are kebab-case identifiers like "planning-frontier"
   * or "worker-cheap".
   */
  lanes: Record<string, LaneDefinition>

  /**
   * Agent-to-lane bindings keyed by agent runtime name.
   * Agent names use dotted notation like "zflow.planner-frontier".
   */
  agentBindings: Record<string, AgentBinding>
}

/**
 * Top-level profiles file.
 *
 * Keyed by profile name. The "default" profile is required.
 */
export interface ProfilesFile {
  [profileName: string]: ProfileDefinition
}

// ── Normalized types (internal resolved form) ───────────────────

/**
 * Normalized lane definition with resolved required/optional booleans.
 */
export interface NormalizedLaneDefinition {
  required: boolean
  optional: boolean
  thinking?: "low" | "medium" | "high"
  preferredModels: string[]
}

/**
 * Normalized agent binding with resolved optional boolean.
 */
export interface NormalizedAgentBinding {
  lane: string
  optional: boolean
  tools?: string
  maxOutput?: number
  maxSubagentDepth?: number
}

/**
 * Normalized profile definition with fully resolved fields.
 */
export interface NormalizedProfileDefinition {
  description?: string
  verificationCommand?: string
  lanes: Record<string, NormalizedLaneDefinition>
  agentBindings: Record<string, NormalizedAgentBinding>
}

/**
 * Normalized profiles file.
 */
export interface NormalizedProfilesFile {
  [profileName: string]: NormalizedProfileDefinition
}

// ── Lane resolution types ───────────────────────────────────────

/** Possible resolved status for a lane. */
export type LaneStatus = "resolved" | "disabled-optional" | "unresolved-required"

/**
 * Result of resolving a single logical lane to a concrete model.
 */
export interface ResolvedLane {
  /** Lane name (e.g. "planning-frontier"). */
  lane: string
  /** Resolved model identifier, or null if the lane could not be resolved. */
  model: string | null
  /** Whether this lane is required for activation. */
  required: boolean
  /** Whether this lane is optional (nice-to-have). */
  optional: boolean
  /** Effective thinking level after resolution (may be clamped). */
  thinking?: "low" | "medium" | "high"
  /** Resolution status. */
  status: LaneStatus
  /** Human-readable explanation for failures, skips, or changes. */
  reason?: string
}

/**
 * Resolved agent binding with concrete model resolved from its lane.
 */
export interface ResolvedAgentBinding {
  /** Agent runtime name (e.g. "zflow.planner-frontier"). */
  agent: string
  /** Lane this agent is bound to. */
  lane: string
  /** Concrete model identifier resolved for this agent's lane. */
  resolvedModel: string | null
  /** Whether this binding is optional. */
  optional: boolean
  /** Tools the agent is allowed to use. */
  tools?: string
  /** Maximum output tokens for this agent. */
  maxOutput?: number
  /** Maximum subagent nesting depth. */
  maxSubagentDepth?: number
  /** Resolution status of the underlying lane. */
  status: LaneStatus
  /** Reason if unresolved or degraded. */
  reason?: string
}

/**
 * A fully resolved profile: all lanes resolved and all agent bindings
 * mapped to concrete models.
 */
export interface ResolvedProfile {
  /** Name of the profile that was resolved (e.g. "default"). */
  profileName: string
  /** Source file the profile was loaded from. */
  sourcePath: string
  /** Timestamp when resolution was performed. */
  resolvedAt: string
  /** Per-lane resolution results. */
  resolvedLanes: Record<string, ResolvedLane>
  /** Per-agent binding resolution results. */
  agentBindings: Record<string, ResolvedAgentBinding>
}

// ── Model registry interface ───────────────────────────────────

/**
 * Information about a model available in the runtime environment.
 */
export interface ModelInfo {
  /** Full model identifier (e.g. "openai/gpt-5.4", "github-copilot/gpt-5.4-codex"). */
  id: string
  /** Whether this model supports tool calling. */
  supportsTools: boolean
  /** Whether this model supports text input/output. */
  supportsText: boolean
  /** The model's maximum available thinking/reasoning capability. */
  thinkingCapability: "low" | "medium" | "high"
  /** Whether the user is authenticated and the model is available for use. */
  authenticated: boolean
  /**
   * Maximum context window size in tokens (optional).
   * If omitted, context window is considered unconstrained.
   */
  contextWindow?: number
  /**
   * Maximum output tokens (optional).
   * If omitted, output is considered unconstrained.
   */
  maxOutput?: number
}

/**
 * Richer capability profile for a model, used by the capability checking
 * module for detailed compatibility evaluation beyond basic availability.
 *
 * This builds on `ModelInfo` by adding structured enumerations for
 * capability dimensions and numeric thresholds.
 */
export interface ModelCapabilityProfile {
  /** Full model identifier. */
  id: string
  /** Whether the model supports tool calling. */
  supportsTools: boolean
  /** Whether the model supports text input/output. */
  supportsText: boolean
  /** The model's maximum thinking/reasoning capability. */
  thinkingCapability: "low" | "medium" | "high"
  /** Maximum context window in tokens (undefined = unconstrained). */
  contextWindow?: number
  /** Maximum output in tokens (undefined = unconstrained). */
  maxOutput?: number
  /** Maximum number of tools the model can call in a single turn. */
  maxToolsPerTurn?: number
}

/**
 * Requirements that a lane or agent binding imposes on candidate models.
 *
 * Used by the capability checking functions to determine whether a
 * particular model is suitable for the role.
 */
export interface CapabilityRequirements {
  /** Whether the model must support tool calling. */
  requiresTools: boolean
  /** Whether the model must support text input/output. */
  requiresText: boolean
  /** Minimum required thinking level (optional). */
  requiredThinking?: "low" | "medium" | "high"
  /** Whether this is a conservative lane that rejects thinking downgrades. */
  isConservativeLane: boolean
  /** Minimum context window size in tokens (optional). */
  minContextWindow?: number
  /** Minimum output tokens required (optional). */
  minOutput?: number
}

/**
 * Abstract interface for querying model availability and capabilities.
 *
 * Implementations connect this to the actual Pi runtime model registry
 * (e.g., via `pi --list-models` or the Pi AI SDK). This interface
 * keeps the resolution engine testable without a live Pi environment.
 */
export interface ModelRegistry {
  /**
   * Look up a model by its identifier.
   * Returns `undefined` if the model is not known to the runtime.
   */
  getModel(modelId: string): ModelInfo | undefined
}

// ── Validation result types ─────────────────────────────────────

/**
 * Severity levels for profile validation messages.
 */
export type ValidationSeverity = "error" | "warn"

/**
 * A single validation message.
 */
export interface ValidationMessage {
  severity: ValidationSeverity
  /** Path to the field that caused the message (e.g. "default.lanes.scout-cheap.preferredModels") */
  path: string
  /** Human-readable message. */
  message: string
}

/**
 * Result of validating a profiles file.
 */
export interface ValidationResult {
  valid: boolean
  errors: ValidationMessage[]
  warnings: ValidationMessage[]
}

/**
 * Parsed and fully validated profiles file.
 */
export interface ParsedProfilesFile {
  source: string
  profiles: NormalizedProfilesFile
  validation: ValidationResult
}

// ── Error class ─────────────────────────────────────────────────

/**
 * Error thrown when a profiles file fails validation.
 * Contains the complete validation result for diagnostic rendering.
 */
export class ProfileValidationError extends Error {
  public readonly validation: ValidationResult

  constructor(validation: ValidationResult) {
    const msg = validation.errors.map((e) => `  - ${e.path}: ${e.message}`).join("\n")
    super(`Profile validation failed with ${validation.errors.length} error(s):\n${msg}`)
    this.name = "ProfileValidationError"
    this.validation = validation
  }
}

// ── Constants ───────────────────────────────────────────────────

/** Valid thinking levels. */
export const THINKING_LEVELS = ["low", "medium", "high"] as const

/** Default thinking level when not specified. */
export const DEFAULT_THINKING = "medium" as const

// ── Validation helpers ──────────────────────────────────────────

/**
 * Check if a value is a non-empty string.
 */
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

/**
 * Check if a value is a valid thinking level.
 */
function isValidThinking(v: unknown): v is "low" | "medium" | "high" {
  return THINKING_LEVELS.includes(v as any)
}

// ── Validation logic ────────────────────────────────────────────

/**
 * Validate a raw parsed profiles file.
 *
 * Returns a `ValidationResult` with errors and warnings but does not
 * throw. Use `validateProfilesFile()` for the throwing variant.
 *
 * @param data - The raw parsed JSON data to validate.
 * @returns Validation result with errors and warnings.
 */
export function validateProfilesFile(data: unknown): ValidationResult {
  const errors: ValidationMessage[] = []
  const warnings: ValidationMessage[] = []

  if (data === null || data === undefined || typeof data !== "object") {
    errors.push({
      severity: "error",
      path: "<root>",
      message: "Profiles file must be a JSON object with profile names as keys.",
    })
    return { valid: errors.length === 0, errors, warnings }
  }

  const root = data as Record<string, unknown>

  // ── Check for "default" profile ───────────────────────────────
  if (!root["default"]) {
    errors.push({
      severity: "error",
      path: "<root>",
      message: `Missing required "default" profile. The profiles file must define a "default" profile that activates on startup.`,
    })
  }

  // ── Validate each profile ─────────────────────────────────────
  for (const [profileName, profileRaw] of Object.entries(root)) {
    const profilePath = (p: string) => `${profileName}.${p}`

    if (!profileRaw || typeof profileRaw !== "object") {
      errors.push({
        severity: "error",
        path: profileName,
        message: `Profile "${profileName}" must be a non-null object.`,
      })
      continue
    }

    const profile = profileRaw as Record<string, unknown>

    // ── Validate description (optional) ─────────────────────────
    if (profile.description !== undefined && typeof profile.description !== "string") {
      errors.push({
        severity: "error",
        path: profilePath("description"),
        message: `Profile "${profileName}" description must be a string.`,
      })
    }

    // ── Validate verificationCommand (optional) ─────────────────
    if (
      profile.verificationCommand !== undefined &&
      typeof profile.verificationCommand !== "string"
    ) {
      errors.push({
        severity: "error",
        path: profilePath("verificationCommand"),
        message: `Profile "${profileName}" verificationCommand must be a string.`,
      })
    }

    // ── Validate lanes ─────────────────────────────────────────
    if (!profile.lanes || typeof profile.lanes !== "object") {
      errors.push({
        severity: "error",
        path: profilePath("lanes"),
        message: `Profile "${profileName}" must have a "lanes" object.`,
      })
      // Can't validate agentBindings without lanes
      continue
    }

    const lanes = profile.lanes as Record<string, unknown>
    const validLaneNames = new Set<string>()

    for (const [laneName, laneRaw] of Object.entries(lanes)) {
      const lanePath = (p: string) => profilePath(`lanes.${laneName}${p ? "." + p : ""}`)

      if (!laneRaw || typeof laneRaw !== "object") {
        errors.push({
          severity: "error",
          path: lanePath(""),
          message: `Lane "${laneName}" in profile "${profileName}" must be a non-null object.`,
        })
        continue
      }

      const lane = laneRaw as Record<string, unknown>

      // ── Validate preferredModels ──────────────────────────────
      if (
        !Array.isArray(lane.preferredModels) ||
        lane.preferredModels.length === 0 ||
        !lane.preferredModels.every(isNonEmptyString)
      ) {
        errors.push({
          severity: "error",
          path: lanePath("preferredModels"),
          message: `Lane "${laneName}" in profile "${profileName}" must have a non-empty "preferredModels" array of non-empty strings.`,
        })
      }

      // ── Validate required/optional conflict ───────────────────
      const hasRequired = "required" in lane
      const hasOptional = "optional" in lane
      const requiredVal = lane.required
      const optionalVal = lane.optional

      if (
        hasRequired &&
        requiredVal === true &&
        hasOptional &&
        optionalVal === true
      ) {
        errors.push({
          severity: "error",
          path: lanePath(""),
          message: `Lane "${laneName}" in profile "${profileName}" has both "required: true" and "optional: true", which conflict semantically. Set only one or omit both (defaults to required).`,
        })
      }

      // Validate types for required
      if (hasRequired && typeof requiredVal !== "boolean") {
        errors.push({
          severity: "error",
          path: lanePath("required"),
          message: `Lane "${laneName}" in profile "${profileName}" "required" must be a boolean.`,
        })
      }

      // Validate types for optional
      if (hasOptional && typeof optionalVal !== "boolean") {
        errors.push({
          severity: "error",
          path: lanePath("optional"),
          message: `Lane "${laneName}" in profile "${profileName}" "optional" must be a boolean.`,
        })
      }

      // ── Validate thinking level ───────────────────────────────
      if (lane.thinking !== undefined && !isValidThinking(lane.thinking)) {
        errors.push({
          severity: "error",
          path: lanePath("thinking"),
          message: `Lane "${laneName}" in profile "${profileName}" "thinking" must be one of: ${THINKING_LEVELS.join(", ")}.`,
        })
      }

      validLaneNames.add(laneName)
    }

    // ── Validate agentBindings ─────────────────────────────────
    if (!profile.agentBindings || typeof profile.agentBindings !== "object") {
      errors.push({
        severity: "error",
        path: profilePath("agentBindings"),
        message: `Profile "${profileName}" must have an "agentBindings" object.`,
      })
      continue
    }

    const agentBindings = profile.agentBindings as Record<string, unknown>

    for (const [agentName, bindingRaw] of Object.entries(agentBindings)) {
      const bindingPath = (p: string) =>
        profilePath(`agentBindings.${agentName}${p ? "." + p : ""}`)

      if (!bindingRaw || typeof bindingRaw !== "object") {
        errors.push({
          severity: "error",
          path: bindingPath(""),
          message: `Agent binding "${agentName}" in profile "${profileName}" must be a non-null object.`,
        })
        continue
      }

      const binding = bindingRaw as Record<string, unknown>

      // ── Validate lane reference ───────────────────────────────
      if (!isNonEmptyString(binding.lane)) {
        errors.push({
          severity: "error",
          path: bindingPath("lane"),
          message: `Agent binding "${agentName}" in profile "${profileName}" must have a non-empty "lane" string.`,
        })
      } else if (!validLaneNames.has(binding.lane)) {
        errors.push({
          severity: "error",
          path: bindingPath("lane"),
          message: `Agent binding "${agentName}" in profile "${profileName}" references lane "${binding.lane}" which is not defined in "lanes".`,
        })
      }

      // ── Validate optional (if present) ────────────────────────
      if (binding.optional !== undefined && typeof binding.optional !== "boolean") {
        errors.push({
          severity: "error",
          path: bindingPath("optional"),
          message: `Agent binding "${agentName}" in profile "${profileName}" "optional" must be a boolean.`,
        })
      }

      // ── Validate tools (if present) ───────────────────────────
      if (binding.tools !== undefined && typeof binding.tools !== "string") {
        errors.push({
          severity: "error",
          path: bindingPath("tools"),
          message: `Agent binding "${agentName}" in profile "${profileName}" "tools" must be a comma-separated string.`,
        })
      }

      // ── Validate maxOutput (if present) ───────────────────────
      if (
        binding.maxOutput !== undefined &&
        (typeof binding.maxOutput !== "number" ||
          !Number.isInteger(binding.maxOutput) ||
          binding.maxOutput <= 0)
      ) {
        errors.push({
          severity: "error",
          path: bindingPath("maxOutput"),
          message: `Agent binding "${agentName}" in profile "${profileName}" "maxOutput" must be a positive integer.`,
        })
      }

      // ── Validate maxSubagentDepth (if present) ────────────────
      if (
        binding.maxSubagentDepth !== undefined &&
        (typeof binding.maxSubagentDepth !== "number" ||
          !Number.isInteger(binding.maxSubagentDepth) ||
          binding.maxSubagentDepth < 0)
      ) {
        errors.push({
          severity: "error",
          path: bindingPath("maxSubagentDepth"),
          message: `Agent binding "${agentName}" in profile "${profileName}" "maxSubagentDepth" must be a non-negative integer.`,
        })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

// ── Normalization logic ─────────────────────────────────────────

/**
 * Normalize a raw lane definition into its resolved form.
 *
 * Rules:
 * - If `required: true` and `optional` is not explicitly true → required
 * - If `optional: true` and `required` is not explicitly true → optional
 * - If neither is set → required (default for safety)
 * - Both cannot be true (must be caught by validation)
 */
export function normalizeLaneDefinition(lane: LaneDefinition): NormalizedLaneDefinition {
  const requiredExplicit = lane.required === true
  const optionalExplicit = lane.optional === true

  // Both true is a validation error, but if we get here, normalize safely
  const required = requiredExplicit || (!requiredExplicit && !optionalExplicit)
  const optional = optionalExplicit && !requiredExplicit

  return {
    required,
    optional,
    thinking: lane.thinking,
    preferredModels: lane.preferredModels,
  }
}

/**
 * Normalize a raw agent binding into its resolved form.
 */
export function normalizeAgentBinding(binding: AgentBinding): NormalizedAgentBinding {
  return {
    lane: binding.lane,
    optional: binding.optional === true,
    tools: binding.tools,
    maxOutput: binding.maxOutput,
    maxSubagentDepth: binding.maxSubagentDepth,
  }
}

/**
 * Normalize a raw profile definition into its resolved form.
 */
export function normalizeProfileDefinition(
  profile: ProfileDefinition,
): NormalizedProfileDefinition {
  const normalizedLanes: Record<string, NormalizedLaneDefinition> = {}
  for (const [laneName, lane] of Object.entries(profile.lanes)) {
    normalizedLanes[laneName] = normalizeLaneDefinition(lane)
  }

  const normalizedBindings: Record<string, NormalizedAgentBinding> = {}
  for (const [agentName, binding] of Object.entries(profile.agentBindings)) {
    normalizedBindings[agentName] = normalizeAgentBinding(binding)
  }

  return {
    description: profile.description,
    verificationCommand: profile.verificationCommand,
    lanes: normalizedLanes,
    agentBindings: normalizedBindings,
  }
}

/**
 * Normalize a raw profiles file into its resolved form.
 */
export function normalizeProfilesFile(
  profiles: ProfilesFile,
): NormalizedProfilesFile {
  const normalized: NormalizedProfilesFile = {}
  for (const [name, profile] of Object.entries(profiles)) {
    normalized[name] = normalizeProfileDefinition(profile)
  }
  return normalized
}

// ── Parse and validate ──────────────────────────────────────────

/**
 * Parse a raw JSON value as a profiles file, validate it, and
 * return the validated and normalized result.
 *
 * @param data - The raw parsed JSON data.
 * @returns Validation result and normalized profiles.
 * @throws {ProfileValidationError} If validation fails.
 */
export function parseProfilesFile(data: unknown): {
  profiles: NormalizedProfilesFile
  validation: ValidationResult
} {
  const validation = validateProfilesFile(data)

  if (!validation.valid) {
    throw new ProfileValidationError(validation)
  }

  const profiles = normalizeProfilesFile(data as ProfilesFile)

  return { profiles, validation }
}

/**
 * Parse a raw JSON string as a profiles file.
 *
 * @param json - The JSON string to parse.
 * @returns Validation result and normalized profiles.
 * @throws {ProfileValidationError} If validation fails.
 * @throws {SyntaxError} If JSON parsing fails.
 */
export function parseProfilesFileJson(json: string): {
  profiles: NormalizedProfilesFile
  validation: ValidationResult
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (e) {
    const message = e instanceof SyntaxError ? e.message : "Invalid JSON"
    const validation: ValidationResult = {
      valid: false,
      errors: [
        {
          severity: "error",
          path: "<json>",
          message: `Failed to parse profiles file: ${message}`,
        },
      ],
      warnings: [],
    }
    throw new ProfileValidationError(validation)
  }
  return parseProfilesFile(parsed)
}

// ── Profile file loading ────────────────────────────────────────

import * as fs from "node:fs/promises"
import * as fss from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

/**
 * Result of a successful profile file load.
 */
export interface LoadedProfiles {
  /** Absolute path to the source file that was loaded. */
  source: string
  /** Parsed, validated, and normalized profile definitions. */
  profiles: NormalizedProfilesFile
  /** Validation result (valid is guaranteed true here). */
  validation: ValidationResult
}

/**
 * Resolve the project-local profile definition path.
 *
 * @param repoRoot - The repository root directory.
 * @returns The absolute path to `.pi/zflow-profiles.json` within the repo,
 *          or `null` if `repoRoot` is not provided.
 */
export function resolveProjectProfilePath(repoRoot?: string): string | null {
  if (!repoRoot) return null
  return path.resolve(repoRoot, ".pi", "zflow-profiles.json")
}

/**
 * Resolve the user-global profile definition path.
 *
 * Always returns `~/.pi/agent/zflow-profiles.json`.
 */
export function resolveUserProfilePath(): string {
  return path.join(os.homedir(), ".pi", "agent", "zflow-profiles.json")
}

/**
 * Async check whether a file exists at the given path.
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fs.constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Sync check whether a file exists at the given path.
 */
export function fileExistsSync(filePath: string): boolean {
  try {
    fss.accessSync(filePath, fss.constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Determine the profile source path using project-local override with
 * user-global fallback.
 *
 * Resolution order:
 *   1. `.pi/zflow-profiles.json` in the active repo (if `repoRoot` provided)
 *   2. `~/.pi/agent/zflow-profiles.json` as fallback
 *
 * If `repoRoot` is omitted, only the user-global path is considered.
 *
 * @param repoRoot - Optional repository root directory.
 * @returns The absolute path of the chosen source file.
 * @throws If neither path exists and is readable.
 */
export async function resolveProfileSource(repoRoot?: string): Promise<string> {
  const projectPath = resolveProjectProfilePath(repoRoot)
  const userPath = resolveUserProfilePath()

  // Check project path first
  if (projectPath && (await fileExists(projectPath))) {
    return projectPath
  }

  // Check user path
  if (await fileExists(userPath)) {
    return userPath
  }

  // Neither exists — build an actionable error
  const candidates: string[] = []
  if (projectPath) candidates.push(projectPath)
  candidates.push(userPath)

  throw new ProfileFileNotFoundError(candidates)
}

/**
 * Error thrown when no profile definition file can be found at any
 * of the expected locations.
 */
export class ProfileFileNotFoundError extends Error {
  /** Paths that were checked and did not exist. */
  public readonly searchedPaths: string[]

  constructor(searchedPaths: string[]) {
    const paths = searchedPaths.map((p) => `  - ${p}`).join("\n")
    super(
      "No profile definition file found. Searched:\n" +
        paths +
        "\n\n" +
        'Create a ".pi/zflow-profiles.json" in your project or ' +
        '"~/.pi/agent/zflow-profiles.json" in your home directory. ' +
        "You can copy the example from the pi-zflow-profiles package.",
    )
    this.name = "ProfileFileNotFoundError"
    this.searchedPaths = searchedPaths
  }
}

/**
 * Load profile definitions from the filesystem.
 *
 * Resolution order:
 *   1. `.pi/zflow-profiles.json` in the active repo (project-local override)
 *   2. `~/.pi/agent/zflow-profiles.json` (user-global fallback)
 *
 * The chosen source path is recorded in the return value and can be
 * surfaced in `/zflow-profile show` output.
 *
 * @param repoRoot - Optional repository root directory. When provided,
 *                   the project-local path is checked first.
 * @returns The loaded, validated, and normalized profiles with source path.
 * @throws {ProfileFileNotFoundError} If no profile file exists at any
 *         expected location.
 * @throws {ProfileValidationError} If the file content fails validation.
 * @throws {SyntaxError} If the file content is not valid JSON.
 */
export async function loadProfiles(repoRoot?: string): Promise<LoadedProfiles> {
  const source = await resolveProfileSource(repoRoot)
  const raw = await fs.readFile(source, "utf8")
  const { profiles, validation } = parseProfilesFileJson(raw)
  return { source, profiles, validation }
}

/**
 * Synchronous version of `loadProfiles()`.
 *
 * Resolution order:
 *   1. `.pi/zflow-profiles.json` in the active repo (project-local override)
 *   2. `~/.pi/agent/zflow-profiles.json` (user-global fallback)
 *
 * @param repoRoot - Optional repository root directory.
 * @returns The loaded, validated, and normalized profiles with source path.
 * @throws {ProfileFileNotFoundError} If no profile file exists.
 * @throws {ProfileValidationError} If the file content fails validation.
 * @throws {SyntaxError} If the file content is not valid JSON.
 */
export function loadProfilesSync(repoRoot?: string): LoadedProfiles {
  const projectPath = resolveProjectProfilePath(repoRoot)
  const userPath = resolveUserProfilePath()

  // Determine source path
  let source: string | null = null
  if (projectPath && fileExistsSync(projectPath)) {
    source = projectPath
  } else if (fileExistsSync(userPath)) {
    source = userPath
  }

  if (!source) {
    const candidates: string[] = []
    if (projectPath) candidates.push(projectPath)
    candidates.push(userPath)
    throw new ProfileFileNotFoundError(candidates)
  }

  const raw = fss.readFileSync(source, "utf8")
  const { profiles, validation } = parseProfilesFileJson(raw)
  return { source, profiles, validation }
}
