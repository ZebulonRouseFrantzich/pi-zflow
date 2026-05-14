/**
 * pi-zflow-change-workflows extension entrypoint
 *
 * Phase 7 implementation:
 * - Path resolution helpers integrated from pi-zflow-artifacts
 * - `resolveAllPaths` convenience helper for workflow commands
 *
 * TODO(subsequent Phase 7 tasks):
 * - Register extension commands and service via getZflowRegistry()
 * - Register `/zflow-change-prepare <change-path>`, `/zflow-change-implement <change-path>`,
 *   `/zflow-clean` commands
 * - See orchestration.ts, apply-back.ts, verification.ts, plan-validator.ts,
 *   path-guard.ts, failure-log.ts
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

import {
  resolveRuntimeStateDir,
} from "pi-zflow-core/runtime-paths"

import {
  resolveStateIndexPath,
  resolvePlanStatePath,
  resolvePlanVersionDir,
  resolveChangeDir,
  resolveRunStatePath,
  resolveReviewDir,
  resolveCodeReviewFindingsPath,
  resolveFailureLogPath,
  resolveRepoMapPath,
  resolveReconnaissancePath,
} from "pi-zflow-artifacts/artifact-paths"

// ── Path resolution helpers ──────────────────────────────────────

/**
 * All workflow-relevant runtime paths resolved once.
 *
 * This is the single authoritative source of runtime path locations
 * for all workflow commands. Every command should call this to get
 * consistent paths throughout the session.
 */
export interface AllWorkflowPaths {
  /** Root of all runtime state artifacts (`<git-dir>/pi-zflow/`). */
  runtimeStateDir: string
  /** Path to the state index JSON file. */
  stateIndexPath: string
  /** Path to the failure log markdown file. */
  failureLogPath: string
  /** Path to the review artifacts directory. */
  reviewDir: string
  /** Path to the code-review-findings.md file. */
  codeReviewFindingsPath: string
  /** Path to the repo-map.md file. */
  repoMapPath: string
  /** Path to the reconnaissance.md file. */
  reconnaissancePath: string
}

/**
 * Resolve all workflow-relevant runtime paths.
 *
 * Centralises path resolution so that every workflow command resolves
 * paths the same way. Accepts an optional working directory for context.
 *
 * @param cwd - Working directory (defaults to `process.cwd()`)
 */
export function resolveAllPaths(cwd?: string): AllWorkflowPaths {
  return {
    runtimeStateDir: resolveRuntimeStateDir(cwd),
    stateIndexPath: resolveStateIndexPath(cwd),
    failureLogPath: resolveFailureLogPath(cwd),
    reviewDir: resolveReviewDir(cwd),
    codeReviewFindingsPath: resolveCodeReviewFindingsPath(cwd),
    repoMapPath: resolveRepoMapPath(cwd),
    reconnaissancePath: resolveReconnaissancePath(cwd),
  }
}

/**
 * Resolve plan-related paths for a specific change and version.
 *
 * @param changeId - Unique change identifier (kebab-case)
 * @param planVersion - Plan version (e.g. "v1")
 * @param cwd - Working directory (defaults to `process.cwd()`)
 */
export function resolvePlanPaths(
  changeId: string,
  planVersion: string,
  cwd?: string,
): {
  changeDir: string
  planVersionDir: string
  planStatePath: string
} {
  return {
    changeDir: resolveChangeDir(changeId, cwd),
    planVersionDir: resolvePlanVersionDir(changeId, planVersion, cwd),
    planStatePath: resolvePlanStatePath(changeId, cwd),
  }
}

/**
 * Resolve run-related paths for a specific run.
 *
 * @param runId - Unique run identifier
 * @param cwd - Working directory (defaults to `process.cwd()`)
 */
export function resolveRunPaths(
  runId: string,
  cwd?: string,
): {
  runStatePath: string
} {
  return {
    runStatePath: resolveRunStatePath(runId, cwd),
  }
}

// ── State-index lifecycle helpers ─────────────────────────────────

import { loadStateIndex, listStateIndexEntries } from "pi-zflow-artifacts/state-index"
import type { StateIndexEntry } from "pi-zflow-artifacts/state-index"

import {
  discoverUnfinishedWork,
  promptResumeChoices,
  runChangePrepareWorkflow,
  updatePlanState,
  bumpPlanVersion,
  markPlanVersionState,
  buildPlanApprovalQuestions,
  buildImplementationGateQuestions,
  parseInterviewResponse,
  runChangeAuditWorkflow,
  runChangeFixWorkflow,
  runCleanWorkflow,
} from "./orchestration.js"

import {
  loadFragment,
  buildReminderInjection,
  buildModeInjection,
  fragmentExists,
} from "./prompt-fragments.js"

