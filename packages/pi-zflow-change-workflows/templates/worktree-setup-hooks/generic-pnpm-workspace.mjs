/**
 * generic-pnpm-workspace.mjs — worktreeSetupHook template for pnpm monorepos
 * ===========================================================================
 * Template for monorepos using pnpm workspaces that need `pnpm install`,
 * `pnpm rebuild`, or other bootstrap steps before workers can operate.
 *
 * This template uses the `"module"` runtime for better error handling,
 * async support, and cross-platform compatibility.
 *
 * Usage:
 *   cp generic-pnpm-workspace.mjs .pi/zflow/worktree-setup-hook.mjs
 *   # Optionally edit the steps below
 *   git add .pi/zflow/worktree-setup-hook.mjs
 *
 * Config in pi-zflow.config.json:
 *   {
 *     "worktreeSetupHook": {
 *       "script": ".pi/zflow/worktree-setup-hook.mjs",
 *       "runtime": "module",
 *       "timeoutMs": 120000,
 *       "description": "pnpm install and rebuild in worktree"
 *     }
 *   }
 */
// @ts-check

import { execSync } from "node:child_process"

/**
 * @param {{ worktreeRoot: string; repoRoot: string; ref: string; meta?: Record<string,string> }} context
 * @returns {Promise<{ success: boolean; message: string; error?: { exitCode?: number; stderr?: string; hint?: string } }>}
 */
export default async function pnpmWorkspaceHook(context) {
  const { worktreeRoot } = context

  /** ------ STEP 1: pnpm install (frozen lockfile) ------ */
  try {
    console.log(`[worktreeSetupHook] Running pnpm install in ${worktreeRoot}...`)
    execSync("pnpm install --frozen-lockfile", {
      cwd: worktreeRoot,
      stdio: "pipe",
      timeout: 120_000,
    })
  } catch (err) {
    const stderr = err.stderr?.toString() || err.message
    return {
      success: false,
      message: `pnpm install failed: ${stderr.slice(0, 500)}`,
      error: {
        exitCode: err.status,
        stderr,
        hint: "Check pnpm-lock.yaml consistency or network access.",
      },
    }
  }

  /** ------ STEP 2: rebuild native packages (if needed) ------ */
  try {
    console.log("[worktreeSetupHook] Running pnpm rebuild...")
    execSync("pnpm rebuild", {
      cwd: worktreeRoot,
      stdio: "pipe",
      timeout: 60_000,
    })
  } catch {
    // Non-fatal — some projects don't need rebuild
    console.log("[worktreeSetupHook] pnpm rebuild skipped or not needed.")
  }

  return {
    success: true,
    message: "pnpm workspace dependencies installed and rebuilt.",
  }
}
