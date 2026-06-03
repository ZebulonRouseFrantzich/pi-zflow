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
  /** Optional live progress callback from the dispatch backend. */
  onUpdate?: (progress: AgentDispatchProgress) => void
}

/** Live progress snapshot from a running dispatched agent. */
export interface AgentDispatchProgress {
  /** Agent runtime name. */
  agent: string
  /** Current status reported by the backend. */
  status?: string
  /** Number of tool calls observed so far. */
  toolCount?: number
  /** Current tool name, if a tool is running. */
  currentTool?: string
  /** Compact preview of current tool arguments, if available. */
  currentToolArgs?: string
  /** Recent completed tool calls, if reported. */
  recentTools?: Array<{ tool?: string; args?: string }>
  /** Run duration in milliseconds. */
  durationMs?: number
  /** Most recent activity timestamp in milliseconds. */
  lastActivityAt?: number
  /** Recent output lines, if reported. */
  recentOutput?: string[]
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
  /** Optional rate-limit retry metadata for durable diagnostics/logging. */
  rateLimitRetries?: {
    retryCount: number
    totalRateLimitRetries: number
    notices?: string[]
  }
}

// ── Parallel run input/output ───────────────────────────────────

/** Supported worktree execution modes for dispatched tasks. */
export type WorktreeExecutionMode = "isolated" | "shared-staging"

/** Supported shared workspace concurrency modes. */
export type WorkspaceConcurrencyMode = "serialized" | "concurrent"

/** Supported strategies for choosing a task's base commit/ref. */
export type WorktreeBaseStrategy = "head" | "dependency-lineage"

/**
 * Optional per-task worktree strategy metadata.
 *
 * This lets zflow orchestration express richer execution intent while keeping
 * backwards compatibility with simple `worktree: true` dispatches.
 */
export interface TaskWorktreeStrategy {
  /** Default: isolated worktree per task. */
  mode?: WorktreeExecutionMode
  /** Shared staging workspace identifier when `mode` is `shared-staging`. */
  workspaceId?: string
  /** Default: serialized execution inside a shared workspace. */
  workspaceConcurrency?: WorkspaceConcurrencyMode
  /** Default: branch/reset from the repo's current HEAD. */
  baseStrategy?: WorktreeBaseStrategy
  /** Resolved git ref/commit to use as the task's base when supported. */
  baseRef?: string
  /** Optional planner-authored rationale for non-default execution strategy. */
  executionRationale?: string
}

/**
 * Worktree setup hook configuration passed through the typed dispatch layer.
 *
 * The bridge/backend is responsible for executing this hook inside each
 * created worktree before the worker agent starts.
 */
export interface DispatchWorktreeSetupHook {
  script: string
  runtime?: "shell" | "node" | "module"
  timeoutMs?: number
  description?: string
}

/**
 * Dispatch capability flags advertised by the active backend.
 *
 * Missing/undefined capabilities should be treated conservatively by callers.
 */
export interface DispatchCapabilities {
  isolatedWorktrees: boolean
  sharedWorkspaceSerialized: boolean
  sharedWorkspaceConcurrent: boolean
  baseRefWorktrees: boolean
  worktreeSetupHooks: boolean
}

/** Baseline conservative capability set for legacy backends. */
export const LEGACY_DISPATCH_CAPABILITIES: DispatchCapabilities = {
  isolatedWorktrees: true,
  sharedWorkspaceSerialized: false,
  sharedWorkspaceConcurrent: false,
  baseRefWorktrees: false,
  worktreeSetupHooks: false,
}

/**
 * A single task within a parallel dispatch.
 */
export interface ParallelTaskInput {
  /** Agent runtime name. */
  agent: string
  /** Optional stable group/task identifier from orchestration. */
  groupId?: string
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
  /** Optional live progress callback from the dispatch backend. */
  onUpdate?: (progress: AgentDispatchProgress) => void
  /** Files the task expects to change. */
  claimedFiles?: string[]
  /** Execution-plan dependencies for this task. */
  dependencies?: string[]
  /** Optional richer worktree strategy metadata. */
  worktreeStrategy?: TaskWorktreeStrategy
  /**
   * Scoped verification command to run after the agent completes.
   * The dispatch backend should execute this command in the worktree
   * and return stdout/stderr in the result's `verification.output`.
   * Omit or leave undefined to skip post-run verification.
   */
  scopedVerification?: string

  /**
   * Shell command to run in the worktree BEFORE the agent starts.
   * Used to ensure dependencies are installed (e.g. "pnpm install --frozen-lockfile").
   * If specified, this runs before the agent and before scoped verification.
   * If the command fails, the task fails immediately with a clear error.
   * Omit or leave undefined to skip worktree setup.
   */
  worktreeSetupCommand?: string | null
}

/**
 * Result from a single task in a parallel run.
 */
export interface ParallelTaskResult {
  /** Agent runtime name. */
  agent: string
  /** Optional stable group/task identifier from orchestration. */
  groupId?: string
  /** Raw text output. */
  rawOutput: string
  /** Path to persisted output file, if applicable. */
  outputPath?: string
  /** Worktree path used by the worker, when the dispatcher can expose it. */
  worktreePath?: string
  /** Shared workspace identifier when the task ran in shared-staging mode. */
  workspaceId?: string
  /** Base commit/ref actually used for the task. */
  baseCommit?: string
  /** Head commit after the task completed, when known. */
  headCommit?: string
  /** Patch path produced by the dispatcher, when it captures patches itself. */
  patchPath?: string
  /** Files changed by this task, if reported by the dispatcher. */
  changedFiles?: string[]
  /** Scoped verification result reported by the worker/dispatcher. */
  verification?: {
    status: "pass" | "fail" | "skipped" | "missing" | "passed" | "failed"
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
  /** Optional repo-defined hook to run inside created worktrees. */
  worktreeSetupHook?: DispatchWorktreeSetupHook
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

  /**
   * Optionally list discoverable agent runtime names for the current cwd.
   *
   * This is used by planning/prepare flows to keep generated execution-group
   * agent names aligned with what the active backend can actually dispatch.
   */
  listAgents?(cwd?: string): Promise<Array<string | { name?: string }>>

  /** Human-readable name for diagnostics. */
  readonly name: string

  /** Optional capability flags advertised by the active backend. */
  readonly capabilities?: DispatchCapabilities
}

// ─── Registry key ──────────────────────────────────────────────

/** Well-known capability name for the dispatch service. */
export const DISPATCH_SERVICE_CAPABILITY = "zflow-dispatch" as const
