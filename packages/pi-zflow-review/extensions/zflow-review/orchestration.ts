/**
 * orchestration.ts — End-to-end review orchestrations.
 *
 * Provides the high-level `runCodeReview` and `runPrReview` functions
 * that wire together diff baselines, tier selection, reviewer dispatch,
 * synthesizer invocation, and findings persistence.
 *
 * These functions are designed to be called from slash-command handlers
 * registered by the extension activation function, or programmatically
 * via the review service.
 *
 * @module pi-zflow-review/orchestration
 */

import { execSync } from "node:child_process"

import {
  resolveDiffBaseline,
  type DiffBaselineInput,
} from "./diff-baseline.js"

import {
  persistPrReviewFindings,
  persistCodeReviewFindings,
  persistReviewerRawOutput,
  addFindingTraceability,
  chooseCodeReviewTier,
  buildManifestFromTier,
  type CodeReviewTierContext,
  type CodeReviewFinding,
  type PrReviewFinding,
  type PrReviewFindingsInput,
} from "./findings.js"

import {
  buildInternalReviewPrompt,
  buildExternalReviewPrompt,
  type InternalReviewContext,
  type ExternalReviewContext,
  type PrMetadata,
} from "./review-context.js"

import {
  evaluateRecommendation,
  type SynthesisResult,
} from "./synthesizer.js"

import { chunkDiff, type ChunkingOptions } from "./chunking.js"

import type {
  ReviewerManifest,
  ReviewerMode,
} from "pi-zflow-review"

// ── Reviewer runner type (shared with plan-review.ts) ──────────

/**
 * A reviewer output with structured findings.
 */
export interface ReviewerOutput {
  findings: Array<{
    severity: "critical" | "major" | "minor" | "nit"
    title: string
    description: string
    evidence?: string
  }>
  rawOutput: string
}

/**
 * Signature for a reviewer runner function.
 *
 * Implementations may call agent chains, LLM calls, or return stubs.
 */
export type ReviewerRunner = (
  reviewerName: string,
  prompt: string,
) => Promise<ReviewerOutput>

// ── Interfaces ──────────────────────────────────────────────────

/**
 * Input to the internal code review flow.
 */
export interface CodeReviewInput {
  /** What is being reviewed (e.g. "Implementation of feat-auth"). */
  source: string
  /** Repository root path. */
  repoPath: string
  /** Current branch name. */
  branch: string
  /** Baseline override options. */
  baseline?: DiffBaselineInput
  /** Execution groups with review tags for tier selection. */
  executionGroups?: Array<{ reviewTags?: string | string[] }>
  /** Verification document content for tier triggers. */
  verificationText?: string
  /** Modified files list for tier triggers. */
  modifiedFiles?: string[]
  /** Modified directories list for tier triggers. */
  modifiedDirectories?: string[]
  /** Cross-module dependencies for tier triggers. */
  crossModuleDependencies?: string[]
  /** Whether public API changes are present. */
  hasPublicApiChanges?: boolean
  /** Whether migration/schema/config changes are present. */
  hasMigrationChanges?: boolean
  /** Whether algorithmic risk is flagged. */
  hasAlgorithmicRisk?: boolean
  /** Paths to the four planning artifacts. */
  planningArtifacts: {
    design: string
    executionGroups: string
    standards: string
    verification: string
  }
  /** Verification status for the reminder. */
  verificationStatus: "passed" | "failed" | "skipped" | "unknown"
  /** Optional reviewer runner to dispatch real reviewer agents. */
  reviewerRunner?: ReviewerRunner
  /** Working directory for runtime-state resolution. */
  cwd?: string
}

/**
 * Result of the code review flow.
 */
export interface CodeReviewResult {
  /** Resolved review tier. */
  tier: string
  /** The final reviewer manifest. */
  manifest: ReviewerManifest
  /** Severity counts. */
  severity: { critical: number; major: number; minor: number; nit: number }
  /** Recommendation. */
  recommendation: "GO" | "NO-GO" | "CONDITIONAL-GO"
  /** Absolute path to the findings file. */
  findingsPath: string
  /** Number of reviewers that executed. */
  reviewersExecuted: number
  /** Coverage notes. */
  coverageNotes: string[]
}

