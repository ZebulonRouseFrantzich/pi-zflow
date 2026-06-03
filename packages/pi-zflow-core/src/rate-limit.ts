import type { AgentDispatchInput, AgentDispatchResult, DispatchService } from "./dispatch-service.js"

export const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000

export interface AgentRateLimitRetryNotice {
  agent: string
  attempt: number
  maxRetries: number
  waitMs: number
  error?: string
  message: string
  input: AgentDispatchInput
}

export interface RunAgentWithRateLimitRetriesOptions {
  dispatchService: DispatchService
  input: AgentDispatchInput
  maxRetries?: number
  defaultWaitMs?: number
  sleep?: (ms: number) => Promise<void>
  onRateLimitNotice?: (notice: AgentRateLimitRetryNotice) => void | Promise<void>
}

export interface RunAgentWithRateLimitRetriesResult extends AgentDispatchResult {
  retryCount: number
  totalRateLimitRetries: number
}

function durationTokenToMs(value: number, unit: string): number {
  const normalized = unit.toLowerCase()
  if (normalized.startsWith("day")) return value * 24 * 60 * 60 * 1000
  if (normalized.startsWith("hour") || normalized === "hr" || normalized === "hrs" || normalized === "h") return value * 60 * 60 * 1000
  if (normalized.startsWith("min") || normalized === "m") return value * 60 * 1000
  if (normalized.startsWith("sec") || normalized === "s") return value * 1000
  return 0
}

export function isRateLimitDispatchError(error: string | undefined): boolean {
  if (!error) return false
  return /\b429\b/i.test(error) || /rate limit/i.test(error) || /usage limit reached/i.test(error)
}

export function extractRateLimitWaitText(error: string | undefined): string | undefined {
  if (!error) return undefined
  const patterns = [
    /wait time:\s*([^.!?\n]+)/i,
    /resets?\s+in\s+([^.!?\n]+)/i,
    /retry(?:ing)?\s+after\s+([^.!?\n]+)/i,
    /retry(?:ing)?\s+in\s+([^.!?\n]+)/i,
    /try again in\s+([^.!?\n]+)/i,
    /wait\s+([^.!?\n]+?)\s+before/i,
  ]
  for (const pattern of patterns) {
    const match = error.match(pattern)
    const wait = match?.[1]?.trim()
    if (wait) return wait
  }
  return undefined
}

export function parseRetryDelayMs(waitText: string | undefined): number | undefined {
  if (!waitText) return undefined
  const text = waitText.trim().toLowerCase()
  if (!text) return undefined

  const colonMatch = text.match(/^(\d+):(\d{2})(?::(\d{2}))?$/)
  if (colonMatch) {
    const first = Number.parseInt(colonMatch[1]!, 10)
    const second = Number.parseInt(colonMatch[2]!, 10)
    const third = colonMatch[3] ? Number.parseInt(colonMatch[3], 10) : 0
    if (colonMatch[3]) {
      return ((first * 60 * 60) + (second * 60) + third) * 1000
    }
    return ((first * 60) + second) * 1000
  }

  let totalMs = 0
  const tokenPattern = /(\d+(?:\.\d+)?)\s*(days?|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\b/gi
  let match: RegExpExecArray | null
  while ((match = tokenPattern.exec(text)) !== null) {
    const value = Number.parseFloat(match[1]!)
    const unit = match[2]!
    totalMs += durationTokenToMs(value, unit)
  }

  if (totalMs > 0) return totalMs

  const numericOnly = Number.parseFloat(text)
  if (Number.isFinite(numericOnly) && numericOnly > 0) {
    return numericOnly * 1000
  }

  return undefined
}

export function extractRateLimitRetryDelayMs(
  error: string | undefined,
  defaultWaitMs: number = DEFAULT_RATE_LIMIT_WAIT_MS,
): number {
  const parsed = parseRetryDelayMs(extractRateLimitWaitText(error))
  return parsed && parsed > 0 ? parsed : defaultWaitMs
}

export function formatRetryDelay(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s"
  const totalSeconds = Math.round(ms / 1000)
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60

  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`)
  return parts.join(" ")
}

export async function runAgentWithRateLimitRetries(
  options: RunAgentWithRateLimitRetriesOptions,
): Promise<RunAgentWithRateLimitRetriesResult> {
  const maxRetries = options.maxRetries ?? 3
  const defaultWaitMs = options.defaultWaitMs ?? DEFAULT_RATE_LIMIT_WAIT_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  let consecutiveRateLimitRetries = 0
  let totalRateLimitRetries = 0
  let hadPriorRateLimit = false
  let sawProgressSinceRetry = false

  while (true) {
    const input: AgentDispatchInput = {
      ...options.input,
      onUpdate: (progress) => {
        sawProgressSinceRetry = true
        options.input.onUpdate?.(progress)
      },
    }

    let result: AgentDispatchResult
    try {
      result = await options.dispatchService.runAgent(input)
    } catch (err) {
      result = {
        ok: false,
        rawOutput: "",
        error: err instanceof Error ? err.message : String(err),
      }
    }

    if (result.ok || !isRateLimitDispatchError(result.error)) {
      return {
        ...result,
        retryCount: consecutiveRateLimitRetries,
        totalRateLimitRetries,
      }
    }

    const burstRetriesUsed = hadPriorRateLimit && sawProgressSinceRetry
      ? 0
      : consecutiveRateLimitRetries

    if (burstRetriesUsed >= maxRetries) {
      return {
        ...result,
        error: `${result.error ?? "429 rate limit exceeded."} (rate-limit retry budget exhausted after ${maxRetries} retries in the current burst)`,
        retryCount: burstRetriesUsed,
        totalRateLimitRetries,
      }
    }

    const nextRetryCount = burstRetriesUsed + 1
    const waitMs = extractRateLimitRetryDelayMs(result.error, defaultWaitMs)
    const message =
      `⚠️ Agent ${options.input.agent} hit a provider rate limit (429). ` +
      `Retry ${nextRetryCount}/${maxRetries} scheduled in ${formatRetryDelay(waitMs)}.`

    await options.onRateLimitNotice?.({
      agent: options.input.agent,
      attempt: nextRetryCount,
      maxRetries,
      waitMs,
      error: result.error,
      message,
      input: options.input,
    })

    await sleep(waitMs)
    consecutiveRateLimitRetries = nextRetryCount
    totalRateLimitRetries += 1
    hadPriorRateLimit = true
    sawProgressSinceRetry = false
  }
}
