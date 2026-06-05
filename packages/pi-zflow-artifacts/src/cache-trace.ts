/**
 * cache-trace.ts — Redacted cache telemetry persistence helpers.
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"

import {
  classifyCacheHealth,
  type ZflowCacheSummary,
  type ZflowCacheTraceEntry,
} from "pi-zflow-core"

import {
  resolveCacheSummaryPath,
  resolveSessionCacheTracePath,
  resolveUserCacheTracePath,
} from "./cache-paths.js"

const writeQueues = new Map<string, Promise<void>>()

function queueWrite(filePath: string, task: () => Promise<void>): Promise<void> {
  const previous = writeQueues.get(filePath) ?? Promise.resolve()
  const next = previous
    .catch(() => {})
    .then(task)
    .finally(() => {
      if (writeQueues.get(filePath) === next) {
        writeQueues.delete(filePath)
      }
    })
  writeQueues.set(filePath, next)
  return next
}

async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf-8")
}

export async function appendCacheTraceEntry(
  entry: ZflowCacheTraceEntry,
  options?: { cwd?: string; includeUserTrace?: boolean },
): Promise<void> {
  const tracePath = resolveSessionCacheTracePath(options?.cwd)
  await queueWrite(tracePath, async () => {
    await appendJsonLine(tracePath, entry)
    if (options?.includeUserTrace) {
      await appendJsonLine(resolveUserCacheTracePath(), entry)
    }
    const existingSummary = await readCacheSummary(options?.cwd)
    const summary = existingSummary
      ? updateCacheSummary(existingSummary, entry)
      : buildCacheSummary([entry])
    await writeCacheSummary(summary, options?.cwd)
  })
}

export async function readSessionCacheTrace(cwd?: string): Promise<ZflowCacheTraceEntry[]> {
  const tracePath = resolveSessionCacheTracePath(cwd)
  try {
    const raw = await fs.readFile(tracePath, "utf-8")
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ZflowCacheTraceEntry)
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException
    if (nodeError.code === "ENOENT") return []
    throw error
  }
}

export async function writeCacheSummary(summary: ZflowCacheSummary, cwd?: string): Promise<void> {
  const summaryPath = resolveCacheSummaryPath(cwd)
  await fs.mkdir(path.dirname(summaryPath), { recursive: true })
  const tmpPath = `${summaryPath}.tmp`
  await fs.writeFile(tmpPath, JSON.stringify(summary, null, 2), "utf-8")
  await fs.rename(tmpPath, summaryPath)
}

export async function readCacheSummary(cwd?: string): Promise<ZflowCacheSummary | null> {
  const summaryPath = resolveCacheSummaryPath(cwd)
  try {
    const raw = await fs.readFile(summaryPath, "utf-8")
    return JSON.parse(raw) as ZflowCacheSummary
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException
    if (nodeError.code === "ENOENT") return null
    throw error
  }
}

export async function rebuildCacheSummary(cwd?: string): Promise<ZflowCacheSummary | null> {
  const entries = await readSessionCacheTrace(cwd)
  if (entries.length === 0) return null
  const summary = buildCacheSummary(entries)
  await writeCacheSummary(summary, cwd)
  return summary
}

export function buildCacheSummary(entries: ZflowCacheTraceEntry[]): ZflowCacheSummary {
  const latest = entries[entries.length - 1]!
  const total = entries.reduce((acc, entry) => {
    acc.cacheReadTokens += entry.cacheReadTokens ?? 0
    acc.cacheWriteTokens += entry.cacheWriteTokens ?? 0
    acc.inputTokens += entry.inputTokens ?? 0
    acc.outputTokens += entry.outputTokens ?? 0
    if (entry.cacheHitRate !== null) {
      acc.hitRateSum += entry.cacheHitRate
      acc.hitRateCount += 1
    }
    return acc
  }, {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    hitRateSum: 0,
    hitRateCount: 0,
  })

  return {
    sessionId: latest.sessionId,
    totalTurns: entries.length,
    provider: latest.provider,
    model: latest.model,
    stablePromptHash: latest.stablePromptHash,
    reminderHash: latest.reminderHash,
    cacheReadTokens: total.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens,
    inputTokens: total.inputTokens,
    outputTokens: total.outputTokens,
    averageCacheHitRate: total.hitRateCount > 0 ? total.hitRateSum / total.hitRateCount : null,
    hitRateSamples: total.hitRateCount,
    health: classifyCacheHealth(latest),
    lastRegressionCause: latest.regressionCause,
    lastUpdatedAt: latest.timestamp,
    compactionOccurredRecently: latest.compactionOccurredRecently,
  }
}

export function updateCacheSummary(
  summary: ZflowCacheSummary,
  entry: ZflowCacheTraceEntry,
): ZflowCacheSummary {
  const hitRateCountBefore = summary.hitRateSamples
  const hitRateSumBefore = summary.averageCacheHitRate === null
    ? 0
    : summary.averageCacheHitRate * hitRateCountBefore
  const hitRateCountAfter = hitRateCountBefore + (entry.cacheHitRate !== null ? 1 : 0)
  const hitRateSumAfter = hitRateSumBefore + (entry.cacheHitRate ?? 0)

  return {
    sessionId: entry.sessionId,
    totalTurns: summary.totalTurns + 1,
    provider: entry.provider,
    model: entry.model,
    stablePromptHash: entry.stablePromptHash,
    reminderHash: entry.reminderHash,
    cacheReadTokens: summary.cacheReadTokens + (entry.cacheReadTokens ?? 0),
    cacheWriteTokens: summary.cacheWriteTokens + (entry.cacheWriteTokens ?? 0),
    inputTokens: summary.inputTokens + (entry.inputTokens ?? 0),
    outputTokens: summary.outputTokens + (entry.outputTokens ?? 0),
    averageCacheHitRate: hitRateCountAfter > 0 ? hitRateSumAfter / hitRateCountAfter : null,
    hitRateSamples: hitRateCountAfter,
    health: classifyCacheHealth(entry),
    lastRegressionCause: entry.regressionCause,
    lastUpdatedAt: entry.timestamp,
    compactionOccurredRecently: entry.compactionOccurredRecently,
  }
}
