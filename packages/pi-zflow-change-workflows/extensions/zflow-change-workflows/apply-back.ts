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
import { readRun, updateRun, resetToPreApplySnapshot } from "pi-zflow-artifacts/run-state"
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

  return result
}
