/**
 * pi-zflow-change-workflows extension entrypoint
 *
 * Phase 7 implementation:
 * - Path resolution helpers integrated from pi-zflow-artifacts
 * - `resolveAllPaths` convenience helper for workflow commands
 * - Registers `/zflow-change-prepare`, `/zflow-change-implement`,
 *   `/zflow-change-audit`, `/zflow-change-fix`, and `/zflow-clean`
 * - Wires state-driven resume, HITL gates, handoff, prompt reminders,
 *   verification/review sequencing, cleanup, and path-guard enforcement
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

import {
  resolveRuntimeStateDir,
  resolveGitDir,
} from "pi-zflow-core/runtime-paths"

import { getZflowRegistry } from "pi-zflow-core/registry"
import { PI_ZFLOW_CHANGE_WORKFLOWS_VERSION } from "pi-zflow-core"
import type { CapabilityClaim } from "pi-zflow-core/registry"

import {
  resolveStateIndexPath,
  resolvePlanStatePath,
  resolvePlanVersionDir,
  resolvePlanArtifactPath,
  resolveChangeDir,
  resolveRunStatePath,
  resolveRunDir,
  resolveReviewDir,
  resolveCodeReviewFindingsPath,
  resolveFailureLogPath,
  resolveRepoMapPath,
  resolveReconnaissancePath,
} from "pi-zflow-artifacts/artifact-paths"

// ── Path resolution helpers ──────────────────────────────────────

/**
 * All workflow-relevant runtime paths resolved once.
 *
 * This is the single authoritative source of runtime path locations
 * for all workflow commands. Every command should call this to get
 * consistent paths throughout the session.
 */
export interface AllWorkflowPaths {
  /** Root of all runtime state artifacts (`<git-dir>/pi-zflow/`). */
  runtimeStateDir: string
  /** Path to the state index JSON file. */
  stateIndexPath: string
  /** Path to the failure log markdown file. */
  failureLogPath: string
  /** Path to the review artifacts directory. */
  reviewDir: string
  /** Path to the code-review-findings.md file. */
  codeReviewFindingsPath: string
  /** Path to the repo-map.md file. */
  repoMapPath: string
  /** Path to the reconnaissance.md file. */
  reconnaissancePath: string
}

/**
 * Resolve all workflow-relevant runtime paths.
 *
 * Centralises path resolution so that every workflow command resolves
 * paths the same way. Accepts an optional working directory for context.
 *
 * @param cwd - Working directory (defaults to `process.cwd()`)
 */
export function resolveAllPaths(cwd?: string): AllWorkflowPaths {
  return {
    runtimeStateDir: resolveRuntimeStateDir(cwd),
    stateIndexPath: resolveStateIndexPath(cwd),
    failureLogPath: resolveFailureLogPath(cwd),
    reviewDir: resolveReviewDir(cwd),
    codeReviewFindingsPath: resolveCodeReviewFindingsPath(cwd),
    repoMapPath: resolveRepoMapPath(cwd),
    reconnaissancePath: resolveReconnaissancePath(cwd),
  }
}

/**
 * Resolve plan-related paths for a specific change and version.
 *
 * @param changeId - Unique change identifier (kebab-case)
 * @param planVersion - Plan version (e.g. "v1")
 * @param cwd - Working directory (defaults to `process.cwd()`)
 */
export function resolvePlanPaths(
  changeId: string,
  planVersion: string,
  cwd?: string,
): {
  changeDir: string
  planVersionDir: string
  planStatePath: string
} {
  return {
    changeDir: resolveChangeDir(changeId, cwd),
    planVersionDir: resolvePlanVersionDir(changeId, planVersion, cwd),
    planStatePath: resolvePlanStatePath(changeId, cwd),
  }
}

/**
 * Resolve run-related paths for a specific run.
 *
 * @param runId - Unique run identifier
 * @param cwd - Working directory (defaults to `process.cwd()`)
 */
export function resolveRunPaths(
  runId: string,
  cwd?: string,
): {
  runStatePath: string
} {
  return {
    runStatePath: resolveRunStatePath(runId, cwd),
  }
}

// ── State-index lifecycle helpers ─────────────────────────────────

import { loadStateIndex, listStateIndexEntries } from "pi-zflow-artifacts/state-index"
import type { StateIndexEntry } from "pi-zflow-artifacts/state-index"

import {
  discoverUnfinishedWork,
  promptResumeChoices,
  checkUnfinishedOnEntry,
  runChangePrepareWorkflow,
  resolveProfileIfAvailable,
  buildRepoMap,
  buildReconnaissance,
  advancePlanLifecycle,
  runPlanValidation,
  runPlanReview,
  approvePlanVersion,
  buildHandoffContext,
  updatePlanState,
  bumpPlanVersion,
  markPlanVersionState,
  buildPlanApprovalQuestions,
  buildImplementationGateQuestions,
  parseInterviewResponse,
  runChangeAuditWorkflow,
  runChangeFixWorkflow,
  runCleanWorkflow,
  detectResumeContext,
  resumeWorkflow,
  abandonWorkflow,
  buildResumePrompt,
  runChangeImplementWorkflow,
  recordImplementationNextSteps,
  finalizeVerification,
  runBoundedFixLoop,
  finalizeCodeReview,
  completeWorkflow,
  runImplementationPostStartSequence,
  buildImplementationHandoff,
  serializeHandoff,
  deserializeHandoff,
  buildHandoffPromptPrefix,
  canForkSession,
  forkImplementationSessionIfAvailable,
  resolvePendingHandoff,
  clearPendingHandoff,
  handlePlanDrift,
  createPlanAmendment,
  buildDriftDetectedReminder,
  buildCodeReviewInputFromContext,
  publishPlanArtifacts,
  deriveSemanticChangeId,
  resolveChangeImplementTarget,
  type PublishPlanArtifactsResult,
} from "./orchestration.js"

import {
  loadFragment,
  buildReminderInjection,
  buildModeInjection,
  fragmentExists,
} from "./prompt-fragments.js"

import type {
  ReminderId,
  ModeFragment,
} from "./prompt-fragments.js"

import type {
  PrepareWorkflowOptions,
  PrepareWorkflowResult,
  ImplementationHandoff,
  ForkSessionResult,
  ImplementWorkflowOptions,
  ImplementWorkflowResult,
  UnfinishedOnEntryResult,
  CodeReviewInputContext,
  AuditWorkflowOptions,
  AuditWorkflowResult,
  FixWorkflowOptions,
  FixWorkflowResult,
  CleanWorkflowOptions,
  CleanWorkflowResult,
  ResumeContext,
  DriftResolution,
} from "./orchestration.js"

import {
  resolveVerificationCommand,
  runVerification,
  appendFailureLog,
  runVerificationFixLoop,
} from "./verification.js"

import {
  readFailureLog,
  findRelevantFailures,
  appendFailureEntry,
  formatFailureLogEntries,
  parseFailureLog,
} from "./failure-log.js"

import type { FailureLogEntry } from "./failure-log.js"

// ── Path guard helpers ────────────────────────────────────────────

import {
  guardWrite,
  guardBashCommand,
  isGitWriteCommand,
  buildToolDeniedReminder,
} from "./path-guard.js"

import type {
  GuardResult,
  GuardIntent,
  GuardOptions,
  PostStartSequenceOptions,
  PostStartSequenceResult,
} from "./path-guard.js"

import type {
  VerificationResult,
  FixLoopOptions,
  FixLoopResult,
  FixAttempt,
} from "./verification.js"

export {
  discoverUnfinishedWork,
  promptResumeChoices,
  checkUnfinishedOnEntry,
  runChangePrepareWorkflow,
  resolveProfileIfAvailable,
  buildRepoMap,
  buildReconnaissance,
  advancePlanLifecycle,
  runPlanValidation,
  runPlanReview,
  approvePlanVersion,
  buildHandoffContext,
  updatePlanState,
  bumpPlanVersion,
  markPlanVersionState,
  runChangeImplementWorkflow,
  recordImplementationNextSteps,
  finalizeVerification,
  runBoundedFixLoop,
  finalizeCodeReview,
  completeWorkflow,
  runImplementationPostStartSequence,
  loadFragment,
  buildReminderInjection,
  buildModeInjection,
  fragmentExists,
  buildImplementationHandoff,
  serializeHandoff,
  deserializeHandoff,
  buildHandoffPromptPrefix,
  canForkSession,
  resolveVerificationCommand,
  runVerification,
  appendFailureLog,
  runVerificationFixLoop,
  detectResumeContext,
  resumeWorkflow,
  abandonWorkflow,
  buildResumePrompt,
  handlePlanDrift,
  createPlanAmendment,
  buildDriftDetectedReminder,
  buildCodeReviewInputFromContext,
  runChangeAuditWorkflow,
  runChangeFixWorkflow,
  runCleanWorkflow,
  readFailureLog,
  findRelevantFailures,
  appendFailureEntry,
  formatFailureLogEntries,
  parseFailureLog,
  buildPlanApprovalQuestions,
  buildImplementationGateQuestions,
  parseInterviewResponse,
  runStructuredInterview,
  publishPlanArtifacts,
  deriveSemanticChangeId,
  resolveChangeImplementTarget,
}

export type {
  PublishPlanArtifactsResult,
  StateIndexEntry,
  ReminderId,
  ModeFragment,
  PrepareWorkflowOptions,
  PrepareWorkflowResult,
  ImplementationHandoff,
  ForkSessionResult,
  ImplementWorkflowOptions,
  ImplementWorkflowResult,
  VerificationResult,
  FixLoopOptions,
  FixLoopResult,
  FixAttempt,
  DriftResolution,
  CodeReviewInputContext,
  AuditWorkflowOptions,
  AuditWorkflowResult,
  FixWorkflowOptions,
  FixWorkflowResult,
  CleanWorkflowOptions,
  CleanWorkflowResult,
  FailureLogEntry,
  ResumeContext,
  GuardResult,
  GuardIntent,
  GuardOptions,
}

// ── Structured interview helper ─────────────────────────────────

/**
 * Minimal type for a context with interview/UI capability.
 *
 * Permissive to avoid depending on concrete Pi internals — any object
 * matching one of the recognised shapes will work.
 */
export interface InterviewableContext {
  /** Direct interview function (future Pi API). */
  interview?: (payload: string) => Promise<string | undefined> | string | undefined
  /** Nested UI context. */
  ui?: {
    interview?: (payload: string) => Promise<string | undefined> | string | undefined
    /** Single-select from options. */
    select?: (title: string, options: string[], extra?: Record<string, unknown>) => Promise<string | undefined>
    /** Confirm dialog (boolean). */
    confirm?: (title: string, message: string, extra?: Record<string, unknown>) => Promise<boolean>
    /** Plain text input. */
    input?: (title: string, placeholder?: string, extra?: Record<string, unknown>) => Promise<string | undefined>
    /** Non-blocking notification. */
    notify: (message: string, type?: "info" | "warning" | "error") => void
    /** Dynamic widget rendered near the editor in interactive TUI mode. */
    setWidget?: (id: string, content?: string[], options?: { placement?: "aboveEditor" | "belowEditor" }) => void
    /** Footer status indicator in interactive TUI mode. */
    setStatus?: (id: string, value?: string) => void
    /** Request an immediate TUI redraw. */
    requestRender?: () => void
  }
  /**
   * The Pi runtime model registry, available when the handler runs inside
   * a Pi extension command context. Provides model discovery and auth checks.
   *
   * When present, profile resolution can check lane models against
   * real model availability. When absent, lane-health checks are skipped
   * and all resolved lanes are assumed healthy.
   */
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
      [key: string]: unknown
    }>
    hasConfiguredAuth(model: {
      provider: string
      id: string
      [key: string]: unknown
    }): boolean
  }
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

const WORKFLOW_PROGRESS_MESSAGE_TYPE = "zflow-workflow-progress" as const

interface WorkflowProgressSnapshot {
  id: string
  command: string
  changePath: string
  model?: string
  thinking?: string
  status: "running" | "completed" | "failed"
  startedAt: number
  finishedAt?: number
  lastMessage: string
  updateCount: number
  recentMessages: string[]
  subagents: WorkflowSubagentSnapshot[]
  phaseCards: WorkflowPhaseCardSnapshot[]
  reviewers: WorkflowReviewerSnapshot[]
}

interface WorkflowReviewerSnapshot {
  id: string
  reviewerName: string
  agentName: string
  model?: string
  thinking?: string
  status: "queued" | "running" | "completed" | "failed"
  startedAt: number
  finishedAt?: number
  currentTool?: string
  lastCommand?: string
}

interface WorkflowPhaseCardSnapshot {
  id: string
  title: string
  status: "running" | "completed" | "failed"
  startedAt: number
  finishedAt?: number
  messages: string[]
}

interface WorkflowSubagentSnapshot {
  id: string
  agent: string
  title?: string
  model?: string
  thinking?: string
  status: string
  startedAt: number
  finishedAt?: number
  lastCommand?: string
  lastActivityAt?: number
}

interface WorkflowProgressMessageDetails {
  id: string
  snapshot: WorkflowProgressSnapshot
}

const workflowProgressSnapshots = new Map<string, WorkflowProgressSnapshot>()
let workflowProgressCounter = 0

function truncateText(value: string, width: number): string {
  if (width <= 0) return ""
  if (value.length <= width) return value
  return `${value.slice(0, Math.max(0, width - 1))}…`
}

function subagentSortKey(id: string): number {
  const match = id.match(/(\d+)$/)
  return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER
}

function visualCharWidth(char: string): number {
  const cp = char.codePointAt(0) ?? 0
  if (cp >= 0x1F300 && cp <= 0x1F9FF) return 2
  if (cp >= 0x2600 && cp <= 0x27BF) return 2
  if (cp >= 0x2300 && cp <= 0x23FF) return 2
  if (cp >= 0x2B00 && cp <= 0x2BFF) return 2
  if (cp >= 0xFE00 && cp <= 0xFE0F) return 0
  if (cp >= 0x1F000 && cp <= 0x1F02F) return 2
  return 1
}

function visualWidth(text: string): number {
  let w = 0
  for (const ch of text) w += visualCharWidth(ch)
  return w
}

function visualTruncate(value: string, maxVisualWidth: number): string {
  let w = 0
  let idx = 0
  for (const ch of value) {
    const cw = visualCharWidth(ch)
    if (w + cw > maxVisualWidth) break
    w += cw
    idx++
  }
  return value.slice(0, idx)
}

function visualPadEnd(value: string, targetVisualWidth: number): string {
  const currentWidth = visualWidth(value)
  if (currentWidth >= targetVisualWidth) return value
  return value + " ".repeat(targetVisualWidth - currentWidth)
}

/**
 * Word-wrap plain text at word boundaries, preserving visual character widths.
 * Input MUST NOT contain ANSI escape codes.
 * Returns lines each with visual width ≤ maxWidth.
 */
function wordWrap(text: string, maxWidth: number): string[] {
  if (!text) return [""]
  if (maxWidth <= 0) return [""]
  if (visualWidth(text) <= maxWidth) return [text]

  const result: string[] = []
  let line = ""

  for (const word of text.split(" ")) {
    if (!word) {
      if (line) line += " " // preserve inter-word spacing
      continue
    }

    const candidate = line ? line + " " + word : word
    if (visualWidth(candidate) <= maxWidth) {
      line = candidate
    } else {
      if (line) result.push(line)

      // Word itself may exceed maxWidth — hard-break it
      if (visualWidth(word) > maxWidth) {
        let remaining = word
        let chunk = ""
        for (const ch of remaining) {
          const test = chunk + ch
          if (visualWidth(test) > maxWidth && chunk) {
            result.push(chunk)
            chunk = ch
          } else {
            chunk = test
          }
        }
        line = chunk
      } else {
        line = word
      }
    }
  }

  if (line) result.push(line)
  return result
}

function isFinishedSubagentStatus(status: string): boolean {
  const normalized = status.toLowerCase()
  return normalized === "completed" || normalized === "failed"
}

function subagentStatusIcon(status: string): string {
  const normalized = status.toLowerCase()
  if (normalized === "completed") return "✅"
  if (normalized === "failed") return "❌"
  if (normalized === "queued") return "⏳"
  return "▶️"
}

/**
 * View model for a single zflow card.
 * Pure data — the card renderer consumes this to produce themed lines.
 */
interface ZflowCardViewModel {
  /** Unique card identifier. */
  id: string
  /** Primary heading line (e.g. "✅ Code Review"). */
  title: string
  /** Status for coloring. */
  status: "queued" | "running" | "completed" | "failed"
  /** First metadata line — the status + elapsed string. */
  statusLine: string
  /** Additional metadata lines (model, thinking, agent, etc.). */
  metaLines: string[]
  /** Body lines — bullet messages or detail entries. */
  bodyLines: string[]
  /** Raw thinking level string if known ("off", "low", …, "xhigh"). */
  thinking?: string
}

/**
 * Apply the Pi theme's thinking level color to a raw thinking string.
 * Falls back to dim when unknown or unavailable.
 */
function colorizeThinking(thinking: string | undefined, theme: any): string {
  if (!thinking) return theme.fg("dim", "unavailable")
  const t = thinking.toLowerCase()
  const colorMap: Record<string, string> = {
    off: "thinkingOff",
    low: "thinkingLow",
    medium: "thinkingMedium",
    high: "thinkingHigh",
    xhigh: "thinkingXhigh",
  }
  const colorKey = colorMap[t]
  if (colorKey) return theme.fg(colorKey, thinking)
  return theme.fg("dim", thinking)
}

function statusTextColor(status: ZflowCardViewModel["status"], theme: any, text: string): string {
  if (status === "completed") return theme.fg("success", text)
  if (status === "failed") return theme.fg("error", text)
  if (status === "queued") return theme.fg("warning", text)
  return theme.fg("accent", text)
}

/**
 * Choose a Pi TUI background function for a card based on its status.
 * Returns a function that wraps text in the appropriate theme background color.
 */
function cardBgFn(status: ZflowCardViewModel["status"], theme: any): (s: string) => string {
  if (status === "completed") return (s) => theme.bg("toolSuccessBg", s)
  if (status === "failed") return (s) => theme.bg("toolErrorBg", s)
  if (status === "running") return (s) => theme.bg("toolPendingBg", s)
  return (s) => theme.bg("customMessageBg", s)
}

function colorizeMetaLine(rawMeta: string, theme: any): string {
  const thinkingIdx = rawMeta.lastIndexOf("thinking:")
  if (thinkingIdx === -1) return theme.fg("dim", rawMeta)

  const prefix = rawMeta.slice(0, thinkingIdx)
  const label = "thinking:"
  const rest = rawMeta.slice(thinkingIdx + label.length)
  const leading = rest.match(/^\s*/)?.[0] ?? ""
  const valueAndSuffix = rest.slice(leading.length)
  const value = valueAndSuffix.split(/\s+/)[0] ?? valueAndSuffix
  const suffix = valueAndSuffix.slice(value.length)

  return `${theme.fg("dim", prefix)}${theme.fg("dim", label)}${theme.fg("dim", leading)}${colorizeThinking(value, theme)}${theme.fg("dim", suffix)}`
}

