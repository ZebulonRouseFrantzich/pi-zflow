/**
 * integration-merge-strategy.ts — Branch-aware integration merge for apply-back.
 *
 * When patch replay fails (e.g. overlapping file edits), this strategy creates
 * an isolated integration worktree, materializes each group's changes as
 * synthetic branches, merges them in dependency order using git merge/cherry-pick,
 * and produces a single consolidated patch.
 *
 * The primary worktree is never touched until the consolidated patch is ready
 * and verified by the coverage verifier.
 *
 * ## Algorithm
 *
 * 1. Create a fresh git worktree at the base commit (original HEAD).
 * 2. For each group in topological order:
 *    a. Create a synthetic commit from the group's patch on a temp branch.
 *    b. Merge (or cherry-pick) that branch into the integration branch.
 *    c. If merge conflicts occur, attempt auto-resolution.
 * 3. After all groups are merged, generate a single consolidated diff
 *    (base..integration-HEAD).
 * 4. Verify via coverage-verifier that all group changes are preserved.
 * 5. Return the consolidated patch path.
 *
 * @module pi-zflow-change-workflows/integration-merge-strategy
 */

import * as path from "node:path"
import * as fs from "node:fs"
import { execFileSync } from "node:child_process"
import type { PreApplySnapshot } from "pi-zflow-artifacts/run-state"
import { resolveRunDir } from "pi-zflow-artifacts/artifact-paths"
import type { ExecutionGroup } from "./ownership-validator.js"
import { topoSortGroups } from "./ownership-validator.js"
import {
  generateCoverageReport,
} from "./coverage-verifier.js"
import type { CoverageReport } from "./coverage-verifier.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of an integration merge attempt.
 */
export interface IntegrationMergeResult {
  /** Whether the integration merge succeeded. */
  success: boolean
  /** Path to the consolidated patch (if successful). */
  consolidatedPatchPath?: string
  /** Path to the integration worktree (always set, for inspection). */
  integrationWorktreePath: string
  /** Coverage report from the verifier (if verification was run). */
  coverageReport?: CoverageReport
  /** Which group caused the integration failure (if any). */
  failingGroup?: string
  /** Error message from the failure. */
  error?: string
  /** Whether a subagent could attempt resolution (true for merge conflicts). */
  resolvableByAgent?: boolean
  /** Human-readable summary. */
  summary: string
}

/**
 * Configuration for the integration merge strategy.
 */
export interface IntegrationMergeConfig {
  /** Unique run identifier. */
  runId: string
  /** Absolute path to the repo root. */
  repoRoot: string
  /** Pre-apply snapshot (base commit). */
  snapshot: PreApplySnapshot
  /** Execution groups with files and dependencies. */
  groups: ExecutionGroup[]
  /** Patch paths keyed by group ID. */
  patches: Map<string, string>
  /** Working directory for runtime state dir resolution. */
  cwd?: string
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Run a git command in the given working directory and return trimmed stdout.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000,
  }).trimEnd()
}

/**
 * Run a git command and capture stderr on failure.
 */
function gitSafe(cwd: string, ...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
    })
    return { stdout: stdout.trimEnd(), stderr: "", exitCode: 0 }
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string; status?: number; message?: string }
    return {
      stdout: (e.stdout ?? "").toString().trimEnd(),
      stderr: (e.stderr ?? e.message ?? "").trimEnd(),
      exitCode: e.status ?? 1,
    }
  }
}

/**
 * Check whether a ref exists in the repo.
 */
function refExists(repoRoot: string, ref: string): boolean {
  const result = gitSafe(repoRoot, "rev-parse", "--verify", "--quiet", ref)
  return result.exitCode === 0
}

// ---------------------------------------------------------------------------
// Temp branch names
// ---------------------------------------------------------------------------

function groupBranchName(runId: string, groupId: string): string {
  return `zflow/run/${runId}/${groupId}`
}

function integrationBranchName(runId: string): string {
  return `zflow/run/${runId}/integration`
}

// ---------------------------------------------------------------------------
// Worktree management
// ---------------------------------------------------------------------------

/**
 * Create an isolated integration worktree at the base commit.
 *
 * @param repoRoot - Primary repo root.
 * @param baseCommit - Base commit to check out.
 * @param worktreePath - Where to create the worktree.
 * @param branchName - Temporary branch name for the worktree.
 * @returns The resolved worktree path.
 */
