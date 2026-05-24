/**
 * resume-reconciler.ts — Inspects old implementation run state and determines
 * what can be reused vs. what must be rerun, without complex migration logic.
 *
 * Core principle: if old state can be consumed directly by current code, reuse it.
 * If it would require migration or interpretation, rerun that part.
 *
 * @module pi-zflow-change-workflows/resume-reconciler
 */

import * as path from "node:path"
import * as fs from "node:fs/promises"
import { readRun } from "pi-zflow-artifacts"
import { resolvePlanArtifactPath, resolveRunDir } from "pi-zflow-artifacts/artifact-paths"
import { getChangeLifecycle } from "pi-zflow-artifacts/state-index"
import { parseExecutionGroupsMd } from "./orchestration.js"
import type { ExecutionGroup } from "./ownership-validator.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single group's resume status.
 */
export interface GroupResumeStatus {
  groupId: string
  /** Reuse the existing patch without rerunning the worker. */
  canReuse: boolean
  /** Reason for the decision. */
  reason: string
  /** Path to the existing patch file (if exists). */
  patchPath?: string
  /** Whether this group's patch is verified (scoped verification passed). */
  patchVerified: boolean
  /** Whether this group was already applied to the primary tree. */
  alreadyApplied: boolean
}

/**
 * Result of reconciling a previous run against the current workflow.
 */
export interface ResumeReconciliation {
  /** Whether a previous run was found. */
  hasPreviousRun: boolean
  /** The previous run ID. */
  previousRunId?: string
  /** Previous run phase. */
  previousPhase?: string
  /** Groups whose patches can be reused directly. */
  reusableGroups: GroupResumeStatus[]
  /** Groups that need to be rerun (patch missing, unverified, incompatible). */
  groupsNeedingRerun: GroupResumeStatus[]
  /** Groups that are already applied to primary. */
  alreadyAppliedGroups: GroupResumeStatus[]
  /** Whether apply-back was completed or needs retry. */
  applyBackNeeded: boolean
  /** Whether apply-back should use the smart cascade (always true now). */
  applyBackCanUseCascade: boolean
  /** Whether final verification is needed. */
  verificationNeeded: boolean
  /** Whether code review is needed. */
  reviewNeeded: boolean
  /** Human-readable summary for user display. */
  summary: string
  /** Recommended next step. */
  recommendedNextStep: "rerun-groups" | "apply-back" | "verify" | "review" | "complete" | "inspect"
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a file exists on disk.
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    const stat = await fs.stat(filePath)
    return stat.size > 0
  } catch {
    return false
  }
}

/**
 * Normalized group status from run.json groups array vs groupLedger.
 *
 * The run.json has both:
 * - `run.groups[]` (GroupRunMetadata from captureGroupResult)
 * - `run.metadata?.groupLedger` (GroupStatusEntry from buildGroupLedger)
 *
 * We check both for a complete picture.
 */
interface NormalizedGroupState {
  status: string
  patchPath?: string
  appliedToPrimary: boolean
  scopedVerificationPassed: boolean
}

/**
 * Build a normalized view of a group's state from run.json.
 */
async function buildGroupState(
  runId: string,
  groupId: string,
  cwd?: string,
): Promise<NormalizedGroupState | null> {
  const run = await readRun(runId, cwd).catch(() => null)
  if (!run) return null

  // Check groupLedger first (more authoritative)
  const ledger = (run.metadata?.groupLedger ?? {}) as Record<string, Record<string, unknown>>
  const ledgerEntry = ledger[groupId] as Record<string, unknown> | undefined

  if (ledgerEntry) {
    const status = (ledgerEntry.status as string) ?? ""
    const patchPath = ledgerEntry.patchPath as string | undefined
    const appliedToPrimary = (ledgerEntry.appliedToPrimary as boolean) ?? false
    const scopedVerification = ledgerEntry.scopedVerification as
      | { status?: string }
      | undefined
    const scopedVerificationPassed =
      scopedVerification?.status === "pass" || status === "applied"

    return { status, patchPath, appliedToPrimary, scopedVerificationPassed }
  }

  // Fall back to run.groups[]
  const groupMeta = run.groups.find((g) => g.groupId === groupId)
  if (!groupMeta) return null

  const status = groupMeta.patchPath ? "succeeded" : "pending"
  const patchPath = groupMeta.patchPath ?? undefined
  const appliedToPrimary = false // run.groups has no appliedToPrimary field
  const scopedVerificationPassed =
    groupMeta.scopedVerification?.status === "pass"

  return { status, patchPath, appliedToPrimary, scopedVerificationPassed }
}

// ---------------------------------------------------------------------------
// Main reconciliation function
// ---------------------------------------------------------------------------

