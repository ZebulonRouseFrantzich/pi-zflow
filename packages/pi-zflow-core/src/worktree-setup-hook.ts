/**
 * `worktreeSetupHook` — types, contract, and registry helpers.
 *
 * A `worktreeSetupHook` is a per-repo configuration that runs inside a
 * freshly-created git worktree **before** the worker subagent is dispatched.
 * It sets up any generated files, symlinks, env stubs, or bootstrap steps
 * that the repo needs to be buildable or lintable inside an isolated worktree.
 *
 * ---
 * Policy (see `docs/worktree-setup-hook-policy.md` for the full document):
 *
 * 1. Only repos that **need** setup declare a `worktreeSetupHook`.
 * 2. If setup is required but no hook is configured, worker dispatch fails
 *    immediately with actionable guidance.
 * 3. The hook is **always** per-repo configuration — never baked into the
 *    pi-zflow package itself.
 * 4. The package ships **generic templates** for common repo classes so
 *    users can copy, adapt, and commit them.
 *
 * @module pi-zflow-core/worktree-setup-hook
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import { spawn } from "node:child_process"

// ---------------------------------------------------------------------------
// Hook context
// ---------------------------------------------------------------------------

/**
 * Environment information passed to every `worktreeSetupHook`.
 */
export interface WorktreeSetupHookContext {
  /** Absolute path to the worktree root (where the hook runs). */
  readonly worktreeRoot: string

  /** Absolute path to the **original** (non-worktree) repo root. */
  readonly repoRoot: string

  /** The git branch or ref that the worktree was checked out from. */
  readonly ref: string

  /** Arbitrary metadata supplied by the caller (e.g. run id, lane name). */
  readonly meta?: Record<string, string>
}

// ---------------------------------------------------------------------------
// Hook result
// ---------------------------------------------------------------------------

/**
 * Result returned by a completed `worktreeSetupHook`.
 */
export interface WorktreeSetupHookResult {
  /** Whether the hook completed successfully. */
  success: boolean

  /**
   * Human-readable message.
   * On failure this must explain what went wrong and how to fix it.
   * On success a brief confirmation (e.g. "worktree ready") is enough.
   */
  message: string

  /** Optional structured error details for logging / diagnostics. */
  error?: {
    /** Shell exit code, if applicable. */
    exitCode?: number
    /** stderr content, if captured. */
    stderr?: string
    /** A user-facing resolution hint. */
    hint?: string
  }
}

// ---------------------------------------------------------------------------
// Hook signature
// ---------------------------------------------------------------------------

/**
 * A `worktreeSetupHook` is an **executable** — either a shell script or a
 * JavaScript/TypeScript module — that receives one positional argument
 * (the worktree root) and returns exit code 0 on success.
 *
 * TypeScript-based hooks may import this type and export a default function
 * matching this signature.
 */
export type WorktreeSetupHookFn = (
  context: WorktreeSetupHookContext,
) => Promise<WorktreeSetupHookResult> | WorktreeSetupHookResult

// ---------------------------------------------------------------------------
// Hook configuration (how repos declare their hook)
// ---------------------------------------------------------------------------

/**
 * Describes how a `worktreeSetupHook` is configured for a repo.
 *
 * The hook **must** live in the repo (or in a well-known user-level
 * templates directory) so that it is version-controlled and
 * reviewable alongside the code it sets up.
 */
export interface WorktreeSetupHookConfig {
  /**
   * Path to the hook executable, **relative to the repo root**.
   *
   * Examples:
   *   - `.pi/zflow/worktree-setup-hook.sh`
   *   - `.pi/zflow/worktree-setup-hook.mjs`
   *   - `scripts/worktree-setup.mjs`
   *
   * The resolved path is passed as the single argument for shell hooks,
   * or imported as a module for `.mjs` / `.ts` hooks.
   */
  script: string

  /**
   * Runtime used to execute the hook.
   *
   * - `"shell"` (default): executed via `bash <script> <worktreeRoot>`.
   * - `"node"`: executed via `node <script> <worktreeRoot>`.
   * - `"module"`: imported as a JavaScript/TypeScript module (must export
   *   a default `WorktreeSetupHookFn`).
   *
   * When `"module"` is used, the import happens in-process (same Node
   * runtime), which gives the hook access to the full Node.js API and
   * any dependencies available in the calling context.
   */
  runtime?: "shell" | "node" | "module"

  /**
   * Maximum time in milliseconds to wait for the hook to complete.
   * Default: 30_000 (30 seconds).
   */
  timeoutMs?: number

  /**
   * Optional description shown in logs and failure messages.
   * Example: "Install workspace dependencies and link packages"
   */
  description?: string
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default timeout for worktree setup hooks: 30 seconds. */
export const DEFAULT_HOOK_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// Hook runner
// ---------------------------------------------------------------------------

/**
 * Run a worktree setup hook synchronously (await its completion).
 *
 * This is the single entry point that worker dispatch code calls after
 * creating a worktree and before dispatching a subagent to it.
 *
 * @param config - The hook configuration declared by the repo.
 * @param context - Runtime context (worktree path, repo root, ref, meta).
 * @throws If the hook binary cannot be found, the module cannot be loaded,
 *         or the runtime is unsupported.
 */
export async function runWorktreeSetupHook(
  config: WorktreeSetupHookConfig,
  context: WorktreeSetupHookContext,
): Promise<WorktreeSetupHookResult> {
  const scriptPath = path.resolve(context.repoRoot, config.script)
  const timeout = config.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS

  // --- Validate script is within repo root ---
  const normalizedRepoRoot = path.resolve(context.repoRoot)
  const normalizedScript = path.resolve(scriptPath)
  const relative = path.relative(normalizedRepoRoot, normalizedScript)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return {
      success: false,
      message:
        `worktreeSetupHook script path escapes the repository root. ` +
        `Script "${config.script}" resolves to "${scriptPath}" ` +
        `which is outside "${context.repoRoot}". Scripts must use repo-relative paths.`,
      error: {
        hint:
          `Use a repo-relative path, e.g. ".pi/zflow/worktree-setup-hook.sh". ` +
          `Absolute paths and ".." traversal are not permitted.`,
      },
    }
  }

