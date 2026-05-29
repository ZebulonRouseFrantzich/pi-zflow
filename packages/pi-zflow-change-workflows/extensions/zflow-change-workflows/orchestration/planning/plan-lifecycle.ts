/**
 * plan-lifecycle.ts — planning lifecycle, approval, review, and interview gates.
 */

import { loadStateIndex } from "pi-zflow-artifacts/state-index"
import {
  resolvePlanArtifactPath,
  resolvePlanStatePath,
} from "pi-zflow-artifacts/artifact-paths"
import { getZflowRegistry } from "pi-zflow-core/registry"

export async function updatePlanState(
  changeId: string,
  updates: Partial<{
    currentVersion: string
    approvedVersion: string | null
    lifecycleState: string
    versions: Record<string, { state: string; createdAt?: string; immutableAt?: string }>
  }>,
  cwd?: string,
): Promise<void> {
  const { default: fs } = await import("node:fs/promises")
  const planStatePath = resolvePlanStatePath(changeId, cwd)
  const existing = JSON.parse(await fs.readFile(planStatePath, "utf-8"))
  const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() }
  await fs.writeFile(planStatePath, JSON.stringify(updated, null, 2), "utf-8")
}

/**
 * Advance the plan lifecycle state in plan-state.json and the state index.
 */
export async function advancePlanLifecycle(
  changeId: string,
  newState: "draft" | "validated" | "reviewed" | "approved" | "completed",
  cwd?: string,
): Promise<void> {
  await updatePlanState(changeId, { lifecycleState: newState }, cwd)

  const index = await loadStateIndex(cwd)
  const planEntry = index.entries.find(
    (e) => e.type === "plan" && e.metadata?.changeId === changeId,
  )
  if (planEntry) {
    planEntry.status = newState
    planEntry.updatedAt = new Date().toISOString()
    const { default: fs } = await import("node:fs/promises")
    const { resolveStateIndexPath } = await import("pi-zflow-artifacts/artifact-paths")
    await fs.writeFile(resolveStateIndexPath(cwd), JSON.stringify(index, null, 2), "utf-8")
  }
}

/**
 * Validate the required plan artifacts for a given version.
 */
export async function runPlanValidation(
  changeId: string,
  planVersion: string,
  cwd?: string,
): Promise<{
  pass: boolean
  issues: string[]
}> {
  const { default: fs } = await import("node:fs/promises")

  const artifacts = {
    "design.md": resolvePlanArtifactPath(changeId, planVersion, "design", cwd),
    "execution-groups.md": resolvePlanArtifactPath(changeId, planVersion, "execution-groups", cwd),
    "standards.md": resolvePlanArtifactPath(changeId, planVersion, "standards", cwd),
    "verification.md": resolvePlanArtifactPath(changeId, planVersion, "verification", cwd),
    "implementation-tasks.md": resolvePlanArtifactPath(changeId, planVersion, "implementation-tasks", cwd),
  }

  const issues: string[] = []

  for (const [name, filePath] of Object.entries(artifacts)) {
    try {
      const content = await fs.readFile(filePath, "utf-8")

      const placeholderPatterns = [
        /\[TODO\]|\[placeholder\]/i,
        /awaiting\s+(scout|repo.mapper|planner)/i,
        /TODO:\s*(write|fill|implement|add)/i,
        /zflow-synthesized-artifact:\s*implementation-tasks/i,
      ]

      for (const pattern of placeholderPatterns) {
        if (pattern.test(content)) {
          issues.push(`Artifact "${name}" contains placeholder markers (matched: ${pattern.source})`)
        }
      }
    } catch {
      issues.push(`Required artifact "${name}" is missing at: ${filePath}`)
    }
  }

  return issues.length === 0
    ? { pass: true, issues: [] }
    : { pass: false, issues }
}

/**
 * Run plan review for a given change and plan version.
 */
