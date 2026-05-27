/**
 * pi-zflow-subagents-bridge extension entrypoint
 *
 * Registers the `zflow-dispatch` capability in the shared zflow registry.
 *
 * ## Runtime dispatch backend
 *
 * On activation, this extension attempts to load the pi-subagents fork's
 * programmatic dispatch API (`createZflowDispatchService`).  If the fork
 * is available as a dependency, the service wraps it to provide real
 * subagent dispatch.  Otherwise it falls back to a diagnostic
 * "unavailable" service that returns actionable guidance.
 *
 * ## Seam design
 *
 * The fork (`pi-subagents-zflow`) is the only backend that provides
 * operational dispatch.  No Pi ExtensionAPI or ExtensionContext is needed
 * at runtime — agent execution spawns the `pi` CLI as a child process,
 * which is the same mechanism the `subagent` tool uses internally.
 *
 * ## Safety guarantees
 *
 * - No commands, tools, or event handlers are ever registered.
 * - Duplicate load is detected via the zflow registry and treated as no-op.
 * - If the fork backend fails at dispatch time, a clear error is returned.
 *
 * @module pi-zflow-subagents-bridge
 */

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { getZflowRegistry } from "pi-zflow-core/registry"
import type { CapabilityClaim } from "pi-zflow-core/registry"
import {
  DISPATCH_SERVICE_CAPABILITY,
  type DispatchService,
  type AgentDispatchInput,
  type AgentDispatchResult,
  type ParallelDispatchInput,
  type ParallelDispatchResult,
  type ParallelTaskResult,
} from "pi-zflow-core/dispatch-service"
import { PI_ZFLOW_SUBAGENTS_BRIDGE_VERSION } from "pi-zflow-core"

/**
 * Well-known capability name for the dispatch service.
 * Re-exported for convenience; the canonical value lives in
 * `pi-zflow-core/dispatch-service`.
 */
export { DISPATCH_SERVICE_CAPABILITY }

// ── Unavailable fallback ──────────────────────────────────────────

const UNAVAILABLE_GUIDANCE =
  "zflow dispatch is unavailable: pi-subagents fork is not installed or " +
  "could not be loaded. To resolve: install the forked pi-subagents package " +
  "as a dependency of pi-zflow-subagents-bridge.\n" +
  "  npm install /path/to/pi-subagents-zflow\n" +
  "\n" +
  "Until then, apply changes manually and use --manual-dispatch-complete with " +
  "/zflow-change-implement."

class UnavailableDispatchService implements DispatchService {
  readonly name = "pi-zflow-subagents-bridge:unavailable"
  private readonly reason?: string

  constructor(reason?: string) {
    this.reason = reason
  }

  private message(agent: string): string {
    return `Cannot dispatch agent "${agent}" via "${this.name}".\n\n` +
      (this.reason ? `Load failure: ${this.reason}\n\n` : "") +
      UNAVAILABLE_GUIDANCE
  }

  async runAgent(input: AgentDispatchInput): Promise<AgentDispatchResult> {
    return {
      ok: false,
      rawOutput: "",
      error: this.message(input.agent),
    }
  }

  async runParallel(input: ParallelDispatchInput): Promise<ParallelDispatchResult> {
    const results: ParallelTaskResult[] = input.tasks.map((task) => ({
      agent: task.agent,
      rawOutput: "",
      ok: false,
      error: this.message(task.agent),
    }))
    return { ok: false, results }
  }
}

// ── Operational backend (wraps pi-subagents-zflow) ────────────────

type BackendVerification = NonNullable<ParallelTaskResult["verification"]>

interface BackendDispatchService {
  readonly name?: string
  runAgent(input: {
    agent: string
    task: string
    cwd?: string
    model?: string
    output?: string | false
    outputMode?: "inline" | "file-only"
    maxOutput?: { lines?: number; bytes?: number }
    onUpdate?: (progress: unknown) => void
  }): Promise<{
    ok: boolean
    exitCode: number
    error?: string
    rawOutput: string
    outputPath?: string
    savedOutputPath?: string
  }>
  runParallel(input: {
    tasks: Array<{
      agent: string
      task: string
      cwd?: string
      model?: string
      output?: string | false
      outputMode?: "inline" | "file-only"
      maxOutput?: { lines?: number; bytes?: number }
      onUpdate?: (progress: unknown) => void
    }>
    cwd?: string
    concurrency?: number
    worktree?: boolean
    maxOutput?: { lines?: number; bytes?: number }
  }): Promise<{
    ok: boolean
    results: Array<{
      agent: string
      ok: boolean
      error?: string
      rawOutput: string
      outputPath?: string
      savedOutputPath?: string
      worktreePath?: string
      patchPath?: string
      changedFiles?: string[]
      verification?: BackendVerification
    }>
  }>
}