/**
 * Input to the external PR/MR review flow.
 */
export interface PrReviewInput {
  /** Resolved PR/MR target. */
  target: {
    platform: "github" | "gitlab"
    owner: string
    repo: string
    number: number
    url: string
  }
  /** Raw PR/MR metadata from fetch. */
  metadata: {
    title: string
    description: string
    state: string
    headSha: string
    baseSha: string
  }
  /** PR diff files. */
  files: Array<{ path: string; patch?: string }>
  /** Whether inline comment submission is available. */
  submissionAvailable: boolean
  /** Optional reviewer runner to dispatch real reviewer agents. */
  reviewerRunner?: ReviewerRunner
  /** Chunking options (optional). */
  chunkOptions?: Partial<ChunkingOptions>
  /** Working directory. */
  cwd?: string
}

/**
 * Result of the PR/MR review flow.
 */
export interface PrReviewResult {
  /** Absolute path to the findings file. */
  findingsPath: string
  /** Run ID for correlation. */
  runId: string
  /** Number of chunks used (1 = not chunked). */
  chunkCount: number
  /** Number of findings produced. */
  findingsCount: number
  /** Coverage notes. */
  coverageNotes: string[]
}

// ── Internal helpers ───────────────────────────────────────────

/**
 * Get the current git branch name.
 */
function getCurrentBranch(cwd?: string): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf-8",
      timeout: 5_000,
    }).trim()
  } catch {
    return "(unknown)"
  }
}

// ── Code review orchestration ───────────────────────────────────

/**
 * Run internal code review.
 *
 * Steps:
 * 1. Resolve diff baseline and produce diff bundle.
 * 2. Determine code-review tier from context.
 * 3. Build reviewer manifest.
 * 4. For each requested reviewer, build the internal review prompt
 *    (planning docs + diff), invoke the reviewer, collect findings.
 * 5. Persist raw outputs to artifact directory.
 * 6. Synthesise (or fallback).
 * 7. Persist findings to `<runtime-state-dir>/review/code-review-findings.md`.
 * 8. Return result with tier, manifest, severity, recommendation.
 *
 * @param input - Code review input parameters.
 * @returns Code review result with findings file path.
 */
