/**
 * external-path-dependencies.ts — Safe materialisation of manifest-declared
 * sibling path dependencies for isolated worktrees.
 *
 * The helper intentionally copies only manifest-referenced external package
 * directories into the dispatch sandbox. It does not symlink to the caller's
 * real sibling repositories, and it never returns paths for apply-back.
 */

import * as fs from "node:fs"
import * as path from "node:path"

export type ExternalPathDependencyMode = "copy-readonly" | "off"

export interface ExternalPathDependenciesConfig {
  mode?: ExternalPathDependencyMode
  allow?: string[]
}

export interface ExternalPathDependencyCandidate {
  manifestPath: string
  dependencyPath: string
  sourcePath: string
  targetPath: string
  packageName?: string
}

export interface MaterializedExternalPathDependency extends ExternalPathDependencyCandidate {
  copied: boolean
}

export interface MaterializeExternalPathDependenciesOptions {
  repoRoot: string
  worktreeRoot: string
  config?: ExternalPathDependenciesConfig
}

export interface MaterializeExternalPathDependenciesResult {
  mode: ExternalPathDependencyMode
  candidates: ExternalPathDependencyCandidate[]
  materialized: MaterializedExternalPathDependency[]
  skipped: Array<{ dependencyPath: string; reason: string; manifestPath?: string }>
}

interface LoadedExternalPathDependencyConfig {
  mode: ExternalPathDependencyMode
  allow: string[]
}

const CONFIG_FILE_CANDIDATES = [
  ".pi/zflow/config.json",
  "pi-zflow.config.json",
  ".pi-zflow.config.json",
] as const

const SKIPPED_COPY_DIRS = new Set([".git", ".github", ".vscode", ".cache", "node_modules", ".dart_tool", "build", ".wrangler"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export function normalizeExternalPathDependenciesConfig(
  value: unknown,
): LoadedExternalPathDependencyConfig {
  if (!isRecord(value)) return { mode: "copy-readonly", allow: [] }
  return {
    mode: value.mode === "off" ? "off" : "copy-readonly",
    allow: normalizeStringArray(value.allow),
  }
}

function loadExternalPathDependenciesConfig(repoRoot: string): LoadedExternalPathDependencyConfig {
  for (const candidate of CONFIG_FILE_CANDIDATES) {
    const configPath = path.join(repoRoot, candidate)
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>
      return normalizeExternalPathDependenciesConfig(parsed.externalPathDependencies)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      // Invalid repo config is handled by higher-level config loaders. Fall back
      // here so dispatch does not fail while reporting unrelated setup context.
      return { mode: "copy-readonly", allow: [] }
    }
  }
  return { mode: "copy-readonly", allow: [] }
}

function safeRealpathSync(candidate: string): string | null {
  try {
    return fs.realpathSync(candidate)
  } catch {
    return null
  }
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function firstPathSegment(relativePath: string): string | null {
  const segment = relativePath.split(path.sep).filter(Boolean)[0]
  return segment ?? null
}

function inferSiblingRoot(repoRoot: string, sourcePath: string): string | null {
  const repoParent = path.dirname(repoRoot)
  if (!isWithin(sourcePath, repoParent) || isWithin(sourcePath, repoRoot)) return null
  const segment = firstPathSegment(path.relative(repoParent, sourcePath))
  return segment ? path.join(repoParent, segment) : null
}

function resolveAllowedRoots(repoRoot: string, allow: string[]): string[] {
  return allow
    .map((entry) => path.resolve(repoRoot, entry))
    .map((entry) => safeRealpathSync(entry))
    .filter((entry): entry is string => Boolean(entry))
}

function listFilesRecursive(root: string, basename: string, output: string[] = []): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return output
  }

  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".zflow") continue
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      listFilesRecursive(fullPath, basename, output)
    } else if (entry.isFile() && entry.name === basename) {
      output.push(fullPath)
    }
  }

  return output
}

