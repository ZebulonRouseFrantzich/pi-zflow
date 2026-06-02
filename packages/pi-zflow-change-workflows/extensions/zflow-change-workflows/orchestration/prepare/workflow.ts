/**
 * workflow.ts — `/zflow-change-prepare` orchestration and profile hooks.
 */

import { resolvePlanStatePath, resolvePlanVersionDir } from "pi-zflow-artifacts/artifact-paths"
import { addStateIndexEntry } from "pi-zflow-artifacts/state-index"
import { getZflowRegistry } from "pi-zflow-core/registry"

import { buildRepoMap, buildReconnaissance } from "../planning/repo-analysis.js"
import {
  readDurablePlanDoc,
  buildPrepareNotesFromDurablePlanDoc,
} from "../planning/durable-plan-doc.js"
import { generateChangeId } from "../change-id.js"
import { discoverUnfinishedWork } from "../lifecycle/unfinished-work.js"
import {
  runPrepareAgentsIfAvailable,
  type PrepareAgentDispatchResult,
} from "./agent-dispatch.js"
import { ensureImplementationTasksArtifact } from "./implementation-tasks.js"

/**
 * Options for the `/zflow-change-plan` workflow orchestration.
 */
export interface PrepareWorkflowOptions {
  /** Working directory for runtime state dir resolution. */
  cwd?: string
  /** Optional change path (RuneContext path or directory). */
  changePath?: string
  /** Explicit change ID. Auto-generated from changePath if omitted. */
  changeId?: string
  /** Whether to skip the plan-review step. */
  skipReview?: boolean
  /** Force normal ad-hoc change-doc handling; skip RuneContext detection. */
  forceAdHoc?: boolean
  /** Additional user notes supplied after the change path. */
  prepareNotes?: string
  /** Optional progress callback for command UIs. */
  onProgress?: (message: string, type?: "info" | "warning" | "error") => void
}

/**
 * Result of the `/zflow-change-prepare` workflow orchestration.
 */
export interface PrepareWorkflowResult {
  /** Resolved change identifier. */
  changeId: string
  /** The initial plan version label (always "v1" for a new prepare). */
  planVersion: string
  /** Absolute path to the plan-state.json file. */
  planStatePath: string
  /** Current lifecycle state of the plan. */
  status: "draft" | "validated" | "reviewed" | "approved" | "needs-revision"
  /** Absolute paths to the five canonical plan artifact files. */
  artifactPaths: Record<string, string>
  /** Absolute path to review findings, if a plan-review was run. */
  reviewFindingsPath?: string
}

/**
 * Resolve a profile if the profiles capability is available via the registry.
 *
 * Checks the zflow registry for an optional "profiles" capability. If found
 * and the service provides `ensureResolved`, calls it to ensure a profile is
 * active. Optionally records profile info in plan-state.json if a changeId
 * is provided.
 *
 * @param changeId - Optional change ID to record profile info in plan-state.json.
 * @param cwd - Working directory (optional).
 * @returns A structured result with resolution status and advisory message.
 */
export async function resolveProfileIfAvailable(
  changeId?: string,
  cwd?: string,
): Promise<{
  resolved: boolean
  method: "registry-service" | "not-available"
  advisory: string
}> {
  const registry = getZflowRegistry()

  if (registry.has("profiles")) {
    const profileService = registry.optional<{ ensureResolved?: () => Promise<unknown> }>("profiles")
    if (profileService && typeof profileService.ensureResolved === "function") {
      try {
        await profileService.ensureResolved()

        if (changeId) {
          try {
            const { default: fs } = await import("node:fs/promises")
            const planStatePath = resolvePlanStatePath(changeId, cwd)
            const raw = await fs.readFile(planStatePath, "utf-8")
            const planState = JSON.parse(raw)
            planState.profile = { resolved: true, method: "registry-service", resolvedAt: new Date().toISOString() }
            planState.updatedAt = new Date().toISOString()
            await fs.writeFile(planStatePath, JSON.stringify(planState, null, 2), "utf-8")
          } catch {
            // Non-critical; skip recording
          }
        }

        return {
          resolved: true,
          method: "registry-service",
          advisory: "Profile resolution completed via registry service.",
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          resolved: false,
          method: "registry-service",
          advisory: `Profile service available but ensureResolved() failed: ${message}. Caller should resolve profile explicitly.`,
        }
      }
    }
  }

  return {
    resolved: false,
    method: "not-available",
    advisory: "No profile service found in registry. Caller should resolve profile explicitly via Profile.ensureResolved().",
  }
}

