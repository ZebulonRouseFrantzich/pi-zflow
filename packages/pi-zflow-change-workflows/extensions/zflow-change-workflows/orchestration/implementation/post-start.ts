/**
 * post-start.ts — post-dispatch verification, review, completion, and helpers.
 */

import { readRun, setRunPhase, updateRun } from "pi-zflow-artifacts"
import type { RunPhase } from "pi-zflow-artifacts"
import {
  resolvePlanArtifactPath,
  resolvePlanStatePath,
  resolveRunDir,
  resolveStateIndexPath,
} from "pi-zflow-artifacts/artifact-paths"
import { loadStateIndex, updateStateIndexEntry } from "pi-zflow-artifacts/state-index"

import { finalizeCodeReview } from "../review/code-review.js"
import type { ReviewerProgressCallback } from "../review/code-review.js"
import { recordImplementationNextSteps } from "./workflow.js"
import { appendFailureLog, runVerificationFixLoop } from "../../verification.js"

export type { ReviewerProgressCallback } from "../review/code-review.js"

/**
 * Format a user-facing apply-back failure message that always includes
 * the run ID and the exact recovery command.
 *
 * Builds a consistent message from run.json metadata and optional extra
 * info about preserved artifacts. Every apply-back failure handler
 * should call this instead of constructing its own ad-hoc message.
 */
export async function formatApplyBackFailureMessage(
  runId: string,
  changeInput: string,
  error: string,
  cwd?: string,
  extra?: {
    integrationWorktreePath?: string
    patchesDir?: string
    resolutionPromptPath?: string
    strategiesAttempted?: string[]
  },
): Promise<string> {
  const { default: path } = await import("node:path")

  let changeId: string | undefined
  try {
    const run = await readRun(runId, cwd)
    changeId = run.changeId
  } catch {
    changeId = undefined
  }

  const runDir = resolveRunDir(runId, cwd)
  const defaultPatchesDir = extra?.patchesDir ?? path.join(runDir, "patches")
  const strategies = extra?.strategiesAttempted?.length
    ? extra.strategiesAttempted.join(", ")
    : "patch-replay, structured-merge, integration-merge"

  const lines: string[] = [
    `⚠️ **Apply-back failed for run \`${runId}\`**` +
      (changeId ? ` on change \`${changeId}\`.` : "."),
    "",
    `**Error:** ${error}`,
    "",
    "**What was preserved:**",
    `- All group patches: \`${defaultPatchesDir}\``,
  ]

  if (extra?.integrationWorktreePath) {
    lines.push(`- Integration worktree: \`${extra.integrationWorktreePath}\``)
  }
  if (extra?.resolutionPromptPath) {
    lines.push(`- Resolution prompt: \`${extra.resolutionPromptPath}\``)
  }
  lines.push(`- Strategies attempted: ${strategies}`)
  lines.push("")

  lines.push(
    "**Options to recover:**",
    "",
    `1. 🤖 Subagent resolution: \`/zflow-resolve-apply-back ${runId}\``,
    `2. 🔧 Manual resolution, then resume: \`/zflow-change-implement ${changeInput} --resume\``,
    `3. 📂 Inspect artifacts at: \`${runDir}\``,
    `4. 🗑️ Abandon and start fresh: \`/zflow-change-implement ${changeInput} --abandon\``,
  )

  return lines.join("\n")
}

/**
 * Run final verification for a completed run.
 *
 * Resolves the verification command via the precedence rules in
 * verification.ts, runs it, logs the result to run.json, and returns
 * pass/fail.
 */
