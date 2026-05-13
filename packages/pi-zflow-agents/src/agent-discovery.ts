/**
 * agent-discovery.ts — Agent and chain discovery/install module.
 *
 * Ensures the `zflow.*` agent files created in Phase 1 can be discovered
 * and launched by `pi-subagents`. Handles installation (copying source
 * markdown to user-level Pi directories), discovery (listing installed
 * agents and chains), and verification (confirming installed assets are
 * findable by the runtime).
 *
 * ## Design rules
 *
 * - User-level install is the default. Project-level install is opt-in
 *   and can be added later.
 * - Agent files install to `~/.pi/agent/agents/zflow/` so they are
 *   namespaced under the `zflow.*` runtime naming scheme.
 * - Chain files install directly to `~/.pi/agent/chains/` since chains
 *   are discovered by their `.chain.md` filename and the frontmatter
 *   `name` field.
 * - Runtime names must resolve as `zflow.<name>` (e.g. `zflow.planner-frontier`).
 * - Name collisions with builtin agents are detected and reported.
 *
 * @module pi-zflow-agents/agent-discovery
 */

import { readFileSync, existsSync, readdirSync, mkdirSync, copyFileSync, unlinkSync, writeFileSync, renameSync, statSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import { createHash } from "node:crypto"

// ── Package root resolution ─────────────────────────────────────

/**
 * Resolve the package root directory.
 *
 * When loaded from the source tree (via tsx), uses `import.meta.url`.
 * Consumers may override `customPackageRoot` for testing or when
 * the module is installed to a different path.
 *
 * The package root is expected to contain `agents/`, `chains/`,
 * `skills/`, and `prompt-fragments/` directories as siblings
 * to `src/`.
 */
function resolvePackageRoot(customPath?: string): string {
  if (customPath) return customPath
  const thisFile = fileURLToPath(import.meta.url)
  // src/agent-discovery.ts → packages/pi-zflow-agents
  return resolve(dirname(thisFile), "..")
}

// ── Path helpers ────────────────────────────────────────────────

/** User-level Pi data directory. */
const PI_USER_DIR = resolve(homedir(), ".pi")

/** Agent install target for zflow agents. */
const ZFLOW_AGENTS_DIR = resolve(PI_USER_DIR, "agent", "agents", "zflow")

/** Chain install target. */
const ZFLOW_CHAINS_DIR = resolve(PI_USER_DIR, "agent", "chains")

/** Install manifest directory. */
const ZFLOW_MANIFEST_DIR = resolve(PI_USER_DIR, "agent", "zflow")

/** Install manifest file path. */
const ZFLOW_MANIFEST_PATH = resolve(ZFLOW_MANIFEST_DIR, "install-manifest.json")

// ── Types ───────────────────────────────────────────────────────

/** Options for install operations. */
export interface InstallOptions {
  /** Override package root for testing. */
  customPackageRoot?: string
  /** When true, overwrite existing files even if identical. */
  force?: boolean
  /** When true, skip hash comparison and always copy. */
  skipHashCheck?: boolean
  /** Custom install target for agents (default: ~/.pi/agent/agents/zflow). */
  customAgentsTarget?: string
  /** Custom install target for chains (default: ~/.pi/agent/chains). */
  customChainsTarget?: string
  /** When true, suppress logging. */
  silent?: boolean
}

/** Result of an install operation. */
export interface InstallResult {
  /** Number of files installed (copied). */
  installed: number
  /** Number of files skipped (already up to date). */
  skipped: number
  /** Number of errors encountered. */
  errors: number
  /** Error details, if any. */
  errorDetails: string[]
  /** List of installed agent file paths (relative to target dir). */
  installedAgents: string[]
  /** List of installed chain file paths (relative to target dir). */
  installedChains: string[]
  /** Informational messages about the install operation. */
  messages: string[]
}

/** Information about an installed agent. */
export interface InstalledAgentInfo {
  /** Runtime name (e.g. "zflow.planner-frontier"). */
  name: string
  /** Full path to the agent markdown file. */
  path: string
  /** File size in bytes. */
  size: number
  /** Last modified timestamp (ISO string). */
  modifiedAt: string
}

/** Information about an installed chain. */
export interface InstalledChainInfo {
  /** Chain name from frontmatter (e.g. "scout-plan-validate"). */
  name: string
  /** Full path to the chain markdown file. */
  path: string
  /** File size in bytes. */
  size: number
  /** Last modified timestamp (ISO string). */
  modifiedAt: string
}

/** Result of a discovery verification check. */
export interface DiscoveryVerificationResult {
  /** Whether all agents and chains are discoverable. */
  success: boolean
  /** List of agents that are present and correctly named. */
  validAgents: string[]
  /** List of agents with naming issues. */
  invalidAgents: { name: string; issue: string }[]
  /** List of chains that are present. */
  validChains: string[]
  /** List of chains with issues. */
  invalidChains: { name: string; issue: string }[]
  /** Possible name collisions with builtin agents. */
  collisions: { name: string; collisionPath: string }[]
  /** Detailed messages. */
  messages: string[]
}

// ── Builtin agent names (pi-subagents builtins) ─────────────────

/** Set of known pi-subagents builtin agent names to check for collisions. */
const BUILTIN_AGENT_NAMES = new Set([
  "scout",
  "context-builder",
  "planner",
  "writer",
  "architect",
  "debugger",
  "code-reviewer",
  "spec-writer",
  "explainer",
  "translator",
])

// ── Internal helpers ────────────────────────────────────────────

/**
 * Compute a simple SHA-256 hex hash of a file's content.
 * Uses a synchronous approach compatible with Node.js built-in crypto.
 */
function hashFile(filePath: string): string {
  const content = readFileSync(filePath)
  return createHash("sha256").update(content).digest("hex")
}

/**
 * Get the source directory for agent files.
 */
function getSourceAgentsDir(packageRoot: string): string {
  return resolve(packageRoot, "agents")
}

/**
 * Get the source directory for chain files.
 */
function getSourceChainsDir(packageRoot: string): string {
  return resolve(packageRoot, "chains")
}

/**
 * List agent markdown files in the source directory.
 */
function listSourceAgentFiles(packageRoot: string): string[] {
  const agentsDir = getSourceAgentsDir(packageRoot)
  if (!existsSync(agentsDir)) return []
  return readdirSync(agentsDir)
    .filter((f) => f.endsWith(".md") && !f.endsWith(".chain.md"))
    .sort()
}

/**
 * List chain markdown files in the source directory.
 */
function listSourceChainFiles(packageRoot: string): string[] {
  const chainsDir = getSourceChainsDir(packageRoot)
  if (!existsSync(chainsDir)) return []
  return readdirSync(chainsDir)
    .filter((f) => f.endsWith(".chain.md"))
    .sort()
}

/**
 * Ensure a directory exists, creating it and any parents if needed.
 */
function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true })
  }
}

