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
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { getZflowRegistry } from "pi-zflow-core/registry"
import type { CapabilityClaim } from "pi-zflow-core/registry"
import {
  DISPATCH_SERVICE_CAPABILITY,
  LEGACY_DISPATCH_CAPABILITIES,
  type DispatchCapabilities,
  type DispatchService,
  type AgentDispatchInput,
  type AgentDispatchResult,
  type ParallelDispatchInput,
  type ParallelDispatchResult,
  type ParallelTaskInput,
  type ParallelTaskResult,
  type DispatchWorktreeSetupHook,
  type TaskWorktreeStrategy,
} from "pi-zflow-core/dispatch-service"
import {
  ACTIVE_PROFILE_PATH,
  PI_ZFLOW_SUBAGENTS_BRIDGE_VERSION,
  inferTaskRepoRoot,
  runWorktreeSetupHook,
  runAgentWithRateLimitRetries,
  type WorktreeSetupHookConfig,
} from "pi-zflow-core"

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
  readonly capabilities: DispatchCapabilities = {
    ...LEGACY_DISPATCH_CAPABILITIES,
    isolatedWorktrees: false,
  }
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

  async listAgents(): Promise<Array<string | { name?: string }>> {
    return []
  }
}

// ── Operational backend (wraps pi-subagents-zflow) ────────────────

type BackendVerification = NonNullable<ParallelTaskResult["verification"]>

type BackendParallelTaskInput = {
  agent: string
  groupId?: string
  task: string
  cwd?: string
  model?: string
  output?: string | false
  outputMode?: "inline" | "file-only"
  maxOutput?: { lines?: number; bytes?: number }
  onUpdate?: (progress: unknown) => void
  scopedVerification?: string
  worktreeSetupCommand?: string | null
  claimedFiles?: string[]
  dependencies?: string[]
  worktreeStrategy?: TaskWorktreeStrategy
}

interface BackendDispatchService {
  readonly name?: string
  readonly capabilities?: Partial<DispatchCapabilities>
  listAgents?(cwd?: string): Promise<Array<string | { name?: string }>>
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
    attemptedModels?: string[]
    modelAttempts?: Array<{
      model: string
      success: boolean
      exitCode?: number | null
      error?: string
    }>
  }>
  runParallel(input: {
    tasks: BackendParallelTaskInput[]
    cwd?: string
    concurrency?: number
    worktree?: boolean
    worktreeSetupHook?: DispatchWorktreeSetupHook
    maxOutput?: { lines?: number; bytes?: number }
  }): Promise<{
    ok: boolean
    results: Array<{
      agent: string
      groupId?: string
      ok: boolean
      error?: string
      rawOutput: string
      outputPath?: string
      savedOutputPath?: string
      worktreePath?: string
      workspaceId?: string
      baseCommit?: string
      headCommit?: string
      patchPath?: string
      changedFiles?: string[]
      verification?: BackendVerification
    }>
  }>
}

function normalizeBackendCapabilities(
  capabilities?: Partial<DispatchCapabilities>,
): DispatchCapabilities {
  return {
    ...LEGACY_DISPATCH_CAPABILITIES,
    ...(capabilities ?? {}),
  }
}

function requiresSharedSerialized(task: ParallelTaskInput): boolean {
  return task.worktreeStrategy?.mode === "shared-staging" &&
    (task.worktreeStrategy.workspaceConcurrency ?? "serialized") === "serialized"
}

function requiresSharedConcurrent(task: ParallelTaskInput): boolean {
  return task.worktreeStrategy?.mode === "shared-staging" &&
    (task.worktreeStrategy.workspaceConcurrency ?? "serialized") === "concurrent"
}

function requiresBaseRef(task: ParallelTaskInput): boolean {
  return Boolean(task.worktreeStrategy?.baseRef) || task.worktreeStrategy?.baseStrategy === "dependency-lineage"
}

function describeMissingCapabilities(
  input: ParallelDispatchInput,
  capabilities: DispatchCapabilities,
): string | null {
  if (input.worktreeSetupHook && !capabilities.worktreeSetupHooks) {
    return "worktree setup hooks"
  }
  if (input.tasks.some(requiresSharedConcurrent) && !capabilities.sharedWorkspaceConcurrent) {
    return "shared concurrent worktree clusters"
  }
  if (input.tasks.some(requiresSharedSerialized) && !capabilities.sharedWorkspaceSerialized) {
    return "shared serialized worktree clusters"
  }
  if (input.tasks.some(requiresBaseRef) && !capabilities.baseRefWorktrees) {
    return "dependency-lineage/base-ref worktrees"
  }
  return null
}

