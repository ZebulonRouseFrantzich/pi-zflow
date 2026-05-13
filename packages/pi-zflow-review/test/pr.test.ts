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
  buildFetchCommands,
  parsePrMetadataResponse,
  parsePrFilesResponse,
  combineDiffContent,
  fetchPrDiff,
  checkAuthStatus,
  checkSubmissionCapability,
  buildSubmitCommentCommand,
  formatAuthSkipMessage,
} from "../extensions/zflow-review/pr.js"

import type {
  ResolvedPrTarget,
  PrMetadata,
  PrFile,
  PrFetchResult,
  CommandRunner,
} from "../extensions/zflow-review/pr.js"

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

// ── buildFetchCommands ────────────────────────────────────────

void describe("buildFetchCommands", () => {
  it("should return gh commands for a GitHub target", () => {
    const target: ResolvedPrTarget = {
      platform: "github",
      owner: "my-org",
      repo: "my-repo",
      number: 42,
      url: "https://github.com/my-org/my-repo/pull/42",
    }

    const cmds = buildFetchCommands(target)

    assert.equal(
      cmds.metadata,
      "gh api /repos/my-org/my-repo/pulls/42",
    )
    assert.equal(
      cmds.files,
      "gh api /repos/my-org/my-repo/pulls/42/files",
    )
  })

  it("should return glab commands for a GitLab target", () => {
    const target: ResolvedPrTarget = {
      platform: "gitlab",
      owner: "my-group",
      repo: "my-project",
      number: 7,
      url: "https://gitlab.com/my-group/my-project/-/merge_requests/7",
    }

    const cmds = buildFetchCommands(target)

    assert.equal(
      cmds.metadata,
      "glab api projects/my-group%2Fmy-project/merge_requests/7",
    )
    assert.equal(
      cmds.files,
      "glab api projects/my-group%2Fmy-project/merge_requests/7/changes",
    )
  })
})

// ── parsePrMetadataResponse ────────────────────────────────────

void describe("parsePrMetadataResponse", () => {
  it("should normalize GitHub PR metadata correctly", () => {
    const data = {
      number: 42,
      title: "Fix bug in parser",
      body: "This PR fixes a parsing bug",
      state: "open",
      head: { sha: "abc123", repo: { owner: { login: "my-org" }, name: "my-repo" } },
      base: { sha: "def456" },
      html_url: "https://github.com/my-org/my-repo/pull/42",
    }

    const meta = parsePrMetadataResponse("github", data)

    assert.equal(meta.number, 42)
    assert.equal(meta.title, "Fix bug in parser")
    assert.equal(meta.description, "This PR fixes a parsing bug")
    assert.equal(meta.state, "open")
    assert.equal(meta.headSha, "abc123")
    assert.equal(meta.baseSha, "def456")
    assert.equal(meta.url, "https://github.com/my-org/my-repo/pull/42")
    assert.equal(meta.platform, "github")
  })

  it("should normalize GitLab MR metadata correctly", () => {
    const data = {
      iid: 7,
      title: "Add new feature",
      description: "Implements the new feature",
      state: "merged",
      sha: "ghi789",
      diff_refs: { base_sha: "jkl012" },
      web_url: "https://gitlab.com/group/project/-/merge_requests/7",
    }

    const meta = parsePrMetadataResponse("gitlab", data)

    assert.equal(meta.number, 7)
    assert.equal(meta.title, "Add new feature")
    assert.equal(meta.description, "Implements the new feature")
    assert.equal(meta.state, "merged")
    assert.equal(meta.headSha, "ghi789")
    assert.equal(meta.baseSha, "jkl012")
    assert.equal(meta.url, "https://gitlab.com/group/project/-/merge_requests/7")
    assert.equal(meta.platform, "gitlab")
  })

  it("should handle missing fields gracefully", () => {
    const data = { number: 1 }

    const meta = parsePrMetadataResponse("github", data)

    assert.equal(meta.title, "")
    assert.equal(meta.description, "")
    assert.equal(meta.state, "")
    assert.equal(meta.headSha, "")
    assert.equal(meta.baseSha, "")
  })
})

// ── parsePrFilesResponse ───────────────────────────────────────