function createIntegrationWorktree(
  repoRoot: string,
  baseCommit: string,
  worktreePath: string,
  branchName: string,
): string {
  // Create a branch at the base commit if it doesn't exist
  if (!refExists(repoRoot, `refs/heads/${branchName}`)) {
    execFileSync("git", ["branch", branchName, baseCommit], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    })
  }

  // Clean up any existing worktree at this path
  execFileSync("git", ["worktree", "prune"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  })

  // Remove existing worktree if present
  const existing = gitSafe(repoRoot, "worktree", "list")
  if (existing.stdout.includes(worktreePath)) {
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    })
  }

  // Remove existing branch reference if it was dangling
  if (refExists(repoRoot, `refs/heads/${branchName}`)) {
    execFileSync("git", ["branch", "-D", branchName], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    })
  }

  // Create the branch and worktree
  execFileSync("git", ["branch", branchName, baseCommit], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  })

  execFileSync("git", ["worktree", "add", "--force", worktreePath, branchName], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  })

  return worktreePath
}

/**
 * Remove an integration worktree.
 */
function removeIntegrationWorktree(repoRoot: string, worktreePath: string, branchName: string): void {
  try {
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    })
  } catch {
    // Best-effort
  }
  try {
    execFileSync("git", ["branch", "-D", branchName], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    })
  } catch {
    // Best-effort
  }
}

// ---------------------------------------------------------------------------
// Synthetic commit creation from patch
// ---------------------------------------------------------------------------

/**
 * Create a synthetic commit from a group's patch on a temporary branch.
 *
 * Steps:
 * 1. Check if the base branch is at the correct commit.
 * 2. Apply the patch with `git apply --3way --binary` inside the worktree.
 * 3. Commit the result as a synthetic commit.
 * 4. Return the commit SHA.
 *
 * @param worktreePath - The integration worktree path.
 * @param baseCommit - The commit to start from.
 * @param patchPath - Absolute path to the group's patch file.
 * @param groupId - Group identifier (for commit message).
 * @param branchName - Temporary branch name.
 * @returns The synthetic commit SHA, or throws on failure.
 */
function createSyntheticCommit(
  worktreePath: string,
  baseCommit: string,
  patchPath: string,
  groupId: string,
  branchName: string,
): string {
  // Build each group's synthetic commit on its own branch rooted at the
  // original base commit. Do not create these commits on the integration
  // branch itself; the caller will switch back to the integration branch and
  // merge each group branch in topological order.
  execFileSync("git", ["checkout", "-B", branchName, baseCommit], {
    cwd: worktreePath,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  })

  execFileSync("git", ["reset", "--hard", baseCommit], {
    cwd: worktreePath,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  })

  // Apply the patch
  execFileSync("git", ["apply", "--3way", "--binary", "--index", patchPath], {
    cwd: worktreePath,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  })

  // Commit with a message that identifies the group
  execFileSync("git", ["commit", "--allow-empty", "-m", `zflow: ${groupId} synthetic commit`], {
    cwd: worktreePath,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  })

  // The worktree is currently on branchName, so the branch already points at
  // the synthetic commit. The caller will switch back to the integration
  // branch before merging this branch.

  // Get the new commit SHA
  return git(worktreePath, "rev-parse", "HEAD")
}

// ---------------------------------------------------------------------------
// Merge or cherry-pick resolution
// ---------------------------------------------------------------------------

/**
 * Attempt to merge a group branch into the integration branch.
 *
 * First tries `git merge` (no-ff). If that fails with conflicts,
 * tries `git cherry-pick`. Captures conflict markers.
 *
 * @param worktreePath - Integration worktree path.
 * @param groupBranch - Branch name for the group to merge.
 * @param groupId - Group identifier.
 * @returns An object with success flag, and merged commit SHA on success.
 */
