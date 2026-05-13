/**
 * apply-back.ts — Worktree-to-primary-tree apply-back strategy orchestration.
 *
 * **Phase 5 implementation.**
 * Implements topological apply-back ordering, atomic patch replay with
 * rollback, and a clean strategy interface for future branch-aware
 * merge/cherry-pick implementations.
 *
 * ## Strategy interface
 *
 * The apply-back code is structured behind a clean strategy interface so
 * that a future branch-aware merge/cherry-pick implementation can be added
 * without rewriting orchestration.
 *
 * ## First-pass implementation
 *
 * First-pass apply-back is atomic binary-safe patch replay in topological
 * order with rollback to the pre-apply snapshot on conflict.
 *
 * @module pi-zflow-change-workflows/apply-back
 */

import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { readRun, updateRun, resetToPreApplySnapshot, setRunPhase, createRecoveryRef, removeRecoveryRef } from "pi-zflow-artifacts/run-state"
import type { PreApplySnapshot } from "pi-zflow-artifacts/run-state"
import { resolveRunDir } from "pi-zflow-artifacts/artifact-paths"
import { topoSortGroups } from "./ownership-validator.js"
import type { ExecutionGroup } from "./ownership-validator.js"

// ---------------------------------------------------------------------------
// Strategy interface
// ---------------------------------------------------------------------------

/**
 * Apply-back strategy contract.
 *
 * Each strategy knows how to take the output of one or more execution groups
 * and apply them to the primary worktree. The first-pass implementation uses
 * binary-safe patch replay (`git apply --3way --index --binary`).
 *
 * Future strategies may implement branch-aware merge or cherry-pick.
 */
export interface ApplyBackStrategy {
  /** Human-readable name for this strategy (e.g. "patch-replay", "merge"). */
  readonly name: string

  /**
   * Apply a single group's patch to the primary worktree.
   *
   * @param patchPath - Absolute path to the patch file.
   * @param repoRoot - Absolute path to the repo root.
   * @param groupId - Group identifier for logging.
   * @throws If the patch cannot be applied cleanly.
   */
  applyPatch(patchPath: string, repoRoot: string, groupId: string): Promise<void>

