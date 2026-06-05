/**
 * worktree-setup.ts — Worktree setup hook orchestration and fail-fast integration.
 *
 * Integrates the `worktreeSetupHook` infrastructure from pi-zflow-core into
 * the worktree dispatch workflow. Handles detection, configuration lookup,
 * fail-fast behavior, and hook execution.
 *
 * ## Policy
 *
 * 1. Use built-in automatic setup for common dependency-managed repos when possible.
 * 2. Reserve `worktreeSetupHook` for repo-specific bootstrap that zflow cannot infer.
 * 3. If a repo needs custom setup and no hook is configured, fail fast with guidance.
 * 4. The hook is always per-repo configuration — never baked into the package.
 *
 * @module pi-zflow-change-workflows/worktree-setup
 */

import * as path from "node:path"
import { fileURLToPath } from "node:url"
import {
  runWorktreeSetupHook,
  classifyRepo,
  type RepoClass,
  type WorktreeSetupHookConfig,
  type WorktreeSetupHookContext,
  type WorktreeSetupHookResult,
} from "pi-zflow-core/worktree-setup-hook"
import type { DispatchWorktreeSetupHook } from "pi-zflow-core/dispatch-service"
import { loadRepoZflowConfig } from "./repo-config.js"
import { detectAutoWorktreeSetup } from "./worktree-auto-setup.js"

/**
 * Default timeout for worktree setup hooks: 60 seconds.
 */
const DEFAULT_TIMEOUT_MS = 60_000

const CUSTOM_HOOK_REQUIRED_REPO_CLASSES = new Set<RepoClass>([
  "env-stub-required",
  "custom-build-bootstrap",
])

const AUTO_SETUP_PREFERRED_REPO_CLASSES = new Set<RepoClass>([
  "plain-ts-js",
  "pnpm-workspace",
  "npm-workspace",
  "monorepo-generated-links",
])

export interface RepoWorktreeSetupPreference {
  state: "configured" | "disabled" | "absent"
  hook?: WorktreeSetupHookConfig
  configPath?: string
}

export interface DispatchWorktreeSetupResolution {
  ok: boolean
  required: boolean
  hook?: DispatchWorktreeSetupHook
  message?: string
  disabled?: boolean
  autoSetupCommand?: string
  strategy?: "none" | "auto" | "hook" | "disabled"
  repoClass?: RepoClass
}

function withHookDefaults(
  hook: WorktreeSetupHookConfig,
  configPath?: string,
): WorktreeSetupHookConfig {
  return {
    script: hook.script,
    runtime: hook.runtime ?? "shell",
    timeoutMs: hook.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    description: hook.description ?? (configPath ? `worktreeSetupHook (${configPath})` : "worktreeSetupHook"),
  }
}

function getTemplatesDir(): string {
  return path.join(
    path.dirname(fileURLToPath(import.meta.resolve("pi-zflow-change-workflows/package.json"))),
    "templates",
    "worktree-setup-hooks",
  )
}

function buildMissingHookMessage(repoRoot: string, repoClass: RepoClass, autoSetupCommand: string | null): string {
  const templatesDir = getTemplatesDir()
  const autoSetupNote = autoSetupCommand
    ? [
        "Built-in automatic setup was detected, but this repo class still needs additional custom bootstrap.",
        `Detected auto setup command: ${autoSetupCommand}`,
        "",
      ]
    : []

  return [
    "worktreeSetupHook required but not configured.",
    "",
    `Repo: ${repoRoot}`,
    `Detected repo class: ${repoClass}`,
    ...autoSetupNote,
    "This repo appears to need custom setup inside isolated worktrees that zflow cannot safely infer.",
    "Configure a repo-local hook before dispatching workers.",
    "",
    `Templates: ${templatesDir}`,
    `Example config: { "worktreeSetupHook": { "script": ".pi/zflow/worktree-setup-hook.sh" } }`,
    "If this repo does NOT need a custom hook, set:",
    '  { "worktreeSetupHook": null }',
    "to suppress hook enforcement while still allowing built-in automatic setup.",
  ].join("\n")
}

/**
 * Check whether a repo likely needs some kind of worktree setup.
 *
 * This is broader than hook enforcement. A repo may need setup but still be
 * satisfied by a built-in automatic setup command instead of a custom hook.
 */
export async function repoNeedsWorktreeSetup(repoRoot: string): Promise<boolean> {
  const repoClass = await classifyRepo(repoRoot)
  if (CUSTOM_HOOK_REQUIRED_REPO_CLASSES.has(repoClass)) {
    return true
  }

  const autoSetup = await detectAutoWorktreeSetup(repoRoot)
  return autoSetup !== null
}

