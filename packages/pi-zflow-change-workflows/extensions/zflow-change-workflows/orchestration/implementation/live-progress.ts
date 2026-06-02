import { readRun, updateRun } from "pi-zflow-artifacts"

export const GROUP_LEDGER_META_KEY = "groupLedger" as const
export const DISPATCH_PROGRESS_META_KEY = "dispatchProgress" as const

export interface PersistedDispatchProgress {
  activeWave?: number
  heartbeatCount?: number
  totalGroups?: number
  dispatchedGroups?: string[]
  completedGroups?: number
  elapsedSeconds?: number
  lastWorkflowUpdate?: string
  dispatchStartedAt?: string
  status?: "running" | "retrying" | "completed" | "failed"
  updatedAt?: string
}

export interface PersistedGroupProgressUpdate {
  status?: string
  agent?: string
  taskPrompt?: string
  model?: string
  thinking?: string
  lastCommand?: string
  currentTool?: string
  startedAt?: string
  lastProgressAt?: string
  retryCount?: number
  rateLimitRetryCount?: number
  failureKind?: string
}

export interface ImplementationDispatchSnapshot {
  groupUpdates?: Record<string, PersistedGroupProgressUpdate>
  dispatchProgress?: PersistedDispatchProgress
}

export async function persistImplementationDispatchSnapshot(
  runId: string,
  snapshot: ImplementationDispatchSnapshot,
  cwd?: string,
): Promise<void> {
  if (!snapshot.groupUpdates && !snapshot.dispatchProgress) return

  const run = await readRun(runId, cwd)
  const metadata = { ...(run.metadata ?? {}) } as Record<string, unknown>
  const now = new Date().toISOString()

  if (snapshot.groupUpdates && Object.keys(snapshot.groupUpdates).length > 0) {
    const existingLedger = {
      ...((metadata[GROUP_LEDGER_META_KEY] ?? {}) as Record<string, Record<string, unknown>>),
    }

    for (const [groupId, updates] of Object.entries(snapshot.groupUpdates)) {
      existingLedger[groupId] = {
        ...(existingLedger[groupId] ?? {}),
        ...updates,
        groupId,
        updatedAt: now,
      }
    }

    metadata[GROUP_LEDGER_META_KEY] = existingLedger
  }

  if (snapshot.dispatchProgress) {
    metadata[DISPATCH_PROGRESS_META_KEY] = {
      ...((metadata[DISPATCH_PROGRESS_META_KEY] ?? {}) as Record<string, unknown>),
      ...snapshot.dispatchProgress,
      updatedAt: now,
    }
  }

  await updateRun(runId, { metadata } as any, cwd)
}