/**
 * Extract agent runtime name from an agent markdown filename.
 *
 * Convention: `planner-frontier.md` → `zflow.planner-frontier`
 * The `package: zflow` in frontmatter confirms the namespace.
 */
function agentFileNameToRuntimeName(filename: string): string {
  const name = filename.replace(/\.md$/, "")
  return `zflow.${name}`
}

/**
 * Extract chain name from a chain markdown filename.
 *
 * Convention: `scout-plan-validate.chain.md` → `scout-plan-validate`
 */
function chainFileNameToName(filename: string): string {
  return filename.replace(/\.chain\.md$/, "")
}

/**
 * Check if a name collides with a known builtin agent.
 */
function checkNameCollision(runtimeName: string): { collides: boolean; builtinName?: string } {
  // Strip the zflow. prefix for comparison
  const shortName = runtimeName.startsWith("zflow.") ? runtimeName.slice(6) : runtimeName
  if (BUILTIN_AGENT_NAMES.has(shortName)) {
    return { collides: true, builtinName: shortName }
  }
  return { collides: false }
}

/**
 * Write a file atomically: write to a temp file, then rename.
 */
function atomicWrite(targetPath: string, content: Buffer | string): void {
  const tmpPath = targetPath + ".tmp." + Date.now()
  writeFileSync(tmpPath, content)
  renameSync(tmpPath, targetPath)
}