export async function finalizeVerification(
  runId: string,
  cwd?: string,
): Promise<{
  pass: boolean
  status: "passed" | "failed" | "skipped"
  command: string
  output: string
  duration: number
  error?: string
}> {
  const { default: fs } = await import("node:fs/promises")
  const {
    parseVerificationMdCommand,
    resolveVerificationCommand,
    runVerification,
  } = await import("../../verification.js")

  const run = await readRun(runId, cwd)
  const repoRoot = run.repoRoot

  let planCommand: string | null = null
  try {
    const verifMdPath = resolvePlanArtifactPath(run.changeId, run.planVersion, "verification", cwd)
    const verifMdContent = await fs.readFile(verifMdPath, "utf-8")
    planCommand = parseVerificationMdCommand(verifMdContent)
  } catch {
    // verification.md may not exist yet — non-fatal
  }

  const command = resolveVerificationCommand(repoRoot, undefined, planCommand ?? undefined)
  if (!command) {
    console.warn("[zflow] No verification command resolved — marking verification as skipped.")
    await updateRun(runId, {
      verification: { status: "skipped" },
    } as any, cwd)
    return {
      pass: true,
      status: "skipped",
      command: "(none)",
      output: "Verification skipped — no command resolved.",
      duration: 0,
    }
  }

  const result = await runVerification(command, repoRoot)
  const vStatus = result.pass ? "passed" : "failed"
  const truncatedOutput = result.output.length > 2000
    ? result.output.slice(0, 2000) + "\n...(truncated)"
    : result.output

  await updateRun(runId, {
    verification: {
      status: vStatus,
      command: result.command,
      output: truncatedOutput,
      completedAt: new Date().toISOString(),
      failureCount: result.pass ? 0 : 1,
    },
    ...(result.pass ? { codeReview: null } : {}),
  } as any, cwd)

  if (!result.pass) {
    await appendFailureLog(
      `Verification failed for run ${runId}`,
      `- **Command**: \`${command}\`\n- **Output**: \`\`\`\n${result.output}\n\`\`\`\n- **Duration**: ${result.duration}ms`,
      cwd,
    )
  }

  return {
    pass: result.pass,
    status: vStatus,
    command: result.command,
    output: result.output,
    duration: result.duration,
    error: result.error,
  }
}

/**
 * Run a bounded verification fix loop for a run.
 *
 * Delegates to `runVerificationFixLoop` from verification.ts.
 */
export async function runBoundedFixLoop(
  runId: string,
  fixHandler: (verificationResult: import("../../verification.js").VerificationResult) => Promise<boolean>,
  cwd?: string,
): Promise<import("../../verification.js").FixLoopResult> {
  const run = await readRun(runId, cwd)
  const repoRoot = run.repoRoot

  const result = await runVerificationFixLoop({
    repoRoot,
    cwd,
  }, fixHandler)

  await updateRun(runId, {
    verification: {
      status: result.success ? "passed" : "failed",
      completedAt: new Date().toISOString(),
      failureCount: result.success ? 0 : result.fixAttempts.length,
    },
    ...(result.success ? { codeReview: null } : {}),
  } as any, cwd)

  if (!result.success) {
    await appendFailureLog(
      `Fix loop exhausted for run ${runId}`,
      `- **Iterations**: ${result.iterations}\n- **Timed out**: ${result.timedOut}\n- **Final verification**: ${result.finalVerification.pass ? "passed" : "failed"}`,
      cwd,
    )
  }

  return result
}

/**
 * Mark a workflow as completed in plan-state.json, run.json, and the state index.
 *
 * Logs completion to failure-log if any issues occurred during the run.
 */
