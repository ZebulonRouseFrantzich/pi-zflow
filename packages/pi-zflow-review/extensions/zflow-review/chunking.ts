/**
 * chunking.ts — Large diff chunking with line-number preservation.
 *
 * Splits large diffs into file-group chunks for parallel multi-reviewer
 * dispatch, preserving original file paths and right-side/new-side line
 * numbers so that inline comment submission coordinates remain accurate.
 *
 * ## Chunking strategy
 *
 * - Files are grouped into chunks respecting `maxFilesPerChunk` and
 *   `maxLinesPerChunk` limits.
 * - Each file belongs entirely to one chunk (no intra-file splitting).
 * - Each chunk carries a `lineMap` that maps review-line-index to
 *   actual new-side line number for accurate comment placement.
 * - After review, chunked findings can be merged back and line numbers
 *   adjusted to actual file coordinates via `mergeChunkFindings`.
 *
 * @module pi-zflow-review/chunking
 */

// ── Types ──────────────────────────────────────────────────────

/**
 * Configuration options for diff chunking.
 */
export interface ChunkingOptions {
  /** Maximum number of files per chunk. Default: 10 */
  maxFilesPerChunk: number
  /** Maximum total patch change-lines per chunk. Default: 500 */
  maxLinesPerChunk: number
}

/**
 * A single chunk of a large diff, ready for dispatch to a reviewer agent.
 */
export interface DiffChunk {
  /** Unique chunk identifier (e.g. "chunk-1") */
  chunkId: string
  /** Files in this chunk */
  files: Array<{
    /** File path relative to repository root */
    path: string
    /** Unified diff patch for this file */
    patch: string
    /** Maps review-line-index (0-based) to actual new-side line number */
    lineMap: Record<number, number>
  }>
  /** Total change-lines across all files in this chunk */
  totalLines: number
}

/**
 * The complete result of chunking a diff.
 */
export interface ChunkingResult {
  /** The individual chunks */
  chunks: DiffChunk[]
  /** Total number of files across all chunks */
  totalFiles: number
  /** Total change-lines across all chunks */
  totalLines: number
  /** Number of chunks created */
  chunkCount: number
}

/**
 * A single finding produced by a reviewer for a chunk.
 */
export interface ChunkFinding {
  /** File path the finding refers to */
  file: string
  /** Line number in the chunk's diff coordinates (0-based) */
  diffLine: number
  /** Severity of the finding */
  severity: string
  /** Finding description */
  message: string
}

/**
 * Review results for a single chunk.
 */
export interface ChunkResult {
  /** The chunk identifier this result corresponds to */
  chunkId: string
  /** Findings produced for this chunk */
  findings: ChunkFinding[]
  /** The lineMap used for this chunk (preserved for line adjustment) */
  lineMapByFile: Record<string, Record<number, number>>
}

// ── Defaults ──────────────────────────────────────────────────

const DEFAULT_CHUNK_OPTIONS: ChunkingOptions = {
  maxFilesPerChunk: 10,
  maxLinesPerChunk: 500,
}

// ── Chunk ID counter (per session for deterministic IDs) ───────

let _chunkCounter = 0

/**
 * Reset the chunk counter (useful for testing isolation).
 */
export function resetChunkCounter(): void {
  _chunkCounter = 0
}

function nextChunkId(): string {
  _chunkCounter++
  return `chunk-${_chunkCounter}`
}

// ── Patch line-number parsing ──────────────────────────────────

/**
 * Parsed line-number information from a unified diff hunk header.
 */
export interface PatchLineNumbers {
  /** Starting line number in the old file (1-based) */
  oldStart: number
  /** Number of lines in the old file hunk */
  oldLines: number
  /** Starting line number in the new file (1-based) */
  newStart: number
  /** Number of lines in the new file hunk */
  newLines: number
}

/**
 * Parse the line-number information from the first `@@` hunk header
 * in a unified diff patch.
 *
 * @param patch - Unified diff patch content.
 * @returns Parsed line numbers, or `null` if no hunk header is found.
 *
 * @example
 * ```ts
 * parsePatchLineNumbers("@@ -10,7 +12,9 @@ some context")
 * // => { oldStart: 10, oldLines: 7, newStart: 12, newLines: 9 }
 * ```
 */
export function parsePatchLineNumbers(patch: string): PatchLineNumbers | null {
  const match = patch.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/m)
  if (!match) return null

  return {
    oldStart: parseInt(match[1], 10),
    oldLines: match[2] ? parseInt(match[2], 10) : 1,
    newStart: parseInt(match[3], 10),
    newLines: match[4] ? parseInt(match[4], 10) : 1,
  }
}

