/**
 * repo-config.ts — Shared repo-local zflow config loading.
 *
 * Reads the repo-local pi-zflow config files used by workflow packages.
 * The loader is intentionally tolerant: missing files are ignored, malformed
 * JSON emits a warning and falls through to later candidates.
 *
 * @module pi-zflow-change-workflows/repo-config
 */

import * as path from "node:path"
import * as fs from "node:fs/promises"
import type { WorktreeSetupHookConfig } from "pi-zflow-core/worktree-setup-hook"

/**
 * Well-known config file names to search for repo-local zflow configuration.
 * Order matters — first successfully parsed file wins.
 */
export const ZFLOW_CONFIG_FILE_CANDIDATES = [
  ".pi/zflow/config.json",
  "pi-zflow.config.json",
  ".pi-zflow.config.json",
] as const

export interface RepoBashGuardConfig {
  /** Allow these command prefixes even if they are not built into the default safe list. */
  allowCommandPrefixes?: string[]
  /** Deny these command prefixes even if they would otherwise be allowed. */
  denyCommandPrefixes?: string[]
  /** Allow these executables as read-only commands when they do not match destructive rules. */
  allowExecutables?: string[]
  /** Deny these executables even if they are otherwise allowed. */
  denyExecutables?: string[]
  /**
   * Allow top-level chaining/piping only when every segment is individually
   * read-only and path-safe. Default: true.
   */
  allowReadOnlyChaining?: boolean
}

export interface RepoZflowConfig {
  worktreeSetupHook?: WorktreeSetupHookConfig | null
  bashGuard?: RepoBashGuardConfig
  [key: string]: unknown
}

export interface LoadedRepoZflowConfig {
  config: RepoZflowConfig
  configPath?: string
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const normalized = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean)
  return normalized.length > 0 ? normalized : undefined
}

function normalizeWorktreeSetupHook(value: unknown): WorktreeSetupHookConfig | null | undefined {
  if (value === null) return null
  if (!value || typeof value !== "object") return undefined

  const candidate = value as Record<string, unknown>
  if (typeof candidate.script !== "string" || !candidate.script.trim()) {
    return undefined
  }

  return {
    script: candidate.script.trim(),
    runtime: candidate.runtime === "shell" || candidate.runtime === "node" || candidate.runtime === "module"
      ? candidate.runtime
      : undefined,
    timeoutMs: typeof candidate.timeoutMs === "number" ? candidate.timeoutMs : undefined,
    description: typeof candidate.description === "string" ? candidate.description : undefined,
  }
}

function normalizeBashGuardConfig(value: unknown): RepoBashGuardConfig | undefined {
  if (!value || typeof value !== "object") return undefined

  const candidate = value as Record<string, unknown>
  const normalized: RepoBashGuardConfig = {
    allowCommandPrefixes: normalizeStringArray(candidate.allowCommandPrefixes),
    denyCommandPrefixes: normalizeStringArray(candidate.denyCommandPrefixes),
    allowExecutables: normalizeStringArray(candidate.allowExecutables),
    denyExecutables: normalizeStringArray(candidate.denyExecutables),
    allowReadOnlyChaining: typeof candidate.allowReadOnlyChaining === "boolean"
      ? candidate.allowReadOnlyChaining
      : undefined,
  }

  if (
    !normalized.allowCommandPrefixes &&
    !normalized.denyCommandPrefixes &&
    !normalized.allowExecutables &&
    !normalized.denyExecutables &&
    normalized.allowReadOnlyChaining === undefined
  ) {
    return undefined
  }

  return normalized
}

function normalizeRepoConfig(raw: Record<string, unknown>): RepoZflowConfig {
  const normalized: RepoZflowConfig = { ...raw }

  if ("worktreeSetupHook" in raw) {
    normalized.worktreeSetupHook = normalizeWorktreeSetupHook(raw.worktreeSetupHook)
  }

  if ("bashGuard" in raw) {
    normalized.bashGuard = normalizeBashGuardConfig(raw.bashGuard)
  }

  return normalized
}

/**
 * Load repo-local zflow config from the first valid candidate file.
 */
export async function loadRepoZflowConfig(
  repoRoot: string,
): Promise<LoadedRepoZflowConfig> {
  for (const candidate of ZFLOW_CONFIG_FILE_CANDIDATES) {
    const configPath = path.join(repoRoot, candidate)
    try {
      const content = await fs.readFile(configPath, "utf-8")
      const parsed = JSON.parse(content) as Record<string, unknown>
      return {
        config: normalizeRepoConfig(parsed),
        configPath,
      }
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        continue
      }
      if (err instanceof Error) {
        console.warn(
          `[zflow] Repo config file exists but cannot be parsed: ${configPath} — ${err.message}`,
        )
      }
    }
  }

  return { config: {} }
}
