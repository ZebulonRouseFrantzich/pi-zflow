/**
 * repo-analysis.ts — concrete repo-map and reconnaissance builders for planning flows.
 */

import {
  isRepoMapFresh,
  writeRepoMapCache,
  computeRepoStructureHash,
} from "../../repo-map-cache.js"
import { resolveVerificationCommand } from "../../verification.js"

/**
 * Build a lightweight repo-map.md by inspecting the repository.
 *
 * Uses git and Node.js APIs to produce concrete repo data without
 * dispatching any agents. Writes the result to
 * `<runtime-state-dir>/repo-map.md`.
 *
 * @param cwd - Working directory (optional).
 * @returns An object with the output path and entry count.
 */
export async function buildRepoMap(cwd?: string): Promise<{ path: string; entries: number }> {
  // Check cache freshness first — reuse existing map if repo structure is unchanged
  const { fresh } = await isRepoMapFresh(cwd)
  if (fresh) {
    const cached = await (await import("../../repo-map-cache.js")).readRepoMapCache(cwd)
    if (cached) {
      return { path: cached.path, entries: cached.entryCount }
    }
  }

  const { default: fs } = await import("node:fs/promises")
  const { default: path } = await import("node:path")
  const { execFileSync } = await import("node:child_process")
  const { resolveRuntimeStateDir } = await import("pi-zflow-core/runtime-paths")

  const runtimeStateDir = resolveRuntimeStateDir(cwd)
  const outputPath = path.join(runtimeStateDir, "repo-map.md")

  // Resolve repo root
  let repoRoot = ""
  let branch = "unknown"
  let headSha = "unknown"
  let topLevelDirs: string[] = []
  let changedFiles: string[] = []

  try {
    repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
    }).trim()

    branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
    }).trim()

    headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
    }).trim()

    // Top-level listing via git ls-tree (avoids ls dependency)
    const lsTree = execFileSync("git", ["ls-tree", "--name-only", "HEAD"], {
      cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
    }).trim()
    topLevelDirs = lsTree ? lsTree.split("\n").filter(Boolean) : []

    // Changed files
    const statusOutput = execFileSync("git", ["status", "--porcelain"], {
      cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
    }).trim()
    changedFiles = statusOutput ? statusOutput.split("\n").map(l => l.trim()).filter(Boolean) : []
  } catch {
    // Not in a git repo or git unavailable — fall back to filesystem
    repoRoot = cwd ?? process.cwd()
    try {
      const { readdirSync } = await import("node:fs")
      topLevelDirs = readdirSync(repoRoot).filter(e => !e.startsWith("."))
    } catch {
      // Ignore listing failures
    }
  }

  // Detect verification command
  let verificationCommand: string | null = null
  if (repoRoot) {
    verificationCommand = resolveVerificationCommand(repoRoot)
  }

  // Read package/workspace info
  let packageManager = "unknown"
  let workspaces: string[] = []
  if (repoRoot) {
    const pkgJsonPath = path.join(repoRoot, "package.json")
    try {
      const pkgContent = await fs.readFile(pkgJsonPath, "utf-8")
      const pkg = JSON.parse(pkgContent)
      if (pkg.workspaces) {
        workspaces = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces.packages ?? [])
      }
      // Detect package manager from known lockfiles
      if (pkg.packageManager) {
        packageManager = pkg.packageManager
      } else {
        for (const [name, mgr] of [
          ["package-lock.json", "npm"],
          ["yarn.lock", "yarn"],
          ["pnpm-lock.yaml", "pnpm"],
          ["bun.lockb", "bun"],
        ] as const) {
          try {
            await fs.access(path.join(repoRoot, name))
            packageManager = mgr
            break
          } catch { /* not present */ }
        }
      }
    } catch {
      // No package.json — that's fine
    }
  }

  // Collect additional metadata for enriched content
  let entryPoints: string[] = []
  let configFiles: string[] = []
  let keyExports: string[] = []

  if (repoRoot) {
    try {
      const { execFileSync: execSync } = await import("node:child_process")

      // Entry points: common entry file patterns
      const entryPatterns = ["index.ts", "index.js", "main.ts", "main.js", "cli.ts", "cli.js"]
      for (const pattern of entryPatterns) {
        try {
          execSync("git", ["ls-files", `*${pattern}`], {
            cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
          }).trim().split("\n").filter(Boolean).forEach(f => {
            if (!entryPoints.includes(f)) entryPoints.push(f)
          })
        } catch { /* skip */ }
      }

      // Config files
      const configPatterns = ["package.json", "tsconfig.json", ".env*", "Dockerfile*", "docker-compose*", "Makefile", "*.config.ts", "*.config.js", ".gitignore", ".eslintrc*", ".prettierrc*", "jest.config*"]
      for (const pattern of configPatterns) {
        try {
          const matches = execSync("find", [repoRoot, "-maxdepth", "2", "-name", pattern, "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*"], {
            encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
          }).trim().split("\n").filter(Boolean)
          matches.forEach(f => {
            const relative = f.startsWith(repoRoot) ? f.slice(repoRoot.length + 1) : f
            if (!configFiles.includes(relative)) configFiles.push(relative)
          })
        } catch { /* skip */ }
      }

      // Key exports: look for `export` in key index files
      for (const entryFile of entryPoints.slice(0, 5)) {
        try {
          const content = execSync("head", ["-40", path.join(repoRoot, entryFile)], {
            encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
          }).trim()
          const exports = content.split("\n").filter(l => l.includes("export ") && !l.includes("export type"))
            .map(l => l.trim()).slice(0, 10)
          if (exports.length > 0) {
            keyExports.push(`### ${entryFile}`)
            exports.forEach(e => keyExports.push(`- \`${e}\``))
          }
        } catch { /* skip */ }
      }
    } catch { /* tools unavailable */ }
  }

  // Build enriched content — target ~200 lines max
  const lines: string[] = [
    "# Repository Map",
    "",
    `Generated by zflow-change-workflows at ${new Date().toISOString()}.`,
    "",
    "## Repository",
    `- **Root**: ${repoRoot || "(outside git)"}`,
    `- **Branch**: ${branch}`,
    `- **HEAD**: ${headSha}`,
    "",
  ]

  if (workspaces.length > 0) {
    lines.push("## Workspace", "")
    lines.push(`- **Package manager**: ${packageManager}`)
    lines.push(`- **Workspaces**: ${workspaces.join(", ")}`, "")
  }

  // Depth-3 directory tree — in-process bounded traversal (no shell find)
  if (repoRoot) {
    try {
      const MAX_TREE_FILES = 80
      const MAX_DEPTH = 3
      const excludeDirNames = new Set(["node_modules", ".git"])
      const collectedFiles: string[] = []

      const walkDir = async (dir: string, depth: number): Promise<void> => {
        if (depth > MAX_DEPTH || collectedFiles.length >= MAX_TREE_FILES) return
        let entries
        try {
          entries = await fs.readdir(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          if (collectedFiles.length >= MAX_TREE_FILES) break
          const fullPath = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            if (excludeDirNames.has(entry.name)) continue
            await walkDir(fullPath, depth + 1)
          } else if (entry.isFile()) {
            const relative = fullPath.startsWith(repoRoot)
              ? fullPath.slice(repoRoot.length + 1)
              : fullPath
            collectedFiles.push(relative)
          }
        }
      }

      await walkDir(repoRoot, 0)

      if (collectedFiles.length > 0) {
        lines.push("## Directory structure", "")
        // Build a tree-like representation
        const tree = new Map<string, string[]>()
        for (const relative of collectedFiles) {
          const parts = relative.split("/")
          if (parts.length > 1) {
            const dir = parts.slice(0, -1).join("/")
            if (!tree.has(dir)) tree.set(dir, [])
            tree.get(dir)!.push(parts[parts.length - 1])
          }
        }
        for (const [dir, entries] of [...tree.entries()].slice(0, 30)) {
          lines.push(`- \`${dir}/\``)
          for (const entry of entries.slice(0, 5)) {
            lines.push(`  - ${entry}`)
          }
          if (entries.length > 5) lines.push(`  - ... (${entries.length - 5} more)`)
        }
        lines.push("")
      }
    } catch { /* skip */ }
  }

  // Entry points and config files
  if (entryPoints.length > 0) {
    lines.push("## Entry points", "")
    for (const ep of entryPoints.slice(0, 15)) {
      lines.push(`- \`${ep}\``)
    }
    lines.push("")
  }

  if (configFiles.length > 0) {
    lines.push("## Config files", "")
    for (const cf of configFiles.slice(0, 15)) {
      lines.push(`- \`${cf}\``)
    }
    lines.push("")
  }

  // Key module exports
  if (keyExports.length > 0) {
    lines.push("## Key exports", "")
    lines.push(...keyExports)
    lines.push("")
  }

  if (changedFiles.length > 0) {
    lines.push("## Changed files", "")
    for (const file of changedFiles.slice(0, 20)) {
      lines.push(`- \`${file}\``)
    }
    if (changedFiles.length > 20) {
      lines.push(`- ... and ${changedFiles.length - 20} more`)
    }
    lines.push("")
  } else {
    lines.push("## Changed files", "", "(none)", "")
  }

  if (verificationCommand) {
    lines.push("## Verification", "")
    lines.push(`- **Detected command**: \`${verificationCommand}\``, "")
  }

  // Ensure content doesn't exceed ~250 lines
  let content = lines.join("\n")
  const contentLines = content.split("\n")
  if (contentLines.length > 250) {
    content = contentLines.slice(0, 245).join("\n") + "\n\n_(content truncated at 250 lines)_\n"
  }

  await fs.mkdir(runtimeStateDir, { recursive: true })
  await fs.writeFile(outputPath, content, "utf-8")

  // Cache the new repo-map for future freshness checks
  const hash = computeRepoStructureHash(cwd)
  await writeRepoMapCache({
    hash,
    generatedAt: new Date().toISOString(),
    entryCount: topLevelDirs.length,
    path: outputPath,
  }, cwd)

  return { path: outputPath, entries: topLevelDirs.length }
}

