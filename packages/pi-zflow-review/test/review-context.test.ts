/**
 * review-context.test.ts — Tests for review-context prompt builders.
 *
 * Covers:
 *   - getVerificationStatusReminder for all four status values
 *   - getVerificationStatusReminder throws for unknown status
 *   - getPlanAdherenceInstruction returns non-empty instruction mentioning plan
 *   - buildInternalReviewPrompt includes reviewer name, planning docs, diff,
 *     verification status, and plan-adherence instruction
 *   - buildExternalReviewPrompt includes diff-only instruction, PR metadata,
 *     and diff chunks; does NOT contain planning document paths
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"

import {
  getVerificationStatusReminder,
  getPlanAdherenceInstruction,
  buildInternalReviewPrompt,
  buildExternalReviewPrompt,
} from "../extensions/zflow-review/review-context.js"

import type {
  InternalReviewContext,
  ExternalReviewContext,
  ReviewDiffChunk,
} from "../extensions/zflow-review/review-context.js"

// ── Helpers ───────────────────────────────────────────────────

/**
 * Create a temporary directory and return its path.
 */
async function makeTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "review-context-test-"))
}

/**
 * Write a file with the given content.
 */
async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, "utf-8")
}

// ── getVerificationStatusReminder ──────────────────────────────

void describe("getVerificationStatusReminder", () => {
  it("should return release-gating text when verification passed", () => {
    const text = getVerificationStatusReminder("passed")
    assert.ok(text.includes("release-gating"))
    assert.ok(text.includes("passed"))
    assert.ok(text.includes("block approval"))
  })

  it("should return advisory text when verification failed", () => {
    const text = getVerificationStatusReminder("failed")
    assert.ok(text.includes("advisory"))
    assert.ok(text.includes("failed"))
    assert.ok(!text.includes("release-gating"))
  })

  it("should return advisory text when verification skipped", () => {
    const text = getVerificationStatusReminder("skipped")
    assert.ok(text.includes("advisory"))
    assert.ok(text.includes("skipped"))
    assert.ok(text.includes("rather than release-gating"))
  })

  it("should return advisory text when verification unknown", () => {
    const text = getVerificationStatusReminder("unknown")
    assert.ok(text.includes("advisory"))
    assert.ok(text.includes("unknown"))
    assert.ok(!text.includes("release-gating"))
  })

  it("should throw for unrecognised status value", () => {
    assert.throws(
      () => (getVerificationStatusReminder as (s: string) => string)("invalid"),
      /unknown verification status/i,
    )
  })
})

// ── getPlanAdherenceInstruction ────────────────────────────────

void describe("getPlanAdherenceInstruction", () => {
  it("should return a non-empty string", () => {
    const text = getPlanAdherenceInstruction()
    assert.ok(typeof text === "string")
    assert.ok(text.length > 0)
  })

  it("should mention plan adherence as primary objective", () => {
    const text = getPlanAdherenceInstruction()
    assert.ok(
      /primary.*(objective|task)/i.test(text),
      `Expected "primary objective" or "primary task" in: ${text}`,
    )
    assert.ok(text.includes("plan"), "Expected instruction to mention 'plan'")
  })

  it("should mention that novel defect detection is secondary", () => {
    const text = getPlanAdherenceInstruction()
    assert.ok(
      /secondary/i.test(text),
      `Expected "secondary" in: ${text}`,
    )
  })
})

// ── buildInternalReviewPrompt ───────────────────────────────────

