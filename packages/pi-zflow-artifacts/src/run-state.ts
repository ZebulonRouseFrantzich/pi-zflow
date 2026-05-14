/**
 * run-state.ts — Run lifecycle tracking with recovery-grade metadata.
 *
 * **Phase 5 implementation.**
 * Creates and manages run.json for recovery metadata, pre-apply snapshots,
 * group tracking, and retained artifact metadata.
 *
 * ## States
 *
 * - `pending` → `executing` → `applying` → `completed` | `failed` | `apply-back-conflicted`
 * - `pending` → `executing` → `drift-pending`
 *
 * @module pi-zflow-artifacts/run-state
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { resolveRunDir, resolveRunStatePath } from "./artifact-paths.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Phases in the run lifecycle.
 */
export type RunPhase =
  | "pending"
  | "executing"
  | "applying"
  | "completed"
  | "failed"
  | "apply-back-conflicted"
  | "drift-pending"
  | "verification-failed"
  | "review-failed"

/**
 * Apply-back status for the run.
 */
export interface ApplyBackStatus {
  /** Current apply-back phase. */
  status: "pending" | "in-progress" | "completed" | "conflicted" | "rolled-back"
  /** ISO timestamp when apply-back started. */
  startedAt?: string
  /** ISO timestamp when apply-back completed or failed. */
  completedAt?: string
  /** ID of the group that caused a conflict (if conflicted). */
  failingGroup?: string
  /** Error message from the conflict (if conflicted). */
  error?: string
}

/**
 * Verification status for the run.
 */
export interface VerificationStatus {
  /** Current verification phase. */
  status: "pending" | "in-progress" | "passed" | "failed" | "skipped"
  /** ISO timestamp when verification completed. */
  completedAt?: string
  /** Number of verification failures. */
  failureCount?: number
}

/**
 * A snapshot of the primary worktree state before apply-back.
 */
export interface PreApplySnapshot {
  /** Full SHA of HEAD before apply. */
  head: string
  /** Git index state description. */
  indexState: string
  /** Recovery reference for git (e.g. "refs/zflow/recovery/<run-id>"). */
  recoveryRef: string
}

/**
 * Metadata for a single execution group.
 */
export interface GroupRunMetadata {
  /** Group identifier from execution-groups.md. */
  groupId: string
  /** Assigned agent runtime name. */
  agent: string
  /** Absolute path to the worktree. */
  worktreePath: string
  /** Base commit SHA (HEAD of primary when worktree was created). */
  baseCommit: string
  /** Head commit SHA of the worktree after worker completed. */
  headCommit?: string
  /** Files changed by this group (relative to repo root). */
  changedFiles: string[]
  /** Files with uncommitted changes in the worktree (empty if all changes committed). */
  uncommittedChanges?: string[]
  /** Path to the patch artifact. */
  patchPath: string
  /** Result of scoped verification. */
  scopedVerification?: {
    status: "pass" | "fail" | "skipped" | "missing"
    command?: string
    output?: string
  }
  /** Whether this group's artifacts should be retained. */
  retained: boolean
}

/**
 * A retained artifact entry for cleanup tracking.
 */
export interface RetainedArtifact {
  /** Type of artifact ("worktree" | "patch" | "log"). */
  type: "worktree" | "patch" | "log"
  /** Absolute path to the artifact. */
  path: string
  /** Human-readable reason for retention. */
  reason: string
  /** ISO timestamp when the artifact expires. */
  expiresAt: string
}

/**
 * Complete run metadata document.
 */
export interface RunJson {
  /** Unique run identifier. */
  runId: string
  /** Absolute path to the repository root. */
  repoRoot: string
  /** Branch name at the time the run started. */
  branch: string
  /** Full SHA of HEAD at run start. */
  head: string
  /** Change identifier from the plan. */
  changeId: string
  /** Plan version (e.g. "v1"). */
  planVersion: string
  /** Current run phase. */
  phase: RunPhase
  /** Pre-apply snapshot (recorded before workers are dispatched). */
  preApplySnapshot?: PreApplySnapshot
  /** Metadata per execution group. */
  groups: GroupRunMetadata[]
  /** Apply-back status. */
  applyBack: ApplyBackStatus
  /** Verification status. */
  verification: VerificationStatus
  /** Retained artifact entries. */
  retainedArtifacts: RetainedArtifact[]
  /** ISO timestamp when the run was created. */
  createdAt: string
  /** ISO timestamp when the run was last updated. */
  updatedAt: string
  /** Optional generic metadata bag (e.g. worktreeDirty flag, next steps). */
  metadata?: Record<string, unknown>
  /** Ordered list of step descriptions for what should happen next. */
  nextSteps?: string[]
}