export async function runCodeReview(
  input: CodeReviewInput,
): Promise<CodeReviewResult> {
  const cwd = input.cwd
  const repoPath = input.repoPath || cwd || process.cwd()
  const branch = input.branch || getCurrentBranch(cwd)

  // Step 1: Resolve diff baseline and produce diff bundle
  const resolved = resolveDiffBaseline(input.baseline ?? {})
  const baseRef = resolved.baseRef

  let diffContent: string
  try {
    diffContent = execSync(resolved.diffCommand, {
      cwd,
      encoding: "utf-8",
      timeout: 15_000,
      maxBuffer: 10 * 1024 * 1024,
    })
  } catch {
    diffContent = "(diff unavailable)"
  }

  // Step 2: Determine code-review tier
  const tierContext: CodeReviewTierContext = {
    executionGroups: input.executionGroups,
    verificationText: input.verificationText,
    modifiedFiles: input.modifiedFiles,
    modifiedDirectories: input.modifiedDirectories,
    crossModuleDependencies: input.crossModuleDependencies,
    hasPublicApiChanges: input.hasPublicApiChanges,
    hasMigrationChanges: input.hasMigrationChanges,
    hasAlgorithmicRisk: input.hasAlgorithmicRisk,
  }
  const tier = chooseCodeReviewTier(tierContext)

  // Step 3: Build reviewer manifest
  let manifest = buildManifestFromTier("code-review", tier)
  const reviewerNames = manifest.reviewers.map(r => r.name)

  // Step 4: Dispatch reviewers
  const allFindings: Array<{ reviewerName: string; finding: CodeReviewFinding }> = []
  const reviewerOutputs: Record<string, string> = {}
  const coverageNotes: string[] = [`Tier: ${tier}`, `Base ref: ${baseRef}`]

  const internalCtx: InternalReviewContext = {
    planningArtifacts: input.planningArtifacts,
    diffBundle: diffContent,
    verificationStatus: input.verificationStatus,
    tier,
  }

  if (input.reviewerRunner) {
    // Run reviewers in parallel via the injected runner
    const runner = input.reviewerRunner
    const results = await Promise.allSettled(
      reviewerNames.map(async (name) => {
        const prompt = await buildInternalReviewPrompt(name, internalCtx)
        return { name, prompt, output: await runner(name, prompt) }
      }),
    )

    for (const result of results) {
      if (result.status === "fulfilled") {
        const { name, prompt, output } = result.value
        reviewerOutputs[name] = output.rawOutput
        manifest = {
          ...manifest,
          reviewers: manifest.reviewers.map(r =>
            r.name === name ? { ...r, status: "executed" as const } : r,
          ),
        }
        for (const f of output.findings) {
          allFindings.push({
            reviewerName: name,
            finding: {
              severity: f.severity,
              title: f.title,
              reviewerSupport: [name],
              evidence: f.evidence || "See raw reviewer output.",
              whyItMatters: "Issue identified during code review.",
              recommendation: f.description,
              artifactPath: `runs/${manifest.runId}/review-artifacts/${name}.md`,
              runId: manifest.runId,
            },
          })
        }
        coverageNotes.push(`Reviewer "${name}" executed`)
      } else {
        coverageNotes.push(`Reviewer failed: ${result.reason}`)
      }
    }
  } else {
    // No reviewer runner: record a diagnostic instead of silently succeeding
    for (const name of reviewerNames) {
      const prompt = await buildInternalReviewPrompt(name, internalCtx)
      reviewerOutputs[name] = prompt
      manifest = {
        ...manifest,
        reviewers: manifest.reviewers.map(r =>
          r.name === name ? { ...r, status: "skipped" as const, detail: "no reviewer runner available" } : r,
        ),
      }
    }
    coverageNotes.push(
      "No reviewer runner provided — review prompts were built but no reviewers were dispatched. " +
      "All reviewers marked as skipped. Install and configure pi-subagents or provide a custom reviewerRunner.",
    )
  }

  // Step 5: Persist raw outputs
  for (const [name, rawOutput] of Object.entries(reviewerOutputs)) {
    await persistReviewerRawOutput(manifest.runId, name, rawOutput, cwd)
  }

  // Step 6: Synthesise (compute severity from collected findings)
  const severity = { critical: 0, major: 0, minor: 0, nit: 0 }
  for (const { finding } of allFindings) {
    severity[finding.severity]++
  }
  const recommendation = evaluateRecommendation(severity)

  // Step 7: Persist findings
  const codeReviewFindings: CodeReviewFinding[] = allFindings.map(f => f.finding)
  const findingsWithTraceability = addFindingTraceability(
    codeReviewFindings,
    manifest.runId,
    cwd,
  )

  const findingsPath = await persistCodeReviewFindings({
    source: input.source,
    repoPath,
    branch,
    baseRef,
    runId: manifest.runId,
    manifest,
    reviewers: reviewerNames,
    reviewedFiles: input.modifiedFiles ?? [],
    verificationContext: `Verification status: ${input.verificationStatus}`,
    findings: findingsWithTraceability,
    cwd,
  })

  return {
    tier,
    manifest,
    severity,
    recommendation,
    findingsPath,
    reviewersExecuted: manifest.reviewers.filter(r => r.status === "executed").length,
    coverageNotes,
  }
}

// ── PR/MR review orchestration ──────────────────────────────────

/**
 * Run external PR/MR review.
 *
 * Steps:
 * 1. Chunk diff files if the diff exceeds review limits.
 * 2. Build external review prompts with diff-only instructions.
 * 3. Dispatch reviewer prompts.
 * 4. Merge chunk findings if chunked.
 * 5. Persist PR findings file.
 * 6. Return result with findings path.
 *
 * @param input - PR review input with target, metadata, and files.
 * @returns PR review result.
 */