/**
 * Reconcile a previous run's state against the current workflow.
 *
 * Algorithm:
 * 1. Read run.json for the given runId.
 * 2. Read the current execution-groups.md from the approved plan.
 * 3. Parse current execution groups.
 * 4. For each current group, check the group ledger and patch state.
 * 5. Classify each group as reusable, needs-rerun, or already-applied.
 * 6. Determine what workflow phase to resume from.
 *
 * @param runId - The previous run ID.
 * @param changeId - The change identifier.
 * @param planVersion - The approved plan version.
 * @param cwd - Working directory (optional).
 * @returns ResumeReconciliation with reusable groups and next step.
 */
export async function reconcileResumeState(
  runId: string,
  changeId: string,
  planVersion: string,
  cwd?: string,
): Promise<ResumeReconciliation> {
  // 1. Read the previous run
  const run = await readRun(runId, cwd).catch(() => null)
  if (!run) {
    return {
      hasPreviousRun: false,
      reusableGroups: [],
      groupsNeedingRerun: [],
      alreadyAppliedGroups: [],
      applyBackNeeded: false,
      applyBackCanUseCascade: true,
      verificationNeeded: false,
      reviewNeeded: false,
      summary: `Previous run "${runId}" not found. Cannot resume.`,
      recommendedNextStep: "inspect",
    }
  }

  const previousPhase = run.phase
  const previousRunId = runId

  // 2. Read the current execution groups from the approved plan
  let currentGroups: ExecutionGroup[] = []
  try {
    const execGroupsPath = resolvePlanArtifactPath(changeId, planVersion, "execution-groups", cwd)
    const execGroupsMd = await fs.readFile(execGroupsPath, "utf-8")
    currentGroups = parseExecutionGroupsMd(execGroupsMd)
  } catch {
    // If we can't read the plan, try to use the run's stored groups
    if (run.groups.length > 0) {
      currentGroups = run.groups.map((g) => ({
        id: g.groupId,
        files: g.changedFiles,
        dependencies: [],
        parallelizable: true,
      }))
    }
  }

  if (currentGroups.length === 0) {
    return {
      hasPreviousRun: true,
      previousRunId,
      previousPhase,
      reusableGroups: [],
      groupsNeedingRerun: [],
      alreadyAppliedGroups: [],
      applyBackNeeded: false,
      applyBackCanUseCascade: true,
      verificationNeeded: false,
      reviewNeeded: false,
      summary: `No execution groups found for change "${changeId}". Cannot determine resume state.`,
      recommendedNextStep: "inspect",
    }
  }

  // 3. Classify each group
  const reusableGroups: GroupResumeStatus[] = []
  const groupsNeedingRerun: GroupResumeStatus[] = []
  const alreadyAppliedGroups: GroupResumeStatus[] = []

  for (const group of currentGroups) {
    const state = await buildGroupState(runId, group.id, cwd)

    if (!state) {
      // Group not found in previous run at all — needs rerun
      groupsNeedingRerun.push({
        groupId: group.id,
        canReuse: false,
        reason: "No previous state found for this group.",
        patchVerified: false,
        alreadyApplied: false,
      })
      continue
    }

    if (state.appliedToPrimary || state.status === "applied" || state.status === "skipped") {
      alreadyAppliedGroups.push({
        groupId: group.id,
        canReuse: true,
        reason:
          state.status === "skipped"
            ? "Group was skipped in previous run."
            : "Group patch already applied to primary tree.",
        patchPath: state.patchPath,
        patchVerified: true,
        alreadyApplied: true,
      })
      continue
    }

    // Check if the patch file exists on disk
    let patchExists = false
    if (state.patchPath) {
      patchExists = await fileExists(state.patchPath)
    }

    if (patchExists && state.status === "succeeded") {
      reusableGroups.push({
        groupId: group.id,
        canReuse: true,
        reason: "Patch exists on disk and group succeeded.",
        patchPath: state.patchPath,
        patchVerified: state.scopedVerificationPassed,
        alreadyApplied: false,
      })
    } else {
      // Cannot reuse — needs rerun
      let reason: string
      if (!state.patchPath) {
        reason = "No patch artifact path recorded."
      } else if (!patchExists) {
        reason = `Patch file missing from disk: ${state.patchPath}`
      } else if (state.status !== "succeeded") {
        reason = `Group status is "${state.status}", not "succeeded".`
      } else {
        reason = "Cannot reuse — state does not meet reuse criteria."
      }

      groupsNeedingRerun.push({
        groupId: group.id,
        canReuse: false,
        reason,
        patchPath: state.patchPath,
        patchVerified: state.scopedVerificationPassed,
        alreadyApplied: false,
      })
    }
  }

  // 4. Determine what phase to resume from
  const allApplied = alreadyAppliedGroups.length === currentGroups.length
  const allHavePatches = reusableGroups.length === currentGroups.length
  const anyNeedRerun = groupsNeedingRerun.length > 0
  const someReusableSomeApplied =
    reusableGroups.length > 0 &&
    alreadyAppliedGroups.length > 0 &&
    !anyNeedRerun
  const mixedState =
    reusableGroups.length > 0 || alreadyAppliedGroups.length > 0

  // Determine apply-back need
  let applyBackNeeded: boolean
  if (allApplied) {
    applyBackNeeded = false
  } else if (allHavePatches || someReusableSomeApplied) {
    // Some patches are ready and some may be already applied
    applyBackNeeded = reusableGroups.length > 0
  } else {
    applyBackNeeded = false // will need to rerun first
  }

  // Always prefer cascade
  const applyBackCanUseCascade = true

  // Determine verification/review need based on phase history
  const verificationNeeded =
    previousPhase === "verification-failed" ||
    previousPhase === "review-failed" ||
    previousPhase === "completed" ||
    (previousPhase !== "verification-failed" && allApplied)

  const reviewNeeded = previousPhase === "review-failed"

  // Determine the recommended next step
  let recommendedNextStep: ResumeReconciliation["recommendedNextStep"]
  if (anyNeedRerun) {
    recommendedNextStep = "rerun-groups"
  } else if (applyBackNeeded) {
    recommendedNextStep = "apply-back"
  } else if (previousPhase === "verification-failed") {
    recommendedNextStep = "verify"
  } else if (previousPhase === "review-failed") {
    recommendedNextStep = "review"
  } else if (allApplied) {
    recommendedNextStep = "verify"
  } else {
    recommendedNextStep = "inspect"
  }

  // Build a human-readable summary
  const totalGroups = currentGroups.length
  const reusableCount = reusableGroups.length
  const rerunCount = groupsNeedingRerun.length
  const appliedCount = alreadyAppliedGroups.length

  const parts: string[] = [
    `Resume analysis for run "${previousRunId}" (phase: ${previousPhase}):`,
    "",
    `- ${reusableCount}/${totalGroups} group(s) reusable (patches available).`,
    `- ${rerunCount}/${totalGroups} group(s) need rerun.`,
    `- ${appliedCount}/${totalGroups} group(s) already applied.`,
    "",
  ]

  if (reusableCount > 0) {
    parts.push("Reusable groups:")
    for (const g of reusableGroups) {
      parts.push(`  - ${g.groupId}: ${g.reason}`)
    }
    parts.push("")
  }

  if (rerunCount > 0) {
    parts.push("Groups needing rerun:")
    for (const g of groupsNeedingRerun) {
      parts.push(`  - ${g.groupId}: ${g.reason}`)
    }
    parts.push("")
  }

  if (appliedCount > 0) {
    parts.push("Already applied groups:")
    for (const g of alreadyAppliedGroups) {
      parts.push(`  - ${g.groupId}: ${g.reason}`)
    }
    parts.push("")
  }

  parts.push(`Recommended next step: ${recommendedNextStep}`)
  if (applyBackNeeded) {
    parts.push("Apply-back will use the smart cascade strategy.")
  }

  return {
    hasPreviousRun: true,
    previousRunId,
    previousPhase,
    reusableGroups,
    groupsNeedingRerun,
    alreadyAppliedGroups,
    applyBackNeeded,
    applyBackCanUseCascade,
    verificationNeeded,
    reviewNeeded,
    summary: parts.join("\n"),
    recommendedNextStep,
  }
}

