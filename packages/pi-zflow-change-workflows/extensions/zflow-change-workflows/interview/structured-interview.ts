/**
 * structured-interview.ts — adaptable interview helpers for human checkpoints.
 */

import { parseInterviewResponse } from "../orchestration.js"

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
      return { decision: "continue" }
    }
  } catch {
    // fall through
  }
  return { decision: "continue" }
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
export async function runStructuredInterview(
  ctx: InterviewableContext,
  questionsJson: string,
  fallbackMessage: string,
): Promise<{ decision: string; revisionNotes?: string; selectedFindings?: string[] } | null> {
  if (typeof ctx.interview === "function") {
    const raw = await Promise.resolve(ctx.interview(questionsJson))
    if (raw !== undefined) {
      return parseInterviewResponse(raw)
    }
  }

  if (typeof ctx.ui?.interview === "function") {
    const raw = await Promise.resolve(ctx.ui.interview(questionsJson))
    if (raw !== undefined) {
      return parseInterviewResponse(raw)
    }
  }

  const choice = extractFirstChoice(questionsJson)
  if (choice && typeof ctx.ui?.select === "function") {
    const selected = await ctx.ui.select(
      `${choice.title}: ${choice.question}`,
      choice.options,
    )
    const result = selectToDecision(selected, questionsJson)
    if (result) return result
  }

  if (typeof ctx.ui?.confirm === "function") {
    const ok = await ctx.ui.confirm(
      "Approve?",
      fallbackMessage,
    )
    return { decision: ok ? "approve" : "cancel" }
  }

  if (typeof ctx.ui?.notify === "function") {
    ctx.ui.notify(fallbackMessage, "info")
  }
  return { decision: "inspect" }
}
