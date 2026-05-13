/**
 * diff-baseline.test.ts — Tests for diff baseline resolution helpers.
 *
 * Covers:
 *   - resolveDiffBaseline: default, explicit, head, merge-base, precedence
 *   - buildDiffCommand: default, custom head, explicit baseline, three-dot
 *   - parseDiffBaselineOverride: valid strings, empty input
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  resolveDiffBaseline,
  buildDiffCommand,
  parseDiffBaselineOverride,
} from "../extensions/zflow-review/diff-baseline.js"

import type {
  DiffBaselineInput,
  ResolvedBaseline,
} from "../extensions/zflow-review/diff-baseline.js"

// ── resolveDiffBaseline ────────────────────────────────────────

void describe("resolveDiffBaseline", () => {
  it("should return 'main' with 'default' resolution when no options given", () => {
    const result = resolveDiffBaseline({})
    assert.equal(result.baseRef, "main")
    assert.equal(result.resolution, "default")
    assert.equal(result.diffCommand, "git diff main...HEAD")
  })

  it("should return 'main' with 'default' resolution when called with empty input", () => {
    const result = resolveDiffBaseline()
    assert.equal(result.baseRef, "main")
    assert.equal(result.resolution, "default")
  })

  it("should return explicit baseRef with 'explicit' resolution", () => {
    const result = resolveDiffBaseline({ baseRef: "origin/stable-v2" })
    assert.equal(result.baseRef, "origin/stable-v2")
    assert.equal(result.resolution, "explicit")
    assert.equal(result.diffCommand, "git diff origin/stable-v2..HEAD")
  })

  it("should return 'HEAD' with 'head' resolution when useHead is true", () => {
    const result = resolveDiffBaseline({ useHead: true })
    assert.equal(result.baseRef, "HEAD")
    assert.equal(result.resolution, "head")
    assert.equal(result.diffCommand, "git diff HEAD")
  })

  it("should return 'main' with 'merge-base' resolution when useMergeBase is true", () => {
    const result = resolveDiffBaseline({ useMergeBase: true })
    assert.equal(result.baseRef, "main")
    assert.equal(result.resolution, "merge-base")
    assert.equal(result.diffCommand, "git diff main...HEAD")
  })

  it("should prefer explicit baseRef over useHead", () => {
    const result = resolveDiffBaseline({
      baseRef: "develop",
      useHead: true,
    })
    assert.equal(result.baseRef, "develop")
    assert.equal(result.resolution, "explicit")
  })

  it("should prefer explicit baseRef over useMergeBase", () => {
    const result = resolveDiffBaseline({
      baseRef: "origin/release-1.0",
      useMergeBase: true,
    })
    assert.equal(result.baseRef, "origin/release-1.0")
    assert.equal(result.resolution, "explicit")
  })

  it("should prefer useHead over useMergeBase", () => {
    const result = resolveDiffBaseline({
      useHead: true,
      useMergeBase: true,
    })
    assert.equal(result.baseRef, "HEAD")
    assert.equal(result.resolution, "head")
  })

  it("should handle SHA-like baseRef", () => {
    const result = resolveDiffBaseline({
      baseRef: "abc123def456",
    })
    assert.equal(result.baseRef, "abc123def456")
    assert.equal(result.resolution, "explicit")
  })

  it("should handle tag-like baseRef", () => {
    const result = resolveDiffBaseline({
      baseRef: "v1.2.3",
    })
    assert.equal(result.baseRef, "v1.2.3")
    assert.equal(result.resolution, "explicit")
  })
})

// ── buildDiffCommand ───────────────────────────────────────────

void describe("buildDiffCommand", () => {
  it("should produce default 'git diff main...HEAD'", () => {
    const cmd = buildDiffCommand("main", "HEAD")
    assert.equal(cmd, "git diff main...HEAD")
  })

  it("should accept a custom head ref", () => {
    const cmd = buildDiffCommand("main", "feature-branch")
    assert.equal(cmd, "git diff main...feature-branch")
  })

  it("should accept a custom baseline", () => {
    const cmd = buildDiffCommand("origin/stable", "HEAD")
    assert.equal(cmd, "git diff origin/stable...HEAD")
  })

  it("should default headRef to HEAD when omitted", () => {
    const cmd = buildDiffCommand("main")
    assert.equal(cmd, "git diff main...HEAD")
  })

  it("should use three-dot notation by default", () => {
    const cmd = buildDiffCommand("main", "feature")
    assert.ok(cmd.includes("..."))
  })

  it("should accept empty string baseline", () => {
    const cmd = buildDiffCommand("", "HEAD")
    assert.equal(cmd, "git diff ...HEAD")
  })
})

// ── parseDiffBaselineOverride ──────────────────────────────────

void describe("parseDiffBaselineOverride", () => {
  it("should return 'HEAD' for 'HEAD'", () => {
    const result = parseDiffBaselineOverride("HEAD")
    assert.equal(result, "HEAD")
  })

  it("should return 'main' for 'main'", () => {
    const result = parseDiffBaselineOverride("main")
    assert.equal(result, "main")
  })

  it("should return SHA for a SHA input", () => {
    const result = parseDiffBaselineOverride("a1b2c3d4e5f6")
    assert.equal(result, "a1b2c3d4e5f6")
  })

  it("should return 'origin/feature' for 'origin/feature'", () => {
    const result = parseDiffBaselineOverride("origin/feature")
    assert.equal(result, "origin/feature")
  })

  it("should return undefined for empty string", () => {
    const result = parseDiffBaselineOverride("")
    assert.equal(result, undefined)
  })

  it("should return undefined for whitespace-only string", () => {
    const result = parseDiffBaselineOverride("   ")
    assert.equal(result, undefined)
  })

  it("should trim whitespace from input", () => {
    const result = parseDiffBaselineOverride("  main  ")
    assert.equal(result, "main")
  })

  it("should preserve case sensitivity", () => {
    const result = parseDiffBaselineOverride("HEAD")
    assert.equal(result, "HEAD")
  })
})
