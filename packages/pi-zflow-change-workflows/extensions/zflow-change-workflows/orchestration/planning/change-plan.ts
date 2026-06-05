/**
 * change-plan.ts — durable /zflow-change-plan workflow orchestration.
 */

import type { AgentDispatchProgress } from "pi-zflow-core/dispatch-service"
import { DISPATCH_SERVICE_CAPABILITY, type DispatchService } from "pi-zflow-core/dispatch-service"
import { getZflowRegistry } from "pi-zflow-core/registry"

import type { DurablePlanDocFrontmatter } from "./durable-plan-doc.js"
import {
  resolveDurablePlanDocPath,
  readDurablePlanDoc,
  normalizeDurablePlanDocBody,
  validateDurablePlanDocBody,
  listPublishedDurablePlanVersions,
  writeDurablePlanDoc,
  resolveDurablePlanRepoRoot,
} from "./durable-plan-doc.js"
import { buildRepoMap, buildReconnaissance } from "./repo-analysis.js"
import { resolveImplementationAgentGuidance } from "../implementation-agents.js"

export interface ChangePlanWorkflowOptions {
  /** Working directory for runtime state dir resolution. */
  cwd?: string
  /** Final resolved durable change identifier. */
  changeId: string
  /** Human description of the requested change. */
  changeDescription: string
  /** Original user input seed (description, path, or explicit id). */
  changeSeed: string
  /** Optional extracted repo path/folder/file reference mentioned by the user. */
  changeReferencePath?: string
  /** Whether the change seed was an explicit path/id reference. */
  explicitReference?: boolean
  /** Durable plan source mode. */
  sourceMode?: DurablePlanDocFrontmatter["sourceMode"]
  /** Optional progress callback for command UIs. */
  onProgress?: (message: string, type?: "info" | "warning" | "error") => void
  /** Optional live agent-progress callback. */
  onAgentProgress?: (progress: AgentDispatchProgress) => void
}

/**
 * Result of the `/zflow-change-plan` workflow orchestration.
 */
export interface ChangePlanWorkflowResult {
  changeId: string
  planDocPath: string
  repoMapPath: string
  reconnaissancePath: string
  draftOutputPath?: string
  dispatchService?: string
  existingPlanUpdated: boolean
}