function requiresCompatWorktreeTaskCwds(input: ParallelDispatchInput): boolean {
  if (!input.worktree) return false
  const sharedCwd = safeGetCwd(input.cwd)
  return input.tasks.some((task) => {
    if (!task.cwd) return false
    const taskCwd = path.isAbsolute(task.cwd)
      ? task.cwd
      : path.resolve(sharedCwd, task.cwd)
    return path.resolve(taskCwd) !== path.resolve(sharedCwd)
  })
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
  readonly capabilities: DispatchCapabilities
  private backend: BackendDispatchService
  private advancedFallback?: BackendDispatchService
  private primaryCapabilities: DispatchCapabilities
  private fallbackCapabilities?: DispatchCapabilities

  constructor(
    backend: BackendDispatchService,
    options?: { fallback?: BackendDispatchService; capabilities?: Partial<DispatchCapabilities> },
  ) {
    this.backend = backend
    this.advancedFallback = options?.fallback
    const primaryCapabilities = normalizeBackendCapabilities(options?.capabilities ?? backend.capabilities)
    const fallbackCapabilities = options?.fallback
      ? normalizeBackendCapabilities(options.fallback.capabilities)
      : undefined
    this.primaryCapabilities = primaryCapabilities
    this.fallbackCapabilities = fallbackCapabilities
    this.capabilities = fallbackCapabilities
      ? {
          isolatedWorktrees: primaryCapabilities.isolatedWorktrees || fallbackCapabilities.isolatedWorktrees,
          sharedWorkspaceSerialized: primaryCapabilities.sharedWorkspaceSerialized || fallbackCapabilities.sharedWorkspaceSerialized,
          sharedWorkspaceConcurrent: primaryCapabilities.sharedWorkspaceConcurrent || fallbackCapabilities.sharedWorkspaceConcurrent,
          baseRefWorktrees: primaryCapabilities.baseRefWorktrees || fallbackCapabilities.baseRefWorktrees,
          worktreeSetupHooks: primaryCapabilities.worktreeSetupHooks || fallbackCapabilities.worktreeSetupHooks,
        }
      : primaryCapabilities
    this.name = `pi-zflow-subagents-bridge:${backend.name ?? "operational"}`
  }

  async runAgent(input: AgentDispatchInput): Promise<AgentDispatchResult> {
    try {
      // Prefer the compat backend for single-agent runs when available because
      // it preserves model-attempt details from pi-subagents foreground
      // execution. That lets zflow surface provider 429 usage-limit failures
      // instead of a later placeholder fallback error.
      const backend = this.advancedFallback ?? this.backend
      const runWithModel = async (modelOverride: string | undefined) => runAgentWithRateLimitRetries({
        dispatchService: {
          name: this.name,
          runAgent: async (dispatchInput) => {
            const backendResult = await backend.runAgent({
              agent: dispatchInput.agent,
              task: dispatchInput.task,
              cwd: dispatchInput.cwd,
              model: dispatchInput.model,
              output: dispatchInput.output,
              outputMode: dispatchInput.outputMode,
              maxOutput: dispatchInput.maxOutput,
              onUpdate: dispatchInput.onUpdate,
            })
            return {
              ok: backendResult.ok,
              rawOutput: backendResult.rawOutput,
              outputPath: backendResult.outputPath ?? backendResult.savedOutputPath,
              error: resolveMeaningfulSingleError(backendResult),
            }
          },
          runParallel: async () => ({ ok: false, results: [] }),
        },
        input: {
          ...input,
          ...(modelOverride ? { model: modelOverride } : {}),
        },
        onRateLimitNotice: async (notice) => {
          input.onUpdate?.({
            agent: input.agent,
            status: "running",
            lastActivityAt: Date.now(),
            recentOutput: [notice.message],
          })
        },
      })

      let result = await runWithModel(input.model)
      if (!result.ok && isUnsupportedDeveloperRoleDispatchError(result.error)) {
        const fallbackModels = await loadAgentFallbackModelCandidates(input.agent, input.model)
        for (const fallbackModel of fallbackModels) {
          input.onUpdate?.({
            agent: input.agent,
            status: "running",
            lastActivityAt: Date.now(),
            recentOutput: [
              `⚠️ Agent ${input.agent} hit a provider compatibility error on model ${input.model ?? "(default)"}. Retrying with fallback model ${fallbackModel}.`,
            ],
          })
          const fallbackResult = await runWithModel(fallbackModel)
          if (fallbackResult.ok) {
            await persistAgentFallbackModel(input.agent, fallbackModel).catch(() => {})
            result = fallbackResult
            break
          }
          result = fallbackResult
          if (!isUnsupportedDeveloperRoleDispatchError(fallbackResult.error)) {
            break
          }
        }
      }

      return {
        ok: result.ok,
        rawOutput: result.rawOutput,
        outputPath: result.outputPath,
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

  async listAgents(cwd?: string): Promise<Array<string | { name?: string }>> {
    if (typeof this.advancedFallback?.listAgents === "function") {
      return this.advancedFallback.listAgents(cwd)
    }
    if (typeof this.backend.listAgents === "function") {
      return this.backend.listAgents(cwd)
    }
    return []
  }

  async runParallel(input: ParallelDispatchInput): Promise<ParallelDispatchResult> {
    if (this.advancedFallback && requiresCompatWorktreeTaskCwds(input)) {
      return this.invokeParallel(this.advancedFallback, input)
    }

    const requestedUnsupported = describeMissingCapabilities(input, this.primaryCapabilities)
    if (requestedUnsupported) {
      if (this.advancedFallback) {
        const stillUnsupported = describeMissingCapabilities(
          input,
          this.fallbackCapabilities ?? normalizeBackendCapabilities(this.advancedFallback.capabilities),
        )
        if (!stillUnsupported) {
          return this.invokeParallel(this.advancedFallback, input)
        }
      }

      return {
        ok: false,
        results: input.tasks.map((t) => ({
          agent: t.agent,
          groupId: t.groupId,
          rawOutput: "",
          ok: false,
          error: `Dispatch backend does not support ${requestedUnsupported}. ` +
            `Supported by active backend: isolated=${this.capabilities.isolatedWorktrees}, ` +
            `shared-serialized=${this.capabilities.sharedWorkspaceSerialized}, ` +
            `shared-concurrent=${this.capabilities.sharedWorkspaceConcurrent}, ` +
            `base-ref=${this.capabilities.baseRefWorktrees}, hooks=${this.capabilities.worktreeSetupHooks}.`,
        })),
      }
    }

    return this.invokeParallel(this.backend, input)
  }

  private async invokeParallel(
    backend: BackendDispatchService,
    input: ParallelDispatchInput,
  ): Promise<ParallelDispatchResult> {
    try {
      const result = await backend.runParallel({
        tasks: input.tasks.map((t) => ({
          agent: t.agent,
          groupId: t.groupId,
          task: t.task,
          cwd: t.cwd,
          model: t.model,
          output: t.output,
          outputMode: t.outputMode,
          maxOutput: input.maxOutput,
          onUpdate: t.onUpdate,
          scopedVerification: t.scopedVerification,
          worktreeSetupCommand: t.worktreeSetupCommand,
          claimedFiles: t.claimedFiles,
          dependencies: t.dependencies,
          worktreeStrategy: t.worktreeStrategy,
        })),
        cwd: input.cwd,
        concurrency: input.concurrency,
        worktree: input.worktree,
        worktreeSetupHook: input.worktreeSetupHook,
        maxOutput: input.maxOutput,
      })
      return {
        ok: result.ok,
        results: result.results.map((r, index) => ({
          agent: r.agent,
          groupId: r.groupId ?? input.tasks[index]?.groupId,
          rawOutput: r.rawOutput,
          outputPath: r.outputPath ?? r.savedOutputPath,
          ok: r.ok,
          error: r.error,
          worktreePath: r.worktreePath,
          workspaceId: r.workspaceId,
          baseCommit: r.baseCommit,
          headCommit: r.headCommit,
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
          groupId: t.groupId,
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
  model?: string
  attemptedModels?: string[]
  modelAttempts?: Array<{
    model: string
    success: boolean
    exitCode?: number | null
    error?: string
  }>
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

interface CompatWorktreeInfo {
  path: string
  agentCwd: string
  branch: string
  index: number
  syntheticPaths?: string[]
}

interface CompatWorktreeSetup {
  cwd: string
  baseCommit: string
  worktrees: CompatWorktreeInfo[]
}

interface CompatModules {
  discoverAgents: (cwd: string, scope?: "user" | "project" | "both") => { agents: unknown[] }
  runSync: (runtimeCwd: string, agents: unknown[], agentName: string, task: string, options: CompatRunSyncOptions) => Promise<CompatSingleResult>
  createWorktrees: (cwd: string, runId: string, count: number, options?: { agents?: string[] }) => CompatWorktreeSetup
  diffWorktrees: (setup: CompatWorktreeSetup, agents: string[], diffsDir: string) => Array<{ index: number; patchPath: string; filesChanged: number }>
  cleanupWorktrees: (setup: CompatWorktreeSetup) => void
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

function normalizeWorktreeStrategy(
  strategy?: TaskWorktreeStrategy,
): Required<Pick<TaskWorktreeStrategy, "mode" | "workspaceConcurrency" | "baseStrategy">> & Omit<TaskWorktreeStrategy, "mode" | "workspaceConcurrency" | "baseStrategy"> {
  return {
    mode: strategy?.mode ?? "isolated",
    workspaceConcurrency: strategy?.workspaceConcurrency ?? "serialized",
    baseStrategy: strategy?.baseStrategy ?? "head",
    workspaceId: strategy?.workspaceId,
    baseRef: strategy?.baseRef,
    executionRationale: strategy?.executionRationale,
  }
}

/** Preserve exact bytes from git commands (needed for patch content). */
function gitOutputRaw(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
  })
}

/** Trimmed variant for commands where trailing whitespace is harmless (rev-parse, --name-only). */
function gitOutputTrimmed(cwd: string, args: string[]): string {
  return gitOutputRaw(cwd, args).trimEnd()
}

function gitOutputSafeRaw(cwd: string, args: string[]): string {
  try {
    return gitOutputRaw(cwd, args)
  } catch {
    return ""
  }
}

function gitOutputSafeTrimmed(cwd: string, args: string[]): string {
  try {
    return gitOutputTrimmed(cwd, args)
  } catch {
    return ""
  }
}

function resetWorktreeToBaseRef(worktreePath: string, baseRef: string): string {
  execFileSync("git", ["reset", "--hard", baseRef], {
    cwd: worktreePath,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
  })
  return gitOutputTrimmed(worktreePath, ["rev-parse", "HEAD"])
}

/**
 * Validate a patch file by attempting to apply it against a base commit's tree.
 * Uses a temporary index to avoid modifying the actual working tree or index.
 * Throws if the patch is structurally invalid.
 */
function validatePatchFile(worktreePath: string, patchPath: string, baseRef: string): void {
  const tmpIndex = path.join(os.tmpdir(), `zflow-validate-${crypto.randomUUID()}`)
  try {
    execFileSync("git", ["read-tree", "--reset", baseRef], {
      cwd: worktreePath,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_INDEX_FILE: tmpIndex },
      maxBuffer: 10 * 1024 * 1024,
    })
    execFileSync("git", ["apply", "--cached", "--check", "--binary", patchPath], {
      cwd: worktreePath,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_INDEX_FILE: tmpIndex },
      maxBuffer: 10 * 1024 * 1024,
    })
  } catch (err: unknown) {
    const execErr = err as { stderr?: Buffer | string; status?: number; message?: string }
    const stderr = execErr.stderr ? String(execErr.stderr) : execErr.message ?? "unknown error"
    throw new Error(
      `Bridge produced invalid patch artifact at ${patchPath}: git apply --check failed.\n` +
      `Stderr: ${stderr.trimEnd()}\n` +
      `This indicates the bridge generated a malformed patch.`,
    )
  } finally {
    try { fs.unlinkSync(tmpIndex) } catch { /* cleanup errors ignored */ }
  }
}

function writePatchFromRange(worktreePath: string, patchPath: string, baseRef: string): { changedFiles: string[]; headCommit: string } {
  const headCommit = gitOutputTrimmed(worktreePath, ["rev-parse", "HEAD"])
  const patch = gitOutputSafeRaw(worktreePath, ["diff", "--binary", baseRef, "HEAD"])
  fs.mkdirSync(path.dirname(patchPath), { recursive: true })
  fs.writeFileSync(patchPath, patch ? `${patch}${patch.endsWith("\n") ? "" : "\n"}` : "", "utf-8")
  if (patch && patch.trim()) {
    validatePatchFile(worktreePath, patchPath, baseRef)
  }
  const changedFilesOut = gitOutputSafeTrimmed(worktreePath, ["diff", "--name-only", baseRef, "HEAD"])
  const changedFiles = changedFilesOut ? changedFilesOut.split("\n").filter(Boolean) : []
  return { changedFiles, headCommit }
}

function checkpointSharedWorkspace(worktreePath: string, message: string): string {
  execFileSync("git", ["add", "-A"], {
    cwd: worktreePath,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
  })
  execFileSync("git", ["commit", "--allow-empty", "-m", message], {
    cwd: worktreePath,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
  })
  return gitOutputTrimmed(worktreePath, ["rev-parse", "HEAD"])
}

async function maybeRunCompatWorktreeSetupHook(
  hookConfig: DispatchWorktreeSetupHook | undefined,
  repoRoot: string,
  worktree: CompatWorktreeInfo,
  runId: string,
  agent: string | undefined,
  baseCommit: string,
): Promise<void> {
  if (!hookConfig) return
  const result = await runWorktreeSetupHook(hookConfig as WorktreeSetupHookConfig, {
    worktreeRoot: worktree.path,
    repoRoot,
    ref: worktree.branch,
    meta: {
      runId,
      agent: agent ?? "unknown",
      index: String(worktree.index),
      baseCommit,
    },
  })
  if (!result.success) {
    throw new Error(result.message)
  }
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

function isUsageLimitError(error: string | undefined): boolean {
  if (!error) return false
  return /\b429\b/i.test(error) ||
    /usage limit reached/i.test(error) ||
    /rate limit/i.test(error)
}

function extractUsageLimitWaitTime(error: string | undefined): string | undefined {
  if (!error) return undefined
  const patterns = [
    /resets?\s+in\s+([^.!?\n]+)/i,
    /retry(?:ing)?\s+after\s+([^.!?\n]+)/i,
    /retry(?:ing)?\s+in\s+([^.!?\n]+)/i,
    /try again in\s+([^.!?\n]+)/i,
    /wait\s+([^.!?\n]+?)\s+before/i,
  ]
  for (const pattern of patterns) {
    const match = error.match(pattern)
    const wait = match?.[1]?.trim()
    if (wait) return wait
  }
  return undefined
}

function resolveMeaningfulSingleError(result: {
  error?: string
  modelAttempts?: Array<{
    model: string
    success: boolean
    exitCode?: number | null
    error?: string
  }>
}): string | undefined {
  const usageLimitAttempt = result.modelAttempts?.find((attempt) => !attempt.success && isUsageLimitError(attempt.error))
  if (!usageLimitAttempt) return result.error

  const providerMessage = usageLimitAttempt.error?.trim() ?? "429 usage limit reached."
  const waitTime = extractUsageLimitWaitTime(providerMessage)
  const modelLabel = usageLimitAttempt.model ? ` for model \"${usageLimitAttempt.model}\"` : ""
  if (waitTime) {
    return `429 usage limit reached${modelLabel}. Wait time: ${waitTime}. Provider message: ${providerMessage}`
  }
  return `429 usage limit reached${modelLabel}. Provider message: ${providerMessage}`
}

const THINKING_SUFFIX_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"])

function stripKnownThinkingSuffix(model: string | undefined): string | undefined {
  if (!model) return undefined
  const trimmed = model.trim()
  const colonIdx = trimmed.lastIndexOf(":")
  if (colonIdx === -1) return trimmed
  const suffix = trimmed.slice(colonIdx + 1).toLowerCase()
  if (!THINKING_SUFFIX_LEVELS.has(suffix)) return trimmed
  return trimmed.slice(0, colonIdx)
}

function isUnsupportedDeveloperRoleDispatchError(error: string | undefined): boolean {
  if (!error) return false
  return /messages?[^\n]*role/i.test(error) &&
    /input should be 'system', 'user', 'assistant' or 'tool'/i.test(error) &&
    /developer/i.test(error)
}

function resolveAgentFallbackModelCandidates(
  activeProfileCache: {
    profileName?: string
    agentBindings?: Record<string, { lane?: string; resolvedModel?: string }>
  } | null | undefined,
  profileDoc: Record<string, { lanes?: Record<string, { preferredModels?: string[] }> }> | null | undefined,
  agentName: string,
  currentModel?: string,
): string[] {
  const binding = activeProfileCache?.agentBindings?.[agentName]
  const laneName = binding?.lane
  const profileName = activeProfileCache?.profileName
  if (!laneName || !profileName) return []

  const preferredModels = profileDoc?.[profileName]?.lanes?.[laneName]?.preferredModels
  if (!Array.isArray(preferredModels) || preferredModels.length === 0) return []

  const normalizedCurrent = stripKnownThinkingSuffix(currentModel ?? binding?.resolvedModel)
  const normalizedPreferred = preferredModels.map((model) => stripKnownThinkingSuffix(model) ?? model)
  const currentIdx = normalizedCurrent ? normalizedPreferred.findIndex((model) => model === normalizedCurrent) : -1
  const tail = currentIdx >= 0 ? preferredModels.slice(currentIdx + 1) : preferredModels
  return [...new Set(tail.filter((model) => stripKnownThinkingSuffix(model) !== normalizedCurrent))]
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8")
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

async function loadAgentFallbackModelCandidates(agentName: string, currentModel?: string): Promise<string[]> {
  const activeProfile = await readJsonFile<{
    profileName?: string
    sourcePath?: string
    agentBindings?: Record<string, { lane?: string; resolvedModel?: string }>
  }>(ACTIVE_PROFILE_PATH)
  if (!activeProfile?.sourcePath) return []
  const profileDoc = await readJsonFile<Record<string, { lanes?: Record<string, { preferredModels?: string[] }> }>>(activeProfile.sourcePath)
  return resolveAgentFallbackModelCandidates(activeProfile, profileDoc, agentName, currentModel)
}

async function persistAgentFallbackModel(agentName: string, successfulModel: string): Promise<void> {
  const activeProfile = await readJsonFile<{
    profileName?: string
    sourcePath?: string
    resolvedAt?: string
    agentBindings?: Record<string, { lane?: string; resolvedModel?: string }>
    resolvedLanes?: Record<string, { model?: string; reason?: string }>
  }>(ACTIVE_PROFILE_PATH)
  if (!activeProfile?.agentBindings || !activeProfile.resolvedLanes) return

  const binding = activeProfile.agentBindings[agentName]
  const laneName = binding?.lane
  if (!binding || !laneName || !activeProfile.resolvedLanes[laneName]) return

  const previousModel = binding.resolvedModel ?? activeProfile.resolvedLanes[laneName]?.model ?? "unknown"
  for (const candidateBinding of Object.values(activeProfile.agentBindings)) {
    if (candidateBinding?.lane === laneName) {
      candidateBinding.resolvedModel = successfulModel
    }
  }
  activeProfile.resolvedLanes[laneName] = {
    ...activeProfile.resolvedLanes[laneName],
    model: successfulModel,
    reason: `Runtime fallback after provider rejected developer-role messages on \"${previousModel}\". Re-routed to \"${successfulModel}\".`,
  }
  activeProfile.resolvedAt = new Date().toISOString()

  const dir = path.dirname(ACTIVE_PROFILE_PATH)
  const tmpPath = path.join(dir, `.tmp-${Date.now().toString(36)}-active-profile.json`)
  await fs.promises.mkdir(dir, { recursive: true })
  await fs.promises.writeFile(tmpPath, JSON.stringify(activeProfile, null, 2), "utf-8")
  await fs.promises.rename(tmpPath, ACTIVE_PROFILE_PATH)
}

function mapCompatSingleResult(result: CompatSingleResult): {
  ok: boolean
  exitCode: number
  error?: string
  rawOutput: string
  outputPath?: string
  savedOutputPath?: string
  attemptedModels?: string[]
  modelAttempts?: Array<{
    model: string
    success: boolean
    exitCode?: number | null
    error?: string
  }>
} {
  return {
    ok: result.exitCode === 0 && !result.error,
    exitCode: result.exitCode,
    error: resolveMeaningfulSingleError(result),
    rawOutput: result.finalOutput ?? "",
    savedOutputPath: result.savedOutputPath,
    outputPath: result.savedOutputPath,
    attemptedModels: result.attemptedModels,
    modelAttempts: result.modelAttempts,
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

  const listAgents = async (cwd?: string) => {
    const resolvedCwd = safeGetCwd(cwd)
    const { agents } = resolveAgents(resolvedCwd)
    return agents
      .map((agent) => (agent as { name?: unknown }).name)
      .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
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
        results: input.tasks.map((task) => ({ agent: task.agent, groupId: task.groupId, ok: false, error: discoveryError ?? "No agents discovered", rawOutput: "" })),
      }
    }
    for (const task of input.tasks) {
      if (!findAgent(agents, task.agent)) {
        const available = agents.map((a) => (a as { name?: unknown }).name).filter(Boolean).join(", ")
        return {
          ok: false,
          results: input.tasks.map((t) => ({
            agent: t.agent,
            groupId: t.groupId,
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
    capabilities: {
      isolatedWorktrees: true,
      sharedWorkspaceSerialized: true,
      sharedWorkspaceConcurrent: false,
      baseRefWorktrees: true,
      worktreeSetupHooks: true,
    },
    listAgents,
    runAgent,
    runParallel,
  }
}

const COMPAT_EXCLUDED_STAGE_PATHS = ["node_modules", ".wrangler"]

interface CompatWorkspacePlan {
  workspaceId: string
  repoCwd: string
  mode: "isolated" | "shared-staging"
  workspaceConcurrency: "serialized" | "concurrent"
  baseRef?: string
  taskIndexes: number[]
}

function resolveCompatTaskRepoCwd(sharedCwd: string, task: BackendParallelTaskInput): string {
  return inferTaskRepoRoot(sharedCwd, {
    cwd: task.cwd,
    claimedFiles: task.claimedFiles,
  })
}

function buildCompatWorkspacePlans(sharedCwd: string, tasks: BackendParallelTaskInput[]): CompatWorkspacePlan[] {
  const plans = new Map<string, CompatWorkspacePlan>()

  for (let index = 0; index < tasks.length; index++) {
    const task = tasks[index]!
    const strategy = normalizeWorktreeStrategy(task.worktreeStrategy)
    if (strategy.mode === "shared-staging" && !strategy.workspaceId) {
      throw new Error(
        `Task ${task.groupId ?? index} requested shared-staging without a workspaceId.`,
      )
    }
    const repoCwd = resolveCompatTaskRepoCwd(sharedCwd, task)
    const workspaceId = strategy.mode === "shared-staging"
      ? strategy.workspaceId!
      : (task.groupId ?? `task-${index}`)
    const planKey = `${repoCwd}::${workspaceId}`

    const existing = plans.get(planKey)
    if (existing) {
      existing.taskIndexes.push(index)
      if (strategy.baseRef && existing.baseRef && existing.baseRef !== strategy.baseRef) {
        throw new Error(
          `Shared workspace \"${workspaceId}\" received conflicting base refs (${existing.baseRef} vs ${strategy.baseRef}). ` +
          `Shared workspaces must agree on a single base ref.`,
        )
      }
      if (strategy.baseRef && !existing.baseRef) existing.baseRef = strategy.baseRef
      continue
    }

    plans.set(planKey, {
      workspaceId,
      repoCwd,
      mode: strategy.mode,
      workspaceConcurrency: strategy.workspaceConcurrency,
      baseRef: strategy.baseRef,
      taskIndexes: [index],
    })
  }

  return [...plans.values()]
}

function topoSortWorkspaceTaskIndexes(
  tasks: BackendParallelTaskInput[],
  taskIndexes: number[],
): number[] {
  if (taskIndexes.length <= 1) return [...taskIndexes]
  const idToIndex = new Map<string, number>()
  for (const index of taskIndexes) {
    const groupId = tasks[index]?.groupId
    if (groupId) idToIndex.set(groupId, index)
  }

  const inDegree = new Map<number, number>()
  const adjacency = new Map<number, number[]>()
  for (const index of taskIndexes) {
    inDegree.set(index, 0)
    adjacency.set(index, [])
  }

  for (const index of taskIndexes) {
    const deps = tasks[index]?.dependencies ?? []
    for (const dep of deps) {
      const depIndex = idToIndex.get(dep)
      if (depIndex === undefined) continue
      adjacency.get(depIndex)?.push(index)
      inDegree.set(index, (inDegree.get(index) ?? 0) + 1)
    }
  }

  const ready = taskIndexes.filter((index) => (inDegree.get(index) ?? 0) === 0)
  const ordered: number[] = []
  while (ready.length > 0) {
    ready.sort((a, b) => a - b)
    const next = ready.shift()!
    ordered.push(next)
    for (const neighbor of adjacency.get(next) ?? []) {
      const degree = (inDegree.get(neighbor) ?? 1) - 1
      inDegree.set(neighbor, degree)
      if (degree === 0) ready.push(neighbor)
    }
  }

  return ordered.length === taskIndexes.length ? ordered : [...taskIndexes]
}

function stageAllCompatChanges(worktreePath: string): void {
  execFileSync("git", ["add", "-A"], {
    cwd: worktreePath,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
  })
  for (const excludedPath of COMPAT_EXCLUDED_STAGE_PATHS) {
    try {
      execFileSync("git", ["reset", "HEAD", "--", excludedPath], {
        cwd: worktreePath,
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 10 * 1024 * 1024,
      })
    } catch {
      // Ignore absent excluded paths.
    }
  }
}

function captureCompatPatchAgainstBase(
  worktreePath: string,
  baseCommit: string,
  patchPath: string,
): { changedFiles: string[]; headCommit: string } {
  stageAllCompatChanges(worktreePath)
  const patch = gitOutputSafeRaw(worktreePath, ["diff", "--cached", "--binary", baseCommit])
  fs.mkdirSync(path.dirname(patchPath), { recursive: true })
  fs.writeFileSync(patchPath, patch ? `${patch}${patch.endsWith("\n") ? "" : "\n"}` : "", "utf-8")
  if (patch && patch.trim()) {
    validatePatchFile(worktreePath, patchPath, baseCommit)
  }
  const changedFilesOut = gitOutputSafeTrimmed(worktreePath, ["diff", "--cached", "--name-only", baseCommit])
  const changedFiles = changedFilesOut ? changedFilesOut.split("\n").filter(Boolean) : []
  const headCommit = gitOutputTrimmed(worktreePath, ["rev-parse", "HEAD"])
  return { changedFiles, headCommit }
}

function looksLikeExecutableScopedVerificationLine(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false
  return /^(?:cd\s+|npm\s+|yarn\s+|pnpm\s+|npx\s+|node\s+|python\s+|python3\s+|pytest\b|make\s+|just\s+|cargo\s+|go\s+|bash\s+|sh\s+|git\s+|\.\/|\.\.\/|\/|[A-Za-z_][A-Za-z0-9_]*=)/.test(trimmed) ||
    trimmed.includes("&&") ||
    trimmed.includes("||")
}

function inferScopedVerificationRepoPrefix(claimedFiles?: string[]): string | undefined {
  if (!claimedFiles || claimedFiles.length === 0) return undefined
  const prefixes = claimedFiles
    .map((file) => file.split(/[\\/]+/).filter(Boolean)[0])
    .filter((prefix): prefix is string => Boolean(prefix))
  if (prefixes.length === 0) return undefined
  const [first] = prefixes
  if (!first) return undefined
  return prefixes.every((prefix) => prefix === first) ? first : undefined
}

function normalizeScopedVerificationLineForCwd(
  command: string,
  cwd: string,
  claimedFiles?: string[],
): string {
  const trimmed = command.trim()
  const cdMatch = trimmed.match(/^cd\s+([^;&]+?)\s*&&\s*(.+)$/)
  if (!cdMatch) return trimmed

  const rawTarget = cdMatch[1]!.trim().replace(/^['"]|['"]$/g, "").replace(/[\\/]+$/, "")
  const remainder = cdMatch[2]!.trim()
  const cwdBase = path.basename(cwd)
  if (rawTarget === cwdBase || rawTarget === `./${cwdBase}`) {
    return remainder
  }

  const repoPrefix = inferScopedVerificationRepoPrefix(claimedFiles)
  if (repoPrefix && (rawTarget === repoPrefix || rawTarget === `./${repoPrefix}`)) {
    const targetFromCwd = path.resolve(cwd, rawTarget)
    if (!fs.existsSync(targetFromCwd)) {
      return remainder
    }
  }

  return trimmed
}

function extractExecutableScopedVerificationCommands(
  command: string | undefined,
  cwd: string,
  claimedFiles?: string[],
): string[] {
  if (!command || !command.trim()) return []
  return command
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => looksLikeExecutableScopedVerificationLine(line))
    .map((line) => normalizeScopedVerificationLineForCwd(line, cwd, claimedFiles))
    .filter(Boolean)
}

interface ScopedVerificationAttempt {
  cwd: string
  command: string
}

function looksLikePathToken(token: string): boolean {
  if (!token || token.startsWith("-")) return false
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) return false
  return token.includes("/") || token.includes("\\")
}

function splitLooseShellWords(command: string): string[] {
  return command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
}

function unquoteShellWord(word: string): string {
  return word.replace(/^['"]|['"]$/g, "")
}

function classifyScopedVerificationFailureOutput(
  output: string | undefined,
): "environment" | "command-misconfigured" | "implementation" {
  if (!output) return "implementation"
  if (
    /Could not read package\.json/i.test(output) ||
    /ENOENT: no such file or directory, open .*package\.json/i.test(output) ||
    /No tests found/i.test(output) ||
    /Pattern: .* - 0 matches/i.test(output)
  ) {
    return "command-misconfigured"
  }
  if (
    /ENOENT: no such file or directory, open '\/home\/[^']+\.opscompassdev\/tokens\.json'/i.test(output) ||
    /path '\/home\/[^']+\.opscompassdev\/tokens\.json'/i.test(output) ||
    /missing credentials/i.test(output) ||
    /authentication required/i.test(output)
  ) {
    return "environment"
  }
  return "implementation"
}

function looksLikeRetryableScopedVerificationFailure(output: string | undefined): boolean {
  if (!output) return false
  return classifyScopedVerificationFailureOutput(output) === "command-misconfigured"
}

function buildScopedVerificationCommandAttempts(
  command: string,
  cwd: string,
): ScopedVerificationAttempt[] {
  const attempts: ScopedVerificationAttempt[] = [{ cwd, command }]
  if (!/^(?:npm|yarn|pnpm)\s+test\b|^(?:npx\s+jest|jest)\b/i.test(command.trim())) {
    return attempts
  }

  const words = splitLooseShellWords(command)
  const pathTokens = words
    .map((word) => unquoteShellWord(word))
    .filter((word) => looksLikePathToken(word))

  const seen = new Set<string>([`${path.resolve(cwd)}::${command}`])
  for (const token of pathTokens) {
    const absoluteTarget = path.resolve(cwd, token)
    if (!fs.existsSync(absoluteTarget)) continue

    let currentDir = fs.statSync(absoluteTarget).isDirectory()
      ? absoluteTarget
      : path.dirname(absoluteTarget)

    while (currentDir !== cwd && currentDir.startsWith(`${path.resolve(cwd)}${path.sep}`)) {
      if (fs.existsSync(path.join(currentDir, "package.json"))) {
        const rewrittenToken = path.relative(currentDir, absoluteTarget)
        if (rewrittenToken && rewrittenToken !== token) {
          const rewrittenCommand = command.replace(token, rewrittenToken)
          const dedupeKey = `${path.resolve(currentDir)}::${rewrittenCommand}`
          if (!seen.has(dedupeKey)) {
            seen.add(dedupeKey)
            attempts.push({ cwd: currentDir, command: rewrittenCommand })
          }
        }
      }
      const parentDir = path.dirname(currentDir)
      if (parentDir === currentDir) break
      currentDir = parentDir
    }
  }

  return attempts
}

function formatScopedVerificationAttempt(attempt: ScopedVerificationAttempt, baseCwd: string): string {
  if (path.resolve(attempt.cwd) === path.resolve(baseCwd)) return attempt.command
  const relativeCwd = path.relative(baseCwd, attempt.cwd) || "."
  return `cd ${relativeCwd} && ${attempt.command}`
}

function runCompatScopedVerification(
  command: string | undefined,
  cwd: string,
  claimedFiles?: string[],
): {
  status: "pass" | "fail" | "skipped"
  command?: string
  output?: string
  classification?: "environment" | "command-misconfigured" | "implementation"
  attempts?: Array<{
    cwd?: string
    command: string
    status: "pass" | "fail"
    output?: string
    classification?: "environment" | "command-misconfigured" | "implementation"
  }>
} | undefined {
  const commands = extractExecutableScopedVerificationCommands(command, cwd, claimedFiles)
  if (commands.length === 0) return undefined

  const outputs: string[] = []
  const attemptRecords: Array<{
    cwd?: string
    command: string
    status: "pass" | "fail"
    output?: string
    classification?: "environment" | "command-misconfigured" | "implementation"
  }> = []

  for (const executable of commands) {
    const attempts = buildScopedVerificationCommandAttempts(executable, cwd)

    for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex++) {
      const attempt = attempts[attemptIndex]!
      try {
        const output = execFileSync("bash", ["-c", attempt.command], {
          cwd: attempt.cwd,
          encoding: "utf-8",
          maxBuffer: 50 * 1024,
          timeout: 300_000,
        })
        const trimmedOutput = output.trim()
        attemptRecords.push({
          cwd: attempt.cwd,
          command: attempt.command,
          status: "pass",
          output: trimmedOutput || undefined,
        })
        if (trimmedOutput) {
          outputs.push(trimmedOutput)
        }
        break
      } catch (err: unknown) {
        const execErr = err as {
          stdout?: Buffer | string
          stderr?: Buffer | string
          message?: string
        }
        const parts: string[] = []
        if (execErr.stdout) parts.push(execErr.stdout.toString().trim())
        if (execErr.stderr) parts.push(execErr.stderr.toString().trim())
        if (!parts.length && execErr.message) parts.push(execErr.message)
        const failureOutput = parts.join("\n---stderr---\n").substring(0, 50 * 1024)
        const classification = classifyScopedVerificationFailureOutput(failureOutput)
        attemptRecords.push({
          cwd: attempt.cwd,
          command: attempt.command,
          status: "fail",
          output: failureOutput,
          classification,
        })
        const canRetry = attemptIndex < attempts.length - 1 && looksLikeRetryableScopedVerificationFailure(failureOutput)
        if (canRetry) {
          outputs.push(
            `Scoped verification retry ${attemptIndex + 1}/${attempts.length - 1} failed for ` +
            `${formatScopedVerificationAttempt(attempt, cwd)}\n${failureOutput}`,
          )
          continue
        }
        return {
          status: "fail",
          command: commands.join("\n"),
          classification,
          attempts: attemptRecords,
          output: [
            ...outputs,
            `Scoped verification failed for ${formatScopedVerificationAttempt(attempt, cwd)}`,
            failureOutput,
          ].join("\n\n").substring(0, 50 * 1024),
        }
      }
    }
  }

  return {
    status: "pass",
    command: commands.join("\n"),
    attempts: attemptRecords,
    output: outputs.join("\n\n").substring(0, 50 * 1024),
  }
}

function runCompatWorktreeSetupCommand(
  command: string | null | undefined,
  cwd: string,
): void {
  if (!command || !command.trim()) return
  try {
    execFileSync("bash", ["-c", command.trim()], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
    })
  } catch (err: unknown) {
    const execErr = err as {
      stdout?: Buffer | string
      stderr?: Buffer | string
      message?: string
    }
    const parts: string[] = []
    if (execErr.stdout) parts.push(execErr.stdout.toString().trim())
    if (execErr.stderr) parts.push(execErr.stderr.toString().trim())
    if (!parts.length && execErr.message) parts.push(execErr.message)
    throw new Error(`Worktree setup failed: ${parts.join("\n---stderr---\n") || "unknown error"}`)
  }
}

function prefixChangedFilesForSharedCwd(
  sharedCwd: string,
  taskRepoCwd: string,
  changedFiles: string[],
): string[] {
  const repoPrefix = path.relative(sharedCwd, taskRepoCwd)
  if (!repoPrefix || repoPrefix === ".") return changedFiles
  return changedFiles.map((file) => path.join(repoPrefix, file))
}

async function runCompatTaskInWorkspace(
  task: BackendParallelTaskInput,
  taskIndex: number,
  workspaceId: string,
  worktree: CompatWorktreeInfo,
  runId: string,
  agents: unknown[],
  modules: CompatModules,
  sharedCwd: string,
  taskRepoCwd: string,
  baseCommit: string,
  patchPath: string,
): Promise<ParallelTaskResult> {
  task.onUpdate?.({
    agent: task.agent,
    status: "running",
    recentOutput: [`starting ${workspaceId} dispatch...`],
    lastActivityAt: Date.now(),
  })

  try {
    runCompatWorktreeSetupCommand(task.worktreeSetupCommand, worktree.agentCwd)
    const resolvedAgent = findAgent(agents, task.agent)!
    const result = await modules.runSync(worktree.agentCwd, agents, resolvedAgent.name, task.task, {
      runId: `${runId}-${taskIndex}`,
      cwd: worktree.agentCwd,
      modelOverride: task.model,
      outputPath: task.output === false ? undefined : (typeof task.output === "string" ? task.output : undefined),
      outputMode: task.outputMode === "file-only" ? "file-only" : undefined,
      maxOutput: task.maxOutput,
      onUpdate: forwardCompatProgress(task.agent, task.onUpdate),
    })

    const verification = runCompatScopedVerification(task.scopedVerification, worktree.agentCwd, task.claimedFiles)
    const { changedFiles, headCommit } = captureCompatPatchAgainstBase(worktree.agentCwd, baseCommit, patchPath)
    const normalizedChangedFiles = prefixChangedFilesForSharedCwd(sharedCwd, taskRepoCwd, changedFiles)

    return {
      agent: task.agent,
      groupId: task.groupId,
      rawOutput: result.finalOutput ?? "",
      outputPath: result.savedOutputPath,
      ok: result.exitCode === 0 && !result.error,
      error: result.error,
      workspaceId,
      baseCommit,
      headCommit,
      patchPath,
      changedFiles: normalizedChangedFiles,
      verification,
    }
  } catch (err) {
    return {
      agent: task.agent,
      groupId: task.groupId,
      rawOutput: "",
      ok: false,
      error: `Worktree dispatch error: ${err instanceof Error ? err.message : String(err)}`,
      workspaceId,
      baseCommit,
    }
  }
}

async function runParallelWithCompatWorktrees(
  cwd: string,
  input: Parameters<BackendDispatchService["runParallel"]>[0],
  agents: unknown[],
  modules: CompatModules,
): Promise<Awaited<ReturnType<BackendDispatchService["runParallel"]>>> {
  const runId = generateRunId()
  const workspacePlans = buildCompatWorkspacePlans(cwd, input.tasks)
  const clusterCount = workspacePlans.length
  const worktreeSetups: Array<{ setup: CompatWorktreeSetup; planRunId: string } | undefined> = new Array(clusterCount)

  try {
    for (let clusterIndex = 0; clusterIndex < workspacePlans.length; clusterIndex++) {
      const plan = workspacePlans[clusterIndex]!
      const representativeTask = input.tasks[plan.taskIndexes[0]!]!
      const planRunId = `${runId}-${clusterIndex}`
      const setup = modules.createWorktrees(plan.repoCwd, planRunId, 1, {
        agents: [representativeTask.agent],
      })
      const worktree = setup.worktrees[0]!
      worktreeSetups[clusterIndex] = { setup, planRunId }
      await maybeRunCompatWorktreeSetupHook(
        input.worktreeSetupHook,
        setup.cwd,
        worktree,
        planRunId,
        representativeTask.agent,
        setup.baseCommit,
      )
      if (plan.baseRef) {
        resetWorktreeToBaseRef(worktree.path, plan.baseRef)
      }
    }

    const results: Array<ParallelTaskResult | undefined> = new Array(input.tasks.length)
    const concurrencyLimit = Math.max(1, Math.min(input.concurrency ?? clusterCount, clusterCount))
    const diffsDir = path.join(cwd, ".zflow", "worktree-diffs", runId)
    fs.mkdirSync(diffsDir, { recursive: true })

    const clusterRuns = workspacePlans.map((plan, clusterIndex) => async () => {
      const setupEntry = worktreeSetups[clusterIndex]!
      const worktree = setupEntry.setup.worktrees[0]!
      const orderedTaskIndexes = topoSortWorkspaceTaskIndexes(input.tasks, plan.taskIndexes)
      let currentBaseCommit = plan.baseRef ? gitOutputTrimmed(worktree.path, ["rev-parse", "HEAD"]) : setupEntry.setup.baseCommit
      let blockedByFailure: string | undefined

      for (const taskIndex of orderedTaskIndexes) {
        const task = input.tasks[taskIndex]!
        if (blockedByFailure) {
          results[taskIndex] = {
            agent: task.agent,
            groupId: task.groupId,
            rawOutput: "",
            ok: false,
            error: `Shared workspace cluster \"${plan.workspaceId}\" halted because ${blockedByFailure} failed.`,
            workspaceId: plan.workspaceId,
            baseCommit: currentBaseCommit,
          }
          continue
        }

        const patchPath = path.join(diffsDir, `${task.groupId ?? `task-${taskIndex}`}.patch`)
        const taskResult = await runCompatTaskInWorkspace(
          task,
          taskIndex,
          plan.workspaceId,
          worktree,
          setupEntry.planRunId,
          agents,
          modules,
          cwd,
          plan.repoCwd,
          currentBaseCommit,
          patchPath,
        )
        results[taskIndex] = taskResult

        if (!taskResult.ok) {
          blockedByFailure = task.groupId ?? `task-${taskIndex}`
          continue
        }

        if (plan.mode === "shared-staging") {
          currentBaseCommit = checkpointSharedWorkspace(
            worktree.agentCwd,
            `[zflow-shared] ${plan.workspaceId}: ${task.groupId ?? `task-${taskIndex}`}`,
          )
          results[taskIndex] = {
            ...taskResult,
            headCommit: currentBaseCommit,
          }
        }
      }
    })

    await runTasksWithRollingConcurrency(clusterRuns, concurrencyLimit)

    const finalizedResults = input.tasks.map((task, index) => results[index] ?? ({
      agent: task.agent,
      groupId: task.groupId,
      rawOutput: "",
      ok: false,
      error: "Task did not produce a result.",
    }))

    return {
      ok: finalizedResults.every((result) => result.ok),
      results: finalizedResults,
    }
  } finally {
    for (const setupEntry of worktreeSetups) {
      if (!setupEntry) continue
      try {
        modules.cleanupWorktrees(setupEntry.setup)
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
        groupId: task.groupId,
        ...mapCompatSingleResult(result),
      }
    } catch (err) {
      return {
        agent: task.agent,
        groupId: task.groupId,
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
  let compatBackend: BackendDispatchService | undefined
  let compatError: unknown | undefined

  try {
    compatBackend = await createCompatZflowDispatchService()
  } catch (err) {
    compatError = err
  }

  // Prefer the fork-provided backend for legacy isolated dispatches, while
  // keeping the compat backend available as a fallback for richer zflow-owned
  // worktree features (hooks, shared serialized staging, base-ref worktrees).
  try {
    const { createZflowDispatchService } = await import("pi-subagents/zflow-bridge")
    const backend = createZflowDispatchService()
    service = new SubagentsDispatchService(backend, {
      fallback: compatBackend,
      capabilities: {
        isolatedWorktrees: true,
        sharedWorkspaceSerialized: false,
        sharedWorkspaceConcurrent: false,
        baseRefWorktrees: false,
        worktreeSetupHooks: false,
      },
    })
  } catch (forkErr) {
    if (compatBackend) {
      service = new SubagentsDispatchService(compatBackend)
    } else {
      service = new UnavailableDispatchService(
        `fork import failed: ${forkErr instanceof Error ? forkErr.message : String(forkErr)}; ` +
        `compat import failed: ${compatError instanceof Error ? compatError.message : String(compatError)}`,
      )
    }
  }

  registry.provide(DISPATCH_SERVICE_CAPABILITY, service)
}

// ── Test-only exports ──────────────────────────────────────────────
/** @internal Exported for unit testing only. */
export {
  validatePatchFile,
  writePatchFromRange,
  captureCompatPatchAgainstBase,
  isUsageLimitError,
  extractUsageLimitWaitTime,
  isUnsupportedDeveloperRoleDispatchError,
  resolveAgentFallbackModelCandidates,
  resolveMeaningfulSingleError,
  buildScopedVerificationCommandAttempts,
  extractExecutableScopedVerificationCommands,
  normalizeScopedVerificationLineForCwd,
}
