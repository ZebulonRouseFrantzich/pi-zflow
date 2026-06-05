import { addRetainedArtifact, createRun, readRun, updateRun } from "pi-zflow-artifacts"
import type { RunJson } from "pi-zflow-artifacts"
import { resolveRunDir } from "pi-zflow-artifacts/artifact-paths"
import { addStateIndexEntry, updateStateIndexEntry } from "pi-zflow-artifacts/state-index"

import { executeApplyBack } from "../../apply-back.js"
import type { CascadeApplyBackResult } from "../../apply-back.js"
import { readDeviationReports, synthesizeDeviationSummary, writeDeviationSummary } from "../../deviations.js"
import { assertCleanPrimaryTree } from "../../git-preflight.js"
import type { GitPreflightResult } from "../../git-preflight.js"
import type { GroupResult } from "../../group-result.js"
import type { ExecutionGroup, OwnershipValidationResult } from "../../ownership-validator.js"
import { topoSortGroups, validateOwnershipAndDependencies } from "../../ownership-validator.js"
import { coalesceConnectedGroups } from "../execution-groups.js"
import type { DispatchExecutionGroup } from "../execution-groups.js"
import { buildWorktreeDispatchPlan } from "./dispatch-plan.js"
import type { WorktreeDispatchConfig, WorktreeGroupTask } from "../worktree-task.js"

/**
 * A complete plan for executing a worktree implementation run.
 */
export interface WorktreeImplementationRunPlan {
  runId: string
  config: WorktreeDispatchConfig
  tasks: WorktreeGroupTask[]
  groups: ExecutionGroup[]
  plannedPaths: Set<string>
  preflight: GitPreflightResult
  ownershipValidation: OwnershipValidationResult
  run: RunJson
  executionPlan: {
    parallelBatches: ExecutionGroup[][]
    sequentialGroups: ExecutionGroup[]
  }
}

/**
 * Prepare a complete worktree implementation run.
 */