export async function completeWorkflow(
  changeId: string,
  runId: string,
  cwd?: string,
): Promise<void> {
  const { default: fs } = await import("node:fs/promises")
  const { getChangeLifecycle, upsertChangeLifecycle } = await import("pi-zflow-artifacts/state-index")

  const currentRun = await readRun(runId, cwd)
  if (currentRun.applyBack.status === "conflicted" || currentRun.applyBack.status === "rolled-back" || currentRun.applyBack.status === "failed") {
    const errMsg = `Cannot complete workflow for run ${runId}: apply-back status is "${currentRun.applyBack.status}". Resolve the apply-back conflict first.`
    console.error(`[zflow] ${errMsg}`)
    throw new Error(errMsg)
  }

  const completedAt = new Date().toISOString()

  const planStatePath = resolvePlanStatePath(changeId, cwd)
  const planState = JSON.parse(await fs.readFile(planStatePath, "utf-8"))
  planState.lifecycleState = "completed"
  planState.updatedAt = completedAt
  await fs.writeFile(planStatePath, JSON.stringify(planState, null, 2), "utf-8")

  const metadata = { ...(currentRun.metadata ?? {}) } as Record<string, unknown>
  const dispatchProgress = metadata.dispatchProgress && typeof metadata.dispatchProgress === "object"
    ? { ...(metadata.dispatchProgress as Record<string, unknown>) }
    : undefined
  if (dispatchProgress) {
    dispatchProgress.status = "completed"
    dispatchProgress.updatedAt = completedAt
    dispatchProgress.lastWorkflowUpdate = "Workflow completed successfully."
    if (typeof dispatchProgress.totalGroups === "number") {
      dispatchProgress.completedGroups = dispatchProgress.totalGroups
    }
    metadata.dispatchProgress = dispatchProgress
  }

  await updateRun(runId, {
    phase: "completed",
    applyBack: currentRun.applyBack.status === "pending" || currentRun.applyBack.status === "in-progress"
      ? {
          ...currentRun.applyBack,
          status: "completed",
          completedAt,
        }
      : currentRun.applyBack,
    nextSteps: [],
    metadata,
  } as any, cwd)

  const index = await loadStateIndex(cwd)
  const runEntry = index.entries.find(
    (e) => e.type === "run" && e.id === runId,
  )
  if (runEntry) {
    runEntry.status = "completed"
    runEntry.updatedAt = completedAt
  }
  const planEntry = index.entries.find(
    (e) => e.type === "plan" && e.metadata?.changeId === changeId,
  )
  if (planEntry) {
    planEntry.status = "completed"
    planEntry.updatedAt = completedAt
  }
  await fs.writeFile(resolveStateIndexPath(cwd), JSON.stringify(index, null, 2), "utf-8")

  const lifecycle = await getChangeLifecycle(changeId, cwd)
  if (lifecycle) {
    await upsertChangeLifecycle({
      ...lifecycle,
      lastPhase: "completed",
      unfinishedRuns: lifecycle.unfinishedRuns.filter((id) => id !== runId),
    }, cwd)
  }

  try {
    const run = await readRun(runId, cwd)
    if (run.verification && run.verification.status === "failed") {
      await appendFailureLog(
        `Workflow completed with issues for run ${runId}`,
        `- **Change**: ${changeId}\n- **Verification**: ${run.verification.status}\n- **Completed at**: ${completedAt}`,
        cwd,
      )
    }
  } catch {
    // run.json may not be readable — that's OK
  }

  console.info(`[zflow] Workflow completed for change "${changeId}" (run ${runId}).`)
}

/**
 * Scan for orphaned helper scripts at the repo root and `scripts/` directory.
 */
export async function scanForOrphanedScripts(
  options?: {
    cwd?: string
    maxAgeMinutes?: number,
  },
): Promise<string[]> {
  const { default: fs } = await import("node:fs/promises")
  const { default: path } = await import("node:path")
  const maxAge = (options?.maxAgeMinutes ?? 60) * 60 * 1000
  const now = Date.now()
  const cwd = options?.cwd ?? process.cwd()

  const scanDirs = [cwd]
  const scriptsDir = path.join(cwd, "scripts")
  try {
    await fs.access(scriptsDir)
    scanDirs.push(scriptsDir)
  } catch {
    // scripts/ doesn't exist — skip
  }

  const scriptPatterns = [
    /^verify/i,
    /^check/i,
    /^debug/i,
    /^tmp\b/i,
    /^fix-/i,
    /^test-/i,
    /^run-/i,
  ]

  const orphans: string[] = []

  for (const dir of scanDirs) {
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      continue
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry)
      if (entry.startsWith(".")) continue
      if (entry === "scripts" && dir === cwd) continue

      try {
        const stat = await fs.stat(fullPath)
        if (stat.isDirectory()) continue

        const age = now - stat.mtimeMs
        if (age > maxAge) continue

        const matchesPattern = scriptPatterns.some((p) => p.test(entry))
        if (!matchesPattern) continue

        const ext = path.extname(entry).toLowerCase()
        const isScript = [".sh", ".bash", ".zsh", ".js", ".mjs", ".ts", ".py", ".rb", ".pl", ".php", ""].includes(ext)
        if (!isScript) continue

        orphans.push(fullPath)
      } catch {
        // stat failed — skip
      }
    }
  }

  return orphans
}