function parsePubspecPathDependencies(content: string): Array<{ dependencyPath: string; packageName?: string }> {
  const dependencies: Array<{ dependencyPath: string; packageName?: string }> = []
  const lines = content.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const packageMatch = lines[index]?.match(/^\s{2}([A-Za-z0-9_\-]+):\s*$/)
    if (!packageMatch) continue
    const packageName = packageMatch[1]
    for (let lookahead = index + 1; lookahead < Math.min(lines.length, index + 8); lookahead++) {
      const line = lines[lookahead] ?? ""
      if (/^\s{0,2}[A-Za-z0-9_\-]+:\s*/.test(line) && !line.trim().startsWith("path:")) break
      const pathMatch = line.match(/^\s{4,}path:\s*(.+?)\s*$/)
      if (!pathMatch) continue
      const rawPath = pathMatch[1]!.replace(/^['"]|['"]$/g, "").trim()
      if (rawPath && !path.isAbsolute(rawPath) && !rawPath.startsWith("~")) {
        dependencies.push({ dependencyPath: rawPath, packageName })
      }
      break
    }
  }
  return dependencies
}

function discoverPubspecCandidates(
  repoRoot: string,
  manifestPath: string,
  worktreeRoot: string,
  sandboxRoot: string,
  allowedRoots: string[],
  autoSiblingRoots: Set<string>,
  skipped: MaterializeExternalPathDependenciesResult["skipped"],
): ExternalPathDependencyCandidate[] {
  let content = ""
  try {
    content = fs.readFileSync(manifestPath, "utf-8")
  } catch {
    return []
  }

  const manifestDir = path.dirname(manifestPath)
  const manifestRelativeDir = path.relative(repoRoot, manifestDir)
  const worktreeManifestDir = path.join(worktreeRoot, manifestRelativeDir)
  const candidates: ExternalPathDependencyCandidate[] = []

  for (const dependency of parsePubspecPathDependencies(content)) {
    const sourcePathRaw = path.resolve(manifestDir, dependency.dependencyPath)
    const sourcePath = safeRealpathSync(sourcePathRaw)
    if (!sourcePath) {
      skipped.push({
        manifestPath,
        dependencyPath: dependency.dependencyPath,
        reason: `source path does not exist: ${sourcePathRaw}`,
      })
      continue
    }
    if (isWithin(sourcePath, repoRoot)) continue

    const siblingRoot = inferSiblingRoot(repoRoot, sourcePath)
    if (siblingRoot) autoSiblingRoots.add(siblingRoot)
    const isAllowed = allowedRoots.some((root) => isWithin(sourcePath, root)) || Boolean(siblingRoot)
    if (!isAllowed) {
      skipped.push({
        manifestPath,
        dependencyPath: dependency.dependencyPath,
        reason: `external path is outside allowed sibling roots: ${sourcePath}`,
      })
      continue
    }

    const targetPath = path.resolve(worktreeManifestDir, dependency.dependencyPath)
    if (!isWithin(targetPath, sandboxRoot)) {
      skipped.push({
        manifestPath,
        dependencyPath: dependency.dependencyPath,
        reason: `target path escapes worktree sandbox: ${targetPath}`,
      })
      continue
    }

    candidates.push({
      manifestPath,
      dependencyPath: dependency.dependencyPath,
      sourcePath,
      targetPath,
      packageName: dependency.packageName,
    })
  }

  return candidates
}

function chmodReadonly(target: string): void {
  const stat = fs.lstatSync(target)
  if (stat.isSymbolicLink()) return
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) chmodReadonly(path.join(target, entry))
    fs.chmodSync(target, 0o555)
  } else {
    fs.chmodSync(target, 0o444)
  }
}

function chmodWritable(target: string): void {
  if (!fs.existsSync(target)) return
  const stat = fs.lstatSync(target)
  if (stat.isSymbolicLink()) return
  if (stat.isDirectory()) {
    fs.chmodSync(target, 0o755)
    for (const entry of fs.readdirSync(target)) chmodWritable(path.join(target, entry))
  } else {
    fs.chmodSync(target, 0o644)
  }
}

function ensureNoSymlinkAncestors(sandboxRoot: string, targetPath: string): void {
  const relative = path.relative(sandboxRoot, targetPath)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`target path escapes sandbox: ${targetPath}`)
  }

  const segments = relative.split(path.sep).filter(Boolean)
  let current = sandboxRoot
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment)
    if (!fs.existsSync(current)) {
      fs.mkdirSync(current, { recursive: true })
      continue
    }

    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(current)
      fs.mkdirSync(current, { recursive: true })
      continue
    }
    if (!stat.isDirectory()) {
      throw new Error(`target ancestor is not a directory: ${current}`)
    }
  }
}