function mergeGroupIntoIntegration(
  worktreePath: string,
  groupBranch: string,
  groupId: string,
): { success: boolean; commitSha?: string; conflictFiles?: string[]; error?: string } {
  // Try git merge first
  const mergeResult = gitSafe(
    worktreePath,
    "merge", "--no-ff", "--no-edit", groupBranch,
  )

  if (mergeResult.exitCode === 0) {
    const sha = git(worktreePath, "rev-parse", "HEAD")
    return { success: true, commitSha: sha }
  }

  // Merge failed — abort and try cherry-pick
  try {
    execFileSync("git", ["merge", "--abort"], {
      cwd: worktreePath,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    })
  } catch {
    // merge --abort fails when there's no merge in progress — that's OK
  }

  // Get the list of commits to cherry-pick
  const integrationHead = git(worktreePath, "rev-parse", "HEAD")
  const groupHead = git(worktreePath, "rev-parse", groupBranch)
  const groupBase = git(worktreePath, "merge-base", "HEAD", groupBranch)

  const cherryPickResult = gitSafe(
    worktreePath,
    "cherry-pick", "--no-commit", `${groupBase}..${groupHead}`,
  )

  if (cherryPickResult.exitCode === 0) {
    // Commit the cherry-picked changes
    execFileSync("git", ["commit", "--allow-empty", "-m", `zflow: ${groupId} integrated via cherry-pick`], {
      cwd: worktreePath,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    })
    const sha = git(worktreePath, "rev-parse", "HEAD")
    return { success: true, commitSha: sha }
  }

  // Cherry-pick also failed. Preserve the conflicted worktree for subagent
  // resolution instead of aborting; otherwise the resolver has no conflict
  // markers or index state to inspect.

  // Collect conflicted files
  const conflictResult = gitSafe(worktreePath, "diff", "--name-only", "--diff-filter=U")
  const conflictFiles = conflictResult.stdout ? conflictResult.stdout.split("\n").filter(Boolean) : []

  return {
    success: false,
    conflictFiles: conflictFiles.length > 0 ? conflictFiles : undefined,
    error: `Failed to merge "${groupId}" into integration: merge and cherry-pick both failed.\n` +
      `Conflicted files: ${conflictFiles.length > 0 ? conflictFiles.join(", ") : "(unknown)"}\n` +
      `Merge stderr: ${mergeResult.stderr}`,
  }
}

// ---------------------------------------------------------------------------
// Main integration merge orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the integration merge strategy.
 *
 * Creates an isolated worktree, materializes group patches as synthetic
 * branches, merges them in topological order, generates a consolidated patch,
 * and verifies coverage.
 *
 * @param config - Integration merge configuration.
 * @returns An IntegrationMergeResult.
 */