// ── Main API ────────────────────────────────────────────────────

/**
 * Install agent markdown files from the package to the user-level
 * Pi agents directory.
 *
 * Copies all `.md` files (that are not `.chain.md`) from
 * `<packageRoot>/agents/` to `~/.pi/agent/agents/zflow/`.
 *
 * Uses hash-based idempotent copy: if the target file exists and has
 * the same SHA-256 hash, it is skipped.
 *
 * @param options - Install options (package root override, force, etc.)
 * @returns Result with counts of installed/skipped/errored files.
 */
export function installAgents(options: InstallOptions = {}): InstallResult {
  const packageRoot = resolvePackageRoot(options.customPackageRoot)
  const agentsDir = getSourceAgentsDir(packageRoot)
  const targetDir = options.customAgentsTarget || ZFLOW_AGENTS_DIR

  const result: InstallResult = {
    installed: 0,
    skipped: 0,
    errors: 0,
    errorDetails: [],
    installedAgents: [],
    installedChains: [],
  }

  if (!existsSync(agentsDir)) {
    result.messages = [`Agent source directory not found: ${agentsDir}`]
    if (!options.silent) {
      console.warn(`[agent-discovery] Warning: Source agents directory not found: ${agentsDir}`)
    }
    return result
  }

  ensureDir(targetDir)
  const sourceFiles = listSourceAgentFiles(packageRoot)

  for (const filename of sourceFiles) {
    try {
      const sourcePath = resolve(agentsDir, filename)
      const targetPath = resolve(targetDir, filename)

      // Idempotent copy: skip if hashes match
      if (!options.force && existsSync(targetPath)) {
        const sourceHash = hashFile(sourcePath)
        const targetHash = hashFile(targetPath)
        if (sourceHash === targetHash) {
          result.skipped++
          result.installedAgents.push(filename)
          continue
        }
      }

      // Copy the file
      copyFileSync(sourcePath, targetPath)
      result.installed++
      result.installedAgents.push(filename)

      if (!options.silent) {
        console.log(`[agent-discovery] Installed agent: ${filename}`)
      }
    } catch (err: any) {
      result.errors++
      const msg = `Failed to install agent ${filename}: ${err.message}`
      result.errorDetails.push(msg)
      if (!options.silent) {
        console.error(`[agent-discovery] Error: ${msg}`)
      }
    }
  }

  return result
}

/**
 * Install chain markdown files from the package to the user-level
 * Pi chains directory.
 *
 * Copies all `.chain.md` files from `<packageRoot>/chains/` to
 * `~/.pi/agent/chains/`.
 *
 * Uses hash-based idempotent copy: if the target file exists and has
 * the same SHA-256 hash, it is skipped.
 *
 * @param options - Install options.
 * @returns Result with counts of installed/skipped/errored files.
 */
export function installChains(options: InstallOptions = {}): InstallResult {
  const packageRoot = resolvePackageRoot(options.customPackageRoot)
  const chainsDir = getSourceChainsDir(packageRoot)
  const targetDir = options.customChainsTarget || ZFLOW_CHAINS_DIR

  const result: InstallResult = {
    installed: 0,
    skipped: 0,
    errors: 0,
    errorDetails: [],
    installedAgents: [],
    installedChains: [],
  }

  if (!existsSync(chainsDir)) {
    if (!options.silent) {
      console.warn(`[agent-discovery] Warning: Source chains directory not found: ${chainsDir}`)
    }
    return result
  }

  ensureDir(targetDir)
  const sourceFiles = listSourceChainFiles(packageRoot)

  for (const filename of sourceFiles) {
    try {
      const sourcePath = resolve(chainsDir, filename)
      const targetPath = resolve(targetDir, filename)

      // Idempotent copy: skip if hashes match
      if (!options.force && existsSync(targetPath)) {
        const sourceHash = hashFile(sourcePath)
        const targetHash = hashFile(targetPath)
        if (sourceHash === targetHash) {
          result.skipped++
          result.installedChains.push(filename)
          continue
        }
      }

      // Copy the file
      copyFileSync(sourcePath, targetPath)
      result.installed++
      result.installedChains.push(filename)

      if (!options.silent) {
        console.log(`[agent-discovery] Installed chain: ${filename}`)
      }
    } catch (err: any) {
      result.errors++
      const msg = `Failed to install chain ${filename}: ${err.message}`
      result.errorDetails.push(msg)
      if (!options.silent) {
        console.error(`[agent-discovery] Error: ${msg}`)
      }
    }
  }

  return result
}

