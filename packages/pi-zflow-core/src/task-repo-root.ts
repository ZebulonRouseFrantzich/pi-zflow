import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

export interface InferTaskRepoRootOptions {
  cwd?: string
  claimedFiles?: string[]
}

function tryResolveGitTopLevel(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  } catch {
    return null
  }
}

function findNearestExistingAncestor(targetPath: string, floor: string): string | null {
  let current = path.resolve(targetPath)
  const resolvedFloor = path.resolve(floor)

  while (true) {
    if (fs.existsSync(current)) return current
    if (current === resolvedFloor) return fs.existsSync(resolvedFloor) ? resolvedFloor : null
    const parent = path.dirname(current)
    if (parent === current) return null
    const relativeParent = path.relative(resolvedFloor, parent)
    if (relativeParent === ".." || relativeParent.startsWith(`..${path.sep}`) || path.isAbsolute(relativeParent)) {
      return fs.existsSync(resolvedFloor) ? resolvedFloor : null
    }
    current = parent
  }
}

export function inferClaimedFileRepoRoots(
  sharedCwd: string,
  claimedFiles?: string[],
): string[] {
  if (!claimedFiles || claimedFiles.length === 0) return []

  const discoveredRoots = new Set<string>()
  const resolvedSharedCwd = path.resolve(sharedCwd)

  for (const claimedFile of claimedFiles) {
    if (!claimedFile?.trim()) continue
    const absoluteTarget = path.resolve(resolvedSharedCwd, claimedFile)
    const existingAncestor = findNearestExistingAncestor(absoluteTarget, resolvedSharedCwd)
    if (!existingAncestor) continue
    const stat = fs.statSync(existingAncestor)
    const searchCwd = stat.isDirectory() ? existingAncestor : path.dirname(existingAncestor)
    const repoRoot = tryResolveGitTopLevel(searchCwd)
    if (repoRoot) {
      discoveredRoots.add(path.resolve(repoRoot))
    }
  }

  return [...discoveredRoots].sort()
}

export function inferTaskRepoRoot(
  sharedCwd: string,
  options?: InferTaskRepoRootOptions,
): string {
  const explicitCwd = options?.cwd?.trim()
  if (explicitCwd) {
    return path.resolve(sharedCwd, explicitCwd)
  }

  const discoveredRoots = inferClaimedFileRepoRoots(sharedCwd, options?.claimedFiles)
  if (discoveredRoots.length === 0) return path.resolve(sharedCwd)
  if (discoveredRoots.length === 1) return discoveredRoots[0]!

  throw new Error(
    `Task files span multiple git repositories: ${discoveredRoots.join(", ")}`,
  )
}