void describe("parsePrFilesResponse", () => {
  it("should normalize GitHub files response correctly", () => {
    const data = [
      {
        filename: "src/main.ts",
        status: "modified",
        additions: 10,
        deletions: 2,
        patch: "@@ -1,5 +1,13 @@\n+new line",
      },
      {
        filename: "src/new.ts",
        status: "added",
        additions: 20,
        deletions: 0,
        patch: "@@ -0,0 +1,20 @@\n+new file",
      },
    ]

    const files = parsePrFilesResponse("github", data)

    assert.equal(files.length, 2)
    assert.equal(files[0].path, "src/main.ts")
    assert.equal(files[0].status, "modified")
    assert.equal(files[0].additions, 10)
    assert.equal(files[0].deletions, 2)
    assert.ok(files[0].patch)
    assert.equal(files[1].path, "src/new.ts")
    assert.equal(files[1].status, "added")
    assert.equal(files[1].additions, 20)
  })

  it("should normalize GitLab changes response correctly", () => {
    const data = [
      {
        new_path: "src/feature.ts",
        new_file: true,
        diff: "@@ -0,0 +1,5 @@\n+feature code",
      },
      {
        new_path: "src/old.ts",
        deleted_file: true,
        diff: "@@ -1,10 +0,0 @@\n-removed code",
      },
    ]

    const files = parsePrFilesResponse("gitlab", data)

    assert.equal(files.length, 2)
    assert.equal(files[0].path, "src/feature.ts")
    assert.equal(files[0].status, "added")
    assert.ok(files[0].patch)
    assert.equal(files[1].path, "src/old.ts")
    assert.equal(files[1].status, "removed")
  })

  it("should handle empty file list", () => {
    const files = parsePrFilesResponse("github", [])
    assert.equal(files.length, 0)
  })
})

// ── combineDiffContent ─────────────────────────────────────────

void describe("combineDiffContent", () => {
  it("should combine patches from multiple files into a single diff string", () => {
    const files: PrFile[] = [
      {
        path: "src/a.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1,3 +1,3 @@\n-old\n+new",
      },
      {
        path: "src/b.ts",
        status: "modified",
        additions: 2,
        deletions: 0,
        patch: "@@ -1,0 +1,2 @@\n+new lines",
      },
    ]

    const combined = combineDiffContent(files)

    assert.ok(combined.includes("diff --git a/src/a.ts b/src/a.ts"))
    assert.ok(combined.includes("diff --git a/src/b.ts b/src/b.ts"))
    assert.ok(combined.includes("@@ -1,3 +1,3 @@"))
    assert.ok(combined.includes("@@ -1,0 +1,2 @@"))
  })

  it("should return empty string when no files have patches", () => {
    const files: PrFile[] = [
      { path: "src/a.ts", status: "modified", additions: 1, deletions: 0 },
      { path: "src/b.ts", status: "added", additions: 5, deletions: 0 },
    ]

    const combined = combineDiffContent(files)
    assert.equal(combined, "")
  })

  it("should return empty string for empty file array", () => {
    assert.equal(combineDiffContent([]), "")
  })
})

// ── fetchPrDiff ───────────────────────────────────────────────

void describe("fetchPrDiff", () => {
  it("should return PrFetchResult from mock runner for GitHub", async () => {
    const target: ResolvedPrTarget = {
      platform: "github",
      owner: "my-org",
      repo: "my-repo",
      number: 42,
      url: "https://github.com/my-org/my-repo/pull/42",
    }

    const mockRunner = async (cmd: string): Promise<string> => {
      if (cmd.includes("pulls/42/files")) {
        return JSON.stringify([
          {
            filename: "src/main.ts",
            status: "modified",
            additions: 5,
            deletions: 1,
            patch: "@@ -1,3 +1,7 @@\n+added\n",
          },
        ])
      }
      return JSON.stringify({
        number: 42,
        title: "Test PR",
        body: "Description",
        state: "open",
        head: { sha: "abc123", repo: { owner: { login: "my-org" }, name: "my-repo" } },
        base: { sha: "def456" },
        html_url: "https://github.com/my-org/my-repo/pull/42",
      })
    }

    const result = await fetchPrDiff(target, mockRunner)

    assert.equal(result.metadata.number, 42)
    assert.equal(result.metadata.title, "Test PR")
    assert.equal(result.metadata.headSha, "abc123")
    assert.equal(result.metadata.baseSha, "def456")
    assert.equal(result.files.length, 1)
    assert.equal(result.files[0].path, "src/main.ts")
    assert.ok(result.diffContent.includes("diff --git a/src/main.ts b/src/main.ts"))
  })

  it("should return PrFetchResult from mock runner for GitLab", async () => {
    const target: ResolvedPrTarget = {
      platform: "gitlab",
      owner: "my-group",
      repo: "my-project",
      number: 7,
      url: "https://gitlab.com/my-group/my-project/-/merge_requests/7",
    }

    const mockRunner = async (cmd: string): Promise<string> => {
      if (cmd.includes("/changes")) {
        // Return empty for pagination pages beyond the first
        if (cmd.includes("&page=")) {
          return JSON.stringify({ changes: [] })
        }
        return JSON.stringify({
          changes: [
            {
              new_path: "src/feature.ts",
              new_file: true,
              diff: "@@ -0,0 +1,5 @@\n+new feature",
            },
          ],
        })
      }
      return JSON.stringify({
        iid: 7,
        title: "MR Title",
        description: "MR description",
        state: "merged",
        sha: "ghi789",
        diff_refs: { base_sha: "jkl012" },
        web_url: "https://gitlab.com/group/my-project/-/merge_requests/7",
      })
    }

    const result = await fetchPrDiff(target, mockRunner)

    assert.equal(result.metadata.number, 7)
    assert.equal(result.metadata.title, "MR Title")
    assert.equal(result.metadata.owner, "my-group")
    assert.equal(result.metadata.repo, "my-project")
    assert.equal(result.files.length, 1)
    assert.equal(result.files[0].path, "src/feature.ts")
    assert.equal(result.files[0].status, "added")
  })

  it("should propagate CLI errors from the runner", async () => {
    const target: ResolvedPrTarget = {
      platform: "github",
      owner: "o",
      repo: "r",
      number: 1,
      url: "https://github.com/o/r/pull/1",
    }

    const failingRunner = async (_cmd: string): Promise<string> => {
      throw new Error("gh: command not found")
    }

    await assert.rejects(
      () => fetchPrDiff(target, failingRunner),
      /gh: command not found/,
    )
  })
})

