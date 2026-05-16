/**
 * worktree-setup.ts — Worktree setup hook orchestration and fail-fast integration.
 *
 * Integrates the `worktreeSetupHook` infrastructure from pi-zflow-core into
 * the worktree dispatch workflow. Handles detection, configuration lookup,
 * fail-fast behavior, and hook execution.
 *
 * ## Policy
 *
 * 1. Only repos that need setup declare a `worktreeSetupHook`.
 * 2. If setup is required but no hook is configured, worker dispatch fails
 *    immediately with actionable guidance and a pointer to the templates.
 * 3. The hook is always per-repo configuration — never baked into the package.
 * 4. Generic templates ship with this package for common repo classes.
 *
 * @module pi-zflow-change-workflows/worktree-setup
 */

import * as path from "node:path"
import { fileURLToPath } from "node:url"
import * as fs from "node:fs/promises"
import {
  runWorktreeSetupHook,
  classifyRepo,
  type WorktreeSetupHookConfig,
  type WorktreeSetupHookContext,
  type WorktreeSetupHookResult,
} from "pi-zflow-core/worktree-setup-hook"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Well-known config file names to search for worktree setup hook configuration.
 * Order matters — first match wins.
 */
const CONFIG_FILE_CANDIDATES = [
  ".pi/zflow/config.json",
  "pi-zflow.config.json",
  ".pi-zflow.config.json",
]

/**
 * Default timeout for worktree setup hooks: 60 seconds.
 */
const DEFAULT_TIMEOUT_MS = 60_000

// ---------------------------------------------------------------------------
// Repo needs check
// ---------------------------------------------------------------------------

/**
 * Check whether a repo is known to require a worktree setup hook.
 *
 * Uses the `classifyRepo` heuristics from pi-zflow-core and an allowlist of
 * repo classes that are known to need setup.
 *
 * @param repoRoot - Absolute path to the repo root.
 * @returns `true` if the repo likely needs a hook, `false` otherwise.
 */