function removeTargetWithoutFollowingSymlinkAncestor(sandboxRoot: string, targetPath: string): void {
  ensureNoSymlinkAncestors(sandboxRoot, targetPath)
  if (!fs.existsSync(targetPath)) return
  const stat = fs.lstatSync(targetPath)
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(targetPath)
    return
  }
  chmodWritable(targetPath)
  fs.rmSync(targetPath, { recursive: true, force: true })
}

function copyDirectorySafe(source: string, target: string, sandboxRoot: string): void {
  const stat = fs.lstatSync(source)
  if (stat.isSymbolicLink()) return
  if (stat.isDirectory()) {
    ensureNoSymlinkAncestors(sandboxRoot, path.join(target, ".placeholder"))
    fs.mkdirSync(target, { recursive: true })
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIPPED_COPY_DIRS.has(entry.name)) continue
      copyDirectorySafe(path.join(source, entry.name), path.join(target, entry.name), sandboxRoot)
    }
    return
  }
  if (stat.isFile()) {
    ensureNoSymlinkAncestors(sandboxRoot, target)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, target)
  }
}

export function hasExternalPathDependencies(repoRootInput: string): boolean {
  const repoRoot = safeRealpathSync(repoRootInput)
  if (!repoRoot) return false
  const config = loadExternalPathDependenciesConfig(repoRoot)
  if (config.mode === "off") return false

  for (const manifestPathRaw of listFilesRecursive(repoRoot, "pubspec.yaml")) {
    const manifestPath = safeRealpathSync(manifestPathRaw)
    if (!manifestPath) continue
    let content = ""
    try {
      content = fs.readFileSync(manifestPath, "utf-8")
    } catch {
      continue
    }
    const manifestDir = path.dirname(manifestPath)
    for (const dependency of parsePubspecPathDependencies(content)) {
      const sourcePath = safeRealpathSync(path.resolve(manifestDir, dependency.dependencyPath))
      if (sourcePath && !isWithin(sourcePath, repoRoot)) return true
    }
  }

  return false
}

export function materializeExternalPathDependencies(
  options: MaterializeExternalPathDependenciesOptions,
): MaterializeExternalPathDependenciesResult {
  const repoRoot = fs.realpathSync(options.repoRoot)
  const worktreeRoot = fs.realpathSync(options.worktreeRoot)
  const config = options.config
    ? normalizeExternalPathDependenciesConfig(options.config)
    : loadExternalPathDependenciesConfig(repoRoot)
  const skipped: MaterializeExternalPathDependenciesResult["skipped"] = []

  if (config.mode === "off") {
    return { mode: "off", candidates: [], materialized: [], skipped }
  }

  const sandboxRoot = path.dirname(worktreeRoot)
  const configuredAllowedRoots = resolveAllowedRoots(repoRoot, config.allow)
  const autoSiblingRoots = new Set<string>()
  const queue = listFilesRecursive(repoRoot, "pubspec.yaml")
  const seenManifests = new Set<string>()
  const candidatesByTarget = new Map<string, ExternalPathDependencyCandidate>()

  while (queue.length > 0) {
    const manifestPathRaw = queue.shift()!
    const manifestPath = safeRealpathSync(manifestPathRaw)
    if (!manifestPath || seenManifests.has(manifestPath)) continue
    seenManifests.add(manifestPath)

    const allowedRoots = [...configuredAllowedRoots, ...autoSiblingRoots]
    const discovered = discoverPubspecCandidates(
      repoRoot,
      manifestPath,
      worktreeRoot,
      sandboxRoot,
      allowedRoots,
      autoSiblingRoots,
      skipped,
    )
    for (const candidate of discovered) {
      candidatesByTarget.set(candidate.targetPath, candidate)
      const nestedManifest = path.join(candidate.sourcePath, "pubspec.yaml")
      if (fs.existsSync(nestedManifest)) queue.push(nestedManifest)
    }
  }

  const materialized: MaterializedExternalPathDependency[] = []
  for (const candidate of candidatesByTarget.values()) {
    try {
      removeTargetWithoutFollowingSymlinkAncestor(sandboxRoot, candidate.targetPath)
      copyDirectorySafe(candidate.sourcePath, candidate.targetPath, sandboxRoot)
      chmodReadonly(candidate.targetPath)
      materialized.push({ ...candidate, copied: true })
    } catch (error) {
      skipped.push({
        manifestPath: candidate.manifestPath,
        dependencyPath: candidate.dependencyPath,
        reason: `copy failed: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  return {
    mode: config.mode,
    candidates: [...candidatesByTarget.values()],
    materialized,
    skipped,
  }
}