/**
 * Install all agents and chains.
 *
 * Equivalent to calling `installAgents()` then `installChains()`.
 *
 * @param options - Install options.
 * @returns Combined install result.
 */
export function installAll(options: InstallOptions = {}): InstallResult {
  const agentResult = installAgents(options)
  const chainResult = installChains(options)

  return {
    installed: agentResult.installed + chainResult.installed,
    skipped: agentResult.skipped + chainResult.skipped,
    errors: agentResult.errors + chainResult.errors,
    errorDetails: [...agentResult.errorDetails, ...chainResult.errorDetails],
    installedAgents: agentResult.installedAgents,
    installedChains: chainResult.installedChains,
  }
}

/**
 * Write the install manifest after successful installation.
 *
 * Records which files were installed, the package version, and timestamps.
 *
 * @param manifest - Install manifest data.
 */
export function writeInstallManifest(manifest: {
  version: string
  source: string
  installedAgents: string[]
  installedChains: string[]
}): void {
  const now = new Date().toISOString()

  // Read existing manifest if present
  let existing: any = {}
  if (existsSync(ZFLOW_MANIFEST_PATH)) {
    try {
      existing = JSON.parse(readFileSync(ZFLOW_MANIFEST_PATH, "utf-8"))
    } catch {
      // Corrupt manifest — start fresh
    }
  }

  const fullManifest = {
    version: manifest.version,
    source: manifest.source || "local:pi-zflow-agents",
    installedAt: existing.installedAt || now,
    updatedAt: now,
    installedAgents: [...new Set([...(existing.installedAgents || []), ...manifest.installedAgents])].sort(),
    installedChains: [...new Set([...(existing.installedChains || []), ...manifest.installedChains])].sort(),
    installedSkills: existing.installedSkills || [],
  }

  ensureDir(ZFLOW_MANIFEST_DIR)
  atomicWrite(ZFLOW_MANIFEST_PATH, JSON.stringify(fullManifest, null, 2))
}

/**
 * Read the install manifest.
 *
 * @returns The parsed manifest, or null if it doesn't exist.
 */
export function readInstallManifest(): Record<string, unknown> | null {
  if (!existsSync(ZFLOW_MANIFEST_PATH)) return null
  try {
    return JSON.parse(readFileSync(ZFLOW_MANIFEST_PATH, "utf-8"))
  } catch {
    return null
  }
}

/**
 * Get a list of installed zflow agents.
 *
 * Scans `~/.pi/agent/agents/zflow/` for `.md` files and returns
 * information about each installed agent.
 *
 * @returns Array of installed agent information.
 */
export function getInstalledAgents(): InstalledAgentInfo[] {
  const agentsDir = ZFLOW_AGENTS_DIR

  if (!existsSync(agentsDir)) return []

  try {
    const files = readdirSync(agentsDir)
      .filter((f) => f.endsWith(".md") && !f.endsWith(".chain.md"))
      .sort()

    return files.map((filename) => {
      const filePath = resolve(agentsDir, filename)
      const stat = statSync(filePath)
      return {
        name: agentFileNameToRuntimeName(filename),
        path: filePath,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      }
    })
  } catch {
    return []
  }
}

