/**
 * tui-components.ts — Reusable TUI components for the profile configuration wizard.
 *
 * Components:
 *   - ProviderModelPicker — Browse providers and select models with capability info.
 *   - ThinkingLevelPicker — Cycle through supported thinking levels.
 *   - LaneEditor — Full lane editing form (model stack, thinking, required/optional, fallbacks).
 *   - AgentBindingEditor — Agent-to-lane binding with tool/maxOutput/maxSubagentDepth.
 *   - ReviewSummary — Side-by-side before/after summary with confirm.
 *
 * @module pi-zflow-profiles/tui-components
 */

import type {
  SelectItem,
} from "@earendil-works/pi-tui"

import type {
  ThinkingLevel,
  LaneDefinition,
  AgentBinding,
  ProfileDefinition,
  NormalizedProfileDefinition,
} from "./profiles.js"

// ═══════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════

/** A model entry enriched for display in the wizard. */
export interface DisplayModel {
  /** Full provider/id identifier (e.g. "openai/gpt-5.4"). */
  id: string
  /** Human-readable model name. */
  name: string
  /** Provider this model belongs to. */
  provider: string
  /** Whether this model supports tool calling. */
  supportsTools: boolean
  /** Whether this model supports text I/O. */
  supportsText: boolean
  /** Whether the user is authenticated for this model. */
  authenticated: boolean
  /** Maximum thinking capability. */
  thinkingCapability: ThinkingLevel
  /** Which thinking levels are supported (null = unsupported). */
  thinkingLevelMap?: Record<string, string | null>
  /** Context window size, if known. */
  contextWindow?: number
  /** Maximum output tokens, if known. */
  maxTokens?: number
  /** Reasoning support. */
  reasoning: boolean
}

/** A provider group containing its models. */
export interface ProviderGroup {
  /** Provider name. */
  name: string
  /** Models belonging to this provider. */
  models: DisplayModel[]
  /** Whether the user has at least one authenticated model here. */
  hasAuth: boolean
}

/** Editing state for a single lane. */
export interface LaneEditState {
  laneName: string
  /** Human-readable description of this lane's role. */
  description: string
  selectedModels: string[]
  thinking: ThinkingLevel
  required: boolean
  optional: boolean
  /** Whether this lane uses multiple providers (review enhancement). */
  multiProvider: boolean
}

/** Editing state for a single agent binding. */
export interface AgentEditState {
  agentName: string
  /** Human-readable description of this agent's role. */
  description: string
  lane: string
  thinking: ThinkingLevel
  tools: string
  maxOutput: number
  maxSubagentDepth: number
  optional: boolean
}

/** The full wizard editing state. */
export interface WizardEditState {
  profileName: string
  lanes: LaneEditState[]
  agentBindings: AgentEditState[]
}

// ═══════════════════════════════════════════════════════════════════
//  Lane & agent metadata
// ═══════════════════════════════════════════════════════════════════

/** Descriptions for each lane role. */
export const LANE_DESCRIPTIONS: Record<string, string> = {
  "scout-cheap":
    "Fast, cheap reconnaissance and repository mapping. Uses low-thinking models to explore codebases and gather context efficiently.",
  "planning-frontier":
    "Deep reasoning for planning and design decisions. Requires high-thinking frontier models that excel at architecture and trade-off analysis.",
  "worker-cheap":
    "Routine code changes and verification. Uses cost-effective models for straightforward implementation tasks like editing, writing, and testing.",
  "worker-strong":
    "Complex implementation requiring deep code understanding. Uses powerful models for hard refactors, algorithmic work, and cross-cutting changes.",
  "review-correctness":
    "Code correctness review — checks logic, edge cases, error handling, and functional completeness against the plan.",
  "review-integration":
    "Integration review — validates that changes fit within the existing system, don't break contracts, and compose correctly with other changes.",
  "review-security":
    "Security review — identifies vulnerabilities, injection risks, auth bypasses, and unsafe patterns in the implementation.",
  "review-logic":
    "Logic and algorithmic review — deep analysis of computational correctness, complexity, and data flow integrity.",
  "review-system":
    "System-level review — architecture-level validation of the change's impact on the wider system, including performance and scalability.",
  "synthesis-frontier":
    "Synthesis of review findings into actionable, prioritized, non-redundant reports. Requires frontier models for coherent consolidation.",
}

