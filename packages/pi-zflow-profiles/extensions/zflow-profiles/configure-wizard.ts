/**
 * configure-wizard.ts — Interactive TUI wizard for configuring zflow profiles.
 *
 * Launches a full-screen overlay that guides users through:
 *   1. Profile selection
 *   2. Lane configuration (model, thinking level, required/optional)
 *   3. Agent binding configuration (lane binding, tools, maxOutput)
 *   4. Review and write-back
 *
 * Uses Pi runtime registry for live provider/model lists. Previous values
 * are pre-populated as defaults on re-run.
 *
 * @module pi-zflow-profiles/configure-wizard
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"

import {
  SelectList,
  type SelectItem,
  matchesKey,
  truncateToWidth,
} from "@earendil-works/pi-tui"

/** Minimal theme interface for the wizard (avoiding direct import). */
interface WizardTheme {
  fg: (color: string, text: string) => string
  bg: (color: string, text: string) => string
  bold: (text: string) => string
}

import type {
  ThinkingLevel,
  ProfileDefinition,
  NormalizedProfileDefinition,
  ProfilesFile,
  NormalizedProfilesFile,
} from "./profiles.js"

import {
  loadProfiles,
  resolveProfileSource,
  normalizeProfileDefinition,
  fileExists,
  parseProfilesFileJson,
} from "./profiles.js"

import {
  type DisplayModel,
  type ProviderGroup,
  type LaneEditState,
  type AgentEditState,
  type WizardEditState,
  resolveProviderModels,
  getSupportedThinkingLevels,
  buildModelSelectItems,
  buildThinkingSelectItems,
  initWizardState,
  buildProfileDefinition,
  getLaneThinkingGuidance,
  LANE_DESCRIPTIONS,
  AGENT_DESCRIPTIONS,
  MULTI_PROVIDER_LANES,
} from "./tui-components.js"

// ═══════════════════════════════════════════════════════════════════
//  Wizard stages
// ═══════════════════════════════════════════════════════════════════

type WizardStage = "welcome" | "lanes" | "agents" | "review" | "done"

// ═══════════════════════════════════════════════════════════════════
//  Main wizard component
// ═══════════════════════════════════════════════════════════════════

interface WizardContext {
  theme: WizardTheme
  tui: { requestRender: () => void }
  done: (result: WizardEditState | null) => void
}

/**
 * The main wizard component. Manages stage transitions and renders
 * the appropriate sub-view for each stage.
 */
class ConfigureWizard {
  private ctx: WizardContext
  private stage: WizardStage = "welcome"
  private state: WizardEditState
  private providerGroups: ProviderGroup[]

  // Per-stage state
  private profileNames: string[] = []
  private selectedProfileIndex = 0

  private laneIndex = 0
  private laneModelIndex = 0
  private laneThinkingIndex = 0
  private laneEditingModel = false
  private laneEditingThinking = false
  private laneSelectedProvider = 0
  private laneModelsForProvider: DisplayModel[] = []

  private agentIndex = 0
  private agentLaneIndex = 0
  private agentThinkingIndex = 0
  private agentEditingLane = false
  private agentEditingThinking = false

  private reviewConfirmed = false

  // Cached render
  private cachedWidth?: number
  private cachedLines?: string[]

  // Current sub-component for input delegation
  private activeSelectList: SelectList | null = null
  private activeSettingsList: SettingsList | null = null

  // Lane names for lane selector in agent editor
  private laneNames: string[] = []

  constructor(
    state: WizardEditState,
    providerGroups: ProviderGroup[],
    profileNames: string[],
    ctx: WizardContext,
  ) {
    this.state = state
    this.providerGroups = providerGroups
    this.profileNames = profileNames
    this.ctx = ctx
    this.laneNames = state.lanes.map((l) => l.laneName)

    // Set selected profile index
    const profileIdx = profileNames.indexOf(state.profileName)
    this.selectedProfileIndex = profileIdx >= 0 ? profileIdx : 0
  }

  // ── Navigation ────────────────────────────────────────────────

  private goToStage(stage: WizardStage): void {
    this.stage = stage
    this.activeSelectList = null
    this.activeSettingsList = null
    this.invalidate()
    this.ctx.tui.requestRender()
  }

  private finish(result: WizardEditState | null): void {
    this.stage = "done"
    this.ctx.done(result)
  }

  // ── Input handling ────────────────────────────────────────────