/**
 * Render a single zflow card as a filled-background panel with text wrapping.
 *
 * Uses Pi TUI theme background colors based on status. Each content line is
 * word-wrapped to fit the available width, and the card grows vertically to
 * accommodate wrapped content. No truncation — text that would overflow wraps
 * to one or more additional lines.
 */
function buildCardLines(model: ZflowCardViewModel, theme: any, width: number): string[] {
  const safeWidth = Math.max(8, width)
  const bgFn = cardBgFn(model.status, theme)

  function cardLineWrapped(text: string, colorize: (s: string) => string): string[] {
    const contentWidth = Math.max(1, safeWidth - 2)
    const wrapped = wordWrap(text, contentWidth)
    return wrapped.map((fragment) => {
      const indented = "  " + fragment
      const padded = visualPadEnd(indented, safeWidth)
      return bgFn(colorize(padded))
    })
  }

  const lines: string[] = []

  // Top padding — empty background-filled line for vertical breathing room
  lines.push(bgFn(" ".repeat(safeWidth)))

  // Title — word-wrapped, colored by status
  for (const l of cardLineWrapped(model.title, (s) => statusTextColor(model.status, theme, s))) {
    lines.push(l)
  }

  // Status + elapsed line — dimmed metadata
  for (const l of cardLineWrapped(model.statusLine, (s) => theme.fg("dim", s))) {
    lines.push(l)
  }

  // Meta lines — dimmed, with thinking level highlighted
  for (const meta of model.metaLines) {
    for (const l of cardLineWrapped(meta, (s) => colorizeMetaLine(s, theme))) {
      lines.push(l)
    }
  }

  // Body lines — dimmed bullet items
  for (const body of model.bodyLines) {
    for (const l of cardLineWrapped(body, (s) => theme.fg("dim", s))) {
      lines.push(l)
    }
  }

  // Bottom padding
  lines.push(bgFn(" ".repeat(safeWidth)))

  return lines
}

/**
 * View-model adapters for each card kind.
 */
function toSubagentCardModel(subagent: WorkflowSubagentSnapshot): ZflowCardViewModel {
  const elapsed = formatElapsed((subagent.finishedAt ?? Date.now()) - subagent.startedAt)
  const model = subagent.model ?? "unavailable"
  const thinking = subagent.thinking ?? "unavailable"
  const status = mapSubagentStatus(subagent.status)
  return {
    id: subagent.id,
    title: `${subagentStatusIcon(subagent.status)} ${subagent.title ?? "untitled group"}`,
    status,
    statusLine: `${subagent.status} · ${elapsed}`,
    metaLines: [
      subagent.id,
      `${subagent.agent} · ${model} · ${thinking}`,
    ],
    bodyLines: [`last: ${subagent.lastCommand ?? "starting"}`],
    thinking: subagent.thinking,
  }
}

function toPhaseCardModel(card: WorkflowPhaseCardSnapshot): ZflowCardViewModel {
  const elapsed = formatElapsed((card.finishedAt ?? Date.now()) - card.startedAt)
  return {
    id: card.id,
    title: `${subagentStatusIcon(card.status)} ${card.title}`,
    status: card.status,
    statusLine: `${card.status} · ${elapsed}`,
    metaLines: [],
    bodyLines: card.messages.slice(-4).map((m) => `• ${m}`),
  }
}

function toReviewerCardModel(reviewer: WorkflowReviewerSnapshot): ZflowCardViewModel {
  const model = reviewer.model ?? "unavailable"
  const thinking = reviewer.thinking ?? "unavailable"
  const status = reviewer.status
  const icon = status === "completed" ? "✅" : status === "failed" ? "❌" : status === "queued" ? "⏳" : "▶️"
  return {
    id: reviewer.id,
    title: `${icon} ${reviewer.reviewerName}`,
    status,
    statusLine: status,
    metaLines: [
      `${reviewer.agentName}`,
      `model: ${model} · thinking: ${thinking}`,
    ],
    bodyLines: [`last: ${reviewer.lastCommand ?? reviewer.currentTool ?? "starting"}`],
    thinking: reviewer.thinking,
  }
}

function mapSubagentStatus(status: string): "queued" | "running" | "completed" | "failed" {
  const s = status.toLowerCase()
  if (s === "completed") return "completed"
  if (s === "failed") return "failed"
  if (s === "queued") return "queued"
  return "running"
}

/**
 * Component-style zflow card.
 *
 * Implements the Pi TUI Component interface (render + invalidate) so it can
 * be used directly in Pi's TUI framework. Internally caches rendered output
 * for the same width to avoid recomputation on every render cycle.
 */
class ZflowCard {
  private model: ZflowCardViewModel
  private theme: any
  private cachedWidth?: number
  private cachedLines?: string[]

  constructor(model: ZflowCardViewModel, theme: any) {
    this.model = model
    this.theme = theme
  }

  /** Update the card's content. Invalidates cache. */
  setModel(model: ZflowCardViewModel): void {
    this.model = model
    this.invalidate()
  }

  invalidate(): void {
    this.cachedWidth = undefined
    this.cachedLines = undefined
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines
    }
    this.cachedWidth = width
    this.cachedLines = buildCardLines(this.model, this.theme, width)
    return this.cachedLines
  }
}

/**
 * Render a grid of reviewer cards.
 */
function renderReviewerCards(reviewers: WorkflowReviewerSnapshot[], width: number, theme: any): string[] {
  const available = Math.max(32, width - 2)
  const columns = available >= 120 ? 3 : available >= 76 ? 2 : 1
  const gap = 2
  const cardWidth = Math.max(32, Math.floor((available - (columns - 1) * gap) / columns))
  const ordered = [...reviewers].sort((a, b) => a.reviewerName.localeCompare(b.reviewerName))
  const rendered: string[] = []

  for (let index = 0; index < ordered.length; index += columns) {
    const rowSlice = ordered.slice(index, index + columns)
    const rowCardData = rowSlice.map((r) => {
      const model = toReviewerCardModel(r)
      return {
        lines: new ZflowCard(model, theme).render(cardWidth),
        bg: cardBgFn(model.status, theme),
      }
    })
    const rowHeight = Math.max(...rowCardData.map((d) => d.lines.length))
    for (let line = 0; line < rowHeight; line++) {
      rendered.push(
        rowCardData
          .map((d) => d.lines[line] ?? d.bg(" ".repeat(cardWidth)))
          .join(" ".repeat(gap)),
      )
    }
  }

  return rendered
}

/**
 * Render a vertical stack of phase workflow cards, with reviewer cards
 * inserted immediately after the Code Review phase card.
 */
function renderWorkflowCards(
  cards: WorkflowPhaseCardSnapshot[],
  width: number,
  theme: any,
  reviewers: WorkflowReviewerSnapshot[] = [],
): string[] {
  const available = Math.max(32, width - 2)
  const rendered: string[] = []
  let reviewersRendered = false

  for (const card of cards) {
    if (rendered.length > 0) rendered.push("")
    rendered.push(...new ZflowCard(toPhaseCardModel(card), theme).render(available))
    if (card.id === "code-review" && reviewers.length > 0) {
      rendered.push("")
      rendered.push(...renderReviewerCards(reviewers, available, theme))
      reviewersRendered = true
    }
  }

  if (!reviewersRendered && reviewers.length > 0) {
    if (rendered.length > 0) rendered.push("")
    rendered.push(...renderReviewerCards(reviewers, available, theme))
  }

  return rendered
}

/**
 * Render a grid of subagent cards.
 */
function renderSubagentCards(subagents: WorkflowSubagentSnapshot[], width: number, theme: any): string[] {
  const available = Math.max(32, width - 2)
  const columns = available >= 120 ? 3 : available >= 76 ? 2 : 1
  const gap = 2
  const cardWidth = Math.max(32, Math.floor((available - (columns - 1) * gap) / columns))
  const ordered = [...subagents].sort((a, b) => subagentSortKey(a.id) - subagentSortKey(b.id) || a.id.localeCompare(b.id))
  const rendered: string[] = []

  for (let index = 0; index < ordered.length; index += columns) {
    const rowSlice = ordered.slice(index, index + columns)
    const rowCardData = rowSlice.map((sa) => {
      const model = toSubagentCardModel(sa)
      return {
        lines: new ZflowCard(model, theme).render(cardWidth),
        bg: cardBgFn(model.status, theme),
      }
    })
    const rowHeight = Math.max(...rowCardData.map((d) => d.lines.length))
    for (let line = 0; line < rowHeight; line++) {
      rendered.push(
        rowCardData
          .map((d) => d.lines[line] ?? d.bg(" ".repeat(cardWidth)))
          .join(" ".repeat(gap)),
      )
    }
  }

  return rendered
}

function makeWorkflowProgressComponent(details: WorkflowProgressMessageDetails, theme: any): {
  invalidate: () => void
  render: (width: number) => string[]
} {
  return {
    invalidate() {
      // Render always reads from workflowProgressSnapshots dynamically;
      // no local cache to invalidate. This stub ensures Pi's TUI framework
      // recognises the component as properly implementing the lifecycle.
    },
    render(width: number): string[] {
      const snapshot = workflowProgressSnapshots.get(details.id) ?? details.snapshot
      const finishedAt = snapshot.finishedAt ?? Date.now()
      const elapsed = formatElapsed(finishedAt - snapshot.startedAt)
      const statusLabel = snapshot.status === "running"
        ? theme.fg("accent", "running")
        : snapshot.status === "completed"
          ? theme.fg("success", "completed")
          : theme.fg("error", "failed")
      const icon = snapshot.status === "running" ? "🤖" : snapshot.status === "completed" ? "✅" : "⚠️"
      const available = Math.max(24, width - 2)
      const lines = [
        truncateText(`${icon} ${theme.bold(snapshot.command)} ${statusLabel}`, available),
        truncateText(`  ${theme.fg("dim", "change:")} ${snapshot.changePath}`, available),
      ]
      if (snapshot.model) {
        lines.push(truncateText(`  ${theme.fg("dim", "model:")} ${snapshot.model}`, available))
      }
      if (snapshot.thinking) {
        lines.push(truncateText(`  ${theme.fg("dim", "thinking:")} ${snapshot.thinking}`, available))
      }
      lines.push(
        truncateText(`  ${theme.fg("dim", "elapsed:")} ${elapsed}`, available),
        truncateText(`  ${theme.fg("dim", "updates:")} ${snapshot.updateCount}`, available),
        truncateText(`  ${theme.fg("dim", "last:")} ${snapshot.lastMessage}`, available),
      )
      const phaseCards = snapshot.phaseCards ?? []
      // Suppress top-level recent-message bullets when phase cards are present,
      // because the cards provide the same information in a more readable layout.
      if (phaseCards.length === 0) {
        for (const message of snapshot.recentMessages.slice(-3)) {
          lines.push(truncateText(`  ${theme.fg("dim", "•")} ${message}`, available))
        }
      }
      if (snapshot.subagents.length > 0) {
        const finished = snapshot.subagents.filter((subagent) => isFinishedSubagentStatus(subagent.status)).length
        lines.push(truncateText(`  ${theme.fg("dim", "subagents:")} ${finished}/${snapshot.subagents.length} finished`, available))
        lines.push(...renderSubagentCards(snapshot.subagents, available, theme))
      }
      const reviewers = snapshot.reviewers ?? []
      if (phaseCards.length > 0) {
        lines.push(truncateText(`  ${theme.fg("dim", "workflow cards:")}`, available))
        lines.push(...renderWorkflowCards(phaseCards, available, theme, reviewers))
      } else if (reviewers.length > 0) {
        lines.push(`  ${theme.fg("dim", "reviewers:")}`)
        lines.push(...renderReviewerCards(reviewers, available, theme))
      }
      return lines
    },
  }
}

function registerWorkflowProgressRenderer(pi: ExtensionAPI): void {
  if (typeof pi.registerMessageRenderer !== "function") return
  pi.registerMessageRenderer<WorkflowProgressMessageDetails>(
    WORKFLOW_PROGRESS_MESSAGE_TYPE,
    (message, _options, theme) => {
      const details = message.details as WorkflowProgressMessageDetails | undefined
      if (!details?.id || !details.snapshot) return undefined
      return makeWorkflowProgressComponent(details, theme)
    },
  )
}

function createWorkflowProgressIndicator(
  pi: ExtensionAPI,
  ctx: InterviewableContext,
  changePath: string,
  options?: { command?: string; model?: string; thinking?: string; initialMessage?: string; statusId?: string; widgetId?: string },
): {
  update: (message: string) => void
  updatePhaseCard: (id: string, title: string, message: string, status?: "running" | "completed" | "failed") => void
  updateSubagent: (id: string, update: Partial<Omit<WorkflowSubagentSnapshot, "id">>) => void
  updateReviewer: (id: string, update: {
    reviewerName: string
    agentName: string
    status: "queued" | "running" | "completed" | "failed"
    model?: string
    thinking?: string
    currentTool?: string
    lastCommand?: string
  }) => void
  stop: (message?: string, status?: "completed" | "failed") => void
} {
  const ui = ctx.ui
  const id = `wf-${Date.now().toString(36)}-${++workflowProgressCounter}`
  const command = options?.command ?? "zflow-workflow"
  const statusId = options?.statusId ?? `zflow-${command.replace(/^zflow-/, "").replace(/-/g, "")}`
  const widgetId = options?.widgetId ?? `${command}-progress`
  const startedAt = Date.now()
  let stopped = false
  // Clear the older below-editor widget if it exists from a hot-reloaded session.
  ui?.setWidget?.(widgetId, undefined)
  const initialSnapshot: WorkflowProgressSnapshot = {
    id,
    command,
    changePath,
    model: options?.model,
    thinking: options?.thinking,
    status: "running",
    startedAt,
    lastMessage: options?.initialMessage ?? "Initializing workflow",
    updateCount: 0,
    recentMessages: [options?.initialMessage ?? "Initializing workflow"],
    subagents: [],
    phaseCards: [],
    reviewers: [],
  }
  workflowProgressSnapshots.set(id, initialSnapshot)

  if (typeof pi.sendMessage === "function") {
    pi.sendMessage({
      customType: WORKFLOW_PROGRESS_MESSAGE_TYPE,
      content: `${command} ${changePath}`,
      display: true,
      details: { id, snapshot: initialSnapshot },
    })
  }

  const refreshProgressMessage = (): void => {
    // The custom message renderer reads the latest snapshot from
    // workflowProgressSnapshots, so one persistent chat component is enough.
    // Re-sending visible messages for every tick/update creates duplicated
    // historical progress blocks in chat.
    ui?.requestRender?.()
  }

  const render = (): void => {
    if (stopped) return
    const elapsed = formatElapsed(Date.now() - startedAt)
    ui?.setStatus?.(statusId, `${command} ${elapsed}`)
    ui?.requestRender?.()
  }

  render()
  refreshProgressMessage()

  const interval = setInterval(() => {
    const current = workflowProgressSnapshots.get(id)
    if (current) {
      const now = Date.now()
      let mutated = false
      const updatedSubagents = [...current.subagents]
      for (let i = 0; i < updatedSubagents.length; i++) {
        const subagent = updatedSubagents[i]
        if (subagent && subagent.status === "running" && subagent.lastActivityAt && now - subagent.lastActivityAt > 20_000) {
          updatedSubagents[i] = { ...subagent, lastCommand: "thinking / waiting for model..." }
          mutated = true
        }
      }
      if (mutated) {
        workflowProgressSnapshots.set(id, { ...current, subagents: updatedSubagents })
      }
    }
    render()
    refreshProgressMessage()
  }, 1000)

  return {
    update(message: string) {
      const current = workflowProgressSnapshots.get(id)
      const normalizedMessage = message.replace(/\s+/g, " ").trim()
      if (current) {
        workflowProgressSnapshots.set(id, {
          ...current,
          lastMessage: normalizedMessage,
          updateCount: current.updateCount + 1,
          recentMessages: [...current.recentMessages, normalizedMessage].slice(-5),
        })
      }
      render()
      refreshProgressMessage()
    },
    updatePhaseCard(cardId: string, title: string, message: string, status: "running" | "completed" | "failed" = "running") {
      const current = workflowProgressSnapshots.get(id)
      const normalizedMessage = message.replace(/\s+/g, " ").trim()
      if (current) {
        const currentPhaseCards = current.phaseCards ?? []
        const existing = currentPhaseCards.find((card) => card.id === cardId)
        const nextCard: WorkflowPhaseCardSnapshot = {
          id: cardId,
          title,
          status,
          startedAt: existing?.startedAt ?? Date.now(),
          finishedAt: status === "running" ? undefined : existing?.finishedAt ?? Date.now(),
          messages: [...(existing?.messages ?? []), normalizedMessage].slice(-8),
        }
        const phaseCards = [...currentPhaseCards]
        const existingIdx = phaseCards.findIndex((card) => card.id === cardId)
        if (existingIdx >= 0) phaseCards[existingIdx] = nextCard
        else phaseCards.push(nextCard)
        workflowProgressSnapshots.set(id, {
          ...current,
          lastMessage: normalizedMessage,
          updateCount: current.updateCount + 1,
          recentMessages: [...current.recentMessages, normalizedMessage].slice(-5),
          phaseCards,
        })
      }
      render()
      refreshProgressMessage()
    },
    updateSubagent(subagentId: string, update: Partial<Omit<WorkflowSubagentSnapshot, "id">>) {
      const current = workflowProgressSnapshots.get(id)
      let shouldSendMessage = false
      if (current) {
        const existing = current.subagents.find((subagent) => subagent.id === subagentId)
        const nextStatus = update.status ?? existing?.status ?? "running"
        const statusChanged = update.status !== undefined && update.status !== existing?.status
        const lastCommandChanged = update.lastCommand !== undefined && update.lastCommand !== existing?.lastCommand
        const startedAtChanged = update.startedAt !== undefined && update.startedAt !== existing?.startedAt
        const nextSubagent: WorkflowSubagentSnapshot = {
          id: subagentId,
          agent: update.agent ?? existing?.agent ?? subagentId,
          title: update.title ?? existing?.title,
          model: update.model ?? existing?.model,
          thinking: update.thinking ?? existing?.thinking,
          status: nextStatus,
          startedAt: update.startedAt ?? existing?.startedAt ?? Date.now(),
          finishedAt: update.finishedAt ?? existing?.finishedAt ?? (isFinishedSubagentStatus(nextStatus) ? Date.now() : undefined),
          lastCommand: update.lastCommand ?? existing?.lastCommand,
          lastActivityAt: Date.now(),
        }
        const existingIdx = current.subagents.findIndex((subagent) => subagent.id === subagentId)
        const updatedSubagents = [...current.subagents]
        if (existingIdx >= 0) {
          updatedSubagents[existingIdx] = nextSubagent
        } else {
          updatedSubagents.push(nextSubagent)
        }
        workflowProgressSnapshots.set(id, {
          ...current,
          subagents: updatedSubagents,
        })
        shouldSendMessage = statusChanged || lastCommandChanged || startedAtChanged
      }
      render()
      if (shouldSendMessage) {
        refreshProgressMessage()
      }
    },
    updateReviewer(reviewerId: string, update: {
      reviewerName: string
      agentName: string
      status: "queued" | "running" | "completed" | "failed"
      model?: string
      thinking?: string
      currentTool?: string
      lastCommand?: string
    }) {
      const current = workflowProgressSnapshots.get(id)
      if (current) {
        const currentReviewers = current.reviewers ?? []
        const existing = currentReviewers.find((r) => r.id === reviewerId)
        const statusChanged = update.status !== existing?.status
        const activityChanged = update.lastCommand !== existing?.lastCommand || update.currentTool !== existing?.currentTool
        const nextReviewer: WorkflowReviewerSnapshot = {
          id: reviewerId,
          reviewerName: update.reviewerName,
          agentName: update.agentName,
          model: update.model ?? existing?.model,
          thinking: update.thinking ?? existing?.thinking,
          status: update.status,
          startedAt: existing?.startedAt ?? Date.now(),
          finishedAt: update.status === "completed" || update.status === "failed" ? existing?.finishedAt ?? Date.now() : undefined,
          currentTool: update.currentTool ?? existing?.currentTool,
          lastCommand: update.lastCommand ?? existing?.lastCommand,
        }
        const updatedReviewers = [...currentReviewers]
        const existingIdx = updatedReviewers.findIndex((r) => r.id === reviewerId)
        if (existingIdx >= 0) updatedReviewers[existingIdx] = nextReviewer
        else updatedReviewers.push(nextReviewer)
        workflowProgressSnapshots.set(id, {
          ...current,
          reviewers: updatedReviewers,
        })
        if (statusChanged || activityChanged) refreshProgressMessage()
      }
      render()
    },
    stop(message?: string, status: "completed" | "failed" = "completed") {
      if (stopped) return
      stopped = true
      clearInterval(interval)
      ui?.setStatus?.(statusId, undefined)
      ui?.setWidget?.(widgetId, undefined)
      const current = workflowProgressSnapshots.get(id)
      if (current) {
        workflowProgressSnapshots.set(id, {
          ...current,
          status,
          finishedAt: Date.now(),
          lastMessage: message ?? current.lastMessage,
        })
      }
      refreshProgressMessage()
      ui?.requestRender?.()
    },
  }
}

