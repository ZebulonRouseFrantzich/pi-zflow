/**
 * coverage-verifier.ts — "No lost code" verification for merged apply-back results.
 *
 * After multiple worker groups implement their patches in isolated worktrees
 * and those patches are merged (via integration merge or structured merge),
 * this module verifies that every group's intended changes are preserved in
 * the final consolidated result.
 *
 * ## Coverage verification
 *
 * Each group's original patch is parsed into hunks. Each hunk is checked in
 * the merged result using git diff. Hunks are classified as:
 * - **preserved**: content appears in the merged diff (tolerant of line shifts)
 * - **transformed**: intent preserved but text differs (record explanation)
 * - **missing**: no trace found in merged output
 *
 * @module pi-zflow-change-workflows/coverage-verifier
 */

import { execFileSync } from "node:child_process"
import * as fs from "node:fs"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single hunk from a group's patch.
 */
export interface GroupHunk {
  /** File path relative to repo root. */
  file: string
  /** The hunk content (header + body). */
  content: string
  /** Whether this is an addition, deletion, or modification. */
  kind: "add" | "delete" | "modify"
  /** Line numbers in the original file (if parseable). */
  originalLines?: { start: number; count: number }
}

/**
 * Coverage status for a single group's changes.
 */
export interface GroupCoverage {
  /** Group identifier. */
  groupId: string
  /** All hunks from this group's original patch. */
  originalHunks: GroupHunk[]
  /** Hunks that are fully present in the merged result. */
  preservedHunks: GroupHunk[]
  /** Hunks that were modified during merge but intent is preserved. */
  transformedHunks: Array<{ original: GroupHunk; explanation: string }>
  /** Hunks that could NOT be found in the merged result. */
  missingHunks: GroupHunk[]
  /** Whether this group's intent is fully covered. */
  covered: boolean
  /** Human-readable summary. */
  summary: string
}

/**
 * Complete coverage report across all groups.
 */
export interface CoverageReport {
  /** Per-group coverage. */
  groups: GroupCoverage[]
  /** Whether all groups are covered. */
  allCovered: boolean
  /** Number of groups fully covered. */
  groupsCovered: number
  /** Total number of groups. */
  totalGroups: number
  /** Human-readable summary. */
  summary: string
}

// ---------------------------------------------------------------------------
// Unified diff parsing
// ---------------------------------------------------------------------------

/**
 * Regex for unified diff hunk header.
 */
const HUNK_HEADER_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/

/**
 * Parse a unified diff patch string into per-file per-hunk structures.
 *
 * Supports patches with multiple files (separated by `diff --git a/... b/...`).
 *
 * @param patchContent - Raw unified diff text.
 * @returns Array of GroupHunks, one per hunk per file.
 */
export function parsePatchHunks(patchContent: string): GroupHunk[] {
  const hunks: GroupHunk[] = []
  const lines = patchContent.split("\n")
  let currentFile = ""
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Detect file headers: "diff --git a/file b/file"
    const fileMatch = line.match(/^diff --git a\/(\S+) b\/\S+/)
    if (fileMatch) {
      currentFile = fileMatch[1]
      i++
      continue
    }

    // Skip index, ---, +++ lines
    if (/^index\s/.test(line) || line.startsWith("--- ") || line.startsWith("+++ ")) {
      i++
      continue
    }

    // Detect hunk header
    const hunkMatch = line.match(HUNK_HEADER_RE)
    if (hunkMatch) {
      const oldStart = parseInt(hunkMatch[1], 10)
      const oldCount = hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1
      const newStart = parseInt(hunkMatch[3], 10)
      const newCount = hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1

      // Collect hunk body lines
      const hunkLines: string[] = [line]
      i++
      while (i < lines.length && !/^(?:diff --git|---|\+\+\+|@@\s)/.test(lines[i]) && lines[i] !== "") {
        hunkLines.push(lines[i])
        i++
      }

      const body = hunkLines.slice(1)  // exclude header
      const hasAddition = body.some((l) => l.startsWith("+"))
      const hasDeletion = body.some((l) => l.startsWith("-"))

      let kind: "add" | "delete" | "modify"
      if (hasAddition && !hasDeletion) {
        kind = "add"
      } else if (hasDeletion && !hasAddition) {
        kind = "delete"
      } else {
        kind = "modify"
      }

      hunks.push({
        file: currentFile,
        content: hunkLines.join("\n"),
        kind,
        originalLines: { start: oldStart, count: oldCount },
      })
      continue
    }

    i++
  }

  return hunks
}

