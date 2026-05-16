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

  async runAgent(input: AgentDispatchInput): Promise<AgentDispatchResult> {
    return {
      ok: false,
      rawOutput: "",
      error: `Cannot dispatch agent "${input.agent}" via "${this.name}".\n\n${UNAVAILABLE_GUIDANCE}`,
    }
  }

  async runParallel(input: ParallelDispatchInput): Promise<ParallelDispatchResult> {
    const results: ParallelTaskResult[] = input.tasks.map((task) => ({
      agent: task.agent,
      rawOutput: "",
      ok: false,
      error: `Cannot dispatch agent "${task.agent}" via "${this.name}".\n\n${UNAVAILABLE_GUIDANCE}`,
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

  // Try to load the pi-subagents-zflow backend.
  // The fork is a file: dependency during local development.
  try {
    const { createZflowDispatchService } = await import("pi-subagents/zflow-bridge")
    const backend = createZflowDispatchService()
    service = new SubagentsDispatchService(backend)
  } catch {
    // Fork unavailable — use diagnostic service
    service = new UnavailableDispatchService()
  }

  registry.provide(DISPATCH_SERVICE_CAPABILITY, service)
}