/**
 * Parse a simplified questions payload to extract the first single-choice
 * question and its options for a fallback `ui.select` or `ui.confirm` call.
 */
function extractFirstChoice(questionsJson: string): {
  title: string
  question: string
  options: string[]
} | null {
  try {
    const parsed = JSON.parse(questionsJson)
    const title = parsed.title ?? "Decision Required"
    const q = parsed.questions?.[0]
    if (!q) return null
    if (q.type === "single" && Array.isArray(q.options)) {
      return {
        title,
        question: q.question,
        options: q.options.map((o: { label: string }) => o.label),
      }
    }
    return { title, question: q.question ?? "Proceed?", options: ["Yes", "No"] }
  } catch {
    return null
  }
}

/** Map a fallback select choice to a decision string. */
function selectToDecision(
  selected: string | undefined,
  questionsJson: string,
): { decision: string; revisionNotes?: string } | null {
  if (!selected) {
    return { decision: "cancel" }
  }
  // Match the selected label against the options in the JSON payload
  try {
    const parsed = JSON.parse(questionsJson)
    const q = parsed.questions?.[0]
    if (q?.type === "single" && Array.isArray(q.options)) {
      const matched = q.options.find(
        (o: { label: string }) => o.label === selected,
      )
      if (matched?.label?.startsWith?.("Approve") || matched?.label === "Yes") {
        return { decision: "approve" }
      }
      if (matched?.label?.startsWith?.("Request Revisions")) {
        return { decision: "revise", revisionNotes: "Revision requested via gate" }
      }
      if (matched?.label?.startsWith?.("Cancel") || matched?.label === "No") {
        return { decision: "cancel" }
      }
      if (matched?.label?.startsWith?.("Inspect Artifacts")) {
        return { decision: "inspect" }
      }
      // Other labels map to a "continue" decision
      return { decision: "continue" }
    }
  } catch {
    // fall through
  }
  return { decision: "continue" }
}

function formatPlanInspectionPaths(input: {
  changeId: string
  planVersion: string
  planStatePath: string
  artifactPaths: Record<string, string>
  reviewFindingsPath?: string
  durableDir?: string
  publishedArtifacts?: Record<string, string>
  publishErrors?: string[]
}): string {
  const durable = input.durableDir && input.publishedArtifacts
    ? Object.entries(input.publishedArtifacts).length > 0
    : false

  const sections: string[] = []

  if (durable && input.publishedArtifacts) {
    sections.push(
      `📂 Repo-visible change documents for "${input.changeId}" ${input.planVersion}:`,
      `  - directory: ${input.durableDir}`,
    )
    for (const [key, filePath] of Object.entries(input.publishedArtifacts)) {
      sections.push(`  - ${key}: ${filePath}`)
    }
    sections.push("")
  }

  sections.push(`📌 Runtime plan artifacts for "${input.changeId}" ${input.planVersion}:`)
  if (input.planStatePath) sections.push(`  - plan state: ${input.planStatePath}`)
  for (const key of ["design", "executionGroups", "standards", "verification"] as const) {
    if (input.artifactPaths[key]) sections.push(`  - ${key}: ${input.artifactPaths[key]}`)
  }
  if (input.reviewFindingsPath) sections.push(`  - review findings: ${input.reviewFindingsPath}`)

  if (input.publishErrors && input.publishErrors.length > 0) {
    sections.push("")
    sections.push("⚠️  Publishing warnings:")
    for (const err of input.publishErrors) {
      sections.push(`  - ${err}`)
    }
  }

  sections.push(
    "",
    `Review the changes in the repo-visible directory before approving.`,
    `If you need time, choose "Inspect Artifacts" or "Cancel"; the plan remains on disk and can be revisited later.`,
  )

  return sections.join("\n")
}

/**
 * Run a structured interview with the user, adapting to whatever UI
 * capabilities the context provides.
 *
 * Priority order:
 * 1. `ctx.interview(payload)` — future Pi native interview API
 * 2. `ctx.ui.interview(payload)` — future Pi UI interview API
 * 3. `ctx.ui.select()` / `ctx.ui.confirm()` — fallback for single-choice questions
 * 4. `ctx.ui.notify()` — last-resort notification
 *
 * @param ctx - The extension command context (or any InterviewableContext).
 * @param questionsJson - JSON string produced by buildPlanApprovalQuestions()
 *                        or buildImplementationGateQuestions().
 * @param fallbackMessage - Concise message to show when no interactive UI is
 *                          available.
 * @returns Parsed decision + optional revision notes, or null if the
 *          context had no usable UI at all.
 */
async function runStructuredInterview(
  ctx: InterviewableContext,
  questionsJson: string,
  fallbackMessage: string,
): Promise<{ decision: string; revisionNotes?: string } | null> {
  // 1. Try ctx.interview (native Pi interview API)
  if (typeof ctx.interview === "function") {
    const raw = await Promise.resolve(ctx.interview(questionsJson))
    if (raw !== undefined) {
      return parseInterviewResponse(raw)
    }
  }

  // 2. Try ctx.ui.interview
  if (typeof ctx.ui?.interview === "function") {
    const raw = await Promise.resolve(ctx.ui.interview(questionsJson))
    if (raw !== undefined) {
      return parseInterviewResponse(raw)
    }
  }

  // 3. Fall back to ctx.ui.select / ctx.ui.confirm
  const choice = extractFirstChoice(questionsJson)
  if (choice && typeof ctx.ui?.select === "function") {
    const selected = await ctx.ui.select(
      `${choice.title}: ${choice.question}`,
      choice.options,
    )
    const result = selectToDecision(selected, questionsJson)
    if (result) return result
  }

  // 4. Fall back to ctx.ui.confirm (binary yes/no)
  if (typeof ctx.ui?.confirm === "function") {
    const ok = await ctx.ui.confirm(
      "Approve?",
      fallbackMessage,
    )
    return { decision: ok ? "approve" : "cancel" }
  }

  // 5. No interactive UI — notify and return a safe default
  if (typeof ctx.ui?.notify === "function") {
    ctx.ui.notify(fallbackMessage, "info")
  }
  return { decision: "inspect" }
}

/**
 * Return whether ad-hoc `/zflow-plan` mode is currently active.
 *
 * Formal change preparation may approve a plan while plan mode is active, but
 * it must not immediately fork or hand off to implementation from that
 * read-only planning context.
 */
export function isAdHocPlanModeActive(): boolean {
  try {
    const service = getZflowRegistry().optional<{
      isPlanModeActive?: () => boolean
    }>("plan-mode")
    return service?.isPlanModeActive?.() === true
  } catch {
    return false
  }
}

/**
 * Decide whether `/zflow-change-prepare` should create an implementation
 * handoff/session fork after plan approval.
 */
export function shouldForkImplementationSessionAfterPrepare(): boolean {
  return !isAdHocPlanModeActive()
}

/** Parsed arguments for `/zflow-change-prepare`. */
export interface ParsedChangePrepareArgs {
  changePath: string
  forceAdHoc: boolean
  notes: string
}

/**
 * Parse `/zflow-change-prepare` arguments.
 *
 * The command's first token is the change document/path. Remaining text is
 * advisory notes. `--no-runecontext` or a note like "not a RuneContext" forces
 * normal ad-hoc change-doc handling.
 */
export function parseChangePrepareArgs(args: string): ParsedChangePrepareArgs {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const rawPath = parts[0] ?? ""
  const rest = parts.slice(1)
  const notes = rest.filter((part) => part !== "--no-runecontext").join(" ")
  const forceAdHoc =
    rest.includes("--no-runecontext") ||
    /\bnot\s+(?:a\s+)?runecontext\b/i.test(notes) ||
    /\bnormal\s+idea\s+file\b/i.test(notes)
  const changePath = forceAdHoc && rawPath.startsWith("@")
    ? rawPath.slice(1)
    : rawPath

  return { changePath, forceAdHoc, notes }
}

// ═══════════════════════════════════════════════════════════════════
// Workflow mode/reminder state management
// ═══════════════════════════════════════════════════════════════════
//
// In-memory state for the current active workflow mode and active
// runtime reminders. The before_agent_start hook reads this state to
// inject prompt fragments and reminders into the system prompt.
//
// State is set by command handlers and cleared when the mode/state
// ends. Exported for testability.

let _activeWorkflowMode: ModeFragment | null = null
let _activeReminders: Set<ReminderId> = new Set()

/**
 * Set the current active workflow mode.
 * The before_agent_start hook will inject the corresponding mode fragment.
 */
export function setActiveWorkflowMode(mode: ModeFragment | null): void {
  _activeWorkflowMode = mode
}

/**
 * Get the current active workflow mode.
 */
export function getActiveWorkflowMode(): ModeFragment | null {
  return _activeWorkflowMode
}

/**
 * Activate a runtime reminder. Duplicates are ignored.
 */
export function addReminder(reminder: ReminderId): void {
  _activeReminders.add(reminder)
}

/**
 * Deactivate a runtime reminder.
 */
export function removeReminder(reminder: ReminderId): void {
  _activeReminders.delete(reminder)
}

/**
 * Get all currently active reminders.
 */
export function getActiveReminders(): ReminderId[] {
  return [..._activeReminders]
}

/**
 * Clear all active reminders.
 */
export function clearReminders(): void {
  _activeReminders.clear()
}

/**
 * Reset both mode and reminders (clean slate).
 */
export function resetWorkflowState(): void {
  _activeWorkflowMode = null
  _activeReminders.clear()
}

// ═══════════════════════════════════════════════════════════════════
// Dispatch service helpers
// ═══════════════════════════════════════════════════════════════════

import type { AgentDispatchProgress, DispatchService } from "pi-zflow-core/dispatch-service"
import { DISPATCH_SERVICE_CAPABILITY } from "pi-zflow-core/dispatch-service"

const IMPLEMENT_GROUP_MAX_RETRIES = 1

type DispatchGroupResult = Awaited<ReturnType<DispatchService["runParallel"]>>["results"][number]

// ── Group status ledger types and helpers ─────────────────────────

/**
 * Status for a single group in a partial/resumable run.
 */
export type GroupLedgerStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "retrying"
  | "pending"
  | "applied"
  | "skipped"

/**
 * Semantic coupling metadata for a group.
 *
 * Describes how this group relates to other groups so users/automation
 * can assess whether applying successful groups independently is safe.
 */
export interface SemanticCoupling {
  /** Groups that must complete before this one. */
  dependsOnGroups: string[]
  /** Groups that this group blocks. */
  blocksGroups: string[]
  /** Files shared with other groups (potential conflict points). */
  sharedFiles: string[]
  /** Explanatory notes, e.g. "Coupling inferred from plan dependencies and file overlap. Not proof of independence." */
  notes: string[]
}

/**
 * Per-group entry in the durable group status ledger.
 *
 * Embedded in run.json metadata (`groupLedger` key). Updated
 * throughout the implementation workflow lifecycle.
 */
export interface GroupStatusEntry {
  /** Group identifier (e.g. "group-1"). */
  groupId: string
  /** Current status. */
  status: GroupLedgerStatus
  /** Agent assigned to this group. */
  agent: string
  /** Task prompt text for the group. */
  taskPrompt: string
  /** Files this group claims. */
  files: string[]
  /** Group dependencies from plan. */
  dependencies: string[]
  /** Semantic coupling inferred from plan metadata. */
  semanticCoupling: SemanticCoupling
  /** Result of scoped verification (if known). */
  scopedVerification?: {
    status: "pass" | "fail" | "skipped" | "missing"
    command?: string
    output?: string
  }
  /** Path to the patch artifact (if produced and captured). */
  patchPath?: string
  /** Absolute path to the worktree (if one was created). */
  worktreePath?: string
  /** Files changed by this group (if captured). */
  changedFiles?: string[]
  /** Number of retry attempts so far. */
  retryCount: number
  /** Error message if status is "failed". */
  error?: string
  /** Categorization of failure for retry policy. */
  failureKind?: "retryable" | "blocker"
  /** Whether this group's patch has been applied back to the primary. */
  appliedToPrimary: boolean
  /** ISO timestamp of last state change. */
  updatedAt: string
}

/**
 * Durable group status ledger key in run.json metadata.
 */
const GROUP_LEDGER_META_KEY = "groupLedger" as const

/**
 * Infer semantic coupling for a group from execution group data.
 *
 * Computes dependencies (explicit), reverse dependencies (groups that depend on this one),
 * and shared files (files owned by this group that also appear in other groups).
 */
function inferSemanticCoupling(
  groupId: string,
  allGroups: ReadonlyArray<{ id: string; files: string[]; dependencies: string[] }>,
): SemanticCoupling {
  const group = allGroups.find((g) => g.id === groupId)
  const dependsOnGroups = group?.dependencies ?? []

  // Groups that list this group as a dependency
  const blocksGroups = allGroups
    .filter((g) => g.dependencies.includes(groupId))
    .map((g) => g.id)

  // Shared files: files this group owns that also appear in other groups
  const groupFiles = new Set(group?.files ?? [])
  const sharedFiles = new Set<string>()
  for (const other of allGroups) {
    if (other.id === groupId) continue
    for (const file of other.files) {
      if (groupFiles.has(file)) sharedFiles.add(file)
    }
  }

  const notes: string[] = []
  if (dependsOnGroups.length > 0 || blocksGroups.length > 0) {
    notes.push("Dependency relationships are defined in the execution plan.")
  }
  if (sharedFiles.size > 0) {
    notes.push(`Shared files with other groups: ${[...sharedFiles].join(", ")}.`)
  }
  notes.push("Coupling inferred from plan dependencies and file overlap. Not proof of independence.")

  return {
    dependsOnGroups,
    blocksGroups,
    sharedFiles: [...sharedFiles],
    notes,
  }
}

/**
 * Build a durable group status ledger from execution group metadata.
 *
 * Creates the initial state and infers semantic coupling for every group.
 * If an existing run.json exists (for resume), preserves previous
 * non-failed group states.
 */
function buildGroupLedger(
  groups: ReadonlyArray<{
    id: string
    files: string[]
    dependencies: string[]
    agent?: string
    taskPrompt?: string
    scopedVerification?: string
  }>,
  existingLedger?: Record<string, GroupStatusEntry>,
): Record<string, GroupStatusEntry> {
  const ledger: Record<string, GroupStatusEntry> = {}

  for (const group of groups) {
    const existing = existingLedger?.[group.id]
    const newStatus: GroupLedgerStatus = existing
      ? existing.status === "succeeded" || existing.status === "applied" || existing.status === "skipped"
        ? existing.status
        : "queued"
      : "queued"

    ledger[group.id] = {
      groupId: group.id,
      status: newStatus,
      agent: group.agent ?? "zflow.implement-routine",
      taskPrompt: group.taskPrompt ?? "",
      files: [...group.files],
      dependencies: [...group.dependencies],
      semanticCoupling: inferSemanticCoupling(group.id, groups),
      scopedVerification: existing?.scopedVerification,
      patchPath: existing?.patchPath,
      worktreePath: existing?.worktreePath,
      changedFiles: existing?.changedFiles,
      retryCount: existing?.retryCount ?? 0,
      error: existing?.error,
      failureKind: existing?.failureKind,
      appliedToPrimary: existing?.appliedToPrimary ?? false,
      updatedAt: new Date().toISOString(),
    }
  }

  return ledger
}

/**
 * Update the group ledger embedded in run.json metadata for a run.
 *
 * Reads the current run, merges the updates into the ledger,
 * and writes back with refreshed updatedAt.
 */
async function updateGroupLedger(
  runId: string,
  groupId: string,
  updates: Partial<Omit<GroupStatusEntry, "groupId">>,
  cwd?: string,
): Promise<void> {
  const { readRun, updateRun } = await import("pi-zflow-artifacts")
  const run = await readRun(runId, cwd)
  const existingLedger = (run.metadata?.[GROUP_LEDGER_META_KEY] ?? {}) as Record<string, GroupStatusEntry>
  const existing = existingLedger[groupId] ?? {} as GroupStatusEntry
  existingLedger[groupId] = {
    ...existing,
    ...updates,
    groupId,
    updatedAt: new Date().toISOString(),
  } as GroupStatusEntry
  await updateRun(runId, {
    metadata: {
      ...(run.metadata ?? {}),
      [GROUP_LEDGER_META_KEY]: existingLedger,
    },
  } as any, cwd)
}

/**
 * Write a human-readable group status summary artifact.
 *
 * Path: `<run-dir>/group-status-summary.md`
 */
