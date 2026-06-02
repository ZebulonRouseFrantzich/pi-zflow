/**
 * agent-dispatch.ts — optional prepare-phase planner dispatch.
 */

import { resolvePlanStatePath, resolvePlanVersionDir } from "pi-zflow-artifacts/artifact-paths"
import { getZflowRegistry } from "pi-zflow-core/registry"
import {
  DISPATCH_SERVICE_CAPABILITY,
  type DispatchService,
  type AgentDispatchProgress,
} from "pi-zflow-core/dispatch-service"

import {
  backfillImplementationTasksLikelyFiles,
  buildImplementationAgentPromptLines,
  canonicalizeExecutionGroupsAgentFields,
  canonicalizeImplementationTasksAgentFields,
  resolveImplementationAgentGuidance,
} from "../implementation-agents.js"

/**
 * Result of attempting to dispatch prepare-phase agents via the registry.
 */
export interface PrepareAgentDispatchResult {
  /** Whether any agent dispatch was attempted and completed. */
  dispatched: boolean
  /**
   * Status of the dispatch attempt:
   * - "unavailable": no registry service exposes compatible dispatch methods
   * - "dispatched": service called successfully, outputs may exist
   * - "failed": service was called but threw an error
   */
  agentDispatchStatus: "unavailable" | "dispatched" | "failed"
  /** Name of the capability/service used, if any. */
  serviceName?: string
  /** Method used for dispatch, if any. */
  methodUsed?: string
  /** Absolute paths to any output files produced by agent dispatch. */
  producedOutputs: string[]
  /** Error message if dispatch failed. */
  error?: string
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

function isTransportDispatchError(error: string | undefined): boolean {
  if (!error) return false
  const TRANSPORT_ERROR_PATTERNS = [
    /WebSocket error/i,
    /ECONNRESET/i,
    /connection (closed|reset|refused)/i,
    /transport/i,
    /timeout/i,
    /network/i,
    /socket/i,
    /tls/i,
    /ETIMEDOUT/i,
    /ENOTFOUND/i,
    /EPIPE/i,
    /ECONNREFUSED/i,
    /keepalive/i,
  ]
  return TRANSPORT_ERROR_PATTERNS.some((pattern) => pattern.test(error))
}

function formatDispatchElapsed(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "00:00"
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

function formatPrepareAgentProgress(progress: AgentDispatchProgress): string {
  const elapsed = formatDispatchElapsed(progress.durationMs)
  const toolCount = progress.toolCount ?? 0
  if (progress.currentTool) {
    const args = progress.currentToolArgs ? ` ${progress.currentToolArgs}` : ""
    return `zflow.planner-frontier running — child elapsed ${elapsed} — ${toolCount} tools — current: ${progress.currentTool}${args}`
  }
  const recent = progress.recentTools?.at(-1)
  if (recent?.tool) {
    const args = recent.args ? ` ${recent.args}` : ""
    return `zflow.planner-frontier running — child elapsed ${elapsed} — ${toolCount} tools — last: ${recent.tool}${args}`
  }
  return `zflow.planner-frontier running — child elapsed ${elapsed} — ${toolCount} tools observed`
}

/**
 * Run prepare-phase agents via the registry if available.
 *
 * Checks the shared capability registry for any registered service that
 * exposes agent-dispatch methods (`runAgent`, `runChain`, `dispatch`,
 * `subagent`). Designed for optional integration — if no service exists,
 * the prepare workflow still succeeds with an explicit
 * `agentDispatchStatus: "unavailable"` recorded in plan-state.
 *
 * If a compatible service is found, calls through it defensively
 * (try/catch) and persists any outputs to repo-map, reconnaissance, and
 * plan artifact paths. If the service exists but exposes none of the
 * known dispatch method names, no dispatch is attempted.
 *
 * @param changeId - The change identifier.
 * @param planVersion - The plan version label (e.g. "v1").
 * @param cwd - Working directory (optional).
 * @returns A structured result describing the dispatch outcome.
 */
export async function runPrepareAgentsIfAvailable(
  changeId: string,
  planVersion: string,
  cwd?: string,
  changePath?: string,
  prepareNotes?: string,
  onAgentProgress?: (message: string) => void,
): Promise<PrepareAgentDispatchResult> {
  const registry = getZflowRegistry()
  const { default: fs } = await import("node:fs/promises")
  const { default: pathModule } = await import("node:path")
  const { resolveRuntimeStateDir } = await import("pi-zflow-core/runtime-paths")

  const runtimeStateDir = resolveRuntimeStateDir(cwd)
  const versionDir = resolvePlanVersionDir(changeId, planVersion, cwd)
  const artifactPaths = {
    repoMap: pathModule.join(runtimeStateDir, "repo-map.md"),
    reconnaissance: pathModule.join(runtimeStateDir, "reconnaissance.md"),
    design: pathModule.join(versionDir, "design.md"),
    executionGroups: pathModule.join(versionDir, "execution-groups.md"),
    standards: pathModule.join(versionDir, "standards.md"),
    verification: pathModule.join(versionDir, "verification.md"),
    implementationTasks: pathModule.join(versionDir, "implementation-tasks.md"),
  }

  const collectOutputs = async (): Promise<string[]> => {
    const outputs: string[] = []
    for (const artifactPath of Object.values(artifactPaths)) {
      try {
        await fs.access(artifactPath)
        outputs.push(artifactPath)
      } catch {
        // Not written — that's fine
      }
    }
    return outputs
  }

  const canonicalizePreparedArtifacts = async (implementationAgentGuidance: Awaited<ReturnType<typeof resolveImplementationAgentGuidance>>): Promise<void> => {
    let canonicalExecutionGroupsContent: string | undefined

    try {
      const executionGroupsRaw = await fs.readFile(artifactPaths.executionGroups, "utf-8")
      const canonicalExecutionGroups = canonicalizeExecutionGroupsAgentFields(
        executionGroupsRaw,
        implementationAgentGuidance,
      )
      canonicalExecutionGroupsContent = canonicalExecutionGroups.content
      if (canonicalExecutionGroups.changed) {
        await fs.writeFile(artifactPaths.executionGroups, canonicalExecutionGroups.content, "utf-8")
      }
    } catch {
      // execution-groups.md may be absent or still unwritten
    }

    try {
      const implementationTasksRaw = await fs.readFile(artifactPaths.implementationTasks, "utf-8")
      const canonicalImplementationTasks = canonicalizeImplementationTasksAgentFields(
        implementationTasksRaw,
        implementationAgentGuidance,
      )
      const backfilledImplementationTasks = canonicalExecutionGroupsContent
        ? backfillImplementationTasksLikelyFiles(
            canonicalImplementationTasks.content,
            canonicalExecutionGroupsContent,
          )
        : { content: canonicalImplementationTasks.content, changed: false }

      if (canonicalImplementationTasks.changed || backfilledImplementationTasks.changed) {
        await fs.writeFile(artifactPaths.implementationTasks, backfilledImplementationTasks.content, "utf-8")
      }
    } catch {
      // implementation-tasks.md may be absent or still unwritten
    }
  }

  const recordDispatchMetadata = async (metadata: Record<string, unknown>): Promise<void> => {
    try {
      const planStatePath = resolvePlanStatePath(changeId, cwd)
      const raw = await fs.readFile(planStatePath, "utf-8")
      const planState = JSON.parse(raw)
      planState.runtimeMetadata = {
        ...(planState.runtimeMetadata ?? {}),
        ...metadata,
      }
      planState.updatedAt = new Date().toISOString()
      await fs.writeFile(planStatePath, JSON.stringify(planState, null, 2), "utf-8")
    } catch {
      // Non-critical; skip recording
    }
  }

  const zflowDispatch = registry.optional<DispatchService>(DISPATCH_SERVICE_CAPABILITY)
  if (zflowDispatch && typeof zflowDispatch.runAgent === "function") {
    try {
      const implementationAgentGuidance = await resolveImplementationAgentGuidance(cwd)
      const task = [
        `Run formal zflow change preparation for changeId \`${changeId}\` and planVersion \`${planVersion}\`.`,
        changePath ? `Change input path: ${changePath}` : "No change input path was provided.",
        prepareNotes ? `Additional user notes: ${prepareNotes}` : "",
        "Treat non-RuneContext idea/change documents as requirements input, then inspect the repository before planning.",
        "Ask clarifying questions in your final output if decisions are genuinely blocked; otherwise write all five required plan artifacts.",
        "Use ONLY zflow_write_plan_artifact for artifact writes.",
        "Required artifact writes:",
        `- design -> ${artifactPaths.design}`,
        `- execution-groups -> ${artifactPaths.executionGroups}`,
        `- standards -> ${artifactPaths.standards}`,
        `- verification -> ${artifactPaths.verification}`,
        `- implementation-tasks -> ${artifactPaths.implementationTasks}`,
        `Repository map path: ${artifactPaths.repoMap}`,
        `Reconnaissance path: ${artifactPaths.reconnaissance}`,
        "",
        "## CRITICAL: Machine-Readable Format Contract",
        "",
        "The plan artifacts MUST be parseable by automated tools. The parsers are strict.",
        "Validation will fail if the format contract is violated, and the planner will",
        "receive EXACT parser errors to repair the artifacts.",
        "",
        "### execution-groups.md — REQUIRED format",
        "",
        ...buildImplementationAgentPromptLines(implementationAgentGuidance),
        "",
        "Each group heading: `## Group X: Name` or `## GX — Name` or `## Execution Group X: Name`",
        "Group IDs: digit-first (1, 1A, 2B) or letter-first (A1, B2, C3a).",
        "",
        "Required fields per group:",
        "- `**Files:**` or `**Primary files/paths touched:**` — comma-separated paths or bullet list.",
        "  Each file path must be concrete (e.g. `src/auth/login.ts`), not vague like `src/auth/*`.",
        "- `**Scoped verification:**` — a concrete shell command. NOT \"TBD\", not empty.",
        "- `**Agent:**` — required and must be one of the discoverable implementation agents listed above.",
        "- `**Dependencies:**` — required (group IDs or `none`).",
        "- `**Parallelizable:**` — required (`true` or `false`).",
        "- `**Role label:**` — optional human ownership label (for example `backend-api`, `sdk-client`, or `cli-integrations`).",
        "",
        "Optional advanced execution fields (default to simple isolated execution unless justified):",
        "- `**Execution mode:** isolated | shared-staging`",
        "- `**Workspace ID:** <kebab-id>` (required when execution mode is `shared-staging`)",
        "- `**Workspace concurrency:** serialized | concurrent` (default `serialized`)",
        "- `**Base strategy:** head | dependency-lineage` (default `head`)",
        "- `**Execution rationale:** <concrete reason>` (required for any non-default execution mode or base strategy)",
        "",
        "Use advanced execution fields sparingly:",
        "- Default to isolated worktrees.",
        "- Use shared-staging only when two or more groups genuinely need shared filesystem/type feedback.",
        "- Use `Workspace concurrency: concurrent` only when the backend explicitly supports it; otherwise prefer `serialized`.",
        "- Use `Base strategy: dependency-lineage` only when downstream groups truly need their dependencies' pending changes present before final apply-back.",
        "",
        "### CRITICAL: File ownership and cross-group dependencies",
        "",
        "When two groups claim the same file, the execution dispatcher MUST know",
        "which group runs first. The ownership validator will REJECT the plan at",
        "implementation time if overlapping files have no dependency ordering.",
        "",
        "Rules:",
        "- If groups share ANY file, one must declare an explicit dependency on the other.",
        "- Set `Parallelizable: false` on groups that share files with peers.",
        "- Transitive dependencies count: if G8→G6→G5, then G8 is ordered after G5.",
        "  But if G7 and G8 both touch `app.ts` and neither depends on the other,",
        "  that overlap IS a violation — add `Dependencies: 6, 7` to G8.",
        "- After drafting all groups, scan the Files: lists for every same-phase group",
        "  pair. For every overlapping file, ensure a dependency edge exists between",
        "  the two groups touching it.",
        "- Phase 3 cross-cutting groups (redaction, rate-limit, access guardrails)",
        "  commonly all touch integration files like `app.ts`. They MUST declare",
        "  dependencies on each other, not just on Phase 2 groups.",
        "",
        "Example:",
        "",
        "```markdown",
        "## Group A1: Short descriptive name",
        "",
        "**Files:** src/path/file.ts, src/other/file.ts",
        "**Role label:** backend-api",
        `**Agent:** ${implementationAgentGuidance.defaultAgent}`,
        "**Dependencies:** none",
        "**Scoped verification:** npm test -- --testPathPattern=src/path",
        "**Parallelizable:** true",
        "```",
        "",
        "VALID: `**Scoped verification:** npm test -- --testPathPattern=src/auth`",
        "INVALID: `**Scoped verification:** TBD`",
        "INVALID: `**Scoped verification:** ` (empty)",
        "",
        "### implementation-tasks.md — REQUIRED format",
        "",
        "For EVERY execution group, include a matching section headed like `## Group X: Name`.",
        "Each group section must include these subsections with concrete content:",
        "- `### Objective`",
        "- `### Scope`",
        "- `### Likely files touched`",
        "- `### Context to read first`",
        "- `### Implementation checklist`",
        "- `### Pseudocode / implementation sketch`",
        "- `### Acceptance criteria`",
        "- `### Scoped verification`",
        "- `### Self-check before completion`",
        "- `### Drift triggers`",
        "",
        "Implementation-task quality rules:",
        "- The pseudocode must be group-specific, not boilerplate reused for every group.",
        "- Mention concrete files, symbols, data flows, or interfaces relevant to that group.",
        "- Do NOT write generic fallback text like 'for each likely touched file' unless you also explain the actual code path for this group.",
        "- Do NOT emit synthesized-marker comments such as `zflow-synthesized-artifact`.",
        "",
        "### Other artifacts",
        "",
        "- **design.md**: Must have >=50 chars of concrete design content.",
        "- **standards.md**: Must have >=50 chars. No [TODO] or [placeholder] markers.",
        "- **verification.md**: Must have >=50 chars and at least one code fence with a command.",
        "- **implementation-tasks.md**: Must have >=100 chars, real per-group sections, and no placeholder/synthesized markers.",
        "",
        "### Failure is OK",
        "",
        "If your plan artifacts fail validation, you will receive the EXACT parser errors",
        "and can rewrite only the invalid artifact. This is NOT a criticism — it is a",
        "normal part of ensuring machine-ingestible output. Repair passes are bounded",
        "and expected.",
      ].filter(Boolean).join("\n")

      const MAX_DISPATCH_RETRIES = 3
      const RETRY_BACKOFF_MS = [1_000, 3_000, 5_000]

      let attempt = 0
      let lastResult: Awaited<ReturnType<DispatchService["runAgent"]>> | null = null
      let outputs: string[] = []

      while (attempt <= MAX_DISPATCH_RETRIES) {
        if (attempt > 0) {
          onAgentProgress?.(
            `zflow.planner-frontier transport error, retry ${attempt}/${MAX_DISPATCH_RETRIES}...`,
          )
          await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[attempt - 1]))
        } else {
          onAgentProgress?.("zflow.planner-frontier launch requested — waiting for first child event")
        }

        let sawChildProgress = false
        const launchStartedAt = Date.now()
        const heartbeat = setInterval(() => {
          if (sawChildProgress) return
          onAgentProgress?.(
            `zflow.planner-frontier launch pending — no child tool events yet after ${formatDispatchElapsed(Date.now() - launchStartedAt)}`,
          )
        }, 15_000)
        heartbeat.unref?.()

        try {
          lastResult = await zflowDispatch.runAgent({
            agent: "zflow.planner-frontier",
            task,
            cwd: cwd ?? process.cwd(),
            model: await resolveProfileModelForAgent("zflow.planner-frontier"),
            onUpdate: (progress) => {
              sawChildProgress = true
              onAgentProgress?.(formatPrepareAgentProgress(progress))
            },
            output: pathModule.join(versionDir, "planner-frontier-output.md"),
            outputMode: "file-only",
            maxOutput: { lines: 400, bytes: 24000 },
          })
          outputs = await collectOutputs()

          if (lastResult.ok || outputs.length >= 3) {
            break
          }

          if (!isTransportDispatchError(lastResult.error) || attempt >= MAX_DISPATCH_RETRIES) {
            break
          }

          clearInterval(heartbeat)
          attempt++
          continue
        } catch (err) {
          clearInterval(heartbeat)
          outputs = await collectOutputs()

          if (outputs.length >= 3) {
            lastResult = null
            break
          }

          const errMsg = err instanceof Error ? err.message : String(err)
          if (!isTransportDispatchError(errMsg) || attempt >= MAX_DISPATCH_RETRIES) {
            throw err
          }
          attempt++
        } finally {
          clearInterval(heartbeat)
        }
      }

      if (lastResult) {
        if (!lastResult.ok) {
          if (outputs.length >= 3) {
            await canonicalizePreparedArtifacts(implementationAgentGuidance)
            outputs = await collectOutputs()
            await recordDispatchMetadata({
              agentDispatchStatus: "dispatched",
              agentDispatchService: DISPATCH_SERVICE_CAPABILITY,
              agentDispatchMethod: "runAgent",
              agentDispatchedAt: new Date().toISOString(),
              agentDispatchError: `Recovered: agent wrote ${outputs.length} artifacts before ${lastResult.error ?? "transport error"}`,
              availableImplementationAgents: implementationAgentGuidance.implementationAgents,
              canonicalRoleLabels: implementationAgentGuidance.roleLabels,
            })
            return {
              dispatched: true,
              agentDispatchStatus: "dispatched",
              serviceName: DISPATCH_SERVICE_CAPABILITY,
              methodUsed: "runAgent",
              producedOutputs: outputs,
              error: lastResult.error,
            }
          }
          await recordDispatchMetadata({
            agentDispatchStatus: "failed",
            agentDispatchService: DISPATCH_SERVICE_CAPABILITY,
            agentDispatchMethod: "runAgent",
            agentDispatchError: lastResult.error ?? "Planner dispatch failed",
          })
          return {
            dispatched: false,
            agentDispatchStatus: "failed",
            serviceName: DISPATCH_SERVICE_CAPABILITY,
            methodUsed: "runAgent",
            producedOutputs: outputs,
            error: lastResult.error ?? "Planner dispatch failed",
          }
        }

        await canonicalizePreparedArtifacts(implementationAgentGuidance)
        outputs = await collectOutputs()

        await recordDispatchMetadata({
          agentDispatchStatus: "dispatched",
          agentDispatchService: DISPATCH_SERVICE_CAPABILITY,
          agentDispatchMethod: "runAgent",
          agentDispatchedAt: new Date().toISOString(),
          plannerOutputPath: lastResult.outputPath,
          availableImplementationAgents: implementationAgentGuidance.implementationAgents,
          canonicalRoleLabels: implementationAgentGuidance.roleLabels,
        })
        return {
          dispatched: true,
          agentDispatchStatus: "dispatched",
          serviceName: DISPATCH_SERVICE_CAPABILITY,
          methodUsed: "runAgent",
          producedOutputs: outputs,
        }
      }

      await canonicalizePreparedArtifacts(implementationAgentGuidance)
      outputs = await collectOutputs()
      await recordDispatchMetadata({
        agentDispatchStatus: "dispatched",
        agentDispatchService: DISPATCH_SERVICE_CAPABILITY,
        agentDispatchMethod: "runAgent",
        agentDispatchedAt: new Date().toISOString(),
        agentDispatchError: `Recovered: found ${outputs.length} existing artifacts after transport failures`,
        availableImplementationAgents: implementationAgentGuidance.implementationAgents,
        canonicalRoleLabels: implementationAgentGuidance.roleLabels,
      })
      return {
        dispatched: true,
        agentDispatchStatus: "dispatched",
        serviceName: DISPATCH_SERVICE_CAPABILITY,
        methodUsed: "runAgent",
        producedOutputs: outputs,
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      await recordDispatchMetadata({
        agentDispatchStatus: "failed",
        agentDispatchService: DISPATCH_SERVICE_CAPABILITY,
        agentDispatchMethod: "runAgent",
        agentDispatchError: errorMessage,
      })
      return {
        dispatched: false,
        agentDispatchStatus: "failed",
        serviceName: DISPATCH_SERVICE_CAPABILITY,
        methodUsed: "runAgent",
        producedOutputs: await collectOutputs(),
        error: errorMessage,
      }
    }
  }

  const DISPATCH_METHOD_NAMES = new Set(["runAgent", "runChain", "dispatch", "subagent"])
  const capabilities = registry.getCapabilities()
  let dispatchService: { name: string; service: unknown; method: string } | null = null

  for (const [capName, registered] of capabilities) {
    if (registered.service === undefined) continue
    const svc = registered.service as Record<string, unknown>
    for (const methodName of DISPATCH_METHOD_NAMES) {
      if (typeof svc[methodName] === "function") {
        dispatchService = { name: capName, service: svc, method: methodName }
        break
      }
    }
    if (dispatchService) break
  }

  if (!dispatchService) {
    try {
      const planStatePath = resolvePlanStatePath(changeId, cwd)
      const raw = await fs.readFile(planStatePath, "utf-8")
      const planState = JSON.parse(raw)
      planState.runtimeMetadata = {
        ...(planState.runtimeMetadata ?? {}),
        agentDispatchStatus: "unavailable",
        agentCheckedAt: new Date().toISOString(),
      }
      planState.updatedAt = new Date().toISOString()
      await fs.writeFile(planStatePath, JSON.stringify(planState, null, 2), "utf-8")
    } catch {
      // Non-critical; skip recording
    }

    return {
      dispatched: false,
      agentDispatchStatus: "unavailable",
      producedOutputs: [],
    }
  }

  const outputs: string[] = []

  try {
    const dispatchFn = (dispatchService.service as Record<string, unknown>)[
      dispatchService.method
    ] as (...args: unknown[]) => Promise<unknown>

    const dispatchContext = {
      changeId,
      planVersion,
      cwd: cwd ?? process.cwd(),
      artifactPaths,
    }

    await dispatchFn(dispatchContext)

    for (const artifactPath of Object.values(dispatchContext.artifactPaths)) {
      try {
        await fs.access(artifactPath)
        outputs.push(artifactPath)
      } catch {
        // Not written — that's fine
      }
    }

    try {
      const planStatePath = resolvePlanStatePath(changeId, cwd)
      const raw = await fs.readFile(planStatePath, "utf-8")
      const planState = JSON.parse(raw)
      planState.runtimeMetadata = {
        ...(planState.runtimeMetadata ?? {}),
        agentDispatchStatus: "dispatched",
        agentDispatchService: dispatchService.name,
        agentDispatchMethod: dispatchService.method,
        agentDispatchedAt: new Date().toISOString(),
      }
      planState.updatedAt = new Date().toISOString()
      await fs.writeFile(planStatePath, JSON.stringify(planState, null, 2), "utf-8")
    } catch {
      // Non-critical
    }

    return {
      dispatched: true,
      agentDispatchStatus: "dispatched",
      serviceName: dispatchService.name,
      methodUsed: dispatchService.method,
      producedOutputs: outputs,
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)

    try {
      const planStatePath = resolvePlanStatePath(changeId, cwd)
      const raw = await fs.readFile(planStatePath, "utf-8")
      const planState = JSON.parse(raw)
      planState.runtimeMetadata = {
        ...(planState.runtimeMetadata ?? {}),
        agentDispatchStatus: "failed",
        agentDispatchService: dispatchService.name,
        agentDispatchMethod: dispatchService.method,
        agentDispatchError: errorMessage,
      }
      planState.updatedAt = new Date().toISOString()
      await fs.writeFile(planStatePath, JSON.stringify(planState, null, 2), "utf-8")
    } catch {
      // Non-critical
    }

    return {
      dispatched: false,
      agentDispatchStatus: "failed",
      serviceName: dispatchService.name,
      methodUsed: dispatchService.method,
      producedOutputs: outputs,
      error: errorMessage,
    }
  }
}
