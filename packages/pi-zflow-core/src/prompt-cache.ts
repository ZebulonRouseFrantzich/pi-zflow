/**
 * prompt-cache.ts — Stable prompt normalization, fingerprinting, and
 * redacted cache telemetry types.
 */

import { createHash } from "node:crypto"

export interface ZflowPromptFingerprint {
  agentName: string
  mode: string | null
  profileName: string | null
  stableFragmentIds: string[]
  skillIds: string[]
  toolSurfaceHash: string | null
  docsSectionHash: string | null
  stablePromptHash: string
}

export type ZflowCacheRegressionCause =
  | "model-changed"
  | "provider-changed"
  | "stable-prompt-changed"
  | "mode-changed"
  | "compaction-recent"
  | "idle-gap-exceeded"
  | "large-tool-payload"
  | "diagnostic-injection-changed"
  | "unknown"

export type ZflowCacheHealth = "healthy" | "warming" | "degraded" | "unknown"

export interface ZflowCacheTraceEntry {
  sessionId: string
  turnId: string
  timestamp: string
  cwdHash: string
  workflowMode: string | null
  agentName: string | null
  profileName: string | null
  provider: string | null
  model: string | null
  stablePromptHash: string | null
  reminderHash: string | null
  contextUsagePercent: number | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  cacheHitRate: number | null
  compactionOccurredRecently: boolean
  promptFingerprintChanged: boolean
  modelChanged: boolean
  modeChanged: boolean
  toolBurstHint: boolean
  regressionCause: ZflowCacheRegressionCause | null
}

export interface ZflowCacheSummary {
  sessionId: string
  totalTurns: number
  provider: string | null
  model: string | null
  stablePromptHash: string | null
  reminderHash: string | null
  cacheReadTokens: number
  cacheWriteTokens: number
  inputTokens: number
  outputTokens: number
  averageCacheHitRate: number | null
  hitRateSamples: number
  health: ZflowCacheHealth
  lastRegressionCause: ZflowCacheRegressionCause | null
  lastUpdatedAt: string
  compactionOccurredRecently: boolean
}

export interface BuildPromptFingerprintInput {
  agentName: string
  mode?: string | null
  profileName?: string | null
  stableFragmentIds?: string[]
  skillIds?: string[]
  toolSurface?: string[] | string | null
  docsSectionText?: string | null
  stablePrompt: string
}

export function normalizePromptText(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function sortAndNormalizeList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => normalizePromptText(value).trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b))
}

export function hashNormalizedText(input: string | null | undefined): string | null {
  if (!input) return null
  const normalized = normalizePromptText(input)
  if (!normalized) return null
  return createHash("sha256").update(normalized).digest("hex")
}

function hashToolSurface(toolSurface?: string[] | string | null): string | null {
  if (!toolSurface) return null
  const tools = Array.isArray(toolSurface)
    ? sortAndNormalizeList(toolSurface)
    : sortAndNormalizeList(toolSurface.split(","))
  if (tools.length === 0) return null
  return hashNormalizedText(tools.join("\n"))
}

export function buildPromptFingerprint(input: BuildPromptFingerprintInput): ZflowPromptFingerprint {
  return {
    agentName: input.agentName,
    mode: input.mode ?? null,
    profileName: input.profileName ?? null,
    stableFragmentIds: sortAndNormalizeList(input.stableFragmentIds),
    skillIds: sortAndNormalizeList(input.skillIds),
    toolSurfaceHash: hashToolSurface(input.toolSurface),
    docsSectionHash: hashNormalizedText(input.docsSectionText ?? null),
    stablePromptHash: hashNormalizedText(input.stablePrompt) ?? hashNormalizedText("<empty>")!,
  }
}

export function calculateCacheHitRate(inputTokens: number | null, cacheReadTokens: number | null): number | null {
  if (inputTokens === null || cacheReadTokens === null) return null
  return cacheReadTokens / Math.max(inputTokens, 1)
}

export function classifyCacheHealth(entry: Pick<ZflowCacheTraceEntry, "cacheHitRate" | "cacheReadTokens" | "inputTokens">): ZflowCacheHealth {
  if (entry.cacheHitRate !== null) {
    if (entry.cacheHitRate >= 0.5) return "healthy"
    if (entry.cacheHitRate >= 0.1) return "warming"
    return "degraded"
  }

  if (entry.cacheReadTokens !== null && entry.cacheReadTokens > 0) {
    return "warming"
  }

  if (entry.inputTokens !== null && entry.inputTokens > 0) {
    return "unknown"
  }

  return "unknown"
}

export function inferRegressionCause(
  current: Pick<ZflowCacheTraceEntry, "modelChanged" | "modeChanged" | "promptFingerprintChanged" | "compactionOccurredRecently" | "cacheHitRate">,
  previous?: Pick<ZflowCacheTraceEntry, "cacheHitRate"> | null,
): ZflowCacheRegressionCause | null {
  if (current.modelChanged) return "model-changed"
  if (current.modeChanged) return "mode-changed"
  if (current.promptFingerprintChanged) return "stable-prompt-changed"
  if (current.compactionOccurredRecently) return "compaction-recent"
  if (
    previous?.cacheHitRate !== null &&
    previous?.cacheHitRate !== undefined &&
    current.cacheHitRate !== null &&
    current.cacheHitRate < previous.cacheHitRate - 0.2
  ) {
    return "unknown"
  }
  return null
}

export function shortHash(hash: string | null | undefined, length: number = 12): string {
  if (!hash) return "unknown"
  return hash.slice(0, Math.max(4, length))
}