async function writeGroupStatusSummary(
  runId: string,
  changeId: string,
  cwd?: string,
): Promise<string> {
  const { default: fs } = await import("node:fs/promises")
  const { default: path } = await import("node:path")
  const { readRun } = await import("pi-zflow-artifacts")
  const { resolveRunDir } = await import("pi-zflow-artifacts/artifact-paths")

  const run = await readRun(runId, cwd)
  const ledger = (run.metadata?.[GROUP_LEDGER_META_KEY] ?? {}) as Record<string, GroupStatusEntry>
  const entries = Object.values(ledger)

  const lines: string[] = []
  const succeeded = entries.filter((e) => e.status === "succeeded" || e.status === "applied")
  const failed = entries.filter((e) => e.status === "failed")
  const running_ = entries.filter((e) => e.status === "running" || e.status === "retrying")
  const pending_ = entries.filter((e) => e.status === "queued" || e.status === "pending")

  lines.push(`# Group Status Summary — ${changeId}\n`)
  lines.push(`Run: ${runId}`)
  lines.push(`Phase: ${run.phase}`)
  lines.push(`Generated: ${new Date().toISOString()}\n`)

  lines.push(`## Overview`)
  lines.push(`- Total groups: ${entries.length}`)
  lines.push(`- Succeeded: ${succeeded.length}`)
  lines.push(`- Failed: ${failed.length}`)
  lines.push(`- In progress: ${running_.length}`)
  lines.push(`- Pending: ${pending_.length}\n`)

  if (succeeded.length > 0) {
    lines.push(`## Succeeded Groups`)
    for (const g of succeeded) {
      lines.push(`- **${g.groupId}** — ${g.agent}`)
      lines.push(`  - Files: ${g.files.join(", ")}`)
      lines.push(`  - Patch: ${g.patchPath ?? "(no patch)"}`)
      if (g.semanticCoupling.notes.length > 0) {
        for (const note of g.semanticCoupling.notes) {
          lines.push(`  - Note: ${note}`)
        }
      }
    }
    lines.push("")
  }

  if (failed.length > 0) {
    lines.push(`## Failed Groups`)
    for (const g of failed) {
      lines.push(`- **${g.groupId}** — ${g.agent}`)
      lines.push(`  - Error: ${g.error ?? "(unknown)"}`)
      lines.push(`  - Failure kind: ${g.failureKind ?? "unknown"}`)
      lines.push(`  - Retry count: ${g.retryCount}`)
      if (g.semanticCoupling.notes.length > 0) {
        for (const note of g.semanticCoupling.notes) {
          lines.push(`  - Note: ${note}`)
        }
      }
    }
    lines.push("")
  }

  if (pending_.length > 0) {
    lines.push(`## Pending Groups`)
    for (const g of pending_) {
      lines.push(`- **${g.groupId}** — ${g.agent}`)
      lines.push(`  - Status: ${g.status}`)
    }
    lines.push("")
  }

  lines.push(`## Next Steps\n`)
  if (failed.length > 0) {
    lines.push(`1. Inspect failed groups: /zflow-change-audit ${changeId}`)
    lines.push(`2. Resume failed groups: /zflow-change-implement ${changeId} --resume --failed-only`)
    lines.push(`3. Apply successful groups' patches: /zflow-change-implement ${changeId} --apply-successful`)
  } else if (entries.every((e) => e.status === "succeeded" || e.status === "applied")) {
    lines.push("All groups completed. Run final verification and code review.")
  } else {
    lines.push(`1. Resume: /zflow-change-implement ${changeId} --resume`)
  }

  const summary = lines.join("\n")
  const runDir = resolveRunDir(runId, cwd)
  const summaryPath = path.join(runDir, "group-status-summary.md")
  await fs.writeFile(summaryPath, summary, "utf-8")
  return summaryPath
}

interface FailedGroupDecision {
  groupId: string
  agent: string
  attempt: number
  decision: "retry" | "blocker"
  reason: string
  error?: string
}

// ── Partial/resume run helpers ────────────────────────────────────

/**
 * Find the latest partial or unfinished run for a change.
 *
 * Prioritises runs with phase "partial", then "executing".
 * Returns null if no unfinished run is found.
 */
async function findLatestPartialRun(
  changeId: string,
  cwd?: string,
): Promise<{ runId: string; run: Record<string, unknown> } | null> {
  const { getChangeLifecycle } = await import("pi-zflow-artifacts/state-index")
  const { readRun } = await import("pi-zflow-artifacts")

  const cl = await getChangeLifecycle(changeId, cwd)
  if (!cl || cl.unfinishedRuns.length === 0) return null

  const runIds = cl.unfinishedRuns.slice().reverse()
  for (const runId of runIds) {
    try {
      const run = await readRun(runId, cwd)
      const phase = (run as Record<string, unknown>).phase as string ?? ""
      if (phase === "partial" || phase === "executing") {
        return { runId, run: run as unknown as Record<string, unknown> }
      }
    } catch {
      continue
    }
  }

  return null
}

/**
 * Read the group ledger from a run's metadata.
 */
async function getGroupLedger(
  runId: string,
  cwd?: string,
): Promise<Record<string, GroupStatusEntry>> {
  const { readRun } = await import("pi-zflow-artifacts")
  const run = await readRun(runId, cwd)
  return (run.metadata?.[GROUP_LEDGER_META_KEY] ?? {}) as Record<string, GroupStatusEntry>
}

/**
 * Filter group ledger entries that need to be resumed (failed/pending/queued/retrying).
 */
function getResumableGroupIds(ledger: Record<string, GroupStatusEntry>): string[] {
  return Object.values(ledger)
    .filter((e) => e.status === "failed" || e.status === "pending" || e.status === "queued" || e.status === "retrying")
    .map((e) => e.groupId)
}

/**
 * Check whether a group is eligible for safe apply-back.
 *
 * Conditions:
 * - status must be "succeeded"
 * - appliedToPrimary must be false
 * - scopedVerification must exist and be "pass"
 * - patchPath must exist
 *
 * When `checkCoupling` is true (default), also reject if:
 * - sharedFiles includes any file from another group
 * - any dependency is not succeeded/applied
 */
function checkApplyEligibility(
  entry: GroupStatusEntry,
  ledger: Record<string, GroupStatusEntry>,
  checkCoupling: boolean,
): { ok: boolean; reason?: string } {
  if (entry.status !== "succeeded") {
    return { ok: false, reason: `Status is "${entry.status}", not "succeeded"` }
  }
  if (entry.appliedToPrimary) {
    return { ok: false, reason: "Already applied to primary" }
  }
  if (!entry.scopedVerification || entry.scopedVerification.status !== "pass") {
    return { ok: false, reason: "Scoped verification did not pass or is missing" }
  }
  if (!entry.patchPath) {
    return { ok: false, reason: "No patch artifact available" }
  }

  if (checkCoupling) {
    if (entry.semanticCoupling.sharedFiles.length > 0) {
      return { ok: false, reason: `Has shared files: ${entry.semanticCoupling.sharedFiles.join(", ")}` }
    }
    for (const depId of entry.dependencies) {
      const dep = ledger[depId]
      if (dep && dep.status !== "applied" && !dep.appliedToPrimary && dep.status !== "skipped") {
        return { ok: false, reason: `Dependency "${depId}" has status "${dep.status}", not applied/skipped` }
      }
    }
  }

  return { ok: true }
}

/**
 * Apply patches from successful groups back to the primary worktree.
 *
 * Returns list of groupIds that were applied.
 */
async function applySuccessfulGroupPatches(
  runId: string,
  changeId: string,
  cwd: string | undefined,
  forceCoupling: boolean,
  onProgress?: (message: string) => void,
): Promise<{ applied: string[]; errors: string[]; summaryPath: string }> {
  const { default: fs } = await import("node:fs/promises")
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const execFileAsync = promisify(execFile)

  const ledger = await getGroupLedger(runId, cwd)
  const entries = Object.values(ledger)
    .sort((a, b) => a.dependencies.length - b.dependencies.length || a.groupId.localeCompare(b.groupId))

  const applied: string[] = []
  const errors: string[] = []

  // Determine repo root
  const { resolveRunDir } = await import("pi-zflow-artifacts/artifact-paths")
  const runDir = resolveRunDir(runId, cwd)
  const { stdout: repoRootRaw } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: cwd ?? process.cwd() })
  const repoRoot = repoRootRaw.trim()

  for (const entry of entries) {
    if (entry.appliedToPrimary) {
      // If already marked applied, verify the patch file still exists
      if (entry.patchPath) {
        try {
          await fs.access(entry.patchPath)
        } catch {
          errors.push(`Group "${entry.groupId}" marked applied but patch missing at "${entry.patchPath}"`)
        }
      }
      continue
    }

    const eligibility = checkApplyEligibility(entry, ledger, !forceCoupling)
    if (!eligibility.ok) {
      errors.push(`Group "${entry.groupId}": ${eligibility.reason}`)
      continue
    }

    const patchPath = entry.patchPath!
    onProgress?.(`Applying group "${entry.groupId}" patch: ${patchPath}`)

    try {
      await execFileAsync("git", ["apply", "--3way", "--index", "--binary", patchPath], {
        cwd: repoRoot,
        timeout: 30_000,
      })
      applied.push(entry.groupId)
      ledger[entry.groupId] = {
        ...entry,
        status: "applied",
        appliedToPrimary: true,
        updatedAt: new Date().toISOString(),
      }
      await updateGroupLedger(runId, entry.groupId, {
        status: "applied",
        appliedToPrimary: true,
      }, cwd)
    } catch (applyErr: unknown) {
      const msg = applyErr instanceof Error ? applyErr.message : String(applyErr)
      errors.push(`Group "${entry.groupId}" git apply failed: ${msg}`)
    }
  }

  const { readRun, updateRun } = await import("pi-zflow-artifacts")
  const run = await readRun(runId, cwd)
  await updateRun(runId, {
    phase: "partial",
    metadata: {
      ...(run.metadata ?? {}),
      applySuccessfulResult: {
        applied: applied.length,
        errors: errors.length,
      },
    },
  } as any, cwd)

  const summaryPath = await writeGroupStatusSummary(runId, changeId, cwd).catch(() => "")
  onProgress?.(`Applied ${applied.length} group(s). ${errors.length} error(s).`)

  return { applied, errors, summaryPath }
}

/**
 * Resume a partial run by dispatching only the failed/pending/queued groups.
 *
 * Returns the updated ledger after dispatch.
 */
async function resumeWorktreeDispatch(
  runId: string,
  changeId: string,
  planVersion: string,
  dispatchService: DispatchService,
  options?: {
    cwd?: string
    force?: boolean
    onSubagentUpdate?: (id: string, update: Partial<Omit<WorkflowSubagentSnapshot, "id" | "startedAt">>) => void
  },
): Promise<void> {
  const { default: fs } = await import("node:fs/promises")
  const { default: path } = await import("node:path")
  const { parseExecutionGroupsMd } = await import("./orchestration.js")
  const {
    prepareWorktreeImplementationRun,
    finalizeWorktreeImplementationRun,
  } = await import("./orchestration.js")
  const { captureGroupResult } = await import("./group-result.js")
  const { readRun, updateRun } = await import("pi-zflow-artifacts")

  const cwd = options?.cwd ?? process.cwd()
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const execFileAsync = promisify(execFile)
  const { stdout: repoRootRaw } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd })
  const repoRoot = repoRootRaw.trim()

  // Read existing execution groups from plan artifact
  const executionGroupsArtifactPath = resolvePlanArtifactPath(changeId, planVersion, "execution-groups", cwd)
  let executionGroupsMd = ""
  try {
    executionGroupsMd = await fs.readFile(executionGroupsArtifactPath, "utf-8")
  } catch {
    throw new Error(`Cannot read execution-groups.md at: ${executionGroupsArtifactPath}`)
  }
  const allGroups = parseExecutionGroupsMd(executionGroupsMd)

  // ── Read the existing run and ledger ───────────────────────────
  const run = await readRun(runId, cwd)
  const existingLedger = (run.metadata?.[GROUP_LEDGER_META_KEY] ?? {}) as Record<string, GroupStatusEntry>

  // Filter groups to only those needing resume
  const resumableGroupIds = new Set(getResumableGroupIds(existingLedger))
  if (resumableGroupIds.size === 0) {
    throw new Error("No groups found to resume. All groups are already succeeded/applied/skipped.")
  }

  const resumeGroups = allGroups.filter((g) => resumableGroupIds.has(g.id))
  if (resumeGroups.length === 0) {
    throw new Error(
      `Resumable groups (${[...resumableGroupIds].join(", ")}) not found in execution plan. ` +
      "The plan may have changed since the original run.",
    )
  }

  // ── Prepare task plan for only the resumable groups ────────────
  const planArtifactPaths = {
    design: resolvePlanArtifactPath(changeId, planVersion, "design", cwd),
    executionGroups: executionGroupsArtifactPath,
    standards: resolvePlanArtifactPath(changeId, planVersion, "standards", cwd),
    verification: resolvePlanArtifactPath(changeId, planVersion, "verification", cwd),
  }

  const runPlan = await prepareWorktreeImplementationRun(
    changeId,
    planVersion,
    resumeGroups,
    planArtifactPaths,
    {
      cwd,
      repoRoot,
      runId,
      force: options?.force,
    },
  )

  // ── Reuse the existing worktree-results dir ────────────────────
  const { resolveRunDir } = await import("pi-zflow-artifacts/artifact-paths")
  const runDir = resolveRunDir(runId, cwd)
  const worktreeResultsDir = path.join(runDir, "worktree-results")
  await fs.mkdir(worktreeResultsDir, { recursive: true })

  const implementModel = await resolveWorkflowModel("zflow.implement-routine")
  const tasks = runPlan.tasks.map((t) => ({
    agent: t.agent,
    task: t.task,
    model: implementModel.model,
    output: path.join(worktreeResultsDir, `${t.groupId}-resume-result.md`),
    outputMode: "file-only" as const,
    onUpdate: (progress: AgentDispatchProgress) => {
      const recentTools = Array.isArray(progress.recentTools) ? progress.recentTools : []
      const recentTool = recentTools[recentTools.length - 1]
      const recentOutput = Array.isArray(progress.recentOutput) ? progress.recentOutput : []
      options?.onSubagentUpdate?.(t.groupId, {
        agent: t.agent,
        title: undefined,
        status: progress.status ?? "running",
        lastCommand: progress.currentTool
          ? `${progress.currentTool}${progress.currentToolArgs ? ` ${progress.currentToolArgs}` : ""}`
          : recentTool?.tool
            ? `${recentTool.tool}${recentTool.args ? ` ${recentTool.args}` : ""}`
            : recentOutput[recentOutput.length - 1] ?? "resume dispatching...",
      })
    },
  }))

  const WORKTREE_DISPATCH_CONCURRENCY = 6
  const MAX_OUTPUT_LINES = 5000
  const MAX_OUTPUT_BYTES = 500_000

  for (let taskIdx = 0; taskIdx < runPlan.tasks.length; taskIdx++) {
    const task = runPlan.tasks[taskIdx]!
    options?.onSubagentUpdate?.(task.groupId, {
      agent: task.agent,
      status: "running",
      lastCommand: "resume dispatching...",
    })
    await updateGroupLedger(runId, task.groupId, {
      status: "running",
      agent: task.agent,
    }, cwd).catch(() => {})
  }

  // ── Dispatch ──────────────────────────────────────────────────

  const dispatchResult = await dispatchService.runParallel({
    tasks,
    cwd,
    concurrency: WORKTREE_DISPATCH_CONCURRENCY,
    worktree: true,
    maxOutput: { lines: MAX_OUTPUT_LINES, bytes: MAX_OUTPUT_BYTES },
  })

  // ── Collect results and update ledger ─────────────────────────
  const newResults: Array<DispatchGroupResult> = [...dispatchResult.results]
  const groupResults: any[] = []
  const resumeFailures: string[] = []

  for (let idx = 0; idx < newResults.length; idx++) {
    const r = newResults[idx]!
    const group = resumeGroups[idx]
    if (!group) continue

    if (!r.ok) {
      resumeFailures.push(`${group.id}: ${r.error ?? "unknown error"}`)
      await updateGroupLedger(runId, group.id, {
        status: "failed",
        error: r.error ?? "unknown error",
        failureKind: "blocker",
        retryCount: ((existingLedger[group.id]?.retryCount ?? 0) + 1),
      }, cwd).catch(() => {})
      options?.onSubagentUpdate?.(group.id, {
        status: "failed",
        finishedAt: Date.now(),
        lastCommand: r.error ?? "resume failed",
      })
      continue
    }

    const verification = normalizeDispatchVerification(r.verification)
    if (!verification || verification.status !== "pass") {
      resumeFailures.push(`${group.id}: scoped verification ${verification?.status ?? "missing"}`)
      await updateGroupLedger(runId, group.id, {
        status: "failed",
        error: `scoped verification ${verification?.status ?? "missing"}`,
        failureKind: "blocker",
        scopedVerification: verification ?? { status: "missing" },
      }, cwd).catch(() => {})
      options?.onSubagentUpdate?.(group.id, {
        status: "failed",
        finishedAt: Date.now(),
        lastCommand: `scoped verification ${verification?.status ?? "missing"}`,
      })
      continue
    }

    // Group succeeded
    await updateGroupLedger(runId, group.id, {
      status: "succeeded",
      agent: r.agent ?? "zflow.implement-routine",
      error: undefined,
      failureKind: undefined,
      scopedVerification: { status: "pass", command: verification.command, output: verification.output },
    }, cwd).catch(() => {})
    options?.onSubagentUpdate?.(group.id, {
      status: "completed",
      finishedAt: Date.now(),
      lastCommand: "resume dispatch complete",
    })

    // Collect group result for apply-back later
    if (r.patchPath) {
      const patchesDir = path.join(runDir, "patches")
      await fs.mkdir(patchesDir, { recursive: true })
      const destPatchPath = path.join(patchesDir, `${group.id}.patch`)
      if (path.resolve(r.patchPath) !== path.resolve(destPatchPath)) {
        await fs.copyFile(r.patchPath, destPatchPath)
      }
      groupResults.push({
        groupId: group.id,
        agent: r.agent ?? "zflow.implement-routine",
        worktreePath: r.worktreePath ?? "(patch-based)",
        baseCommit: run.head as string,
        headCommit: run.head as string,
        changedFiles: r.changedFiles ?? group.files,
        uncommittedChanges: [],
        patchPath: destPatchPath,
        verification,
        retained: false,
      })
      await updateGroupLedger(runId, group.id, {
        patchPath: destPatchPath,
        changedFiles: r.changedFiles ?? group.files,
      }, cwd).catch(() => {})
    } else if (r.worktreePath) {
      const captured = await captureGroupResult({
        groupId: group.id,
        agent: r.agent ?? group.agent ?? "zflow.implement-routine",
        worktreePath: r.worktreePath,
        runId,
        repoRoot,
        scopedFiles: group.files,
        verification,
        cwd,
      })
      groupResults.push(captured)
      await updateGroupLedger(runId, group.id, {
        patchPath: captured.patchPath,
        worktreePath: captured.worktreePath,
        changedFiles: captured.changedFiles,
      }, cwd).catch(() => {})
    }
  }

  // ── Finalize — check if all groups are now complete ───────────
  const updatedLedger = await getGroupLedger(runId, cwd)
  const allSucceeded = Object.values(updatedLedger).every((e) =>
    e.status === "succeeded" || e.status === "applied" || e.status === "skipped"
  )

  if (resumeFailures.length > 0) {
    // Some resume groups still failed — update phase to partial
    await updateRun(runId, {
      phase: "partial",
      metadata: {
        ...((await readRun(runId, cwd)).metadata ?? {}),
        partialRunNote: `${resumeFailures.length} resumed group(s) failed. Successful groups preserved.`,
      },
    } as any, cwd).catch(() => {})
    await writeGroupStatusSummary(runId, changeId, cwd).catch(() => "")
    throw new Error(
      `Resume: ${resumeFailures.length} group(s) still failed: ${resumeFailures.join("; ")}`,
    )
  }

  if (allSucceeded) {
    const applyResult = await applySuccessfulGroupPatches(runId, changeId, cwd, false)
    const finalLedger = await getGroupLedger(runId, cwd)
    const allApplied = Object.values(finalLedger).every((e) => e.status === "applied" || e.status === "skipped")
    if (!allApplied) {
      throw new Error(
        `Resume completed, but not all successful groups could be applied safely. ` +
        `Applied ${applyResult.applied.length}; ${applyResult.errors.length} issue(s). ` +
        `Use /zflow-change-implement ${changeId} --apply-successful to inspect/apply, or --force-apply-successful to bypass semantic-coupling checks.`,
      )
    }
  }
}