/**
 * DispatchService that delegates to pi-subagents-zflow's programmatic API.
 *
 * The fork's `createZflowDispatchService` uses the same child-process
 * spawning engine as the builtin `subagent` tool, so no Pi
 * ExtensionContext is required at runtime.
 */
class SubagentsDispatchService implements DispatchService {
  readonly name: string
  private backend: BackendDispatchService

  constructor(backend: BackendDispatchService) {
    this.backend = backend
    this.name = `pi-zflow-subagents-bridge:${backend.name ?? "operational"}`
  }

  async runAgent(input: AgentDispatchInput): Promise<AgentDispatchResult> {
    try {
      const result = await this.backend.runAgent({
        agent: input.agent,
        task: input.task,
        cwd: input.cwd,
        model: input.model,
        output: input.output,
        outputMode: input.outputMode,
        maxOutput: input.maxOutput,
        onUpdate: input.onUpdate,
      })
      return {
        ok: result.ok,
        rawOutput: result.rawOutput,
        outputPath: result.outputPath ?? result.savedOutputPath,
        error: result.error,
      }
    } catch (err) {
      return {
        ok: false,
        rawOutput: "",
        error: `Dispatch error: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  async runParallel(input: ParallelDispatchInput): Promise<ParallelDispatchResult> {
    try {
      const result = await this.backend.runParallel({
        tasks: input.tasks.map((t) => ({
          agent: t.agent,
          task: t.task,
          cwd: t.cwd,
          model: t.model,
          output: t.output,
          outputMode: t.outputMode,
          maxOutput: input.maxOutput,
          onUpdate: t.onUpdate,
          scopedVerification: (t as { scopedVerification?: string }).scopedVerification,
          worktreeSetupCommand: (t as { worktreeSetupCommand?: string }).worktreeSetupCommand,
        })),
        cwd: input.cwd,
        concurrency: input.concurrency,
        worktree: input.worktree,
        maxOutput: input.maxOutput,
      })
      return {
        ok: result.ok,
        results: result.results.map((r) => ({
          agent: r.agent,
          rawOutput: r.rawOutput,
          outputPath: r.outputPath ?? r.savedOutputPath,
          ok: r.ok,
          error: r.error,
          worktreePath: r.worktreePath,
          patchPath: r.patchPath,
          changedFiles: r.changedFiles,
          verification: r.verification,
        })),
      }
    } catch (err) {
      return {
        ok: false,
        results: input.tasks.map((t) => ({
          agent: t.agent,
          rawOutput: "",
          ok: false,
          error: `Parallel dispatch error: ${err instanceof Error ? err.message : String(err)}`,
        })),
      }
    }
  }
}

// ── Compatibility backend (builds zflow bridge from installed pi-subagents) ──

interface CompatAgentProgress {
  agent: string
  status?: string
  toolCount?: number
  currentTool?: string
  currentToolArgs?: string
  recentTools?: Array<{ tool?: string; args?: string }>
  durationMs?: number
  lastActivityAt?: number
  recentOutput?: string[]
}

interface CompatSingleResult {
  exitCode: number
  error?: string
  finalOutput?: string
  savedOutputPath?: string
}

interface CompatRunSyncOptions {
  runId: string
  cwd?: string
  modelOverride?: string
  outputPath?: string
  outputMode?: "inline" | "file-only"
  maxOutput?: { lines?: number; bytes?: number }
  onUpdate?: (update: { details?: { progress?: unknown[] } }) => void
}

interface CompatModules {
  discoverAgents: (cwd: string, scope?: "user" | "project" | "both") => { agents: unknown[] }
  runSync: (runtimeCwd: string, agents: unknown[], agentName: string, task: string, options: CompatRunSyncOptions) => Promise<CompatSingleResult>
  createWorktrees: (cwd: string, runId: string, count: number, options?: { agents?: string[] }) => { worktrees: Array<{ agentCwd: string }> }
  diffWorktrees: (setup: unknown, agents: string[], diffsDir: string) => Array<{ index: number; patchPath: string; filesChanged: number }>
  cleanupWorktrees: (setup: unknown) => void
}

function generateRunId(): string {
  return crypto.randomUUID().slice(0, 8)
}

/**
 * Run tasks with rolling concurrency.
 *
 * Starts up to `limit` tasks immediately.
 * When any task completes, the next queued task begins.
 * Results are returned in original task order.
 */
async function runTasksWithRollingConcurrency<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const idx = nextIndex++
      // If a task factory throws unexpectedly, catch and set the result to a
      // best-effort failure sentinel so the slot is freed and the pool
      // continues. Call-site task factories already catch their own errors
      // and return { ok: false, error }, so this is defence-in-depth.
      try {
        results[idx] = await tasks[idx]()
      } catch (err) {
        results[idx] = {
          ok: false,
          error: `Unexpected worker crash: ${err instanceof Error ? err.message : String(err)}`,
          rawOutput: "",
        } as unknown as T
      }
    }
  }

  const active = Math.min(limit, tasks.length)
  const workers: Promise<void>[] = []
  for (let i = 0; i < active; i++) {
    workers.push(worker())
  }
  await Promise.all(workers)
  return results
}

function safeGetCwd(override?: string): string {
  if (override) {
    try {
      fs.accessSync(override, fs.constants.R_OK)
      return override
    } catch {
      // fall through to process.cwd()
    }
  }
  return process.cwd()
}

function findAgent(agents: unknown[], name: string): { name: string } | undefined {
  return agents.find((agent) => {
    const agentName = (agent as { name?: unknown }).name
    return agentName === name || agentName === `builtin:${name}`
  }) as { name: string } | undefined
}

function mapCompatProgress(agentName: string, progress: Record<string, unknown>): CompatAgentProgress {
  const recentTools = Array.isArray(progress.recentTools)
    ? progress.recentTools.map((tool) => ({
      tool: (tool as { tool?: unknown }).tool as string | undefined,
      args: (tool as { args?: unknown }).args as string | undefined,
    }))
    : undefined
  return {
    agent: agentName,
    status: typeof progress.status === "string" ? progress.status : undefined,
    toolCount: typeof progress.toolCount === "number" ? progress.toolCount : undefined,
    currentTool: typeof progress.currentTool === "string" ? progress.currentTool : undefined,
    currentToolArgs: typeof progress.currentToolArgs === "string" ? progress.currentToolArgs : undefined,
    recentTools,
    durationMs: typeof progress.durationMs === "number" ? progress.durationMs : undefined,
    lastActivityAt: typeof progress.lastActivityAt === "number" ? progress.lastActivityAt : undefined,
    recentOutput: Array.isArray(progress.recentOutput) ? progress.recentOutput.filter((line): line is string => typeof line === "string") : undefined,
  }
}

function forwardCompatProgress(
  agentName: string,
  onUpdate: ((progress: CompatAgentProgress) => void) | undefined,
): CompatRunSyncOptions["onUpdate"] | undefined {
  if (!onUpdate) return undefined
  return (update) => {
    const progress = update.details?.progress?.[0]
    if (!progress || typeof progress !== "object") return
    onUpdate(mapCompatProgress(agentName, progress as Record<string, unknown>))
  }
}

function mapCompatSingleResult(result: CompatSingleResult): {
  ok: boolean
  exitCode: number
  error?: string
  rawOutput: string
  outputPath?: string
  savedOutputPath?: string
} {
  return {
    ok: result.exitCode === 0 && !result.error,
    exitCode: result.exitCode,
    error: result.error,
    rawOutput: result.finalOutput ?? "",
    savedOutputPath: result.savedOutputPath,
    outputPath: result.savedOutputPath,
  }
}

async function loadCompatModules(): Promise<CompatModules> {
  // Use jiti for this fallback because Node's built-in type stripping refuses
  // to load TypeScript files from node_modules, while Pi packages are shipped
  // as TypeScript source.
  async function importJiti(): Promise<{ createJiti: typeof import("jiti").createJiti }> {
    try {
      return await import("jiti")
    } catch {
      return await import(path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "jiti", "lib", "jiti.mjs"))
    }
  }

  const { createJiti } = await importJiti()
  const jiti = createJiti(import.meta.url, { interopDefault: true })

  async function importPiSubagentsInternal(relativePath: string): Promise<unknown> {
    const packageSpecifier = `pi-subagents/${relativePath}`
    try {
      return await jiti.import(packageSpecifier)
    } catch (specifierErr) {
      const candidates = [
        path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "pi-subagents", relativePath),
      ]
      for (const candidate of candidates) {
        try {
          return await jiti.import(candidate)
        } catch {
          // Try the next known install location.
        }
      }
      throw specifierErr
    }
  }

  const [agentsModule, executionModule, worktreeModule] = await Promise.all([
    importPiSubagentsInternal("src/agents/agents.ts"),
    importPiSubagentsInternal("src/runs/foreground/execution.ts"),
    importPiSubagentsInternal("src/runs/shared/worktree.ts"),
  ])
  const modules = {
    discoverAgents: (agentsModule as { discoverAgents?: unknown }).discoverAgents,
    runSync: (executionModule as { runSync?: unknown }).runSync,
    createWorktrees: (worktreeModule as { createWorktrees?: unknown }).createWorktrees,
    diffWorktrees: (worktreeModule as { diffWorktrees?: unknown }).diffWorktrees,
    cleanupWorktrees: (worktreeModule as { cleanupWorktrees?: unknown }).cleanupWorktrees,
  }
  for (const [name, value] of Object.entries(modules)) {
    if (typeof value !== "function") {
      throw new Error(`installed pi-subagents is missing required internal export: ${name}`)
    }
  }
  return modules as CompatModules
}

async function createCompatZflowDispatchService(): Promise<BackendDispatchService> {
  const modules = await loadCompatModules()

  function resolveAgents(cwd: string): { agents: unknown[]; error?: string } {
    try {
      const result = modules.discoverAgents(cwd, "both")
      if (result.agents.length === 0) return { agents: [], error: "No agents discovered" }
      return { agents: result.agents }
    } catch (err) {
      return {
        agents: [],
        error: `Agent discovery failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  const runAgent = async (input: Parameters<BackendDispatchService["runAgent"]>[0]) => {
    const cwd = safeGetCwd(input.cwd)
    const { agents, error: discoveryError } = resolveAgents(cwd)
    if (discoveryError || agents.length === 0) {
      return { ok: false, exitCode: 1, error: discoveryError ?? "No agents discovered", rawOutput: "" }
    }
    const agent = findAgent(agents, input.agent)
    if (!agent) {
      const available = agents.map((a) => (a as { name?: unknown }).name).filter(Boolean).join(", ")
      return { ok: false, exitCode: 1, error: `Unknown agent "${input.agent}". Available: ${available}`, rawOutput: "" }
    }
    const result = await modules.runSync(cwd, agents, agent.name, input.task, {
      runId: generateRunId(),
      cwd,
      modelOverride: input.model,
      outputPath: input.output === false ? undefined : (typeof input.output === "string" ? input.output : undefined),
      outputMode: input.outputMode === "file-only" ? "file-only" : undefined,
      maxOutput: input.maxOutput,
      onUpdate: forwardCompatProgress(agent.name, input.onUpdate),
    })
    return mapCompatSingleResult(result)
  }

  const runParallel = async (input: Parameters<BackendDispatchService["runParallel"]>[0]) => {
    if (input.tasks.length === 0) return { ok: false, results: [] }
    const cwd = safeGetCwd(input.cwd)
    const { agents, error: discoveryError } = resolveAgents(cwd)
    if (discoveryError || agents.length === 0) {
      return {
        ok: false,
        results: input.tasks.map((task) => ({ agent: task.agent, ok: false, error: discoveryError ?? "No agents discovered", rawOutput: "" })),
      }
    }
    for (const task of input.tasks) {
      if (!findAgent(agents, task.agent)) {
        const available = agents.map((a) => (a as { name?: unknown }).name).filter(Boolean).join(", ")
        return {
          ok: false,
          results: input.tasks.map((t) => ({
            agent: t.agent,
            ok: false,
            error: t.agent === task.agent
              ? `Unknown agent "${task.agent}". Available: ${available}`
              : `Sibling task failed before start due to unknown agent "${task.agent}"`,
            rawOutput: "",
          })),
        }
      }
    }

    if (input.worktree) {
      return runParallelWithCompatWorktrees(cwd, input, agents, modules)
    }
    return runParallelCompatConcurrent(cwd, input, agents, modules)
  }

  return {
    name: "pi-subagents-compat:operational",
    runAgent,
    runParallel,
  }
}

async function runParallelWithCompatWorktrees(
  cwd: string,
  input: Parameters<BackendDispatchService["runParallel"]>[0],
  agents: unknown[],
  modules: CompatModules,
): Promise<Awaited<ReturnType<BackendDispatchService["runParallel"]>>> {
  const runId = generateRunId()
  const count = input.tasks.length
  let worktreeSetup: unknown | undefined
  try {
    worktreeSetup = modules.createWorktrees(cwd, runId, count, { agents: input.tasks.map((task) => task.agent) })
    const setup = worktreeSetup as { worktrees: Array<{ agentCwd: string }> }
    const concurrencyLimit = Math.max(1, Math.min(input.concurrency ?? count, count))
    const runQueue = input.tasks.map((task, index) => async () => {
      const agentCwd = setup.worktrees[index]!.agentCwd
      // Emit starting progress before the agent run so the UI transitions
      // from "queued" to "running" immediately, even before runSync emits
      // its first progress event.
      task.onUpdate?.({
        agent: task.agent,
        status: "running",
        recentOutput: ["starting worktree dispatch..."],
        lastActivityAt: Date.now(),
      })
      // Run worktree setup command if provided (e.g. pnpm install --frozen-lockfile)
      const worktreeSetupCommand = (task as { worktreeSetupCommand?: string }).worktreeSetupCommand
      if (worktreeSetupCommand && worktreeSetupCommand.trim()) {
        try {
          const { execFileSync } = await import("node:child_process")
          execFileSync("bash", ["-c", worktreeSetupCommand.trim()], {
            cwd: agentCwd,
            stdio: "pipe",
            timeout: 120_000,
          })
        } catch (setupErr: unknown) {
          const setupError = setupErr as { stderr?: Buffer; message?: string }
          return {
            agent: task.agent,
            ok: false,
            error: `Worktree setup failed: ${setupError.stderr?.toString().trim() || setupError.message || "unknown error"}`,
            rawOutput: "",
          }
        }
      }

      try {
        const resolvedAgent = findAgent(agents, task.agent)!
        const result = await modules.runSync(agentCwd, agents, resolvedAgent.name, task.task, {
          runId: `${runId}-${index}`,
          cwd: agentCwd,
          modelOverride: task.model,
          outputPath: task.output === false ? undefined : (typeof task.output === "string" ? task.output : undefined),
          outputMode: task.outputMode === "file-only" ? "file-only" : undefined,
          maxOutput: task.maxOutput,
          onUpdate: forwardCompatProgress(task.agent, task.onUpdate),
        })

        // Run scoped verification if specified
        const scopedVerification = (task as { scopedVerification?: string }).scopedVerification
        let verificationResult: {
          status: "pass" | "fail" | "skipped"
          command?: string
          output?: string
        } | undefined

        if (scopedVerification && scopedVerification.trim()) {
          try {
            const { execFileSync } = await import("node:child_process")
            const verOut = execFileSync("bash", ["-c", scopedVerification.trim()], {
              cwd: agentCwd,
              encoding: "utf-8",
              maxBuffer: 50 * 1024,   // 50KB
              timeout: 300_000,        // 5 minutes
            })
            verificationResult = {
              status: "pass",
              command: scopedVerification.trim(),
              output: verOut.substring(0, 50 * 1024),
            }
          } catch (verErr: unknown) {
            const execErr = verErr as {
              stdout?: Buffer | string
              stderr?: Buffer | string
              status?: number
              message?: string
            }
            const parts: string[] = []
            if (execErr.stdout) parts.push(execErr.stdout.toString().trim())
            if (execErr.stderr) parts.push(execErr.stderr.toString().trim())
            if (!parts.length && execErr.message) parts.push(execErr.message)
            const verOutput = parts.join("\n---stderr---\n").substring(0, 50 * 1024)
            verificationResult = {
              status: "fail",
              command: scopedVerification.trim(),
              output: verOutput,
            }
          }
        }

        return {
          agent: task.agent,
          ok: result.exitCode === 0 && !result.error,
          error: result.error,
          rawOutput: result.finalOutput ?? "",
          savedOutputPath: result.savedOutputPath,
          outputPath: result.savedOutputPath,
          verification: verificationResult,
        }
      } catch (err) {
        return {
          agent: task.agent,
          ok: false,
          error: `Worktree dispatch error: ${err instanceof Error ? err.message : String(err)}`,
          rawOutput: "",
        }
      }
    })

    const taskResults: Awaited<ReturnType<BackendDispatchService["runParallel"]>>["results"] =
      await runTasksWithRollingConcurrency(runQueue, concurrencyLimit)

    const diffsDir = `${cwd}/.zflow/worktree-diffs/${runId}`
    try {
      fs.mkdirSync(diffsDir, { recursive: true })
      const diffs = modules.diffWorktrees(worktreeSetup, input.tasks.map((task) => task.agent), diffsDir)
      for (const diff of diffs) {
        if (diff.index < taskResults.length) taskResults[diff.index]!.patchPath = diff.patchPath
      }
    } catch {
      // Best-effort diff capture.
    }

    return { ok: taskResults.every((result) => result.ok), results: taskResults }
  } finally {
    if (worktreeSetup) {
      try {
        modules.cleanupWorktrees(worktreeSetup)
      } catch {
        // Best-effort cleanup.
      }
    }
  }
}

async function runParallelCompatConcurrent(
  cwd: string,
  input: Parameters<BackendDispatchService["runParallel"]>[0],
  agents: unknown[],
  modules: CompatModules,
): Promise<Awaited<ReturnType<BackendDispatchService["runParallel"]>>> {
  const concurrencyLimit = Math.max(1, Math.min(input.concurrency ?? input.tasks.length, input.tasks.length))
  const runQueue = input.tasks.map((task) => async () => {
    // Emit starting progress so the UI shows "running" immediately.
    task.onUpdate?.({
      agent: task.agent,
      status: "running",
      recentOutput: ["starting dispatch..."],
      lastActivityAt: Date.now(),
    })
    try {
      const resolvedAgent = findAgent(agents, task.agent)!
      const result = await modules.runSync(task.cwd ?? cwd, agents, resolvedAgent.name, task.task, {
        runId: generateRunId(),
        cwd: task.cwd ?? cwd,
        modelOverride: task.model,
        outputPath: task.output === false ? undefined : (typeof task.output === "string" ? task.output : undefined),
        outputMode: task.outputMode === "file-only" ? "file-only" : undefined,
        maxOutput: task.maxOutput,
        onUpdate: forwardCompatProgress(task.agent, task.onUpdate),
      })
      return {
        agent: task.agent,
        ...mapCompatSingleResult(result),
      }
    } catch (err) {
      return {
        agent: task.agent,
        ok: false,
        error: `Dispatch error: ${err instanceof Error ? err.message : String(err)}`,
        rawOutput: "",
      }
    }
  })
  const results = await runTasksWithRollingConcurrency(runQueue, concurrencyLimit)
  return { ok: results.every((result) => result.ok), results }
}

// ── Activation ─────────────────────────────────────────────────────

/**
 * Activate the pi-zflow-subagents-bridge extension.
 *
 * Attempts to load the pi-subagents-zflow backend.  On success the
 * registry receives an operational DispatchService; otherwise a
 * diagnostic unavailable service.
 *
 * @param pi - Pi extension API (unused — kept for interface compatibility).
 */
export default async function activateZflowSubagentsBridgeExtension(_pi: ExtensionAPI): Promise<void> {
  const registry = getZflowRegistry()

  // ── Capability claim ────────────────────────────────────────────
  const claim: CapabilityClaim = {
    capability: DISPATCH_SERVICE_CAPABILITY,
    version: PI_ZFLOW_SUBAGENTS_BRIDGE_VERSION,
    provider: "pi-zflow-subagents-bridge",
    sourcePath: import.meta.url,
    compatibilityMode: "compatible",
  }

  const registered = registry.claim(claim)
  if (!registered) {
    // Another incompatible provider already claimed this capability
    return
  }

  // If the capability already has a service, another compatible
  // instance already initialised fully. No-op to avoid running twice.
  if (registered.service !== undefined) {
    return
  }

  // ── Provide the service ─────────────────────────────────────────

  let service: DispatchService

  // Prefer the fork-provided backend when available. Pi git installs may load
  // this package without its npm dependencies, so fall back to a compatibility
  // backend built from the installed pi-subagents internals before reporting
  // dispatch as unavailable.
  try {
    const { createZflowDispatchService } = await import("pi-subagents/zflow-bridge")
    const backend = createZflowDispatchService()
    service = new SubagentsDispatchService(backend)
  } catch (forkErr) {
    try {
      const backend = await createCompatZflowDispatchService()
      service = new SubagentsDispatchService(backend)
    } catch (compatErr) {
      service = new UnavailableDispatchService(
        `fork import failed: ${forkErr instanceof Error ? forkErr.message : String(forkErr)}; ` +
        `compat import failed: ${compatErr instanceof Error ? compatErr.message : String(compatErr)}`,
      )
    }
  }

  registry.provide(DISPATCH_SERVICE_CAPABILITY, service)
}