/**
 * Load the repo's explicit worktree-setup preference.
 */
export async function getRepoWorktreeSetupPreference(
  repoRoot: string,
): Promise<RepoWorktreeSetupPreference> {
  const { config, configPath } = await loadRepoZflowConfig(repoRoot)

  if (!("worktreeSetupHook" in config)) {
    return { state: "absent", configPath }
  }

  if (config.worktreeSetupHook === null) {
    return { state: "disabled", configPath }
  }

  if (config.worktreeSetupHook) {
    return {
      state: "configured",
      hook: withHookDefaults(config.worktreeSetupHook, configPath),
      configPath,
    }
  }

  return { state: "absent", configPath }
}

/**
 * Load the worktree setup hook configuration from a repo's config files.
 *
 * Returns the configured hook, or null when the hook is absent or explicitly
 * disabled via `worktreeSetupHook: null`.
 */
export async function getRepoWorktreeSetupConfig(
  repoRoot: string,
): Promise<WorktreeSetupHookConfig | null> {
  const preference = await getRepoWorktreeSetupPreference(repoRoot)
  return preference.state === "configured" ? preference.hook ?? null : null
}

/**
 * Resolve the repo's worktree setup requirements into a dispatch-layer shape.
 */
export async function resolveDispatchWorktreeSetup(
  repoRoot: string,
): Promise<DispatchWorktreeSetupResolution> {
  const repoClass = await classifyRepo(repoRoot)
  const preference = await getRepoWorktreeSetupPreference(repoRoot)
  const autoSetup = await detectAutoWorktreeSetup(repoRoot)

  if (preference.state === "disabled") {
    return {
      ok: true,
      required: false,
      disabled: true,
      strategy: "disabled",
      autoSetupCommand: autoSetup?.command,
      repoClass,
      message: "Custom worktree hook enforcement disabled by repo config.",
    }
  }

  if (preference.state === "configured") {
    return {
      ok: true,
      required: true,
      strategy: "hook",
      repoClass,
      autoSetupCommand: autoSetup?.command,
      hook: {
        script: preference.hook!.script,
        runtime: preference.hook!.runtime,
        timeoutMs: preference.hook!.timeoutMs,
        description: preference.hook!.description,
      },
      message: `Using repo-configured worktree setup hook (${preference.hook!.script}).`,
    }
  }

  if (CUSTOM_HOOK_REQUIRED_REPO_CLASSES.has(repoClass)) {
    return {
      ok: false,
      required: true,
      strategy: "hook",
      repoClass,
      autoSetupCommand: autoSetup?.command,
      message: buildMissingHookMessage(repoRoot, repoClass, autoSetup?.command ?? null),
    }
  }

  if (autoSetup) {
    return {
      ok: true,
      required: AUTO_SETUP_PREFERRED_REPO_CLASSES.has(repoClass),
      strategy: "auto",
      repoClass,
      autoSetupCommand: autoSetup.command,
      message: `Using built-in automatic worktree setup (${autoSetup.strategyId}).`,
    }
  }

  return {
    ok: true,
    required: false,
    strategy: "none",
    repoClass,
    message: "No custom worktree setup hook required.",
  }
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
 * Built-in automatic setup is handled by the dispatch layer via
 * `worktreeSetupCommand`; this function only enforces/runs custom hooks.
 */
export async function assertWorktreeSetupReady(
  repoRoot: string,
  worktreeRoot: string,
  ref: string,
  meta?: Record<string, string>,
): Promise<WorktreeSetupResult> {
  const resolution = await resolveDispatchWorktreeSetup(repoRoot)

  if (!resolution.ok) {
    return {
      success: false,
      hookExecuted: false,
      message: resolution.message ?? "worktree setup requirements were not satisfied",
      hookCreatedPaths: [],
    }
  }

  if (!resolution.hook) {
    return {
      success: true,
      hookExecuted: false,
      message: resolution.message ?? "No custom worktree setup hook required.",
      hookCreatedPaths: [],
    }
  }

  const hookConfig: WorktreeSetupHookConfig = withHookDefaults({
    script: resolution.hook.script,
    runtime: resolution.hook.runtime,
    timeoutMs: resolution.hook.timeoutMs,
    description: resolution.hook.description,
  })

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

  return {
    success: true,
    hookExecuted: true,
    hookResult,
    message: `Worktree setup hook completed: ${hookResult.message}`,
    hookCreatedPaths: [],
  }
}
