/**
 * chunking.test.ts — Tests for diff chunking, line-map construction,
 * patch-line-number parsing, size estimation, and finding merging.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  chunkDiff,
  buildLineMap,
  parsePatchLineNumbers,
  parseAllHunkLineNumbers,
  estimateChunkSize,
  mergeChunkFindings,
  resetChunkCounter,
} from "../extensions/zflow-review/chunking.js"

import type {
  ChunkingResult,
  ChunkFinding,
  ChunkResult,
} from "../extensions/zflow-review/chunking.js"

// ── parsePatchLineNumbers ──────────────────────────────────────

void describe("parsePatchLineNumbers", () => {
  it("should parse a standard hunk header", () => {
    const result = parsePatchLineNumbers("@@ -10,7 +12,9 @@ some context")
    assert.deepEqual(result, { oldStart: 10, oldLines: 7, newStart: 12, newLines: 9 })
  })

  it("should parse a hunk header without line counts", () => {
    const result = parsePatchLineNumbers("@@ -1 +2 @@")
    assert.deepEqual(result, { oldStart: 1, oldLines: 1, newStart: 2, newLines: 1 })
  })

  it("should parse a hunk header with single-line changes", () => {
    const result = parsePatchLineNumbers("@@ -5,1 +5,1 @@")
    assert.deepEqual(result, { oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 })
  })

  it("should return null for a patch with no hunk header", () => {
    const result = parsePatchLineNumbers("no hunk header here")
    assert.equal(result, null)
  })

  it("should return null for an empty patch", () => {
    const result = parsePatchLineNumbers("")
    assert.equal(result, null)
  })

  it("should parse the first hunk when multiple hunks are present", () => {
    const result = parsePatchLineNumbers(
      "@@ -1,3 +1,4 @@\n context\n+add\n@@ -10,5 +11,6 @@\n more\n",
    )
    assert.deepEqual(result, { oldStart: 1, oldLines: 3, newStart: 1, newLines: 4 })
  })
})

// ── parseAllHunkLineNumbers ────────────────────────────────────

void describe("parseAllHunkLineNumbers", () => {
  it("should parse all hunk headers in a multi-hunk patch", () => {
    const patch = "@@ -1,3 +1,4 @@\n a\n@@ -10,5 +11,6 @@\n b\n@@ -20,2 +21,3 @@\n c\n"
    const results = parseAllHunkLineNumbers(patch)
    assert.equal(results.length, 3)
    assert.deepEqual(results[0], { oldStart: 1, oldLines: 3, newStart: 1, newLines: 4 })
    assert.deepEqual(results[1], { oldStart: 10, oldLines: 5, newStart: 11, newLines: 6 })
    assert.deepEqual(results[2], { oldStart: 20, oldLines: 2, newStart: 21, newLines: 3 })
  })

  it("should return empty array for patch with no hunks", () => {
    assert.deepEqual(parseAllHunkLineNumbers("no hunks"), [])
  })

  it("should return empty array for empty patch", () => {
    assert.deepEqual(parseAllHunkLineNumbers(""), [])
  })
})

// ── buildLineMap ───────────────────────────────────────────────

void describe("buildLineMap", () => {
  it("should map context lines correctly", () => {
    const patch = [
      "@@ -1,3 +1,3 @@",
      " first",
      " second",
      " third",
    ].join("\n")

    const map = buildLineMap(patch)
    assert.deepEqual(map, { 0: 1, 1: 2, 2: 3 })
  })

  it("should map additions and skip deletions", () => {
    const patch = [
      "@@ -1,4 +1,5 @@",
      " unchanged",
      "+added",
      "-deleted",
      " still-here",
    ].join("\n")

    const map = buildLineMap(patch)
    // review index 0 = " unchanged" → line 1 (context)
    // review index 1 = "+added" → line 2 (addition)
    // review index 2 = "-deleted" → no mapping (deletion)
    // review index 3 = " still-here" → line 3 (context)
    assert.deepEqual(map, { 0: 1, 1: 2, 3: 3 })
  })

  it("should reset new-line counter for each hunk", () => {
    const patch = [
      "@@ -1,2 +1,2 @@",
      " old-line-1",
      " old-line-2",
      "@@ -10,2 +11,2 @@",
      " new-hunk-line-1",
      " new-hunk-line-2",
    ].join("\n")

    const map = buildLineMap(patch)
    // Hunk 1: lines at 1, 2
    // Hunk 2: starts at line 11, so lines at 11, 12
    assert.deepEqual(map, { 0: 1, 1: 2, 2: 11, 3: 12 })
  })

  it("should skip No newline at end of file marker", () => {
    const patch = [
      "@@ -1,2 +1,3 @@",
      " line-one",
      "+line-two",
      "\\ No newline at end of file",
    ].join("\n")

    const map = buildLineMap(patch)
    assert.deepEqual(map, { 0: 1, 1: 2 })
  })

  it("should handle empty patch", () => {
    const map = buildLineMap("")
    assert.deepEqual(map, {})
  })

  it("should handle patch with no hunk header", () => {
    const map = buildLineMap("some random text")
    assert.deepEqual(map, {})
  })

  it("should handle file metadata lines before first hunk", () => {
    const patch = [
      "--- a/old.ts",
      "+++ b/new.ts",
      "@@ -1,2 +1,2 @@",
      " line-a",
      " line-b",
    ].join("\n")

    const map = buildLineMap(patch)
    assert.deepEqual(map, { 0: 1, 1: 2 })
  })
})

// ── estimateChunkSize ─────────────────────────────────────────

void describe("estimateChunkSize", () => {
  it("should count additions and deletions", () => {
    const files = [
      { path: "a.ts", patch: "@@ -1,4 +1,4 @@\n unchanged\n+added\n-removed\n context" },
    ]
    assert.equal(estimateChunkSize(files), 2)
  })

  it("should not count context lines or hunk headers", () => {
    const files = [
      {
        path: "a.ts",
        patch: [
          "@@ -1,5 +1,6 @@",
          " context-1",
          "+addition-1",
          " context-2",
          " context-3",
          "-deletion-1",
          "+addition-2",
        ].join("\n"),
      },
    ]
    // additions: "+addition-1", "+addition-2" = 2
    // deletions: "-deletion-1" = 1
    // total: 3
    assert.equal(estimateChunkSize(files), 3)
  })

  it("should return 0 for files with no patch", () => {
    const files = [{ path: "a.ts" }]
    assert.equal(estimateChunkSize(files), 0)
  })

  it("should return 0 for empty file list", () => {
    assert.equal(estimateChunkSize([]), 0)
  })

  it("should not count ---/+++ file metadata lines", () => {
    const files = [
      {
        path: "a.ts",
        patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
      },
    ]
    assert.equal(estimateChunkSize(files), 2)
  })

  it("should sum across multiple files", () => {
    const files = [
      { path: "a.ts", patch: "@@ -1,2 +1,3 @@\n a\n+b\n" },
      { path: "b.ts", patch: "@@ -1,1 +1,1 @@\n-c\n+d\n" },
      { path: "c.ts", patch: "" }, // no changes
    ]
    // a.ts: 1 addition, b.ts: 1 deletion + 1 addition = 2, total: 3
    assert.equal(estimateChunkSize(files), 3)
  })
})

// ── chunkDiff ──────────────────────────────────────────────────

void describe("chunkDiff", () => {
  it("should produce a single chunk for small diffs", () => {
    resetChunkCounter()
    const files = [
      { path: "a.ts", patch: "@@ -1,2 +1,2 @@\n-old\n+new\n" },
    ]

    const result = chunkDiff(files)
    assert.equal(result.chunkCount, 1)
    assert.equal(result.totalFiles, 1)
    assert.equal(result.chunks.length, 1)
    assert.equal(result.chunks[0].chunkId, "chunk-1")
  })

  it("should split files into multiple chunks when maxFilesPerChunk is exceeded", () => {
    resetChunkCounter()
    const files = Array.from({ length: 25 }, (_, i) => ({
      path: `file-${i}.ts`,
      patch: "@@ -1,2 +1,2 @@\n-old\n+new\n",
    }))

    const result = chunkDiff(files, { maxFilesPerChunk: 10, maxLinesPerChunk: 9999 })
    assert.equal(result.chunkCount, 3)
    assert.equal(result.totalFiles, 25)
    assert.equal(result.chunks[0].files.length, 10)
    assert.equal(result.chunks[1].files.length, 10)
    assert.equal(result.chunks[2].files.length, 5)
  })

  it("should respect maxFilesPerChunk limit", () => {
    resetChunkCounter()
    const files = Array.from({ length: 7 }, (_, i) => ({
      path: `f-${i}.ts`,
      patch: "@@ -1,1 +1,1 @@\n-x\n+y\n",
    }))

    const result = chunkDiff(files, { maxFilesPerChunk: 3, maxLinesPerChunk: 9999 })
    assert.equal(result.chunkCount, 3)
    assert.equal(result.chunks[0].files.length, 3)
    assert.equal(result.chunks[1].files.length, 3)
    assert.equal(result.chunks[2].files.length, 1)
  })

  it("should respect maxLinesPerChunk limit", () => {
    resetChunkCounter()
    // Each file has 2 change-lines (+ and -)
    const files = Array.from({ length: 6 }, (_, i) => ({
      path: `f-${i}.ts`,
      patch: [
        `@@ -1,3 +1,4 @@`,
        ` context-${i}-a`,
        `+addition-${i}`,
        `-deletion-${i}`,
        ` context-${i}-b`,
      ].join("\n"),
    }))

    // Each file = 2 change-lines, maxLinesPerChunk = 5 => max 2 files per chunk
    // 6 files / 2 per chunk = 3 chunks
    const result = chunkDiff(files, { maxFilesPerChunk: 9999, maxLinesPerChunk: 5 })
    assert.equal(result.chunkCount, 3)
    assert.equal(result.chunks[0].files.length, 2)
    assert.equal(result.chunks[1].files.length, 2)
    assert.equal(result.chunks[2].files.length, 2)
  })

  it("should put a single large file in its own chunk", () => {
    resetChunkCounter()
    const largePatch = Array.from({ length: 50 }, (_, i) => `+line-${i}`).join("\n")
    const files = [
      { path: "small.ts", patch: "@@ -1,1 +1,1 @@\n-x\n+y\n" },
      { path: "large.ts", patch: `@@ -1,50 +1,100 @@\n${largePatch}` },
      { path: "small2.ts", patch: "@@ -1,1 +1,1 @@\n-x\n+y\n" },
    ]

    const result = chunkDiff(files, { maxFilesPerChunk: 10, maxLinesPerChunk: 10 })
    assert.equal(result.chunkCount, 3)
    // chunk-1: small.ts (2 lines, fits in 10)
    // chunk-2: large.ts (50 lines, exceeds 10, gets its own chunk)
    // chunk-3: small2.ts (2 lines)
    assert.equal(result.chunks[0].files.length, 1)
    assert.equal(result.chunks[1].files.length, 1)
    assert.equal(result.chunks[2].files.length, 1)
    assert.equal(result.chunks[0].chunkId, "chunk-1")
    assert.equal(result.chunks[1].chunkId, "chunk-2")
    assert.equal(result.chunks[2].chunkId, "chunk-3")
  })

  it("should return chunks with lineMap for each file", () => {
    resetChunkCounter()
    const files = [
      { path: "a.ts", patch: "@@ -1,2 +1,3 @@\n old\n+new\n" },
    ]

    const result = chunkDiff(files)
    assert.ok(result.chunks[0].files[0].lineMap !== undefined)
    assert.ok(Object.keys(result.chunks[0].files[0].lineMap).length > 0)
  })

  it("should return empty result for empty file list", () => {
    const result = chunkDiff([])
    assert.deepEqual(result, { chunks: [], totalFiles: 0, totalLines: 0, chunkCount: 0 })
  })

  it("should use default options when none provided", () => {
    resetChunkCounter()
    const files = Array.from({ length: 5 }, (_, i) => ({
      path: `f-${i}.ts`,
      patch: "@@ -1,1 +1,1 @@\n-x\n+y\n",
    }))

    // Default maxFilesPerChunk is 10, so all 5 fit in one chunk
    const result = chunkDiff(files)
    assert.equal(result.chunkCount, 1)
    assert.equal(result.chunks[0].files.length, 5)
  })

  it("should preserve totalLines across chunks", () => {
    resetChunkCounter()
    const files = Array.from({ length: 4 }, (_, i) => ({
      path: `f-${i}.ts`,
      patch: "@@ -1,2 +1,2 @@\n-old\n+new\n",
    }))

    // Each file has 2 change-lines
    const result = chunkDiff(files, { maxFilesPerChunk: 2, maxLinesPerChunk: 9999 })
    assert.equal(result.totalLines, 8)
    assert.equal(result.chunks[0].totalLines, 4)
    assert.equal(result.chunks[1].totalLines, 4)
  })
})

// ── mergeChunkFindings ─────────────────────────────────────────

void describe("mergeChunkFindings", () => {
  it("should merge findings from multiple chunks", () => {
    const results: ChunkResult[] = [
      {
        chunkId: "chunk-1",
        findings: [
          { file: "a.ts", diffLine: 0, severity: "major", message: "Issue in a.ts" },
        ],
        lineMapByFile: { "a.ts": { 0: 42 } },
      },
      {
        chunkId: "chunk-2",
        findings: [
          { file: "b.ts", diffLine: 1, severity: "minor", message: "Issue in b.ts" },
        ],
        lineMapByFile: { "b.ts": { 1: 17 } },
      },
    ]

    const merged = mergeChunkFindings(results)
    assert.equal(merged.length, 2)
    assert.equal(merged[0].file, "a.ts")
    assert.equal(merged[0].actualLine, 42)
    assert.equal(merged[0].severity, "major")
    assert.equal(merged[1].file, "b.ts")
    assert.equal(merged[1].actualLine, 17)
  })

  it("should adjust line numbers using lineMap", () => {
    const results: ChunkResult[] = [
      {
        chunkId: "chunk-1",
        findings: [
          { file: "a.ts", diffLine: 0, severity: "critical", message: "Bug" },
          { file: "a.ts", diffLine: 1, severity: "nit", message: "Style" },
        ],
        lineMapByFile: { "a.ts": { 0: 10, 1: 11 } },
      },
    ]

    const merged = mergeChunkFindings(results)
    assert.equal(merged.length, 2)
    assert.equal(merged[0].actualLine, 10)
    assert.equal(merged[1].actualLine, 11)
  })

  it("should mark findings on deleted lines with isDeletionLine flag", () => {
    const results: ChunkResult[] = [
      {
        chunkId: "chunk-1",
        findings: [
          { file: "a.ts", diffLine: 2, severity: "major", message: "Deleted line issue" },
        ],
        lineMapByFile: { "a.ts": { 0: 1, 1: 2 } }, // no entry for diffLine 2
      },
    ]

    const merged = mergeChunkFindings(results)
    assert.equal(merged.length, 1)
    assert.equal(merged[0].actualLine, undefined)
    assert.equal(merged[0].isDeletionLine, true)
  })

  it("should return empty array when no results", () => {
    const merged = mergeChunkFindings([])
    assert.deepEqual(merged, [])
  })

  it("should handle chunk with no findings", () => {
    const results: ChunkResult[] = [
      {
        chunkId: "chunk-1",
        findings: [],
        lineMapByFile: { "a.ts": { 0: 1 } },
      },
    ]

    const merged = mergeChunkFindings(results)
    assert.deepEqual(merged, [])
  })

  it("should handle findings for files not in lineMap", () => {
    const results: ChunkResult[] = [
      {
        chunkId: "chunk-1",
        findings: [
          { file: "unknown.ts", diffLine: 0, severity: "info", message: "?" },
        ],
        lineMapByFile: { "a.ts": { 0: 1 } },
      },
    ]

    const merged = mergeChunkFindings(results)
    assert.equal(merged.length, 1)
    assert.equal(merged[0].actualLine, undefined)
    assert.equal(merged[0].isDeletionLine, false) // no lineMap entry at all
  })
})

// ── resetChunkCounter ──────────────────────────────────────────

void describe("resetChunkCounter", () => {
  it("should reset chunk IDs to start from chunk-1", () => {
    resetChunkCounter()
    const r1 = chunkDiff([{ path: "a.ts", patch: "@@ -1,1 +1,1 @@\n-x\n+y\n" }])
    assert.equal(r1.chunks[0].chunkId, "chunk-1")

    resetChunkCounter()
    const r2 = chunkDiff([{ path: "a.ts", patch: "@@ -1,1 +1,1 @@\n-x\n+y\n" }])
    assert.equal(r2.chunks[0].chunkId, "chunk-1")
  })
})