// ---------------------------------------------------------------------------
// Finding the best resume run
// ---------------------------------------------------------------------------

/**
 * Find the latest unfinished run for a change.
 *
 * Prefers runs with phase "partial", then "apply-back-conflicted",
 * then "executing". Returns null if no unfinished run is found.
 *
 * @param changeId - The change identifier.
 * @param cwd - Working directory (optional).
 * @returns The run ID, or null.
 */
export async function findBestResumeRun(
  changeId: string,
  cwd?: string,
): Promise<string | null> {
  try {
    const cl = await getChangeLifecycle(changeId, cwd)
    if (!cl || cl.unfinishedRuns.length === 0) return null

    // Phase preference order
    const phasePreference = [
      "partial",
      "apply-back-conflicted",
      "executing",
      "verification-failed",
      "review-failed",
      "pending",
      "failed",
      "drift-pending",
    ]

    const runIds = cl.unfinishedRuns.slice().reverse()

    // First pass: check by phase preference
    for (const phase of phasePreference) {
      for (const runId of runIds) {
        try {
          const run = await readRun(runId, cwd)
          if (run.phase === phase) {
            return runId
          }
        } catch {
          continue
        }
      }
    }

    // Second pass: return the most recent run regardless of phase
    for (const runId of runIds) {
      try {
        const run = await readRun(runId, cwd)
        if (run) return runId
      } catch {
        continue
      }
    }

    return null
  } catch {
    return null
  }
}
