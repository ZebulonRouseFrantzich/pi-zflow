/**
 * install.ts — Agent/chain installation and update flow.
 *
 * Provides the `/zflow-setup-agents` and `/zflow-update-agents` command
 * handlers via the extension activation function.
 *
 * Uses the core `agent-discovery.ts` module for the actual file copy/install
 * logic, and `manifest.ts` for install manifest management.
 *
 * @module pi-zflow-agents/install
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { ensureUserDirs } from "pi-zflow-core/user-dirs"
import type { InstallManifest } from "pi-zflow-core/schemas"
import { readManifest, writeManifest, diffManifest, type ManifestDiff } from "./manifest.js"

// ── Path resolution ──────────────────────────────────────────────

function getPackageRoot(): string {
  const extRoot = dirname(fileURLToPath(import.meta.url))
  // Extension is at <pkg>/extensions/zflow-agents/install.ts
  // Package root is two levels up
  return resolve(extRoot, "..", "..")
}

/**
 * Resolve the source paths for agents and chains.
 */
function getSourcePaths(): { agentsDir: string; chainsDir: string } {
  const pkgRoot = getPackageRoot()
  return {
    agentsDir: resolve(pkgRoot, "agents"),
    chainsDir: resolve(pkgRoot, "chains"),
  }
}

/**
 * Resolve the target paths for installation.
 */
function getTargetPaths(): { agentsDir: string; chainsDir: string } {
  // Install to ~/.pi/agent/agents/zflow/ and ~/.pi/agent/chains/zflow/
  const homeDir = process.env.HOME || process.env.USERPROFILE || "/tmp"
  return {
    agentsDir: resolve(homeDir, ".pi", "agent", "agents", "zflow"),
    chainsDir: resolve(homeDir, ".pi", "agent", "chains", "zflow"),
  }
}

// ── Agent/chain file listing ─────────────────────────────────────

async function listMarkdownFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

async function listChainFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".chain.md"))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

// ── Idempotent copy ──────────────────────────────────────────────

async function computeFileHash(filePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8")
    const { createHash } = await import("node:crypto")
    return createHash("sha256").update(content).digest("hex")
  } catch {
    return null
  }
}

