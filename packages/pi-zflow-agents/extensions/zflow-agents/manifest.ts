/**
 * manifest.ts — Install manifest tracking for deployed agents and chains.
 *
 * @module pi-zflow-agents/manifest
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import { INSTALL_MANIFEST_PATH } from "pi-zflow-core/user-dirs"
import type { InstallManifest } from "pi-zflow-core/schemas"

/**
 * Read the install manifest from disk.
 *
 * Reads `~/.pi/agent/zflow/install-manifest.json`.
 * Returns `null` if the file does not exist.
 * Throws with a clear error if the file is malformed.
 */
export async function readManifest(): Promise<InstallManifest | null> {
  try {
    const raw = await fs.readFile(INSTALL_MANIFEST_PATH, "utf-8")
    const parsed = JSON.parse(raw) as InstallManifest

    // Basic validation
    if (!parsed.version || !parsed.installedAgents) {
      throw new Error("Install manifest is missing required fields")
    }

    return parsed
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException
    if (nodeErr.code === "ENOENT") {
      return null
    }
    if (err instanceof SyntaxError) {
      throw new Error(
        `Install manifest at ${INSTALL_MANIFEST_PATH} is malformed: ${err.message}`,
      )
    }
    throw err
  }
}

/**
 * Write the install manifest to disk atomically.
 *
 * Creates parent directories if needed.
 * Uses atomic write (.tmp → rename) to prevent corruption.
 */
export async function writeManifest(manifest: InstallManifest): Promise<void> {
  const dir = path.dirname(INSTALL_MANIFEST_PATH)
  await fs.mkdir(dir, { recursive: true })

  const tmpPath = INSTALL_MANIFEST_PATH + ".tmp"
  await fs.writeFile(tmpPath, JSON.stringify(manifest, null, 2), "utf-8")
  await fs.rename(tmpPath, INSTALL_MANIFEST_PATH)
}

/**
 * Result of comparing the manifest against the current package state.
 */
export interface ManifestDiff {
  /** Whether the package version has changed */
  versionChanged: boolean
  /** Old version from the manifest, or null */
  oldVersion: string | null
  /** New package version */
  newVersion: string
  /** Agents in the package but not in the manifest */
  missingAgents: string[]
  /** Chains in the package but not in the manifest */
  missingChains: string[]
  /** Agents in the manifest but no longer in the package (stale) */
  extraAgents: string[]
  /** Chains in the manifest but no longer in the package (stale) */
  extraChains: string[]
  /** Whether an update is needed */
  needsUpdate: boolean
}

/**
 * Compare the manifest against the current package state.
 *
 * @param manifest - The existing install manifest.
 * @param packageVersion - Current package version.
 * @param knownAgentFiles - List of agent file names in the package.
 * @param knownChainFiles - List of chain file names in the package.
 * @returns A diff describing what has changed.
 */
export function diffManifest(
  manifest: InstallManifest,
  packageVersion: string,
  knownAgentFiles: string[],
  knownChainFiles: string[],
): ManifestDiff {
  const versionChanged = manifest.version !== packageVersion

  // Find missing agents/chains
  const missingAgents = knownAgentFiles.filter(
    (f) => !manifest.installedAgents.includes(f),
  )
  const missingChains = knownChainFiles.filter(
    (f) => !manifest.installedChains.includes(f),
  )

  // Find extra agents/chains (stale)
  const extraAgents = manifest.installedAgents.filter(
    (f) => !knownAgentFiles.includes(f),
  )
  const extraChains = manifest.installedChains.filter(
    (f) => !knownChainFiles.includes(f),
  )

  return {
    versionChanged,
    oldVersion: manifest.version,
    newVersion: packageVersion,
    missingAgents,
    missingChains,
    extraAgents,
    extraChains,
    needsUpdate: versionChanged || missingAgents.length > 0 || missingChains.length > 0,
  }
}