/**
 * Parse all hunk headers from a unified diff patch and return an array
 * of line-number info objects.
 *
 * @param patch - Unified diff patch content.
 * @returns Array of parsed line numbers for each hunk.
 */
export function parseAllHunkLineNumbers(patch: string): PatchLineNumbers[] {
  const results: PatchLineNumbers[] = []
  const regex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm
  let match: RegExpExecArray | null

  while ((match = regex.exec(patch)) !== null) {
    results.push({
      oldStart: parseInt(match[1], 10),
      oldLines: match[2] ? parseInt(match[2], 10) : 1,
      newStart: parseInt(match[3], 10),
      newLines: match[4] ? parseInt(match[4], 10) : 1,
    })
  }

  return results
}

// ── Line map construction ──────────────────────────────────────

/**
 * Build a map from review-line-index to actual new-side line number.
 *
 * The review-line-index is a 0-based index into the patch content
 * (excluding hunk headers). The returned map allows converting a
 * line reference in a chunk to the actual line number in the new
 * version of the file.
 *
 * **Mapping rules:**
 * - Context lines (no prefix): increment new-line counter, store mapping.
 * - Additions (`+`): increment new-line counter, store mapping.
 * - Deletions (`-`): do NOT increment new-line counter, but DO increment
 *   review index. No mapping is stored (these lines don't exist in new file).
 * - Hunk headers (`@@ ... @@`): reset the new-line counter for the next hunk.
 * - Trailing `\ No newline at end of file`: skipped, no index increment.
 *
 * @param patch - Unified diff patch content.
 * @returns A record mapping 0-based review-line-index → new-side line number.
 *
 * @example
 * ```ts
 * const patch = [
 *   "@@ -1,3 +1,4 @@",
 *   " unchanged",
 *   "+addition",
 *   " context",
 * ].join("\n")
 *
 * buildLineMap(patch)
 * // => { 0: 1, 1: 2, 2: 3 }
 * ```
 */
export function buildLineMap(patch: string): Record<number, number> {
  const lines = patch.split("\n")
  const map: Record<number, number> = {}
  let newLineNum = 0
  let reviewIndex = 0
  let inHunk = false

  for (const line of lines) {
    // Skip empty trailing lines
    if (line === "" && !inHunk) continue

    // Hunk header — reset new-line counter for this hunk
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunkMatch) {
      newLineNum = parseInt(hunkMatch[1], 10)
      inHunk = true
      continue
    }

    // Before first hunk header — skip (file metadata lines)
    if (!inHunk) continue

    // `\ No newline at end of file` — skip, counts as neither context nor change
    if (line === "\\ No newline at end of file") continue

    // Deletion — only advances review index, not line number
    if (line.startsWith("-")) {
      reviewIndex++
      continue
    }

    // Addition or context — advances both
    if (line.startsWith("+") || line.startsWith(" ")) {
      map[reviewIndex] = newLineNum
      reviewIndex++
      newLineNum++
      continue
    }

    // Any other line (shouldn't occur in well-formed patches)
    reviewIndex++
  }

  return map
}

// ── Chunk size estimation ──────────────────────────────────────

/**
 * Estimate the total change-lines across an array of files.
 *
 * Counts only non-context, non-empty lines in patches — i.e., lines
 * starting with `+` (additions) or `-` (deletions). Context lines
 * and hunk headers are not counted.
 *
 * @param files - Array of files with patches.
 * @returns Total number of change-lines across all files.
 *
 * @example
 * ```ts
 * const files = [
 *   { path: "a.ts", patch: "@@ -1 +1 @@\n-old\n+new" },
 * ]
 * estimateChunkSize(files) // => 2
 * ```
 */
export function estimateChunkSize(
  files: Array<{ path: string; patch?: string }>,
): number {
  let total = 0

  for (const file of files) {
    if (!file.patch) continue

    const lines = file.patch.split("\n")
    for (const line of lines) {
      // Count additions and deletions; skip context, headers, and metadata
      if (line.startsWith("+") || line.startsWith("-")) {
        // Skip hunk headers (they start with @@, not + or -)
        if (line.startsWith("+++") || line.startsWith("---")) continue
        total++
      }
    }
  }

  return total
}

// ── Chunk creation ─────────────────────────────────────────────

/**
 * Build a line map for each file in a chunk.
 */
function buildChunkLineMaps(
  files: Array<{ path: string; patch?: string }>,
): DiffChunk["files"] {
  return files.map((f) => ({
    path: f.path,
    patch: f.patch ?? "",
    lineMap: buildLineMap(f.patch ?? ""),
  }))
}