// ---------------------------------------------------------------------------
// Run creation
// ---------------------------------------------------------------------------

/**
 * Create a new run.json with initial metadata.
 *
 * Records the current branch, HEAD sha, and recovery reference before any
 * workers are dispatched. Creates the run directory and writes the initial
 * run.json atomically.
 *
 * @param runId - Unique run identifier.
 * @param repoRoot - Absolute path to the git repository root.
 * @param changeId - Change identifier from the plan.
 * @param planVersion - Plan version (e.g. "v1").
 * @param cwd - Working directory (optional, for resolving runtime state dir).
 * @returns The created RunJson document.
 * @throws If the run directory already exists.
 */
export async function createRun(
  runId: string,
  repoRoot: string,
  changeId: string,
  planVersion: string,
  cwd?: string,
): Promise<RunJson> {
  const runDir = resolveRunDir(runId, cwd)
  const runPath = resolveRunStatePath(runId, cwd)

  // Ensure the run directory doesn't already exist
  try {
    await fs.access(runPath)
    // File exists — this is an error
    throw new Error(`Run ${runId} already exists at ${runPath}`)
  } catch (err: unknown) {
    // If fs.access threw ENOENT, the file doesn't exist — that's fine
    const nodeErr = err as NodeJS.ErrnoException
    if (nodeErr.code === "ENOENT") {
      // File doesn't exist, proceed
    } else if (err instanceof Error && err.message.startsWith("Run ")) {
      // This is our "already exists" error — re-throw it
      throw err
    } else if (err instanceof Error) {
      // Some other error from fs.access — re-throw
      throw err
    }
  }

  // Capture current git state
  const branch = getCurrentBranch(repoRoot)
  const head = getHeadSha(repoRoot)
  const recoveryRef = `refs/zflow/recovery/${runId}`

  const now = new Date().toISOString()

  const run: RunJson = {
    runId,
    repoRoot,
    branch,
    head,
    changeId,
    planVersion,
    phase: "pending",
    preApplySnapshot: {
      head,
      indexState: "clean", // verified by preflight
      recoveryRef,
    },
    groups: [],
    applyBack: { status: "pending" },
    verification: { status: "pending" },
    retainedArtifacts: [],
    createdAt: now,
    updatedAt: now,
  }

  // Create the run directory
  await fs.mkdir(runDir, { recursive: true })

  // Write atomically using a temp file
  const tmpPath = runPath + ".tmp"
  await fs.writeFile(tmpPath, JSON.stringify(run, null, 2), "utf-8")
  await fs.rename(tmpPath, runPath)

  return run
}

/**
 * Read an existing run.json file.
 *
 * @param runId - Unique run identifier.
 * @param cwd - Working directory (optional).
 * @returns The parsed RunJson document.
 * @throws If the run.json does not exist or is malformed.
 */
export async function readRun(runId: string, cwd?: string): Promise<RunJson> {
  const runPath = resolveRunStatePath(runId, cwd)
  const content = await fs.readFile(runPath, "utf-8")
  return JSON.parse(content) as RunJson
}

/**
 * Update a run.json file with partial changes.
 *
 * Merges the provided partial update into the existing run.json and writes
 * it back atomically. Also updates the `updatedAt` timestamp.
 *
 * @param runId - Unique run identifier.
 * @param partial - Partial RunJson fields to merge.
 * @param cwd - Working directory (optional).
 * @returns The updated RunJson document.
 */
