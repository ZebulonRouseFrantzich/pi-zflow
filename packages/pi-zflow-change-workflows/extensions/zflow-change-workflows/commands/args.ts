/**
 * args.ts — command argument parsing and change-id derivation helpers.
 */

import { getZflowRegistry } from "pi-zflow-core/registry"

import { deriveSemanticChangeId } from "../orchestration.js"
import type { InterviewableContext } from "../interview/structured-interview.js"

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
 *
 * Always returns false — implementation is only started when the user
 * manually triggers `/zflow-change-implement`. The prepare workflow
 * creates and publishes plan artifacts, runs validation + review + approval,
 * but never launches implementation.
 */
export function shouldForkImplementationSessionAfterPrepare(): boolean {
  return false
}

/** Parsed arguments for `/zflow-change-plan`. */
export interface ParsedChangePlanArgs {
  changeSeed: string
  notes: string
  explicitReference: boolean
  depth: "dynamic" | "shallow" | "standard" | "deep" | "exhaustive"
}

const CHANGE_INTAKE_DEPTH_VALUES = new Set([
  "dynamic",
  "shallow",
  "standard",
  "deep",
  "exhaustive",
])

function stripDepthFlag(args: string): {
  remaining: string
  depth: "dynamic" | "shallow" | "standard" | "deep" | "exhaustive"
} {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const kept: string[] = []
  let depth: "dynamic" | "shallow" | "standard" | "deep" | "exhaustive" = "dynamic"

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === "--depth") {
      const candidate = (tokens[i + 1] ?? "").toLowerCase()
      if (CHANGE_INTAKE_DEPTH_VALUES.has(candidate)) {
        depth = candidate as typeof depth
        i += 1
        continue
      }
    }
    kept.push(token)
  }

  return {
    remaining: kept.join(" "),
    depth,
  }
}

function looksLikeChangePlanReference(value: string): boolean {
  return value.startsWith("@") ||
    value.includes("/") ||
    value.includes("\\") ||
    value.endsWith(".md") ||
    /^[a-z0-9][a-z0-9-]*$/.test(value)
}

function isStandaloneChangePlanReference(value: string): boolean {
  return !/\s/.test(value.trim()) && looksLikeChangePlanReference(value.trim())
}

export function extractChangePlanReference(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (isStandaloneChangePlanReference(trimmed)) {
    return trimmed.replace(/[),.;:]+$/g, "")
  }

  const tokens = trimmed.split(/\s+/)
  for (const token of tokens) {
    const normalized = token.replace(/^[('\"\[]+|[)'\"\],.;:]+$/g, "")
    if (!normalized) continue
    const tokenLooksPathLike = normalized.startsWith("@") ||
      normalized.includes("/") ||
      normalized.includes("\\") ||
      normalized.endsWith(".md")
    if (tokenLooksPathLike) {
      return normalized
    }
  }

  return null
}

const CHANGE_PLAN_DESCRIPTION_NOISE_TOKENS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "to",
  "from",
  "for",
  "of",
  "in",
  "on",
  "with",
  "without",
  "within",
  "under",
  "through",
  "across",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "s",
  "file",
  "files",
  "folder",
  "folders",
  "subfolder",
  "subfolders",
  "path",
  "paths",
  "include",
  "includes",
  "including",
  "add",
  "adds",
  "adding",
  "update",
  "updates",
  "updating",
  "create",
  "creates",
  "creating",
  "enable",
  "enables",
  "enabling",
  "support",
  "supports",
  "supporting",
])

export function deriveChangePlanId(changeSeed: string, explicitReference: boolean): string | null {
  if (explicitReference) {
    return deriveSemanticChangeId(changeSeed)
  }

  const referencedPath = extractChangePlanReference(changeSeed)
  if (referencedPath) {
    const fromReference = deriveSemanticChangeId(referencedPath)
    if (fromReference) return fromReference
  }

  const tokens = changeSeed
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .split("-")
    .filter(Boolean)

  const semanticTokens = tokens.filter((token) => !CHANGE_PLAN_DESCRIPTION_NOISE_TOKENS.has(token))
  const chosenTokens = (semanticTokens.length >= 2 ? semanticTokens : tokens).slice(0, 6)
  const slug = chosenTokens.join("-").slice(0, 72).replace(/-+$/g, "")
  return slug || deriveSemanticChangeId(changeSeed)
}

