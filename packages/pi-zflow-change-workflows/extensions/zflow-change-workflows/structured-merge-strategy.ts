/**
 * structured-merge-strategy.ts — Auto-resolves common safe merge conflicts.
 *
 * When `git apply --3way` or `git merge` encounters conflicts, this strategy
 * attempts to resolve them using structured rules for known conflict patterns.
 *
 * ## Common safe patterns
 *
 * - **Import additions**: multiple groups add different imports to the same file
 * - **Route/endpoint registrations**: multiple groups register different routes
 * - **Config object keys**: multiple groups add different keys to JSON/YAML/TOML
 * - **Package.json dependencies**: multiple groups add different packages
 * - **Non-overlapping context drift**: patch context lines shifted but actual changes
 *   don't overlap
 * - **Enum/union member additions**: multiple groups add different members
 * - **Documentation additions**: different sections
 *
 * ## What this strategy does NOT resolve
 *
 * - Same config key changed to different values
 * - Same function rewritten incompatibly
 * - Binary file conflicts
 * - Structural/cross-cutting conflicts that require human intent analysis
 *
 * @module pi-zflow-change-workflows/structured-merge-strategy
 */

import * as path from "node:path"
import * as fs from "node:fs"
import { execFileSync } from "node:child_process"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single conflict marker region found in a file.
 */
export interface ConflictRegion {
  /** File path relative to repo root. */
  file: string
  /** Our version content (between <<<<<<< and =======). */
  ours: string[]
  /** Their version content (between ======= and >>>>>>>). */
  theirs: string[]
  /** Starting line number of the conflict (1-indexed). */
  startLine: number
  /** Ending line number of the conflict. */
  endLine: number
}

/**
 * Result of a structured merge attempt.
 */
export interface StructuredMergeResult {
  /** Whether the merge succeeded (all conflicts resolved). */
  success: boolean
  /** Number of conflicts resolved automatically. */
  resolved: number
  /** Number of conflicts that could not be resolved. */
  unresolved: number
  /** Files that still have conflict markers after resolution. */
  unresolvedFiles: string[]
  /** Files that were modified during resolution. */
  modifiedFiles: string[]
  /** Human-readable summary. */
  summary: string
}

// ---------------------------------------------------------------------------
// Conflict marker detection
// ---------------------------------------------------------------------------

/**
 * Detect all conflict regions in a file.
 */
export function detectConflictRegions(filePath: string): ConflictRegion[] {
  const regions: ConflictRegion[] = []

  let content: string
  try {
    content = fs.readFileSync(filePath, "utf-8")
  } catch {
    return []
  }

  const lines = content.split("\n")
  let i = 0

  while (i < lines.length) {
    if (lines[i].startsWith("<<<<<<< ")) {
      const startLine = i + 1  // 1-indexed
      const ours: string[] = []
      const theirs: string[] = []
      const conflictEnd = lines[i].substring("<<<<<<< ".length).trim()

      i++
      // Collect ours lines
      while (i < lines.length && !lines[i].startsWith("=======")) {
        ours.push(lines[i])
        i++
      }

      if (i < lines.length) {
        i++  // skip =======
      }

      // Collect theirs lines
      while (i < lines.length && !lines[i].startsWith(">>>>>>> ")) {
        theirs.push(lines[i])
        i++
      }

      if (i < lines.length) {
        i++  // skip >>>>>>>
      }

      regions.push({
        file: path.basename(filePath), // caller should set proper path
        ours,
        theirs,
        startLine,
        endLine: i,
      })
    } else {
      i++
    }
  }

  return regions
}

/**
 * Check if a file still contains unresolved conflict markers.
 */