function classifyFailedGroup(
  groupId: string,
  result: DispatchGroupResult,
  attempt: number,
  maxRetries: number = IMPLEMENT_GROUP_MAX_RETRIES,
): FailedGroupDecision {
  const error = result.error ?? "unknown error"
  const normalized = error.toLowerCase()
  const retryBudgetRemaining = attempt < maxRetries

  const blockerPatterns = [
    "unknown agent",
    "no agents discovered",
    "scoped verification failed",
    "verification failed",
    "path guard",
    "permission denied",
    "not a git repository",
  ]

  if (blockerPatterns.some((pattern) => normalized.includes(pattern))) {
    return {
      groupId,
      agent: result.agent,
      attempt,
      decision: "blocker",
      reason: "Failure is deterministic or requires user/code changes before retry.",
      error,
    }
  }

  if (!retryBudgetRemaining) {
    return {
      groupId,
      agent: result.agent,
      attempt,
      decision: "blocker",
      reason: `Retry budget exhausted after ${maxRetries} retry attempt(s).`,
      error,
    }
  }

  return {
    groupId,
    agent: result.agent,
    attempt,
    decision: "retry",
    reason: "Failure may be transient; one bounded retry is allowed.",
    error,
  }
}

async function recordDispatchFailurePolicy(
  runId: string,
  cwd: string | undefined,
  decisions: FailedGroupDecision[],
  reportPath: string,
  phase: "failed" | "partial" = "failed",
): Promise<void> {
  const { readRun, updateRun } = await import("pi-zflow-artifacts")
  const run = await readRun(runId, cwd)
  await updateRun(runId, {
    phase,
    metadata: {
      ...(run.metadata ?? {}),
      dispatchFailurePolicy: {
        maxRetries: IMPLEMENT_GROUP_MAX_RETRIES,
        reportPath,
        decisions,
      },
    },
  } as any, cwd)
}

function normalizeDispatchVerification(
  verification: DispatchGroupResult["verification"],
) {
  if (!verification) return undefined
  const status = verification.status === "passed"
    ? "pass"
    : verification.status === "failed"
      ? "fail"
      : verification.status
  return {
    status,
    command: verification.command,
    output: verification.output,
  }
}

/**
 * Try to discover and return a dispatch service from the zflow registry.
 *
 * Searches for a service exposing dispatch-like methods from any capability.
 * Returns null if no service is found.
 */
async function tryGetDispatchServiceViaRegistry(): Promise<DispatchService | null> {
  try {
    const reg = getZflowRegistry()
    // Check directly via the dedicated capability first
    if (reg.has(DISPATCH_SERVICE_CAPABILITY)) {
      const svc = reg.optional<DispatchService>(DISPATCH_SERVICE_CAPABILITY)
      if (svc && typeof svc.runAgent === "function" && typeof svc.runParallel === "function") {
        return svc
      }
    }

    // Fallback: search all capabilities for a dispatch-like service
    const capabilities = reg.getCapabilities()
    for (const [, registered] of capabilities) {
      if (registered.service === undefined) continue
      const svc = registered.service as Record<string, unknown>
      if (typeof svc.runAgent === "function" && typeof svc.runParallel === "function") {
        return svc as unknown as DispatchService
      }
    }

    return null
  } catch {
    return null
  }
}

/**
 * Run worktree dispatch using the provided dispatch service, then finalize.
 *
 * Reads execution-groups.md, calls prepareWorktreeImplementationRun(),
 * dispatches via dispatchService.runParallel({ worktree: true, ... }),
 * collects GroupResults, and calls finalizeWorktreeImplementationRun().
 */
async function runWorktreeDispatchAndFinalize(
  runId: string,
  changeId: string,
  planVersion: string,
  dispatchService: DispatchService,
  options?: {
    cwd?: string
    force?: boolean
    onWorkflowUpdate?: (message: string) => void
    onSubagentUpdate?: (id: string, update: Partial<Omit<WorkflowSubagentSnapshot, "id" | "startedAt">>) => void
  },
): Promise<void> {
  const { default: fs } = await import("node:fs/promises")
  const { default: path } = await import("node:path")
  const { parseExecutionGroupsMd } = await import("./orchestration.js")
  const {
    prepareWorktreeImplementationRun,
    finalizeWorktreeImplementationRun,
  } = await import("./orchestration.js")
  const { captureGroupResult } = await import("./group-result.js")
  const { readRun, updateRun } = await import("pi-zflow-artifacts")

  const cwd = options?.cwd ?? process.cwd()
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const execFileAsync = promisify(execFile)
  const { stdout: repoRootRaw } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd })
  const repoRoot = repoRootRaw.trim()

  // Read execution groups from the approved plan artifact
  const executionGroupsArtifactPath = resolvePlanArtifactPath(changeId, planVersion, "execution-groups", cwd)
  let executionGroupsMd = ""
  try {
    executionGroupsMd = await fs.readFile(executionGroupsArtifactPath, "utf-8")
  } catch {
    throw new Error(
      `Cannot read execution-groups.md at: ${executionGroupsArtifactPath}\n` +
      "Run /zflow-change-prepare to create plan artifacts first.",
    )
  }

  const groups = parseExecutionGroupsMd(executionGroupsMd)

  if (groups.length === 0) {
    throw new Error(
      `No execution groups found in ${executionGroupsArtifactPath}. ` +
      "The approved plan must contain at least one implementation group.",
    )
  }

  const missingScopedVerification = groups.filter((g) => !g.scopedVerification)
  if (missingScopedVerification.length > 0) {
    throw new Error(
      "Cannot dispatch implementation: every execution group must define scoped verification. " +
      `Missing: ${missingScopedVerification.map((g) => g.id).join(", ")}`,
    )
  }

  // Prepare the worktree implementation run — this runs clean-tree preflight,
  // ownership/dependency validation, and builds task descriptors.
  const planArtifactPaths = {
    design: resolvePlanArtifactPath(changeId, planVersion, "design", cwd),
    executionGroups: executionGroupsArtifactPath,
    standards: resolvePlanArtifactPath(changeId, planVersion, "standards", cwd),
    verification: resolvePlanArtifactPath(changeId, planVersion, "verification", cwd),
  }

  const runPlan = await prepareWorktreeImplementationRun(
    changeId,
    planVersion,
    groups,
    planArtifactPaths,
    { cwd, repoRoot, runId, force: options?.force },
  )

  // ── Initialize durable group status ledger ────────────────────
  const runBefore = await readRun(runId, cwd)
  const existingLedger = runBefore?.metadata?.[GROUP_LEDGER_META_KEY] as Record<string, GroupStatusEntry> | undefined
  const ledger = buildGroupLedger(groups, existingLedger)
  await updateRun(runId, {
    metadata: {
      ...(runBefore?.metadata ?? {}),
      [GROUP_LEDGER_META_KEY]: ledger,
    },
  } as any, cwd)

  // Dispatch via the dispatch service with worktree: true. Keep worker output
  // under runtime state so repo roots are not polluted with worktree-results/.
  const runDir = resolveRunDir(runId, cwd)
  const worktreeResultsDir = path.join(runDir, "worktree-results")
  await fs.mkdir(worktreeResultsDir, { recursive: true })
  const implementModel = await resolveWorkflowModel("zflow.implement-routine")
  const tasks = runPlan.tasks.map((t, taskIdx) => ({
    agent: t.agent,
    task: t.task,
    model: implementModel.model,
    output: path.join(worktreeResultsDir, `${t.groupId}-result.md`),
    outputMode: "file-only" as const,
    onUpdate: (progress: AgentDispatchProgress) => {
      const recentTools = Array.isArray(progress.recentTools) ? progress.recentTools : []
      const recentTool = recentTools[recentTools.length - 1]
      const recentOutput = Array.isArray(progress.recentOutput) ? progress.recentOutput : []
      options?.onSubagentUpdate?.(t.groupId, {
        agent: t.agent,
        title: runPlan.groups[taskIdx]?.taskPrompt ?? undefined,
        model: implementModel.model ?? "unavailable",
        thinking: implementModel.thinking ?? "unavailable",
        status: progress.status ?? "running",
        lastCommand: progress.currentTool
          ? `${progress.currentTool}${progress.currentToolArgs ? ` ${progress.currentToolArgs}` : ""}`
          : recentTool?.tool
            ? `${recentTool.tool}${recentTool.args ? ` ${recentTool.args}` : ""}`
            : recentOutput[recentOutput.length - 1] ?? "running",
      })
    },
  }))

  const WORKTREE_DISPATCH_CONCURRENCY = 6
  const MAX_OUTPUT_LINES = 5000
  const MAX_OUTPUT_BYTES = 500_000

  for (let taskIdx = 0; taskIdx < runPlan.tasks.length; taskIdx++) {
    const task = runPlan.tasks[taskIdx]!
    const initiallyScheduled = taskIdx < WORKTREE_DISPATCH_CONCURRENCY
    options?.onSubagentUpdate?.(task.groupId, {
      agent: task.agent,
      title: runPlan.groups[taskIdx]?.taskPrompt ?? undefined,
      model: implementModel.model ?? "unavailable",
      thinking: implementModel.thinking ?? "unavailable",
      status: initiallyScheduled ? "running" : "queued",
      lastCommand: initiallyScheduled ? "starting worktree dispatch..." : "queued waiting for dispatch slot",
    })
    await updateGroupLedger(runId, task.groupId, {
      status: initiallyScheduled ? "running" : "queued",
      agent: task.agent,
    }, cwd).catch(() => {})
  }

  const dispatchResult = await dispatchService.runParallel({
    tasks,
    cwd,
    concurrency: WORKTREE_DISPATCH_CONCURRENCY,
    worktree: true,
    maxOutput: { lines: MAX_OUTPUT_LINES, bytes: MAX_OUTPUT_BYTES },
  })

  // Classify results: successful groups go into collected; failures are classified
  // as retryable or blocker. Retryable groups get one bounded re-run via runParallel
  // (not sequential runAgent) so multiple retries run concurrently.
  const decisions: FailedGroupDecision[] = []
  const allResults: Array<DispatchGroupResult> = [...dispatchResult.results]

  for (let idx = 0; idx < allResults.length; idx++) {
    const result = allResults[idx]!
    const task = runPlan.tasks[idx]
    if (result.ok) {
      options?.onSubagentUpdate?.(task?.groupId ?? `group-${idx}`, {
        agent: result.agent,
        title: runPlan.groups[idx]?.taskPrompt ?? undefined,
        status: "completed",
        finishedAt: Date.now(),
        lastCommand: "dispatch complete",
      })
      // Update ledger: group succeeded
      const gId = task?.groupId ?? runPlan.groups[idx]?.id ?? `group-${idx}`
      await updateGroupLedger(runId, gId, {
        status: "succeeded",
        agent: result.agent ?? "zflow.implement-routine",
        error: undefined,
        failureKind: undefined,
      }, cwd).catch(() => {})
    }
  }

  const failedIndices: number[] = []
  for (let idx = 0; idx < allResults.length; idx++) {
    if (!allResults[idx]!.ok) failedIndices.push(idx)
  }

  if (failedIndices.length > 0) {
    // ── Phase 1: classify every failed group immediately so UI shows honest state
    const retryIndices: number[] = []
    const retryDecisionIndices: number[] = []
    for (const idx of failedIndices) {
      const result = allResults[idx]!
      const group = runPlan.groups[idx]
      const decision = classifyFailedGroup(group?.id ?? `group-${idx}`, result, 0, IMPLEMENT_GROUP_MAX_RETRIES)
      decisions.push(decision)

      if (decision.decision === "retry") {
        retryIndices.push(idx)
        retryDecisionIndices.push(decisions.length - 1)
        const task = runPlan.tasks[idx]!
        options?.onSubagentUpdate?.(task.groupId, {
          agent: result.agent,
          title: group?.taskPrompt ?? undefined,
          status: "retry",
          finishedAt: undefined,
          startedAt: Date.now(),
          lastCommand: "scheduling retry...",
        })
        // Update ledger: group retrying
        const gId = group?.id ?? task.groupId ?? `group-${idx}`
        await updateGroupLedger(runId, gId, {
          status: "retrying",
          retryCount: 1,
          error: undefined,
          failureKind: "retryable",
        }, cwd).catch(() => {})
      } else {
        const gId = group?.id ?? `group-${idx}`
        options?.onSubagentUpdate?.(runPlan.tasks[idx]?.groupId ?? gId, {
          agent: result.agent,
          title: group?.taskPrompt ?? undefined,
          status: "failed",
          finishedAt: Date.now(),
          lastCommand: decision.reason,
        })
        // Update ledger: group failed (blocker)
        await updateGroupLedger(runId, gId, {
          status: "failed",
          error: decision.error ?? decision.reason,
          failureKind: "blocker",
          retryCount: 0,
        }, cwd).catch(() => {})
      }
    }

    // ── Phase 2: dispatch all retries in parallel (not one-at-a-time)
    // IMPORTANT: retries run WITHOUT worktree isolation (matching the original
    // runAgent behaviour). The initial dispatch already created worktrees for
    // these groups; creating new ones would fail because git rejects duplicate
    // worktree paths. Running retries in the main working directory lets the
    // agent access the full repo and retry the implementation from scratch.
    if (retryIndices.length > 0) {
      const retryTasks = retryIndices.map((idx) => {
        const task = runPlan.tasks[idx]!
        const group = runPlan.groups[idx]
        return {
          agent: task.agent,
          task: task.task,
          model: implementModel.model,
          output: path.join(worktreeResultsDir, `${task.groupId}-retry-result.md`),
          outputMode: "file-only" as const,
          onUpdate: (progress: AgentDispatchProgress) => {
            const recentTools = Array.isArray(progress.recentTools) ? progress.recentTools : []
            const recentTool = recentTools[recentTools.length - 1]
            const recentOutput = Array.isArray(progress.recentOutput) ? progress.recentOutput : []
            options?.onSubagentUpdate?.(task.groupId, {
              agent: task.agent,
              title: group?.taskPrompt ?? undefined,
              model: implementModel.model ?? "unavailable",
              thinking: implementModel.thinking ?? "unavailable",
              status: progress.status ?? "running",
              lastCommand: progress.currentTool
                ? `${progress.currentTool}${progress.currentToolArgs ? ` ${progress.currentToolArgs}` : ""}`
                : recentTool?.tool
                  ? `${recentTool.tool}${recentTool.args ? ` ${recentTool.args}` : ""}`
                  : recentOutput[recentOutput.length - 1] ?? "retrying...",
            })
          },
        }
      })

      let retryDispatchResult: Awaited<ReturnType<DispatchService["runParallel"]>>
      try {
        retryDispatchResult = await dispatchService.runParallel({
          tasks: retryTasks,
          cwd,
          concurrency: WORKTREE_DISPATCH_CONCURRENCY,
          maxOutput: { lines: MAX_OUTPUT_LINES, bytes: MAX_OUTPUT_BYTES },
        })
      } catch (retryDispatchErr: unknown) {
        // If the parallel retry dispatch itself throws, treat every retry as a blocker
        const errMsg = retryDispatchErr instanceof Error ? retryDispatchErr.message : String(retryDispatchErr)
        for (let rIdx = 0; rIdx < retryIndices.length; rIdx++) {
          const originalIdx = retryIndices[rIdx]!
          const decisionIdx = retryDecisionIndices[rIdx]!
          const group = runPlan.groups[originalIdx]
          const task = runPlan.tasks[originalIdx]!
          decisions[decisionIdx] = {
            ...decisions[decisionIdx]!,
            decision: "blocker",
            reason: `Retry dispatch threw: ${errMsg}`,
          }
          options?.onSubagentUpdate?.(task.groupId, {
            agent: task.agent,
            title: group?.taskPrompt ?? undefined,
            status: "failed",
            finishedAt: Date.now(),
            lastCommand: `retry dispatch threw: ${errMsg}`,
          })
          await updateGroupLedger(runId, group?.id ?? task.groupId, {
            status: "failed",
            error: `Retry dispatch threw: ${errMsg}`,
            failureKind: "blocker",
            retryCount: 1,
          }, cwd).catch(() => {})
        }
        // Fall through to blocker check below
        retryDispatchResult = { ok: false, results: [] }
      }

      // ── Phase 3: map retry results back to original indices.
      // Guard against result/expectation length mismatches — if the backend
      // returned fewer results than tasks (e.g. internal error), mark every
      // unmapped retry as a blocker so it doesn't silently hang.
      const mappedSet = new Set<number>()
      for (let rIdx = 0; rIdx < retryDispatchResult.results.length; rIdx++) {
        const originalIdx = retryIndices[rIdx]
        const decisionIdx = retryDecisionIndices[rIdx]
        if (originalIdx === undefined || decisionIdx === undefined) continue
        mappedSet.add(rIdx)
        const group = runPlan.groups[originalIdx]
        const task = runPlan.tasks[originalIdx]!
        const rResult = retryDispatchResult.results[rIdx]!
        const mappedResult: DispatchGroupResult = {
          ...rResult,
          agent: rResult.agent ?? task.agent,
        }
        allResults[originalIdx] = mappedResult

        if (rResult.ok) {
          decisions[decisionIdx] = { ...decisions[decisionIdx]!, decision: "retry", reason: "Retry succeeded." }
          options?.onSubagentUpdate?.(task.groupId, {
            agent: rResult.agent ?? task.agent,
            title: group?.taskPrompt ?? undefined,
            status: "completed",
            finishedAt: Date.now(),
            lastCommand: "retry dispatch complete",
          })
          // Update ledger: retry succeeded
          await updateGroupLedger(runId, group?.id ?? task.groupId, {
            status: "succeeded",
            agent: rResult.agent ?? task.agent,
            error: undefined,
            failureKind: undefined,
          }, cwd).catch(() => {})
        } else {
          decisions[decisionIdx] = classifyFailedGroup(group?.id ?? `group-${originalIdx}`, mappedResult, 1, IMPLEMENT_GROUP_MAX_RETRIES)
          options?.onSubagentUpdate?.(task.groupId, {
            agent: rResult.agent ?? task.agent,
            title: group?.taskPrompt ?? undefined,
            status: "failed",
            finishedAt: Date.now(),
            lastCommand: rResult.error ?? "retry failed",
          })
          // Update ledger: retry failed
          await updateGroupLedger(runId, group?.id ?? task.groupId, {
            status: "failed",
            error: rResult.error ?? "retry failed",
            failureKind: "blocker",
            retryCount: 1,
          }, cwd).catch(() => {})
        }
      }

      // Mark any retries that weren't mapped (backend returned fewer results)
      for (let rIdx = 0; rIdx < retryIndices.length; rIdx++) {
        if (mappedSet.has(rIdx)) continue
        const originalIdx = retryIndices[rIdx]!
        const decisionIdx = retryDecisionIndices[rIdx]!
        const group = runPlan.groups[originalIdx]
        const task = runPlan.tasks[originalIdx]!
        decisions[decisionIdx] = {
          ...decisions[decisionIdx]!,
          decision: "blocker",
          reason: `Retry produced no result for ${group?.id ?? `group-${originalIdx}`} — backend may have crashed`,
        }
        options?.onSubagentUpdate?.(task.groupId, {
          agent: task.agent,
          title: group?.taskPrompt ?? undefined,
          status: "failed",
          finishedAt: Date.now(),
          lastCommand: "retry produced no result — backend may have crashed",
        })
        await updateGroupLedger(runId, group?.id ?? task.groupId, {
          status: "failed",
          error: "Retry produced no result — backend may have crashed",
          failureKind: "blocker",
          retryCount: 1,
        }, cwd).catch(() => {})
      }
    }
  }

  const blockers = decisions.filter((d) => d.decision === "blocker")
  if (blockers.length > 0) {
    const reportPath = path.join(worktreeResultsDir, "failure-report.json")
    await fs.writeFile(reportPath, JSON.stringify({ decisions, allResults: allResults.map(r => ({ agent: r.agent, ok: r.ok, error: r.error })) }, null, 2))

    // ── Write group-status-summary and update phase to partial ──
    // Even though some groups failed, preserve succeeded group data
    // so the user can resume or apply successful groups independently.
    const summaryPath = await writeGroupStatusSummary(runId, changeId, cwd).catch(() => reportPath)
    await updateRun(runId, {
      phase: "partial",
      metadata: {
        ...((await readRun(runId, cwd)).metadata ?? {}),
        partialRunNote: `${blockers.length} group(s) failed. Successful groups preserved. Use --resume to retry failed groups or --apply-successful to apply successful groups.`,
        groupStatusSummaryPath: summaryPath,
      },
    } as any, cwd)

    await recordDispatchFailurePolicy(runId, cwd, decisions, reportPath, "partial")
    throw new Error(
      `${blockers.length} group(s) could not be dispatched after ${IMPLEMENT_GROUP_MAX_RETRIES} retry: ` +
      blockers.map((d) => `${d.groupId}: ${d.reason}`).join("; ") +
      `\nFailure report: ${reportPath}` +
      `\nGroup status summary: ${summaryPath}`,
    )
  }

  options?.onWorkflowUpdate?.("All subagents finished; validating scoped verification and collecting worktree results")

  // Collect group results from dispatch outputs
  const groupResults = []
  const postDispatchFailures: string[] = []
  const patchesDir = path.join(runDir, "patches")
  await fs.mkdir(patchesDir, { recursive: true })

  for (let idx = 0; idx < allResults.length; idx++) {
    const r = allResults[idx]!
    const group = groups[idx]
    if (!group) continue

    if (!r.ok) {
      continue
    }

    const verification = normalizeDispatchVerification(r.verification)

    if (!verification || verification.status !== "pass") {
      const vStatus = verification?.status ?? "missing"
      const failure = `${group.id}: scoped verification ${vStatus}`
      postDispatchFailures.push(failure)
      options?.onSubagentUpdate?.(group.id, {
        status: "failed",
        finishedAt: Date.now(),
        lastCommand: failure,
      })
      // Update ledger: scoped verification failed
      await updateGroupLedger(runId, group.id, {
        status: "failed",
        error: failure,
        failureKind: "blocker",
        scopedVerification: verification ?? { status: "missing" },
      }, cwd).catch(() => {})
      continue
    }

    if (r.worktreePath) {
      groupResults.push(await captureGroupResult({
        groupId: group.id,
        agent: tasks[idx]?.agent ?? group.agent ?? "unknown",
        worktreePath: r.worktreePath,
        runId,
        repoRoot,
        scopedFiles: group.files,
        verification,
        cwd,
      }))
      // Update ledger: capture patch/changedFiles data
      await updateGroupLedger(runId, group.id, {
        worktreePath: r.worktreePath,
        changedFiles: r.changedFiles ?? group.files,
        scopedVerification: verification ?? { status: "pass" },
      }, cwd).catch(() => {})
      continue
    }

    if (r.patchPath) {
      const destPatchPath = path.join(patchesDir, `${group.id}.patch`)
      if (path.resolve(r.patchPath) !== path.resolve(destPatchPath)) {
        await fs.copyFile(r.patchPath, destPatchPath)
      }

      const run = await readRun(runId, cwd)
      const groupMeta = {
        groupId: group.id,
        agent: tasks[idx]?.agent ?? group.agent ?? "unknown",
        worktreePath: r.worktreePath ?? "(provided patch)",
        baseCommit: run.head,
        headCommit: run.head,
        changedFiles: r.changedFiles ?? group.files,
        uncommittedChanges: [],
        patchPath: destPatchPath,
        scopedVerification: {
          status: verification.status,
          command: verification.command,
          output: verification.output,
        },
        retained: false,
      }
      const existingIndex = run.groups.findIndex((g) => g.groupId === group.id)
      if (existingIndex >= 0) run.groups[existingIndex] = groupMeta
      else run.groups.push(groupMeta)
      await updateRun(runId, { groups: run.groups }, cwd)
      groupResults.push({
        groupId: group.id,
        agent: groupMeta.agent,
        worktreePath: groupMeta.worktreePath,
        baseCommit: groupMeta.baseCommit,
        headCommit: groupMeta.headCommit,
        changedFiles: groupMeta.changedFiles,
        uncommittedChanges: [],
        patchPath: destPatchPath,
        verification,
        retained: false,
      })
      // Update ledger: capture patch/changedFiles data
      await updateGroupLedger(runId, group.id, {
        patchPath: destPatchPath,
        changedFiles: r.changedFiles ?? group.files,
        scopedVerification: { status: "pass", command: verification.command, output: verification.output },
      }, cwd).catch(() => {})
      continue
    }

    // Fallback: dispatch ran without worktree isolation (e.g. because the
    // backend's worktree path is broken). The agent made changes directly in
    // the working directory. Record the group as completed in-place — the
    // apply-back step will skip it (no patch file to apply) and verification
    // will run against the working directory.
    const run = await readRun(runId, cwd)
    const groupMeta = {
      groupId: group.id,
      agent: tasks[idx]?.agent ?? group.agent ?? "unknown",
      worktreePath: "(in-place — no worktree isolation)",
      baseCommit: run.head,
      headCommit: run.head,
      changedFiles: r.changedFiles ?? group.files,
      uncommittedChanges: [],
      patchPath: undefined as string | undefined,
      scopedVerification: {
        status: verification.status,
        command: verification.command,
        output: verification.output,
      },
      retained: false,
    }
    const existingIndex = run.groups.findIndex((g) => g.groupId === group.id)
    if (existingIndex >= 0) run.groups[existingIndex] = groupMeta
    else run.groups.push(groupMeta)
    await updateRun(runId, { groups: run.groups }, cwd)
    // Update ledger: capture changedFiles data for fallback path
    await updateGroupLedger(runId, group.id, {
      changedFiles: r.changedFiles ?? group.files,
      scopedVerification: { status: "pass", command: verification.command, output: verification.output },
    }, cwd).catch(() => {})
    groupResults.push({
      groupId: group.id,
      agent: groupMeta.agent,
      worktreePath: groupMeta.worktreePath,
      baseCommit: groupMeta.baseCommit,
      headCommit: groupMeta.headCommit,
      changedFiles: groupMeta.changedFiles,
      uncommittedChanges: [],
      patchPath: undefined,
      verification,
      retained: false,
    })
  }

  if (postDispatchFailures.length > 0) {
    const reportPath = path.join(worktreeResultsDir, "post-dispatch-failure-report.json")
    await fs.writeFile(reportPath, JSON.stringify({ failures: postDispatchFailures }, null, 2), "utf-8")
    // Write group-status-summary and update phase to partial
    const summaryPath = await writeGroupStatusSummary(runId, changeId, cwd).catch(() => reportPath)
    await updateRun(runId, {
      phase: "partial",
      metadata: {
        ...((await readRun(runId, cwd)).metadata ?? {}),
        partialRunNote: `${postDispatchFailures.length} group(s) failed post-dispatch validation. Successful groups preserved. Use --resume to retry failed groups.`,
        groupStatusSummaryPath: summaryPath,
      },
    } as any, cwd)
    await recordDispatchFailurePolicy(runId, cwd, postDispatchFailures.map((failure) => ({
      groupId: failure.split(":", 1)[0] ?? "unknown",
      agent: "zflow.implement-routine",
      attempt: 0,
      decision: "blocker" as const,
      reason: failure,
      error: failure,
    })), reportPath, "partial")
    throw new Error(
      `${postDispatchFailures.length} group(s) failed post-dispatch validation: ` +
      postDispatchFailures.join("; ") +
      `\nFailure report: ${reportPath}` +
      `\nGroup status summary: ${summaryPath}`,
    )
  }

  options?.onWorkflowUpdate?.("Applying completed group patches back to the primary worktree")

  // Finalize: apply patches back, check deviations
  await finalizeWorktreeImplementationRun(
    runId,
    groupResults,
    {
      cwd,
      changeId,
      planVersion,
      executionGroups: groups,
    },
  )

  for (const result of groupResults) {
    await updateGroupLedger(runId, result.groupId, {
      status: "applied",
      appliedToPrimary: true,
      patchPath: result.patchPath,
      worktreePath: result.worktreePath,
      changedFiles: result.changedFiles,
      scopedVerification: {
        status: result.verification.status,
        command: result.verification.command,
        output: result.verification.output,
      },
    }, cwd).catch(() => {})
  }
  await writeGroupStatusSummary(runId, changeId, cwd).catch(() => "")

  options?.onWorkflowUpdate?.("Apply-back complete; dispatch artifacts are ready for final verification")

  console.info(
    `[zflow] Worktree dispatch completed via "${dispatchService.name}". ` +
    `${dispatchResult.results.filter(r => r.ok).length}/${dispatchResult.results.length} groups succeeded.`,
  )
}