async function fileExists(filePath: string): Promise<boolean> {
  const { default: fs } = await import("node:fs/promises")
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function resolveProfileModelForAgent(agentName: string): Promise<string | undefined> {
  try {
    const profileService = getZflowRegistry().optional<{
      getResolvedAgentBinding?: (agentName: string) => Promise<{ resolvedModel?: string | null } | null>
    }>("profiles")
    const binding = await profileService?.getResolvedAgentBinding?.(agentName)
    return binding?.resolvedModel ?? undefined
  } catch {
    return undefined
  }
}

function formatDispatchElapsed(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "00:00"
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

function formatChangePlanAgentProgress(progress: AgentDispatchProgress): string {
  const elapsed = formatDispatchElapsed(progress.durationMs)
  const toolCount = progress.toolCount ?? 0
  if (progress.currentTool) {
    const args = progress.currentToolArgs ? ` ${progress.currentToolArgs}` : ""
    return `planner running — child elapsed ${elapsed} — ${toolCount} tools — current: ${progress.currentTool}${args}`
  }
  const recent = progress.recentTools?.at(-1)
  if (recent?.tool) {
    const args = recent.args ? ` ${recent.args}` : ""
    return `planner running — child elapsed ${elapsed} — ${toolCount} tools — last: ${recent.tool}${args}`
  }
  return `planner running — child elapsed ${elapsed} — ${toolCount} tools observed`
}

function buildChangePlanDraftTaskPrompt(input: {
  changeId: string
  changeDescription: string
  sourceMode: DurablePlanDocFrontmatter["sourceMode"]
  planDocPath: string
  repoMapPath: string
  reconnaissancePath: string
  changeReferencePath?: string
  existingPlanBody?: string
  roleLabels: string[]
  implementationAgents: string[]
}): string {
  return [
    `Draft a complete durable change plan body for changeId \`${input.changeId}\`.`,
    `Change description: ${input.changeDescription}`,
    `Source mode: ${input.sourceMode}`,
    `Target durable plan path: ${input.planDocPath}`,
    `Repository map path: ${input.repoMapPath}`,
    `Reconnaissance path: ${input.reconnaissancePath}`,
    input.changeReferencePath ? `Referenced repo path: ${input.changeReferencePath}` : "",
    input.existingPlanBody
      ? [
        "Existing durable plan body to refine:",
        input.existingPlanBody,
      ].join("\n")
      : "No existing durable plan body was found; create a fresh, detailed draft.",
    "",
    "You are drafting the human-reviewed durable `plan.md` intake document.",
    "Explore the repository before writing. Use the repo map and reconnaissance as anchors, then read the most relevant files.",
    "Ask clarifying questions ONLY if the plan would otherwise be materially blocked. If not blocked, produce the strongest plan you can and capture remaining uncertainty under Open questions.",
    "",
    "Return ONLY markdown for the `plan.md` body. Do NOT include YAML frontmatter. Do NOT wrap the result in code fences. Do NOT include the managed zflow header or version-index sections.",
    "",
    "Use these exact headings and fill each with concrete detail:",
    "- `## Summary`",
    "- `## Goals / Success Criteria`",
    "- `## Scope In`",
    "- `## Scope Out`",
    "- `## Relevant codebase areas`",
    "- `## Constraints`",
    "- `## Decisions`",
    "- `## Risks / Unknowns`",
    "- `## Proposed execution outline`",
    "- `## Verification approach`",
    "- `## Open questions`",
    "",
    "Quality requirements:",
    "- No placeholder text, no TODO-only sections, and no empty headings.",
    "- Mention concrete files, modules, services, or directories in Relevant codebase areas whenever they can be inferred.",
    "- Proposed execution outline should describe logical work groups, likely ordering, and coordination concerns, but it does NOT need the final machine-readable execution-groups format.",
    "- Verification approach should include concrete commands or focused validation methods whenever the repo suggests them.",
    "- Open questions should be empty of fluff; only include unresolved decisions that could materially affect planning.",
    `- If you mention likely human ownership labels, use only these role labels: ${input.roleLabels.map((label) => `\`${label}\``).join(", ")}.`,
    `- If you mention dispatchable implementation agents, use only these real agent names: ${input.implementationAgents.map((agent) => `\`${agent}\``).join(", ")}.`,
    "",
    "If the change is RuneContext-backed, treat RuneContext documents as canonical and describe how this durable plan summarizes or stages that work without competing with canonical docs.",
  ].filter(Boolean).join("\n")
}

export async function runChangePlanWorkflow(
  options: ChangePlanWorkflowOptions,
): Promise<ChangePlanWorkflowResult> {
  const cwd = options.cwd
  const { default: fs } = await import("node:fs/promises")
  const { default: path } = await import("node:path")
  const { resolveRuntimeStateDir } = await import("pi-zflow-core/runtime-paths")

  const sourceMode = options.sourceMode ?? "adhoc"
  const planDocPath = await resolveDurablePlanDocPath(options.changeId, await resolveDurablePlanRepoRoot({ cwd }))
  const existingPlan = await readDurablePlanDoc(options.changeId, { cwd })
  const existingPlanBody = existingPlan
    ? normalizeDurablePlanDocBody(existingPlan.body)
    : ""

  options.onProgress?.("🗺️ Building repository map for change planning...", "info")
  const repoMapResult = await buildRepoMap(cwd)
  options.onProgress?.("🔎 Building reconnaissance context for change planning...", "info")
  const reconResult = await buildReconnaissance(
    cwd,
    options.explicitReference
      ? options.changeSeed
      : options.changeReferencePath,
  )

  const registry = getZflowRegistry()
  const zflowDispatch = registry.optional<DispatchService>(DISPATCH_SERVICE_CAPABILITY)
  if (!zflowDispatch || typeof zflowDispatch.runAgent !== "function") {
    throw new Error(
      "No dispatch service available for /zflow-change-plan. Ensure pi-zflow-subagents-bridge is installed and active.",
    )
  }

  const implementationAgentGuidance = await resolveImplementationAgentGuidance(cwd)

  const runtimeStateDir = resolveRuntimeStateDir(cwd)
  const outputDir = path.join(runtimeStateDir, "change-plan-drafts")
  await fs.mkdir(outputDir, { recursive: true })
  const draftOutputPath = path.join(outputDir, `${options.changeId}-plan-draft.md`)

  const dispatchResult = await zflowDispatch.runAgent({
    agent: "planner",
    cwd,
    model: await resolveProfileModelForAgent("zflow.planner-frontier"),
    output: draftOutputPath,
    outputMode: "inline",
    task: buildChangePlanDraftTaskPrompt({
      changeId: options.changeId,
      changeDescription: options.changeDescription,
      sourceMode,
      planDocPath,
      repoMapPath: repoMapResult.path,
      reconnaissancePath: reconResult.path,
      changeReferencePath: options.explicitReference ? options.changeSeed : options.changeReferencePath,
      existingPlanBody: existingPlanBody || undefined,
      roleLabels: implementationAgentGuidance.roleLabels,
      implementationAgents: implementationAgentGuidance.implementationAgents,
    }),
    onUpdate: (progress) => {
      options.onAgentProgress?.(progress)
      options.onProgress?.(formatChangePlanAgentProgress(progress), "info")
    },
  })

  if (!dispatchResult.ok) {
    throw new Error(dispatchResult.error ?? "Change-plan drafting agent failed without an error message")
  }

  let draftedBody = dispatchResult.rawOutput?.trim() ?? ""
  if (!draftedBody && dispatchResult.outputPath && await fileExists(dispatchResult.outputPath)) {
    draftedBody = await fs.readFile(dispatchResult.outputPath, "utf-8")
  }
  draftedBody = normalizeDurablePlanDocBody(draftedBody)
  const bodyErrors = validateDurablePlanDocBody(draftedBody)
  if (bodyErrors.length > 0) {
    throw new Error(`Drafted durable plan body did not meet the contract: ${bodyErrors.join("; ")}`)
  }

  const publishedVersions = await listPublishedDurablePlanVersions(options.changeId, { cwd })
  const existingPlanUpdated = Boolean(existingPlan)
  await writeDurablePlanDoc(
    options.changeId,
    {
      changeId: options.changeId,
      status: existingPlan?.frontmatter.status ?? "draft",
      sourceMode: existingPlan?.frontmatter.sourceMode ?? sourceMode,
      currentVersion: existingPlan?.frontmatter.currentVersion ?? null,
      approvedVersion: existingPlan?.frontmatter.approvedVersion ?? null,
    },
    {
      cwd,
      bodyContent: draftedBody,
      publishedVersions,
    },
  )

  return {
    changeId: options.changeId,
    planDocPath,
    repoMapPath: repoMapResult.path,
    reconnaissancePath: reconResult.path,
    draftOutputPath: dispatchResult.outputPath ?? draftOutputPath,
    dispatchService: zflowDispatch.name,
    existingPlanUpdated,
  }
}