  /**
   * Roll back the primary worktree to the pre-apply state.
   *
   * @param repoRoot - Absolute path to the repo root.
   * @param snapshot - The pre-apply snapshot to restore.
   * @param runId - Run identifier for recovery ref lookup.
   */
  rollback(repoRoot: string, snapshot: PreApplySnapshot, runId: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Apply-back result
// ---------------------------------------------------------------------------

/**
 * Result of an apply-back operation.
 */
export interface ApplyBackResult {
  /** Overall success or failure. */
  success: boolean
  /** Number of groups successfully applied. */
  groupsApplied: number
  /** Total number of groups. */
  totalGroups: number
  /** ID of the failing group, if any. */
  failingGroup?: string
  /** Error message from the failure. */
  error?: string
  /** Patch path of the failing group. */
  failingPatchPath?: string
  /** Whether an automatic rollback was performed. */
  rolledBack: boolean
  /** Human-readable summary. */
  summary: string
}

// ---------------------------------------------------------------------------
// Patch-replay strategy (first-pass)
// ---------------------------------------------------------------------------

/**
 * First-pass apply-back strategy using `git apply --3way --index --binary`.
 *
 * This strategy replays patches created by `git diff` between the base
 * commit and the worktree head. It requires a clean primary tree index
 * and uses 3-way merge fallback for conflicts.
 */
export class PatchReplayStrategy implements ApplyBackStrategy {
  readonly name = "patch-replay"

  async applyPatch(patchPath: string, repoRoot: string, groupId: string): Promise<void> {
    try {
      execFileSync("git", ["apply", "--3way", "--index", "--binary", patchPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      })
    } catch (err: unknown) {
      const stderr = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Failed to apply patch for group "${groupId}": ${stderr}`,
      )
    }
  }

  async rollback(repoRoot: string, snapshot: PreApplySnapshot, runId: string): Promise<void> {
    resetToPreApplySnapshot(runId, repoRoot, snapshot)
  }
}

// ---------------------------------------------------------------------------
// Apply-back orchestrator
// ---------------------------------------------------------------------------

/**
 * Options for the apply-back orchestrator.
 */
export interface ApplyBackOptions {
  /** Unique run identifier. */
  runId: string
  /** Absolute path to the repo root. */
  repoRoot: string
  /** Pre-apply snapshot to restore on failure. */
  snapshot: PreApplySnapshot
  /** Execution groups in dependency order. */
  groups: ExecutionGroup[]
  /** Strategy to use for applying patches (default: PatchReplayStrategy). */
  strategy?: ApplyBackStrategy
  /** Working directory for runtime state dir resolution. */
  cwd?: string
}

/**
 * Check whether a patch file exists and has content.
 */
function patchExists(patchPath: string): boolean {
  try {
    const stat = execFileSync("stat", [patchPath], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] })
    return stat.length > 0
  } catch {
    return false
  }
}

/**
 * Resolve the patch path for a group based on the run's metadata.
 */
function resolveGroupPatchPath(runId: string, groupId: string, cwd?: string): string | null {
  const runDir = resolveRunDir(runId, cwd)
  const candidatePath = path.join(runDir, "patches", `${groupId}.patch`)
  return patchExists(candidatePath) ? candidatePath : null
}

/**
 * Execute a full apply-back cycle.
 *
 * Algorithm:
 * 1. Record pre-apply snapshot and recovery ref in run.json
 * 2. Select the first-pass apply-back strategy: atomic patch replay
 * 3. Compute topological order from execution groups
 * 4. Iterate groups in topological order, applying each patch
 * 5. If all succeed, drop recovery marker and mark apply complete
 * 6. If any fail:
 *    - Abort remaining applies
 *    - Hard-reset the primary worktree/index to the pre-apply snapshot
 *    - Leave no partial success behind
 *    - Mark run as apply-back-conflicted
 *    - Surface failing group, files, patch path, and retained worktree path
 *
 * @param options - Apply-back options.
 * @returns ApplyBackResult with success/failure information.
 */
export async function executeApplyBack(
  options: ApplyBackOptions,
): Promise<ApplyBackResult> {
  const {
    runId,
    repoRoot,
    snapshot,
    groups,
    strategy = new PatchReplayStrategy(),
    cwd,
  } = options

  // Mark run as applying
  await updateRun(runId, {
    phase: "applying",
    applyBack: { status: "in-progress", startedAt: new Date().toISOString() },
  }, cwd)

  // Create recovery ref before any patches are applied
  // This ensures we can restore the pre-apply state if apply-back fails or is interrupted.
  createRecoveryRef(runId, repoRoot, snapshot.head)

  // Compute topological order
  const orderedIds = topoSortGroups(groups)
  if (!orderedIds) {
    const result: ApplyBackResult = {
      success: false,
      groupsApplied: 0,
      totalGroups: groups.length,
      error: "Dependency graph contains cycles; cannot determine apply order.",
      rolledBack: false,
      summary: "Cannot apply patches: circular dependency detected in execution groups.",
    }
    await updateRun(runId, {
      phase: "failed",
      applyBack: {
        status: "conflicted",
        completedAt: new Date().toISOString(),
        error: result.error,
      },
    }, cwd)
    return result
  }

  // Build group lookup
  const groupMap = new Map(groups.map((g) => [g.id, g]))

  // Apply groups in topological order
  let groupsApplied = 0
  let failingGroup: string | undefined
  let failingPatchPath: string | undefined
  let errorMessage: string | undefined

  for (const groupId of orderedIds) {
    const group = groupMap.get(groupId)
    if (!group) continue

    // Resolve patch path
    const patchPath = resolveGroupPatchPath(runId, groupId, cwd)
    if (!patchPath) {
      // No patch for this group — skip (group may have had no changes)
      groupsApplied++
      continue
    }

    try {
      await strategy.applyPatch(patchPath, repoRoot, groupId)
      groupsApplied++
    } catch (err: unknown) {
      failingGroup = groupId
      failingPatchPath = patchPath
      errorMessage = err instanceof Error ? err.message : String(err)

      // Rollback
      await strategy.rollback(repoRoot, snapshot, runId)

      const result: ApplyBackResult = {
        success: false,
        groupsApplied,
        totalGroups: groups.length,
        failingGroup,
        failingPatchPath,
        error: errorMessage,
        rolledBack: true,
        summary: [
          `Apply-back failed at group "${failingGroup}".`,
          `Patch: ${failingPatchPath}`,
          `Error: ${errorMessage}`,
          "",
          `${groupsApplied} of ${groups.length} groups applied before failure.`,
          "Primary worktree has been rolled back to the pre-apply snapshot.",
          "No partial changes remain.",
        ].join("\n"),
      }

      await updateRun(runId, {
        phase: "apply-back-conflicted",
        applyBack: {
          status: "conflicted",
          completedAt: new Date().toISOString(),
          failingGroup,
          error: errorMessage,
        },
      }, cwd)

      return result
    }
  }

  // All patches applied successfully
  const result: ApplyBackResult = {
    success: true,
    groupsApplied,
    totalGroups: groups.length,
    rolledBack: false,
    summary: `All ${groupsApplied} group(s) applied successfully in topological order.`,
  }

  await updateRun(runId, {
    phase: "completed",
    applyBack: {
      status: "completed",
      startedAt: undefined, // already set in the "in-progress" update
      completedAt: new Date().toISOString(),
    },
    preApplySnapshot: undefined, // clear snapshot after successful apply
  }, cwd)

  // Remove recovery ref — apply-back completed successfully, no rollback needed
  removeRecoveryRef(runId, repoRoot)

  return result
}

// ── Recovery and resume support (Task 5.15) ─────────────────────

/**
 * Options for the apply-back recovery operation.
 */
export interface RecoveryOptions {
  /**
   * Recommended next actions for the caller.
   * - `resume`: Retry the apply-back from scratch (after restoring pre-apply snapshot).
   * - `abandon`: Give up on this run; no recovery attempted.
   * - `inspect`: Review retained artifacts before deciding.
   * - `cleanup`: Remove orphaned worktrees/patches without retrying.
   */
  recommendations: Array<"resume" | "abandon" | "inspect" | "cleanup">
  /** Whether the primary tree was restored to the pre-apply snapshot. */
  primaryTreeRestored: boolean
  /** Orphaned worktree paths from previous failures. */
  orphanedWorktreePaths: string[]
  /** The current apply-back status from run.json. */
  currentStatus: string
  /** Human-readable summary. */
  summary: string
}

/**
 * Get the current apply-back status from run.json.
 *
 * @param runId - Unique run identifier.
 * @param cwd - Working directory (optional).
 * @returns The apply-back status object, or null if the run doesn't exist.
 */
export async function getApplyBackStatus(
  runId: string,
  cwd?: string,
): Promise<{
  status: string
  startedAt?: string
  completedAt?: string
  failingGroup?: string
  error?: string
} | null> {
  try {
    const run = await readRun(runId, cwd)
    return {
      status: run.applyBack.status,
      startedAt: run.applyBack.startedAt,
      completedAt: run.applyBack.completedAt,
      failingGroup: run.applyBack.failingGroup,
      error: run.applyBack.error,
    }
  } catch {
    return null
  }
}

/**
 * Recover from an interrupted or incomplete apply-back.
 *
 * Reads run.json to check the current apply-back status. If the status
 * is unknown or incomplete, restores the primary worktree to the
 * pre-apply snapshot and returns recovery options.
 *
 * This function does NOT automatically retry. The caller receives
 * recommendations and must decide the next action.
 *
 * @param runId - Unique run identifier.
 * @param repoRoot - Absolute path to the repository root.
 * @param cwd - Working directory (optional).
 * @returns Recovery options with recommendations.
 */
export async function recoverFromApplyBack(
  runId: string,
  repoRoot: string,
  cwd?: string,
): Promise<RecoveryOptions> {
  const run = await readRun(runId, cwd).catch(() => null)

  if (!run) {
    return {
      recommendations: ["abandon"],
      primaryTreeRestored: false,
      orphanedWorktreePaths: [],
      currentStatus: "unknown",
      summary: `Run "${runId}" not found. Cannot recover. Recommend abandoning this run.`,
    }
  }

  const currentStatus = run.applyBack.status
  const snapshot = run.preApplySnapshot
  const orphanedWorktreePaths: string[] = []

  // Collect orphaned worktree paths from retained artifacts
  if (run.retainedArtifacts) {
    for (const artifact of run.retainedArtifacts) {
      if (artifact.type === "worktree") {
        orphanedWorktreePaths.push(artifact.path)
      }
    }
  }

  // Also collect from group metadata
  if (run.groups) {
    for (const group of run.groups) {
      if (group.worktreePath && !orphanedWorktreePaths.includes(group.worktreePath)) {
        // Check if the worktree path still exists on disk
        try {
          await import("node:fs/promises").then((fs) => fs.access(group.worktreePath))
          orphanedWorktreePaths.push(group.worktreePath)
        } catch {
          // Worktree no longer exists
        }
      }
    }
  }

  // Determine recovery action based on status
  let primaryTreeRestored = false
  let recommendations: RecoveryOptions["recommendations"] = []
  let summary: string

  switch (currentStatus) {
    case "pending":
    case "in-progress": {
      // Apply-back was interrupted — restore pre-apply snapshot and recommend resume
      if (snapshot) {
        try {
          resetToPreApplySnapshot(runId, repoRoot, snapshot)
          primaryTreeRestored = true
        } catch {
          // Recovery ref may not exist; try hard reset to recorded head
          try {
            execFileSync("git", ["reset", "--hard", snapshot.head], {
              cwd: repoRoot,
              stdio: ["ignore", "pipe", "pipe"],
            })
            execFileSync("git", ["clean", "-fd"], {
              cwd: repoRoot,
              stdio: ["ignore", "pipe", "pipe"],
            })
            primaryTreeRestored = true
          } catch {
            primaryTreeRestored = false
          }
        }
      }

      await setRunPhase(runId, "failed", cwd)
      await updateRun(runId, {
        applyBack: { status: "rolled-back" },
      }, cwd)

      recommendations = primaryTreeRestored
        ? ["resume", "inspect", "cleanup"]
        : ["inspect", "abandon"]

      summary = primaryTreeRestored
        ? `Apply-back was interrupted (status: ${currentStatus}). ` +
          `Primary worktree restored to pre-apply snapshot. ` +
          `Recommend retrying apply-back after inspecting retained artifacts.`
        : `Apply-back was interrupted (status: ${currentStatus}). ` +
          `Could NOT restore primary worktree. Inspect retained artifacts manually.`
      break
    }

    case "conflicted": {
      // Apply-back failed with conflict — tree was already rolled back
      primaryTreeRestored = true

      recommendations = ["inspect", "resume"]
      summary = `Apply-back conflicted at group "${run.applyBack.failingGroup ?? "unknown"}". ` +
        `Primary worktree was already rolled back. ` +
        `Inspect the deviation report and retained artifacts, then retry.`
      break
    }

    case "rolled-back": {
      // Already rolled back — safe to retry
      primaryTreeRestored = true

      recommendations = ["resume", "inspect", "abandon"]
      summary = `Apply-back was previously rolled back. ` +
        `Primary worktree is clean. Resume with a fresh apply-back attempt.`
      break
    }

    case "completed": {
      // Already completed — nothing to recover
      recommendations = ["cleanup"]
      summary = `Apply-back completed successfully. No recovery needed. ` +
        `Orphaned worktrees may still need cleanup.`
      break
    }

    default: {
      recommendations = ["abandon", "inspect"]
      summary = `Unknown apply-back status "${currentStatus}". ` +
        `Inspect run.json manually for details.`
    }
  }

  return {
    recommendations,
    primaryTreeRestored,
    orphanedWorktreePaths,
    currentStatus,
    summary,
  }
}
