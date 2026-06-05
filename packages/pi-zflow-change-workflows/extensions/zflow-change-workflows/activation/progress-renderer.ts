/**
 * progress-renderer.ts — workflow progress snapshots, attention signals, and TUI card rendering.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

import type { InterviewableContext } from "../interview/structured-interview.js"

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

const WORKFLOW_PROGRESS_MESSAGE_TYPE = "zflow-workflow-progress" as const
const WORKFLOW_ATTENTION_PHASE_CARD_ID = "coordination-attention" as const

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

export interface WorkflowSubagentSnapshot {
  id: string
  agent: string
  title?: string
  model?: string
  thinking?: string
  status: string
  startedAt: number
  finishedAt?: number
  lastCommand?: string
  logs?: string[]
  lastActivityAt?: number
}

interface WorkflowProgressMessageDetails {
  id: string
  snapshot: WorkflowProgressSnapshot
}

export interface SessionMessageLike {
  role?: string
  customType?: string
  content?: unknown
  timestamp?: number
}

export interface SessionEntryLike {
  id?: string
  type?: string
  message?: SessionMessageLike
}

export interface WorkflowAttentionSignalInput {
  id: string
  agent: string
  title?: string
  lastCommand?: string
  logs?: string[]
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

function flattenMessageContentToText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return ""
      const maybeText = part as { type?: unknown; text?: unknown }
      if (maybeText.type === "text" && typeof maybeText.text === "string") return maybeText.text
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

function detectCoordinationKeyword(text: string): string | undefined {
  const normalized = text.toLowerCase()
  if (normalized.includes("drift detected")) return "DRIFT_DETECTED"
  if (normalized.includes("need_clarification") || normalized.includes("need clarification")) return "NEED_CLARIFICATION"
  if (normalized.includes("verification_failed") || normalized.includes("verification failed")) return "VERIFICATION_FAILED"
  if (normalized.includes("blocked") || normalized.includes("need_decision") || normalized.includes("need decision")) return "BLOCKED"
  if (normalized.includes("progress_update") || normalized.includes("progress update")) return "PROGRESS_UPDATE"
  return undefined
}

export function detectWorkflowAttentionSignal(subagent: WorkflowAttentionSignalInput): string | undefined {
  const candidates = [subagent.lastCommand, ...(subagent.logs ?? [])]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
  const matched = candidates.find((value) => /contact_supervisor|intercom/i.test(value))
  if (!matched) return undefined

  const label = subagent.title?.trim() || subagent.agent || subagent.id
  const keyword = detectCoordinationKeyword(matched)
  const tool = /contact_supervisor/i.test(matched) ? "contact_supervisor" : "intercom"
  const detail = visualTruncate(matched.replace(/\s+/g, " ").trim(), 140)
  return keyword
    ? `${label} raised ${keyword} via ${tool}: ${detail}`
    : `${label} used ${tool}: ${detail}`
}

export function detectIncomingWorkflowAttention(entry: SessionEntryLike): string | undefined {
  if (entry.type !== "message" || !entry.message) return undefined
  const message = entry.message
  const customType = typeof message.customType === "string" ? message.customType : ""
  if (customType === WORKFLOW_PROGRESS_MESSAGE_TYPE) return undefined

  const text = flattenMessageContentToText(message.content)
  const haystack = `${customType}\n${text}`.toLowerCase()
  const looksLikeIntercom = haystack.includes("intercom") || haystack.includes("contact_supervisor")
  const keyword = detectCoordinationKeyword(haystack)

  if (!looksLikeIntercom && !keyword) return undefined

  const summary = visualTruncate(text.replace(/\s+/g, " ").trim(), 180) || visualTruncate(customType, 80)
  if (!summary) return undefined
  return keyword
    ? `Incoming ${keyword} signal: ${summary}`
    : `Incoming coordination signal: ${summary}`
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

function ansiAwareVisualWidth(text: string): number {
  let w = 0
  let index = 0
  while (index < text.length) {
    const ansi = text.slice(index).match(/^\x1b\[[0-9;]*m/)
    if (ansi) {
      index += ansi[0].length
      continue
    }

    const codePoint = text.codePointAt(index)
    if (codePoint === undefined) break
    const ch = String.fromCodePoint(codePoint)
    w += visualCharWidth(ch)
    index += ch.length
  }
  return w
}

function visualTruncate(value: string, maxVisualWidth: number): string {
  if (maxVisualWidth <= 0) return ""

  // ANSI-aware truncation. Workflow progress lines often contain theme SGR
  // sequences; slicing by raw string length can cut an escape sequence or drop
  // the reset emitted by theme.bg()/theme.fg(), which leaves terminal
  // background color bleeding into later transcript lines. This follows the
  // same principle as pi-subagents' TUI renderer: count only visible cells and
  // copy escape sequences through untouched.
  let w = 0
  let result = ""
  let index = 0
  while (index < value.length) {
    const ansi = value.slice(index).match(/^\x1b\[[0-9;]*m/)
    if (ansi) {
      result += ansi[0]
      index += ansi[0].length
      continue
    }

    const codePoint = value.codePointAt(index)
    if (codePoint === undefined) break
    const ch = String.fromCodePoint(codePoint)
    const cw = visualCharWidth(ch)
    if (w + cw > maxVisualWidth) break
    result += ch
    w += cw
    index += ch.length
  }
  return result
}

function visualPadEnd(value: string, targetVisualWidth: number): string {
  const currentWidth = visualWidth(value)
  if (currentWidth >= targetVisualWidth) return value
  return value + " ".repeat(targetVisualWidth - currentWidth)
}

function ansiAwarePadEnd(value: string, targetVisualWidth: number): string {
  const currentWidth = ansiAwareVisualWidth(value)
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
  // Keep for row-fill compatibility in the grid renderers, but do not paint
  // each card line. The earlier filled-background card style could bleed into
  // surrounding transcript text when Pi clipped styled lines, producing the
  // large rectangular artifacts shown in the TUI. pi-subagents avoids this by
  // rendering compact foreground-only rows inside one outer result box.
  void status
  void theme
  return (s) => s
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
  const MAX_CARD_WIDTH = 90
  const safeWidth = Math.max(8, Math.min(width, MAX_CARD_WIDTH))

  function cardLineWrapped(text: string, indent: string, colorize: (s: string) => string): string[] {
    const contentWidth = Math.max(1, safeWidth - visualWidth(indent))
    const wrapped = wordWrap(text, contentWidth)
    return wrapped.map((fragment) => {
      const plainLine = indent + fragment
      const clippedLine = visualTruncate(plainLine, safeWidth)
      const styledLine = colorize(clippedLine)
      // Do not pass padding through theme.fg()/theme.bg(); some theme
      // functions trim or reset trailing whitespace, which collapses reviewer
      // grid columns and lets text from one card run into the next. Pad after
      // styling with ANSI-aware width accounting so every card line occupies
      // exactly safeWidth cells before the inter-column gap is appended.
      return ansiAwarePadEnd(visualTruncate(styledLine, safeWidth), safeWidth)
    })
  }

  const lines: string[] = []

  // Foreground-only compact card, inspired by pi-subagents' result rows. Avoid
  // per-card backgrounds; the outer Pi tool/message renderer already provides
  // the visual grouping.
  for (const l of cardLineWrapped(model.title, "  ", (s) => statusTextColor(model.status, theme, s))) {
    lines.push(l)
  }

  // Status + elapsed line — dimmed metadata
  for (const l of cardLineWrapped(`⎿  ${model.statusLine}`, "  ", (s) => theme.fg("dim", s))) {
    lines.push(l)
  }

  // Meta lines — dimmed, with thinking level highlighted
  for (const meta of model.metaLines) {
    for (const l of cardLineWrapped(meta, "     ", (s) => colorizeMetaLine(s, theme))) {
      lines.push(l)
    }
  }

  // Body lines — dimmed bullet items
  for (const body of model.bodyLines) {
    for (const l of cardLineWrapped(body, "     ", (s) => theme.fg("dim", s))) {
      lines.push(l)
    }
  }

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
  const bodyLines: string[] = [`last: ${subagent.lastCommand ?? "starting"}`]
  if (subagent.logs && subagent.logs.length > 0) {
    for (const log of subagent.logs.slice(-5)) {
      bodyLines.push(`• ${log}`)
    }
  }
  return {
    id: subagent.id,
    title: `${subagentStatusIcon(subagent.status)} ${subagent.title ?? "untitled group"}`,
    status,
    statusLine: `${subagent.status} · ${elapsed}`,
    metaLines: [
      subagent.id,
      `${subagent.agent} · ${model} · ${thinking}`,
    ],
    bodyLines,
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
  const modelWithThinking = reviewer.model?.match(/^(.*?)\s+·\s+thinking:\s*(\S+)\s*$/i)
  const model = modelWithThinking?.[1]?.trim() || reviewer.model || "unavailable"
  const thinking = reviewer.thinking ?? modelWithThinking?.[2] ?? "unavailable"
  const status = reviewer.status
  const icon = status === "completed" ? "✅" : status === "failed" ? "❌" : status === "queued" ? "⏳" : "▶️"
  return {
    id: reviewer.id,
    title: `${icon} ${reviewer.reviewerName}`,
    status,
    statusLine: status,
    metaLines: [
      `${reviewer.agentName}`,
      `model: ${model}`,
      `thinking: ${thinking}`,
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
  const gap = 4
  const cardWidth = Math.min(
    Math.max(32, Math.floor((available - (columns - 1) * gap) / columns)),
    90,  // match buildCardLines cap
  )
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

export function buildWorkflowFinalNextStepsLine(
  postResult: { status: string; phase: string; nextSteps: string[]; reviewFindingsPath?: string },
  changeInput: string,
): string {
  if (postResult.status === "completed") return "No further steps — workflow is complete."

  if (postResult.phase === "review-failed") {
    const findings = postResult.reviewFindingsPath
      ? ` Findings: ${postResult.reviewFindingsPath}.`
      : ""
    return `Next: /zflow-change-fix ${changeInput} to review findings, then /zflow-change-implement ${changeInput} --resume to re-verify.${findings}`
  }

  if (postResult.phase === "verification-failed") {
    return `Next: fix verification failures, then run /zflow-change-implement ${changeInput} --resume.`
  }

  if (postResult.nextSteps.length > 0) {
    return `Next steps: ${postResult.nextSteps.map((s) => s.replace(/^\d+\.\s*/, "")).join("; ")}`
  }

  return `Next: inspect the run, then run /zflow-change-implement ${changeInput} --resume when ready.`
}

/**
 * Render a grid of subagent cards.
 *
 * Features:
 * - Variable-width rows: if a row has fewer cards than the max column count,
 *   cards expand to fill the available width evenly.
 * - Vertical spacing: a blank line separates each row for readability.
 */
function renderSubagentCards(subagents: WorkflowSubagentSnapshot[], width: number, theme: any): string[] {
  const available = Math.max(32, width - 2)
  const maxColumns = available >= 120 ? 3 : available >= 76 ? 2 : 1
  const gap = 2
  const ordered = [...subagents].sort((a, b) => subagentSortKey(a.id) - subagentSortKey(b.id) || a.id.localeCompare(b.id))
  const rendered: string[] = []

  for (let index = 0; index < ordered.length;) {
    const remainingCards = ordered.length - index
    const rowColumns = Math.min(maxColumns, remainingCards)
    const cardWidth = Math.max(32, Math.floor((available - (rowColumns - 1) * gap) / rowColumns))
    const rowSlice = ordered.slice(index, index + rowColumns)
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
    index += rowColumns
    if (index < ordered.length) {
      // Vertical spacer between rows
      rendered.push("")
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
      // Safety: enforce terminal width on every line to prevent TUI crashes
      return lines.map((line) => visualTruncate(line, width))
    },
  }
}

export function registerWorkflowProgressRenderer(pi: ExtensionAPI): void {
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

export function createWorkflowProgressIndicator(
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

  const activeAttentionSignals = new Map<string, string>()
  const seenIncomingAttentionKeys = new Set<string>()
  let lastAttentionNotice = ""

  const upsertAttentionCard = (message: string, status: "running" | "completed" | "failed" = "running"): void => {
    const current = workflowProgressSnapshots.get(id)
    const normalizedMessage = visualTruncate(message.replace(/\s+/g, " ").trim(), 200)
    if (!current || !normalizedMessage) return

    const currentPhaseCards = current.phaseCards ?? []
    const existing = currentPhaseCards.find((card) => card.id === WORKFLOW_ATTENTION_PHASE_CARD_ID)
    const nextCard: WorkflowPhaseCardSnapshot = {
      id: WORKFLOW_ATTENTION_PHASE_CARD_ID,
      title: "Coordination Attention",
      status,
      startedAt: existing?.startedAt ?? Date.now(),
      finishedAt: status === "running" ? undefined : existing?.finishedAt ?? Date.now(),
      messages: [...(existing?.messages ?? []), normalizedMessage].slice(-8),
    }
    const phaseCards = [...currentPhaseCards]
    const existingIdx = phaseCards.findIndex((card) => card.id === WORKFLOW_ATTENTION_PHASE_CARD_ID)
    if (existingIdx >= 0) phaseCards[existingIdx] = nextCard
    else phaseCards.push(nextCard)
    workflowProgressSnapshots.set(id, {
      ...current,
      lastMessage: normalizedMessage,
      updateCount: current.updateCount + 1,
      recentMessages: [...current.recentMessages, normalizedMessage].slice(-5),
      phaseCards,
    })
    if (normalizedMessage !== lastAttentionNotice) {
      lastAttentionNotice = normalizedMessage
      ui?.notify?.(normalizedMessage, status === "failed" ? "error" : "warning")
    }
    refreshProgressMessage()
  }

  const reconcileAttentionCard = (): void => {
    if (activeAttentionSignals.size > 0) {
      const latest = [...activeAttentionSignals.values()][activeAttentionSignals.size - 1]
      if (latest) upsertAttentionCard(latest, "running")
      return
    }

    const current = workflowProgressSnapshots.get(id)
    const existing = current?.phaseCards?.find((card) => card.id === WORKFLOW_ATTENTION_PHASE_CARD_ID)
    if (existing && existing.status === "running") {
      upsertAttentionCard("No active worker coordination signals.", "completed")
    }
  }

  const scanSessionAttention = (): void => {
    const entries = ctx.sessionManager?.getEntries?.() as SessionEntryLike[] | undefined
    if (!entries || entries.length === 0) return
    const recentEntries = entries.slice(-25)
    for (let index = 0; index < recentEntries.length; index++) {
      const entry = recentEntries[index]!
      const attention = detectIncomingWorkflowAttention(entry)
      if (!attention) continue
      const timestamp = typeof entry.message?.timestamp === "number" ? entry.message.timestamp : 0
      const key = `${entry.id ?? `recent-${index}`}:${timestamp}:${attention}`
      if (seenIncomingAttentionKeys.has(key)) continue
      seenIncomingAttentionKeys.add(key)
      upsertAttentionCard(attention, "running")
    }
  }

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
    scanSessionAttention()
    reconcileAttentionCard()
    render()
    refreshProgressMessage()
  }, 1000)

  return {
    update(message: string) {
      const current = workflowProgressSnapshots.get(id)
      const normalizedMessage = visualTruncate(message.replace(/\s+/g, " ").trim(), 140)
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
      const normalizedMessage = visualTruncate(message.replace(/\s+/g, " ").trim(), 200)
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
      let nextSubagentSnapshot: WorkflowSubagentSnapshot | undefined
      if (current) {
        const existing = current.subagents.find((subagent) => subagent.id === subagentId)
        const nextStatus = update.status ?? existing?.status ?? "running"
        const statusChanged = update.status !== undefined && update.status !== existing?.status
        const lastCommandChanged = update.lastCommand !== undefined && update.lastCommand !== existing?.lastCommand
        const startedAtChanged = update.startedAt !== undefined && update.startedAt !== existing?.startedAt
        // Logs: if caller provides logs, append them to existing logs, bounded at 6
        const existingLogs = existing?.logs ?? []
        const newLogs = update.logs
        const mergedLogs = newLogs !== undefined
          ? [...existingLogs, ...newLogs].slice(-6)
          : existingLogs
        const nextSubagent: WorkflowSubagentSnapshot = {
          id: subagentId,
          agent: update.agent ?? existing?.agent ?? subagentId,
          title: update.title ?? existing?.title,
          model: update.model ?? existing?.model,
          thinking: update.thinking ?? existing?.thinking,
          status: nextStatus,
          startedAt: update.startedAt ?? existing?.startedAt ?? Date.now(),
          finishedAt: update.finishedAt !== undefined
            ? update.finishedAt
            : isFinishedSubagentStatus(nextStatus)
              ? existing?.finishedAt ?? Date.now()
              : undefined,
          lastCommand: update.lastCommand ?? existing?.lastCommand,
          logs: mergedLogs,
          lastActivityAt: Date.now(),
        }
        nextSubagentSnapshot = nextSubagent
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
        shouldSendMessage = statusChanged || lastCommandChanged || startedAtChanged || (newLogs !== undefined && newLogs.length > 0)
      }

      if (nextSubagentSnapshot) {
        const attentionSignal = detectWorkflowAttentionSignal(nextSubagentSnapshot)
        const previousAttention = activeAttentionSignals.get(subagentId)
        if (attentionSignal) {
          activeAttentionSignals.set(subagentId, attentionSignal)
          if (attentionSignal !== previousAttention) {
            upsertAttentionCard(attentionSignal, "running")
          }
        } else if (previousAttention) {
          activeAttentionSignals.delete(subagentId)
          reconcileAttentionCard()
        }
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