void describe("buildInternalReviewPrompt", () => {
  let tmpDir: string
  let designPath: string
  let execGroupsPath: string
  let standardsPath: string
  let verificationPath: string
  let diffPath: string

  before(async () => {
    tmpDir = await makeTempDir()
    designPath = path.join(tmpDir, "design.md")
    execGroupsPath = path.join(tmpDir, "execution-groups.md")
    standardsPath = path.join(tmpDir, "standards.md")
    verificationPath = path.join(tmpDir, "verification.md")
    diffPath = path.join(tmpDir, "diff.patch")

    await writeFile(designPath, "# Design\n\nThis is the design doc.\n")
    await writeFile(execGroupsPath, "# Execution groups\n\nGroup A\n")
    await writeFile(standardsPath, "# Standards\n\nCode standards.\n")
    await writeFile(verificationPath, "# Verification\n\nRun tests.\n")
    await writeFile(diffPath, "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new\n")
  })

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it("should include the reviewer name in the prompt", async () => {
    const ctx: InternalReviewContext = {
      planningArtifacts: {
        design: designPath,
        executionGroups: execGroupsPath,
        standards: standardsPath,
        verification: verificationPath,
      },
      diffBundle: diffPath,
      verificationStatus: "passed",
      tier: "standard",
    }

    const prompt = await buildInternalReviewPrompt("correctness", ctx)
    assert.ok(prompt.includes("Reviewer: correctness"))
  })

  it("should include the plan-adherence instruction", async () => {
    const ctx: InternalReviewContext = {
      planningArtifacts: {
        design: designPath,
        executionGroups: execGroupsPath,
        standards: standardsPath,
        verification: verificationPath,
      },
      diffBundle: diffPath,
      verificationStatus: "passed",
      tier: "standard",
    }

    const prompt = await buildInternalReviewPrompt("security", ctx)
    assert.ok(prompt.includes("Primary objective"))
    assert.ok(prompt.includes("plan"))
  })

  it("should include verification status reminder", async () => {
    const ctx: InternalReviewContext = {
      planningArtifacts: {
        design: designPath,
        executionGroups: execGroupsPath,
        standards: standardsPath,
        verification: verificationPath,
      },
      diffBundle: diffPath,
      verificationStatus: "passed",
      tier: "standard",
    }

    const prompt = await buildInternalReviewPrompt("integration", ctx)
    assert.ok(prompt.includes("release-gating"))
    assert.ok(prompt.includes("passed"))
  })

  it("should include planning document paths", async () => {
    const ctx: InternalReviewContext = {
      planningArtifacts: {
        design: designPath,
        executionGroups: execGroupsPath,
        standards: standardsPath,
        verification: verificationPath,
      },
      diffBundle: diffPath,
      verificationStatus: "passed",
      tier: "standard",
    }

    const prompt = await buildInternalReviewPrompt("correctness", ctx)
    assert.ok(prompt.includes(designPath))
    assert.ok(prompt.includes(execGroupsPath))
    assert.ok(prompt.includes(standardsPath))
    assert.ok(prompt.includes(verificationPath))
  })

  it("should include planning document content from files", async () => {
    const ctx: InternalReviewContext = {
      planningArtifacts: {
        design: designPath,
        executionGroups: execGroupsPath,
        standards: standardsPath,
        verification: verificationPath,
      },
      diffBundle: diffPath,
      verificationStatus: "passed",
      tier: "standard",
    }

    const prompt = await buildInternalReviewPrompt("correctness", ctx)
    assert.ok(prompt.includes("This is the design doc."))
    assert.ok(prompt.includes("Group A"))
    assert.ok(prompt.includes("Code standards."))
    assert.ok(prompt.includes("Run tests."))
  })

  it("should include diff bundle content", async () => {
    const ctx: InternalReviewContext = {
      planningArtifacts: {
        design: designPath,
        executionGroups: execGroupsPath,
        standards: standardsPath,
        verification: verificationPath,
      },
      diffBundle: diffPath,
      verificationStatus: "passed",
      tier: "standard",
    }

    const prompt = await buildInternalReviewPrompt("correctness", ctx)
    assert.ok(prompt.includes("src/foo.ts"))
    assert.ok(prompt.includes("old"))
    assert.ok(prompt.includes("+new"))
  })

  it("should handle inline diff content (not a file path)", async () => {
    const ctx: InternalReviewContext = {
      planningArtifacts: {
        design: designPath,
        executionGroups: execGroupsPath,
        standards: standardsPath,
        verification: verificationPath,
      },
      diffBundle: "inline-diff-content-here",
      verificationStatus: "skipped",
      tier: "standard",
    }

    const prompt = await buildInternalReviewPrompt("correctness", ctx)
    assert.ok(prompt.includes("inline-diff-content-here"))
  })

  it("should show advisory status in prompt when verification was skipped", async () => {
    const ctx: InternalReviewContext = {
      planningArtifacts: {
        design: designPath,
        executionGroups: execGroupsPath,
        standards: standardsPath,
        verification: verificationPath,
      },
      diffBundle: diffPath,
      verificationStatus: "skipped",
      tier: "standard",
    }

    const prompt = await buildInternalReviewPrompt("correctness", ctx)
    assert.ok(prompt.includes("advisory"))
    assert.ok(prompt.includes("skipped"))
  })

  it("should include plan-adherence as primary when tier is +full", async () => {
    const ctx: InternalReviewContext = {
      planningArtifacts: {
        design: designPath,
        executionGroups: execGroupsPath,
        standards: standardsPath,
        verification: verificationPath,
      },
      diffBundle: diffPath,
      verificationStatus: "failed",
      tier: "+full",
    }

    const prompt = await buildInternalReviewPrompt("logic", ctx)
    assert.ok(prompt.includes("primary"))
    assert.ok(prompt.includes("advisory"))
  })

  it("should handle missing planning document gracefully", async () => {
    const missingPath = path.join(tmpDir, "nonexistent.md")
    const ctx: InternalReviewContext = {
      planningArtifacts: {
        design: missingPath,
        executionGroups: execGroupsPath,
        standards: standardsPath,
        verification: verificationPath,
      },
      diffBundle: diffPath,
      verificationStatus: "passed",
      tier: "standard",
    }

    const prompt = await buildInternalReviewPrompt("correctness", ctx)
    assert.ok(prompt.includes("Could not read"))
    assert.ok(prompt.includes(missingPath))
  })
})

// ── buildExternalReviewPrompt ──────────────────────────────────

