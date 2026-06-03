import { execFileSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import * as path from "node:path"

import { readRun, updateRun } from "pi-zflow-artifacts"
import { resolvePlanArtifactPath } from "pi-zflow-artifacts/artifact-paths"
import { inferClaimedFileRepoRoots } from "pi-zflow-core"
import { getZflowRegistry } from "pi-zflow-core/registry"

import { getCurrentBranch } from "../../git-preflight.js"
import { parseExecutionGroupsMd } from "../execution-groups.js"

/**
 * Input shape for code review, matching the CodeReviewInput interface
 * from pi-zflow-review's runCodeReview.
 */
export interface CodeReviewInputContext {
  source: string
  repoPath: string
  branch: string
  planningArtifacts: {
    design: string
    executionGroups: string
    standards: string
    verification: string
  }
  verificationStatus: "passed" | "failed" | "skipped" | "unknown"
  cwd?: string
}

/**
 * Per-reviewer progress callback used by implement workflow progress cards.
 */
export interface ReviewerProgressCallback {
  (update: {
    reviewerName: string
    agentName: string
    status: "queued" | "running" | "completed" | "failed"
    model?: string
    thinking?: string
    currentTool?: string
    lastCommand?: string
  }): void
}

function resolvePlanningArtifacts(
  changeId: string,
  planVersion: string,
  cwd?: string,
): CodeReviewInputContext["planningArtifacts"] {
  return {
    design: resolvePlanArtifactPath(changeId, planVersion, "design", cwd),
    executionGroups: resolvePlanArtifactPath(changeId, planVersion, "execution-groups", cwd),
    standards: resolvePlanArtifactPath(changeId, planVersion, "standards", cwd),
    verification: resolvePlanArtifactPath(changeId, planVersion, "verification", cwd),
  }
}

/**
 * Build a code review input from the current implementation context.
 */
export function buildCodeReviewInputFromContext(
  changeId: string,
  planVersion: string,
  repoRoot: string,
  verificationStatus: "passed" | "failed" | "skipped" | "unknown" = "passed",
  cwd?: string,
): CodeReviewInputContext {
  return {
    source: `Implementation of ${changeId} ${planVersion}`,
    repoPath: repoRoot,
    branch: getCurrentBranch(repoRoot),
    planningArtifacts: resolvePlanningArtifacts(changeId, planVersion, cwd),
    verificationStatus,
    cwd,
  }
}

function uniqueStrings(values: Iterable<string | null | undefined>): string[] {
  return [...new Set([...values].filter((value): value is string => Boolean(value && value.trim().length > 0)))]
}

function collectLedgerEntries(run: Awaited<ReturnType<typeof readRun>>): Array<Record<string, unknown>> {
  const ledger = (run.metadata as { groupLedger?: unknown } | undefined)?.groupLedger
  if (!ledger || typeof ledger !== "object") return []
  return Object.values(ledger as Record<string, unknown>).filter(
    (entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"),
  )
}

async function buildDiffBundle(patchPaths: string[]): Promise<string> {
  if (patchPaths.length === 0) return ""

  const parts: string[] = []
  for (const patchPath of patchPaths) {
    try {
      const content = await readFile(patchPath, "utf-8")
      parts.push(content.trimEnd())
    } catch {
      parts.push(`# Patch not found: ${patchPath}`)
    }
  }

  return parts.length > 0 ? parts.join("\n") : ""
}

function collectPatchPaths(run: Awaited<ReturnType<typeof readRun>>): string[] {
  const groupPatchPaths = run.groups.map((group) => group.patchPath).filter((patchPath): patchPath is string => Boolean(patchPath))
  const ledgerPatchPaths = collectLedgerEntries(run)
    .map((entry) => typeof entry.patchPath === "string" ? entry.patchPath : null)
    .filter((patchPath): patchPath is string => Boolean(patchPath))
  return uniqueStrings([...groupPatchPaths, ...ledgerPatchPaths])
}

function collectModifiedFiles(run: Awaited<ReturnType<typeof readRun>>): string[] {
  const modifiedFiles: string[] = []
  for (const group of run.groups) {
    if (!Array.isArray(group.changedFiles)) continue
    for (const file of group.changedFiles) {
      if (!modifiedFiles.includes(file)) modifiedFiles.push(file)
    }
  }

  for (const entry of collectLedgerEntries(run)) {
    for (const candidateKey of ["changedFiles", "files"]) {
      const value = entry[candidateKey]
      if (!Array.isArray(value)) continue
      for (const file of value) {
        if (typeof file === "string" && !modifiedFiles.includes(file)) {
          modifiedFiles.push(file)
        }
      }
    }
  }

  return modifiedFiles
}

function collectModifiedDirectories(modifiedFiles: string[]): string[] {
  return uniqueStrings(modifiedFiles.map((file) => {
    const dir = path.dirname(file)
    return dir === "." ? null : dir
  }))
}

function runGitDiffForFiles(repoRoot: string, repoRelativeFiles: string[]): string {
  const commonOptions = {
    cwd: repoRoot,
    encoding: "utf-8" as const,
    stdio: ["ignore", "pipe", "pipe"] as const,
    timeout: 15_000,
    maxBuffer: 10 * 1024 * 1024,
  }

  try {
    return execFileSync("git", ["diff", "--binary", "HEAD", "--", ...repoRelativeFiles], commonOptions).trimEnd()
  } catch {
    try {
      return execFileSync("git", ["diff", "--binary", "--", ...repoRelativeFiles], commonOptions).trimEnd()
    } catch {
      return ""
    }
  }
}

async function buildPrimaryWorktreeDiffBundle(sharedCwd: string, modifiedFiles: string[]): Promise<string> {
  if (modifiedFiles.length === 0) return ""

  const grouped = new Map<string, string[]>()
  for (const modifiedFile of modifiedFiles) {
    const repoRoot = inferClaimedFileRepoRoots(sharedCwd, [modifiedFile])[0] ?? path.resolve(sharedCwd)
    const absolutePath = path.resolve(sharedCwd, modifiedFile)
    const repoRelativePath = path.relative(repoRoot, absolutePath)
    if (!repoRelativePath || repoRelativePath.startsWith("..") || path.isAbsolute(repoRelativePath)) continue
    const existing = grouped.get(repoRoot) ?? []
    if (!existing.includes(repoRelativePath)) {
      existing.push(repoRelativePath)
      grouped.set(repoRoot, existing)
    }
  }

  const parts: string[] = []
  for (const [repoRoot, repoRelativeFiles] of grouped.entries()) {
    const diff = runGitDiffForFiles(repoRoot, repoRelativeFiles)
    if (!diff) continue
    parts.push(grouped.size > 1 ? `# Repo root: ${repoRoot}\n${diff}` : diff)
  }

  return parts.join("\n\n")
}

async function readExecutionGroupReviewContext(
  changeId: string,
  planVersion: string,
  cwd?: string,
): Promise<Array<{ reviewTags?: string | string[] }> | undefined> {
  try {
    const execPath = resolvePlanArtifactPath(changeId, planVersion, "execution-groups", cwd)
    const execMd = await readFile(execPath, "utf-8")
    const parsed = parseExecutionGroupsMd(execMd)
    return parsed.map((group) => ({
      reviewTags: group.reviewTags ?? undefined,
    }))
  } catch {
    return undefined
  }
}

function toReviewUpdateCallback(
  onReviewerUpdate?: ReviewerProgressCallback,
): ((update: { reviewerName: string; agentName: string; status: string; model?: string; thinking?: string; currentTool?: string; lastCommand?: string }) => void) | undefined {
  if (!onReviewerUpdate) return undefined

  return (update) => {
    onReviewerUpdate({
      reviewerName: update.reviewerName,
      agentName: update.agentName,
      status: update.status as "queued" | "running" | "completed" | "failed",
      model: update.model,
      thinking: update.thinking,
      currentTool: update.currentTool,
      lastCommand: update.lastCommand,
    })
  }
}

/**
 * Finalize code review for a completed run.
 *
 * Delegates to pi-zflow-review if available via registry.
 */
export async function finalizeCodeReview(
  runId: string,
  cwd?: string,
  onReviewerUpdate?: ReviewerProgressCallback,
): Promise<{
  pass: boolean
  findingsPath?: string
  summary: string
  infrastructureFailure?: boolean
  recoveryHint?: string
}> {
  const registry = getZflowRegistry()
  const run = await readRun(runId, cwd)
  const reviewService = registry.optional<Record<string, Function>>("review")

  if (reviewService && typeof reviewService.runCodeReview === "function") {
    try {
      const planningArtifacts = resolvePlanningArtifacts(run.changeId, run.planVersion, cwd)
      const repoRoot = run.repoRoot || cwd || process.cwd()
      const patchPaths = collectPatchPaths(run)
      let diffBundle = await buildDiffBundle(patchPaths)
      let diffSource: string | undefined = diffBundle ? "run-patches" : undefined
      const modifiedFiles = collectModifiedFiles(run)
      if (!diffBundle && modifiedFiles.length > 0) {
        const worktreeDiffBundle = await buildPrimaryWorktreeDiffBundle(repoRoot, modifiedFiles)
        if (worktreeDiffBundle) {
          diffBundle = worktreeDiffBundle
          diffSource = "primary-worktree-diff"
        }
      }
      const modifiedDirectories = collectModifiedDirectories(modifiedFiles)
      const executionGroups = await readExecutionGroupReviewContext(run.changeId, run.planVersion, cwd)
      const onReviewUpdate = toReviewUpdateCallback(onReviewerUpdate)

      const result = await (reviewService.runCodeReview as Function)({
        source: `Implementation of ${run.changeId}`,
        repoPath: repoRoot,
        branch: run.branch || "(unknown)",
        planningArtifacts,
        verificationStatus: (run.verification as any)?.status || "unknown",
        diffBundle: diffBundle || undefined,
        diffSource,
        modifiedFiles: modifiedFiles.length > 0 ? modifiedFiles : undefined,
        modifiedDirectories: modifiedDirectories.length > 0 ? modifiedDirectories : undefined,
        executionGroups,
        onReviewUpdate,
        cwd,
      })

      const severity = (result as any).severity as { critical: number; major: number; minor: number; nit: number }
      const recommendation = (result as any).recommendation as string | undefined
      const manifest = (result as any).manifest as { reviewers: Array<{ name: string; status: string; required?: boolean }> } | undefined
      const coverageNotes = (result as any).coverageNotes as string[] | undefined
      const reviewInfrastructure = (result as any).reviewInfrastructure as
        | { status?: string; summary?: string; recoveryHint?: string }
        | undefined

      const failedRequiredReviewers: string[] = []
      if (manifest?.reviewers) {
        for (const reviewer of manifest.reviewers) {
          if (reviewer.status === "failed" && reviewer.required !== false) {
            failedRequiredReviewers.push(reviewer.name)
          }
        }
      }

      const hasPassableSeverity = severity.critical === 0 && severity.major === 0
      const hasFailedRequiredReviewers = failedRequiredReviewers.length > 0
      const isNoGo = recommendation === "NO-GO"
      const pass = hasPassableSeverity && !hasFailedRequiredReviewers && !isNoGo

      let summary = `Code review: ${severity.critical} critical, ${severity.major} major, ${severity.minor} minor issues.`
      if (hasFailedRequiredReviewers) {
        summary += ` Required reviewer(s) failed: ${failedRequiredReviewers.join(", ")}.`
      }
      if (isNoGo && !hasFailedRequiredReviewers) {
        summary += " Review recommendation: NO-GO."
      }
      if (coverageNotes && coverageNotes.length > 0) {
        const relevantNotes = coverageNotes.filter((note) =>
          note.includes("Fail-closed") || note.includes("failed") || note.includes("error") || note.includes("ENOENT") || note.includes("severity") || note.includes("Recovery hint") || note.includes("Review infrastructure"),
        )
        if (relevantNotes.length > 0) {
          summary += ` ${relevantNotes.join("; ")}`
        }
      }
      if (reviewInfrastructure?.summary && !summary.includes(reviewInfrastructure.summary)) {
        summary += ` ${reviewInfrastructure.summary}`
      }
      if (reviewInfrastructure?.recoveryHint && !summary.includes(reviewInfrastructure.recoveryHint)) {
        summary += ` ${reviewInfrastructure.recoveryHint}`
      }

      const findingsPath = (result as any).findingsPath as string | undefined
      const infrastructureFailure = reviewInfrastructure?.status === "failed"

      try {
        await updateRun(runId, {
          codeReview: {
            pass,
            findingsPath: findingsPath ?? null,
            severity,
            summary,
            infrastructureFailure,
            recoveryHint: reviewInfrastructure?.recoveryHint ?? null,
            completedAt: new Date().toISOString(),
          },
        } as any, cwd)
      } catch {
        console.warn("[zflow] Failed to persist code review result to run state")
      }

      return {
        pass,
        findingsPath,
        summary,
        infrastructureFailure,
        recoveryHint: reviewInfrastructure?.recoveryHint,
      }
    } catch (err) {
      const summary = `Code review via registry failed: ${err instanceof Error ? err.message : String(err)}`
      console.warn(`[zflow] ${summary}`)
      return { pass: false, summary }
    }
  }

  const summary = "Code review skipped (no review service available)."
  console.info(`[zflow] ${summary}`)
  return { pass: true, summary }
}