export async function updateRun(
  runId: string,
  partial: Partial<RunJson>,
  cwd?: string,
): Promise<RunJson> {
  const run = await readRun(runId, cwd)
  const updated: RunJson = {
    ...run,
    ...partial,
    updatedAt: new Date().toISOString(),
  }

  const runPath = resolveRunStatePath(runId, cwd)
  const tmpPath = runPath + ".tmp"
  await fs.writeFile(tmpPath, JSON.stringify(updated, null, 2), "utf-8")
  await fs.rename(tmpPath, runPath)

  return updated
}

/**
 * Add a group's metadata to a run.
 *
 * @param runId - Unique run identifier.
 * @param groupMeta - The group metadata to append.
 * @param cwd - Working directory (optional).
 */
export async function addGroupToRun(
  runId: string,
  groupMeta: GroupRunMetadata,
  cwd?: string,
): Promise<void> {
  const run = await readRun(runId, cwd)
  run.groups.push(groupMeta)
  await updateRun(runId, { groups: run.groups }, cwd)
}

/**
 * Add a retained artifact entry to a run.
 *
 * @param runId - Unique run identifier.
 * @param artifact - The retained artifact entry.
 * @param cwd - Working directory (optional).
 */
export async function addRetainedArtifact(
  runId: string,
  artifact: RetainedArtifact,
  cwd?: string,
): Promise<void> {
  const run = await readRun(runId, cwd)
  run.retainedArtifacts.push(artifact)
  await updateRun(runId, { retainedArtifacts: run.retainedArtifacts }, cwd)
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Get the current branch name (or "HEAD" if detached).
 */
function getCurrentBranch(repoRoot: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  } catch {
    return "HEAD"
  }
}

/**
 * Get the full SHA of HEAD.
 */
function getHeadSha(repoRoot: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

// ---------------------------------------------------------------------------
// Recovery ref helpers
// ---------------------------------------------------------------------------

/**
 * Create a git recovery reference that points to the current HEAD.
 *
 * The recovery ref (e.g. `refs/zflow/recovery/<run-id>`) is used to
 * restore the pre-apply state if apply-back needs to be rolled back.
 *
 * @param runId - Unique run identifier.
 * @param repoRoot - Absolute path to the git repository root.
 * @param headSha - Full SHA to point the ref at.
 */
export function createRecoveryRef(
  runId: string,
  repoRoot: string,
  headSha: string,
): void {
  execFileSync("git", ["update-ref", `refs/zflow/recovery/${runId}`, headSha], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  })
}

/**
 * Remove a git recovery reference.
 *
 * @param runId - Unique run identifier.
 * @param repoRoot - Absolute path to the git repository root.
 */
export function removeRecoveryRef(
  runId: string,
  repoRoot: string,
): void {
  try {
    execFileSync("git", ["update-ref", "-d", `refs/zflow/recovery/${runId}`], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch {
    // Ignore errors if the ref doesn't exist
  }
}

/**
 * Reset the primary worktree to the pre-apply snapshot.
 *
 * Uses the recovery ref if available, or a hard reset to the recorded head.
 *
 * @param runId - Unique run identifier.
 * @param repoRoot - Absolute path to the git repository root.
 * @param snapshot - The pre-apply snapshot to restore.
 */
export function resetToPreApplySnapshot(
  runId: string,
  repoRoot: string,
  snapshot: PreApplySnapshot,
): void {
  // Try recovery ref first, fall back to recorded head
  try {
    execFileSync("git", ["reset", "--hard", `refs/zflow/recovery/${runId}`], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch {
    execFileSync("git", ["reset", "--hard", snapshot.head], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    })
  }
  // NOTE: We intentionally do NOT run `git clean -fd` here.
  // Preflight permits non-overlapping untracked files, and a blanket clean
  // would delete unrelated user files that existed before dispatch.
  // The hard reset restores tracked files; untracked files created by apply
  // are harmless orphans that can be ignored or cleaned selectively.
}

/**
 * Mark a run's phase with atomic update.
 *
 * @param runId - Unique run identifier.
 * @param phase - The new phase.
 * @param cwd - Working directory (optional).
 */
export async function setRunPhase(
  runId: string,
  phase: RunPhase,
  cwd?: string,
): Promise<void> {
  await updateRun(runId, { phase }, cwd)
}