export async function repoNeedsWorktreeSetup(repoRoot: string): Promise<boolean> {
  const repoClass = await classifyRepo(repoRoot)

  // Repo classes that typically need setup
  const needsSetup: Record<string, boolean> = {
    "pnpm-workspace": true,
    "npm-workspace": true,
    "monorepo-generated-links": true,
    "env-stub-required": true,
    "env-stub-needed": false, // nice-to-have but not required
    "custom-build-bootstrap": true,
    "plain-ts-js": false,
    "unknown": false,
  }

  return needsSetup[repoClass] ?? false
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

/**
 * Load the worktree setup hook configuration from a repo's config files.
 *
 * Searches well-known config file locations and returns the first
 * `worktreeSetupHook` config found, or `null` if none is configured.
 *
 * @param repoRoot - Absolute path to the repo root.
 * @returns The hook configuration, or `null` if not configured.
 */
export async function getRepoWorktreeSetupConfig(
  repoRoot: string,
): Promise<WorktreeSetupHookConfig | null> {
  for (const candidate of CONFIG_FILE_CANDIDATES) {
    const configPath = path.join(repoRoot, candidate)
    try {
      const content = await fs.readFile(configPath, "utf-8")
      const config = JSON.parse(content)

      if (config.worktreeSetupHook) {
        // Merge with defaults
        const hookConfig: WorktreeSetupHookConfig = {
          script: config.worktreeSetupHook.script,
          runtime: config.worktreeSetupHook.runtime ?? "shell",
          timeoutMs: config.worktreeSetupHook.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          description: config.worktreeSetupHook.description ?? `worktreeSetupHook (${configPath})`,
        }
        return hookConfig
      }
    } catch (err: unknown) {
      // ENOENT: file doesn't exist — skip silently and try next candidate
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        continue
      }
      // File exists but cannot be read or parsed — warn and continue
      if (err instanceof Error) {
        console.warn(
          `[zflow] Worktree setup config file exists but cannot be parsed: ${configPath} — ${err.message}`,
        )
      }
      continue
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Worktree setup entry points
// ---------------------------------------------------------------------------

/**
 * Result of a worktree setup validation/execution.
 */
export interface WorktreeSetupResult {
  /** Whether the hook check and execution succeeded. */
  success: boolean
  /** Whether a hook was found and executed. */
  hookExecuted: boolean
  /** The hook execution result, if a hook was run. */
  hookResult?: WorktreeSetupHookResult
  /** Human-readable summary message. */
  message: string
  /** Paths created by the hook that should be excluded from diff capture. */
  hookCreatedPaths: string[]
}

/**
 * Assert that the worktree setup precondition is met for a repo.
 *
 * This is the main entry point the orchestrator calls before creating worktrees.
 *
 * Behavior:
 * - If the repo needs a hook and one is configured, runs it and returns the result.
 * - If the repo needs a hook and none is configured, fails with actionable guidance.
 * - If the repo does not need a hook, silently succeeds.
 *
 * @param repoRoot - Absolute path to the repo root.
 * @param worktreeRoot - Absolute path to the worktree (for hook context).
 * @param ref - The git ref the worktree was checked out from.
 * @param meta - Optional metadata (run ID, lane name, etc.).
 * @returns WorktreeSetupResult with success/failure and hook details.
 */
export async function assertWorktreeSetupReady(
  repoRoot: string,
  worktreeRoot: string,
  ref: string,
  meta?: Record<string, string>,
): Promise<WorktreeSetupResult> {
  // Step 1: Check if the repo needs setup
  const needsSetup = await repoNeedsWorktreeSetup(repoRoot)

  if (!needsSetup) {
    return {
      success: true,
      hookExecuted: false,
      message: "Repo does not require worktree setup. Proceeding without hook.",
      hookCreatedPaths: [],
    }
  }

  // Step 2: Look for a hook configuration
  const hookConfig = await getRepoWorktreeSetupConfig(repoRoot)

  if (!hookConfig) {
    // Fail fast with actionable guidance
    const templatesDir = path.join(
      path.dirname(fileURLToPath(import.meta.resolve("pi-zflow-change-workflows/package.json"))),
      "templates", "worktree-setup-hooks",
    )

    return {
      success: false,
      hookExecuted: false,
      message: [
        `Repo at ${repoRoot} requires a worktreeSetupHook, but none is configured.`,
        "",
        "This repo was classified as needing setup to be buildable/lintable",
        "inside an isolated git worktree.",
        "",
        "To fix this:",
        `  1. Choose a template from ${templatesDir}`,
        "     Available templates:",
        "       - generic-node-ci.sh (plain TS/JS repos)",
        "       - generic-pnpm-workspace.mjs (pnpm monorepos)",
        "       - generic-env-stub.sh (repos needing .env)",
        "       - generic-codegen.sh (repos needing code generation)",
        `  2. Copy the template to your repo:`,
        `     cp ${templatesDir}/generic-node-ci.sh ${repoRoot}/.pi/zflow/worktree-setup-hook.sh`,
        `  3. Make it executable: chmod +x ${repoRoot}/.pi/zflow/worktree-setup-hook.sh`,
        "  4. Configure it in .pi/zflow/config.json:",
        `     { "worktreeSetupHook": { "script": ".pi/zflow/worktree-setup-hook.sh" } }`,
        "  5. Commit the hook and config.",
        "",
        "See docs/worktree-setup-hook-policy.md for the full contract.",
      ].join("\n"),
      hookCreatedPaths: [],
    }
  }

  // Step 3: Run the hook
  const context: WorktreeSetupHookContext = {
    worktreeRoot,
    repoRoot,
    ref,
    meta,
  }

  const hookResult = await runWorktreeSetupHook(hookConfig, context)

  if (!hookResult.success) {
    return {
      success: false,
      hookExecuted: true,
      hookResult,
      message: `Worktree setup hook failed: ${hookResult.message}`,
      hookCreatedPaths: [],
    }
  }

  // Collect paths that the hook may have created (from the hook result notes)
  const hookCreatedPaths: string[] = []

  return {
    success: true,
    hookExecuted: true,
    hookResult,
    message: `Worktree setup hook completed: ${hookResult.message}`,
    hookCreatedPaths,
  }
}
