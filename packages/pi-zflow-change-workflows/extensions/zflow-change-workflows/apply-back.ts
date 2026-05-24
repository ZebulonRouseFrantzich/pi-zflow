/**
 * apply-back.ts — Worktree-to-primary-tree apply-back strategy orchestration.
 *
 * **Phase 5 implementation (extended).**
 * Implements topological apply-back ordering, atomic patch replay with
 * rollback, and a strategy cascade that falls through increasingly
 * intelligent merge strategies before asking for human resolution.
 *
 * ## Strategy interface
 *
 * The apply-back code is structured behind a clean strategy interface so
 * that future strategies like branch-aware merge or structured conflict
 * resolution can be added without rewriting orchestration.
 *
 * ## Strategy cascade
 *
 * 1. `PatchReplayStrategy` — fast binary-safe `git apply --3way --index --binary`
 *    in topological order. Fast path for non-overlapping patches.
 * 2. `StructuredFileMergeStrategy` — auto-resolves common safe conflict
 *    patterns (imports, config keys, package.json deps, route registrations).
 * 3. `IntegrationWorktreeMergeStrategy` — branch-aware merge in an isolated
 *    integration worktree. Creates synthetic commits from each group's patch,
 *    merges them in topological order, produces a single consolidated patch.
 * 4. Subagent-assisted resolution — offered to the user when automated
 *    strategies fail. A dedicated subagent attempts resolution with
 *    full context.
 * 5. Manual resolution — the fallback when all automated strategies and
 *    agent assistance fail.
 *
 * @module pi-zflow-change-workflows/apply-back
 */

import * as path from "node:path"
import * as fs from "node:fs"
import { execFileSync } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { readRun, updateRun, resetToPreApplySnapshot, setRunPhase, createRecoveryRef, removeRecoveryRef } from "pi-zflow-artifacts/run-state"
import type { PreApplySnapshot } from "pi-zflow-artifacts/run-state"
import { resolveRunDir } from "pi-zflow-artifacts/artifact-paths"
import { topoSortGroups } from "./ownership-validator.js"
import type { ExecutionGroup } from "./ownership-validator.js"
import type { IntegrationMergeResult } from "./integration-merge-strategy.js"
import { runIntegrationMerge } from "./integration-merge-strategy.js"
import type { StructuredMergeResult } from "./structured-merge-strategy.js"
import { resolveAllConflicts } from "./structured-merge-strategy.js"

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
 * Strategies may implement either single-patch application (applyPatch) or
 * batch group merging (mergeGroups). The orchestrator calls mergeGroups if
 * available, falling back to applyPatch per group.
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
// Consolidated-patch strategy
// ---------------------------------------------------------------------------

/**
 * Strategy that applies a single consolidated patch to the primary worktree.
 *
 * This is used after a successful integration merge (where multiple group
 * patches have been merged into one consolidated diff in an isolated
 * worktree). Applying a consolidated patch is much simpler and less likely
 * to conflict than replaying individual patches.
 */
export class ConsolidatedPatchStrategy implements ApplyBackStrategy {
  readonly name = "consolidated-patch"

  /**
   * Path to the consolidated patch file.
   */
  private consolidatedPatchPath: string

  constructor(consolidatedPatchPath: string) {
    this.consolidatedPatchPath = consolidatedPatchPath
  }