  handleInput(data: string): void {
    // Delegate to active sub-components first
    if (this.activeSelectList) {
      const prevSelected = this.activeSelectList.getSelectedItem()
      this.activeSelectList.handleInput(data)
      const newSelected = this.activeSelectList.getSelectedItem()
      if (prevSelected !== newSelected) {
        this.ctx.tui.requestRender()
      }
      // Check if enter was pressed (selection made)
      if (matchesKey(data, "enter")) {
        this.handleSelectListConfirm()
        return
      }
      if (matchesKey(data, "escape")) {
        this.handleSelectListCancel()
        return
      }
      this.ctx.tui.requestRender()
      return
    }

    if (this.activeSettingsList) {
      this.activeSettingsList.handleInput?.(data)
      this.ctx.tui.requestRender()
      return
    }

    // Stage-level navigation
    if (matchesKey(data, "escape")) {
      if (this.stage === "welcome") {
        this.finish(null) // Cancel wizard
      } else if (this.stage === "lanes") {
        this.goToStage("welcome")
      } else if (this.stage === "agents") {
        this.goToStage("lanes")
      } else if (this.stage === "review") {
        this.goToStage("agents")
      }
      return
    }

    if (matchesKey(data, "enter")) {
      if (this.stage === "welcome") {
        this.goToStage("lanes")
      } else if (this.stage === "review") {
        this.reviewConfirmed = true
        this.finish(this.state)
      }
      return
    }

    // Tab navigation within stages
    if (matchesKey(data, "tab")) {
      this.handleTabNavigation()
      return
    }

    if (matchesKey(data, "left") || matchesKey(data, "right")) {
      this.handleHorizontalNavigation(data)
      return
    }

    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      this.handleVerticalNavigation(data)
      return
    }
  }

  private handleSelectListConfirm(): void {
    if (!this.activeSelectList) return

    if (this.laneEditingModel) {
      this.confirmLaneModelSelection()
    } else if (this.laneEditingThinking) {
      this.confirmLaneThinkingSelection()
    } else if (this.agentEditingLane) {
      this.confirmAgentLaneSelection()
    } else if (this.agentEditingThinking) {
      this.confirmAgentThinkingSelection()
    }
  }

  private handleSelectListCancel(): void {
    this.laneEditingModel = false
    this.laneEditingThinking = false
    this.agentEditingLane = false
    this.agentEditingThinking = false
    this.activeSelectList = null
    this.invalidate()
    this.ctx.tui.requestRender()
  }

  private handleTabNavigation(): void {
    if (this.stage === "lanes") {
      // Cycle between editing modes: model, thinking, required/optional
      if (this.laneEditingModel) {
        this.laneEditingModel = false
        this.laneEditingThinking = true
        this.startLaneThinkingEdit()
      } else if (this.laneEditingThinking) {
        this.laneEditingThinking = false
        this.laneEditingModel = false
      } else {
        this.laneEditingModel = true
        this.startLaneModelEdit()
      }
      this.invalidate()
      this.ctx.tui.requestRender()
    } else if (this.stage === "agents") {
      if (this.agentEditingLane) {
        this.agentEditingLane = false
        this.agentEditingThinking = true
        this.startAgentThinkingEdit()
      } else if (this.agentEditingThinking) {
        this.agentEditingThinking = false
        this.agentEditingLane = false
      } else {
        this.agentEditingLane = true
        this.startAgentLaneEdit()
      }
      this.invalidate()
      this.ctx.tui.requestRender()
    }
  }

  private handleHorizontalNavigation(data: string): void {
    if (this.stage !== "lanes") return
    if (this.laneEditingModel || this.laneEditingThinking) return

    if (matchesKey(data, "left")) {
      // Previous lane
      if (this.laneIndex > 0) {
        this.laneIndex--
        this.invalidate()
        this.ctx.tui.requestRender()
      }
    } else if (matchesKey(data, "right")) {
      // Next lane
      if (this.laneIndex < this.state.lanes.length - 1) {
        this.laneIndex++
        this.invalidate()
        this.ctx.tui.requestRender()
      }
    }
  }

  private handleVerticalNavigation(data: string): void {
    if (this.stage === "lanes") {
      if (matchesKey(data, "up")) {
        if (this.laneIndex > 0) {
          this.laneIndex--
          this.invalidate()
          this.ctx.tui.requestRender()
        }
      } else if (matchesKey(data, "down")) {
        if (this.laneIndex < this.state.lanes.length - 1) {
          this.laneIndex++
          this.invalidate()
          this.ctx.tui.requestRender()
        }
      }
    } else if (this.stage === "agents") {
      if (matchesKey(data, "up")) {
        if (this.agentIndex > 0) {
          this.agentIndex--
          this.invalidate()
          this.ctx.tui.requestRender()
        }
      } else if (matchesKey(data, "down")) {
        if (this.agentIndex < this.state.agentBindings.length - 1) {
          this.agentIndex++
          this.invalidate()
          this.ctx.tui.requestRender()
        }
      }
    }
  }

  // ── Lane model editing ────────────────────────────────────────

  private startLaneModelEdit(): void {
    const lane = this.state.lanes[this.laneIndex]
    const isMulti = lane.multiProvider && MULTI_PROVIDER_LANES.has(lane.laneName)

    if (isMulti) {
      // For multi-provider lanes (review), show provider-first then model
      this.laneEditingModel = true
      this.laneEditingThinking = false
      this.activeSelectList = this.buildProviderSelectList()
    } else {
      // Show all models directly
      this.laneEditingModel = true
      this.laneEditingThinking = false
      this.activeSelectList = this.buildModelSelectListForLane()
    }
  }

  private confirmLaneModelSelection(): void {
    const lane = this.state.lanes[this.laneIndex]
    const isMulti = lane.multiProvider && MULTI_PROVIDER_LANES.has(lane.laneName)

    if (isMulti && this.laneSelectedProvider >= 0) {
      // Provider selected — show models for that provider
      const providerName = this.providerGroups[this.laneSelectedProvider]?.name
      if (providerName) {
        const group = this.providerGroups.find((g) => g.name === providerName)
        if (group) {
          this.laneModelsForProvider = group.models.filter((m) => m.authenticated)
          this.laneModelIndex = 0
          this.activeSelectList = this.buildModelSelectListForProvider()
          return
        }
      }
    }

    // Model selected — add to lane's model list
    if (this.activeSelectList) {
      const selectedItem = this.activeSelectList.getSelectedItem()
      if (selectedItem) {
        // Add model to lane's selectedModels (if not already there)
        if (!lane.selectedModels.includes(selectedItem.value)) {
          lane.selectedModels.push(selectedItem.value)
        }
      }
    }

    this.laneEditingModel = false
    this.activeSelectList = null
    this.laneModelsForProvider = []
    this.invalidate()
    this.ctx.tui.requestRender()
  }

  private buildModelSelectListForLane(): SelectList {
    const lane = this.state.lanes[this.laneIndex]
    const allModels: DisplayModel[] = []
    for (const group of this.providerGroups) {
      for (const model of group.models) {
        if (model.authenticated && model.supportsTools) {
          allModels.push(model)
        }
      }
    }

    const items = buildModelSelectItems(allModels, lane.selectedModels[0])
    const selectList = new SelectList(items, 8, {
      selectedPrefix: (t: string) => this.ctx.theme.fg("accent", t),
      selectedText: (t: string) => this.ctx.theme.fg("accent", t),
      description: (t: string) => this.ctx.theme.fg("muted", t),
      scrollInfo: (t: string) => this.ctx.theme.fg("dim", t),
      noMatch: (t: string) => this.ctx.theme.fg("warning", t),
    })
    // Set initial selection to current model if any
    if (lane.selectedModels.length > 0) {
      const idx = allModels.findIndex((m) => m.id === lane.selectedModels[0])
      if (idx >= 0) {
        // SelectList doesn't have setIndex, so we accept the top-of-list default
      }
    }
    return selectList
  }

  private buildProviderSelectList(): SelectList {
    const items = buildProviderSelectItems(this.providerGroups)
    const selectList = new SelectList(items, 8, {
      selectedPrefix: (t: string) => this.ctx.theme.fg("accent", t),
      selectedText: (t: string) => this.ctx.theme.fg("accent", t),
      description: (t: string) => this.ctx.theme.fg("muted", t),
      scrollInfo: (t: string) => this.ctx.theme.fg("dim", t),
      noMatch: (t: string) => this.ctx.theme.fg("warning", t),
    })
    this.laneSelectedProvider = 0
    return selectList
  }

  private buildModelSelectListForProvider(): SelectList {
    const items = buildModelSelectItems(
      this.laneModelsForProvider,
      this.state.lanes[this.laneIndex]?.selectedModels[0],
    )
    const selectList = new SelectList(items, 8, {
      selectedPrefix: (t: string) => this.ctx.theme.fg("accent", t),
      selectedText: (t: string) => this.ctx.theme.fg("accent", t),
      description: (t: string) => this.ctx.theme.fg("muted", t),
      scrollInfo: (t: string) => this.ctx.theme.fg("dim", t),
      noMatch: (t: string) => this.ctx.theme.fg("warning", t),
    })
    return selectList
  }

  // ── Lane thinking editing ─────────────────────────────────────

  private startLaneThinkingEdit(): void {
    const lane = this.state.lanes[this.laneIndex]
    const primaryModel = this.findModel(lane.selectedModels[0])
    const supportedLevels = primaryModel
      ? getSupportedThinkingLevels(primaryModel)
      : (["off", "low", "medium", "high", "xhigh"] as ThinkingLevel[])

    const items = buildThinkingSelectItems(supportedLevels, lane.thinking)
    this.activeSelectList = new SelectList(items, 6, {
      selectedPrefix: (t: string) => this.ctx.theme.fg("accent", t),
      selectedText: (t: string) => this.ctx.theme.fg("accent", t),
      description: (t: string) => this.ctx.theme.fg("muted", t),
      scrollInfo: (t: string) => this.ctx.theme.fg("dim", t),
      noMatch: (t: string) => this.ctx.theme.fg("warning", t),
    })
  }

  private confirmLaneThinkingSelection(): void {
    if (this.activeSelectList) {
      const selectedItem = this.activeSelectList.getSelectedItem()
      if (selectedItem) {
        this.state.lanes[this.laneIndex].thinking = selectedItem.value as ThinkingLevel
      }
    }
    this.laneEditingThinking = false
    this.activeSelectList = null
    this.invalidate()
    this.ctx.tui.requestRender()
  }

  // ── Agent lane editing ────────────────────────────────────────

  private startAgentLaneEdit(): void {
    const agent = this.state.agentBindings[this.agentIndex]
    const items: SelectItem[] = this.laneNames.map((name) => {
      const desc = LANE_DESCRIPTIONS[name] ?? ""
      const shortDesc = desc.length > 60 ? desc.slice(0, 57) + "..." : desc
      return {
        value: name,
        label: name === agent.lane ? `✓ ${name}` : `  ${name}`,
        description: shortDesc,
      }
    })

    this.activeSelectList = new SelectList(items, 8, {
      selectedPrefix: (t: string) => this.ctx.theme.fg("accent", t),
      selectedText: (t: string) => this.ctx.theme.fg("accent", t),
      description: (t: string) => this.ctx.theme.fg("muted", t),
      scrollInfo: (t: string) => this.ctx.theme.fg("dim", t),
      noMatch: (t: string) => this.ctx.theme.fg("warning", t),
    })
  }

  private confirmAgentLaneSelection(): void {
    if (this.activeSelectList) {
      const selectedItem = this.activeSelectList.getSelectedItem()
      if (selectedItem) {
        this.state.agentBindings[this.agentIndex].lane = selectedItem.value
      }
    }
    this.agentEditingLane = false
    this.activeSelectList = null
    this.invalidate()
    this.ctx.tui.requestRender()
  }

  // ── Agent thinking editing ────────────────────────────────────

  private startAgentThinkingEdit(): void {
    const agent = this.state.agentBindings[this.agentIndex]
    // Agent thinking inherits from lane, but show all levels as options
    const supportedLevels: ThinkingLevel[] = ["off", "low", "medium", "high", "xhigh"]

    const items = buildThinkingSelectItems(supportedLevels, agent.thinking)
    this.activeSelectList = new SelectList(items, 6, {
      selectedPrefix: (t: string) => this.ctx.theme.fg("accent", t),
      selectedText: (t: string) => this.ctx.theme.fg("accent", t),
      description: (t: string) => this.ctx.theme.fg("muted", t),
      scrollInfo: (t: string) => this.ctx.theme.fg("dim", t),
      noMatch: (t: string) => this.ctx.theme.fg("warning", t),
    })
  }

  private confirmAgentThinkingSelection(): void {
    if (this.activeSelectList) {
      const selectedItem = this.activeSelectList.getSelectedItem()
      if (selectedItem) {
        this.state.agentBindings[this.agentIndex].thinking = selectedItem.value as ThinkingLevel
      }
    }
    this.agentEditingThinking = false
    this.activeSelectList = null
    this.invalidate()
    this.ctx.tui.requestRender()
  }

  // ── Helpers ───────────────────────────────────────────────────

  private findModel(modelId: string | undefined): DisplayModel | undefined {
    if (!modelId) return undefined
    for (const group of this.providerGroups) {
      for (const model of group.models) {
        if (model.id === modelId) return model
      }
    }
    return undefined
  }

  // ── Render ────────────────────────────────────────────────────

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines
    }

    const lines: string[] = []
    const theme = this.ctx.theme
    const pad = "  "

    // Top border
    lines.push(theme.fg("borderAccent", "┌" + "─".repeat(width - 2) + "┐"))

    // Title
    const title = "  Profile Configuration Wizard"
    lines.push(theme.fg("borderAccent", truncateToWidth(title, width)))

    // Subtitle with stage
    const stageLabel = this.getStageLabel()
    lines.push(theme.fg("muted", truncateToWidth(`  Stage: ${stageLabel}`, width)))
    lines.push("")

    // Stage content
    switch (this.stage) {
      case "welcome":
        lines.push(...this.renderWelcome(width, pad))
        break
      case "lanes":
        lines.push(...this.renderLaneEditor(width, pad))
        break
      case "agents":
        lines.push(...this.renderAgentEditor(width, pad))
        break
      case "review":
        lines.push(...this.renderReview(width, pad))
        break
    }

    // Bottom help
    lines.push("")
    lines.push(theme.fg("dim", truncateToWidth(`  ${this.getHelpText()}`, width)))

    // Bottom border
    lines.push(theme.fg("borderAccent", "└" + "─".repeat(width - 2) + "┘"))

    this.cachedLines = lines
    this.cachedWidth = width
    return lines
  }

  private getStageLabel(): string {
    switch (this.stage) {
      case "welcome": return "1/4 — Welcome"
      case "lanes": return `2/4 — Configure Lanes (${this.laneIndex + 1}/${this.state.lanes.length})`
      case "agents": return `3/4 — Configure Agents (${this.agentIndex + 1}/${this.state.agentBindings.length})`
      case "review": return "4/4 — Review & Save"
      default: return ""
    }
  }

  private getHelpText(): string {
    switch (this.stage) {
      case "welcome":
        return "enter: next  ·  esc: cancel"
      case "lanes":
        if (this.laneEditingModel || this.laneEditingThinking) {
          return "↑↓: navigate  ·  enter: select  ·  esc: cancel"
        }
        return "↑↓/←→: change lane  ·  enter: next stage  ·  tab: edit model/thinking  ·  esc: back"
      case "agents":
        if (this.agentEditingLane || this.agentEditingThinking) {
          return "↑↓: navigate  ·  enter: select  ·  esc: cancel"
        }
        return "↑↓: change agent  ·  enter: next stage  ·  tab: edit lane/thinking  ·  esc: back"
      case "review":
        return "enter: save & activate  ·  esc: back to agents"
      default:
        return ""
    }
  }

  // ── Welcome screen ────────────────────────────────────────────

  private renderWelcome(width: number, pad: string): string[] {
    const theme = this.ctx.theme
    const lines: string[] = []

    lines.push(pad + theme.fg("accent", theme.bold("Welcome to Profile Configuration")))
    lines.push("")
    lines.push(pad + "This wizard will help you configure which models, providers,")
    lines.push(pad + "and thinking levels to use for each role in your workflow.")
    lines.push("")

    // Profile selection
    if (this.profileNames.length > 1) {
      lines.push(pad + theme.fg("accent", "Profile to configure:"))
      lines.push("")
      for (let i = 0; i < this.profileNames.length; i++) {
        const isSelected = i === this.selectedProfileIndex
        lines.push(
          pad + (isSelected ? theme.fg("accent", `▶ ${this.profileNames[i]}`) : `  ${this.profileNames[i]}`)
        )
      }
      lines.push("")
      lines.push(pad + theme.fg("dim", "Use ↑↓ to select profile, enter to continue"))
    } else {
      lines.push(pad + theme.fg("accent", `Profile: ${this.state.profileName}`))
      lines.push("")
    }

    lines.push(pad + theme.fg("muted", `${this.state.lanes.length} lanes to configure`))
    lines.push(pad + theme.fg("muted", `${this.state.agentBindings.length} agent bindings to configure`))
    lines.push("")
    lines.push(pad + theme.fg("dim", "Press enter to begin, or escape to cancel."))
    lines.push(pad + theme.fg("dim", "Previous values will be shown as defaults."))

    return lines
  }

  // ── Lane editor ───────────────────────────────────────────────

  private renderLaneEditor(width: number, pad: string): string[] {
    const theme = this.ctx.theme
    const lane = this.state.lanes[this.laneIndex]
    const lines: string[] = []

    // Lane selector header
    const lanePager = `Lane ${this.laneIndex + 1} of ${this.state.lanes.length}`
    lines.push(pad + theme.fg("accent", theme.bold(lanePager + ": " + lane.laneName)))
    lines.push(pad + theme.fg("muted", truncateToWidth(lane.description, width - 4)))
    lines.push("")

    // If editing model
    if (this.laneEditingModel && this.activeSelectList) {
      lines.push(pad + theme.fg("accent", "Select a model:"))
      if (this.laneModelsForProvider.length > 0) {
        lines.push(pad + theme.fg("muted", `Provider: ${this.providerGroups[this.laneSelectedProvider]?.name}`))
      }
      lines.push("")
      const selectLines = this.activeSelectList.render(width - 4)
      for (const line of selectLines) {
        lines.push(pad + line)
      }
      return lines
    }

    // If editing thinking
    if (this.laneEditingThinking && this.activeSelectList) {
      lines.push(pad + theme.fg("accent", "Select thinking level:"))
      lines.push("")
      const guidance = getLaneThinkingGuidance(lane.laneName)
      lines.push(pad + theme.fg("muted", truncateToWidth(guidance, width - 4)))
      lines.push("")
      const selectLines = this.activeSelectList.render(width - 4)
      for (const line of selectLines) {
        lines.push(pad + line)
      }
      return lines
    }

    // Normal lane display
    // Model status
    const hasModels = lane.selectedModels.length > 0
    const modelDisplay = hasModels
      ? lane.selectedModels.map((m) => {
        const model = this.findModel(m)
        return model ? `${model.provider}/${model.name}` : m
      }).join(", ")
      : "(none selected)"

    lines.push(pad + theme.fg("accent", "Models:") + " " + (hasModels ? modelDisplay : theme.fg("warning", modelDisplay)))

    // Model capabilities if selected
    if (hasModels) {
      const primaryModel = this.findModel(lane.selectedModels[0])
      if (primaryModel) {
        const capInfo: string[] = []
        capInfo.push(primaryModel.reasoning ? `reasoning: ${primaryModel.thinkingCapability}` : "no reasoning")
        if (primaryModel.contextWindow) capInfo.push(`${(primaryModel.contextWindow / 1000).toFixed(0)}k ctx`)
        if (primaryModel.maxTokens) capInfo.push(`${(primaryModel.maxTokens / 1000).toFixed(0)}k max out`)
        lines.push(pad + theme.fg("dim", capInfo.join(" · ")))
      }
    }

    // Multi-provider hint for review lanes
    if (MULTI_PROVIDER_LANES.has(lane.laneName) && lane.selectedModels.length < 2) {
      lines.push(pad + theme.fg("warning", "💡 Adding models from different providers enhances review coverage."))
    }

    lines.push("")

    // Thinking level
    lines.push(pad + theme.fg("accent", "Thinking:") + " " + lane.thinking)
    lines.push(pad + theme.fg("dim", getLaneThinkingGuidance(lane.laneName)))
    lines.push("")

    // Required/Optional
    const reqLabel = lane.required ? "required" : "optional"
    const reqColor = lane.required ? "success" : "muted" as const
    lines.push(pad + theme.fg("accent", "Priority:") + " " + theme.fg(reqColor, reqLabel))
    lines.push(pad + theme.fg("dim", lane.required
      ? "This lane must resolve to a model for the profile to activate."
      : "This lane is optional — the profile activates even if no model is available."))

    lines.push("")
    lines.push(pad + theme.fg("dim", "[tab] edit model/thinking  ·  [↑↓/←→] change lane  ·  [enter] next stage"))

    return lines
  }

  // ── Agent editor ──────────────────────────────────────────────

  private renderAgentEditor(width: number, pad: string): string[] {
    const theme = this.ctx.theme
    const agent = this.state.agentBindings[this.agentIndex]
    const lines: string[] = []

    // Agent selector header
    const agentPager = `Agent ${this.agentIndex + 1} of ${this.state.agentBindings.length}`
    lines.push(pad + theme.fg("accent", theme.bold(agentPager + ": " + agent.agentName)))
    lines.push(pad + theme.fg("muted", truncateToWidth(agent.description, width - 4)))
    lines.push("")

    // If editing lane
    if (this.agentEditingLane && this.activeSelectList) {
      lines.push(pad + theme.fg("accent", "Select lane for this agent:"))
      lines.push("")
      const selectLines = this.activeSelectList.render(width - 4)
      for (const line of selectLines) {
        lines.push(pad + line)
      }
      return lines
    }

    // If editing thinking
    if (this.agentEditingThinking && this.activeSelectList) {
      lines.push(pad + theme.fg("accent", "Select thinking level:"))
      lines.push("")
      const selectLines = this.activeSelectList.render(width - 4)
      for (const line of selectLines) {
        lines.push(pad + line)
      }
      return lines
    }

    // Normal agent display
    lines.push(pad + theme.fg("accent", "Lane:") + " " + agent.lane)
    const laneDesc = LANE_DESCRIPTIONS[agent.lane]
    if (laneDesc) {
      lines.push(pad + theme.fg("dim", truncateToWidth(laneDesc, width - 4)))
    }

    // Show what model this agent gets from its lane
    const resolvedLane = this.state.lanes.find((l) => l.laneName === agent.lane)
    if (resolvedLane && resolvedLane.selectedModels.length > 0) {
      const model = this.findModel(resolvedLane.selectedModels[0])
      if (model) {
        lines.push(pad + theme.fg("dim", `→ inherits model: ${model.provider}/${model.name}`))
      }
    }

    lines.push("")

    lines.push(pad + theme.fg("accent", "Thinking:") + " " + agent.thinking)
    lines.push("")

    lines.push(pad + theme.fg("accent", "Tools:") + " " + (agent.tools || "(default tool set)"))
    lines.push("")

    const optLabel = agent.optional ? "yes (optional)" : "no (required)"
    const optColor = agent.optional ? "muted" as const : "success" as const
    lines.push(pad + theme.fg("accent", "Optional:") + " " + theme.fg(optColor, optLabel))
    lines.push(pad + theme.fg("dim", agent.optional
      ? "This agent is skipped if its lane cannot resolve."
      : "This agent is required for the workflow to function."))
    lines.push("")

    if (agent.maxOutput) {
      lines.push(pad + theme.fg("accent", "Max Output:") + " " + `${agent.maxOutput} tokens`)
      lines.push("")
    }

    if (agent.maxSubagentDepth !== undefined) {
      lines.push(pad + theme.fg("accent", "Max Subagent Depth:") + " " + `${agent.maxSubagentDepth}`)
      lines.push("")
    }

    lines.push(pad + theme.fg("dim", "[tab] edit lane/thinking  ·  [↑↓] change agent  ·  [enter] review & save"))

    return lines
  }

  // ── Review screen ─────────────────────────────────────────────

  private renderReview(width: number, pad: string): string[] {
    const theme = this.ctx.theme
    const lines: string[] = []

    lines.push(pad + theme.fg("accent", theme.bold("Review Configuration")))
    lines.push(pad + theme.fg("muted", `Profile: ${this.state.profileName}`))
    lines.push("")

    // Lane summary
    lines.push(pad + theme.fg("accent", "Lanes:"))
    for (const lane of this.state.lanes) {
      const modelSummary = lane.selectedModels.length > 0
        ? lane.selectedModels.map((m) => m.split("/").pop() ?? m).join(", ")
        : "(no model)"
      const thinkingIcon = lane.thinking === "high" || lane.thinking === "xhigh" ? "🧠" : "💡"
      const reqTag = lane.required ? "" : " (optional)"
      lines.push(pad + `  ${thinkingIcon} ${lane.laneName}: ${modelSummary} [${lane.thinking}]${reqTag}`)
    }

    lines.push("")

    // Agent summary
    lines.push(pad + theme.fg("accent", "Agent Bindings:"))
    for (const agent of this.state.agentBindings) {
      const resolvedLane = this.state.lanes.find((l) => l.laneName === agent.lane)
      const modelHint = resolvedLane && resolvedLane.selectedModels.length > 0
        ? ` → ${resolvedLane.selectedModels[0].split("/").pop()}`
        : ""
      lines.push(pad + `  ${agent.agentName} → ${agent.lane}${modelHint}`)
    }

    lines.push("")
    lines.push(pad + theme.fg("success", "✓ Configuration will be written to your profiles file."))
    lines.push(pad + theme.fg("dim", "Run /zflow-profile default to activate, then /zflow-profile sync-project to apply."))

    return lines
  }

  // ── Cache management ──────────────────────────────────────────

  invalidate(): void {
    this.cachedWidth = undefined
    this.cachedLines = undefined
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Entry point
// ═══════════════════════════════════════════════════════════════════

/**
 * Launch the profile configuration wizard.
 *
 * Opens a full-screen TUI overlay that guides the user through
 * lane and agent configuration, then writes the result back to
 * the profile JSON file.
 *
 * @param ctx - The extension command context with UI, model registry, and cwd.
 * @returns Promise that resolves when the wizard finishes.
 */
export async function launchConfigureWizard(
  ctx: {
    ui: {
      notify: (message: string, type?: "info" | "warning" | "error") => void
      custom: <T>(
        componentFactory: (
          tui: { requestRender: () => void },
          theme: unknown,
          keybindings: unknown,
          done: (result: T) => void,
        ) => { render: (w: number) => string[]; invalidate: () => void; handleInput: (data: string) => void },
        options?: { overlay?: boolean; overlayOptions?: Record<string, unknown> },
      ) => Promise<T>
      setStatus: (key: string, text: string | undefined) => void
      confirm: (title: string, message: string) => Promise<boolean>
    }
    modelRegistry?: {
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
    }
    cwd?: string
  },
): Promise<void> {
  // 1. Check for model registry availability
  if (!ctx.modelRegistry) {
    ctx.ui.notify(
      "Model registry is not available. The configuration wizard needs access to your Pi model registry.\n\n" +
        "Make sure you're running this command in an interactive Pi session.",
      "error",
    )
    return
  }

  // 2. Resolve provider groups from the Pi runtime
  const providerGroups = resolveProviderModels(ctx.modelRegistry)

  if (providerGroups.length === 0) {
    ctx.ui.notify(
      "No models were found in the Pi runtime registry.\n\n" +
        "Run `/login` to authenticate with a provider, then try again.",
      "error",
    )
    return
  }

  const hasAuthModels = providerGroups.some((g) => g.hasAuth)
  if (!hasAuthModels) {
    ctx.ui.notify(
      "No authenticated models were found.\n\n" +
        "Run `/login` to authenticate with a provider, then try again.",
      "warning",
    )
    return
  }

  // 3. Load existing profile
  let existingProfile: NormalizedProfileDefinition | null = null
  let existingProfiles: NormalizedProfilesFile = {}
  let profileSourcePath: string | null = null
  let profileNames: string[] = ["default"]

  try {
    const repoRoot = ctx.cwd ?? process.cwd()
    const gitDir = (await import("pi-zflow-core/runtime-paths")).resolveGitDir(repoRoot)
    const projectRoot = gitDir ? path.dirname(gitDir) : repoRoot
    const loaded = await loadProfiles(projectRoot)
    existingProfiles = loaded.profiles
    profileSourcePath = loaded.source
    profileNames = Object.keys(loaded.profiles)
    if (profileNames.length > 0) {
      existingProfile = loaded.profiles[profileNames[0]] ?? null
    }
  } catch {
    // No existing profile — start fresh with sensible defaults
    ctx.ui.notify(
      "No existing profile file found. The wizard will create a new one with sensible defaults.",
      "info",
    )
  }

  // 4. Determine which profile to edit
  const profileName = profileNames.length > 1
    ? profileNames[0] // Default to first; wizard welcome screen can change this
    : (profileNames[0] ?? "default")

  // 5. Initialise wizard state
  const wizardState = initWizardState(profileName, existingProfile, providerGroups)

  // 6. Launch the TUI wizard overlay
  const result = await ctx.ui.custom<WizardEditState | null>(
    (tui, theme, _kb, done) => {
      const wizard = new ConfigureWizard(wizardState, providerGroups, profileNames, {
        theme,
        tui,
        done,
      })

      return {
        render: (w: number) => wizard.render(w),
        invalidate: () => wizard.invalidate(),
        handleInput: (data: string) => {
          wizard.handleInput(data)
          tui.requestRender()
        },
      }
    },
    {
      overlay: true,
      overlayOptions: {
        width: "90%",
        minWidth: 60,
        maxHeight: "90%",
        anchor: "center" as const,
      },
    },
  )

  // 7. User cancelled
  if (!result) {
    ctx.ui.notify("Configuration cancelled.", "info")
    return
  }

  // 8. Build and write the profile JSON
  const profileDef = buildProfileDefinition(result, existingProfile ?? undefined)
  const profilesToWrite: ProfilesFile = {
    ...(existingProfiles as Record<string, unknown> ?? {}) as unknown as ProfilesFile,
    [result.profileName]: profileDef,
  }

  // Determine write path
  let writePath: string
  if (profileSourcePath && !profileSourcePath.includes("node_modules")) {
    writePath = profileSourcePath
  } else {
    // Write to project-local path
    const repoRoot = ctx.cwd ?? process.cwd()
    const gitDir = (await import("pi-zflow-core/runtime-paths")).resolveGitDir(repoRoot)
    const projectRoot = gitDir ? path.dirname(gitDir) : repoRoot
    writePath = path.join(projectRoot, ".pi", "zflow-profiles.json")
  }

  // Ensure directory exists
  await fs.mkdir(path.dirname(writePath), { recursive: true })

  // Write atomically
  const tmpPath = writePath + ".tmp"
  try {
    await fs.writeFile(tmpPath, JSON.stringify(profilesToWrite, null, 2), "utf8")
    await fs.rename(tmpPath, writePath)
  } catch (err) {
    try { await fs.unlink(tmpPath) } catch { /* ignore */ }
    ctx.ui.notify(
      `Failed to write profile: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    )
    return
  }

  ctx.ui.notify(
    `Profile "${result.profileName}" configured with:\n` +
    `  ${result.lanes.length} lanes\n` +
    `  ${result.agentBindings.length} agent bindings\n\n` +
    `Written to: ${writePath}\n\n` +
    `Next steps:\n` +
    `  Run /zflow-profile default to activate the profile.\n` +
    `  Run /zflow-profile sync-project to write agent overrides to .pi/settings.json.`,
  )
}