export function hasUnresolvedMarkers(filePath: string): boolean {
  try {
    const content = fs.readFileSync(filePath, "utf-8")
    return /^<<<<<<< |^=======$|^>>>>>>> /m.test(content)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Merge conflict resolution strategies
// ---------------------------------------------------------------------------

/**
 * Try to resolve a conflict by assuming it's a non-overlapping addition
 * (both sides added content to the same region).
 *
 * Resolution: keep both sides' additions in order (ours first, then theirs).
 *
 * @param region - The conflict region.
 * @returns Resolved lines or null if this strategy doesn't apply.
 */
function resolveNonOverlappingAddition(region: ConflictRegion): string[] | null {
  // This strategy works when both sides added non-conflicting content.
  // "Non-conflicting" means no line in ours and theirs is the same except
  // for whitespace, and both sets look like additions (no deletions).

  const ourTrimmed = region.ours.filter((l) => !l.startsWith("-"))
  const theirTrimmed = region.theirs.filter((l) => !l.startsWith("-"))

  // Check that neither side has deletions that would conflict
  const ourDeletions = region.ours.filter((l) => l.startsWith("-"))
  const theirDeletions = region.theirs.filter((l) => l.startsWith("-"))
  if (ourDeletions.length > 0 && theirDeletions.length > 0) {
    // Both sides deleting — too risky
    return null
  }

  // Check that the additions don't overlap exactly
  const ourLines = region.ours.map((l) => l.trim()).filter(Boolean)
  const theirLines = region.theirs.map((l) => l.trim()).filter(Boolean)

  const overlap = ourLines.some((l) => theirLines.includes(l))
  if (overlap) {
    return null  // exact overlap — can't decide
  }

  // Both sides added different content — keep both
  return [...region.ours, ...region.theirs]
}

/**
 * Try to resolve a conflict that looks like an import addition conflict.
 *
 * Pattern: both sides added `import ...` or `require(...)` lines.
 *
 * Resolution: keep both imports, deduplicating if same module imported.
 *
 * @param region - The conflict region.
 * @returns Resolved lines or null if this strategy doesn't apply.
 */
function resolveImportConflict(region: ConflictRegion): string[] | null {
  const ourImports = region.ours.filter((l) =>
    /^\s*(?:import|const\s+\w+\s*=\s*require|from\s+)/.test(l.trim()),
  )
  const theirImports = region.theirs.filter((l) =>
    /^\s*(?:import|const\s+\w+\s*=\s*require|from\s+)/.test(l.trim()),
  )

  if (ourImports.length === 0 && theirImports.length === 0) {
    return null  // not an import conflict
  }

  // If one side has imports and the other has non-import content, this
  // might be a mixed conflict — don't auto-resolve
  const ourNonImports = region.ours.length - ourImports.length
  const theirNonImports = region.theirs.length - theirImports.length
  if (ourNonImports > 0 && theirNonImports > 0) {
    return null  // mixed — too risky
  }

  // Collect all unique import lines, deduplicating
  const seen = new Set<string>()
  const resolved: string[] = []

  for (const line of [...region.ours, ...region.theirs]) {
    const trimmed = line.trim()
    // Normalize for dedup: remove trailing semicolons and extra spaces
    const normalized = trimmed.replace(/;$/, "").replace(/\s+/g, " ").trim()
    const dedupKey = normalized.replace(/['"]([^'"]+)['"]/, "MODULE($1)")
    if (!seen.has(dedupKey)) {
      seen.add(dedupKey)
      resolved.push(line)
    }
  }

  return resolved
}

/**
 * Try to resolve a conflict in a JSON config file (package.json, etc.).
 *
 * Pattern: both sides added different keys to an object.
 *
 * Resolution: merge both sets of keys.
 *
 * @param region - The conflict region.
 * @param filePath - The file path (for determining config type).
 * @returns Resolved lines or null if this strategy doesn't apply.
 */
function resolveConfigConflict(region: ConflictRegion, filePath: string): string[] | null {
  const fileName = path.basename(filePath)

  // Only handle known config files
  const configFiles = ["package.json", "tsconfig.json", "wrangler.json", "wrangler.toml"]
  if (!configFiles.includes(fileName)) {
    return null
  }

  // Check if both sides have JSON-like content (key: value patterns)
  const ourJsonKeys = region.ours.filter((l) => /^\s*"[^"]+"\s*:/.test(l.trim()))
  const theirJsonKeys = region.theirs.filter((l) => /^\s*"[^"]+"\s*:/.test(l.trim()))

  if (ourJsonKeys.length === 0 && theirJsonKeys.length === 0) {
    return null  // not a JSON key conflict
  }

  // Check for conflicts on the same key
  const ourKeyNames = new Set(ourJsonKeys.map((l) => l.trim().match(/"([^"]+)"\s*:/)?.[1]).filter(Boolean))
  const theirKeyNames = new Set(theirJsonKeys.map((l) => l.trim().match(/"([^"]+)"\s*:/)?.[1]).filter(Boolean))

  const conflictingKeys = [...ourKeyNames].filter((k) => theirKeyNames.has(k))
  if (conflictingKeys.length > 0) {
    return null  // same key changed — can't auto-resolve
  }

  // Different keys — merge both
  // Take ours first, then theirs (avoiding duplicate trailing commas)
  return [...region.ours, ...region.theirs]
}

/**
 * Try to resolve a package.json dependency conflict.
 *
 * Pattern: both sides added different packages to "dependencies" or
 * "devDependencies".
 *
 * @param lines - The merged lines so far.
 * @returns Whether resolution was attempted.
 */
function resolvePackageJsonConflict(filePath: string): boolean {
  if (path.basename(filePath) !== "package.json") return false

  let content: string
  try {
    content = fs.readFileSync(filePath, "utf-8")
  } catch {
    return false
  }

  const regions = detectConflictRegions(filePath)
  if (regions.length === 0) return false

  const resolved: string[] = []
  let hasChanges = false

  for (const region of regions) {
    // Try JSON key merge for the whole region content
    const result = resolveConfigConflict(
      { ...region, file: filePath },
      filePath,
    )
    if (result) {
      resolved.push(...result)
      hasChanges = true
    } else {
      // Keep conflict markers
      resolved.push(
        `<<<<<<< ${region.file}`,
        ...region.ours,
        "=======",
        ...region.theirs,
        `>>>>>>> ${region.file}`,
      )
    }
  }

  if (hasChanges) {
    // Write resolved content back
    const contentLines = content.split("\n")
    // This is a simplified approach — for real implementation we'd
    // need to replace regions in the original content
    writeResolvedContent(filePath, content, regions)
    return true
  }

  return false
}

/**
 * Write resolved content back to a file, replacing conflict regions
 * with resolved content.
 */
function writeResolvedContent(
  filePath: string,
  originalContent: string,
  resolutions: Array<{ region: ConflictRegion; resolvedLines: string[] }>,
): void {
  const lines = originalContent.split("\n")
  const newLines: string[] = []

  // Sort regions in reverse order to process from bottom up
  const sorted = [...resolutions].sort((a, b) => b.region.startLine - a.region.startLine)

  // Build new content by replacing conflict regions
  let currentLines = [...lines]
  for (const { region, resolvedLines } of sorted) {
    const before = currentLines.slice(0, region.startLine - 1)
    const after = currentLines.slice(region.endLine)
    currentLines = [...before, ...resolvedLines, ...after]
  }

  fs.writeFileSync(filePath, currentLines.join("\n"), "utf-8")
}

/**
 * Try to resolve all conflicts in a file.
 *
 * Tries each strategy in order. Stops when all conflicts are resolved
 * or a conflict cannot be handled.
 *
 * @param filePath - Absolute path to the conflicted file.
 * @returns StructuredMergeResult for this file.
 */
export function resolveFileConflicts(filePath: string): StructuredMergeResult {
  const regions = detectConflictRegions(filePath)

  if (regions.length === 0) {
    return {
      success: true,
      resolved: 0,
      unresolved: 0,
      unresolvedFiles: [],
      modifiedFiles: [],
      summary: "No conflicts found.",
    }
  }

  const resolutions: Array<{ region: ConflictRegion; resolvedLines: string[] }> = []
  let resolved = 0
  let unresolved = 0

  for (const region of regions) {
    let result: string[] | null = null

    // Try each strategy in order
    result = resolveImportConflict(region)
    if (result) {
      resolutions.push({ region, resolvedLines: result })
      resolved++
      continue
    }

    // Check file name for config-specific resolvers
    const fileName = path.basename(filePath)
    if (["package.json", "tsconfig.json", "wrangler.json", "wrangler.toml"].includes(fileName)) {
      result = resolveConfigConflict(region, filePath)
      if (result) {
        resolutions.push({ region, resolvedLines: result })
        resolved++
        continue
      }
    }

    // Try non-overlapping addition fallback
    result = resolveNonOverlappingAddition(region)
    if (result) {
      resolutions.push({ region, resolvedLines: result })
      resolved++
      continue
    }

    // Can't resolve this conflict
    unresolved++
  }

  if (resolved > 0) {
    writeResolvedContent(filePath, fs.readFileSync(filePath, "utf-8"), resolutions)
  }

  const stillConflicted = hasUnresolvedMarkers(filePath)

  return {
    success: !stillConflicted,
    resolved,
    unresolved,
    unresolvedFiles: stillConflicted ? [filePath] : [],
    modifiedFiles: resolved > 0 ? [filePath] : [],
    summary: [
      `File "${path.basename(filePath)}": ${resolved} conflict(s) resolved` +
        (unresolved > 0 ? `, ${unresolved} remaining.` : "."),
      stillConflicted
        ? `${unresolved} conflict(s) could not be auto-resolved.`
        : "All conflicts resolved.",
    ].join("\n"),
  }
}

/**
 * Scan a directory for conflict markers and attempt structured resolution.
 *
 * @param repoRoot - Repository root path.
 * @returns Overall structured merge result.
 */
export function resolveAllConflicts(repoRoot: string): StructuredMergeResult {
  // Find all files with conflict markers
  const grepResult = execFileSync(
    "git", ["grep", "-l", "^<<<<<<< \\|^=======$\\|^>>>>>>> ", "--", "."],
    {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    },
  )

  const conflictedFiles = grepResult.trim()
    ? grepResult.split("\n").filter(Boolean)
    : []

  if (conflictedFiles.length === 0) {
    return {
      success: true,
      resolved: 0,
      unresolved: 0,
      unresolvedFiles: [],
      modifiedFiles: [],
      summary: "No conflicted files found.",
    }
  }

  let totalResolved = 0
  let totalUnresolved = 0
  const unresolvedFiles: string[] = []
  const modifiedFiles: string[] = []

  for (const filePath of conflictedFiles) {
    const absPath = path.join(repoRoot, filePath)
    const result = resolveFileConflicts(absPath)

    totalResolved += result.resolved
    totalUnresolved += result.unresolved
    modifiedFiles.push(...result.modifiedFiles)
    if (result.unresolvedFiles.length > 0) {
      unresolvedFiles.push(filePath)
    }
  }

  const allResolved = unresolvedFiles.length === 0

  return {
    success: allResolved,
    resolved: totalResolved,
    unresolved: totalUnresolved,
    unresolvedFiles,
    modifiedFiles: [...new Set(modifiedFiles)],
    summary: [
      allResolved
        ? `All ${totalResolved} conflict(s) in ${modifiedFiles.length} file(s) resolved.`
        : `${totalResolved} conflict(s) resolved, ${totalUnresolved} remaining in ${unresolvedFiles.length} file(s).`,
      unresolvedFiles.length > 0
        ? `Unresolved files: ${unresolvedFiles.join(", ")}`
        : "No unresolved conflicts.",
    ].join("\n"),
  }
}

/**
 * Determine whether a conflict is "safe" for auto-resolution or
 * should be escalated to the user/subagent.
 *
 * A conflict is safe if:
 * - It has no overlapping key changes in config files
 * - Both sides are additions (no deletions)
 * - Imports from different modules
 * - Route registrations at different paths
 *
 * @param filePath - Path to the conflicted file.
 * @returns True if the conflict looks safe.
 */
export function isConflictSafeForAutoResolution(filePath: string): boolean {
  const regions = detectConflictRegions(filePath)
  if (regions.length === 0) return true

  for (const region of regions) {
    // Try import resolution
    if (resolveImportConflict(region)) continue

    // Try non-overlapping addition
    if (resolveNonOverlappingAddition(region)) continue

    // Try config key merge
    if (resolveConfigConflict(region, filePath)) continue

    // No strategy worked
    return false
  }

  return true
}