/**
 * Options for `runImplementationPostStartSequence`.
 */
export interface PostStartSequenceOptions {
  /** If true, skip waiting for dispatch artifacts and proceed to verification. */
  skipDispatchWait?: boolean
  /** If true, skip final verification entirely (review becomes advisory). */
  skipVerification?: boolean
  /** If true, skip code review. */
  skipReview?: boolean
  /** Receives user-visible phase updates for long post-dispatch work. */
  onProgress?: (message: string) => void
  /** Per-reviewer progress callback for code review cards. */
  onReviewerUpdate?: ReviewerProgressCallback
  /** If false, do not attempt auto-fix loop on verification failure (default: true). */
  autoFix?: boolean
  /**
   * Optional fix handler for the bounded fix loop.
   * Receives the failed verification result and returns `true` if a fix
   * was applied. If not provided, the fix loop still runs up to 3 iterations
   * re-checking verification but without applying code changes.
   */
  fixHandler?: (result: import("../../verification.js").VerificationResult) => Promise<boolean>
}

/**
 * Result of running the post-start implementation sequence.
 */
export interface PostStartSequenceResult {
  /** Current phase after the sequence ran (reflects run.json). */
  phase: string
  /** Symbolic status label. */
  status: "waiting-for-dispatch" | "verifying" | "reviewing" | "completed" | "failed" | "verification-skipped"
  /** Verification outcome. */
  verificationStatus: "passed" | "failed" | "skipped" | "pending"
  /** Whether code review passed (if run). */
  reviewPassed?: boolean
  /** Path to code review findings if review was run. */
  reviewFindingsPath?: string
  /** Error message if any phase failed. */
  error?: string
  /** Run identifier. */
  runId: string
  /** Change identifier. */
  changeId: string
  /** Ordered list of next steps. */
  nextSteps: string[]
}

/**
 * Run the combined post-start implementation sequence in order where possible.
 */