export async function runPlanReview(
  changeId: string,
  planVersion: string,
  cwd?: string,
): Promise<{
  pass: boolean
  reviewFindingsPath?: string
  summary: string
}> {
  const registry = getZflowRegistry()
  const reviewService = registry.optional<Record<string, Function>>("review")

  if (reviewService && typeof reviewService.runPlanReview === "function") {
    try {
      const planningArtifacts = {
        design: resolvePlanArtifactPath(changeId, planVersion, "design", cwd),
        executionGroups: resolvePlanArtifactPath(changeId, planVersion, "execution-groups", cwd),
        standards: resolvePlanArtifactPath(changeId, planVersion, "standards", cwd),
        verification: resolvePlanArtifactPath(changeId, planVersion, "verification", cwd),
        implementationTasks: resolvePlanArtifactPath(changeId, planVersion, "implementation-tasks", cwd),
      }

      const result = await (reviewService.runPlanReview as Function)({
        changeId,
        planVersion,
        executionGroups: [],
        planningArtifacts,
        cwd,
      })

      return {
        pass: (result as any).action === "approve",
        reviewFindingsPath: (result as any).findingsPath,
        summary:
          (result as any).action === "approve"
            ? "Plan review passed."
            : `Plan review: ${(result as any).action}${(result as any).needsZebReason ? ` — ${(result as any).needsZebReason}` : ""}`,
      }
    } catch (err) {
      return {
        pass: false,
        summary: `Plan review via registry failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  const { default: path } = await import("node:path")
  const { resolveReviewDir } = await import("pi-zflow-artifacts/artifact-paths")
  const reviewFindingsPath = path.join(resolveReviewDir(cwd), `plan-review-${changeId}-${planVersion}.md`)
  const summary = "Plan review skipped (no review service available). Review is advisory."

  console.info(`[zflow] ${summary}`)

  return {
    pass: true,
    reviewFindingsPath,
    summary,
  }
}

/**
 * Approve a specific plan version.
 */
export async function approvePlanVersion(
  changeId: string,
  version: string,
  cwd?: string,
): Promise<void> {
  const { default: fs } = await import("node:fs/promises")
  const planStatePath = resolvePlanStatePath(changeId, cwd)
  const raw = await fs.readFile(planStatePath, "utf-8")
  const planState = JSON.parse(raw)

  planState.approvedVersion = version
  planState.lifecycleState = "approved"
  planState.updatedAt = new Date().toISOString()

  if (planState.versions && planState.versions[version]) {
    planState.versions[version].state = "approved"
    planState.versions[version].immutableAt = planState.updatedAt
  }

  await fs.writeFile(planStatePath, JSON.stringify(planState, null, 2), "utf-8")

  const index = await loadStateIndex(cwd)
  const planEntry = index.entries.find(
    (e) => e.type === "plan" && e.metadata?.changeId === changeId,
  )
  if (planEntry) {
    planEntry.status = "approved"
    planEntry.updatedAt = planState.updatedAt
    const { resolveStateIndexPath } = await import("pi-zflow-artifacts/artifact-paths")
    await fs.writeFile(resolveStateIndexPath(cwd), JSON.stringify(index, null, 2), "utf-8")
  }
}

/**
 * Build handoff context metadata for session fork from planning to implementation.
 */
export async function buildHandoffContext(
  changeId: string,
  approvedVersion: string,
  cwd?: string,
): Promise<{
  changeId: string
  approvedVersion: string
  runtimeStateDir: string
  planArtifactPaths: Record<string, string>
  forkedAt: string
}> {
  const { resolveRuntimeStateDir } = await import("pi-zflow-core/runtime-paths")

  const runtimeStateDir = resolveRuntimeStateDir(cwd)
  const planArtifactPaths = {
    design: resolvePlanArtifactPath(changeId, approvedVersion, "design", cwd),
    executionGroups: resolvePlanArtifactPath(changeId, approvedVersion, "execution-groups", cwd),
    standards: resolvePlanArtifactPath(changeId, approvedVersion, "standards", cwd),
    verification: resolvePlanArtifactPath(changeId, approvedVersion, "verification", cwd),
    implementationTasks: resolvePlanArtifactPath(changeId, approvedVersion, "implementation-tasks", cwd),
  }

  return {
    changeId,
    approvedVersion,
    runtimeStateDir,
    planArtifactPaths,
    forkedAt: new Date().toISOString(),
  }
}

/**
 * Build a JSON interview questions payload for plan approval.
 */
export function buildPlanApprovalQuestions(
  changeId: string,
  version: string,
  summary: string,
): string {
  return JSON.stringify({
    title: `Plan Review: ${changeId} ${version}`,
    description: `Review plan version ${version} for change "${changeId}".\n\n${summary}`,
    questions: [
      {
        id: "decision",
        type: "single",
        question: "How would you like to proceed with this plan?",
        options: [
          {
            label: "Inspect Artifacts",
            content: "Pause here. Review the generated plan and review findings paths before deciding.",
          },
          {
            label: "Approve",
            content: "Plan looks good. Approve and proceed to implementation.",
          },
          {
            label: "Request Revisions",
            content: "Plan needs changes. Create a new version with revisions.",
          },
          {
            label: "Cancel",
            content: "Cancel this planning session. No changes will be made.",
          },
        ],
        recommended: "Inspect Artifacts",
      },
      {
        id: "revisionNotes",
        type: "text",
        question: "If requesting revisions, describe what needs to change:",
      },
    ],
  })
}

/**
 * Build a JSON interview questions payload for implementation/review gates.
 */
export function buildImplementationGateQuestions(
  changeId: string,
  gateType: "drift" | "verification-failure" | "review-findings",
  context: string,
): string {
  const gateTitles: Record<string, string> = {
    drift: "Plan Drift Detected",
    "verification-failure": "Verification Failed",
    "review-findings": "Review Findings",
  }

  const gateOptions: Record<string, Array<{ label: string; content: string }>> = {
    drift: [
      { label: "Approve Amendment", content: "Approve the plan amendment and continue." },
      { label: "Cancel", content: "Cancel the workflow." },
      { label: "Inspect Artifacts", content: "Review retained artifacts before deciding." },
    ],
    "verification-failure": [
      { label: "Auto-fix Loop", content: "Run automated fix attempts (max 3 iterations, ~15 min cap)." },
      { label: "Manual Review", content: "Stop for manual investigation." },
      { label: "Skip Verification", content: "Skip verification — review will be advisory." },
    ],
    "review-findings": [
      { label: "Fix All", content: "Fix all findings." },
      { label: "Fix Critical/Major", content: "Fix critical and major findings only." },
      { label: "Dismiss", content: "Dismiss findings and proceed." },
    ],
  }

  return JSON.stringify({
    title: gateTitles[gateType] ?? "Decision Required",
    description: `Change: ${changeId}\n\n${context}`,
    questions: [
      {
        id: "action",
        type: "single",
        question: "How would you like to proceed?",
        options: gateOptions[gateType] ?? [
          { label: "Continue", content: "Proceed with the workflow." },
          { label: "Cancel", content: "Cancel the workflow." },
        ],
      },
    ],
  })
}

/**
 * Parse a structured interview response into a simple decision object.
 */
export function parseInterviewResponse(
  response: string,
): { decision: string; revisionNotes?: string; selectedFindings?: string[] } {
  try {
    const parsed = JSON.parse(response)
    return {
      decision: parsed.decision ?? parsed.action ?? "cancel",
      revisionNotes: parsed.revisionNotes,
      ...(parsed.selectedFindings ? { selectedFindings: parsed.selectedFindings } : {}),
    }
  } catch {
    return { decision: "cancel" }
  }
}