async function idempotentCopy(
  srcDir: string,
  destDir: string,
  fileName: string,
  force: boolean,
  knownHashes?: Map<string, string>,
  update?: boolean,
): Promise<{ copied: boolean; error?: string; skipped?: string }> {
  const srcPath = path.join(srcDir, fileName)
  const destPath = path.join(destDir, fileName)

  // Ensure target dir exists
  await fs.mkdir(destDir, { recursive: true })

  // Check if target exists
  const destHash = await computeFileHash(destPath)

  if (destHash !== null) {
    // File exists at target
    const srcHash = knownHashes?.get(fileName) ?? await computeFileHash(srcPath)

    if (srcHash !== null && srcHash === destHash) {
      return { copied: false } // Files are identical, nothing to do
    }

    if (srcHash !== null && !force && !update) {
      // Files differ and this is not an update — protect potential user edits
      return {
        copied: false,
        skipped: `"${fileName}" exists with different content. Use /zflow-update-agents or --force to overwrite.`,
      }
    }
    // force=true, update=true, or hash unavailable — proceed to overwrite
  }

  // Copy the file
  try {
    await fs.copyFile(srcPath, destPath)
    return { copied: true }
  } catch (err: unknown) {
    return { copied: false, error: `Failed to copy ${fileName}: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Options for agent/chain installation.
 */
export interface InstallOptions {
  /** Force overwrite of user-edited files */
  force?: boolean
  /** Whether this is an update (different messaging) */
  update?: boolean
}

/**
 * Result of an installation operation.
 */
export interface InstallResult {
  /** Number of agents installed/copied */
  agentsInstalled: number
  /** Number of chains installed/copied */
  chainsInstalled: number
  /** Number of agents already up to date */
  agentsUpToDate: number
  /** Number of chains already up to date */
  chainsUpToDate: number
  /** List of errors encountered */
  errors: string[]
  /** List of warnings (e.g. skipped files due to content drift) */
  warnings: string[]
  /** Whether the operation was successful overall */
  success: boolean
}

/**
 * Install or update agents and chains from the package to user-level directories.
 *
 * This is the main entrypoint called by `/zflow-setup-agents` and
 * `/zflow-update-agents` command handlers.
 *
 * @param options - Installation options.
 * @returns Installation result with counts and errors.
 */
export async function installAgentsAndChains(
  options: InstallOptions = {},
): Promise<InstallResult> {
  const { agentsDir: srcAgents, chainsDir: srcChains } = getSourcePaths()
  const { agentsDir: destAgents, chainsDir: destChains } = getTargetPaths()

  // Ensure user directories exist
  await ensureUserDirs()

  // Read existing manifest
  const existingManifest = await readManifest()

  // List available files
  const agentFiles = await listMarkdownFiles(srcAgents)
  const chainFiles = await listChainFiles(srcChains)

  // If existing manifest, check for version drift
  const isUpdate = options.update && existingManifest !== null

  // Pre-compute source hashes for idempotent copy
  const srcHashes = new Map<string, string>()
  for (const file of [...agentFiles, ...chainFiles]) {
    const hash = await computeFileHash(path.join(srcAgents, file)) || await computeFileHash(path.join(srcChains, file))
    if (hash) srcHashes.set(file, hash)
  }

  // Copy agents
  const agentErrors: string[] = []
  const agentWarnings: string[] = []
  let agentsInstalled = 0
  let agentsUpToDate = 0

  for (const file of agentFiles) {
    const result = await idempotentCopy(srcAgents, destAgents, file, options.force ?? false, srcHashes, isUpdate)
    if (result.copied) {
      agentsInstalled++
    } else if (result.skipped) {
      agentWarnings.push(result.skipped)
      agentsUpToDate++
    } else if (!result.error) {
      agentsUpToDate++
    }
    if (result.error) agentErrors.push(result.error)
  }

  // Copy chains
  const chainErrors: string[] = []
  const chainWarnings: string[] = []
  let chainsInstalled = 0
  let chainsUpToDate = 0

  for (const file of chainFiles) {
    const result = await idempotentCopy(srcChains, destChains, file, options.force ?? false, srcHashes, isUpdate)
    if (result.copied) {
      chainsInstalled++
    } else if (result.skipped) {
      chainWarnings.push(result.skipped)
      chainsUpToDate++
    } else if (!result.error) {
      chainsUpToDate++
    }
    if (result.error) chainErrors.push(result.error)
  }

  // Write manifest
  const { createRequire } = await import("node:module")
  const _require = createRequire(import.meta.url)
  const pkgPath = _require.resolve("pi-zflow-agents/package.json")
  const pkgJson = JSON.parse(await fs.readFile(pkgPath, "utf-8"))
  const packageVersion: string = pkgJson.version ?? "0.1.0"

  const now = new Date().toISOString()
  const manifest: InstallManifest = {
    packageVersion,
    source: `npm:pi-zflow-agents@${packageVersion}`,
    installedAt: existingManifest?.installedAt ?? now,
    updatedAt: now,
    installedAgents: agentFiles,
    installedChains: chainFiles,
    installedSkills: [],
  }

  await writeManifest(manifest)

  const errors = [...agentErrors, ...chainErrors]
  const warnings = [...agentWarnings, ...chainWarnings]

  return {
    agentsInstalled,
    chainsInstalled,
    agentsUpToDate,
    chainsUpToDate,
    errors,
    warnings,
    success: errors.length === 0,
  }
}

/**
 * Check whether agent installation is up to date.
 *
 * Compares the install manifest against the current package version
 * and available agent/chain files.
 *
 * @returns A manifest diff or null if no manifest exists.
 */
export async function checkInstallStatus(): Promise<ManifestDiff | null> {
  const manifest = await readManifest()
  if (!manifest) return null

  const { agentsDir, chainsDir } = getSourcePaths()
  const agentFiles = await listMarkdownFiles(agentsDir)
  const chainFiles = await listChainFiles(chainsDir)

  const { createRequire } = await import("node:module")
  const _require = createRequire(import.meta.url)
  const pkgPath = _require.resolve("pi-zflow-agents/package.json")
  const pkgJson = JSON.parse(await fs.readFile(pkgPath, "utf-8"))
  const packageVersion: string = pkgJson.version ?? "0.1.0"

  return diffManifest(manifest, packageVersion, agentFiles, chainFiles)
}

/**
 * Build a human-readable summary of the installation result.
 */
export function formatInstallSummary(result: InstallResult, isUpdate: boolean): string {
  const lines: string[] = []

  if (isUpdate) {
    lines.push(`Agent update complete.`)
  } else {
    lines.push(`Agent setup complete.`)
  }

  lines.push(
    `  Agents: ${result.agentsInstalled} installed, ${result.agentsUpToDate} up to date`,
    `  Chains: ${result.chainsInstalled} installed, ${result.chainsUpToDate} up to date`,
  )

  if (result.warnings.length > 0) {
    lines.push(
      `  Warnings: ${result.warnings.length}`,
      "",
      `  ⚠️  The following files differ from the source and were NOT overwritten:`,
    )
    for (const w of result.warnings.slice(0, 5)) {
      lines.push(`    - ${w}`)
    }
    if (result.warnings.length > 5) {
      lines.push(`    ... and ${result.warnings.length - 5} more`)
    }
    lines.push(
      "",
      `  To overwrite with package versions, run with --force.`,
    )
  }

  if (result.errors.length > 0) {
    lines.push(`  Errors: ${result.errors.length}`, "")
    for (const err of result.errors.slice(0, 5)) {
      lines.push(`    - ${err}`)
    }
    if (result.errors.length > 5) {
      lines.push(`    ... and ${result.errors.length - 5} more`)
    }
  }

  return lines.join("\n")
}
