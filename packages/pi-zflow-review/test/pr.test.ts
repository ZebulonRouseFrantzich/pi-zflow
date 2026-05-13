/**
 * pr.test.ts — Tests for PR/MR URL parsing, host detection, and CLI commands.
 *
 * Covers:
 *   - parsePrUrl: GitHub PR URLs (plain, /files, /commits, trailing slashes, query params)
 *   - parsePrUrl: GitLab MR URLs (plain, /diffs, trailing slashes, query params)
 *   - parsePrUrl: throws for invalid URLs, non-PR URLs, empty string
 *   - detectHost: github.com, gitlab.com, unknown, invalid URL
 *   - buildPrApiCommands: GitHub and GitLab command generation
 *   - validatePrUrl: valid, invalid, empty, edge cases
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  parsePrUrl,
  detectHost,
  buildPrApiCommands,
  validatePrUrl,
} from "../extensions/zflow-review/pr.js"

import type { ResolvedPrTarget } from "../extensions/zflow-review/pr.js"

// ── parsePrUrl ─────────────────────────────────────────────────

void describe("parsePrUrl", () => {
  // ── GitHub ──────────────────────────────────────────────────

  it("should parse a standard GitHub PR URL", () => {
    const result = parsePrUrl("https://github.com/owner/repo/pull/42")
    assert.equal(result.platform, "github")
    assert.equal(result.owner, "owner")
    assert.equal(result.repo, "repo")
    assert.equal(result.number, 42)
    assert.equal(result.url, "https://github.com/owner/repo/pull/42")
  })

  it("should parse a GitHub PR URL with /files suffix", () => {
    const result = parsePrUrl("https://github.com/zeb/pi/pull/123/files")
    assert.equal(result.platform, "github")
    assert.equal(result.owner, "zeb")
    assert.equal(result.repo, "pi")
    assert.equal(result.number, 123)
    assert.equal(result.url, "https://github.com/zeb/pi/pull/123")
  })

  it("should parse a GitHub PR URL with /commits suffix", () => {
    const result = parsePrUrl("https://github.com/org/repo-name/pull/7/commits")
    assert.equal(result.platform, "github")
    assert.equal(result.owner, "org")
    assert.equal(result.repo, "repo-name")
    assert.equal(result.number, 7)
  })

  it("should parse a GitHub PR URL with trailing slash", () => {
    const result = parsePrUrl("https://github.com/a/b/pull/99/")
    assert.equal(result.platform, "github")
    assert.equal(result.owner, "a")
    assert.equal(result.repo, "b")
    assert.equal(result.number, 99)
  })

  it("should parse a GitHub PR URL with query parameters", () => {
    const result = parsePrUrl("https://github.com/x/y/pull/5?diff=split")
    assert.equal(result.platform, "github")
    assert.equal(result.owner, "x")
    assert.equal(result.repo, "y")
    assert.equal(result.number, 5)
  })

  it("should parse a GitHub PR URL with owner containing dots and dashes", () => {
    const result = parsePrUrl("https://github.com/my-org.test/pi-zflow/pull/10")
    assert.equal(result.platform, "github")
    assert.equal(result.owner, "my-org.test")
    assert.equal(result.repo, "pi-zflow")
    assert.equal(result.number, 10)
  })

  // ── GitLab ──────────────────────────────────────────────────

  it("should parse a standard GitLab MR URL", () => {
    const result = parsePrUrl("https://gitlab.com/owner/repo/-/merge_requests/42")
    assert.equal(result.platform, "gitlab")
    assert.equal(result.owner, "owner")
    assert.equal(result.repo, "repo")
    assert.equal(result.number, 42)
    assert.equal(result.url, "https://gitlab.com/owner/repo/-/merge_requests/42")
  })

  it("should parse a GitLab MR URL with /diffs suffix", () => {
    const result = parsePrUrl("https://gitlab.com/group/project/-/merge_requests/7/diffs")
    assert.equal(result.platform, "gitlab")
    assert.equal(result.owner, "group")
    assert.equal(result.repo, "project")
    assert.equal(result.number, 7)
  })

  it("should parse a GitLab MR URL with trailing slash", () => {
    const result = parsePrUrl("https://gitlab.com/a/b/-/merge_requests/99/")
    assert.equal(result.platform, "gitlab")
    assert.equal(result.owner, "a")
    assert.equal(result.repo, "b")
    assert.equal(result.number, 99)
  })

  it("should parse a GitLab MR URL with query parameters", () => {
    const result = parsePrUrl("https://gitlab.com/x/y/-/merge_requests/3?w=1")
    assert.equal(result.platform, "gitlab")
    assert.equal(result.owner, "x")
    assert.equal(result.repo, "y")
    assert.equal(result.number, 3)
  })

  it("should parse a GitLab MR URL with owner containing dots and dashes", () => {
    const result = parsePrUrl("https://gitlab.com/my-group.test/toolkit/-/merge_requests/15")
    assert.equal(result.platform, "gitlab")
    assert.equal(result.owner, "my-group.test")
    assert.equal(result.repo, "toolkit")
    assert.equal(result.number, 15)
  })

  // ── Error cases ─────────────────────────────────────────────

  it("should throw for a non-PR GitHub URL (issues page)", () => {
    assert.throws(
      () => parsePrUrl("https://github.com/owner/repo/issues/42"),
      /unrecognised/i,
    )
  })

  it("should throw for a completely invalid URL", () => {
    assert.throws(
      () => parsePrUrl("not-a-url"),
      /unrecognised/i,
    )
  })

  it("should throw for an empty string", () => {
    assert.throws(
      () => parsePrUrl(""),
      /unrecognised/i,
    )
  })

  it("should throw for an HTTPS URL on an unrecognised host", () => {
    assert.throws(
      () => parsePrUrl("https://bitbucket.org/owner/repo/pull-requests/1"),
      /unrecognised/i,
    )
  })

  it("should throw for a GitHub URL with missing number", () => {
    assert.throws(
      () => parsePrUrl("https://github.com/owner/repo/pull/"),
      /unrecognised/i,
    )
  })

  it("should throw for a GitLab URL with missing number", () => {
    assert.throws(
      () => parsePrUrl("https://gitlab.com/owner/repo/-/merge_requests/"),
      /unrecognised/i,
    )
  })
})

// ── detectHost ─────────────────────────────────────────────────

void describe("detectHost", () => {
  it("should return 'github' for github.com URLs", () => {
    assert.equal(detectHost("https://github.com/owner/repo"), "github")
  })

  it("should return 'gitlab' for gitlab.com URLs", () => {
    assert.equal(detectHost("https://gitlab.com/owner/repo"), "gitlab")
  })

  it("should return null for an unrecognised host", () => {
    assert.equal(detectHost("https://bitbucket.org/owner/repo"), null)
  })

  it("should return null for an invalid URL", () => {
    assert.equal(detectHost("not-a-valid-url-at-all"), null)
  })

  it("should return null for empty string", () => {
    assert.equal(detectHost(""), null)
  })

  it("should match hostname case-insensitively", () => {
    assert.equal(detectHost("https://GITHUB.COM/owner/repo"), "github")
    assert.equal(detectHost("https://GitLab.com/owner/repo"), "gitlab")
  })

  it("should work with HTTP URLs", () => {
    assert.equal(detectHost("http://github.com/owner/repo"), "github")
    assert.equal(detectHost("http://gitlab.com/owner/repo"), "gitlab")
  })
})

// ── buildPrApiCommands ─────────────────────────────────────────

void describe("buildPrApiCommands", () => {
  it("should build gh commands for a GitHub target", () => {
    const target: ResolvedPrTarget = {
      platform: "github",
      owner: "my-org",
      repo: "my-repo",
      number: 42,
      url: "https://github.com/my-org/my-repo/pull/42",
    }

    const cmds = buildPrApiCommands(target)

    assert.equal(
      cmds.metadata,
      "gh api /repos/my-org/my-repo/pulls/42",
    )
    assert.equal(
      cmds.files,
      "gh api /repos/my-org/my-repo/pulls/42/files",
    )
  })

  it("should build glab commands for a GitLab target", () => {
    const target: ResolvedPrTarget = {
      platform: "gitlab",
      owner: "my-group",
      repo: "my-project",
      number: 7,
      url: "https://gitlab.com/my-group/my-project/-/merge_requests/7",
    }

    const cmds = buildPrApiCommands(target)

    assert.equal(
      cmds.metadata,
      "glab api projects/my-group%2Fmy-project/merge_requests/7",
    )
    assert.equal(
      cmds.files,
      "glab api projects/my-group%2Fmy-project/merge_requests/7/changes",
    )
  })

  it("should handle repos with dots in name for GitLab", () => {
    const target: ResolvedPrTarget = {
      platform: "gitlab",
      owner: "group",
      repo: "tool.kit",
      number: 3,
      url: "https://gitlab.com/group/tool.kit/-/merge_requests/3",
    }

    const cmds = buildPrApiCommands(target)
    assert.ok(cmds.metadata.includes("group%2Ftool.kit"))
    assert.ok(cmds.files.includes("group%2Ftool.kit"))
  })
})

// ── validatePrUrl ──────────────────────────────────────────────

void describe("validatePrUrl", () => {
  it("should return { valid: true } for a valid GitHub PR URL", () => {
    const result = validatePrUrl("https://github.com/a/b/pull/1")
    assert.equal(result.valid, true)
    assert.equal(result.error, undefined)
  })

  it("should return { valid: true } for a valid GitLab MR URL", () => {
    const result = validatePrUrl("https://gitlab.com/a/b/-/merge_requests/1")
    assert.equal(result.valid, true)
    assert.equal(result.error, undefined)
  })

  it("should return { valid: false, error } for an invalid URL", () => {
    const result = validatePrUrl("not-a-url")
    assert.equal(result.valid, false)
    assert.ok(typeof result.error === "string")
    assert.ok(result.error.length > 0)
  })

  it("should return { valid: false, error } for a non-PR URL", () => {
    const result = validatePrUrl("https://github.com/a/b/issues/1")
    assert.equal(result.valid, false)
    assert.ok(result.error?.toLowerCase().includes("unrecognised".toLowerCase()) ?? false)
  })

  it("should return { valid: false, error } for an empty string", () => {
    const result = validatePrUrl("")
    assert.equal(result.valid, false)
    assert.ok(typeof result.error === "string")
  })
})
