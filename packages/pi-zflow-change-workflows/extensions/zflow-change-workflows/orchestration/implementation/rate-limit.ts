import type {
  DispatchService,
  ParallelDispatchInput,
  ParallelDispatchResult,
  ParallelTaskInput,
} from "pi-zflow-core/dispatch-service"

const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000

export interface RateLimitRetryNotice {
  groupId: string
  attempt: number
  maxRetries: number
  waitMs: number
  error?: string
  message: string
  task: ParallelTaskInput
}

export interface DispatchParallelWithRateLimitRetriesOptions {
  dispatchService: DispatchService
  input: ParallelDispatchInput
  maxRetries?: number
  defaultWaitMs?: number
  sleep?: (ms: number) => Promise<void>
  onRateLimitNotice?: (notice: RateLimitRetryNotice) => void | Promise<void>
}

export interface DispatchParallelWithRateLimitRetriesResult extends ParallelDispatchResult {
  retryCounts: Record<string, number>
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

export async function dispatchParallelWithRateLimitRetries(
  options: DispatchParallelWithRateLimitRetriesOptions,
): Promise<DispatchParallelWithRateLimitRetriesResult> {
  const maxRetries = options.maxRetries ?? 3
  const defaultWaitMs = options.defaultWaitMs ?? DEFAULT_RATE_LIMIT_WAIT_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  type PendingEntry = {
    task: ParallelTaskInput
    index: number
    consecutiveRateLimitRetries: number
    totalRateLimitRetries: number
    sawProgressSinceRetry: boolean
    hadPriorRateLimit: boolean
    readyAt: number
  }

  const finalResults: Array<ParallelDispatchResult["results"][number] | undefined> = new Array(options.input.tasks.length)
  const retryCounts: Record<string, number> = {}
  let pending: PendingEntry[] = options.input.tasks.map((task, index) => ({
    task,
    index,
    consecutiveRateLimitRetries: 0,
    totalRateLimitRetries: 0,
    sawProgressSinceRetry: false,
    hadPriorRateLimit: false,
    readyAt: Date.now(),
  }))
  let serializeRetries = false

  while (pending.length > 0) {
    const dispatchEntries = serializeRetries
      ? [pending.shift()!]
      : pending.splice(0, pending.length)

    if (serializeRetries) {
      const waitMs = Math.max(0, dispatchEntries[0]!.readyAt - Date.now())
      if (waitMs > 0) await sleep(waitMs)
    }

    const tasksForDispatch = dispatchEntries.map((entry) => ({
      ...entry.task,
      onUpdate: (progress: Parameters<NonNullable<ParallelTaskInput["onUpdate"]>>[0]) => {
        entry.sawProgressSinceRetry = true
        entry.task.onUpdate?.(progress)
      },
    }))

    let dispatchResult: ParallelDispatchResult
    try {
      dispatchResult = await options.dispatchService.runParallel({
        ...options.input,
        tasks: tasksForDispatch,
        concurrency: serializeRetries ? 1 : options.input.concurrency,
      })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      dispatchResult = {
        ok: false,
        results: dispatchEntries.map((entry) => ({
          agent: entry.task.agent,
          groupId: entry.task.groupId,
          ok: false,
          rawOutput: "",
          error: errorMessage,
        })),
      }
    }

    const retryPending: PendingEntry[] = []

    for (let i = 0; i < dispatchResult.results.length; i++) {
      const result = dispatchResult.results[i]!
      const pendingEntry = dispatchEntries[i]!
      const groupId = pendingEntry.task.groupId ?? `task-${pendingEntry.index}`

      if (result.ok || !isRateLimitDispatchError(result.error)) {
        finalResults[pendingEntry.index] = result
        retryCounts[groupId] = pendingEntry.consecutiveRateLimitRetries
        continue
      }

      const burstRetriesUsed = pendingEntry.hadPriorRateLimit && pendingEntry.sawProgressSinceRetry
        ? 0
        : pendingEntry.consecutiveRateLimitRetries

      if (burstRetriesUsed >= maxRetries) {
        finalResults[pendingEntry.index] = {
          ...result,
          error: `${result.error ?? "429 rate limit exceeded."} (rate-limit retry budget exhausted after ${maxRetries} retries in the current burst)`,
        }
        retryCounts[groupId] = burstRetriesUsed
        continue
      }

      const nextRetryCount = burstRetriesUsed + 1
      const waitMs = extractRateLimitRetryDelayMs(result.error, defaultWaitMs)
      retryCounts[groupId] = nextRetryCount

      const message =
        `⚠️ Group ${groupId} hit a provider rate limit (429). ` +
        `Retry ${nextRetryCount}/${maxRetries} scheduled in ${formatRetryDelay(waitMs)}.`

      await options.onRateLimitNotice?.({
        groupId,
        attempt: nextRetryCount,
        maxRetries,
        waitMs,
        error: result.error,
        message,
        task: pendingEntry.task,
      })

      retryPending.push({
        ...pendingEntry,
        consecutiveRateLimitRetries: nextRetryCount,
        totalRateLimitRetries: pendingEntry.totalRateLimitRetries + 1,
        sawProgressSinceRetry: false,
        hadPriorRateLimit: true,
        readyAt: Date.now() + waitMs,
      })
    }

    if (retryPending.length > 0) {
      serializeRetries = true
      pending.push(...retryPending)
      pending.sort((a, b) => a.readyAt - b.readyAt || a.index - b.index)
      continue
    }

    if (pending.length === 0) {
      return {
        ok: finalResults.every((result) => result?.ok === true),
        results: finalResults as ParallelDispatchResult["results"],
        retryCounts,
      }
    }
  }

  return {
    ok: finalResults.every((result) => result?.ok === true),
    results: finalResults as ParallelDispatchResult["results"],
    retryCounts,
  }
}