/**
 * Run the formal `/zflow-change-prepare` workflow orchestration.
 *
 * This function:
 * 1. Checks for unfinished work in the state index for the given change.
 * 2. Resolves or generates a change ID.
 * 3. Creates `plan-state.json` with draft status and version `v1`.
 * 4. Creates the version directory under `<runtime-state-dir>/plans/{changeId}/v1/`.
 * 5. Builds canonical plan artifact paths for agent dispatch.
 * 6. Adds a state-index entry tracking this plan.
 * 7. Resolves profile via registry if available (`resolveProfileIfAvailable`).
 * 8. Detects RuneContext if changePath looks like a RuneContext path.
 * 9. Writes concrete repo-map.md (`buildRepoMap`) and reconnaissance.md
 *    (`buildReconnaissance`) with real repository data.
 * 10. Attempts optional agent dispatch via registry (`runPrepareAgentsIfAvailable`).
 * 11. Returns an initial workflow execution plan structure for the caller
 *    to populate with resolved profile steps.
 *
 * The caller (the extension command handler) is responsible for:
 * - Resolving the active profile (`Profile.ensureResolved()`)
 * - Calling `buildWorkflowExecutionPlan("prepare", ...)` with the resolved profile
 * - Dispatching agents via pi-subagents
 * - Calling `advancePlanLifecycle()` to advance lifecycle state after each phase
 *
 * @param options - Prepare workflow options.
 * @returns The prepared plan context with change ID, version, plan state path, and initial plan.
 */