/**
 * Split an array of patch files into chunks that respect size limits.
 *
 * **Chunking strategy:**
 * 1. Files are processed in order and grouped into chunks.
 * 2. A file is added to the current chunk if it fits within both
 *    `maxFilesPerChunk` and `maxLinesPerChunk`.
 * 3. If a file exceeds `maxLinesPerChunk` on its own, it gets its own
 *    chunk (single-file chunk).
 * 4. Each chunk has a unique sequential ID ("chunk-1", "chunk-2", ...).
 *
 * @param files - Array of file entries with `path` and optional `patch`.
 * @param options - Chunking configuration (optional, sensible defaults).
 * @returns The chunking result with all chunks and summary stats.
 *
 * @example
 * ```ts
 * const result = chunkDiff(files, { maxFilesPerChunk: 3, maxLinesPerChunk: 200 })
 * console.log(result.chunkCount) // number of chunks
 * ```
 */
export function chunkDiff(
  files: Array<{ path: string; patch?: string }>,
  options?: Partial<ChunkingOptions>,
): ChunkingResult {
  const opts: ChunkingOptions = { ...DEFAULT_CHUNK_OPTIONS, ...options }

  if (files.length === 0) {
    return {
      chunks: [],
      totalFiles: 0,
      totalLines: 0,
      chunkCount: 0,
    }
  }

  const chunks: DiffChunk[] = []
  let currentFileGroup: Array<{ path: string; patch?: string }> = []
  let currentLines = 0

  // Helper to flush the current group into a new chunk
  function flushCurrentGroup(): void {
    if (currentFileGroup.length === 0) return

    const chunkFiles = buildChunkLineMaps(currentFileGroup)
    chunks.push({
      chunkId: nextChunkId(),
      files: chunkFiles,
      totalLines: currentLines,
    })

    currentFileGroup = []
    currentLines = 0
  }

  for (const file of files) {
    const fileLines = estimateChunkSize([file])

    // Single file that exceeds the max-line limit — give it its own chunk
    if (fileLines > opts.maxLinesPerChunk) {
      flushCurrentGroup() // flush any pending files first

      const chunkFiles = buildChunkLineMaps([file])
      chunks.push({
        chunkId: nextChunkId(),
        files: chunkFiles,
        totalLines: fileLines,
      })
      continue
    }

    // If adding this file would exceed limits, start a new chunk
    if (
      currentFileGroup.length >= opts.maxFilesPerChunk ||
      currentLines + fileLines > opts.maxLinesPerChunk
    ) {
      flushCurrentGroup()
    }

    currentFileGroup.push(file)
    currentLines += fileLines
  }

  // Flush any remaining files
  flushCurrentGroup()

  const totalLines = chunks.reduce((sum, c) => sum + c.totalLines, 0)

  return {
    chunks,
    totalFiles: files.length,
    totalLines,
    chunkCount: chunks.length,
  }
}

// ── Finding merge ──────────────────────────────────────────────

/**
 * Combine findings from multiple chunk reviews into a single unified
 * array, adjusting line numbers from chunk-diff coordinates to actual
 * new-file line numbers using each chunk's lineMap.
 *
 * Each finding in a `ChunkResult` carries a `diffLine` that refers to the
 * 0-based review-line-index within the chunk's patch. This function uses
 * the chunk's `lineMapByFile` to translate that to the actual line number
 * in the new version of the file.
 *
 * If a finding's `diffLine` is not found in the lineMap (e.g., it refers
 * to a deleted line), the line is left as-is but marked as a deletion-line
 * reference (the line does not exist in the new file).
 *
 * @param chunkResults - Array of review results from chunk reviewers.
 * @returns Unified findings with line numbers adjusted to actual file lines.
 */
export function mergeChunkFindings(
  chunkResults: ChunkResult[],
): Array<ChunkFinding & { actualLine?: number; isDeletionLine?: boolean }> {
  const merged: Array<ChunkFinding & { actualLine?: number; isDeletionLine?: boolean }> = []

  for (const result of chunkResults) {
    for (const finding of result.findings) {
      const fileLineMap = result.lineMapByFile[finding.file]
      let actualLine: number | undefined
      let isDeletionLine = false

      if (fileLineMap && finding.diffLine in fileLineMap) {
        actualLine = fileLineMap[finding.diffLine]
      } else if (fileLineMap) {
        // The line number is in the diff but not in the new file (deletion)
        isDeletionLine = true
      }

      merged.push({
        ...finding,
        actualLine,
        isDeletionLine,
      })
    }
  }

  return merged
}