/**
 * Get a list of installed chains.
 *
 * Scans `~/.pi/agent/chains/` for `.chain.md` files and returns
 * information about each installed chain.
 *
 * @returns Array of installed chain information.
 */
export function getInstalledChains(): InstalledChainInfo[] {
  const chainsDir = ZFLOW_CHAINS_DIR

  if (!existsSync(chainsDir)) return []

  try {
    const files = readdirSync(chainsDir)
      .filter((f) => f.endsWith(".chain.md"))
      .sort()

    return files.map((filename) => {
      const filePath = resolve(chainsDir, filename)
      const stat = statSync(filePath)
      return {
        name: chainFileNameToName(filename),
        path: filePath,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      }
    })
  } catch {
    return []
  }
}

/**
 * Resolve the file path for a specific zflow agent by runtime name.
 *
 * @param agentName - Runtime agent name (e.g. "zflow.planner-frontier").
 * @returns The full path to the agent markdown file, or null if not found.
 */
export function getAgentPath(agentName: string): string | null {
  // Strip zflow. prefix if present to get the filename
  const shortName = agentName.startsWith("zflow.") ? agentName.slice(6) : agentName
  const filePath = resolve(ZFLOW_AGENTS_DIR, `${shortName}.md`)

  if (existsSync(filePath)) return filePath

  // Also check without the zflow prefix
  const altPath = resolve(ZFLOW_AGENTS_DIR, `${agentName}.md`)
  if (existsSync(altPath)) return altPath

  return null
}

/**
 * Resolve the file path for a specific chain by name.
 *
 * @param chainName - Chain name (e.g. "scout-plan-validate").
 * @returns The full path to the chain markdown file, or null if not found.
 */
export function getChainPath(chainName: string): string | null {
  // Try with .chain.md extension
  const filePath = resolve(ZFLOW_CHAINS_DIR, `${chainName}.chain.md`)
  if (existsSync(filePath)) return filePath

  // Try without extension if it was already included
  const altName = chainName.replace(/\.chain\.md$/, "")
  if (altName !== chainName) {
    const altPath = resolve(ZFLOW_CHAINS_DIR, `${altName}.chain.md`)
    if (existsSync(altPath)) return altPath
  }

  return null
}

/**
 * Verify that installed zflow agents and chains are discoverable.
 *
 * Checks:
 * - All expected source files are present in the install target.
 * - Agent runtime names follow the `zflow.*` convention.
 * - No name collisions with known pi-subagents builtins.
 * - File paths are resolvable.
 *
 * @param options - Options including optional package root for source comparison.
 * @returns Verification result with details.
 */