export async function runChangePrepareWorkflow(
  options: PrepareWorkflowOptions,
): Promise<{
  changeId: string
  planVersion: string
  stateDir: string
  planStatePath: string
  artifactPaths: Record<string, string>
  initialPlanState: Record<string, unknown>
  agentDispatchResult: PrepareAgentDispatchResult
}> {
  const cwd = options.cwd
  const { default: fs } = await import("node:fs/promises")
  const { default: path } = await import("node:path")
  const { resolveRuntimeStateDir } = await import("pi-zflow-core/runtime-paths")

  if (options.changeId) {
    const unfinished = await discoverUnfinishedWork(options.changeId, cwd)
    if (unfinished.hasUnfinishedWork) {
      console.warn(
        `[zflow] Unfinished work detected for change "${options.changeId}". ` +
        "Call promptResumeChoices() before proceeding.",
      )
    }
  }

  const changeId = options.changeId ?? generateChangeId(options.changePath)
  const durableDraftPlan = await readDurablePlanDoc(changeId, { cwd })
  if (durableDraftPlan?.validationErrors.length) {
    throw new Error(
      `Durable draft plan frontmatter is invalid for "${changeId}": ${durableDraftPlan.validationErrors.join("; ")}`,
    )
  }
  if (durableDraftPlan?.bodyValidationErrors.length) {
    throw new Error(
      `Durable draft plan body is incomplete for "${changeId}": ${durableDraftPlan.bodyValidationErrors.join("; ")}`,
    )
  }
  const effectivePrepareNotes = buildPrepareNotesFromDurablePlanDoc(durableDraftPlan, options.prepareNotes)
  if (durableDraftPlan) {
    options.onProgress?.(`📝 Loaded durable draft plan from ${durableDraftPlan.path}.`, "info")
    if (durableDraftPlan.frontmatter.sourceMode === "runecontext") {
      options.onProgress?.(
        "🧭 Durable draft is marked as RuneContext-backed; canonical requirements must remain in RuneContext docs.",
        "info",
      )
    }
  }

  const planStatePath = resolvePlanStatePath(changeId, cwd)
  const initialPlanState: {
    changeId: string
    currentVersion: string
    approvedVersion: string | null
    lifecycleState: string
    runeContext: { enabled: boolean; changePath: string | null }
    versions: Record<string, { state: string; createdAt: string }>
    createdAt: string
    updatedAt: string
    runtimeStateDir?: string
    runtimeMetadata?: {
      repoMapPath: string
      reconnaissancePath: string
      durablePlanDocPath?: string
    }
  } = {
    changeId,
    currentVersion: "v1",
    approvedVersion: null,
    lifecycleState: "draft",
    runeContext: {
      enabled: false,
      changePath: options.changePath ?? null,
    },
    versions: {
      v1: { state: "draft", createdAt: new Date().toISOString() },
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  await fs.mkdir(path.dirname(planStatePath), { recursive: true })
  await fs.writeFile(planStatePath, JSON.stringify(initialPlanState, null, 2), "utf-8")

  const versionDir = resolvePlanVersionDir(changeId, "v1", cwd)
  await fs.mkdir(versionDir, { recursive: true })

  const artifactPaths = {
    design: path.join(versionDir, "design.md"),
    executionGroups: path.join(versionDir, "execution-groups.md"),
    standards: path.join(versionDir, "standards.md"),
    verification: path.join(versionDir, "verification.md"),
    implementationTasks: path.join(versionDir, "implementation-tasks.md"),
  }

  await addStateIndexEntry({
    type: "plan",
    id: `plan-${changeId}-v1`,
    status: "draft",
    metadata: {
      changeId,
      version: "v1",
      changePath: options.changePath ?? null,
    },
  }, cwd)

  const profileResult = await resolveProfileIfAvailable(changeId, cwd)
  if (!profileResult.resolved) {
    options.onProgress?.(`⚠️ ${profileResult.advisory}`, "warning")
  }

  const registry = getZflowRegistry()
  const changePath = options.changePath ?? ""
  let runeContextCanonical = false
  let runeContextDocsList: string[] = []
  if (!options.forceAdHoc && (changePath.includes("@") || changePath.includes("/context/"))) {
    console.info(`[zflow] Change path "${changePath}" looks like a RuneContext path — attempting detection.`)
    if (registry.has("runecontext")) {
      try {
        const runeContextService = registry.get<{
          detect?: (path: string) => Promise<{ detected?: boolean; repoRoot?: string; flavor?: string; status?: string }>
          resolveChange?: (input: { repoRoot: string; changePath?: string }) => Promise<{ changePath: string; changeId: string; flavor: string; files: Record<string, string> }>
          readDocs?: (change: unknown) => Promise<Record<string, string>>
        }>("runecontext")
        if (runeContextService && typeof runeContextService.detect === "function") {
          const detected = await runeContextService.detect(changePath)
          console.info(`[zflow] RuneContext detected: ${JSON.stringify(detected)}`)

          if (detected && detected.detected) {
            initialPlanState.runeContext.enabled = true

            if (runeContextService.resolveChange && detected.repoRoot) {
              try {
                const resolved = await runeContextService.resolveChange({
                  repoRoot: detected.repoRoot,
                  changePath,
                })
                if (resolved && resolved.files) {
                  runeContextCanonical = true
                  runeContextDocsList = Object.keys(resolved.files)

                  if (runeContextService.readDocs) {
                    try {
                      const runeDocs = await runeContextService.readDocs(resolved)

                      await fs.writeFile(
                        artifactPaths.design,
                        [
                          "# RuneContext Design",
                          "",
                          "## Proposal",
                          "",
                          runeDocs.proposal,
                          "",
                          "## Design",
                          "",
                          runeDocs.design,
                        ].join("\n"),
                        "utf-8",
                      )
                      console.info("[zflow] Populated design.md from RuneContext proposal/design docs")

                      await fs.writeFile(artifactPaths.standards, runeDocs.standards, "utf-8")
                      console.info("[zflow] Populated standards.md from RuneContext standards.md")

                      await fs.writeFile(
                        artifactPaths.verification,
                        [
                          "# RuneContext Verification",
                          "",
                          runeDocs.verification,
                          runeDocs.references ? ["", "## References", "", runeDocs.references].join("\n") : "",
                          "",
                          "## Status",
                          "",
                          "```json",
                          JSON.stringify(runeDocs.status, null, 2),
                          "```",
                        ].filter(Boolean).join("\n"),
                        "utf-8",
                      )
                      console.info("[zflow] Populated verification.md from RuneContext verification/references/status docs")

                      const { resolveImplementationAgentGuidance } = await import("../implementation-agents.js")
                      const implementationAgentGuidance = await resolveImplementationAgentGuidance(cwd)

                      try {
                        const { deriveExecutionGroupsFromRuneDocs } = await import("pi-zflow-runecontext")
                        const derived = deriveExecutionGroupsFromRuneDocs(runeDocs)
                        const lines = [
                          "# Execution Groups",
                          "",
                          `> Derived from RuneContext canonical source: ${derived.sourceDocument}.`,
                          "> Review and replace `TBD` file lists before implementation dispatch.",
                          "",
                        ]
                        for (let i = 0; i < derived.groups.length; i++) {
                          const group = derived.groups[i]!
                          const verification = group.tasks
                            .map((task) => task.verification)
                            .filter((value): value is string => Boolean(value))
                            .join("; ")
                          lines.push(
                            `## Group ${i + 1}: ${group.name}`,
                            "",
                            `- **Files:** TBD`,
                            `- **Agent:** ${implementationAgentGuidance.defaultAgent}`,
                            `- **Verification:** ${verification || "TBD — derive scoped verification from RuneContext criteria"}`,
                            `- **Parallelizable:** true`,
                            `- **Canonical source:** ${derived.sourceDocument}`,
                            "",
                            group.description,
                            "",
                          )
                        }
                        await fs.writeFile(artifactPaths.executionGroups, lines.join("\n"), "utf-8")
                        console.info("[zflow] Populated execution-groups.md via deriveExecutionGroupsFromRuneDocs()")
                      } catch {
                        const basic = [
                          `# Execution Groups`,
                          ``,
                          `> Derived from RuneContext canonical docs.`,
                          `> Manual grouping is required before implementation dispatch.`,
                          ``,
                          `## Group 1: RuneContext implementation`,
                          ``,
                          `- **Files:** TBD`,
                          `- **Agent:** ${implementationAgentGuidance.defaultAgent}`,
                          `- **Verification:** TBD`,
                          `- **Canonical source:** ${runeDocs.tasks ? "tasks.md" : "proposal+design+verification"}`,
                        ].join("\n")
                        await fs.writeFile(artifactPaths.executionGroups, basic, "utf-8")
                        console.info("[zflow] Wrote basic execution-groups.md from RuneContext docs")
                      }

                      const implTasks = [
                        `# Implementation Tasks`,
                        ``,
                        `> Derived from RuneContext canonical docs.`,
                        `> Detailed task specs should be filled by the planner before implementation.`,
                        ``,
                        `## Group 1: RuneContext implementation`,
                        ``,
                        `### Objective`,
                        `See execution-groups.md for group description.`,
                        ``,
                        `### Likely files touched`,
                        `TBD`,
                        ``,
                        `### Implementation checklist`,
                        `1. Review the design, standards, and verification artifacts.`,
                        `2. Implement the changes described in the execution group.`,
                        `3. Run scoped verification commands.`,
                        ``,
                        `### Acceptance criteria`,
                        `- All verification steps pass.`,
                        `- No regressions in existing behavior.`,
                      ].join("\n")
                      try {
                        await fs.writeFile(artifactPaths.implementationTasks, implTasks, "utf-8")
                        console.info("[zflow] Wrote placeholder implementation-tasks.md from RuneContext docs")
                      } catch {
                        console.warn("[zflow] Could not write placeholder implementation-tasks.md")
                      }
                    } catch {
                      console.warn("[zflow] Could not populate artifacts from RuneContext docs")
                    }
                  } else {
                    console.info("[zflow] RuneContext readDocs not available — artifacts remain empty")
                  }
                }

                console.info(`[zflow] RuneContext resolved: changeId=${resolved.changeId}, flavor=${resolved.flavor}, docs=${runeContextDocsList.join(", ") || "none"}`)
              } catch {
                console.warn("[zflow] RuneContext resolveChange failed — proceeding without canonical doc resolution.")
              }
            }
          }
        }
      } catch {
        console.warn("[zflow] RuneContext service available but detection failed.")
      }
    } else {
      console.info("[zflow] No RuneContext service found in registry. Detection is caller's responsibility.")
    }
  }

  if (runeContextCanonical) {
    try {
      const raw = await fs.readFile(planStatePath, "utf-8")
      const planState = JSON.parse(raw)
      planState.runeContext = {
        ...planState.runeContext,
        enabled: true,
        canonical: true,
        canonicalDocs: runeContextDocsList,
        detectedAt: new Date().toISOString(),
      }
      planState.updatedAt = new Date().toISOString()
      await fs.writeFile(planStatePath, JSON.stringify(planState, null, 2), "utf-8")
      initialPlanState.runeContext = planState.runeContext
    } catch {
      console.warn("[zflow] Could not persist RuneContext canonical flag in plan-state.json.")
    }
  }

  options.onProgress?.("🗺️ Building repository map and reconnaissance context...", "info")
  const repoMapResult = await buildRepoMap(cwd)
  const reconResult = await buildReconnaissance(cwd, options.changePath)

  initialPlanState.runtimeStateDir = resolveRuntimeStateDir(cwd)
  initialPlanState.runtimeMetadata = {
    repoMapPath: repoMapResult.path,
    reconnaissancePath: reconResult.path,
    ...(durableDraftPlan ? { durablePlanDocPath: durableDraftPlan.path } : {}),
  }
  try {
    const raw = await fs.readFile(planStatePath, "utf-8")
    const planState = JSON.parse(raw)
    planState.runtimeMetadata = {
      ...(planState.runtimeMetadata ?? {}),
      ...initialPlanState.runtimeMetadata,
    }
    planState.updatedAt = new Date().toISOString()
    await fs.writeFile(planStatePath, JSON.stringify(planState, null, 2), "utf-8")
  } catch {
    console.warn("[zflow] Could not persist runtime metadata in plan-state.json.")
  }

  options.onProgress?.("🤖 Dispatching zflow.planner-frontier to generate plan artifacts...", "info")
  const agentDispatchResult = await runPrepareAgentsIfAvailable(
    changeId,
    "v1",
    cwd,
    options.changePath,
    effectivePrepareNotes,
    (message) => options.onProgress?.(message, "info"),
  )
  if (agentDispatchResult.dispatched) {
    options.onProgress?.(
      `✅ Planner dispatch completed via ${agentDispatchResult.serviceName}.` +
      `${agentDispatchResult.methodUsed} (${agentDispatchResult.producedOutputs.length} outputs).`,
      "info",
    )
  } else if (agentDispatchResult.agentDispatchStatus === "unavailable") {
    options.onProgress?.("⚠️ No agent dispatch service available — planner did not run.", "warning")
  } else {
    options.onProgress?.(`⚠️ Agent dispatch failed: ${agentDispatchResult.error}`, "warning")
  }

  try {
    const synthesizedImplementationTasks = await ensureImplementationTasksArtifact(changeId, "v1", cwd)
    if (synthesizedImplementationTasks) {
      options.onProgress?.(
        "🧩 Synthesized missing implementation-tasks.md from execution-groups.md. This recovery artifact is not approvable until the planner rewrites it.",
        "warning",
      )
    }
  } catch (err) {
    options.onProgress?.(
      `⚠️ Could not synthesize implementation-tasks.md: ${err instanceof Error ? err.message : String(err)}`,
      "warning",
    )
  }

  const { validateAllPlanArtifacts } = await import("../../plan-artifact-validator.js")
  options.onProgress?.("🔍 Validating plan artifacts against format contracts...", "info")
  const validationResult = await validateAllPlanArtifacts(changeId, "v1", cwd)

  if (!validationResult.valid) {
    const errors = validationResult.results
      .filter((r) => !r.valid)
      .map((r) => `- **${r.artifact}**: ${r.issues.join("; ")}`)
      .join("\n")
    options.onProgress?.(
      `⚠️ Plan artifacts have validation issues:\n${errors}\n` +
      `Attempting planner repair pass...`,
      "warning",
    )

    const { runArtifactRepair } = await import("../../plan-artifact-validator.js")
    const repairResult = await runArtifactRepair(changeId, "v1", validationResult.results.filter((r) => !r.valid), 2, cwd)

    if (repairResult.repaired) {
      options.onProgress?.("✅ Plan artifacts repaired successfully.", "info")
    } else {
      const remaining = repairResult.remainingIssues
        .filter((r) => !r.valid)
        .map((r) => `- **${r.artifact}**: ${r.issues.join("; ")}`)
        .join("\n")
      options.onProgress?.(
        `⚠️ Some plan artifacts could not be automatically repaired:\n${remaining}\n` +
        `Plan approval will be blocked until these are resolved.\n` +
        `Artifact paths for manual editing:\n` +
        Object.entries(artifactPaths).map(([k, v]) => `  - ${k}: ${v}`).join("\n"),
        "warning",
      )
    }
  } else {
    options.onProgress?.("✅ All plan artifacts pass format validation.", "info")
  }

  return {
    changeId,
    planVersion: "v1",
    stateDir: path.dirname(planStatePath),
    planStatePath,
    artifactPaths,
    initialPlanState,
    agentDispatchResult,
  }
}