import type {
  ReminderId,
  ModeFragment,
} from "./prompt-fragments.js"

import type {
  PrepareWorkflowOptions,
  PrepareWorkflowResult,
  ImplementationHandoff,
  ImplementWorkflowOptions,
  ImplementWorkflowResult,
  CodeReviewInputContext,
  AuditWorkflowOptions,
  AuditWorkflowResult,
  FixWorkflowOptions,
  FixWorkflowResult,
  CleanWorkflowOptions,
  CleanWorkflowResult,
} from "./orchestration.js"

import {
  resolveVerificationCommand,
  runVerification,
  appendFailureLog,
  runVerificationFixLoop,
} from "./verification.js"

import {
  readFailureLog,
  findRelevantFailures,
  appendFailureEntry,
  formatFailureLogEntries,
  parseFailureLog,
} from "./failure-log.js"

import type {
  VerificationResult,
  FixLoopOptions,
  FixLoopResult,
  FixAttempt,
} from "./verification.js"

export {
  discoverUnfinishedWork,
  promptResumeChoices,
  runChangePrepareWorkflow,
  updatePlanState,
  bumpPlanVersion,
  markPlanVersionState,
  runChangeImplementWorkflow,
  loadFragment,
  buildReminderInjection,
  buildModeInjection,
  fragmentExists,
  buildImplementationHandoff,
  serializeHandoff,
  deserializeHandoff,
  buildHandoffPromptPrefix,
  canForkSession,
  resolveVerificationCommand,
  runVerification,
  appendFailureLog,
  runVerificationFixLoop,
  handlePlanDrift,
  createPlanAmendment,
  buildDriftDetectedReminder,
  buildCodeReviewInputFromContext,
  runChangeAuditWorkflow,
  runChangeFixWorkflow,
  runCleanWorkflow,
  readFailureLog,
  findRelevantFailures,
  appendFailureEntry,
  formatFailureLogEntries,
  parseFailureLog,
}

export type {
  StateIndexEntry,
  ReminderId,
  ModeFragment,
  PrepareWorkflowOptions,
  PrepareWorkflowResult,
  ImplementationHandoff,
  ImplementWorkflowOptions,
  ImplementWorkflowResult,
  VerificationResult,
  FixLoopOptions,
  FixLoopResult,
  FixAttempt,
  DriftResolution,
  CodeReviewInputContext,
  AuditWorkflowOptions,
  AuditWorkflowResult,
  FixWorkflowOptions,
  FixWorkflowResult,
  CleanWorkflowOptions,
  CleanWorkflowResult,
  FailureLogEntry,
}

// ── Extension activation ────────────────────────────────────────

export default function activateZflowChangeWorkflowsExtension(pi: ExtensionAPI): void {
  // Registration logic will be added in subsequent Phase 7 tasks

  pi.registerCommand("zflow-clean", {
    description: "Clean stale runtime artifacts, orphaned worktrees, and expired metadata",
    handler: async (args: string, ctx: {
      ui: { notify: (message: string, type?: "info" | "warning" | "error") => void }
    }): Promise<void> => {
      // Parse arguments
      const parts = args.trim().split(/\s+/)
      const options: CleanWorkflowOptions = {}
      for (let i = 0; i < parts.length; i++) {
        switch (parts[i]) {
          case "--dry-run":
            options.dryRun = true
            break
          case "--orphans":
            options.orphans = true
            break
          case "--older-than":
            i++
            if (i < parts.length) {
              options.olderThan = parseInt(parts[i], 10)
              if (isNaN(options.olderThan)) {
                ctx.ui.notify(`Invalid --older-than value: ${parts[i]}`, "error")
                return
              }
            }
            break
          default:
            ctx.ui.notify(`Unknown option: ${parts[i]}`, "warning")
            break
        }
      }

      ctx.ui.notify(
        options.dryRun
          ? "🧹 Dry-run cleanup — previewing stale artifacts..."
          : "🧹 Running cleanup...",
      )

      try {
        const result = await runCleanWorkflow(options)

        ctx.ui.notify(result.summary, "info")

        if (options.dryRun) {
          ctx.ui.notify(
            `Preview: ${result.cleaned} artifact(s) would be cleaned, ${result.kept} kept.`,
            "info",
          )
          ctx.ui.notify("Run without --dry-run to actually clean.", "info")
        } else {
          if (result.errors.length > 0) {
            ctx.ui.notify(
              `Cleaned ${result.cleaned} artifact(s). ${result.errors.length} error(s) occurred.`,
              result.errors.length > 0 ? "warning" : "info",
            )
          } else {
            ctx.ui.notify(`Cleaned ${result.cleaned} artifact(s).`, "info")
          }
        }
      } catch (err: unknown) {
        ctx.ui.notify(
          `Cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        )
      }
    },
  })
}