void describe("buildExternalReviewPrompt", () => {
  const metadata = {
    platform: "github" as const,
    owner: "test-owner",
    repo: "test-repo",
    number: 42,
    url: "https://github.com/test-owner/test-repo/pull/42",
    title: "Fix the thing",
    description: "This PR fixes an important issue.",
  }

  const diffChunks: ReviewDiffChunk[] = [
    {
      chunkId: "chunk-1",
      files: [
        {
          path: "src/foo.ts",
          patch: "@@ -1,5 +1,6 @@\n old\n+new\n",
        },
      ],
    },
    {
      chunkId: "chunk-2",
      files: [
        {
          path: "src/bar.ts",
          patch: "@@ -10,3 +10,5 @@\n context\n+added\n",
          lineMap: { 1: 11, 2: 12 },
        },
      ],
    },
  ]

  it("should include diff-only instruction", async () => {
    const ctx: ExternalReviewContext = {
      diffChunks,
      prMetadata: metadata,
      diffOnlyInstructions: "## Review mode: Diff-only\n\nDo not execute code.",
    }

    const prompt = await buildExternalReviewPrompt("correctness", ctx)
    assert.ok(prompt.includes("Diff-only"))
    assert.ok(prompt.includes("Do not execute"))
  })

  it("should include PR metadata", async () => {
    const ctx: ExternalReviewContext = {
      diffChunks,
      prMetadata: metadata,
      diffOnlyInstructions: "Diff-only review.",
    }

    const prompt = await buildExternalReviewPrompt("correctness", ctx)
    assert.ok(prompt.includes("test-owner"))
    assert.ok(prompt.includes("test-repo"))
    assert.ok(prompt.includes("#42"))
    assert.ok(prompt.includes("Fix the thing"))
    assert.ok(prompt.includes("important issue"))
    assert.ok(prompt.includes("github.com/test-owner/test-repo/pull/42"))
  })

  it("should NOT contain planning document paths", async () => {
    const ctx: ExternalReviewContext = {
      diffChunks,
      prMetadata: metadata,
      diffOnlyInstructions: "Diff-only review.",
    }

    const prompt = await buildExternalReviewPrompt("correctness", ctx)
    assert.ok(!prompt.includes("design.md"))
    assert.ok(!prompt.includes("execution-groups.md"))
    assert.ok(!prompt.includes("standards.md"))
    assert.ok(!prompt.includes("verification.md"))
    assert.ok(!prompt.includes("planning"))
  })

  it("should include diff chunk file paths and patches", async () => {
    const ctx: ExternalReviewContext = {
      diffChunks,
      prMetadata: metadata,
      diffOnlyInstructions: "Diff-only review.",
    }

    const prompt = await buildExternalReviewPrompt("correctness", ctx)
    assert.ok(prompt.includes("src/foo.ts"))
    assert.ok(prompt.includes("src/bar.ts"))
    assert.ok(prompt.includes("chunk-1"))
    assert.ok(prompt.includes("chunk-2"))
    assert.ok(prompt.includes("+new"))
    assert.ok(prompt.includes("+added"))
  })

  it("should include reviewer name in the prompt", async () => {
    const ctx: ExternalReviewContext = {
      diffChunks,
      prMetadata: metadata,
      diffOnlyInstructions: "Diff-only review.",
    }

    const prompt = await buildExternalReviewPrompt("security", ctx)
    assert.ok(prompt.includes("Reviewer: security"))
  })

  it("should use default diff-only instruction when not provided", async () => {
    const ctx: ExternalReviewContext = {
      diffChunks,
      prMetadata: metadata,
      diffOnlyInstructions: "",
    }

    const prompt = await buildExternalReviewPrompt("correctness", ctx)
    assert.ok(prompt.includes("Diff-only"))
    assert.ok(prompt.includes("untrusted"))
  })

  it("should work with GitLab metadata", async () => {
    const glMetadata = {
      ...metadata,
      platform: "gitlab" as const,
      url: "https://gitlab.com/test-owner/test-repo/-/merge_requests/42",
    }

    const ctx: ExternalReviewContext = {
      diffChunks,
      prMetadata: glMetadata,
      diffOnlyInstructions: "Diff-only review.",
    }

    const prompt = await buildExternalReviewPrompt("integration", ctx)
    assert.ok(prompt.includes("gitlab"))
    assert.ok(prompt.includes("gitlab.com/test-owner/test-repo/-/merge_requests/42"))
  })

  it("should not include planning document content for external review", async () => {
    const ctx: ExternalReviewContext = {
      diffChunks,
      prMetadata: metadata,
      diffOnlyInstructions: "Diff-only review.",
    }

    const prompt = await buildExternalReviewPrompt("correctness", ctx)
    // External review prompts should not mention plan adherence
    assert.ok(!prompt.includes("Primary objective"))
    assert.ok(!prompt.includes("plan adherence"))
    assert.ok(!prompt.includes("novel defect"))
  })
})