export function verifyDiscovery(options: InstallOptions = {}): DiscoveryVerificationResult {
  const packageRoot = resolvePackageRoot(options.customPackageRoot)
  const result: DiscoveryVerificationResult = {
    success: true,
    validAgents: [],
    invalidAgents: [],
    validChains: [],
    invalidChains: [],
    collisions: [],
    messages: [],
  }

  // ── Check agents ────────────────────────────────────────────────
  const sourceAgentFiles = listSourceAgentFiles(packageRoot)
  const installedAgents = getInstalledAgents()

  if (sourceAgentFiles.length === 0) {
    result.messages.push("Warning: No source agent files found in package.")
    result.success = false
  }

  // Check each expected source agent is installed
  for (const filename of sourceAgentFiles) {
    const runtimeName = agentFileNameToRuntimeName(filename)
    const installed = installedAgents.find((a) => a.name === runtimeName)

    if (installed) {
      result.validAgents.push(runtimeName)

      // Check for name collisions
      const collision = checkNameCollision(runtimeName)
      if (collision.collides) {
        // Find where the builtin lives
        const builtinPath = resolve(PI_USER_DIR, "agent", "agents", `${collision.builtinName}.md`)
        result.collisions.push({
          name: runtimeName,
          collisionPath: builtinPath,
        })
        result.messages.push(
          `Warning: Agent "${runtimeName}" may collide with builtin "${collision.builtinName}". ` +
          `The zflow.* prefix should distinguish it at runtime, but be aware of potential confusion.`,
        )
      }
    } else {
      result.invalidAgents.push({
        name: runtimeName,
        issue: `Expected agent "${filename}" not found in install target. Run installAgents() first.`,
      })
      result.success = false
    }
  }

  // Check for unexpected files in the install directory
  const agentsDir = ZFLOW_AGENTS_DIR
  if (existsSync(agentsDir)) {
    const allFiles = readdirSync(agentsDir).filter((f) => f.endsWith(".md") && !f.endsWith(".chain.md"))
    for (const f of allFiles) {
      if (!sourceAgentFiles.includes(f)) {
        result.messages.push(`Note: File "${f}" exists in install target but not in package source. It may be from another source.`)
      }
    }
  }

  // ── Check chains ────────────────────────────────────────────────
  const sourceChainFiles = listSourceChainFiles(packageRoot)
  const installedChains = getInstalledChains()

  if (sourceChainFiles.length === 0) {
    result.messages.push("Warning: No source chain files found in package.")
    result.success = false
  }

  for (const filename of sourceChainFiles) {
    const chainName = chainFileNameToName(filename)
    const installed = installedChains.find((c) => c.name === chainName)

    if (installed) {
      result.validChains.push(chainName)
    } else {
      result.invalidChains.push({
        name: chainName,
        issue: `Expected chain "${filename}" not found in install target. Run installChains() first.`,
      })
      result.success = false
    }
  }

  // ── Summary ─────────────────────────────────────────────────────
  if (result.success) {
    result.messages.push(
      `Discovery verification passed: ${result.validAgents.length} agents, ${result.validChains.length} chains.`,
    )
  } else {
    result.messages.push(
      `Discovery verification FAILED: ${result.invalidAgents.length} invalid agents, ${result.invalidChains.length} invalid chains.`,
    )
  }

  if (result.collisions.length > 0) {
    result.messages.push(
      `Name collisions detected: ${result.collisions.length}. Review the collision list and verify correct behavior.`,
    )
  }

  return result
}

/**
 * Remove all installed zflow agent and chain files.
 *
 * @param options - Options including custom targets.
 * @returns Number of files removed.
 */
export function uninstallAll(options: InstallOptions = {}): { removedAgents: number; removedChains: number } {
  const agentsDir = options.customAgentsTarget || ZFLOW_AGENTS_DIR
  const chainsDir = options.customChainsTarget || ZFLOW_CHAINS_DIR

  let removedAgents = 0
  let removedChains = 0

  // Remove agent files
  if (existsSync(agentsDir)) {
    const files = readdirSync(agentsDir).filter((f) => f.endsWith(".md"))
    for (const f of files) {
      try {
        unlinkSync(resolve(agentsDir, f))
        removedAgents++
      } catch {
        // Skip files that can't be removed
      }
    }
  }

  // Remove chain files (only zflow ones — by checking if they match our source)
  // For safety, only remove chains that were installed by us, not all chains.
  // Since we install zflow chains to the shared chains directory, we need to be
  // conservative. We only remove chains whose filenames match known source files.
  if (existsSync(chainsDir)) {
    const packageRoot = resolvePackageRoot(options.customPackageRoot)
    const sourceChainFiles = listSourceChainFiles(packageRoot)
    const sourceChainNames = new Set(sourceChainFiles)
    const allFiles = readdirSync(chainsDir).filter((f) => f.endsWith(".chain.md"))
    for (const f of allFiles) {
      if (sourceChainNames.has(f)) {
        try {
          unlinkSync(resolve(chainsDir, f))
          removedChains++
        } catch {
          // Skip files that can't be removed
        }
      }
    }
  }

  // Remove the install manifest
  if (existsSync(ZFLOW_MANIFEST_PATH)) {
    try {
      unlinkSync(ZFLOW_MANIFEST_PATH)
    } catch {
      // Ignore cleanup errors
    }
  }

  return { removedAgents, removedChains }
}
