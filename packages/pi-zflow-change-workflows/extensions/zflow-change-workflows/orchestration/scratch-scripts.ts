/**
 * scratch-scripts.ts — ephemeral helper script directory policy helpers.
 */

/**
 * Resolve the scratch scripts directory for a run.
 *
 * Path: `<runtime-state-dir>/runs/<runId>/scratch/scripts/`
 *
 * This directory is the ONLY allowed location for ephemeral helper scripts
 * (verification wrappers, debug scripts, temp build scripts, etc.) created
 * by subagent workers during workflow execution. Scripts placed here are
 * gitignored, cleanup-tracked, and automatically removed by `/zflow-clean`.
 *
 * @param runId - Unique run identifier.
 * @param cwd - Working directory (optional).
 * @returns Absolute path to the scratch scripts directory.
 */
export async function resolveScratchScriptsDir(
  runId: string,
  cwd?: string,
): Promise<string> {
  const { default: path } = await import("node:path")
  const { resolveRunDir } = await import("pi-zflow-artifacts/artifact-paths")
  const runDir = resolveRunDir(runId, cwd)
  return path.join(runDir, "scratch", "scripts")
}

/**
 * Ensure the scratch scripts directory exists and return its path.
 *
 * Creates the directory (and any parent directories) if it does not exist.
 * Also registers the scratch directory as a retained artifact with a 3-day TTL
 * so `/zflow-clean` picks it up for cleanup.
 *
 * @param runId - Unique run identifier.
 * @param cwd - Working directory (optional).
 * @returns Absolute path to the scratch scripts directory.
 */
export async function ensureScratchScriptsDir(
  runId: string,
  cwd?: string,
): Promise<string> {
  const { default: fs } = await import("node:fs/promises")
  const scratchDir = await resolveScratchScriptsDir(runId, cwd)
  await fs.mkdir(scratchDir, { recursive: true })

  try {
    const { addRetainedArtifact } = await import("pi-zflow-artifacts")
    await addRetainedArtifact(runId, {
      type: "scratch",
      path: scratchDir,
      reason: "Ephemeral helper scripts directory",
      expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    }, cwd)
  } catch {
    // Non-critical — best-effort tracking
  }

  return scratchDir
}

/**
 * Build a markdown snippet describing the ephemeral script policy.
 *
 * This rule must be injected into subagent task prompts for workflows
 * that may create temporary helper scripts, such as apply-back resolution
 * and fix implementation.
 *
 * @param scratchScriptsDir - Absolute path to the scratch scripts directory.
 * @returns A markdown string with the ephemeral script policy.
 */
export function buildEphemeralScriptRule(scratchScriptsDir: string): string {
  return [
    "## Ephemeral Script Policy",
    "",
    "Any temporary helper script you write (verification wrappers, debug scripts,",
    "build helpers, etc.) MUST be written ONLY to:",
    "",
    `\`\`\``,
    `${scratchScriptsDir}/`,
    `\`\`\``,
    "",
    "**NEVER write helper scripts to:**",
    "- The repo root (`/`)",
    "- `scripts/` directory",
    "- `test/` or `tests/` directories (unless they are part of the actual code change)",
    "- Source directories (`src/`, `lib/`, `packages/*/src/`)",
    "",
    "Scripts in the scratch directory are gitignored and automatically cleaned up.",
    "Scripts elsewhere pollute the repository and will be flagged as orphaned.",
    "",
    "If you need to run a multi-step verification, write a temporary script to:",
    `\`\`\``,
    `${scratchScriptsDir}/`,
    `\`\`\``,
    "and run it from there.",
    "",
    "**Violations of this policy will be blocked by the path guard.**",
  ].join("\n")
}
