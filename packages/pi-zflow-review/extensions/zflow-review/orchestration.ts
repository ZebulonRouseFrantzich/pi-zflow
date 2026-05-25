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

import { execSync, execFileSync } from "node:child_process"

import { getZflowRegistry } from "pi-zflow-core/registry"
import { DISPATCH_SERVICE_CAPABILITY, type DispatchService } from "pi-zflow-core/dispatch-service"

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

import { chunkDiff, mergeChunkFindings, type ChunkingOptions } from "./chunking.js"

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
    /** Optional PR/MR file path for external review findings. */
    file?: string
    /** Optional actual new-file line number. */
    line?: number
    /** Optional rendered line/range string. */
    lines?: string
    /** Optional diff-line coordinate used for chunk line-map translation. */
    diffLine?: number
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

/**
 * Parse a raw reviewer output string into a ReviewerOutput with findings.
 *
 * Tries JSON-parsing first for agents that emit structured output.
 * Falls back to extracting markdown finding sections from freeform text.
 */
function parseReviewerOutput(rawOutput: string): ReviewerOutput {
  if (!rawOutput || rawOutput.trim().length === 0) {
    return { findings: [], rawOutput: rawOutput ?? "" }
  }

  // Try JSON first — look for a JSON block or parse the entire output
  const trimmed = rawOutput.trim()
  let jsonBlock = trimmed
  const jsonMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)```/)
  if (jsonMatch) {
    jsonBlock = jsonMatch[1].trim()
  }
  try {
    const parsed = JSON.parse(jsonBlock)
    if (Array.isArray(parsed.findings)) {
      return {
        findings: parsed.findings.map((f: Record<string, unknown>) => ({
          severity: (["critical", "major", "minor", "nit"] as const).includes(f.severity as string)
            ? (f.severity as "critical" | "major" | "minor" | "nit")
            : "minor",
          title: String(f.title ?? "Untitled"),
          description: String(f.description ?? f.evidence ?? ""),
          evidence: f.evidence ? String(f.evidence) : undefined,
          file: f.file ? String(f.file) : undefined,
          line: typeof f.line === "number" ? f.line : undefined,
        })),
        rawOutput,
      }
    }
  } catch {
    // Not valid JSON — fall through to markdown extraction
  }

  // Fallback: extract markdown finding sections.
  // Look for `## Finding:` or `### ` or `**Severity:**` patterns.
  const findings: ReviewerOutput["findings"] = []
  const findingBlocks = trimmed.split(/(?=^#{1,3}\s+(?:(?:Finding|Review|Issue)\b|(?:critical|major|minor|nit)\s*:))/m)
  for (const block of findingBlocks) {
    if (!block.trim()) continue
    const severityMatch = block.match(/(?:Severity|sev)[:\s]+(\w+)/i)
    let severity: "critical" | "major" | "minor" | "nit" = "minor"
    if (severityMatch) {
      const s = severityMatch[1].toLowerCase()
      if (s === "critical" || s === "major" || s === "nit") {
        severity = s
      }
    }
    // Also extract severity from heading like "### critical: ..."
    const headingSeverityMatch = block.match(/^#{1,3}\s+(critical|major|minor|nit)\s*:/im)
    if (headingSeverityMatch) {
      severity = headingSeverityMatch[1].toLowerCase() as typeof severity
    }
    const titleMatch = block.match(/^#{1,3}\s+(?:Finding|Review|Issue)[:\s]+(.+)$/m)
    const severityTitleMatch = block.match(/^#{1,3}\s+(?:critical|major|minor|nit)\s*:\s*(.+)$/im)
    const title = titleMatch
      ? titleMatch[1].trim()
      : severityTitleMatch
        ? severityTitleMatch[1].trim()
        : (block.split("\n")[0] ?? "").replace(/^#+\s*/, "").trim()
    if (!title) continue
    const evidenceLines: string[] = []
    let inEvidence = false
    for (const line of block.split("\n")) {
      if (/evidence|reason|why/i.test(line)) {
        inEvidence = true
        continue
      }
      if (inEvidence && (/^#{1,3}\s|^$/.test(line))) {
        inEvidence = false
        continue
      }
      if (inEvidence) evidenceLines.push(line.trim())
    }
    const evidence = evidenceLines.filter(Boolean).join(" ").slice(0, 500) || undefined
    // Extract structured fields from the new detailed findings format
    const fileMatch = block.match(/\*\*File\*\*:\s*(.+)/im)
    const linesMatch = block.match(/\*\*Lines\*\*:\s*(.+)/im)
    const file = fileMatch ? fileMatch[1].trim() : undefined
    const lineStr = linesMatch ? linesMatch[1].trim() : undefined
    const line = lineStr ? parseInt(lineStr.replace(/[^0-9].*$/, ""), 10) || undefined : undefined
    findings.push({ severity, title, description: evidence ?? title, evidence, file, line })
  }

  // Last resort: each non-empty line could be a finding if other extraction failed
  if (findings.length === 0) {
    const lines = trimmed.split("\n").filter(l => l.trim().length > 5).slice(0, 10)
    for (const line of lines) {
      findings.push({
        severity: "minor",
        title: line.trim().slice(0, 120),
        description: line.trim().slice(0, 300),
      })
    }
  }

  return { findings, rawOutput }
}

/**
 * Try to parse a structured synthesizer output from raw agent text.
 *
 * Expected JSON shape:
 * ```json
 * {
 *   "severity": { "critical": 0, "major": 1, "minor": 0, "nit": 0 },
 *   "recommendation": "CONDITIONAL-GO"
 * }
 * ```
 *
 * Looks for a JSON block first (```json ... ```), then tries full-text parse.
 * Returns null when unparseable.
 */
function parseSynthesizerOutput(raw: string): {
  severity: { critical: number; major: number; minor: number; nit: number }
  recommendation: "GO" | "NO-GO" | "CONDITIONAL-GO"
} | null {
  if (!raw || raw.trim().length === 0) return null

  const trimmed = raw.trim()
  let jsonBlock = trimmed
  const jsonMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)```/)
  if (jsonMatch) {
    jsonBlock = jsonMatch[1].trim()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonBlock)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== "object") return null
  const obj = parsed as Record<string, unknown>
  if (!obj.severity || typeof obj.severity !== "object") return null
  if (typeof obj.recommendation !== "string") return null

  const rec = obj.recommendation as string
  if (rec !== "GO" && rec !== "NO-GO" && rec !== "CONDITIONAL-GO") return null

  const sev = obj.severity as Record<string, unknown>
  const critical = typeof sev.critical === "number" ? sev.critical : 0
  const major = typeof sev.major === "number" ? sev.major : 0
  const minor = typeof sev.minor === "number" ? sev.minor : 0
  const nit = typeof sev.nit === "number" ? sev.nit : 0

  return {
    severity: { critical, major, minor, nit },
    recommendation: rec as "GO" | "NO-GO" | "CONDITIONAL-GO",
  }
}

// ── Interfaces ──────────────────────────────────────────────────

/**
 * Per-reviewer progress update emitted during code review.
 */
export interface ReviewerUpdate {
  /** Short reviewer name (e.g. "correctness", "integration"). */
  reviewerName: string
  /** Full agent name (e.g. "zflow.review-correctness"). */
  agentName: string
  /** Reviewer status. */
  status: "queued" | "running" | "completed" | "failed"
  /** Resolved model identifier, if available. */
  model?: string
  /** Effective thinking level, if available. */
  thinking?: string
  /** Active tool name, if a tool is running. */
  currentTool?: string
  /** Last command or activity line. */
  lastCommand?: string
}

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
  /** Explicit diff bundle content (overrides git diff execution when provided). */
  diffBundle?: string
  /** Optional label for the diff source (e.g. "run-patches", "git-diff"). */
  diffSource?: string
  /** Execution groups with review tags for tier selection. */
  executionGroups?: Array<{ reviewTags?: string | string[] }>
  /** Verification document content for tier triggers. */
  verificationText?: string
  /** Modified files list for tier triggers. */
  modifiedFiles?: string[]
  /** Modified directories list for tier triggers. */
  modifiedDirectories?: string[]
  /** Optional path to limit the reviewed diff to a file or directory. */
  targetPath?: string
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
  /** Optional progress callback for per-reviewer status updates. */
  onReviewUpdate?: (update: ReviewerUpdate) => void
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

/**
 * Parse a known `git diff` command string into a git args array.
 *
 * Handles the limited set of command strings emitted by `resolveDiffBaseline()`:
 *   - `git diff HEAD`
 *   - `git diff <ref>...HEAD`
 *   - `git diff <ref>..HEAD`
 *
 * `targetPath`, if provided, is appended as a positional path argument (no shell quoting).
 *
 * @param commandStr - A git diff command string from `resolveDiffBaseline()`.
 * @param targetPath - Optional file/directory path to restrict the diff.
 * @returns A string array of git arguments suitable for `execFileSync("git", args, ...)`.
 */
function parseDiffCommand(commandStr: string, targetPath?: string): string[] {
  const args: string[] = ["diff"]
  const parts = commandStr.trim().split(/\s+/)

  // Expect at minimum `git diff ...`
  if (parts.length < 3 || parts[0] !== "git" || parts[1] !== "diff") {
    // Unknown format — fall back to a basic diff HEAD
    args.push("HEAD")
    if (targetPath) args.push("--", targetPath)
    return args
  }

  // Strip "git diff" prefix, keep remaining args (e.g. "HEAD" or "main...HEAD")
  for (let i = 2; i < parts.length; i++) {
    args.push(parts[i])
  }

  if (targetPath) {
    args.push("--", targetPath)
  }

  return args
}

function toCodeReviewAgentName(reviewerName: string): string {
  return reviewerName.startsWith("zflow.") ? reviewerName : `zflow.review-${reviewerName}`
}

function isRequiredCodeReviewer(reviewerName: string): boolean {
  return reviewerName === "correctness" || reviewerName === "integration" || reviewerName === "security"
}

interface AgentModelInfo {
  model?: string
  thinking?: string
}

async function resolveProfileModelForAgent(agentName: string): Promise<string | undefined> {
  const info = await resolveAgentModelInfo(agentName)
  return info.model
}

async function resolveAgentModelInfo(agentName: string): Promise<AgentModelInfo> {
  try {
    const profileService = getZflowRegistry().optional<{
      getResolvedAgentBinding?: (agentName: string) => Promise<{ resolvedModel?: string | null; lane?: string } | null>
      getResolvedLane?: (laneName: string) => Promise<{ thinking?: string } | null>
    }>("profiles")
    if (!profileService) return {}
    const binding = await profileService.getResolvedAgentBinding?.(agentName)
    if (!binding) return {}
    let thinking: string | undefined
    if (binding.lane && profileService.getResolvedLane) {
      const lane = await profileService.getResolvedLane(binding.lane)
      if (lane) thinking = lane.thinking
    }
    return {
      model: binding.resolvedModel ?? undefined,
      thinking,
    }
  } catch {
    return {}
  }
}

function emitReviewerUpdate(
  callback: CodeReviewInput["onReviewUpdate"] | undefined,
  name: string,
  agentName: string,
  status: ReviewerUpdate["status"],
  extra?: { model?: string; thinking?: string; currentTool?: string; lastCommand?: string },
): void {
  if (!callback) return
  callback({
    reviewerName: name,
    agentName,
    status,
    ...extra,
  })
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
  let diffContent: string
  let baseRef: string
  let diffSource: string

  if (input.diffBundle !== undefined) {
    // Caller provided an explicit diff bundle — use it directly
    // Keep baseRef as a stable sentinel so downstream findings metadata
    // is not confused by arbitrary labels; use diffSource for the coverage note.
    diffContent = input.diffBundle
    baseRef = input.baseline?.baseRef ?? "explicit-bundle"
    diffSource = input.diffSource ?? "explicit-bundle"
  } else {
    const resolved = resolveDiffBaseline(input.baseline ?? {})
    baseRef = resolved.baseRef
    diffSource = resolved.resolution

    try {
      const diffArgs = parseDiffCommand(resolved.diffCommand, input.targetPath)
      diffContent = execFileSync("git", diffArgs, {
        cwd,
        encoding: "utf-8",
        timeout: 15_000,
        maxBuffer: 10 * 1024 * 1024,
      })
    } catch {
      diffContent = "(diff unavailable)"
    }
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
  if (input.targetPath) coverageNotes.push(`Target path: ${input.targetPath}`)

  // Diff coverage note
  if (diffContent.length === 0) {
    coverageNotes.push(`Diff bundle is empty — no changes to review (source: ${diffSource}).`)
  } else {
    const byteCount = Buffer.byteLength(diffContent, "utf8")
    coverageNotes.push(`Diff bundle: ${byteCount} bytes (source: ${diffSource}).`)
  }

  const internalCtx: InternalReviewContext = {
    planningArtifacts: input.planningArtifacts,
    diffBundle: diffContent,
    verificationStatus: input.verificationStatus,
    tier,
  }

  if (input.reviewerRunner) {
    // Run reviewers in parallel via the injected runner
    const runner = input.reviewerRunner
    // Emit queued for all reviewers
    for (const name of reviewerNames) {
      const agentName = toCodeReviewAgentName(name)
      emitReviewerUpdate(input.onReviewUpdate, name, agentName, "queued")
    }
    const results = await Promise.allSettled(
      reviewerNames.map(async (name) => {
        const agentName = toCodeReviewAgentName(name)
        emitReviewerUpdate(input.onReviewUpdate, name, agentName, "running")
        const prompt = await buildInternalReviewPrompt(name, internalCtx)
        const output = await runner(name, prompt)
        return { name, prompt, output }
      }),
    )

    for (const result of results) {
      if (result.status === "fulfilled") {
        const { name, prompt, output } = result.value
        const agentName = toCodeReviewAgentName(name)
        reviewerOutputs[name] = output.rawOutput
        manifest = {
          ...manifest,
          reviewers: manifest.reviewers.map(r =>
            r.name === name ? { ...r, status: "executed" as const } : r,
          ),
        }
        emitReviewerUpdate(input.onReviewUpdate, name, agentName, "completed")
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
    // Use the typed DispatchService from the capability registry.
    const dispatchService = getZflowRegistry().optional<DispatchService>(DISPATCH_SERVICE_CAPABILITY)

    if (dispatchService) {
      // Pre-resolve model/thinking for all reviewers
      const reviewerAgentInfo = new Map<string, AgentModelInfo>()
      for (const name of reviewerNames) {
        const agentName = toCodeReviewAgentName(name)
        const info = await resolveAgentModelInfo(agentName)
        reviewerAgentInfo.set(name, info)
        emitReviewerUpdate(input.onReviewUpdate, name, agentName, "queued", {
          model: info.model,
          thinking: info.thinking,
        })
      }

      const results = await Promise.allSettled(
        reviewerNames.map(async (name) => {
          const agentName = toCodeReviewAgentName(name)
          const agentInfo = reviewerAgentInfo.get(name) ?? {}
          emitReviewerUpdate(input.onReviewUpdate, name, agentName, "running", {
            model: agentInfo.model,
            thinking: agentInfo.thinking,
          })
          const prompt = await buildInternalReviewPrompt(name, internalCtx)
          let output: ReviewerOutput
          let dispatchOk = true
          let dispatchError: string | undefined
          try {
            const raw = await dispatchService.runAgent({
              agent: agentName,
              task: prompt,
              cwd,
              ...(agentInfo.model ? { model: agentInfo.model } : {}),
              onUpdate: (progress) => {
                if (!input.onReviewUpdate) return
                const currentTool = progress.currentTool
                const args = progress.currentToolArgs
                const lastCommand = currentTool ? `${currentTool}${args ? " " + args : ""}` : undefined
                input.onReviewUpdate({
                  reviewerName: name,
                  agentName,
                  status: "running",
                  model: agentInfo.model,
                  thinking: agentInfo.thinking,
                  currentTool: currentTool ?? undefined,
                  lastCommand: lastCommand ?? progress.recentOutput?.[progress.recentOutput.length - 1],
                })
              },
            })
            if (raw.ok) {
              output = parseReviewerOutput(raw.rawOutput)
            } else {
              dispatchOk = false
              dispatchError = raw.error ?? "dispatch returned ok: false"
              output = { findings: [], rawOutput: `dispatch error: ${dispatchError}` }
            }
          } catch (err) {
            dispatchOk = false
            dispatchError = err instanceof Error ? err.message : String(err)
            output = { findings: [], rawOutput: `dispatch error: ${dispatchError}` }
          }
          return { name, agentName, agentInfo, prompt, output, ok: dispatchOk, error: dispatchError }
        }),
      )

      for (const result of results) {
        if (result.status === "fulfilled") {
          const { name, agentName, agentInfo, output, ok, error } = result.value
          if (!ok) {
            reviewerOutputs[name] = output.rawOutput
            manifest = {
              ...manifest,
              reviewers: manifest.reviewers.map(r =>
                r.name === name ? { ...r, status: "failed" as const, detail: error ?? "dispatch failed" } : r,
              ),
            }
            emitReviewerUpdate(input.onReviewUpdate, name, agentName, "failed", {
              model: agentInfo.model,
              thinking: agentInfo.thinking,
              lastCommand: error ?? "dispatch failed",
            })
            coverageNotes.push(`Reviewer "${name}" dispatch failed: ${error ?? "unknown error"}`)
          } else {
            reviewerOutputs[name] = output.rawOutput
            manifest = {
              ...manifest,
              reviewers: manifest.reviewers.map(r =>
                r.name === name ? { ...r, status: "executed" as const } : r,
              ),
            }
            emitReviewerUpdate(input.onReviewUpdate, name, agentName, "completed", {
              model: agentInfo.model,
              thinking: agentInfo.thinking,
            })
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
            coverageNotes.push(`Reviewer "${name}" dispatched via "${dispatchService.name}" as ${toCodeReviewAgentName(name)}`)
          }
        } else {
          coverageNotes.push(`Reviewer dispatch failed: ${result.reason}`)
        }
      }
    } else {
      // No dispatch service found — mark all reviewers skipped
      for (const name of reviewerNames) {
        const prompt = await buildInternalReviewPrompt(name, internalCtx)
        reviewerOutputs[name] = prompt
        manifest = {
          ...manifest,
          reviewers: manifest.reviewers.map(r =>
            r.name === name ? { ...r, status: "skipped" as const, detail: "no dispatch service available" } : r,
          ),
        }
      }
      coverageNotes.push(
        "No reviewer runner or dispatch service available — review prompts were built but no " +
        "reviewers were dispatched. All reviewers marked as skipped. " +
        "Install and configure pi-subagents or provide a custom reviewerRunner.",
      )
    }
  }

  // Step 5: Persist raw outputs
  for (const [name, rawOutput] of Object.entries(reviewerOutputs)) {
    await persistReviewerRawOutput(manifest.runId, name, rawOutput, cwd)
  }

  // Step 6: Synthesise — prefer zflow.synthesizer agent via dispatch service
  //
  // Phase 9: Try to find a dispatch service to invoke the zflow.synthesizer
  // agent for consolidation. If no dispatch service is available, fall back
  // to local severity computation.
  const hasDispatchService = getZflowRegistry().has(DISPATCH_SERVICE_CAPABILITY)
  let synthesizerOutput: string | null = null
  let synthesizerParsed: boolean = false

  if (hasDispatchService && allFindings.length > 0 && reviewerNames.length > 0) {
    try {
      const dispatchService = getZflowRegistry().get<{ name: string; runAgent: Function }>(DISPATCH_SERVICE_CAPABILITY)
      if (dispatchService && typeof dispatchService.runAgent === "function") {
        // Build a synthesizer prompt from the reviewer outputs
        const synthInput = allFindings.map(f =>
          `Reviewer: ${f.reviewerName}\nSeverity: ${f.finding.severity}\nTitle: ${f.finding.title}\nEvidence: ${f.finding.evidence || f.finding.recommendation}`
        ).join("\n---\n")

        const synthesizerModel = await resolveProfileModelForAgent("zflow.synthesizer")
        const synthResult = await dispatchService.runAgent({
          agent: "zflow.synthesizer",
          task: `Synthesize the following code review findings and produce consolidated results with support/dissent/coverage:\n\n${synthInput}`,
          cwd,
          ...(synthesizerModel ? { model: synthesizerModel } : {}),
        })

        synthesizerOutput = synthResult.rawOutput
        coverageNotes.push(`Synthesizer dispatched via "${dispatchService.name}" (zflow.synthesizer)`)
      }
    } catch (err) {
      coverageNotes.push(`Synthesizer dispatch attempted but failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Compute local severity from collected findings (used as fallback or reference)
  const localSeverity = { critical: 0, major: 0, minor: 0, nit: 0 }
  for (const { finding } of allFindings) {
    localSeverity[finding.severity]++
  }

  // Try to parse synthesizer output as authoritative; fall back to local
  let severity = localSeverity
  let recommendation: "GO" | "NO-GO" | "CONDITIONAL-GO" = evaluateRecommendation(localSeverity)
  if (synthesizerOutput) {
    const parsed = parseSynthesizerOutput(synthesizerOutput)
    if (parsed) {
      severity = parsed.severity
      recommendation = parsed.recommendation
      synthesizerParsed = true
      coverageNotes.push(
        `Synthesizer: authoritative result used (severity overridden from synthesizer output)`,
      )
    } else {
      coverageNotes.push(
        `Synthesizer output could not be parsed as structured JSON — ` +
        `falling back to local severity computation.`,
      )
    }
  } else {
    coverageNotes.push("Synthesizer: local severity computation (no zflow.synthesizer dispatch)")
  }

  const failedRequiredReviewers = manifest.reviewers
    .filter((r) => r.status === "failed" && isRequiredCodeReviewer(r.name))
    .map((r) => r.name)
  if (failedRequiredReviewers.length > 0) {
    recommendation = "NO-GO"
    coverageNotes.push(
      `Fail-closed: required reviewer(s) failed: ${failedRequiredReviewers.join(", ")}.`,
    )
  } else if (manifest.reviewers.length > 0 && manifest.reviewers.every((r) => r.status !== "executed")) {
    recommendation = "NO-GO"
    coverageNotes.push("Fail-closed: no code reviewers executed.")
  }

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
        const chunk = chunkResult.chunks.find(c => c.chunkId === chunkId)
        const lineMapByFile: Record<string, Record<number, number>> = {}
        if (chunk) {
          for (const file of chunk.files) {
            lineMapByFile[file.path] = file.lineMap
          }
        }

        const chunkFindings = output.findings.map((finding) => {
          const file = finding.file ?? (chunk?.files.length === 1 ? chunk.files[0]!.path : "")
          let diffLine = finding.diffLine
          if (diffLine === undefined && finding.line !== undefined && file && lineMapByFile[file]) {
            const reverse = Object.entries(lineMapByFile[file]).find(([, actual]) => actual === finding.line)
            if (reverse) diffLine = Number(reverse[0])
          }
          return {
            file,
            diffLine: diffLine ?? 0,
            severity: finding.severity,
            message: finding.description,
          }
        })

        const merged = mergeChunkFindings([{ chunkId, findings: chunkFindings, lineMapByFile }])

        for (let i = 0; i < merged.length; i++) {
          const finding = output.findings[i]!
          const mergedFinding = merged[i]!
          const actualLine = finding.line ?? mergedFinding.actualLine
          allFindings.push({
            severity: finding.severity,
            title: finding.title,
            file: finding.file ?? mergedFinding.file ?? "",
            lines: finding.lines ?? (actualLine !== undefined ? String(actualLine) : undefined),
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
