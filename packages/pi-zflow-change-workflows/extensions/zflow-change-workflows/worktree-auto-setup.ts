/**
 * worktree-auto-setup.ts — Built-in repo/worktree bootstrap detection.
 *
 * Detects common dependency-install/bootstrap commands that zflow can run
 * automatically inside temporary worktrees without requiring a repo-specific
 * hook. The strategy list is table-driven so future repo/toolchain handlers can
 * be added in one place.
 *
 * @module pi-zflow-change-workflows/worktree-auto-setup
 */

import * as fs from "node:fs"
import * as path from "node:path"

export interface AutoWorktreeSetupStrategy {
  /** Stable identifier for diagnostics/tests. */
  id: string
  /** Human-readable description for diagnostics. */
  description: string
  /** Return a shell command when this strategy applies, otherwise null. */
  detect(repoRoot: string): string | null
}

const DEFAULT_AUTO_WORKTREE_SETUP_STRATEGIES: readonly AutoWorktreeSetupStrategy[] = [
  {
    id: "pnpm-install",
    description: "Install workspace dependencies with pnpm in isolated worktrees",
    detect(repoRoot) {
      if (
        fs.existsSync(path.join(repoRoot, "pnpm-workspace.yaml")) ||
        fs.existsSync(path.join(repoRoot, "pnpm-lock.yaml"))
      ) {
        return "pnpm install --frozen-lockfile"
      }
      return null
    },
  },
  {
    id: "npm-ci",
    description: "Install dependencies with npm ci in isolated worktrees",
    detect(repoRoot) {
      if (fs.existsSync(path.join(repoRoot, "package-lock.json"))) {
        return "npm ci"
      }
      return null
    },
  },
  {
    id: "yarn-install",
    description: "Install dependencies with yarn in isolated worktrees",
    detect(repoRoot) {
      if (fs.existsSync(path.join(repoRoot, "yarn.lock"))) {
        return "yarn install --frozen-lockfile"
      }
      return null
    },
  },
  {
    id: "bun-install",
    description: "Install dependencies with bun in isolated worktrees",
    detect(repoRoot) {
      if (
        fs.existsSync(path.join(repoRoot, "bun.lockb")) ||
        fs.existsSync(path.join(repoRoot, "bun.lock"))
      ) {
        return "bun install --frozen-lockfile"
      }
      return null
    },
  },
]

export interface DetectedAutoWorktreeSetup {
  strategyId: string
  description: string
  command: string
}

/**
 * Detect the first built-in automatic worktree setup strategy that applies.
 */
export async function detectAutoWorktreeSetup(
  repoRoot: string,
  strategies: readonly AutoWorktreeSetupStrategy[] = DEFAULT_AUTO_WORKTREE_SETUP_STRATEGIES,
): Promise<DetectedAutoWorktreeSetup | null> {
  const hasNix = fs.existsSync(path.join(repoRoot, "flake.nix"))
  const prefix = hasNix ? "nix develop --command " : ""

  for (const strategy of strategies) {
    const command = strategy.detect(repoRoot)
    if (!command) continue
    return {
      strategyId: strategy.id,
      description: strategy.description,
      command: `${prefix}${command}`,
    }
  }

  return null
}

/**
 * Convenience wrapper returning only the command string.
 */
export async function detectWorktreeSetupCommand(
  repoRoot: string,
  strategies?: readonly AutoWorktreeSetupStrategy[],
): Promise<string | null> {
  const detected = await detectAutoWorktreeSetup(repoRoot, strategies)
  return detected?.command ?? null
}

export { DEFAULT_AUTO_WORKTREE_SETUP_STRATEGIES }