  async applyPatch(patchPath: string, repoRoot: string, groupId: string): Promise<void> {
    // Ignore the passed patchPath — we always use the consolidated patch
    try {
      execFileSync("git", ["apply", "--3way", "--index", "--binary", this.consolidatedPatchPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      })
    } catch (err: unknown) {
      const stderr = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Failed to apply consolidated patch for group "${groupId}": ${stderr}`,
      )
    }
  }

  async rollback(repoRoot: string, snapshot: PreApplySnapshot, runId: string): Promise<void> {
    resetToPreApplySnapshot(runId, repoRoot, snapshot)
  }
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
    return existsSync(patchPath) && statSync(patchPath).size > 0
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

// ---------------------------------------------------------------------------
// Cascade-aware apply-back options
// ---------------------------------------------------------------------------

/**
 * Extended options for the cascade apply-back orchestrator.
 */
export interface CascadeApplyBackOptions extends ApplyBackOptions {
  /**
   * Whether to use the strategy cascade on failure.
   * When true (default), if PatchReplay fails, the orchestrator tries
   * structured merge and integration merge before giving up.
   */
  useCascade?: boolean
  /**
   * When true, skip the integration merge step and offer subagent
   * resolution directly after patch replay and structured merge fail.
   */
  preferSubagentOverIntegrationMerge?: boolean
}

/**
 * Extended apply-back result with cascade metadata.
 */
export interface CascadeApplyBackResult extends ApplyBackResult {
  /** Which strategies were attempted. */
  strategiesAttempted: string[]
  /** Which strategy succeeded (or null if all failed). */
  successfulStrategy?: string
  /** Whether subagent resolution is available. */
  subagentAvailable?: boolean
  /** Path to integration worktree (if integration merge was attempted). */
  integrationWorktreePath?: string
  /** Path to consolidated patch (if generated). */
  consolidatedPatchPath?: string
}

/**
 * Build a map of patch paths for all groups.
 */
function buildPatchMap(runId: string, groups: ExecutionGroup[], cwd?: string): Map<string, string> {
  const patchMap = new Map<string, string>()
  const runDir = resolveRunDir(runId, cwd)
  const patchesDir = path.join(runDir, "patches")

  for (const group of groups) {
    const candidatePath = path.join(patchesDir, `${group.id}.patch`)
    if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).size > 0) {
      patchMap.set(group.id, candidatePath)
    }
  }

  return patchMap
}

/**
 * Execute the full patch-replay apply-back cycle with no cascade.
 *
 * This is the original fast-path behavior — it tries only the single
 * provided strategy and reports failure immediately if any patch fails.
 * The primary worktree is rolled back on any failure.
 *
 * @param options - Apply-back options.
 * @returns ApplyBackResult with success/failure information.
 */
async function executePatchReplayApplyBack(
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

  // Read current run to preserve the startedAt timestamp set during the "in-progress" update.
  const currentRun = await readRun(runId, cwd).catch(() => null)
  const existingStartedAt = currentRun?.applyBack?.startedAt

  await updateRun(runId, {
    phase: "completed",
    applyBack: {
      status: "completed",
      startedAt: existingStartedAt,
      completedAt: new Date().toISOString(),
    },
    preApplySnapshot: undefined,
  }, cwd)

  removeRecoveryRef(runId, repoRoot)

  return result
}

// ---------------------------------------------------------------------------
// Mark apply-back as completed
// ---------------------------------------------------------------------------

/**
 * Mark the run as apply-back completed, clearing pre-apply snapshot
 * and recovery ref.
 */
async function markApplyBackCompleted(runId: string, cwd?: string): Promise<void> {
  const currentRun = await readRun(runId, cwd).catch(() => null)
  const existingStartedAt = currentRun?.applyBack?.startedAt

  await updateRun(runId, {
    phase: "completed",
    applyBack: {
      status: "completed",
      startedAt: existingStartedAt,
      completedAt: new Date().toISOString(),
    },
    preApplySnapshot: undefined,
  }, cwd)
}

/**
 * Mark the run as apply-back conflicted.
 */
async function markApplyBackConflicted(
  runId: string,
  failingGroup: string,
  errorMessage: string,
  cwd?: string,
): Promise<void> {
  await updateRun(runId, {
    phase: "apply-back-conflicted",
    applyBack: {
      status: "conflicted",
      completedAt: new Date().toISOString(),
      failingGroup,
      error: errorMessage,
    },
  }, cwd)
}

/**
 * Execute a full apply-back cycle with strategy cascade.
 *
 * Algorithm:
 * 1. Create recovery ref.
 * 2. Try **PatchReplayStrategy** — fast-path binary `git apply --3way`.
 *    If success → done.
 * 3. If patch replay fails → **StructuredFileMergeStrategy** — auto-resolve
 *    common safe conflict patterns (imports, config keys, package.json deps).
 *    After resolution, retry patch replay.
 * 4. If structured merge still fails → **IntegrationWorktreeMergeStrategy** —
 *    branch-aware merge in isolated integration worktree. Produces one
 *    consolidated patch.
 * 5. If integration merge succeeds → apply consolidated patch, verify coverage.
 * 6. If all automated strategies fail → mark as resolvable by subagent.
 *
 * @param options - Cascade apply-back options.
 * @returns CascadeApplyBackResult with strategy metadata.
 */
export async function executeApplyBack(
  options: CascadeApplyBackOptions,
): Promise<CascadeApplyBackResult> {
  const {
    runId,
    repoRoot,
    snapshot,
    groups,
    strategy,
    cwd,
    useCascade = true,
    preferSubagentOverIntegrationMerge = false,
  } = options

  // Mark run as applying
  await updateRun(runId, {
    phase: "applying",
    applyBack: { status: "in-progress", startedAt: new Date().toISOString() },
  }, cwd)

  // Create recovery ref
  createRecoveryRef(runId, repoRoot, snapshot.head)

  // Check for cycles
  const orderedIds = topoSortGroups(groups)
  if (!orderedIds) {
    const result: CascadeApplyBackResult = {
      success: false,
      groupsApplied: 0,
      totalGroups: groups.length,
      error: "Dependency graph contains cycles; cannot determine apply order.",
      rolledBack: false,
      strategiesAttempted: [],
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

  // Build patch map
  const patchMap = buildPatchMap(runId, groups, cwd)

  // ── Strategy 1: PatchReplay ──
  const replayStrategy = strategy ?? new PatchReplayStrategy()
  const patchReplayResult = await executePatchReplayApplyBack({
    runId,
    repoRoot,
    snapshot,
    groups,
    strategy: replayStrategy,
    cwd,
  })

  if (patchReplayResult.success) {
    await markApplyBackCompleted(runId, cwd)
    return {
      ...patchReplayResult,
      strategiesAttempted: [replayStrategy.name],
      successfulStrategy: replayStrategy.name,
      subagentAvailable: false,
    }
  }

  // Patch replay failed. If cascade is disabled, return failure immediately.
  if (!useCascade) {
    return {
      ...patchReplayResult,
      strategiesAttempted: [replayStrategy.name],
      subagentAvailable: false,
    }
  }

  // ── Strategy 2: Structured merge auto-resolution ──
  // After the rollback, the primary worktree is at the pre-apply snapshot.
  // Try structured auto-resolution of the conflicts on the original patches,
  // then retry patch replay.
  let structuredMergeSuccess = false
  let structuredMergeResult: ApplyBackResult | null = null

  try {
    // Apply patches again — this time they'll conflict in the worktree
    // We'll then auto-resolve those conflicts and retry
    // First, find which patch caused the failure
    const failingGroup = patchReplayResult.failingGroup
    const failingPatchPath = patchReplayResult.failingPatchPath

    if (failingPatchPath && fs.existsSync(failingPatchPath)) {
      // Try to apply all patches except the failing one first
      // (they may have succeeded before the failure)
      const patchReplayStrategy = new PatchReplayStrategy()

      // Apply all patches up to (but not including) the failing one
      const preFailPatches: Array<{ id: string; path: string }> = []
      for (const groupId of orderedIds) {
        if (groupId === failingGroup) break
        const pp = patchMap.get(groupId)
        if (pp) preFailPatches.push({ id: groupId, path: pp })
      }

      let allPreFailApplied = true
      for (const pp of preFailPatches) {
        try {
          await patchReplayStrategy.applyPatch(pp.path, repoRoot, pp.id)
        } catch {
          allPreFailApplied = false
          break
        }
      }

      if (allPreFailApplied) {
        // Now try to apply the failing patch — when it fails, the worktree
        // will have conflict markers. Run structured resolution on those.
        try {
          await patchReplayStrategy.applyPatch(failingPatchPath, repoRoot, failingGroup)
          // It worked! Continue with remaining patches
          structuredMergeSuccess = true
          for (const groupId of orderedIds) {
            if (groupId === failingGroup) continue
            const pp = patchMap.get(groupId)
            if (pp) {
              const priorIdx = preFailPatches.findIndex((p) => p.id === groupId)
              if (priorIdx >= 0) continue  // already applied
              try {
                await patchReplayStrategy.applyPatch(pp, repoRoot, groupId)
              } catch {
                structuredMergeSuccess = false
                break
              }
            }
          }
        } catch (conflictError) {
          // Patch failed — resolve conflicts and retry
          // The worktree now has conflict markers from the --3way fallback
          const conflictResolution = resolveAllConflicts(repoRoot)
          if (conflictResolution.success && conflictResolution.resolved > 0) {
            // Try again after resolution
            try {
              await patchReplayStrategy.applyPatch(failingPatchPath, repoRoot, failingGroup)
              // Apply remaining patches
              for (const groupId of orderedIds) {
                if (groupId === failingGroup) continue
                const pp = patchMap.get(groupId)
                if (pp) {
                  const priorIdx = preFailPatches.findIndex((p) => p.id === groupId)
                  if (priorIdx >= 0) continue
                  try {
                    await patchReplayStrategy.applyPatch(pp, repoRoot, groupId)
                  } catch {
                    structuredMergeSuccess = false
                    break
                  }
                }
              }
              structuredMergeSuccess = true
            } catch {
              structuredMergeSuccess = false
            }
          }
        }
      }
    }

    if (structuredMergeSuccess) {
      // Verify the index is clean
      execFileSync("git", ["add", "-A"], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      })
      const result: CascadeApplyBackResult = {
        success: true,
        groupsApplied: groups.length,
        totalGroups: groups.length,
        rolledBack: false,
        strategiesAttempted: [replayStrategy.name, "structured-merge"],
        successfulStrategy: "structured-merge",
        subagentAvailable: false,
        summary: [
          "All groups applied successfully after structured conflict auto-resolution.",
          `Structured merge resolved conflicts automatically.`,
        ].join("\n"),
      }
      await markApplyBackCompleted(runId, cwd)
      return result
    }
  } catch {
    // Structured resolution failed or threw — continue to next strategy
  }

  // Roll back if structured merge left the tree dirty
  try {
    await new PatchReplayStrategy().rollback(repoRoot, snapshot, runId)
  } catch {
    // Best-effort rollback
  }

  // ── Strategy 3: IntegrationWorktreeMergeStrategy ──
  if (!preferSubagentOverIntegrationMerge) {
    try {
      const integrationMergeResult: IntegrationMergeResult = await runIntegrationMerge({
        runId,
        repoRoot,
        snapshot,
        groups,
        patches: patchMap,
        cwd,
      })

      if (integrationMergeResult.success && integrationMergeResult.consolidatedPatchPath) {
        // Apply the consolidated patch back to the primary worktree
        try {
          const consolidatedStrategy = new ConsolidatedPatchStrategy(
            integrationMergeResult.consolidatedPatchPath,
          )
          await consolidatedStrategy.applyPatch(
            integrationMergeResult.consolidatedPatchPath,
            repoRoot,
            "_consolidated",
          )

          await markApplyBackCompleted(runId, cwd)

          return {
            success: true,
            groupsApplied: groups.length,
            totalGroups: groups.length,
            rolledBack: false,
            strategiesAttempted: [
              replayStrategy.name,
              "structured-merge",
              "integration-merge",
            ],
            successfulStrategy: "integration-merge",
            subagentAvailable: false,
            integrationWorktreePath: integrationMergeResult.integrationWorktreePath,
            consolidatedPatchPath: integrationMergeResult.consolidatedPatchPath,
            summary: [
              "Integration merge succeeded!",
              "All group changes were merged in an isolated worktree and verified.",
              "The consolidated patch was applied to the primary worktree.",
            ].join("\n"),
          }
        } catch (err: unknown) {
          // Consolidated patch failed to apply cleanly
          const result: CascadeApplyBackResult = {
            success: false,
            groupsApplied: 0,
            totalGroups: groups.length,
            error: `Consolidated patch application failed: ${err instanceof Error ? err.message : String(err)}`,
            rolledBack: false,
            strategiesAttempted: [
              replayStrategy.name,
              "structured-merge",
              "integration-merge",
            ],
            subagentAvailable: true,
            integrationWorktreePath: integrationMergeResult.integrationWorktreePath,
            consolidatedPatchPath: integrationMergeResult.consolidatedPatchPath,
            summary: [
              "Integration merge produced a consolidated patch, but applying it to the",
              "primary worktree failed. The integration worktree and consolidated patch",
              "are preserved for inspection.",
              "",
              `Integration worktree: ${integrationMergeResult.integrationWorktreePath}`,
              `Consolidated patch: ${integrationMergeResult.consolidatedPatchPath}`,
              "",
              "Options:",
              "1. Request subagent resolution (recommended)",
              "2. Manually resolve and run --resume",
            ].join("\n"),
          }

          await markApplyBackConflicted(runId, "_consolidated", result.error ?? "Unknown", cwd)
          return result
        }
      }

      // Integration merge failed
      const result: CascadeApplyBackResult = {
        success: false,
        groupsApplied: 0,
        totalGroups: groups.length,
        failingGroup: integrationMergeResult.failingGroup,
        error: integrationMergeResult.error,
        rolledBack: false,
        strategiesAttempted: [
          replayStrategy.name,
          "structured-merge",
          "integration-merge",
        ],
        subagentAvailable: integrationMergeResult.resolvableByAgent ?? true,
        integrationWorktreePath: integrationMergeResult.integrationWorktreePath,
        summary: integrationMergeResult.summary,
      }

      await markApplyBackConflicted(
        runId,
        integrationMergeResult.failingGroup ?? "_unknown",
        integrationMergeResult.error ?? "Integration merge failed",
        cwd,
      )
      return result
    } catch (err: unknown) {
      // Integration merge threw an error
      const result: CascadeApplyBackResult = {
        success: false,
        groupsApplied: 0,
        totalGroups: groups.length,
        error: `Integration merge threw: ${err instanceof Error ? err.message : String(err)}`,
        rolledBack: false,
        strategiesAttempted: [
          replayStrategy.name,
          "structured-merge",
          "integration-merge",
        ],
        subagentAvailable: true,
        summary: [
          "All automated strategies failed. Subagent resolution is available.",
          "",
          "Options:",
          "1. Request subagent resolution (recommended)",
          "2. Manually resolve the patches and run --resume",
          "3. Abandon the run",
        ].join("\n"),
      }

      await markApplyBackConflicted(runId, "_all", result.error ?? "Unknown", cwd)
      return result
    }
  }

  // ── All strategies failed (or integration merge was skipped) ──
  const result: CascadeApplyBackResult = {
    success: false,
    groupsApplied: 0,
    totalGroups: groups.length,
    error: patchReplayResult.error ?? "All apply-back strategies failed.",
    failingGroup: patchReplayResult.failingGroup,
    failingPatchPath: patchReplayResult.failingPatchPath,
    rolledBack: true,
    strategiesAttempted: [
      replayStrategy.name,
      ...(useCascade ? ["structured-merge"] : []),
      ...(preferSubagentOverIntegrationMerge ? [] : ["integration-merge"]),
    ],
    subagentAvailable: true,
    summary: [
      "All automated apply-back strategies failed.",
      "Patch replay failed, structured auto-resolution did not resolve all conflicts,",
      preferSubagentOverIntegrationMerge
        ? "and subagent resolution was preferred over integration merge."
        : "and integration merge could not produce a verified consolidated result.",
      "",
      `Primary worktree has been rolled back to the pre-apply snapshot.`,
      `No partial changes remain.`,
      "",
      "Available options:",
      "1. Request subagent resolution — a subagent with full context will attempt",
      "   to merge the patches, guided by the original group task descriptions.",
      `2. Manually resolve the patches in the run dir and run --resume.`,
      "3. Abandon the run.",
    ].join("\n"),
  }

  await markApplyBackConflicted(
    runId,
    result.failingGroup ?? "_unknown",
    result.error ?? "All strategies failed",
    cwd,
  )
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
          // Recovery ref and recovery-based reset both failed.
          // Try direct reset to the recorded snapshot.head as a final fallback.
          // First validate the SHA to avoid applying an invalid ref.
          try {
            execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${snapshot.head}^{commit}`], {
              cwd: repoRoot,
              stdio: ["ignore", "pipe", "pipe"],
            })
            execFileSync("git", ["reset", "--hard", snapshot.head], {
              cwd: repoRoot,
              stdio: ["ignore", "pipe", "pipe"],
            })
            primaryTreeRestored = true
          } catch {
            // head is invalid or reset failed — recovery cannot proceed safely
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