/** Descriptions for each agent role. */
export const AGENT_DESCRIPTIONS: Record<string, string> = {
  "scout":
    "Reconnaissance agent — explores the codebase, maps structure, and gathers context with cheap models. Read-only; no mutations.",
  "zflow.planner-frontier":
    "Planning agent — produces versioned, decision-complete planning artifacts. Uses deep reasoning for architecture and design.",
  "zflow.plan-validator":
    "Plan validation agent — checks planning artifacts for completeness, consistency, and feasibility before implementation begins.",
  "context-builder":
    "Context assembly agent — gathers and synthesises project context (docs, code structure, conventions) for other agents.",
  "zflow.implement-routine":
    "Routine implementation agent — handles straightforward code changes like edits, writes, and simple refactors.",
  "zflow.implement-hard":
    "Hard implementation agent — tackles complex changes requiring deep code understanding, algorithm work, and cross-cutting refactors.",
  "zflow.verifier":
    "Verification agent — runs tests, linters, and build checks to validate implementation correctness.",
  "zflow.review-correctness":
    "Review agent — checks code for logical correctness, edge cases, error handling, and functional completeness against the plan.",
  "zflow.review-integration":
    "Review agent — validates system integration, contract compliance, and cross-change composition.",
  "zflow.review-security":
    "Review agent — identifies security vulnerabilities, injection risks, and unsafe patterns.",
  "zflow.review-logic":
    "Review agent — deep analysis of algorithmic correctness, complexity, and data flow integrity.",
  "zflow.review-system":
    "Review agent — architecture-level validation including performance, scalability, and system-wide impact.",
  "zflow.synthesizer":
    "Synthesis agent — consolidates multiple review findings into coherent, prioritized, non-redundant reports. Requires frontier reasoning.",
  "zflow.repo-mapper":
    "Repository mapping agent — generates high-level structural overviews of the codebase for orientation and planning.",
  "zflow.plan-review-correctness":
    "Plan review agent — validates planning artifacts for logical correctness and completeness before implementation.",
  "zflow.plan-review-integration":
    "Plan review agent — checks plan integration with existing system architecture and conventions.",
  "zflow.plan-review-feasibility":
    "Plan review agent — assesses implementation feasibility, identifies risks, and validates assumptions.",
}

/**
 * Lanes that benefit from multi-provider model selection (review lanes).
 * Using models from different providers with different strengths can
 * catch more issues than a single provider's perspective.
 */
export const MULTI_PROVIDER_LANES = new Set([
  "review-correctness",
  "review-integration",
  "review-security",
  "review-logic",
  "review-system",
])

// ═══════════════════════════════════════════════════════════════════
//  Provider/model resolution
// ═══════════════════════════════════════════════════════════════════

/**
 * Resolve providers and their models from the Pi runtime model registry.
 *
 * Groups models by provider, filters to authenticated models, and enriches
 * with display metadata.
 *
 * @param piRegistry - The Pi runtime model registry (from ctx.modelRegistry).
 * @returns An array of provider groups with their models.
 */