// ── checkAuthStatus ────────────────────────────────────────────

void describe("checkAuthStatus", () => {
  it("should return authenticated for GitHub when auth status succeeds", async () => {
    const mockRunner: CommandRunner = async () => {
      return "Logged in to github.com as octocat\n"
    }

    const status = await checkAuthStatus("github", mockRunner)
    assert.equal(status.authenticated, true)
    assert.equal(status.platform, "github")
    assert.equal(status.username, "octocat")
    assert.equal(status.error, undefined)
  })

  it("should return unauthenticated for GitHub when auth status fails", async () => {
    const mockRunner: CommandRunner = async () => {
      throw new Error("gh: not logged in")
    }

    const status = await checkAuthStatus("github", mockRunner)
    assert.equal(status.authenticated, false)
    assert.equal(status.platform, "github")
    assert.ok(typeof status.error === "string")
    assert.ok(status.error!.includes("not logged in"))
  })

  it("should return authenticated for GitLab when auth status succeeds", async () => {
    const mockRunner: CommandRunner = async () => {
      return "Logged in to gitlab.com as gituser\n"
    }

    const status = await checkAuthStatus("gitlab", mockRunner)
    assert.equal(status.authenticated, true)
    assert.equal(status.platform, "gitlab")
    assert.equal(status.username, "gituser")
  })

  it("should return unauthenticated for GitLab when auth status fails", async () => {
    const mockRunner: CommandRunner = async () => {
      throw new Error("glab: not authenticated")
    }

    const status = await checkAuthStatus("gitlab", mockRunner)
    assert.equal(status.authenticated, false)
    assert.equal(status.platform, "gitlab")
    assert.ok(typeof status.error === "string")
  })

  it("should handle CLI not installed (non-gh/glab error)", async () => {
    const mockRunner: CommandRunner = async () => {
      throw new Error("command not found: gh")
    }

    const status = await checkAuthStatus("github", mockRunner)
    assert.equal(status.authenticated, false)
    assert.ok(status.error!.includes("command not found"))
  })

  it("should handle username with dot in it", async () => {
    const mockRunner: CommandRunner = async () => {
      return "Logged in to github.com as user.name\n"
    }

    const status = await checkAuthStatus("github", mockRunner)
    assert.equal(status.authenticated, true)
    assert.equal(status.username, "user.name")
  })
})

// ── checkSubmissionCapability ──────────────────────────────────