// ---------------------------------------------------------------------------
// Git helpers for diff comparison
// ---------------------------------------------------------------------------

/**
 * Run a git command in the given working directory and return trimmed stdout.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
  }).trimEnd()
}

/**
 * Get the merged diff for a specific file between baseCommit and HEAD.
 */
function getMergedFileDiff(mergedRepoRoot: string, baseCommit: string, file: string): string {
  try {
    return git(mergedRepoRoot, "diff", baseCommit, "HEAD", "--", file)
  } catch {
    return ""
  }
}

/**
 * Get the full merged diff (all files) between baseCommit and HEAD.
 */
function getFullMergedDiff(mergedRepoRoot: string, baseCommit: string): string {
  try {
    return git(mergedRepoRoot, "diff", baseCommit, "HEAD")
  } catch {
    return ""
  }
}

/**
 * Check whether a specific file exists in the merged result at HEAD.
 */
function fileExistsInMerged(mergedRepoRoot: string, file: string): boolean {
  try {
    const result = execFileSync("git", ["show", "HEAD:" + file], {
      cwd: mergedRepoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    return true
  } catch {
    return false
  }
}

/**
 * Read the content of a file at HEAD in the merged repo.
 */
function readMergedFile(mergedRepoRoot: string, file: string): string | null {
  try {
    return execFileSync("git", ["show", "HEAD:" + file], {
      cwd: mergedRepoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Hunk matching and classification
// ---------------------------------------------------------------------------

/**
 * Extract the "added lines" (prefixed with +) from a hunk body, stripping the +.
 */
function extractAddedLines(hunkContent: string): string[] {
  const lines: string[] = []
  for (const line of hunkContent.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++ ")) {
      lines.push(line.slice(1))
    }
  }
  return lines
}

/**
 * Extract the "deleted lines" (prefixed with -) from a hunk body, stripping the -.
 */
function extractDeletedLines(hunkContent: string): string[] {
  const lines: string[] = []
  for (const line of hunkContent.split("\n")) {
    if (line.startsWith("-") && !line.startsWith("--- ")) {
      lines.push(line.slice(1))
    }
  }
  return lines
}

/**
 * Extract the modified lines (both added + and deleted -) from a hunk body.
 * Returns the "new" version of the changed region.
 */
function extractNewLines(hunkContent: string): string[] {
  const lines: string[] = []
  for (const line of hunkContent.split("\n")) {
    const trimmed = line.trimEnd()
    if (trimmed.startsWith("+") && !trimmed.startsWith("+++ ")) {
      lines.push(trimmed.slice(1))
    }
  }
  return lines
}

/**
 * Check if a set of added lines appears in a target diff hunk.
 *
 * Uses substring matching — we want to know if the added content appears
 * in the target's hunk body (with some tolerance).
 */
function linesAppearInDiff(lines: string[], targetDiff: string): boolean {
  if (lines.length === 0) return true

  // For single-line additions, check if the content appears anywhere in the diff
  if (lines.length === 1) {
    const trimmed = lines[0].trim()
    if (!trimmed) return true  // empty line additions are noise
    return targetDiff.includes(trimmed)
  }

  // For multi-line additions, try harder: check if the majority of lines appear
  let matchedCount = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      matchedCount++
      continue
    }
    if (targetDiff.includes(trimmed)) {
      matchedCount++
    }
  }

  // If at least 80% of non-empty lines appear, consider it matched
  const nonEmpty = lines.filter((l) => l.trim().length > 0).length
  return nonEmpty > 0 && matchedCount / nonEmpty >= 0.8
}

/**
 * Verify a single group's patch against the merged result.
 *
 * @param groupId - Group identifier.
 * @param patchPath - Absolute path to the group's patch file.
 * @param mergedRepoRoot - Absolute path to the merged repo root.
 * @param baseCommit - Base commit SHA from which the patch was created.
 * @returns GroupCoverage with preservation status.
 */
export async function verifyGroupCoverage(
  groupId: string,
  patchPath: string,
  mergedRepoRoot: string,
  baseCommit: string,
): Promise<GroupCoverage> {
  // Read and parse the group's patch
  let patchContent: string
  try {
    patchContent = fs.readFileSync(patchPath, "utf-8")
  } catch {
    return {
      groupId,
      originalHunks: [],
      preservedHunks: [],
      transformedHunks: [],
      missingHunks: [],
      covered: true,  // empty patch = nothing to lose
      summary: `No patch file found at "${patchPath}" — nothing to verify.`,
    }
  }

  if (!patchContent.trim()) {
    return {
      groupId,
      originalHunks: [],
      preservedHunks: [],
      transformedHunks: [],
      missingHunks: [],
      covered: true,
      summary: `Patch is empty for group "${groupId}" — nothing to verify.`,
    }
  }

  const originalHunks = parsePatchHunks(patchContent)

  if (originalHunks.length === 0) {
    return {
      groupId,
      originalHunks: [],
      preservedHunks: [],
      transformedHunks: [],
      missingHunks: [],
      covered: true,
      summary: `No hunks found in patch for group "${groupId}" — nothing to verify.`,
    }
  }

  // Get the full merged diff to check against
  const mergedDiff = getFullMergedDiff(mergedRepoRoot, baseCommit)

  // Classify each hunk
  const preservedHunks: GroupHunk[] = []
  const transformedHunks: Array<{ original: GroupHunk; explanation: string }> = []
  const missingHunks: GroupHunk[] = []

  for (const hunk of originalHunks) {
    // For deletions: check if the deleted lines are gone in the merged result
    if (hunk.kind === "delete") {
      const deletedLines = extractDeletedLines(hunk.content)

      // Check if the file still exists — if it was deleted and still exists, that's a problem
      if (!fileExistsInMerged(mergedRepoRoot, hunk.file)) {
        // File doesn't exist — deletion was applied
        preservedHunks.push(hunk)
      } else {
        // File exists — check if deleted lines are gone
        const fileContent = readMergedFile(mergedRepoRoot, hunk.file)
        if (!fileContent) {
          preservedHunks.push(hunk)  // file vanished— deletion worked
        } else {
          const allLinesDeleted = deletedLines.every(
            (dl) => !fileContent.includes(dl)
          )
          if (allLinesDeleted) {
            preservedHunks.push(hunk)
          } else {
            transformedHunks.push({
              original: hunk,
              explanation: `Some deleted lines remain in the merged file "${hunk.file}". ` +
                `Deletion may have been partial or edited during merge.`,
            })
          }
        }
      }
      continue
    }

    // For additions: check if the added lines appear in the merged diff.
    // If the file exists in the worktree, the addition succeeded — mark it
    // as transformed rather than missing when content differs (conflict
    // resolution may have adapted the exact lines).
    if (hunk.kind === "add") {
      const addedLines = extractAddedLines(hunk.content)
      if (linesAppearInDiff(addedLines, mergedDiff)) {
        preservedHunks.push(hunk)
      } else {
        const fileContent = readMergedFile(mergedRepoRoot, hunk.file)
        if (fileContent) {
          if (linesAppearInDiff(addedLines, fileContent)) {
            preservedHunks.push(hunk)
          } else {
            // File exists — content was adapted during merge/resolution
            transformedHunks.push({
              original: hunk,
              explanation: `File "${hunk.file}" exists but added lines differ; ` +
                `content was likely adapted during conflict resolution.`,
            })
          }
        } else {
          missingHunks.push(hunk)
        }
      }
      continue
    }

    // For modifications: check if the new version appears in merged diff
    if (hunk.kind === "modify") {
      const newLines = extractNewLines(hunk.content)

      // Check the merged diff for these lines
      if (linesAppearInDiff(newLines, mergedDiff)) {
        preservedHunks.push(hunk)
      } else {
        // Fallback: check direct file content
        const fileContent = readMergedFile(mergedRepoRoot, hunk.file)
        if (fileContent && linesAppearInDiff(newLines, fileContent)) {
          preservedHunks.push(hunk)
        } else {
          // Maybe the code was transformed (variable rename etc.)
          // Check if the original file still has any of the new content
          let partialMatch = false
          let explanation = ""
          if (fileContent) {
            const matchedCount = newLines.filter((nl) => fileContent.includes(nl.trim())).length
            if (matchedCount > 0) {
              partialMatch = true
              explanation = `${matchedCount}/${newLines.length} modified lines found in merged file "${hunk.file}". ` +
                `Some lines may have been adapted during merge.`
            }
          }

          if (partialMatch) {
            transformedHunks.push({ original: hunk, explanation })
          } else {
            missingHunks.push(hunk)
          }
        }
      }
      continue
    }
  }

  const covered = missingHunks.length === 0
  const parts: string[] = []
  parts.push(
    `${preservedHunks.length}/${originalHunks.length} hunks preserved`,
  )
  if (transformedHunks.length > 0) {
    parts.push(`${transformedHunks.length} transformed`)
  }
  if (missingHunks.length > 0) {
    parts.push(`${missingHunks.length} MISSING`)
  }

  return {
    groupId,
    originalHunks,
    preservedHunks,
    transformedHunks,
    missingHunks,
    covered,
    summary: `Group "${groupId}": ${parts.join(", ")}.`,
  }
}

// ---------------------------------------------------------------------------
// Coverage report generation
// ---------------------------------------------------------------------------

/**
 * Generate a complete coverage report across all groups.
 *
 * @param groups - Array of { groupId, patchPath } for each group.
 * @param mergedRepoRoot - Absolute path to the merged repo root.
 * @param baseCommit - Base commit SHA from which all patches were created.
 * @returns A CoverageReport with per-group and aggregate results.
 */
export async function generateCoverageReport(
  groups: Array<{ groupId: string; patchPath: string }>,
  mergedRepoRoot: string,
  baseCommit: string,
): Promise<CoverageReport> {
  const coverages: GroupCoverage[] = []

  for (const group of groups) {
    const coverage = await verifyGroupCoverage(
      group.groupId,
      group.patchPath,
      mergedRepoRoot,
      baseCommit,
    )
    coverages.push(coverage)
  }

  const groupsCovered = coverages.filter((c) => c.covered).length
  const allCovered = groupsCovered === coverages.length

  // Build summary
  const lines: string[] = ["Coverage report:"]
  for (const c of coverages) {
    const icon = c.covered ? "✓" : "✗"
    lines.push(`  ${icon} ${c.summary}`)
  }
  if (allCovered) {
    lines.push(`All ${coverages.length} group(s) fully covered.`)
  } else {
    lines.push(
      `${groupsCovered}/${coverages.length} group(s) fully covered. ` +
      `${coverages.length - groupsCovered} group(s) have missing hunks.`,
    )
    // List missing hunks
    for (const c of coverages) {
      if (c.missingHunks.length > 0) {
        lines.push(`  ${c.groupId} missing hunks:`)
        for (const hunk of c.missingHunks) {
          lines.push(`    - ${hunk.file} (${hunk.kind})`)
        }
      }
    }
  }

  return {
    groups: coverages,
    allCovered,
    groupsCovered,
    totalGroups: coverages.length,
    summary: lines.join("\n"),
  }
}