export function resolveProviderModels(
  piRegistry: {
    getAll(): Array<{
      provider: string
      id: string
      api?: string
      baseUrl?: string
      reasoning?: boolean
      input?: string[]
      contextWindow?: number
      maxTokens?: number
      thinkingLevelMap?: Record<string, string | null>
      name?: string
      supportsTools?: boolean
      [key: string]: unknown
    }>
    hasConfiguredAuth(model: {
      provider: string
      id: string
      [key: string]: unknown
    }): boolean
  },
): ProviderGroup[] {
  const allModels = piRegistry.getAll()
  const providerMap = new Map<string, DisplayModel[]>()

  for (const piModel of allModels) {
    const authenticated = piRegistry.hasConfiguredAuth(piModel)
    const supportsTools = (piModel as { supportsTools?: boolean }).supportsTools !== false
    const supportsText = piModel.input?.includes("text") ?? true

    // Resolve thinking capability from the model's reasoning flag and thinkingLevelMap
    function resolveThinkingCapability(): ThinkingLevel {
      if (!piModel.reasoning) return "medium"
      const supportedLevels: ThinkingLevel[] = ["xhigh", "high", "medium", "low", "off"]
      const map = piModel.thinkingLevelMap
      if (map && typeof map === "object") {
        for (const level of supportedLevels) {
          if (map[level] !== null && map[level] !== undefined) return level
        }
      }
      return "high"
    }

    const displayModel: DisplayModel = {
      id: `${piModel.provider}/${piModel.id}`,
      name: piModel.name ?? piModel.id,
      provider: piModel.provider,
      supportsTools,
      supportsText,
      authenticated,
      thinkingCapability: resolveThinkingCapability(),
      thinkingLevelMap: piModel.thinkingLevelMap,
      contextWindow: piModel.contextWindow,
      maxTokens: piModel.maxTokens,
      reasoning: piModel.reasoning === true,
    }

    const existing = providerMap.get(piModel.provider)
    if (existing) {
      existing.push(displayModel)
    } else {
      providerMap.set(piModel.provider, [displayModel])
    }
  }

  const groups: ProviderGroup[] = []
  for (const [name, models] of providerMap.entries()) {
    groups.push({
      name,
      models,
      hasAuth: models.some((m) => m.authenticated),
    })
  }

  // Sort: providers with auth first, then alphabetically
  groups.sort((a, b) => {
    if (a.hasAuth !== b.hasAuth) return a.hasAuth ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return groups
}

/**
 * Get thinking levels supported by a specific model.
 *
 * A thinking level is supported if:
 * - The model has reasoning capability (or level is "off"/"medium" for non-reasoning)
 * - The model's thinkingLevelMap does not mark it as null
 *
 * @param model - The display model to check.
 * @returns Array of supported thinking levels.
 */
export function getSupportedThinkingLevels(model: DisplayModel): ThinkingLevel[] {
  const allLevels: ThinkingLevel[] = ["off", "low", "medium", "high", "xhigh"]

  if (!model.reasoning) {
    // Non-reasoning models: only "off" and "medium" make sense
    return allLevels.filter((l) => {
      const map = model.thinkingLevelMap
      if (map && map[l] === null) return false
      return l === "off" || l === "medium"
    })
  }

  return allLevels.filter((l) => {
    const map = model.thinkingLevelMap
    if (map && map[l] === null) return false
    return true
  })
}

// ═══════════════════════════════════════════════════════════════════
//  State initialisation from existing profile
// ═══════════════════════════════════════════════════════════════════

/**
 * Initialise wizard editing state from an existing normalized profile.
 *
 * Uses existing values as defaults. If no profile exists, creates a
 * sensible default state from the lane/agent metadata.
 *
 * @param profileName - The profile name being edited.
 * @param profile - The existing normalized profile, or null if none.
 * @returns Initialised wizard editing state.
 */
export function initWizardState(
  profileName: string,
  profile: NormalizedProfileDefinition | null,
  providerGroups: ProviderGroup[],
): WizardEditState {
  const defaultLanes: LaneEditState[] = []
  const defaultAgents: AgentEditState[] = []

  // Build lane states from existing profile or sensible defaults
  const knownLaneNames = profile ? Object.keys(profile.lanes) : Object.keys(LANE_DESCRIPTIONS)

  for (const laneName of knownLaneNames) {
    const existingLane = profile?.lanes[laneName]
    const isReview = laneName.startsWith("review-") || MULTI_PROVIDER_LANES.has(laneName)

    // Pick a sensible default model for the lane
    const defaultModel = existingLane?.preferredModels[0] ?? pickDefaultModel(laneName, providerGroups)
    const fallbackModels = existingLane?.preferredModels.slice(1) ?? []

    defaultLanes.push({
      laneName,
      description: LANE_DESCRIPTIONS[laneName] ?? `Lane: ${laneName}`,
      selectedModels: defaultModel ? [defaultModel, ...fallbackModels] : [],
      thinking: existingLane?.thinking ?? pickDefaultThinking(laneName),
      required: existingLane?.required ?? !(existingLane?.optional ?? false),
      optional: existingLane?.optional ?? false,
      multiProvider: isReview,
    })
  }

  // Build agent binding states
  const knownAgentNames = profile ? Object.keys(profile.agentBindings) : Object.keys(AGENT_DESCRIPTIONS)

  for (const agentName of knownAgentNames) {
    const existingBinding = profile?.agentBindings[agentName]

    defaultAgents.push({
      agentName,
      description: AGENT_DESCRIPTIONS[agentName] ?? `Agent: ${agentName}`,
      lane: existingBinding?.lane ?? guessAgentLane(agentName),
      thinking: pickDefaultThinking(agentName),
      tools: existingBinding?.tools ?? "",
      maxOutput: existingBinding?.maxOutput ?? pickDefaultMaxOutput(agentName),
      maxSubagentDepth: existingBinding?.maxSubagentDepth ?? 0,
      optional: existingBinding?.optional ?? false,
    })
  }

  return {
    profileName,
    lanes: defaultLanes,
    agentBindings: defaultAgents,
  }
}

/** Pick a sensible default model for a lane based on its role. */
function pickDefaultModel(laneName: string, groups: ProviderGroup[]): string | undefined {
  // Priority selection: pick a widely available model for the lane's needs
  const isPlanning = laneName.includes("planning") || laneName.includes("synthesis") || laneName.includes("frontier")
  const isCheap = laneName.includes("cheap") || laneName.includes("scout") || laneName.includes("mapper")

  for (const group of groups) {
    if (!group.hasAuth) continue
    for (const model of group.models) {
      if (!model.authenticated) continue
      if (!model.supportsTools) continue

      if (isPlanning && model.thinkingCapability === "high" || model.thinkingCapability === "xhigh") {
        return model.id
      }
      if (isCheap && (model.thinkingCapability === "low" || model.thinkingCapability === "medium")) {
        return model.id
      }
      // For review lanes, prefer reasoning models
      if (laneName.startsWith("review-") && model.reasoning) {
        return model.id
      }
    }
  }

  // Fallback: first authenticated model
  for (const group of groups) {
    for (const model of group.models) {
      if (model.authenticated) return model.id
    }
  }

  return undefined
}

/** Pick a sensible default thinking level for a lane. */
function pickDefaultThinking(laneName: string): ThinkingLevel {
  if (laneName.includes("cheap") || laneName.includes("scout") || laneName.includes("mapper")) return "low"
  if (laneName.includes("planning") || laneName.includes("frontier") || laneName.includes("synthesis")) return "high"
  if (laneName.includes("worker-strong") || laneName.includes("implement-hard")) return "high"
  if (laneName.includes("review-security")) return "high"
  return "medium"
}

/** Guess which lane an agent should use based on naming conventions. */
function guessAgentLane(agentName: string): string {
  const mapping: Record<string, string> = {
    "scout": "scout-cheap",
    "zflow.planner-frontier": "planning-frontier",
    "zflow.plan-validator": "worker-cheap",
    "context-builder": "scout-cheap",
    "zflow.implement-routine": "worker-cheap",
    "zflow.implement-hard": "worker-strong",
    "zflow.verifier": "worker-cheap",
    "zflow.review-correctness": "review-correctness",
    "zflow.review-integration": "review-integration",
    "zflow.review-security": "review-security",
    "zflow.review-logic": "review-logic",
    "zflow.review-system": "review-system",
    "zflow.synthesizer": "synthesis-frontier",
    "zflow.repo-mapper": "scout-cheap",
    "zflow.plan-review-correctness": "review-correctness",
    "zflow.plan-review-integration": "review-integration",
    "zflow.plan-review-feasibility": "review-correctness",
  }
  return mapping[agentName] ?? "worker-cheap"
}

/** Pick a sensible maxOutput for an agent based on its role. */
function pickDefaultMaxOutput(agentName: string): number {
  if (agentName.includes("planner") || agentName.includes("synthesizer")) return 12000
  if (agentName.includes("review")) return 10000
  if (agentName.includes("implement-hard")) return 10000
  return 8000
}

// ═══════════════════════════════════════════════════════════════════
//  Profile JSON builder
// ═══════════════════════════════════════════════════════════════════

/**
 * Build a ProfileDefinition from the wizard editing state.
 *
 * @param state - The wizard editing state.
 * @returns A complete ProfileDefinition ready for serialisation.
 */
export function buildProfileDefinition(
  state: WizardEditState,
  existingProfile?: NormalizedProfileDefinition,
): ProfileDefinition {
  const lanes: Record<string, LaneDefinition> = {}
  const agentBindings: Record<string, AgentBinding> = {}

  for (const laneState of state.lanes) {
    lanes[laneState.laneName] = {
      required: laneState.required,
      optional: laneState.optional,
      thinking: laneState.thinking,
      preferredModels: laneState.selectedModels,
    }
  }

  for (const agentState of state.agentBindings) {
    agentBindings[agentState.agentName] = {
      lane: agentState.lane,
      optional: agentState.optional,
      tools: agentState.tools || undefined,
      maxOutput: agentState.maxOutput || undefined,
      maxSubagentDepth: agentState.maxSubagentDepth,
    }
  }

  return {
    description: existingProfile?.description ?? "Profile configured via /zflow-profile-configure",
    verificationCommand: existingProfile?.verificationCommand,
    lanes,
    agentBindings,
  }
}

// ═══════════════════════════════════════════════════════════════════
//  TUI Components
// ═══════════════════════════════════════════════════════════════════

/**
 * A model picker select list that shows model ID, thinking capability,
 * and context window info.
 */
export function buildModelSelectItems(
  models: DisplayModel[],
  currentSelection?: string,
): SelectItem[] {
  return models.map((model) => {
    const isSelected = model.id === currentSelection
    const thinkingLabel = model.reasoning
      ? `🧠 ${model.thinkingCapability}`
      : "no reasoning"
    const ctxLabel = model.contextWindow
      ? `${(model.contextWindow / 1000).toFixed(0)}k ctx`
      : ""
    const toolLabel = model.supportsTools ? "🔧" : ""

    const label = `${isSelected ? "✓ " : "  "}${model.name}`
    const description = [
      thinkingLabel,
      ctxLabel,
      toolLabel,
      !model.authenticated ? "⚠ not authenticated" : "",
    ]
      .filter(Boolean)
      .join(" · ")

    return {
      value: model.id,
      label,
      description,
    }
  })
}

/**
 * Build select items for providers (showing auth status).
 */
export function buildProviderSelectItems(
  groups: ProviderGroup[],
): SelectItem[] {
  return groups.map((group) => {
    const authIcon = group.hasAuth ? "✓" : "✗"
    const modelCount = group.models.filter((m) => m.authenticated).length
    return {
      value: group.name,
      label: `${group.name}`,
      description: `${authIcon} ${modelCount} authenticated model${modelCount !== 1 ? "s" : ""}`,
    }
  })
}

/**
 * Build select items for thinking levels, filtered to supported levels.
 */
export function buildThinkingSelectItems(
  supportedLevels: ThinkingLevel[],
  currentLevel: ThinkingLevel,
): SelectItem[] {
  const levelDescriptions: Record<ThinkingLevel, string> = {
    "off": "Disabled — no additional reasoning effort, fastest responses. Best for mechanical tasks like file reads, simple formatting.",
    "low": "Minimal reasoning — quick, cheap responses. Good for repository mapping, context gathering, simple verification.",
    "medium": "Balanced reasoning — standard depth for routine code changes, verification, and typical review work.",
    "high": "Deep reasoning — thorough analysis for complex implementation, planning, security review, and synthesis.",
    "xhigh": "Extra-deep reasoning — maximum analysis depth for highest-risk planning, architecture decisions, and critical security review.",
  }

  return supportedLevels.map((level) => {
    const isCurrent = level === currentLevel
    return {
      value: level,
      label: `${isCurrent ? "✓ " : "  "}${level}`,
      description: levelDescriptions[level] ?? "",
    }
  })
}

// ═══════════════════════════════════════════════════════════════════
//  Lane-specific UI helpers
// ═══════════════════════════════════════════════════════════════════

/**
 * Get the recommended thinking level range description for a lane.
 */
export function getLaneThinkingGuidance(laneName: string): string {
  if (laneName.includes("cheap") || laneName.includes("scout") || laneName.includes("mapper")) {
    return "Recommended: low–medium. This lane uses cost-effective models. High thinking may waste tokens on simple tasks."
  }
  if (laneName.includes("planning") || laneName.includes("frontier")) {
    return "Recommended: high–xhigh. Planning requires deep reasoning for architecture and trade-off decisions."
  }
  if (laneName.includes("worker-strong") || laneName.includes("implement-hard")) {
    return "Recommended: high–xhigh. Complex implementation benefits from deep code understanding."
  }
  if (laneName.includes("review-security")) {
    return "Recommended: high. Security review requires thorough, cautious analysis."
  }
  if (laneName.includes("review-")) {
    return "Recommended: medium–high. Multiple provider models enhance review coverage by catching different issues."
  }
  if (laneName.includes("synthesis")) {
    return "Recommended: high–xhigh. Synthesis requires frontier-level reasoning to consolidate findings coherently."
  }
  return "Recommended: medium. Standard depth for general-purpose work."
}