export async function runIntegrationMerge(
  config: IntegrationMergeConfig,
): Promise<IntegrationMergeResult> {
  const { runId, repoRoot, snapshot, groups, patches, cwd } = config
  const baseCommit = snapshot.head

  // Resolve paths
  const runDir = resolveRunDir(runId, cwd)
  const intWorktreePath = path.join(runDir, "integration-worktree")
  const intBranch = integrationBranchName(runId)
  const consolidatedPatchPath = path.join(runDir, "patches", "_consolidated.patch")

  // Ensure patches dir exists
  try {
    fs.mkdirSync(path.join(runDir, "patches"), { recursive: true })
  } catch {
    // Already exists
  }

  // Compute topological order
  const orderedIds = topoSortGroups(groups)
  if (!orderedIds) {
    return {
      success: false,
      integrationWorktreePath: "",
      error: "Dependency graph contains cycles.",
      summary: "Cannot run integration merge: circular dependency detected in execution groups.",
    }
  }

  // Create integration worktree
  let worktreePath: string
  try {
    worktreePath = createIntegrationWorktree(repoRoot, baseCommit, intWorktreePath, intBranch)
  } catch (err: unknown) {
    return {
      success: false,
      integrationWorktreePath: intWorktreePath,
      error: `Failed to create integration worktree: ${err instanceof Error ? err.message : String(err)}`,
      summary: `Integration merge failed: could not create worktree at "${intWorktreePath}".`,
    }
  }

  // Create group lookup
  const groupMap = new Map(groups.map((g) => [g.id, g]))

  // Merge groups in topological order
  const mergedGroupShas: string[] = []
  let failingGroup: string | undefined
  let mergeError: string | undefined

  for (const groupId of orderedIds) {
    const group = groupMap.get(groupId)
    if (!group) continue

    const patchPath = patches.get(groupId)
    if (!patchPath || !fs.existsSync(patchPath) || fs.statSync(patchPath).size === 0) {
      // No patch for this group — skip
      mergedGroupShas.push("(no-patch)")
      continue
    }

    const groupBranch = groupBranchName(runId, groupId)

    // Create synthetic commit
    let synthSha: string
    try {
      synthSha = createSyntheticCommit(
        worktreePath,
        baseCommit,
        patchPath,
        groupId,
        groupBranch,
      )
    } catch (err: unknown) {
      failingGroup = groupId
      mergeError = `Failed to create synthetic commit for group "${groupId}": ${err instanceof Error ? err.message : String(err)}`
      break
    }

    // Merge group into the integration branch. createSyntheticCommit leaves
    // the worktree checked out on the group branch, so switch back before the
    // merge or the final integration result can silently lose prior groups.
    execFileSync("git", ["checkout", "--force", intBranch], {
      cwd: worktreePath,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    })
    const mergeResult = mergeGroupIntoIntegration(worktreePath, groupBranch, groupId)
    if (!mergeResult.success) {
      failingGroup = groupId
      mergeError = mergeResult.error
      break
    }

    mergedGroupShas.push(mergeResult.commitSha!)
  }

  // If any merge failed, clean up and return
  if (failingGroup) {
    // Don't remove the worktree — preserve it for inspection and subagent resolution
    return {
      success: false,
      integrationWorktreePath: worktreePath,
      failingGroup,
      error: mergeError,
      resolvableByAgent: true,  // merge conflicts can potentially be resolved by a subagent
      summary: [
        `Integration merge failed at group "${failingGroup}".`,
        mergeError ?? "Unknown error",
        "",
        `Integration worktree preserved at: ${worktreePath}`,
        "A subagent may be able to resolve the conflicts.",
        "Otherwise, manually resolve and run --resume.",
      ].join("\n"),
    }
  }

  // All groups merged successfully — generate consolidated patch
  try {
    const consolidatedDiff = execFileSync(
      "git", ["diff", baseCommit, "HEAD", "--binary"],
      {
        cwd: worktreePath,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 10 * 1024 * 1024,
        timeout: 60_000,
      },
    )

    if (!consolidatedDiff.trim()) {
      return {
        success: false,
        integrationWorktreePath: worktreePath,
        error: "No diff produced from integration worktree. No changes to apply?",
        summary: "Integration merge produced no diff — all groups had empty patches.",
      }
    }

    fs.writeFileSync(consolidatedPatchPath, consolidatedDiff, "utf-8")
  } catch (err: unknown) {
    return {
      success: false,
      integrationWorktreePath: worktreePath,
      error: `Failed to generate consolidated patch: ${err instanceof Error ? err.message : String(err)}`,
      summary: "Integration merge completed but consolidated patch generation failed.",
    }
  }

  // Verify coverage: check that all group changes are preserved
  const groupCoverageInputs = groups
    .filter((g) => patches.has(g.id) && fs.existsSync(patches.get(g.id)!))
    .map((g) => ({ groupId: g.id, patchPath: patches.get(g.id)! }))

  let coverageReport: CoverageReport | undefined
  try {
    coverageReport = await generateCoverageReport(
      groupCoverageInputs,
      worktreePath,
      baseCommit,
    )
  } catch (err: unknown) {
    // Coverage verification failed — this is serious but we still have the consolidated patch
    return {
      success: false,
      consolidatedPatchPath,
      integrationWorktreePath: worktreePath,
      coverageReport: coverageReport ?? {
        groups: [],
        allCovered: false,
        groupsCovered: 0,
        totalGroups: groupCoverageInputs.length,
        summary: `Coverage verification threw: ${err instanceof Error ? err.message : String(err)}`,
      },
      error: `Coverage verification failed: ${err instanceof Error ? err.message : String(err)}`,
      summary: [
        "Integration merge completed but coverage verification threw an error.",
        `Integration worktree preserved at: ${worktreePath}`,
        `Consolidated patch at: ${consolidatedPatchPath}`,
        "Inspect the integration result manually, or use --resume with manual approval.",
      ].join("\n"),
    }
  }

  // Check coverage
  if (!coverageReport.allCovered) {
    // Coverage failed — some group's changes may be missing
    return {
      success: false,
      consolidatedPatchPath,
      integrationWorktreePath: worktreePath,
      coverageReport,
      error: "Coverage verification failed: some group changes are missing from the merged result.",
      resolvableByAgent: coverageReport.groupsCovered > 0,  // If some groups covered, agent may help
      summary: [
        "Integration merge completed but coverage verification FAILED.",
        coverageReport.summary,
        "",
        `Integration worktree preserved at: ${worktreePath}`,
        `Consolidated patch at: ${consolidatedPatchPath}`,
        "Some group changes may be missing from the merged result.",
        "Run --resume with manual inspection, or request subagent resolution.",
      ].join("\n"),
    }
  }

  // Success! Consolidate and clean up
  return {
    success: true,
    consolidatedPatchPath,
    integrationWorktreePath: worktreePath,
    coverageReport,
    summary: [
      "Integration merge completed successfully.",
      `All ${mergedGroupShas.length} group(s) merged in topological order.`,
      `Coverage verified: all groups fully covered.`,
      `Consolidated patch: ${consolidatedPatchPath}`,
      `Integration worktree: ${worktreePath}`,
    ].join("\n"),
  }
}
