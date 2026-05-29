/**
 * unfinished-work.ts — shared unfinished-run discovery helpers.
 */

/**
 * Discover unfinished work for a given change ID.
 *
 * Loads the state index and filters entries whose `metadata.changeId`
 * matches the given changeId. Returns arrays of unfinished runs and
 * plans, plus a convenience boolean.
 *
 * @param changeId - The change identifier to look up.
 * @param cwd - Working directory (optional).
 * @returns Object with unfinished runs, unfinished plans, and a convenience boolean.
 */
export async function discoverUnfinishedWork(
  changeId: string,
  cwd?: string,
): Promise<{
  unfinishedRuns: string[]
  unfinishedPlans: string[]
  hasUnfinishedWork: boolean
}> {
  const { getChangeLifecycle } = await import("pi-zflow-artifacts/state-index")

  const cl = await getChangeLifecycle(changeId, cwd)

  if (!cl || cl.unfinishedRuns.length === 0) {
    return {
      unfinishedRuns: [],
      unfinishedPlans: [],
      hasUnfinishedWork: false,
    }
  }

  return {
    unfinishedRuns: cl.unfinishedRuns,
    unfinishedPlans: [],
    hasUnfinishedWork: true,
  }
}

/**
 * Produce a human-readable summary of unfinished work for a change.
 *
 * Lists each unfinished run with its ID, followed by suggested next actions.
 *
 * @param unfinished - The result of `discoverUnfinishedWork()`.
 * @returns A formatted string describing the unfinished work.
 */
export function promptResumeChoices(unfinished: {
  unfinishedRuns: string[]
  unfinishedPlans: string[]
  hasUnfinishedWork: boolean
}): string {
  const lines: string[] = []

  const allUnfinished = [
    ...unfinished.unfinishedPlans.map((id) => ({ _label: "plan", id })),
    ...unfinished.unfinishedRuns.map((id) => ({ _label: "run", id })),
  ]

  if (allUnfinished.length === 0) {
    return "No unfinished work found for this change."
  }

  lines.push("## Unfinished work detected")
  lines.push("")
  lines.push("| Type | ID |")
  lines.push("|------|----|")
  for (const entry of allUnfinished) {
    lines.push(`| ${entry._label} | ${entry.id} |`)
  }
  lines.push("")
  lines.push("### Available actions")
  lines.push("")
  lines.push("- `resume` — Continue the most recent unfinished run/plan")
  lines.push("- `abandon` — Mark unfinished work as cancelled and start fresh")
  lines.push("- `inspect` — Show detailed state of each unfinished item")
  lines.push("- `cleanup` — Remove stale artifacts associated with unfinished work")
  lines.push("")
  lines.push("Enter one of the above to proceed, or `skip` to ignore and continue.")

  return lines.join("\n")
}

/**
 * Structured result returned by `checkUnfinishedOnEntry` when unfinished
 * work exists for a change.
 */
export interface UnfinishedOnEntryResult {
  /** Whether unfinished work was found. */
  hasUnfinishedWork: boolean
  /** The change identifier with unfinished work. */
  changeId: string
  /** Last known phase of the change. */
  lastPhase: string
  /** Unfinished run IDs. */
  unfinishedRunIds: string[]
  /** Retained worktree paths. */
  retainedWorktrees: string[]
  /** Available user-facing choices. */
  choices: Array<{
    action: "resume" | "abandon" | "inspect" | "cleanup"
    description: string
  }>
  /** Human-readable summary for display. */
  summary: string
}

/**
 * Check for unfinished work on entry to a change workflow command.
 *
 * Looks up the change lifecycle in the state-index `changes` map. If
 * unfinished runs exist, returns structured choices with context so
 * the caller can present them to the user via `ui.notify` or similar.
 *
 * @param changeId - The change identifier to check.
 * @param cwd - Working directory (optional).
 * @returns An `UnfinishedOnEntryResult` if unfinished work exists, or a
 *          result with `hasUnfinishedWork: false`.
 */
export async function checkUnfinishedOnEntry(
  changeId: string,
  cwd?: string,
): Promise<UnfinishedOnEntryResult> {
  const { getChangeLifecycle } = await import("pi-zflow-artifacts/state-index")

  const cl = await getChangeLifecycle(changeId, cwd)

  if (!cl || cl.unfinishedRuns.length === 0) {
    return {
      hasUnfinishedWork: false,
      changeId,
      lastPhase: "none",
      unfinishedRunIds: [],
      retainedWorktrees: [],
      choices: [],
      summary: `No unfinished work for change "${changeId}".`,
    }
  }

  const summary = [
    `Change: ${cl.changeId}`,
    `Last phase: ${cl.lastPhase}`,
    `Unfinished runs: ${cl.unfinishedRuns.join(", ") || "(none)"}`,
    cl.retainedWorktrees.length > 0
      ? `Retained worktrees: ${cl.retainedWorktrees.join(", ")}`
      : "",
  ].filter(Boolean).join("\n")

  return {
    hasUnfinishedWork: true,
    changeId: cl.changeId,
    lastPhase: cl.lastPhase,
    unfinishedRunIds: cl.unfinishedRuns,
    retainedWorktrees: cl.retainedWorktrees,
    choices: [
      { action: "resume", description: "Continue the most recent unfinished run" },
      { action: "abandon", description: "Mark unfinished work as cancelled and start fresh" },
      { action: "inspect", description: "Show detailed state of each unfinished item" },
      { action: "cleanup", description: "Remove stale artifacts associated with unfinished work" },
    ],
    summary,
  }
}
