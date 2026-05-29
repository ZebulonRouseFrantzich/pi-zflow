import { readRun, setRunPhase } from "pi-zflow-artifacts"
import type { RetainedArtifact } from "pi-zflow-artifacts"

import type { DispatchExecutionGroup } from "../execution-groups.js"
import { buildWorkerTask } from "../worktree-task.js"
import type {
  WorktreeGroupTask,
  WorktreeDispatchConfig,
} from "../worktree-task.js"

/**
 * Build a parallel worktree dispatch plan from execution groups.
 *
 * Returns an array of `WorktreeGroupTask` objects that can be passed to
 * `subagents.parallel({ worktree: true, tasks: [...] })`.
 */
export function buildWorktreeDispatchPlan(
  groups: DispatchExecutionGroup[],
  config: WorktreeDispatchConfig,
  planArtifactPaths?: Record<string, string>,
): WorktreeGroupTask[] {
  return groups.map((group) => ({
    groupId: group.id,
    agent: group.agent,
    task: buildWorkerTask(group, config, planArtifactPaths),
    claimedFiles: group.files,
    dependencies: group.dependencies,
    worktreeStrategy: {
      mode: group.executionMode ?? "isolated",
      workspaceId: group.workspaceId,
      workspaceConcurrency: group.workspaceConcurrency ?? "serialized",
      baseStrategy: group.baseStrategy ?? "head",
      executionRationale: group.executionRationale,
    },
    scopedVerification: group.scopedVerification,
    outputRelativePath: `worktree-results/${group.id}-result.md`,
  }))
}

/**
 * Signal that a deviation (plan drift) has been detected.
 */
export async function signalDriftDetected(
  runId: string,
  groupId: string,
  workerName: string,
  deviationPath?: string,
  cwd?: string,
  orchestratorTarget?: string,
): Promise<void> {
  await setRunPhase(runId, "drift-pending", cwd)

  let intercomAvailable = false
  const resolvedTarget = orchestratorTarget?.trim()
    || process.env.ZFLOW_INTERCOM_ORCHESTRATOR_TARGET?.trim()
    || process.env.PI_INTERCOM_ORCHESTRATOR_TARGET?.trim()

  try {
    // @ts-expect-error - optional dependency, handled via catch
    const intercomModule: { intercom?: Function } | null = await import("pi-intercom").catch(() => null)
    if (intercomModule && typeof intercomModule.intercom === "function" && resolvedTarget) {
      intercomAvailable = true
      const msg = [
        `DRIFT DETECTED: Group "${groupId}" (worker: ${workerName})`,
        deviationPath ? `Deviation report: ${deviationPath}` : "",
        "",
        "The approved plan is infeasible for this group.",
        "Pending deviation reports should be synthesized for replanning.",
        "Halting new dependent dispatch until drift is resolved.",
      ].filter(Boolean).join("\n")

      await intercomModule.intercom({
        action: "send",
        to: resolvedTarget,
        message: msg,
      })
    }
  } catch {
    // intercom not available — fallback is acceptable
  }

  if (!intercomAvailable) {
    const reason = resolvedTarget
      ? "pi-intercom not available"
      : "no intercom target available"
    console.warn(
      `[pi-zflow] ${reason}. Drift signal suppressed for group "${groupId}". ` +
      "Workers will still write deviation reports. Run marked as drift-pending.",
    )
  }
}

/**
 * List all retained artifacts for a run.
 */
export async function listRetainedArtifacts(
  runId: string,
  cwd?: string,
): Promise<RetainedArtifact[]> {
  const run = await readRun(runId, cwd)
  return run.retainedArtifacts ?? []
}
