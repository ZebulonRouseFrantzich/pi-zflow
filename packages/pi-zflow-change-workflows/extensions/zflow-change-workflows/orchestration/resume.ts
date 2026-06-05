/**
 * resume.ts — resume/recovery helpers for unfinished change workflows.
 */

/**
 * Resume context describing unfinished work for a given change.
 */
export interface ResumeContext {
  /** Change identifier */
  changeId: string
  /** Most recent run ID, if any */
  runId?: string
  /** Plan version, if known */
  planVersion?: string
  /** Last known phase of the workflow */
  lastPhase: string
  /** Available resume options */
  resumeOptions: string[]
  /** Human-readable details of unfinished entries */
  details: string
}

/**
 * Detect unfinished work and build a resume context.
 */
export async function detectResumeContext(
  changeId?: string,
  cwd?: string,
): Promise<ResumeContext | null> {
  const { listUnfinishedChanges, getChangeLifecycle } =
    await import("pi-zflow-artifacts/state-index")

  if (changeId) {
    const cl = await getChangeLifecycle(changeId, cwd)
    if (!cl || cl.unfinishedRuns.length === 0) return null

    const details = [
      `change ${cl.changeId}: ${cl.lastPhase} (${cl.unfinishedRuns.length} unfinished run(s))`,
      ...cl.unfinishedRuns.map((rid: string) => `  run ${rid}`),
      ...cl.retainedWorktrees.map((wt: string) => `  worktree: ${wt}`),
    ].join("\n")

    return {
      changeId: cl.changeId,
      lastPhase: cl.lastPhase,
      resumeOptions: ["resume", "abandon", "inspect", "cleanup"],
      details,
    }
  }

  const unfinished = await listUnfinishedChanges(cwd)
  if (unfinished.length === 0) return null

  const details = unfinished.map((cl) =>
    `change ${cl.changeId}: ${cl.lastPhase} (${cl.unfinishedRuns.length} unfinished run(s))`,
  ).join("\n")

  const first = unfinished[0]
  return {
    changeId: first.changeId,
    lastPhase: first.lastPhase,
    resumeOptions: ["resume", "abandon", "inspect", "cleanup"],
    details,
  }
}

/**
 * Resume a specific workflow from a saved state.
 */
export async function resumeWorkflow(
  changeId: string,
  runId: string,
  cwd?: string,
): Promise<{
  success: boolean
  message: string
  phase?: string
}> {
  const { readRun } = await import("pi-zflow-artifacts/run-state")

  try {
    const run = await readRun(runId, cwd)

    switch (run.phase) {
      case "pending":
      case "executing":
        return {
          success: true,
          message: `Resuming execution for ${changeId}`,
          phase: run.phase,
        }
      case "applying":
        return {
          success: true,
          message: `Resuming apply-back for ${changeId}`,
          phase: run.phase,
        }
      case "drift-pending":
        return {
          success: true,
          message: `Resuming drift resolution for ${changeId}`,
          phase: run.phase,
        }
      default:
        return {
          success: false,
          message: `Cannot resume run in phase "${run.phase}"`,
        }
    }
  } catch (err: unknown) {
    return {
      success: false,
      message: `Failed to read run: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Abandon a workflow and clean up its state.
 */
export async function abandonWorkflow(
  changeId: string,
  runId: string,
  cwd?: string,
): Promise<{ success: boolean; message: string }> {
  const { updateStateIndexEntry, getChangeLifecycle, upsertChangeLifecycle } = await import("pi-zflow-artifacts/state-index")

  try {
    await updateStateIndexEntry(runId, {
      status: "abandoned",
      metadata: { reason: "user-abandoned" },
    }, cwd)

    const lifecycle = await getChangeLifecycle(changeId, cwd)
    if (lifecycle) {
      const unfinishedRuns = lifecycle.unfinishedRuns.filter((id) => id !== runId)
      await upsertChangeLifecycle({
        ...lifecycle,
        unfinishedRuns,
        lastPhase: unfinishedRuns.length === 0 ? "cancelled" : lifecycle.lastPhase,
      }, cwd)
    }

    return {
      success: true,
      message: `Workflow ${changeId} / ${runId} abandoned.`,
    }
  } catch (err: unknown) {
    return {
      success: false,
      message: `Failed to abandon: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Build a resume prompt for the user describing the unfinished work.
 */
export function buildResumePrompt(context: ResumeContext): string {
  const lines = [
    "# Unfinished Work Detected",
    "",
    `Change: ${context.changeId}`,
    `Last phase: ${context.lastPhase}`,
    "",
    "## Details",
    context.details,
    "",
    "## Options",
    ...context.resumeOptions.map((o) => `- ${o}`),
    "",
    "What would you like to do?",
  ]

  return lines.join("\n")
}