export async function prepareWorktreeImplementationRun(
  changeId: string,
  planVersion: string,
  groups: ExecutionGroup[],
  planArtifactPaths?: Record<string, string>,
  options?: {
    cwd?: string
    plannedPaths?: Set<string>
    repoRoot?: string
    orchestratorTarget?: string
    runId?: string
    force?: boolean
  },
): Promise<WorktreeImplementationRunPlan> {
  const cwd = options?.cwd
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const execFileAsync = promisify(execFile)

  let repoRoot: string
  if (options?.repoRoot) {
    repoRoot = options.repoRoot
  } else {
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"])
      repoRoot = stdout.trim()
    } catch {
      throw new Error("Not a git repository — cannot run worktree implementation.")
    }
  }

  const plannedPaths = options?.plannedPaths ?? new Set<string>()
  if (!options?.plannedPaths) {
    for (const group of groups) {
      for (const file of group.files) {
        plannedPaths.add(file)
      }
    }
  }

  let preflight: GitPreflightResult
  if (options?.force) {
    preflight = {
      clean: true,
      trackedChanges: [],
      untracked: [],
      overlappingUntracked: [],
      summary: "Skipped due to --force.",
      headSha: "",
      branch: "",
    }
  } else {
    preflight = assertCleanPrimaryTree(repoRoot, plannedPaths)
    if (!preflight.clean) {
      throw new Error(
        `Worktree implementation preflight failed.\n${preflight.summary}`,
      )
    }
  }

  const ownershipValidation = validateOwnershipAndDependencies(groups)
  if (!ownershipValidation.valid) {
    throw new Error(
      `Ownership/dependency validation failed:\n${ownershipValidation.summary}`,
    )
  }

  const runId = options?.runId ?? `impl-${changeId}-${Date.now().toString(36)}`
  let run: RunJson
  if (options?.runId) {
    const existingRun = await readRun(options.runId, cwd).catch(() => null)
    if (!existingRun) {
      throw new Error(
        `Caller provided runId "${options.runId}" but run.json does not exist. ` +
        "The caller must create the run before calling prepareWorktreeImplementationRun " +
        "when passing a specific runId.",
      )
    }
    run = existingRun
  } else {
    run = await createRun(runId, repoRoot, changeId, planVersion, cwd)

    await addStateIndexEntry({
      type: "run",
      id: runId,
      status: "preparing",
      metadata: {
        changeId,
        planVersion,
        repoRoot,
        groupCount: groups.length,
      },
    }, cwd)
  }

  const parallelBatches: ExecutionGroup[][] = []
  const sequentialGroups: ExecutionGroup[] = []
  const sequentialIds = new Set<string>()

  for (const batch of ownershipValidation.sequentialGroups) {
    for (const id of batch) {
      sequentialIds.add(id)
    }
  }

  for (const group of groups) {
    if (group.dependencies.length > 0) {
      sequentialIds.add(group.id)
    }
  }

  const parallelGroupIds = groups
    .filter((group) => !sequentialIds.has(group.id))
    .map((group) => group.id)

  if (parallelGroupIds.length > 0) {
    parallelBatches.push(
      groups.filter((group) => parallelGroupIds.includes(group.id)),
    )
  }

  const sequentialIdsSet = new Set(sequentialIds)
  const sequentialOnly = groups.filter((group) => sequentialIdsSet.has(group.id))
  if (sequentialOnly.length > 0) {
    const orderedSequential = topoSortGroups(sequentialOnly) ?? sequentialOnly.map((group) => group.id)
    const seqGroupMap = new Map(groups.map((group) => [group.id, group]))
    for (const id of orderedSequential) {
      const group = seqGroupMap.get(id)
      if (group) sequentialGroups.push(group)
    }
  }

  const dispatchConfig: WorktreeDispatchConfig = {
    runId,
    repoRoot,
    changeId,
    planVersion,
    orchestratorTarget: options?.orchestratorTarget,
  }

  const dispatchGroups: DispatchExecutionGroup[] = groups.map((group) => ({
    id: group.id,
    agent: group.agent || "zflow.implement-routine",
    files: group.files,
    dependencies: group.dependencies,
    taskPrompt: group.taskPrompt,
    scopedVerification: group.scopedVerification,
    parallelizable: group.parallelizable,
    executionMode: (group as DispatchExecutionGroup).executionMode ?? "isolated",
    workspaceId: (group as DispatchExecutionGroup).workspaceId,
    workspaceConcurrency: (group as DispatchExecutionGroup).workspaceConcurrency ?? "serialized",
    baseStrategy: (group as DispatchExecutionGroup).baseStrategy ?? "head",
    executionRationale: (group as DispatchExecutionGroup).executionRationale,
  }))

  const coalescedGroups = coalesceConnectedGroups(dispatchGroups)
  const tasks = buildWorktreeDispatchPlan(coalescedGroups, dispatchConfig, planArtifactPaths)
  const planGroups = coalescedGroups.map((group) => ({
    id: group.id,
    files: group.files,
    dependencies: group.dependencies,
    parallelizable: true,
    taskPrompt: group.taskPrompt,
    scopedVerification: group.scopedVerification,
    agent: group.agent,
    coalescedFrom: group.coalescedFrom,
    executionMode: group.executionMode,
    workspaceId: group.workspaceId,
    workspaceConcurrency: group.workspaceConcurrency,
    baseStrategy: group.baseStrategy,
    executionRationale: group.executionRationale,
  })) as unknown as ExecutionGroup[]

  const workspaceClusters = coalescedGroups
    .filter((group) => group.executionMode === "shared-staging" && group.workspaceId)
    .reduce<Array<RunJson["workspaceClusters"][number]>>((clusters, group) => {
      const existing = clusters.find((cluster) => cluster.workspaceId === group.workspaceId)
      if (existing) {
        existing.groupIds.push(group.id)
        existing.updatedAt = new Date().toISOString()
        return clusters
      }

      clusters.push({
        workspaceId: group.workspaceId!,
        mode: "shared-staging",
        workspaceConcurrency: group.workspaceConcurrency ?? "serialized",
        groupIds: [group.id],
        status: "planned",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      return clusters
    }, [])

  if (workspaceClusters.length > 0) {
    run = await updateRun(runId, { workspaceClusters }, cwd)
  }

  return {
    runId,
    config: dispatchConfig,
    tasks,
    groups: planGroups,
    plannedPaths,
    preflight,
    ownershipValidation,
    run,
    executionPlan: {
      parallelBatches,
      sequentialGroups,
    },
  }
}

/**
 * Finalize a worktree implementation run after worker dispatch.
 */
export async function finalizeWorktreeImplementationRun(
  runId: string,
  _groupResults: GroupResult[],
  options?: {
    cwd?: string
    changeId?: string
    planVersion?: string
    retainOnFailure?: boolean
    executionGroups?: ExecutionGroup[]
    useStrategyCascade?: boolean
    skipIntegrationMerge?: boolean
  },
): Promise<CascadeApplyBackResult & { deviationSummaryPath?: string }> {
  const cwd = options?.cwd
  const { join } = await import("node:path")

  let run: RunJson
  try {
    run = await readRun(runId, cwd)
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException
    if (nodeError?.code === "ENOENT") {
      throw new Error(`Run "${runId}" not found. Cannot finalize.`)
    }
    throw new Error(
      `Run "${runId}" is malformed or unreadable. Cannot finalize. ` +
      `${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const repoRoot = run.repoRoot
  const changeId = options?.changeId ?? run.changeId
  const planVersion = options?.planVersion ?? run.planVersion

  let deviationSummaryPath: string | undefined
  try {
    const reports = await readDeviationReports(changeId, planVersion, cwd)
    if (reports.length > 0) {
      const summary = synthesizeDeviationSummary(runId, changeId, planVersion, reports)
      deviationSummaryPath = await writeDeviationSummary(summary, cwd)
    }
  } catch {
    // Ignore errors reading deviations
  }

  const applyBackGroups: ExecutionGroup[] = options?.executionGroups && options.executionGroups.length > 0
    ? options.executionGroups.map((group) => ({
        id: group.id,
        files: group.files,
        dependencies: group.dependencies,
        parallelizable: group.parallelizable,
      }))
    : run.groups.map((group) => ({
        id: group.groupId,
        files: group.changedFiles,
        dependencies: [],
        parallelizable: true,
      }))

  const applyBackResult = await executeApplyBack({
    runId,
    repoRoot,
    snapshot: run.preApplySnapshot!,
    groups: applyBackGroups,
    cwd,
    useCascade: options?.useStrategyCascade ?? true,
    preferSubagentOverIntegrationMerge: options?.skipIntegrationMerge ?? false,
  })

  if (!applyBackResult.success && options?.retainOnFailure !== false) {
    const patchesDir = join(resolveRunDir(runId, cwd), "patches")
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()

    await addRetainedArtifact(runId, {
      type: "patch",
      path: patchesDir,
      reason: applyBackResult.error
        ? `Apply-back failed: ${applyBackResult.error}`
        : "Apply-back failed",
      expiresAt,
    }, cwd)

    if (applyBackResult.integrationWorktreePath) {
      await addRetainedArtifact(runId, {
        type: "worktree",
        path: applyBackResult.integrationWorktreePath,
        reason: "Integration worktree from apply-back cascade",
        expiresAt,
      }, cwd)
    }

    if (applyBackResult.consolidatedPatchPath) {
      await addRetainedArtifact(runId, {
        type: "patch",
        path: applyBackResult.consolidatedPatchPath,
        reason: "Consolidated patch from integration merge",
        expiresAt,
      }, cwd)
    }

    if (applyBackResult.subagentAvailable) {
      const runState = await readRun(runId, cwd)
      await updateRun(runId, {
        metadata: {
          ...(runState.metadata ?? {}),
          subagentResolutionAvailable: true,
          strategiesAttempted: applyBackResult.strategiesAttempted,
          subagentResolutionPrompt: [
            "All automated apply-back strategies failed.",
            "A subagent can attempt to resolve the remaining conflicts",
            "with full context about each group's original task.",
            "",
            "To request subagent resolution, run:",
            `  /zflow-resolve-apply-back ${runId}`,
            "",
            "To resolve manually:",
            "1. Inspect the integration worktree or patches in the run directory.",
            "2. Resolve remaining conflicts.",
            "3. Run the workflow with --resume.",
          ].join("\n"),
        },
      }, cwd)
    }
  }

  try {
    await updateStateIndexEntry(runId, {
      status: applyBackResult.success ? "completed" : "failed",
      metadata: {
        groupsApplied: applyBackResult.groupsApplied,
        totalGroups: applyBackResult.totalGroups,
        error: applyBackResult.error,
        successfulStrategy: applyBackResult.successfulStrategy,
        strategiesAttempted: applyBackResult.strategiesAttempted,
        subagentAvailable: applyBackResult.subagentAvailable,
      },
    }, cwd)
  } catch {
    // State index entry may not exist yet; that's OK
  }

  return {
    ...applyBackResult,
    deviationSummaryPath,
  }
}

/**
 * Apply patches from a run's group ledger using the smart apply-back cascade.
 */
export async function applyPatchesWithLedger(
  runId: string,
  cwd?: string,
  options?: {
    applyAll?: boolean
    applyOnly?: string[]
    onProgress?: (message: string) => void
  },
): Promise<CascadeApplyBackResult> {
  const run = await readRun(runId, cwd).catch(() => {
    throw new Error(`Run "${runId}" not found. Cannot apply patches.`)
  })

  const repoRoot = run.repoRoot
  const ledger = (run.metadata?.groupLedger ?? {}) as Record<string, { dependencies?: string[] }>
  const allGroups: ExecutionGroup[] = run.groups.map((group) => ({
    id: group.groupId,
    files: group.changedFiles,
    dependencies: Array.isArray(ledger[group.groupId]?.dependencies)
      ? ledger[group.groupId]!.dependencies!
      : [],
    parallelizable: true,
  }))

  const applyOnly = options?.applyOnly
  const applyBackGroups = applyOnly
    ? allGroups.filter((group) => applyOnly.includes(group.id))
    : allGroups
  const applyAll = options?.applyAll ?? true

  if (applyAll) {
    options?.onProgress?.(`Applying ${applyBackGroups.length} group(s) via smart apply-back cascade.`)
  }

  const snapshot = run.preApplySnapshot ?? await (async () => {
    const recoveryRef = `refs/zflow/recovery/${runId}`
    const snap = {
      head: run.head,
      indexState: "clean",
      recoveryRef,
    }
    await updateRun(runId, { preApplySnapshot: snap }, cwd)
    return snap
  })()

  const result = await executeApplyBack({
    runId,
    repoRoot,
    snapshot,
    groups: applyBackGroups,
    cwd,
    useCascade: true,
  })

  options?.onProgress?.(
    result.success
      ? `Apply-back completed: ${result.groupsApplied} group(s) applied via "${result.successfulStrategy ?? "patch-replay"}" strategy.`
      : `Apply-back incomplete: ${result.groupsApplied}/${result.totalGroups} group(s) applied. ${result.error ?? "Unknown error"}`,
  )

  return result
}
