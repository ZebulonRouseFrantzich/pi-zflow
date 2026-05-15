/**
 * dispatch-service.ts — Typed dispatch service interface for subagent/worktree execution.
 *
 * Defines the contract that runtime implementations (e.g. pi-subagents) can
 * satisfy, and that zflow workflow orchestration consumes.
 *
 * ## Design rationale
 *
 * Pi's ExtensionAPI can register and list tools but cannot directly execute
 * another extension's registered tool. pi-subagents exposes its `subagent`
 * tool as a Pi custom tool, not a typed extension service.
 *
 * Until pi-subagents provides a public typed service, this interface allows:
 * - zflow-change-workflows to declare what dispatch capability it requires.
 * - A registry-provided dispatcher (from a companion extension or injected
 *   test harness) to satisfy the contract.
 * - Clean fail-fast behavior when no dispatch service is available (instead
 *   of silently marking workflows complete).
 *
 * @module pi-zflow-core/dispatch-service
 */

// ── Agent run input/output ──────────────────────────────────────

/**
 * Input for dispatching a single agent task.
 */
export interface AgentDispatchInput {
  /** Agent runtime name (e.g. "zflow.implement-routine", "builtin:scout"). */
  agent: string
  /** Task description for the agent. */
  task: string
  /** Working directory (overrides runtime cwd). */
  cwd?: string
  /** Model override (optional). */
  model?: string
  /** Output path or false to suppress. */
  output?: string | false
  /** Output mode for file-only outputs. */
  outputMode?: "inline" | "file-only"
  /** Output truncation limits. */
  maxOutput?: { lines?: number; bytes?: number }
  /** Context mode (fresh vs fork). */
  context?: "fresh" | "fork"
}

/**
 * Result of dispatching a single agent task.
 */
export interface AgentDispatchResult {
  /** Raw text output from the agent. */
  rawOutput: string
  /** Path to the persisted output file, if output was file-based. */
  outputPath?: string
  /** Whether the agent completed successfully. */
  ok: boolean
  /** Optional error message. */
  error?: string
}

// ── Parallel run input/output ───────────────────────────────────

/**
 * A single task within a parallel dispatch.
 */
export interface ParallelTaskInput {
  /** Agent runtime name. */
  agent: string
  /** Task description for the agent. */
  task: string
  /** Working directory or other options. */
  cwd?: string
  /** Model override. */
  model?: string
  /** Output path or false. */
  output?: string | false
  /** Output mode. */
  outputMode?: "inline" | "file-only"
}

/**
 * Result from a single task in a parallel run.
 */
export interface ParallelTaskResult {
  /** Agent runtime name. */
  agent: string
  /** Raw text output. */
  rawOutput: string
  /** Path to persisted output file, if applicable. */
  outputPath?: string
  /** Worktree path used by the worker, when the dispatcher can expose it. */
  worktreePath?: string
  /** Patch path produced by the dispatcher, when it captures patches itself. */
  patchPath?: string
  /** Files changed by this task, if reported by the dispatcher. */
  changedFiles?: string[]
  /** Scoped verification result reported by the worker/dispatcher. */
  verification?: {
    status: "pass" | "fail" | "skipped" | "missing" | "passed" | "failed"
    command?: string
    output?: string
  }
  /** Whether the task completed successfully. */
  ok: boolean
  /** Optional error message. */
  error?: string
}

/**
 * Input for a parallel dispatch (with optional worktree isolation).
 */
export interface ParallelDispatchInput {
  /** Tasks to run in parallel. */
  tasks: ParallelTaskInput[]
  /** Working directory override. */
  cwd?: string
  /** Maximum parallel tasks. */
  concurrency?: number
  /** Create isolated git worktrees for each task. */
  worktree?: boolean
  /** Context mode. */
  context?: "fresh" | "fork"
  /** Output truncation limits. */
  maxOutput?: { lines?: number; bytes?: number }
}

/**
 * Result of a parallel dispatch.
 */
export interface ParallelDispatchResult {
  /** Overall success (all tasks ok). */
  ok: boolean
  /** Individual task results. */
  results: ParallelTaskResult[]
}

// ── Dispatch service interface ──────────────────────────────────

/**
 * Typed dispatch service for subagent/worktree execution.
 *
 * Implementations may wrap pi-subagents, run agents inline for testing,
 * or delegate to remote executors.
 */
export interface DispatchService {
  /** Run a single agent task. */
  runAgent(input: AgentDispatchInput): Promise<AgentDispatchResult>

  /** Run multiple tasks in parallel (with optional worktree isolation). */
  runParallel(input: ParallelDispatchInput): Promise<ParallelDispatchResult>

  /** Human-readable name for diagnostics. */
  readonly name: string
}

// ─── Registry key ──────────────────────────────────────────────

/** Well-known capability name for the dispatch service. */
export const DISPATCH_SERVICE_CAPABILITY = "zflow-dispatch" as const