// Profile preflight helper
// ═══════════════════════════════════════════════════════════════════

/**
 * Attempt to resolve the active profile via the registry's profile
 * service.  This is the first step in both prepare and implement
 * workflows (Phase 7, Profile.ensureResolved()).
 *
 * @returns true if profile was resolved, false if no service is
 *          available (workflow may proceed advisory-only).
 * @throws never — errors are reported via ui and return false.
 */
async function ensureProfileResolved(ctx: InterviewableContext): Promise<boolean> {
  const notify = ctx.ui?.notify ?? (() => {})
  const reg = getZflowRegistry()
  if (reg.has("profiles")) {
    const profileService = reg.optional<{ ensureResolved?: (...args: unknown[]) => Promise<unknown> }>("profiles")
    if (profileService && typeof profileService.ensureResolved === "function") {
      try {
        // Convert the Pi model registry if available, so lane-health preflight
        // can check real model availability and authentication.
        let options: Record<string, unknown> = {}
        if (ctx.cwd) {
          options.repoRoot = ctx.cwd
        }
        if (ctx.modelRegistry) {
          const { createPiModelRegistryAdapter } = await import("pi-zflow-profiles")
          options.registry = createPiModelRegistryAdapter(ctx.modelRegistry)
        }
        await profileService.ensureResolved(undefined, options)
        notify("✅ Profile resolved.", "info")
        return true
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        notify(
          `⚠️ Profile service available but ensureResolved() failed: ${message}. ` +
          "Proceeding without explicit profile — verification command detection may be used.",
          "warning",
        )
        // Advisory-only; workflow may still proceed.
        return false
      }
    }
  }
  notify(
    "ℹ️ No profile service found in registry. Proceeding without explicit profile. " +
    (ctx.modelRegistry
      ? "Run /zflow-profile default to resolve a profile with lane-health checks."
      : "Run a profile setup command first or configure via pi-zflow-profiles. ") +
    "Verification will fall back to auto-detection.",
    "info",
  )
  return false
}

async function resolveWorkflowModel(agentName: string): Promise<{ model?: string; thinking?: string }> {
  try {
    const { getResolvedAgentBinding, getResolvedLane } = await import("pi-zflow-profiles")
    const binding = await getResolvedAgentBinding(agentName)
    const lane = binding?.lane ? await getResolvedLane(binding.lane) : null
    return {
      model: binding?.resolvedModel ?? undefined,
      thinking: lane?.thinking ?? undefined,
    }
  } catch {
    return {}
  }
}

// ── Extension activation ────────────────────────────────────────

const CHANGE_WORKFLOWS_CAPABILITY = "change-workflows" as const