/**
 * Build reconnaissance.md with concrete source context.
 *
 * Inspects the provided change path (if any), nearby files, README,
 * package info, and recent failure-log entries. Writes the result
 * to `<runtime-state-dir>/reconnaissance.md`.
 *
 * @param cwd - Working directory (optional).
 * @param changePath - Optional change path to inspect.
 * @returns An object with the output path.
 */
export async function buildReconnaissance(
  cwd?: string,
  changePath?: string,
): Promise<{ path: string }> {
  const { default: fs } = await import("node:fs/promises")
  const { default: pathModule } = await import("node:path")
  const { resolveRuntimeStateDir } = await import("pi-zflow-core/runtime-paths")
  const { isReconFresh, writeReconCache, computeRepoStructureHash: reconHash } =
    await import("../../recon-cache.js")

  const runtimeStateDir = resolveRuntimeStateDir(cwd)
  const outputPath = pathModule.join(runtimeStateDir, "reconnaissance.md")

  // Check cache freshness — skip regeneration if still fresh
  const { fresh } = await isReconFresh(changePath, cwd)
  if (fresh) {
    return { path: outputPath }
  }

  // Resolve repo root for git-based context
  let repoRoot = ""
  try {
    const { execFileSync } = await import("node:child_process")
    repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  } catch {
    repoRoot = cwd ?? process.cwd()
  }

  const lines: string[] = [
    "# Reconnaissance",
    "",
    `Generated by zflow-change-workflows at ${new Date().toISOString()}.`,
    "",
    "## Scope",
  ]

  // Change path analysis
  if (changePath) {
    lines.push(`- **Change path**: ${changePath}`)
    const resolvedPath = pathModule.isAbsolute(changePath)
      ? changePath
      : pathModule.join(repoRoot, changePath)
    let pathExists = false
    try {
      await fs.access(resolvedPath)
      pathExists = true
    } catch { /* does not exist */ }
    lines.push(`- **Path exists**: ${pathExists}`)
    if (pathExists) {
      try {
        const stat = await fs.stat(resolvedPath)
        lines.push(`- **Type**: ${stat.isDirectory() ? "directory" : "file"}`)
      } catch { /* stat failed */ }
    }
    lines.push("")

    // Nearby files — list directory contents if changePath is a directory
    if (pathExists) {
      try {
        const stat = await fs.stat(resolvedPath)
        if (stat.isDirectory()) {
          const entries = await fs.readdir(resolvedPath)
          if (entries.length > 0) {
            lines.push("## Nearby files", "")
            for (const entry of entries.slice(0, 30)) {
              lines.push(`- ${entry}`)
            }
            if (entries.length > 30) {
              lines.push(`- ... and ${entries.length - 30} more`)
            }
            lines.push("")
          }
        }
      } catch { /* readdir failed */ }
    }
  } else {
    lines.push("- **Change path**: (auto-generated)", "")
  }

  // README excerpt
  if (repoRoot) {
    const readmePath = pathModule.join(repoRoot, "README.md")
    try {
      const readmeContent = await fs.readFile(readmePath, "utf-8")
      lines.push("## README", "")
      const readmeLines = readmeContent.split("\n").filter(l => l.trim()).slice(0, 5)
      for (const rl of readmeLines) {
        lines.push(`> ${rl}`)
      }
      lines.push("")
    } catch {
      // No README — skip
    }

    // Package info
    const pkgJsonPath = pathModule.join(repoRoot, "package.json")
    try {
      const pkgContent = await fs.readFile(pkgJsonPath, "utf-8")
      const pkg = JSON.parse(pkgContent)
      lines.push("## Package info", "")
      lines.push(`- **Name**: ${pkg.name ?? "unknown"}`)
      if (pkg.version) lines.push(`- **Version**: ${pkg.version}`)
      if (pkg.scripts) {
        const scripts = Object.keys(pkg.scripts)
        lines.push(`- **Scripts**: ${scripts.join(", ")}`)
      }
      if (pkg.dependencies) {
        lines.push(`- **Dependencies**: ${Object.keys(pkg.dependencies).length}`)
      }
      if (pkg.devDependencies) {
        lines.push(`- **Dev dependencies**: ${Object.keys(pkg.devDependencies).length}`)
      }
      lines.push("")
    } catch {
      // No package.json — fine
    }
  }

  // Recent failure-log entries — relevance-based, not just first N
  try {
    const { loadRecentFailureLogEntries, formatFailureLogReadback } =
      await import(
        "../../../../src/failure-log-helpers.js"
      )

    // Use change path as search context; fall back to generic planning context
    const searchContext = changePath
      ? `planning implementation for ${pathModule.basename(changePath)}`
      : "codebase exploration and planning"

    const relevantEntries = await loadRecentFailureLogEntries({
      context: searchContext,
      limit: 3,
      maxAge: 30,
      cwd,
    })

    if (relevantEntries.length > 0) {
      lines.push("## Recent failure-log entries", "")
      lines.push(formatFailureLogReadback(relevantEntries))
      lines.push("")
    }
  } catch {
    // Failure log unavailable — skip
  }

  const content = lines.join("\n")

  await fs.mkdir(runtimeStateDir, { recursive: true })
  await fs.writeFile(outputPath, content, "utf-8")

  // Cache the new reconnaissance for future freshness checks
  await writeReconCache({
    hash: reconHash(cwd),
    generatedAt: new Date().toISOString(),
    changePath: changePath ?? null,
    path: outputPath,
  }, cwd)

  return { path: outputPath }
}