export async function runPrReview(
  input: PrReviewInput,
): Promise<PrReviewResult> {
  const cwd = input.cwd
  const runId = `pr-${input.target.platform}-${input.target.owner}-${input.target.repo}-${input.target.number}-${Date.now().toString(36)}`

  const coverageNotes: string[] = [
    `PR URL: ${input.target.url}`,
    `Platform: ${input.target.platform}`,
    `Head SHA: ${input.metadata.headSha}`,
    `Base SHA: ${input.metadata.baseSha}`,
    `Diff-only review (no code execution)`,
    `Files changed: ${input.files.length}`,
  ]

  if (input.submissionAvailable) {
    coverageNotes.push(`Submission available: yes`)
  } else {
    coverageNotes.push(`Submission available: no (auth not configured)`)
  }

  // Chunk the diff if needed
  const chunkResult = chunkDiff(input.files, input.chunkOptions)
  const chunkCount = chunkResult.chunkCount

  // Build external review prompts with diff-only instructions
  const prMetadata: PrMetadata = {
    platform: input.target.platform,
    owner: input.target.owner,
    repo: input.target.repo,
    number: input.target.number,
    title: input.metadata.title,
    description: input.metadata.description,
    state: "open",
    headSha: input.metadata.headSha,
    baseSha: input.metadata.baseSha,
    url: input.target.url,
  }

  const diffOnlyInstruction =
    "# Mode: /zflow-review-pr\n\n" +
    "## Behaviour\n\n" +
    "External PR/MR diff review mode.\n\n" +
    "- **Diff-only review.** Do not execute, check out, or run untrusted PR code.\n" +
    "- **Never execute untrusted PR code by default.**\n" +
    "- **Findings must state verification limits.**\n\n" +
    "## Severity scheme\n\n" +
    "- **critical** — blocks approval; must be resolved\n" +
    "- **major** — should be resolved before merging\n" +
    "- **minor** — nice to fix, not blocking\n" +
    "- **nit** — optional suggestion"

  const allFindings: PrReviewFinding[] = []

  if (input.reviewerRunner) {
    const runner = input.reviewerRunner
    const chunkResults = await Promise.allSettled(
      chunkResult.chunks.map(async (chunk) => {
        const promptStr = await buildExternalReviewPrompt("pr-reviewer", {
          diffChunks: [chunk],
          prMetadata,
          diffOnlyInstructions: diffOnlyInstruction,
        })
        return { chunkId: chunk.chunkId, prompt: promptStr, output: await runner("pr-reviewer", promptStr) }
      }),
    )

    for (const result of chunkResults) {
      if (result.status === "fulfilled") {
        const { chunkId, output } = result.value
        for (const finding of output.findings) {
          allFindings.push({
            severity: finding.severity,
            title: finding.title,
            file: "",
            evidence: finding.evidence || finding.description,
            recommendation: finding.description,
            submit: finding.severity === "critical" || finding.severity === "major",
          })
        }
        coverageNotes.push(`Chunk ${chunkId} reviewed: ${output.findings.length} findings`)
      } else {
        coverageNotes.push(`Chunk review failed: ${result.reason}`)
      }
    }
  } else {
    coverageNotes.push(
      "No reviewer runner provided — PR review prompts were built but no reviewers were dispatched. " +
      "No findings were produced.",
    )
  }

  // Persist findings
  const findingsPath = await persistPrReviewFindings({
    prMetadata: {
      url: input.target.url,
      platform: input.target.platform,
      headSha: input.metadata.headSha,
      baseSha: input.metadata.baseSha,
    },
    runId,
    coverageNotes,
    findings: allFindings,
    wasChunked: chunkCount > 1,
    submissionAvailable: input.submissionAvailable,
    cwd,
  })

  return {
    findingsPath,
    runId,
    chunkCount,
    findingsCount: allFindings.length,
    coverageNotes,
  }
}
