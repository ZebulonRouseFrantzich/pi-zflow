/**
 * path-helpers.ts — shared runtime path resolution helpers for workflow commands.
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

function sanitizeWorkflowSessionToken(token: string, fallback: string): string {
  const sanitized = token
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return sanitized || fallback
}

export function buildWorkflowIntercomSessionName(
  workflow: "implement" | "fix",
  changeId: string,
  sessionId: string,
): string {
  const safeChangeId = sanitizeWorkflowSessionToken(changeId, "change")
  const safeSessionId = sanitizeWorkflowSessionToken(sessionId, "session").slice(0, 8) || "session"
  return `zflow-${workflow}-${safeChangeId}-${safeSessionId}`
}

export function ensureWorkflowIntercomTarget(
  pi: Pick<ExtensionAPI, "getSessionName" | "setSessionName">,
  ctx: { sessionManager?: { getSessionId?: () => string } },
  workflow: "implement" | "fix",
  changeId: string,
): string | undefined {
  const existing = pi.getSessionName()?.trim()
  if (existing) return existing

  const sessionId = ctx.sessionManager?.getSessionId?.()
  if (!sessionId) return undefined

  const generated = buildWorkflowIntercomSessionName(workflow, changeId, sessionId)
  pi.setSessionName(generated)
  return generated
}
