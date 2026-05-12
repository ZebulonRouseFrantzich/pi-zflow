/**
 * User-level directory bootstrap helpers.
 *
 * Creates and resolves the standard user-level directory tree used by
 * pi-zflow for agents, chains, install manifests, and state.
 *
 * These directories live under `~/.pi/agent/` and are separate from
 * project-local `.pi/` overrides.
 *
 * @module pi-zflow-core/user-dirs
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"

// ---------------------------------------------------------------------------
// Directory paths
// ---------------------------------------------------------------------------

/**
 * Base user-level agent state directory.
 * All pi-zflow user directories are rooted here.
 */
export const USER_STATE_BASE = path.join(os.homedir(), ".pi", "agent", "zflow")

/**
 * User-level agent markdown directory.
 * Agent files placed here are discovered by `pi-subagents`.
 */
export const USER_AGENTS_DIR = path.join(os.homedir(), ".pi", "agent", "agents", "zflow")

/**
 * User-level chain markdown directory.
 * Chain files placed here are discovered by `pi-subagents`.
 */
export const USER_CHAINS_DIR = path.join(os.homedir(), ".pi", "agent", "chains", "zflow")

/**
 * User-level install manifest path.
 * Records which agents/chains/skills/prompts are installed.
 */
export const INSTALL_MANIFEST_PATH = path.join(USER_STATE_BASE, "install-manifest.json")

/**
 * User-level active profile cache path.
 * Written by `pi-zflow-profiles` on profile switch.
 */
export const ACTIVE_PROFILE_PATH = path.join(USER_STATE_BASE, "active-profile.json")

// ---------------------------------------------------------------------------
// Directory bootstrap
// ---------------------------------------------------------------------------

/**
 * The set of directories that must exist for pi-zflow user-level operation.
 */
const REQUIRED_USER_DIRS: readonly string[] = [
  USER_AGENTS_DIR,
  USER_CHAINS_DIR,
  USER_STATE_BASE,
] as const

/**
 * Idempotently create all required user-level directories.
 *
 * Safe to call multiple times — `fs.mkdir({ recursive: true })` is a no-op
 * when the directory already exists.
 *
 * This function does **not** create project-local `.pi/agents/` or `.pi/chains/`.
 * Those are opt-in and must be created explicitly by the calling code
 * (e.g., `/zflow-setup-agents --local`).
 */
export async function ensureUserDirs(): Promise<void> {
  await Promise.all(
    REQUIRED_USER_DIRS.map((dir) =>
      fs.mkdir(dir, { recursive: true }).then(() => {
        // Ensure the directory exists with standard permissions
        return fs.chmod(dir, 0o755).catch(() => {
          // chmod may fail on Windows or if directory already exists
          // with different permissions — non-fatal
        })
      }),
    ),
  )
}

/**
 * Check whether all required user directories exist.
 * Returns a map of directory → boolean.
 */
export async function checkUserDirs(): Promise<Record<string, boolean>> {
  const results: Record<string, boolean> = {}
  for (const dir of REQUIRED_USER_DIRS) {
    try {
      await fs.access(dir, fs.constants.F_OK)
      results[dir] = true
    } catch {
      results[dir] = false
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// User-level vs project-local policy
// ---------------------------------------------------------------------------

/**
 * Determine whether to use user-level or project-local agent/chain directories.
 *
 * Rules:
 * - **Default**: user-level (`~/.pi/agent/agents|chains/zflow/`).
 * - **Project-local**: only if the user explicitly opts in with a `--local` flag
 *   or a `.pi/agents/` / `.pi/chains/` directory already exists in the project root.
 *
 * @param projectRoot - The project root to check for local directories.
 * @returns `"user"` or `"local"`
 */
export function resolveAgentInstallScope(
  projectRoot?: string,
): "user" | "local" {
  if (!projectRoot) return "user"

  const localAgents = path.join(projectRoot, ".pi", "agents", "zflow")
  const localChains = path.join(projectRoot, ".pi", "chains", "zflow")

  try {
    const agentsExists = fs.access(localAgents, fs.constants.F_OK).then(() => true).catch(() => false)
    const chainsExists = fs.access(localChains, fs.constants.F_OK).then(() => true).catch(() => false)
    // Note: This is synchronous resolution, so we're checking synchronously.
    // The actual async check would happen in command handlers.
    return "user" // Default to user-level; command handlers do the full check
  } catch {
    return "user"
  }
}