export async function runImplementationPostStartSequence(
  runId: string,
  options?: PostStartSequenceOptions,
  cwd?: string,
): Promise<PostStartSequenceResult> {
  const opts = options ?? {}
  const autoFix = opts.autoFix !== false
  const reportProgress = (message: string): void => {
    try { opts.onProgress?.(message) } catch { /* progress callbacks are best-effort */ }
  }

  const run = await readRun(runId, cwd)
  const changeId = run.changeId

  if (run.applyBack.status === "conflicted" || run.applyBack.status === "rolled-back" || run.applyBack.status === "failed") {
    const reason = run.applyBack.error ?? `apply-back ${run.applyBack.status}`
    const failPhase = "apply-back-conflicted" as RunPhase
    await transitionTo(failPhase)

    const { default: pathModule } = await import("node:path")
    const runDir = resolveRunDir(runId, cwd)
    const patchesPath = pathModule.join(runDir, "patches")
    const intWorktreePath = pathModule.join(runDir, "integration-worktree")
    const resolutionPromptPath = pathModule.join(runDir, "subagent-resolution-prompt.md")
    let hasResolutionPrompt = false
    try { await import("node:fs/promises").then((fs) => fs.access(resolutionPromptPath)); hasResolutionPrompt = true } catch {}
    const failureMsg = await formatApplyBackFailureMessage(
      runId,
      changeId,
      reason,
      cwd,
      {
        patchesDir: patchesPath,
        integrationWorktreePath: run.applyBack.integrationWorktreePath ?? (
          await import("node:fs/promises").then((fs) =>
            fs.access(intWorktreePath).then(() => intWorktreePath).catch(() => undefined),
          ).catch(() => undefined)
        ),
        resolutionPromptPath: hasResolutionPrompt ? resolutionPromptPath : undefined,
        strategiesAttempted: (run.metadata as any)?.strategiesAttempted ?? undefined,
      },
    )

    const nextSteps = [
      `⚠️ Apply-back ${run.applyBack.status}. The primary worktree does not have the implementation changes.`,
      `   Reason: ${reason}`,
      `1. 🤖 Subagent resolution: /zflow-resolve-apply-back ${runId}`,
      "2. 🔧 Resolve manually, then run: /zflow-change-implement --resume",
      "3. 📂 Use /zflow-change-audit to inspect the run status.",
      "4. 🗑️ Abandon: /zflow-change-implement --abandon",
    ]
    await recordImplementationNextSteps(runId, nextSteps, cwd)
    reportProgress(failureMsg)
    return {
      phase: failPhase,
      status: "failed",
      verificationStatus: "pending",
      error: `${reason}\n\n${failureMsg}`,
      runId,
      changeId,
      nextSteps,
    }
  }

  async function transitionTo(phase: RunPhase): Promise<void> {
    await setRunPhase(runId, phase, cwd)
    try {
      await updateStateIndexEntry(runId, { status: phase }, cwd)
    } catch {
      // State-index entry may not exist yet — non-fatal
    }
    const { getChangeLifecycle, upsertChangeLifecycle } = await import("pi-zflow-artifacts/state-index")
    const existingLifecycle = await getChangeLifecycle(changeId, cwd)
    if (existingLifecycle) {
      await upsertChangeLifecycle({
        ...existingLifecycle,
        lastPhase: phase,
      }, cwd)
    }
  }

  const ledger = (run.metadata?.groupLedger ?? {}) as Record<string, {
    status?: string
    patchPath?: string
    implementationEvidencePath?: string
    completionMode?: string
    appliedToPrimary?: boolean
  }>
  const hasGroupResults = run.groups.some((g) => g.patchPath && g.patchPath.length > 0)
  const hasLedgerDispatchEvidence = Object.values(ledger).some((entry) =>
    Boolean(entry.patchPath) ||
    entry.status === "succeeded" ||
    entry.status === "applied" ||
    entry.appliedToPrimary === true ||
    ((entry.completionMode === "worker-evidence" || entry.completionMode === "noop-evidence") &&
      Boolean(entry.implementationEvidencePath)),
  )
  const hasApplyBackArtifacts = run.applyBack.status !== "pending"
  const hasDispatchArtifacts = hasGroupResults || hasLedgerDispatchEvidence || hasApplyBackArtifacts

  if (!hasDispatchArtifacts && !opts.skipDispatchWait) {
    reportProgress("Waiting for dispatch artifacts before final verification")
    const nextSteps: string[] = [
      "1. Worktree dispatch: dispatch execution groups to isolated worktrees with per-group agents",
      "2. Worker verification: each worker runs scoped verification before signalling completion",
      "3. Apply-back: merge completed worktree patches back to the primary worktree",
      "4. Final verification: run full verification suite on the primary worktree",
      "5. Code review: run /zflow-review-code to audit the implementation",
      "6. Fix loop: address any verification or review failures, then re-verify",
    ]

    await recordImplementationNextSteps(runId, nextSteps, cwd)

    return {
      phase: run.phase,
      status: "waiting-for-dispatch",
      verificationStatus: "pending",
      runId,
      changeId,
      nextSteps,
    }
  }

  if (opts.skipDispatchWait) {
    console.info(
      "[zflow] skipDispatchWait is true: proceeding without worktree dispatch. " +
      "Worktree dispatch via pi-subagents worktree:true is not yet integrated. " +
      "prepareWorktreeImplementationRun() and finalizeWorktreeImplementationRun() " +
      "helpers exist but are not connected to the command lifecycle. " +
      "The post-start sequence will run verification/review on the primary worktree " +
      "without any isolated worker execution or apply-back.",
    )
  }

  if (opts.skipVerification) {
    await updateRun(runId, {
      verification: { status: "skipped" },
    } as any, cwd)
    await transitionTo("executing")

    if (!opts.skipReview) {
      const reviewResult = await finalizeCodeReview(runId, cwd, opts.onReviewerUpdate)
      await transitionTo(reviewResult.pass ? "executing" : "review-failed")

      if (reviewResult.pass) {
        await completeWorkflow(changeId, runId, cwd)
        return {
          phase: "completed",
          status: "completed",
          verificationStatus: "skipped",
          reviewPassed: true,
          reviewFindingsPath: reviewResult.findingsPath,
          runId,
          changeId,
          nextSteps: [],
        }
      }

      return {
        phase: "review-failed",
        status: "failed",
        verificationStatus: "skipped",
        reviewPassed: false,
        reviewFindingsPath: reviewResult.findingsPath,
        error: reviewResult.summary,
        runId,
        changeId,
        nextSteps: reviewResult.infrastructureFailure
          ? [
              "1. Resolve the review infrastructure/configuration issue.",
              `2. ${reviewResult.recoveryHint ?? "Run /zflow-setup-agents or /zflow-update-agents, then re-run /zflow-change-implement --resume."}`,
            ]
          : [
              "1. Address code review findings",
              "2. Re-run /zflow-change-implement or /zflow-change-fix to proceed",
            ],
      }
    }

    await completeWorkflow(changeId, runId, cwd)
    return {
      phase: "completed",
      status: "completed",
      verificationStatus: "skipped",
      runId,
      changeId,
      nextSteps: [],
    }
  }

  reportProgress("Preparing final verification on the primary worktree")
  await transitionTo("executing")

  if (opts.skipDispatchWait) {
    await recordImplementationNextSteps(runId, [
      "⚠️ Worktree dispatch via pi-subagents worktree:true is NOT yet integrated.",
      "   The implementation ran directly on the primary worktree without isolated worktrees or apply-back.",
      "1. Final verification: run full verification suite on the primary worktree",
      "2. Code review: run /zflow-review-code to audit the implementation",
      "3. Fix loop: address any verification or review failures, then re-verify",
    ], cwd)
  } else {
    await recordImplementationNextSteps(runId, [
      "1. Final verification: run full verification suite on the primary worktree",
      "2. Code review: run /zflow-review-code to audit the implementation",
      "3. Fix loop: address any verification or review failures, then re-verify",
    ], cwd)
  }

  reportProgress("Running final verification on the primary worktree")
  const verificationResult = await finalizeVerification(runId, cwd)
  if (verificationResult.status === "skipped") {
    reportProgress("Final verification was skipped (no command resolved). Gating workflow — user action required.")
    await transitionTo("verification-skipped" as RunPhase)
    await updateRun(runId, {
      verification: { status: "skipped" },
    } as any, cwd)
    return {
      phase: "verification-skipped",
      status: "failed",
      verificationStatus: "skipped",
      runId,
      changeId,
      error: "Final verification skipped — no command resolved. The implementation patches are applied but haven't been verified. Run /zflow-change-audit or pass --skip-verification to proceed without verification.",
      nextSteps: [
        "⚠️ Final verification was skipped because no verification command was resolved.",
        "   The implementation patches have been applied but not validated.",
        "1. Provide a verification command (e.g. in the plan's verification.md) and run --resume.",
        "2. Or manually run verification checks outside of zflow.",
        "3. Use /zflow-change-audit to inspect the run status.",
      ],
    }
  }

  if (verificationResult.pass) {
    reportProgress("Final verification passed; starting code review")
  } else {
    reportProgress("Final verification failed; evaluating fix loop")
  }

  if (!verificationResult.pass) {
    if (autoFix) {
      reportProgress("Running bounded fix loop after verification failure")
      const fixHandler = opts.fixHandler ?? (async () => false)
      const fixLoopResult = await runBoundedFixLoop(runId, fixHandler, cwd)

      if (!fixLoopResult.success) {
        reportProgress("Fix loop exhausted; marking verification failed")
        await transitionTo("verification-failed")
        return {
          phase: "verification-failed",
          status: "failed",
          verificationStatus: "failed",
          runId,
          changeId,
          error: `Fix loop exhausted (${fixLoopResult.iterations} iterations). ` +
            `Final verification: ${fixLoopResult.finalVerification.pass ? "passed" : "failed"}.`,
          nextSteps: [
            "1. Review failure log for details",
            "2. Manually fix issues, then re-run /zflow-change-implement or /zflow-change-fix",
            "3. Use /zflow-change-audit to re-check status",
          ],
        }
      }

      reportProgress("Fix loop succeeded; continuing to code review")
    } else {
      reportProgress("Final verification failed; auto-fix is disabled")
      await transitionTo("verification-failed")
      return {
        phase: "verification-failed",
        status: "failed",
        verificationStatus: "failed",
        runId,
        changeId,
        error: "Final verification failed (auto-fix disabled).",
        nextSteps: [
          "1. Review verification output for details",
          "2. Manually fix issues, then re-run /zflow-change-implement or /zflow-change-fix",
          "3. Use /zflow-change-audit to re-check status",
        ],
      }
    }
  }

  if (!opts.skipReview) {
    reportProgress("Running code review on the applied implementation")
    const reviewResult = await finalizeCodeReview(runId, cwd, opts.onReviewerUpdate)
    reportProgress(reviewResult.pass ? "Code review passed; completing workflow" : "Code review found issues; marking review failed")

    if (!reviewResult.pass) {
      await transitionTo("review-failed")
      return {
        phase: "review-failed",
        status: "failed",
        verificationStatus: "passed",
        reviewPassed: false,
        reviewFindingsPath: reviewResult.findingsPath,
        error: reviewResult.summary,
        runId,
        changeId,
        nextSteps: reviewResult.infrastructureFailure
          ? [
              "1. Resolve the review infrastructure/configuration issue.",
              `2. ${reviewResult.recoveryHint ?? "Run /zflow-setup-agents or /zflow-update-agents, then re-run /zflow-change-implement --resume."}`,
              "3. Re-run /zflow-change-implement to restart the review stage.",
            ]
          : [
              "1. Address code review findings",
              "2. Run /zflow-change-fix to apply fixes",
              "3. Re-run /zflow-change-implement to re-verify",
            ],
      }
    }

    await transitionTo("completed")
    reportProgress("Persisting completed workflow state")
    await completeWorkflow(changeId, runId, cwd)
    reportProgress("Workflow completion persisted")

    try {
      const orphans = await scanForOrphanedScripts({ cwd })
      if (orphans.length > 0) {
        reportProgress(
          `⚠️ Found ${orphans.length} orphaned helper script(s) outside .zflow/:\n` +
          orphans.map((o) => `  - ${o}`).join("\n") +
          "\nThese should be removed or moved to `.zflow/runs/<runId>/scratch/scripts/`.",
        )
      }
    } catch {
      // Non-critical — best-effort scan
    }

    return {
      phase: "completed",
      status: "completed",
      verificationStatus: "passed",
      reviewPassed: true,
      reviewFindingsPath: reviewResult.findingsPath,
      runId,
      changeId,
      nextSteps: [],
    }
  }

  reportProgress("Review skipped; completing workflow")
  await transitionTo("completed")
  await completeWorkflow(changeId, runId, cwd)

  try {
    const orphans = await scanForOrphanedScripts({ cwd })
    if (orphans.length > 0) {
      reportProgress(
        `⚠️ Found ${orphans.length} orphaned helper script(s) outside .zflow/:\n` +
        orphans.map((o) => `  - ${o}`).join("\n") +
        "\nThese should be removed or moved to `.zflow/runs/<runId>/scratch/scripts/`.",
      )
    }
  } catch {
    // Non-critical — best-effort scan
  }

  return {
    phase: "completed",
    status: "completed",
    verificationStatus: "passed",
    runId,
    changeId,
    nextSteps: [],
  }
}