export default function activateZflowChangeWorkflowsExtension(pi: ExtensionAPI): void {
  const registry = getZflowRegistry()

  // ── Capability claim (guards against duplicate loads) ──────────
  const claim: CapabilityClaim = {
    capability: CHANGE_WORKFLOWS_CAPABILITY,
    version: PI_ZFLOW_CHANGE_WORKFLOWS_VERSION,
    provider: "pi-zflow-change-workflows",
    sourcePath: import.meta.url,
    compatibilityMode: "compatible",
  }

  const registered = registry.claim(claim)

  // If claim returns null, an incompatible provider already owns this
  // capability — do not register anything.
  if (!registered) {
    return
  }

  // If the capability already has a service, another compatible
  // instance already initialised fully. No-op to avoid duplicate
  // command registration.
  if (registered.service !== undefined) {
    return
  }

  // Provide a minimal service marker so duplicate loads see service !== undefined
  registry.provide(CHANGE_WORKFLOWS_CAPABILITY, { activated: true })
  registerWorkflowProgressRenderer(pi)

  // ── Agent setup check ─────────────────────────────────────────
  // Check if the zflow-agents capability is available via registry.
  // If not, emit a one-time warning that setup hasn't been run yet.
  let agentsSetupChecked = false
  try {
    if (registry.has("agents")) {
      agentsSetupChecked = true
    }
  } catch {
    // Registry not available — skip check
  }

  // ── Tool call interception: path guard ───────────────────────
  // Intercept write/edit tool calls to enforce path guard policy.
  // Intercept bash commands to block destructive operations when
  // inappropriate (e.g. planning mode).
  const homeDir = typeof process !== "undefined"
    ? (process.env.HOME || process.env.USERPROFILE || "/home/user")
    : "/home/user"

  pi.on("tool_call", async (event, ctx) => {
    const { isToolCallEventType } = await import("@earendil-works/pi-coding-agent")

    // ── Guard "write" and "edit" tool calls ───────────────────
    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      // Determine the target path from the tool input
      let targetPath = ""
      if (isToolCallEventType("write", event)) {
        targetPath = event.input.path ?? ""
      } else if (isToolCallEventType("edit", event)) {
        targetPath = event.input.path ?? ""
      }

      if (!targetPath) return // no path to check

      // Resolve project root
      let projectRoot = process.cwd()
      try {
        const { execSync } = await import("node:child_process")
        projectRoot = execSync("git rev-parse --show-toplevel", {
          cwd: process.cwd(),
          encoding: "utf-8",
          timeout: 5_000,
        }).trim()
      } catch {
        // Not in a git repo — use cwd as project root
      }

      const options: GuardOptions = {
        projectRoot,
        runtimeStateDir: resolveRuntimeStateDir(process.cwd()),
      }

      const result = guardWrite(targetPath, options)

      if (!result.allowed) {
        const reminder = buildToolDeniedReminder(result)
        return { block: true, reason: reminder }
      }
    }

    // ── Guard "bash" tool calls ───────────────────────────────
    if (isToolCallEventType("bash", event)) {
      const command = event.input.command ?? ""

      // Resolve project root
      let projectRoot = process.cwd()
      try {
        const { execSync } = await import("node:child_process")
        projectRoot = execSync("git rev-parse --show-toplevel", {
          cwd: process.cwd(),
          encoding: "utf-8",
          timeout: 5_000,
        }).trim()
      } catch {
        // Not in a git repo — use cwd as project root
      }

      const options: GuardOptions = {
        projectRoot,
        runtimeStateDir: resolveRuntimeStateDir(process.cwd()),
      }

      const result = guardBashCommand(command, options)

      if (!result.allowed) {
        const reminder = buildToolDeniedReminder(result)
        return { block: true, reason: reminder }
      }
    }
  })

  // ── before_agent_start hook: inject mode fragments and reminders ──

  pi.on("before_agent_start", async (event) => {
    const mode = getActiveWorkflowMode()
    const reminders = getActiveReminders()
    if (!mode && reminders.length === 0) {
      return // nothing to inject
    }

    let injections: string[] = []

    // Inject the current mode fragment (e.g. change-prepare, change-implement)
    if (mode) {
      const modeText = await buildModeInjection(mode)
      if (modeText) {
        injections.push(modeText)
      }
    }

    // Inject active runtime reminders
    if (reminders.length > 0) {
      const reminderText = await buildReminderInjection(reminders)
      if (reminderText) {
        injections.push(reminderText)
      }
    }

    if (injections.length === 0) {
      return
    }

    // Append injections to the system prompt
    return {
      systemPrompt: event.systemPrompt + "\n\n" + injections.join("\n\n"),
    }
  })

  // ── Command: /zflow-clean ─────────────────────────────────────

  pi.registerCommand("zflow-clean", {
    description: "Clean stale runtime artifacts, orphaned worktrees, and expired metadata",
    handler: async (args: string, ctx: InterviewableContext): Promise<void> => {
      // Parse arguments
      const parts = args.trim().split(/\s+/)
      const options: CleanWorkflowOptions = {}
      let targetInput = ""
      for (let i = 0; i < parts.length; i++) {
        if (!parts[i]) continue
        switch (parts[i]) {
          case "--dry-run":
            options.dryRun = true
            break
          case "--abandon":
            options.abandonUnfinished = true
            break
          case "--orphans":
            options.orphans = true
            break
          case "--older-than":
            i++
            if (i < parts.length) {
              options.olderThan = parseInt(parts[i], 10)
              if (isNaN(options.olderThan)) {
                ctx.ui.notify(`Invalid --older-than value: ${parts[i]}`, "error")
                return
              }
            }
            break
          default:
            if (parts[i].startsWith("--")) {
              ctx.ui.notify(`Unknown option: ${parts[i]}`, "warning")
            } else {
              targetInput = targetInput ? `${targetInput} ${parts[i]}` : parts[i]
            }
            break
        }
      }

      if (targetInput) {
        const target = await resolveChangeImplementTarget(targetInput)
        options.changeId = target.changeId
        options.abandonUnfinished = true
        if (target.manifestPath && target.durableChangeId && target.durableChangeId !== target.changeId) {
          ctx.ui.notify(
            `🧹 Resolved durable change docs "${target.durableChangeId}" to runtime plan "${target.changeId}" for cleanup.`,
            "info",
          )
        }
      }

      const cleanProgress = createWorkflowProgressIndicator(pi, ctx, targetInput || "all", {
        command: "zflow-clean",
        model: undefined,
        initialMessage: options.dryRun ? "Dry-run cleanup preview" : "Running cleanup",
        statusId: "zflow-clean",
        widgetId: "zflow-clean-progress",
      })

      try {
        const result = await runCleanWorkflow(options)

        cleanProgress.update(result.summary)
        if (result.abandonedRuns.length > 0) {
          cleanProgress.update(
            `${options.dryRun ? "Would abandon" : "Abandoned"} ${result.abandonedRuns.length} unfinished run(s): ${result.abandonedRuns.join(", ")}`,
          )
        } else if (options.changeId && options.abandonUnfinished) {
          cleanProgress.update(`No unfinished runs found for change "${options.changeId}".`)
        }

        cleanProgress.stop(
          options.dryRun
            ? `Preview: ${result.cleaned} artifact(s) would be cleaned, ${result.kept} kept.`
            : result.errors.length > 0
              ? `Cleaned ${result.cleaned} artifact(s). ${result.errors.length} error(s) occurred.`
              : `Cleaned ${result.cleaned} artifact(s).`,
        )
      } catch (err: unknown) {
        cleanProgress.stop(
          `Cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
          "failed",
        )
      }
    },
  })

  // ── Command: /zflow-change-prepare ────────────────────────────

  pi.registerCommand("zflow-change-prepare", {
    description: "Run the formal change preparation workflow for a given change path or RuneContext",
    handler: async (args: string, ctx: InterviewableContext): Promise<void> => {
      const parsedArgs = parseChangePrepareArgs(args)
      const changePath = parsedArgs.changePath
      if (!changePath) {
        ctx.ui.notify("Usage: /zflow-change-prepare <change-path>", "warning")
        return
      }

      // Step 0: Profile preflight (Phase 7 — Profile.ensureResolved() is step 1)
      await ensureProfileResolved(ctx)

      // Set active workflow mode so before_agent_start injects the change-prepare fragment
      setActiveWorkflowMode("change-prepare")
      const cleanupMode = () => { resetWorkflowState() }

      // Derive the semantic change ID used by the prepare workflow.
      const pathSlug = deriveSemanticChangeId(changePath)

      // Check for unfinished work via checkUnfinishedOnEntry if we can derive changeId
      if (pathSlug) {
        const unfinishedCheck = await checkUnfinishedOnEntry(pathSlug, ctx.cwd)
        if (unfinishedCheck.hasUnfinishedWork) {
          const choices = unfinishedCheck.choices.map(
            (c) => `  - ${c.action}: ${c.description}`,
          ).join("\n")
          ctx.ui.notify(
            `⚠️ Unfinished work detected for change matching "${pathSlug}".\n\n` +
            `Last phase: ${unfinishedCheck.lastPhase}\n` +
            `Unfinished runs: ${unfinishedCheck.unfinishedRunIds.join(", ")}\n` +
            `\nAvailable options:\n${choices}\n\n` +
            "Use /zflow-clean or manually resolve before retrying, or proceed with a different change path.",
            "warning",
          )
          cleanupMode()
          return
        }
      }

      const workflowModel = await resolveWorkflowModel("zflow.planner-frontier")
      ctx.ui.notify(`📋 Preparing change plan for "${changePath}"...`)
      const progress = createWorkflowProgressIndicator(pi, ctx, changePath, {
        command: "zflow-change-prepare",
        model: workflowModel.model ?? "unavailable",
        thinking: workflowModel.thinking ?? "unavailable",
        initialMessage: "Initializing change preparation",
        statusId: "zflow-prepare",
      })

      try {
        // Step 1: Run the initial prepare workflow (creates plan state, version dir, etc.)
        const result = await runChangePrepareWorkflow({
          changePath,
          cwd: ctx.cwd,
          forceAdHoc: parsedArgs.forceAdHoc,
          prepareNotes: parsedArgs.notes,
          onProgress: (message, type) => {
            progress.update(message)
            ctx.ui.notify(message, type)
          },
        })

        ctx.ui.notify(
          `✅ Phase 1 complete: Plan created for change "${result.changeId}" (${result.planVersion}).`,
          "info",
        )
        ctx.ui.notify(
          `   Plan state at: ${result.planStatePath}`,
          "info",
        )

        if (!result.agentDispatchResult.dispatched) {
          const status = result.agentDispatchResult.agentDispatchStatus
          const error = result.agentDispatchResult.error
          ctx.ui.notify(
            `⚠️ Planner agent dispatch did not complete (${status}).\n` +
            (error ? `Reason: ${error}\n` : "") +
            `Plan artifacts were not generated, so validation/review/approval will not run.`,
            "warning",
          )
          return
        }

        ctx.ui.notify(
          `✅ Planner agent completed via ${result.agentDispatchResult.serviceName}.` +
          `${result.agentDispatchResult.methodUsed}.`,
          "info",
        )

        // Check if RuneContext was detected as canonical — notify the user
        const planStateRuneContext = (result.initialPlanState as Record<string, unknown>)?.runeContext as Record<string, unknown> | undefined
        if (planStateRuneContext && (planStateRuneContext as Record<string, unknown>).canonical === true) {
          const docs = (planStateRuneContext as Record<string, unknown>).canonicalDocs as string[] | undefined
          ctx.ui.notify(
            `📋 RuneContext detected for "${changePath}".\n` +
            `   Canonical RuneContext docs will be used as the requirements source.\n` +
            (docs && docs.length > 0 ? `   Available docs: ${docs.join(", ")}` : ""),
            "info",
          )
        }

        // Step 2: Validate plan artifacts
        ctx.ui.notify(`🔍 Validating plan artifacts for "${result.changeId}" ${result.planVersion}...`, "info")
        const validation = await runPlanValidation(result.changeId, result.planVersion, ctx.cwd)
        if (validation.pass) {
          await advancePlanLifecycle(result.changeId, "validated", ctx.cwd)
          ctx.ui.notify(`✅ Plan validation passed for "${result.changeId}" ${result.planVersion}.`, "info")
        } else {
          ctx.ui.notify(
            `⚠️ Plan validation found issues:\n${validation.issues.map((i) => `  - ${i}`).join("\n")}`,
            "warning",
          )
          ctx.ui.notify(
            `Plan artifacts need attention before review or approval.\n` +
            `The planner must produce complete artifacts at:\n` +
            `  - design: ${result.artifactPaths.design}\n` +
            `  - execution-groups: ${result.artifactPaths.executionGroups}\n` +
            `  - standards: ${result.artifactPaths.standards}\n` +
            `  - verification: ${result.artifactPaths.verification}\n\n` +
            `No approval prompt will be shown until validation passes.`,
            "warning",
          )
          return
        }

        // Step 3: Run plan review
        ctx.ui.notify(`📋 Running plan review for "${result.changeId}" ${result.planVersion}...`, "info")
        const reviewResult = await runPlanReview(result.changeId, result.planVersion, ctx.cwd)
        if (reviewResult.pass) {
          await advancePlanLifecycle(result.changeId, "reviewed", ctx.cwd)
          ctx.ui.notify(`✅ Plan review passed for "${result.changeId}".`, "info")
        } else {
          ctx.ui.notify(
            `⚠️ Plan review found issues: ${reviewResult.summary}`,
            "warning",
          )
        }

        // Step 4: Publish durable plan artifacts to repo-visible path
        ctx.ui.notify(`📤 Publishing durable plan artifacts for "${result.changeId}"...`, "info")
        const publishResult = await publishPlanArtifacts(
          result.changeId,
          result.planVersion,
          {
            cwd: ctx.cwd,
            reviewFindingsPath: reviewResult.reviewFindingsPath,
          },
        )

        if (publishResult.artifactCount < 4) {
          const missing = Object.keys(publishResult.publishedArtifacts).length
          ctx.ui.notify(
            `⚠️  Durable publish completed with errors: ${missing}/4 artifacts published.\n` +
            publishResult.errors.map((e) => `  - ${e}`).join("\n"),
            "warning",
          )
          ctx.ui.notify(
            `Cannot proceed to approval — not all four required plan artifacts were published.\n` +
            `Check planner output and runtime artifact paths:\n` +
            `  - design: ${result.artifactPaths.design}\n` +
            `  - execution-groups: ${result.artifactPaths.executionGroups}\n` +
            `  - standards: ${result.artifactPaths.standards}\n` +
            `  - verification: ${result.artifactPaths.verification}`,
            "warning",
          )
          if (publishResult.errors.length > 0) {
            ctx.ui.notify(
              `Publishing errors:\n${publishResult.errors.join("\n")}`,
              "error",
            )
          }
          return
        }

        ctx.ui.notify(
          `✅ Durable plan artifacts published to: ${publishResult.durableDir}`,
          "info",
        )

        const inspectionSummary = formatPlanInspectionPaths({
          changeId: result.changeId,
          planVersion: result.planVersion,
          planStatePath: result.planStatePath,
          artifactPaths: result.artifactPaths,
          reviewFindingsPath: reviewResult.reviewFindingsPath,
          durableDir: publishResult.durableDir,
          publishedArtifacts: publishResult.publishedArtifacts,
          publishErrors: publishResult.errors.length > 0 ? publishResult.errors : undefined,
        })
        ctx.ui.notify(inspectionSummary, "info")

        // Step 5: Run structured interview for plan approval
        const approvalQuestions = buildPlanApprovalQuestions(
          result.changeId,
          result.planVersion,
          `Change path: ${changePath}\nReview status: ${reviewResult.pass ? "passed" : "needs attention"}\nValidation: ${validation.pass ? "passed" : "has issues"}\n\nDurable plan docs published to: ${publishResult.durableDir}\n\n${inspectionSummary}`,
        )

        let interviewResult: { decision: string; revisionNotes?: string } | null = null
        while (true) {
          interviewResult = await runStructuredInterview(
            ctx,
            approvalQuestions,
            `Plan "${result.changeId}" version ${result.planVersion} is ready. ` +
            `Review the durable docs at ${publishResult.durableDir} then use the interactive UI to inspect, approve, request revisions, or cancel.`,
          )

          if (!interviewResult) {
            // No usable UI at all — log paths for manual inspection
            ctx.ui.notify(
              `📌 Plan "${result.changeId}" version ${result.planVersion} is ready for review.\n` +
              `Repo-visible change documents:\n` +
              Object.entries(publishResult.publishedArtifacts).map(([k, v]) => `  - ${k}: ${v}`).join("\n") +
              `\n\nRuntime artifacts:\n` +
              `  - design: ${result.artifactPaths.design}\n` +
              `  - execution-groups: ${result.artifactPaths.executionGroups}\n` +
              `  - standards: ${result.artifactPaths.standards}\n` +
              `  - verification: ${result.artifactPaths.verification}\n\n` +
              `Use /zflow-change-audit ${result.changeId} to inspect.`,
              "info",
            )
            return
          }

          if (interviewResult.decision !== "inspect") break
          ctx.ui.notify(
            `${inspectionSummary}\n\nReview the files, then return to the decision prompt to approve, request revisions, or cancel.`,
            "info",
          )
        }

        switch (interviewResult.decision) {
          case "approve": {
            await approvePlanVersion(result.changeId, result.planVersion, ctx.cwd)
            ctx.ui.notify(
              `✅ Plan "${result.changeId}" version ${result.planVersion} approved.`,
              "info",
            )

            if (!shouldForkImplementationSessionAfterPrepare()) {
              ctx.ui.notify(
                `📌 Plan mode is active, so no implementation session was forked.\n` +
                `  Plan artifacts are ready for change "${result.changeId}" v${result.planVersion}:\n` +
                `    - design: ${result.artifactPaths.design}\n` +
                `    - execution-groups: ${result.artifactPaths.executionGroups}\n` +
                `    - standards: ${result.artifactPaths.standards}\n` +
                `    - verification: ${result.artifactPaths.verification}\n\n` +
                `  When you are ready to implement, run:\n` +
                `    /zflow-plan exit\n` +
                `    /zflow-change-implement ${result.changeId}`,
                "info",
              )
              break
            }

            // Build implementation handoff and attempt session fork
            const handoff = buildImplementationHandoff(
              result.changeId,
              result.planVersion,
              resolveRuntimeStateDir(ctx.cwd),
              result.artifactPaths,
            )

            const forkResult = await forkImplementationSessionIfAvailable(
              ctx as unknown as Record<string, unknown>,
              handoff,
            )

            if (forkResult.forked && forkResult.sessionFile) {
              // Successfully forked into a new implementation session
              ctx.ui.notify(
                `🚀 Forked implementation session.\n` +
                `  Session file: ${forkResult.sessionFile}\n` +
                `  Change: ${handoff.changeId} v${handoff.approvedVersion}\n` +
                `  No git branches were created.\n` +
                `  The planning session remains available via session tree/resume.\n` +
                `  Run \`/zflow-change-implement ${handoff.changeId}\` in the new session to begin.`,
                "info",
              )
            } else if (forkResult.handoffArtifactPath) {
              // Fallback: handoff artifact written
              ctx.ui.notify(
                `📋 Handoff artifact written to: ${forkResult.handoffArtifactPath}\n` +
                `  Change: ${handoff.changeId} v${handoff.approvedVersion}\n` +
                `  No session fork API was available — handoff data persisted for next session.\n` +
                `  Use \`/zflow-change-implement ${handoff.changeId}\` to load the handoff.\n` +
                `  No git branches were created.`,
                "info",
              )
            } else {
              // No fork and no artifact — show inline handoff data
              ctx.ui.notify(
                `📋 Handoff data prepared for change "${handoff.changeId}" v${handoff.approvedVersion}.\n` +
                `  Pass \`/zflow-change-implement ${handoff.changeId}\` to begin implementation.`,
                "info",
              )
            }

            // Present handoff summary and next steps
            ctx.ui.notify(
              `\n📋 Implementation handoff summary:\n` +
              `  • Plan: ${handoff.changeId} v${handoff.approvedVersion}\n` +
              `  • Handoff mode: ${forkResult.forked ? "session-fork" : forkResult.handoffArtifactPath ? "artifact-file" : "inline"}\n` +
              `  • Artifacts:\n` +
              `    - design: ${handoff.planArtifactPaths.design ?? "N/A"}\n` +
              `    - execution-groups: ${handoff.planArtifactPaths.executionGroups ?? "N/A"}\n` +
              `    - verification: ${handoff.planArtifactPaths.verification ?? "N/A"}\n` +
              `  • Next: Run \`/zflow-change-implement ${handoff.changeId}\``,
              "info",
            )
            break
          }
          case "revise": {
            await bumpPlanVersion(result.changeId, ctx.cwd)
            await advancePlanLifecycle(result.changeId, "draft", ctx.cwd)
            ctx.ui.notify(
              `📝 Revision requested for "${result.changeId}". ` +
              (interviewResult.revisionNotes
                ? `Notes: ${interviewResult.revisionNotes}`
                : "A new plan version will be created."),
              "info",
            )
            break
          }
          case "cancel": {
            await updatePlanState(result.changeId, {
              lifecycleState: "cancelled",
            }, ctx.cwd)
            ctx.ui.notify(
              `🛑 Plan "${result.changeId}" version ${result.planVersion} cancelled by user.`,
              "warning",
            )
            break
          }
          case "inspect": {
            ctx.ui.notify(
              `${inspectionSummary}\n\n` +
              `When ready, rerun /zflow-change-prepare ${changePath} or use /zflow-change-audit ${result.changeId} to inspect without approval.`,
              "info",
            )
            break
          }
          default: {
            // "inspect" or unknown — log paths for manual review
            ctx.ui.notify(
              `📌 Plan "${result.changeId}" version ${result.planVersion} is ready for review.\n` +
              `Decision: ${interviewResult.decision}. Use /zflow-change-audit ${result.changeId} to inspect.`,
              "info",
            )
            break
          }
        }
      } catch (err: unknown) {
        progress.stop(
          `Change preparation failed: ${err instanceof Error ? err.message : String(err)}`,
          "failed",
        )
        ctx.ui.notify(
          `Change preparation failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        )
      } finally {
        progress.stop("zflow-change-prepare finished")
        // Clear mode and reminders regardless of outcome
        resetWorkflowState()
      }
    },
  })

  // ── Command: /zflow-change-implement ──────────────────────────

  pi.registerCommand("zflow-change-implement", {
    description: "Execute the approved plan for a change — worktree dispatch, verification, review",
    handler: async (args: string, ctx: InterviewableContext): Promise<void> => {
      // Parse flags from args
      const parts = args.trim().split(/\s+/)
      const force = parts.includes("--force")
      const manualDispatchComplete = parts.includes("--manual-dispatch-complete")
      const abandonUnfinished = parts.includes("--abandon") || parts.includes("--abandon-unfinished")
      const resumeEnabled = parts.includes("--resume")
      const failedOnly = parts.includes("--failed-only")
      const applySuccessful = parts.includes("--apply-successful")
      const forceApplySuccessful = parts.includes("--force-apply-successful")
      const changeInput = parts.filter(p => !p.startsWith("--")).join(" ")

      const usageText =
        "Usage: /zflow-change-implement <change-id-or-docs-path> [options]\n\n" +
        "  <change-id-or-docs-path>       Runtime change ID, or docs/zflow-changes/<id>/[version/] path.\n\n" +
        "  Options:\n" +
        "  --force                       Proceed even if the primary worktree has uncommitted changes.\n" +
        "  --abandon                     Mark unfinished runs for this change abandoned, then start fresh.\n" +
        "  --manual-dispatch-complete    Skip worktree dispatch and proceed directly to verification.\n" +
        "  --resume                      Resume latest unfinished/partial run, dispatching only failed/pending groups.\n" +
        "  --failed-only                 Same as --resume; only retry groups that failed in a partial run.\n" +
        "  --apply-successful            Apply successful group patches despite failed groups (safe check).\n" +
        "  --force-apply-successful       Force apply successful patches even if overlaps exist.\n\n" +
        "  Partial run flags (--resume, --failed-only, --apply-successful, --force-apply-successful)\n" +
        "  use the durable group ledger tracked throughout the implementation lifecycle.\n" +
        "  Inspect status with: /zflow-change-audit <change-id>"

      if (!changeInput) {
        ctx.ui.notify(usageText, "warning")
        return
      }

      // ── Parse partial-run flags ───────────────────────────────
      const useResume = resumeEnabled || failedOnly
      const useApplySuccessful = applySuccessful || forceApplySuccessful
      const useForceApplySuccessful = forceApplySuccessful

      if (useResume || useApplySuccessful) {
        // ── Partial/Resume apply path ────────────────────────────
        const implementTarget = await resolveChangeImplementTarget(changeInput)
        const changeId = implementTarget.changeId

        await ensureProfileResolved(ctx)
        setActiveWorkflowMode("change-implement")
        const cleanupMode = (): void => { resetWorkflowState() }

        const partialRun = await findLatestPartialRun(changeId, ctx.cwd)
        if (!partialRun) {
          ctx.ui.notify(
            `No partial or unfinished run found for change "${changeId}". ` +
            "Starting a full implementation run.\n" +
            usageText,
            "warning",
          )
        }

        if (useApplySuccessful) {
          // ── Apply successful groups path ────────────────────────
          if (!partialRun) {
            ctx.ui.notify(`No previous run found for "${changeId}". Nothing to apply.`, "error")
            cleanupMode()
            return
          }

          ctx.ui.notify(
            `📋 Applying successful group patches from run "${partialRun.runId}"...`,
            "info",
          )

          try {
            const applyResult = await applySuccessfulGroupPatches(
              partialRun.runId,
              changeId,
              ctx.cwd,
              useForceApplySuccessful,
              (msg) => ctx.ui.notify(msg, "info"),
            )

            const summaryEntry = applyResult.summaryPath
              ? `\n  Summary: ${applyResult.summaryPath}`
              : ""

            if (applyResult.errors.length > 0) {
              ctx.ui.notify(
                `⚠️ Applied ${applyResult.applied.length} group(s) with ${applyResult.errors.length} error(s):\n` +
                applyResult.errors.map((e) => `  - ${e}`).join("\n") +
                summaryEntry,
                "warning",
              )
            } else {
              ctx.ui.notify(
                `✅ Applied ${applyResult.applied.length} group(s) successfully.` +
                summaryEntry,
                "info",
              )
            }

            // Check if all groups are now applied
            const updatedLedger = await getGroupLedger(partialRun.runId, ctx.cwd)
            const allDone = Object.values(updatedLedger).every((e) =>
              e.status === "applied" || e.status === "skipped"
            )
            if (allDone) {
              ctx.ui.notify(
                "✅ All groups applied. To run final verification and code review:\n" +
                `  /zflow-change-implement ${changeInput} --manual-dispatch-complete`,
                "info",
              )
            }
          } catch (err: unknown) {
            ctx.ui.notify(
              `Apply successful groups failed: ${err instanceof Error ? err.message : String(err)}`,
              "error",
            )
          }

          cleanupMode()
          return
        }

        // ── Resume path ──────────────────────────────────────────
        if (partialRun) {
          const partialRunId = partialRun.runId
          const partialRunData = partialRun.run as Record<string, unknown>
          const planVersion = partialRunData.planVersion as string ?? "v1"
          const resumeChangeId = partialRunData.changeId as string ?? changeId

          const dispatchService = await tryGetDispatchServiceViaRegistry()
          if (!dispatchService) {
            ctx.ui.notify(
              "⚠️ No dispatch service available. Cannot resume without worktree isolation.\n" +
              "Use --apply-successful if patches exist, or install pi-subagents.",
              "error",
            )
            cleanupMode()
            return
          }

          const implementModel = await resolveWorkflowModel("zflow.implement-routine")
          const implProgress = createWorkflowProgressIndicator(pi, ctx, changeInput, {
            command: "zflow-change-implement",
            model: implementModel.model ?? "unavailable",
            thinking: implementModel.thinking ?? "unavailable",
            initialMessage: "Resuming implementation run",
            statusId: "zflow-implement",
            widgetId: "zflow-implement-progress",
          })

          try {
            implProgress.update(`Resuming run "${partialRunId}" — dispatching only failed/pending groups`)

            await resumeWorktreeDispatch(
              partialRunId,
              resumeChangeId,
              planVersion,
              dispatchService,
              {
                cwd: ctx.cwd,
                force,
                onSubagentUpdate: (id, update) => implProgress.updateSubagent(id, update),
              },
            )

            implProgress.update("Resume dispatch complete; all groups now succeeded")

            // ── Post-start sequence ──────────────────────────────
            const updatePostImplementationCard = (message: string): void => {
              const normalized = message.toLowerCase()
              if (normalized.includes("running code review")) {
                implProgress.updatePhaseCard("code-review", "Code Review", message, "running")
                return
              }
              if (normalized.includes("code review passed")) {
                implProgress.updatePhaseCard("code-review", "Code Review", message, "completed")
                implProgress.updatePhaseCard("post-code-review", "Post Code Review", "Preparing final workflow completion", "running")
                return
              }
              if (normalized.includes("code review found") || normalized.includes("review failed")) {
                implProgress.updatePhaseCard("code-review", "Code Review", message, "failed")
                implProgress.updatePhaseCard("post-code-review", "Post Code Review", "Review failed; preparing next steps", "failed")
                return
              }
              if (normalized.includes("persisting completed") || normalized.includes("workflow completion persisted")) {
                implProgress.updatePhaseCard("post-code-review", "Post Code Review", message, normalized.includes("persisted") ? "completed" : "running")
                return
              }
              const postStatus = normalized.includes("final verification passed") ? "completed" : "running"
              implProgress.updatePhaseCard("post-implementation", "Post Implementation", message, postStatus)
              if (normalized.includes("final verification passed")) {
                implProgress.updatePhaseCard("code-review", "Code Review", "Waiting for code review to start", "running")
              }
            }

            updatePostImplementationCard("Starting post-dispatch sequence: final verification, review, and completion")
            const onReviewerUpdate = (reviewerUpdate: {
              reviewerName: string
              agentName: string
              status: "queued" | "running" | "completed" | "failed"
              model?: string
              thinking?: string
              currentTool?: string
              lastCommand?: string
            }): void => {
              implProgress.updateReviewer(reviewerUpdate.reviewerName, reviewerUpdate)
            }
            const postResult = await runImplementationPostStartSequence(
              partialRunId,
              {
                skipDispatchWait: false,
                onProgress: updatePostImplementationCard,
                onReviewerUpdate,
              },
            )

            const finalCardStatus = postResult.status === "completed" ? "completed" : "failed"
            const finalCardTitle = postResult.status === "completed" ? "Workflow Complete" : "Workflow Needs Attention"
            const nextStepsLine = postResult.nextSteps.length > 0
              ? `Next steps: ${postResult.nextSteps.map((s) => s.replace(/^\d+\.\s*/, "")).join("; ")}`
              : "No further steps — workflow is complete."

            implProgress.updatePhaseCard("workflow-complete", finalCardTitle, `Phase: ${postResult.phase}, status: ${postResult.status}`, finalCardStatus)
            implProgress.updatePhaseCard("workflow-complete", finalCardTitle, nextStepsLine, finalCardStatus)
            implProgress.stop(finalCardTitle)
          } catch (err: unknown) {
            implProgress.stop(
              `Resume failed: ${err instanceof Error ? err.message : String(err)}`,
              "failed",
            )
          }

          cleanupMode()
          return
        }

        // No partial run found — fall through to full dispatch
      }

      const implementTarget = await resolveChangeImplementTarget(changeInput)
      const changeId = implementTarget.changeId
      if (implementTarget.manifestPath && implementTarget.durableChangeId && implementTarget.durableChangeId !== changeId) {
        ctx.ui.notify(
          `📋 Resolved durable change docs "${implementTarget.durableChangeId}" to runtime plan "${changeId}".`,
          "info",
        )
      }

      // Step 0: Profile preflight (Phase 7 — Profile.ensureResolved() is step 1)
      await ensureProfileResolved(ctx)

      // Set active workflow mode so before_agent_start injects change-implement fragment
      setActiveWorkflowMode("change-implement")
      const cleanupMode = (): void => { resetWorkflowState() }

      // Check for unfinished work on this change (non-resume path)
      const unfinishedCheck = await checkUnfinishedOnEntry(changeId, ctx.cwd)
      if (unfinishedCheck.hasUnfinishedWork) {
        if (abandonUnfinished) {
          const cleanResult = await runCleanWorkflow({
            cwd: ctx.cwd,
            changeId,
            abandonUnfinished: true,
          })
          ctx.ui.notify(
            `🧹 Abandoned ${cleanResult.abandonedRuns.length} unfinished run(s) for "${changeId}": ` +
            `${cleanResult.abandonedRuns.join(", ") || "none"}. Starting fresh...`,
            "info",
          )
        } else {
          const choices = unfinishedCheck.choices.map(
            (c) => `  - ${c.action}: ${c.description}`,
          ).join("\n")
          ctx.ui.notify(
            `⚠️ Unfinished work detected for change "${changeId}".\n\n` +
            `Last phase: ${unfinishedCheck.lastPhase}\n` +
            `Unfinished runs: ${unfinishedCheck.unfinishedRunIds.join(", ")}\n` +
            (unfinishedCheck.retainedWorktrees.length > 0
              ? `Retained worktrees: ${unfinishedCheck.retainedWorktrees.join(", ")}\n`
              : "") +
            `\nAvailable options:\n${choices}\n\n` +
            `To start fresh now, run:\n  /zflow-change-implement ${changeInput} --abandon\n\n` +
            `Or clean separately with:\n  /zflow-clean ${changeInput}`,
            "warning",
          )
          cleanupMode()
          return
        }
      }

      // ── Detect and load pending handoff artifacts ──────────────
      const existingHandoff = await resolvePendingHandoff(changeId)
      if (existingHandoff) {
        ctx.ui.notify(
          `📋 Loaded handoff artifact for "${changeId}" v${existingHandoff.approvedVersion}.`,
          "info",
        )
        await clearPendingHandoff(changeId)
      }

      // ── Check for dispatch service availability ───────────────
      const dispatchService = await tryGetDispatchServiceViaRegistry()
      const hasDispatch = dispatchService !== null

      if (!hasDispatch && !manualDispatchComplete) {
        ctx.ui.notify(
          "⚠️ No dispatch service available for worktree isolation.\n\n" +
          "To implement changes, you need one of:\n" +
          "  1. Install and configure pi-subagents (provides the `subagent` tool).\n" +
          "     Install: `npm install -g pi-subagents`\n" +
          "  2. Register a pi-subagents bridge extension.\n" +
          "  3. Run with --manual-dispatch-complete if you are applying changes manually.\n\n" +
          "Without a dispatch service, the workflow cannot dispatch workers to isolated worktrees " +
          "or apply patches back atomically. Aborting.",
          "error",
        )
        return
      }

      if (hasDispatch) {
        ctx.ui.notify(`🔄 Dispatch service detected: ${dispatchService!.name}`, "info")
      }

      if (manualDispatchComplete) {
        ctx.ui.notify(
          "⚠️ --manual-dispatch-complete: Skipping worktree dispatch. Proceeding to verification.\n" +
          "You are responsible for ensuring changes are correctly applied to the primary worktree.",
          "warning",
        )
      }

      const implementModel = await resolveWorkflowModel("zflow.implement-routine")
      const implProgress = createWorkflowProgressIndicator(pi, ctx, changeInput, {
        command: "zflow-change-implement",
        model: implementModel.model ?? "unavailable",
        thinking: implementModel.thinking ?? "unavailable",
        initialMessage: "Starting implementation workflow",
        statusId: "zflow-implement",
        widgetId: "zflow-implement-progress",
      })
      const updatePostImplementationCard = (message: string): void => {
        const normalized = message.toLowerCase()
        if (normalized.includes("running code review")) {
          implProgress.updatePhaseCard("code-review", "Code Review", message, "running")
          return
        }
        if (normalized.includes("code review passed")) {
          implProgress.updatePhaseCard("code-review", "Code Review", message, "completed")
          implProgress.updatePhaseCard("post-code-review", "Post Code Review", "Preparing final workflow completion", "running")
          return
        }
        if (normalized.includes("code review found") || normalized.includes("review failed")) {
          implProgress.updatePhaseCard("code-review", "Code Review", message, "failed")
          implProgress.updatePhaseCard("post-code-review", "Post Code Review", "Review failed; preparing next steps", "failed")
          return
        }
        if (normalized.includes("persisting completed") || normalized.includes("workflow completion persisted")) {
          implProgress.updatePhaseCard("post-code-review", "Post Code Review", message, normalized.includes("persisted") ? "completed" : "running")
          return
        }
        const postStatus = normalized.includes("final verification passed") ? "completed" : "running"
        implProgress.updatePhaseCard("post-implementation", "Post Implementation", message, postStatus)
        if (normalized.includes("final verification passed")) {
          implProgress.updatePhaseCard("code-review", "Code Review", "Waiting for code review to start", "running")
        }
      }

      try {
        addReminder("approved-plan-loaded")
        implProgress.update("Creating run state and parsing execution plan")

        // ── Phase 2: Run the create-run workflow ──────────────────
        const result = await runChangeImplementWorkflow({
          changeId,
          force,
        })

        if (force) {
          implProgress.update("Forcing dirty worktree — changes may conflict")
        }

        implProgress.update(`Run created: ${result.runId}, version ${result.planVersion}`)
        removeReminder("approved-plan-loaded")

        // ── Phase 3: Parse execution groups and dispatch ─────────
        if (!manualDispatchComplete && hasDispatch) {
          implProgress.update(`Dispatching ${result.changeId} via ${dispatchService!.name}`)
          await runWorktreeDispatchAndFinalize(result.runId, result.changeId, result.planVersion, dispatchService!, {
            cwd: undefined,
            force,
            onWorkflowUpdate: updatePostImplementationCard,
            onSubagentUpdate: (id, update) => implProgress.updateSubagent(id, update),
          })
        }

        // ── Phase 4: Post-start sequence (verification, review, complete) ──
        updatePostImplementationCard("Starting post-start sequence: final verification, review, and completion")
        const onReviewerUpdate = (reviewerUpdate: {
          reviewerName: string
          agentName: string
          status: "queued" | "running" | "completed" | "failed"
          model?: string
          thinking?: string
          currentTool?: string
          lastCommand?: string
        }): void => {
          implProgress.updateReviewer(reviewerUpdate.reviewerName, reviewerUpdate)
        }
        const postResult = await runImplementationPostStartSequence(
          result.runId,
          {
            skipDispatchWait: manualDispatchComplete,
            onProgress: updatePostImplementationCard,
            onReviewerUpdate,
          },
        )

        // Avoid duplicating verification status messages already shown via phase cards.
        // Top-level recent-message bullets are suppressed when phase cards are present
        // (see render), so we only set a concise stop message.

        const finalCardStatus = postResult.status === "completed"
          ? "completed"
          : postResult.status === "failed"
            ? "failed"
            : "running"
        const finalCardTitle = postResult.status === "completed" ? "Workflow Complete" : "Workflow Needs Attention"
        const nextStepsLine = postResult.nextSteps.length > 0
          ? `Next steps: ${postResult.nextSteps.map((s) => s.replace(/^\d+\.\s*/, "")).join("; ")}`
          : "No further steps — workflow is complete."

        // Update the Workflow Complete / Workflow Needs Attention card with both lines
        implProgress.updatePhaseCard(
          "workflow-complete",
          finalCardTitle,
          `Phase: ${postResult.phase}, status: ${postResult.status}`,
          finalCardStatus,
        )
        implProgress.updatePhaseCard(
          "workflow-complete",
          finalCardTitle,
          nextStepsLine,
          finalCardStatus,
        )

        implProgress.stop(finalCardTitle)
      } catch (err: unknown) {
        implProgress.stop(
          `Implementation failed: ${err instanceof Error ? err.message : String(err)}`,
          "failed",
        )
      } finally {
        resetWorkflowState()
      }
    },
  })

  // ── Command: /zflow-change-audit ──────────────────────────────

  pi.registerCommand("zflow-change-audit", {
    description: "Audit an approved plan's verification status and deviation reports",
    handler: async (args: string, ctx: InterviewableContext): Promise<void> => {
      const changeId = args.trim()
      if (!changeId) {
        ctx.ui.notify("Usage: /zflow-change-audit <change-id>", "warning")
        return
      }

      const auditProgress = createWorkflowProgressIndicator(pi, ctx, changeId, {
        command: "zflow-change-audit",
        model: undefined,
        initialMessage: "Auditing change status",
        statusId: "zflow-audit",
        widgetId: "zflow-audit-progress",
      })

      try {
        auditProgress.update("Reading plan state and run metadata")
        const result = await runChangeAuditWorkflow({
          changeId,
        })

        auditProgress.update(result.summary)

        // Emit recommended actions
        for (const action of result.recommendedActions) {
          auditProgress.update(`→ ${action}`)
        }

        const status = result.status
        if (status === "approved" || status === "executing") {
          auditProgress.update(
            `Tip: Run /zflow-review-code ${changeId} to (re-)run code review, ` +
            `or /zflow-change-implement ${changeId} if not yet executed.`,
          )
        }

        // Structured gate when verification failed
        if (result.verificationStatus === "failed") {
          const gateQuestions = buildImplementationGateQuestions(
            changeId,
            "verification-failure",
            `Verification failed for change "${changeId}" (${result.planVersion}).\n${result.summary}`,
          )

          const gateResult = await runStructuredInterview(
            ctx,
            gateQuestions,
            `Verification failed for "${changeId}". Choose how to proceed: auto-fix loop, manual review, or skip.`,
          )

          if (gateResult) {
            switch (gateResult.decision) {
              case "continue": {
                auditProgress.update("→ Run /zflow-change-fix to start the auto-fix loop.")
                break
              }
              case "approve": {
                auditProgress.update("→ Verification skipped. Review will be advisory.")
                break
              }
              default: {
                auditProgress.update("→ Manual review chosen. Use /zflow-change-fix when ready.")
                break
              }
            }
          }
        }

        auditProgress.stop("Audit complete.")
      } catch (err: unknown) {
        auditProgress.stop(
          `Audit failed: ${err instanceof Error ? err.message : String(err)}`,
          "failed",
        )
      }
    },
  })

  // ── Command: /zflow-change-fix ────────────────────────────────

  pi.registerCommand("zflow-change-fix", {
    description: "Iterate on verification/code-review failures for an approved change",
    handler: async (args: string, ctx: InterviewableContext): Promise<void> => {
      const changeId = args.trim()
      if (!changeId) {
        ctx.ui.notify("Usage: /zflow-change-fix <change-id>", "warning")
        return
      }

      const fixModel = await resolveWorkflowModel("zflow.implement-routine")
      const fixProgress = createWorkflowProgressIndicator(pi, ctx, changeId, {
        command: "zflow-change-fix",
        model: fixModel.model ?? "unavailable",
        thinking: fixModel.thinking ?? "unavailable",
        initialMessage: "Running fix workflow",
        statusId: "zflow-fix",
        widgetId: "zflow-fix-progress",
      })

      try {
        fixProgress.update("Resolving review findings and building fix plan")
        const result = await runChangeFixWorkflow({
          changeId,
        })

        fixProgress.update(result.fixPlan)
        if (result.filesToModify.length > 0) {
          fixProgress.update(
            `Files to modify: ${result.filesToModify.map(f => `\`${f}\``).join(", ")}`,
          )
        }

        // Structured gate presenting review-finding fix options
        const gateQuestions = buildImplementationGateQuestions(
          changeId,
          "review-findings",
          `Fix plan for "${changeId}":\n${result.fixPlan}\n` +
          (result.filesToModify.length > 0
            ? `Target files: ${result.filesToModify.join(", ")}`
            : "No specific files identified."),
        )

        const gateResult = await runStructuredInterview(
          ctx,
          gateQuestions,
          `Fix plan ready for "${changeId}". Choose approach: fix all, critical/major only, or dismiss findings.`,
        )

        if (gateResult) {
          switch (gateResult.decision) {
            case "continue": {
              fixProgress.update("Applying all fixes.")
              break
            }
            case "approve": {
              fixProgress.update("Applying critical/major fixes.")
              break
            }
            default: {
              fixProgress.update("Findings dismissed. Proceeding without fixes.")
              break
            }
          }
        }

        // Offer next steps
        if (result.verificationCommand) {
          fixProgress.update(
            `After fixes, run: ${result.verificationCommand}`,
          )
        }
        fixProgress.stop(
          `Tip: Update plan lifecycle and re-run /zflow-review-code ${changeId} to re-verify.`,
        )
      } catch (err: unknown) {
        fixProgress.stop(
          `Fix workflow failed: ${err instanceof Error ? err.message : String(err)}`,
          "failed",
        )
      }
    },
  })
}