void describe("checkSubmissionCapability", () => {
  it("should return canSubmit:true when authenticated on GitHub", async () => {
    const mockRunner: CommandRunner = async () => {
      return "Logged in to github.com as octocat\n"
    }

    const capability = await checkSubmissionCapability("github", mockRunner)
    assert.equal(capability.canSubmit, true)
    assert.equal(capability.authStatus.authenticated, true)
    assert.equal(capability.fallbackMessage, undefined)
  })

  it("should return canSubmit:false with fallback message when unauthenticated", async () => {
    const mockRunner: CommandRunner = async () => {
      throw new Error("gh: not logged in")
    }

    const capability = await checkSubmissionCapability("github", mockRunner)
    assert.equal(capability.canSubmit, false)
    assert.equal(capability.authStatus.authenticated, false)
    assert.ok(typeof capability.fallbackMessage === "string")
    assert.ok(capability.fallbackMessage!.includes("Authentication for github"))
    assert.ok(capability.fallbackMessage!.includes("gh auth login"))
  })

  it("should return canSubmit:true when authenticated on GitLab", async () => {
    const mockRunner: CommandRunner = async () => {
      return "Logged in to gitlab.com as gituser\n"
    }

    const capability = await checkSubmissionCapability("gitlab", mockRunner)
    assert.equal(capability.canSubmit, true)
    assert.equal(capability.authStatus.authenticated, true)
  })

  it("should return canSubmit:false with fallback message for GitLab", async () => {
    const mockRunner: CommandRunner = async () => {
      throw new Error("glab: not authenticated")
    }

    const capability = await checkSubmissionCapability("gitlab", mockRunner)
    assert.equal(capability.canSubmit, false)
    assert.ok(capability.fallbackMessage!.includes("Authentication for gitlab"))
    assert.ok(capability.fallbackMessage!.includes("glab auth login"))
  })
})

// ── buildSubmitCommentCommand ──────────────────────────────────

void describe("buildSubmitCommentCommand", () => {
  it("should build gh command for GitHub with body only", () => {
    const target: ResolvedPrTarget = {
      platform: "github",
      owner: "my-org",
      repo: "my-repo",
      number: 42,
      url: "https://github.com/my-org/my-repo/pull/42",
    }

    const cmd = buildSubmitCommentCommand({
      target,
      body: "Please add input validation here.",
    })

    assert.ok(cmd.startsWith("gh api"))
    assert.ok(cmd.includes("/repos/my-org/my-repo/pulls/42/comments"))
    assert.ok(cmd.includes("Please add input validation here."))
    assert.ok(cmd.includes("--method POST"))
  })

  it("should build gh command for GitHub with path and line", async () => {
    const target: ResolvedPrTarget = {
      platform: "github",
      owner: "my-org",
      repo: "my-repo",
      number: 42,
      url: "https://github.com/my-org/my-repo/pull/42",
    }

    const cmd = buildSubmitCommentCommand({
      target,
      body: "Missing null check",
      path: "src/main.ts",
      line: 87,
    })

    assert.ok(cmd.includes('-f path="src/main.ts"'))
    assert.ok(cmd.includes("-F line=87"))
    assert.ok(cmd.includes("Missing null check"))
  })

  it("should build glab command for GitLab", () => {
    const target: ResolvedPrTarget = {
      platform: "gitlab",
      owner: "my-group",
      repo: "my-project",
      number: 7,
      url: "https://gitlab.com/my-group/my-project/-/merge_requests/7",
    }

    const cmd = buildSubmitCommentCommand({
      target,
      body: "Please fix this issue",
      path: "src/feature.ts",
    })

    assert.ok(cmd.startsWith("glab api"))
    assert.ok(cmd.includes("my-group%2Fmy-project"))
    assert.ok(cmd.includes("merge_requests/7/discussions"))
    assert.ok(cmd.includes("Please fix this issue"))
    // GitLab discussions API requires position SHA fields for inline comments
    assert.ok(cmd.includes("position[base_sha]"))
    assert.ok(cmd.includes("position[start_sha]"))
    assert.ok(cmd.includes("position[head_sha]"))
  })

  it("should escape special characters in body", () => {
    const target: ResolvedPrTarget = {
      platform: "github",
      owner: "o",
      repo: "r",
      number: 1,
      url: "https://github.com/o/r/pull/1",
    }

    const cmd = buildSubmitCommentCommand({
      target,
      body: 'Line with "quotes" and $pecial chars',
    })

    assert.ok(cmd.includes("Line with"))
    assert.ok(cmd.includes("quotes"))
  })
})

// ── formatAuthSkipMessage ──────────────────────────────────────

void describe("formatAuthSkipMessage", () => {
  it("should include platform name and findings path for GitHub", () => {
    const msg = formatAuthSkipMessage("github", "/tmp/review/pr-review-abc.md")

    assert.ok(msg.includes("github"))
    assert.ok(msg.includes("/tmp/review/pr-review-abc.md"))
    assert.ok(msg.includes("gh"))
  })

  it("should include platform name and findings path for GitLab", () => {
    const msg = formatAuthSkipMessage("gitlab", "/tmp/review/pr-review-xyz.md")

    assert.ok(msg.includes("gitlab"))
    assert.ok(msg.includes("/tmp/review/pr-review-xyz.md"))
    assert.ok(msg.includes("glab"))
  })

  it("should mention configuring authentication", () => {
    const msg = formatAuthSkipMessage("github", "/tmp/review/findings.md")

    assert.ok(msg.includes("configure"))
  })
})