export function parseChangePlanArgs(args: string): ParsedChangePlanArgs {
  const stripped = stripDepthFlag(args)
  const trimmed = stripped.remaining.trim()
  if (!trimmed) {
    return {
      changeSeed: "",
      notes: "",
      explicitReference: false,
      depth: stripped.depth,
    }
  }

  const separatorIndex = trimmed.indexOf(" -- ")
  if (separatorIndex !== -1) {
    const changeSeed = trimmed.slice(0, separatorIndex).trim()
    const notes = trimmed.slice(separatorIndex + 4).trim()
    return {
      changeSeed,
      notes,
      explicitReference: looksLikeChangePlanReference(changeSeed),
      depth: stripped.depth,
    }
  }

  const parts = trimmed.split(/\s+/).filter(Boolean)
  const first = parts[0] ?? ""
  const rest = parts.slice(1).join(" ")
  if (first && rest && looksLikeChangePlanReference(first)) {
    return {
      changeSeed: first,
      notes: rest,
      explicitReference: true,
      depth: stripped.depth,
    }
  }

  if (isStandaloneChangePlanReference(trimmed)) {
    return {
      changeSeed: trimmed,
      notes: "",
      explicitReference: true,
      depth: stripped.depth,
    }
  }

  return {
    changeSeed: trimmed,
    notes: trimmed,
    explicitReference: false,
    depth: stripped.depth,
  }
}

function buildChangePlanInputQuestions(): string {
  return JSON.stringify({
    title: "Create Change Plan",
    description: "Describe the change you want zflow to plan. The command will explore the repository and draft a detailed durable plan.md file for your review.",
    questions: [
      {
        id: "changeDescription",
        type: "text",
        question: "Describe the change you want planned:",
      },
      {
        id: "preferredChangeId",
        type: "text",
        question: "Optional: enter a preferred change id / folder name (kebab-case). Leave blank to auto-derive one.",
      },
    ],
  })
}

export async function promptForChangePlanInput(
  ctx: InterviewableContext,
): Promise<{ changeDescription: string; preferredChangeId?: string } | null> {
  const questionsJson = buildChangePlanInputQuestions()
  let raw: string | undefined

  if (typeof ctx.interview === "function") {
    raw = await Promise.resolve(ctx.interview(questionsJson))
  } else if (typeof ctx.ui?.interview === "function") {
    raw = await Promise.resolve(ctx.ui.interview(questionsJson))
  } else {
    ctx.ui?.notify?.(
      "No interactive interview UI is available. Re-run /zflow-change-plan with a description.",
      "warning",
    )
    return null
  }

  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return {
      changeDescription: typeof parsed.changeDescription === "string" ? parsed.changeDescription.trim() : "",
      preferredChangeId: typeof parsed.preferredChangeId === "string" ? parsed.preferredChangeId.trim() : undefined,
    }
  } catch {
    ctx.ui?.notify?.("Could not parse change-plan interview response. Please try again.", "warning")
    return null
  }
}

/** Parsed arguments for `/zflow-change-prepare`. */
export interface ParsedChangePrepareArgs {
  changePath: string
  forceAdHoc: boolean
  notes: string
  depth: "dynamic" | "shallow" | "standard" | "deep" | "exhaustive"
}

/**
 * Parse `/zflow-change-prepare` arguments.
 *
 * The command's first token is the change document/path. Remaining text is
 * advisory notes. `--no-runecontext` or a note like "not a RuneContext" forces
 * normal ad-hoc change-doc handling.
 */
export function parseChangePrepareArgs(args: string): ParsedChangePrepareArgs {
  const stripped = stripDepthFlag(args)
  const parts = stripped.remaining.trim().split(/\s+/).filter(Boolean)
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

  return { changePath, forceAdHoc, notes, depth: stripped.depth }
}