  // --- Validate script exists ---
  try {
    await fs.access(scriptPath, fs.constants.X_OK | fs.constants.R_OK)
  } catch {
    return {
      success: false,
      message: `worktreeSetupHook script not found or not executable: ${scriptPath}`,
      error: {
        hint: `Ensure the file exists and has execute permission (chmod +x ${scriptPath}).`
      }
    }
  }

  const runtime = config.runtime ?? "shell"

  switch (runtime) {
    case "module": {
      return runModuleHook(scriptPath, context, config.description)
    }

    case "node": {
      return runChildProcess("node", [scriptPath, context.worktreeRoot], timeout, config.description)
    }

    case "shell": {
      return runChildProcess("bash", [scriptPath, context.worktreeRoot], timeout, config.description)
    }

    default: {
      const _exhaustive: never = runtime
      throw new Error(`Unsupported worktreeSetupHook runtime: ${runtime}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Internal runners
// ---------------------------------------------------------------------------

/**
 * Import and run a module-based hook in-process.
 */
async function runModuleHook(
  scriptPath: string,
  context: WorktreeSetupHookContext,
  description?: string,
): Promise<WorktreeSetupHookResult> {
  try {
    const mod = await import(scriptPath)
    const fn: WorktreeSetupHookFn = mod.default ?? mod
    if (typeof fn !== "function") {
      return {
        success: false,
        message: `Module hook at "${scriptPath}" does not export a default function.`,
        error: {
          hint: "Export a default function matching WorktreeSetupHookFn."
        }
      }
    }
    return await fn(context)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      message: `Module hook "${description || scriptPath}" threw: ${msg}`,
      error: {
        hint: "Check the hook implementation for runtime errors."
      }
    }
  }
}

/**
 * Run a script-based hook in a child process.
 */
function runChildProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  description?: string,
): Promise<WorktreeSetupHookResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      timeout: timeoutMs,
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk))

    let settled = false

    const finish = (exitCode: number | null, signal: string | null) => {
      if (settled) return
      settled = true

      const stdout = Buffer.concat(stdoutChunks).toString("utf-8").trim()
      const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim()

      if (signal === "SIGTERM") {
        resolve({
          success: false,
          message: `worktreeSetupHook "${description || args[0]}" timed out after ${timeoutMs}ms.`,
          error: { hint: "Increase timeoutMs in the hook config or optimize the hook script." }
        })
        return
      }

      if (exitCode !== 0) {
        resolve({
          success: false,
          message: `worktreeSetupHook "${description || args[0]}" failed with exit code ${exitCode}.`,
          error: {
            exitCode: exitCode ?? undefined,
            stderr: stderr || undefined,
            hint: stderr || "Check the hook output for details."
          }
        })
        return
      }

      resolve({
        success: true,
        message: stdout || `worktreeSetupHook "${description || args[0]}" completed successfully.`,
      })
    }

    child.on("exit", (code, signal) => finish(code, signal))
    child.on("error", (err) => {
      if (settled) return
      settled = true
      resolve({
        success: false,
        message: `Failed to spawn worktreeSetupHook: ${err.message}`,
        error: { hint: "Check that the runtime binary exists on $PATH." }
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Repo classifier (decision-table helper)
// ---------------------------------------------------------------------------

/**
 * Broad classification of target repos for the `worktreeSetupHook` decision table.
 *
 * Used by diagnostics / `/zflow-clean --dry-run` to report whether a repo
 * is expected to need a hook.
 */
export type RepoClass =
  | "plain-ts-js"
  | "pnpm-workspace"
  | "npm-workspace"
  | "monorepo-generated-links"
  | "env-stub-needed"
  | "env-stub-required"
  | "custom-build-bootstrap"
  | "unknown"

/**
 * Default classification heuristics.
 *
 * Returns the most likely `RepoClass` based on files present at the repo root.
 * This is intentionally conservative — it may return `"unknown"` when in doubt.
 *
 * @param repoRoot - Absolute path to the repo root.
 */
export async function classifyRepo(repoRoot: string): Promise<RepoClass> {
  const files = await fs.readdir(repoRoot).catch(() => [] as string[])

  const has = (name: string) => files.includes(name)

  // pnpm workspace
  if (has("pnpm-workspace.yaml") || has("pnpm-lock.yaml")) return "pnpm-workspace"

  // npm workspace monorepo
  if (has("package.json") && has("lerna.json")) return "monorepo-generated-links"

  // env-stub markers
  if (has(".env.example") && !has(".env")) return "env-stub-required"
  if (has(".env.example")) return "env-stub-needed"

  // plain TS/JS
  if (has("package.json") && has("tsconfig.json")) return "plain-ts-js"
  if (has("package.json")) return "plain-ts-js"

  return "unknown"
}
