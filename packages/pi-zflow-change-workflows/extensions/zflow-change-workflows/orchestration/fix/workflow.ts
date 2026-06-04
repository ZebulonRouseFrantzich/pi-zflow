/**
 * workflow.ts — change-audit and change-fix orchestration helpers.
 */

import {
  resolveChangeDir,
  resolveCodeReviewFindingsPath,
  resolvePlanArtifactPath,
  resolvePlanStatePath,
  resolvePlanVersionDir,
} from "pi-zflow-artifacts/artifact-paths"
import { resolveRuntimeStateDir } from "pi-zflow-core/runtime-paths"
import type {
  AgentDispatchProgress,
  AgentDispatchResult,
  DispatchService,
} from "pi-zflow-core/dispatch-service"

import { migrateLegacyChangeArtifactsIfPresent } from "../implementation/workflow.js"
import {
  assertFindingsMatchChange,
  buildFixPlan,
  parseReviewFindings,
  type ParsedFinding,
  type ReviewFindingsMetadata,
} from "./findings.js"

function buildLimitedCoordinationLines(
  label: string,
  orchestratorTarget?: string,
): string[] {
  const lines = [
    "## Control-plane coordination (use only at the margins)",
    "- Prefer `contact_supervisor` when available. It is the most reliable way to reach your supervising orchestrator.",
    "- Use coordination only for: `DRIFT_DETECTED`, `BLOCKED`, `NEED_CLARIFICATION`, or `VERIFICATION_FAILED`.",
    `- Keep each message terse, with a leading tag and the relevant ID (for example: \`${label}\`).`,
    "- Write or reference the authoritative artifact first when reporting drift or verification failure.",
    "- Do NOT use intercom for routine narration, detailed discussion, or completion chatter.",
  ]

  if (orchestratorTarget) {
    lines.push(
      `- Fallback raw intercom target: \`${orchestratorTarget}\`.`,
      "- If `contact_supervisor` is unavailable but `intercom` is available, use that exact target.",
    )
  } else {
    lines.push(
      "- If `contact_supervisor` is unavailable and no explicit intercom target is provided, stop and return a clear BLOCKED summary in your task result.",
    )
  }

  return lines
}

/**
 * Options for the change-audit workflow.
 */
export interface AuditWorkflowOptions {
  /** Change identifier to audit. */
  changeId: string
  /** Working directory (optional). */
  cwd?: string
  /** Whether to re-run review if findings already exist. */
  rerunReview?: boolean
}

/**
 * Result of the change-audit workflow.
 */
export interface AuditWorkflowResult {
  /** The audited change identifier. */
  changeId: string
  /** Current plan lifecycle state. */
  status: string
  /** Active plan version. */
  planVersion: string
  /** Verification status string. */
  verificationStatus: string
  /** Path to review findings if available. */
  reviewFindingsPath?: string
  /** Human-readable audit summary. */
  summary: string
  /** Recommended next actions. */
  recommendedActions: string[]
}

/**
 * Run the `/zflow-change-audit <change-path>` workflow.
 */
export async function runChangeAuditWorkflow(
  options: AuditWorkflowOptions,
): Promise<AuditWorkflowResult> {
  const cwd = options.cwd
  const changeId = options.changeId
  const { default: fs } = await import("node:fs/promises")

  await migrateLegacyChangeArtifactsIfPresent(changeId, cwd)
  const planStatePath = resolvePlanStatePath(changeId, cwd)
  let planState: Record<string, unknown>
  try {
    const raw = await fs.readFile(planStatePath, "utf-8")
    planState = JSON.parse(raw)
  } catch {
    throw new Error(`No plan found for change "${changeId}". Run /zflow-change-prepare ${changeId} first.`)
  }

  const planVersion = (planState.approvedVersion ?? planState.currentVersion ?? "v1") as string
  const lifecycleState = (planState.lifecycleState ?? "unknown") as string

  let verificationStatus = "unknown"
  try {
    const verificationPath = resolvePlanArtifactPath(changeId, planVersion, "verification", cwd)
    const verContent = await fs.readFile(verificationPath, "utf-8")
    if (verContent.includes("pass") || verContent.includes("PASS")) {
      verificationStatus = "passed"
    } else if (verContent.includes("fail") || verContent.includes("FAIL")) {
      verificationStatus = "failed"
    }
  } catch {
    // no verification artifact
  }

  const reviewFindingsPath = resolveCodeReviewFindingsPath(cwd)
  let hasReviewFindings = false
  try {
    await fs.access(reviewFindingsPath)
    hasReviewFindings = true
  } catch {
    // no findings file
  }

  const recommendedActions: string[] = []
  if (lifecycleState === "completed") {
    recommendedActions.push("Change is complete. Review findings and close out.")
  } else if (lifecycleState === "approved") {
    recommendedActions.push(`Run /zflow-change-implement ${changeId} to execute the approved plan.`)
  } else if (lifecycleState === "executing") {
    recommendedActions.push("Implementation is in progress. Wait for completion or check run status.")
  } else if (lifecycleState === "draft" || lifecycleState === "validated") {
    recommendedActions.push("Plan is not yet approved. Review and approve via the planning workflow.")
  } else if (lifecycleState === "drifted") {
    recommendedActions.push("Plan drift detected. Review deviations and create an amendment.")
  } else if (lifecycleState === "cancelled") {
    recommendedActions.push("Plan was cancelled. Start a new planning session if needed.")
  } else if (lifecycleState === "superseded") {
    recommendedActions.push("Plan was superseded by a newer version. Check for v{n+1}.")
  } else {
    recommendedActions.push("Run /zflow-change-prepare to start planning.")
  }

  if (!hasReviewFindings && lifecycleState !== "draft") {
    recommendedActions.push("Run /zflow-review-code to review the implementation.")
  }

  if (verificationStatus === "failed") {
    recommendedActions.push("Verification failed. Run /zflow-change-fix to resolve issues.")
  }

  const planVersionDir = resolvePlanVersionDir(changeId, planVersion, cwd)
  const summary = [
    `## Audit: ${changeId}`,
    "",
    `**Status:** ${lifecycleState}`,
    `**Plan Version:** ${planVersion}`,
    `**Verification:** ${verificationStatus}`,
    `**Review Findings:** ${hasReviewFindings ? "available" : "none"}`,
    "",
    `Plan artifacts: \`${planVersionDir}\``,
    hasReviewFindings ? `Review findings: \`${reviewFindingsPath}\`` : "",
  ].filter(Boolean).join("\n")

  return {
    changeId,
    status: lifecycleState,
    planVersion,
    verificationStatus,
    reviewFindingsPath: hasReviewFindings ? reviewFindingsPath : undefined,
    summary,
    recommendedActions,
  }
}

/**
 * Configuration for the fix orchestrator retry bounds.
 */
export interface FixOrchestratorConfig {
  /** Max fix attempts per individual finding. Default: 2 */
  maxAttemptsPerFinding: number
  /** Max global rounds of fix dispatch. Default: 3 */
  maxGlobalRounds: number
}

/**
 * Resolve the fix orchestrator configuration from environment variables,
 * profile settings, or defaults.
 */
export function resolveFixOrchestratorConfig(
  profileSettings?: Record<string, unknown>,
): FixOrchestratorConfig {
  const envMaxAttempts = process.env.ZFLOW_FIX_MAX_ATTEMPTS_PER_FINDING
  const envMaxRounds = process.env.ZFLOW_FIX_MAX_GLOBAL_ROUNDS

  const readPositiveInteger = (value: unknown): number | undefined => {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value
    if (typeof value !== "string" || value.trim().length === 0) return undefined
    const parsed = Number.parseInt(value, 10)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  }

  return {
    maxAttemptsPerFinding:
      readPositiveInteger(envMaxAttempts) ??
      readPositiveInteger(profileSettings?.maxAttemptsPerFinding) ??
      2,
    maxGlobalRounds:
      readPositiveInteger(envMaxRounds) ??
      readPositiveInteger(profileSettings?.maxGlobalRounds) ??
      3,
  }
}

/**
 * Options for the change-fix workflow.
 */
export interface FixWorkflowOptions {
  /** Change identifier to fix. */
  changeId: string
  /** Working directory (optional). */
  cwd?: string
  /** Specific finding indices to fix (empty = all). */
  findingIndices?: number[]
  /** Whether to auto-apply fixes without manual review. */
  autoFix?: boolean
  /** Override for fix orchestrator config. */
  fixOrchestratorConfig?: Partial<FixOrchestratorConfig>
}

/**
 * Result of the change-fix workflow.
 */
export interface FixWorkflowResult {
  /** The fixed change identifier. */
  changeId: string
  /** Generated fix plan description. */
  fixPlan: string
  /** Files identified for modification. */
  filesToModify: string[]
  /** Resolved verification command if available. */
  verificationCommand?: string
  /** Parsed findings from review. */
  parsedFindings: ParsedFinding[]
  /** The raw findings content and path. */
  rawFindingsPath?: string
  /** Plan version used. */
  planVersion: string
  /** Plan lifecycle state. */
  lifecycleState: string
  /** Resolved fix orchestrator configuration. */
  fixOrchestratorConfig: FixOrchestratorConfig
  /** Task prompt for the fix orchestrator agent. */
  fixOrchestratorTaskPrompt?: string
  /** Paths to the five canonical plan artifacts for source context. */
  planArtifactPaths?: Record<string, string>
}

export interface DirectFixBatch {
  batchId: string
  fileKey: string
  files: string[]
  findings: ParsedFinding[]
  severity: ParsedFinding["severity"]
  workerAgent: string
}

export interface DirectFixFindingOutcome {
  findingId: string
  title: string
  severity: ParsedFinding["severity"]
  file?: string
  status: "fixed" | "already-satisfied" | "unresolved"
  attempts: number
  reason?: string
  outputPath?: string
}

export interface DirectFixWorkflowResult {
  changeId: string
  planVersion: string
  reportPath: string
  batchCount: number
  fixed: DirectFixFindingOutcome[]
  unresolved: DirectFixFindingOutcome[]
  verificationCommand?: string
}

export interface DirectFixWorkflowOptions {
  changeId: string
  fixResult: FixWorkflowResult
  dispatchService: DispatchService
  cwd?: string
  workerAgent?: string
  workerModel?: string
  workerThinking?: string
  onBatchStart?: (batch: DirectFixBatch) => void | Promise<void>
  onBatchUpdate?: (batch: DirectFixBatch, progress: AgentDispatchProgress) => void | Promise<void>
  onBatchComplete?: (batch: DirectFixBatch, result: AgentDispatchResult & { outputPath?: string }) => void | Promise<void>
}

function severityRank(severity: ParsedFinding["severity"]): number {
  switch (severity) {
    case "critical": return 0
    case "major": return 1
    case "minor": return 2
    case "nit": return 3
    default: return 4
  }
}

function normalizeBatchFileKey(finding: ParsedFinding): string {
  const file = finding.file?.trim()
  if (file) return file
  return `__${finding.findingId}`
}

function toAbsoluteArtifactPath(runtimeStateDir: string, artifactPath: string | undefined): string | undefined {
  if (!artifactPath) return undefined
  if (artifactPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(artifactPath)) return artifactPath
  return `${runtimeStateDir}/${artifactPath}`
}

/**
 * Detect whether a subagent error indicates a no-op/no-edit outcome
 * rather than a genuine dispatch or provider failure.
 *
 * Returns `true` when the error matches known no-edit patterns from
 * the subagent runner harness.
 */
export function isNoEditFailure(error: string | undefined): boolean {
  if (!error) return false
  const noEditPatterns = [
    "subagent completed without making edits",
    "completed without making edits",
    "returned planning or scratchpad output instead of applying changes",
  ]
  const lower = error.toLowerCase()
  return noEditPatterns.some((pattern) => lower.includes(pattern))
}

export interface ZflowFixFindingResult {
  findingId: string
  status: "fixed" | "already_satisfied" | "blocked" | "partial" | "not_satisfied" | "uncertain"
  evidence?: string[]
  changedFiles?: string[]
  validation?: string[]
  reason?: string
}

export interface ZflowFixResultEnvelope {
  zflowFixResult: {
    status: "fixed" | "already_satisfied" | "blocked" | "partial" | "not_satisfied" | "uncertain"
    findings?: ZflowFixFindingResult[]
    evidence?: string[]
    changedFiles?: string[]
    validation?: string[]
    reason?: string
  }
}

function normalizeStructuredStatus(status: string | undefined): ZflowFixFindingResult["status"] | undefined {
  const normalized = status?.trim().toLowerCase().replace(/-/g, "_")
  switch (normalized) {
    case "fixed":
    case "already_satisfied":
    case "blocked":
    case "partial":
    case "not_satisfied":
    case "uncertain":
      return normalized
    default:
      return undefined
  }
}

function hasSubstantiveEvidence(result: ZflowFixFindingResult | ZflowFixResultEnvelope["zflowFixResult"]): boolean {
  return Boolean(
    result.reason?.trim() ||
    result.evidence?.some((entry) => entry.trim()) ||
    result.validation?.some((entry) => entry.trim()),
  )
}

function extractBalancedJsonObject(source: string, marker: string): string | undefined {
  const markerIndex = source.indexOf(marker)
  if (markerIndex < 0) return undefined

  let openIndex = markerIndex
  while (openIndex >= 0 && source[openIndex] !== "{") {
    openIndex--
  }
  if (openIndex < 0) return undefined

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = openIndex; i < source.length; i++) {
    const char = source[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === "{") {
      depth++
    } else if (char === "}") {
      depth--
      if (depth === 0) return source.slice(openIndex, i + 1)
    }
  }
  return undefined
}

export function parseZflowFixResultEnvelope(output: string | undefined): ZflowFixResultEnvelope | undefined {
  if (!output?.trim()) return undefined

  const candidates: string[] = []
  for (const match of output.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)) {
    candidates.push(match[1])
  }
  const balanced = extractBalancedJsonObject(output, '"zflowFixResult"') ??
    extractBalancedJsonObject(output, "zflowFixResult")
  if (balanced) candidates.push(balanced)

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (!parsed || typeof parsed !== "object" || !("zflowFixResult" in parsed)) continue
      const envelope = parsed as ZflowFixResultEnvelope
      const status = normalizeStructuredStatus(envelope.zflowFixResult?.status)
      if (!status) continue
      envelope.zflowFixResult.status = status
      envelope.zflowFixResult.findings = (envelope.zflowFixResult.findings ?? [])
        .filter((finding) => finding && typeof finding.findingId === "string")
        .map((finding) => ({
          ...finding,
          status: normalizeStructuredStatus(finding.status) ?? "uncertain",
          evidence: Array.isArray(finding.evidence) ? finding.evidence.map(String) : undefined,
          changedFiles: Array.isArray(finding.changedFiles) ? finding.changedFiles.map(String) : undefined,
          validation: Array.isArray(finding.validation) ? finding.validation.map(String) : undefined,
          reason: typeof finding.reason === "string" ? finding.reason : undefined,
        }))
      return envelope
    } catch {
      // Try the next candidate.
    }
  }

  return undefined
}

async function readDispatchOutput(result: AgentDispatchResult & { outputPath?: string }): Promise<string> {
  if (result.rawOutput?.trim()) return result.rawOutput
  if (!result.outputPath) return ""
  try {
    const { default: fs } = await import("node:fs/promises")
    return await fs.readFile(result.outputPath, "utf-8")
  } catch {
    return ""
  }
}

function structuredResultForFinding(
  envelope: ZflowFixResultEnvelope,
  finding: ParsedFinding,
): ZflowFixFindingResult | undefined {
  const specific = envelope.zflowFixResult.findings?.find((entry) => entry.findingId === finding.findingId)
  if (specific) return specific
  if ((envelope.zflowFixResult.findings?.length ?? 0) > 0) return undefined
  return {
    findingId: finding.findingId,
    status: envelope.zflowFixResult.status,
    evidence: envelope.zflowFixResult.evidence,
    changedFiles: envelope.zflowFixResult.changedFiles,
    validation: envelope.zflowFixResult.validation,
    reason: envelope.zflowFixResult.reason,
  }
}

function applyStructuredFixResults(
  batch: DirectFixBatch,
  envelope: ZflowFixResultEnvelope,
  fixed: DirectFixFindingOutcome[],
  unresolved: DirectFixFindingOutcome[],
  attempts: number,
  outputPath: string | undefined,
): Set<string> {
  const handled = new Set<string>()
  for (const finding of batch.findings) {
    const result = structuredResultForFinding(envelope, finding)
    if (!result) continue
    handled.add(finding.findingId)

    const evidenceSuffix = result.reason ?? result.evidence?.join("; ")
    if (result.status === "fixed") {
      fixed.push({
        findingId: finding.findingId,
        title: finding.title,
        severity: finding.severity,
        file: finding.file,
        status: "fixed",
        attempts,
        reason: evidenceSuffix,
        outputPath,
      })
      continue
    }

    if (result.status === "already_satisfied" && hasSubstantiveEvidence(result)) {
      fixed.push({
        findingId: finding.findingId,
        title: finding.title,
        severity: finding.severity,
        file: finding.file,
        status: "already-satisfied",
        attempts,
        reason: evidenceSuffix ?? "worker reported finding already satisfied",
        outputPath,
      })
      continue
    }

    unresolved.push({
      findingId: finding.findingId,
      title: finding.title,
      severity: finding.severity,
      file: finding.file,
      status: "unresolved",
      attempts,
      reason: result.reason ?? `worker reported ${result.status}`,
      outputPath,
    })
  }
  return handled
}

function buildFixSatisfactionCheckerPrompt(
  changeId: string,
  fixResult: FixWorkflowResult,
  batch: DirectFixBatch,
  workerOutput: string,
): string {
  const lines: string[] = [
    `# Fix Satisfaction Check for ${changeId}`,
    "",
    "You are a read-only zflow satisfaction checker. Decide whether the current repository state already satisfies the listed review finding(s).",
    "Do not edit files. Inspect only the source files, plan artifacts, review finding text, and worker output.",
    "",
    "## Required JSON result",
    "",
    "Return a single JSON object in a fenced ```json block using this exact top-level key:",
    "",
    "```json",
    JSON.stringify({
      zflowFixResult: {
        status: "already_satisfied | not_satisfied | uncertain",
        findings: [{
          findingId: "finding-id",
          status: "already_satisfied | not_satisfied | uncertain",
          evidence: ["file/path:line or concrete reason"],
          changedFiles: [],
          validation: ["read-only checks performed"],
          reason: "brief explanation",
        }],
      },
    }, null, 2),
    "```",
    "",
    "Only use `already_satisfied` when concrete source evidence proves the fix requirements are met. Otherwise use `not_satisfied` or `uncertain`.",
    "",
    "## Findings",
    "",
  ]

  for (const finding of batch.findings) {
    lines.push(
      `### ${finding.findingId}: ${finding.title}`,
      `- Severity: ${finding.severity}`,
      `- File: ${finding.file ?? "(not specified)"}`,
      `- Evidence: ${finding.evidence}`,
      `- Expected behavior: ${finding.expectedBehavior ?? "(not specified)"}`,
      `- Fix requirements: ${finding.fixRequirements ?? finding.recommendation}`,
      `- Validation: ${finding.validation ?? "(not specified)"}`,
      "",
    )
  }

  lines.push(
    "## Plan artifacts",
    "",
    ...Object.entries(fixResult.planArtifactPaths ?? {}).map(([name, path]) => `- ${name}: ${path}`),
    "",
    "## Worker output / error context",
    "",
    workerOutput.trim() || "(no worker output)",
    "",
  )

  return lines.join("\n")
}

async function runSatisfactionChecker(
  options: DirectFixWorkflowOptions,
  changeId: string,
  fixResult: FixWorkflowResult,
  batch: DirectFixBatch,
  workerOutput: string,
  outputPath: string,
): Promise<ZflowFixResultEnvelope | undefined> {
  const result = await options.dispatchService.runAgent({
    agent: "zflow.fix-satisfaction-checker",
    task: buildFixSatisfactionCheckerPrompt(changeId, fixResult, batch, workerOutput),
    cwd: options.cwd,
    ...(options.workerModel ? { model: options.workerModel } : {}),
    output: outputPath,
    outputMode: "file-only",
  })
  const resultWithPath = { ...result, outputPath: result.outputPath ?? outputPath }
  await ensureDispatchOutputFile(resultWithPath, outputPath, "satisfaction-checker")
  const checkerOutput = await readDispatchOutput(resultWithPath)
  return parseZflowFixResultEnvelope(checkerOutput)
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const { default: fs } = await import("node:fs/promises")
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

async function ensureDispatchOutputFile(
  result: AgentDispatchResult & { outputPath?: string },
  outputPath: string,
  label: string,
): Promise<void> {
  const { default: fs } = await import("node:fs/promises")
  result.outputPath = result.outputPath ?? outputPath
  if (await fileExists(outputPath)) return

  const content = result.rawOutput?.trim()
    ? result.rawOutput
    : [
        `# ${label}`,
        "",
        `**Status**: ${result.ok ? "completed" : "failed"}`,
        `**Error**: ${result.error ?? "none"}`,
        "",
      ].join("\n")
  try {
    await fs.writeFile(outputPath, content, "utf-8")
  } catch { /* best-effort */ }
}

async function cleanupStaleDirectFixArtifacts(versionDir: string, changeDir: string): Promise<void> {
  const { default: fs } = await import("node:fs/promises")
  try {
    const entries = await fs.readdir(versionDir)
    await Promise.all(entries
      .filter((entry) => /^batch-\d+(?:-result|-attempt-\d+|-satisfaction-check)\.md$/.test(entry) || entry === "fix-orchestration-report.md")
      .map((entry) => fs.rm(`${versionDir}/${entry}`, { force: true })))
  } catch { /* best-effort */ }
  try {
    await fs.rm(`${changeDir}/fix-orchestration-report.md`, { force: true })
  } catch { /* best-effort */ }
}

export function buildDirectFixBatches(
  findings: ParsedFinding[],
  workerAgent: string = "zflow.implement-routine",
): DirectFixBatch[] {
  const grouped = new Map<string, DirectFixBatch>()

  for (const finding of findings) {
    const fileKey = normalizeBatchFileKey(finding)
    const existing = grouped.get(fileKey)
    if (existing) {
      existing.findings.push(finding)
      if (finding.file && !existing.files.includes(finding.file)) {
        existing.files.push(finding.file)
      }
      if (severityRank(finding.severity) < severityRank(existing.severity)) {
        existing.severity = finding.severity
      }
      continue
    }

    grouped.set(fileKey, {
      batchId: `batch-${grouped.size + 1}`,
      fileKey,
      files: finding.file ? [finding.file] : [],
      findings: [finding],
      severity: finding.severity,
      workerAgent,
    })
  }

  return [...grouped.values()].sort((a, b) => {
    const sevDiff = severityRank(a.severity) - severityRank(b.severity)
    if (sevDiff !== 0) return sevDiff
    return a.fileKey.localeCompare(b.fileKey)
  })
}

/**
 * Build a concise conflict/scope guidance block for direct worker prompts.
 */
function buildConflictScopeGuidance(): string[] {
  return [
    "## Conflict Resolution & Scope Guard",
    "",
    "1. **Advisory suggestions only.** The `Suggested approach` in each finding is advisory — not a mandate. If it contradicts the source plan documents, prefer the plan's approved design and standards.",
    "2. **Minimal compliant fix.** Choose the smallest safe change that satisfies the finding and preserves the approved design/standards. Do not implement features planned for later phases.",
    "3. **Placeholder/missing-file findings.** For findings that ask for missing files or schema definitions: prefer minimal placeholders (`export {}`) or config adjustments over real schema/table/runtime behavior unless the finding's fix requirements explicitly demand production code.",
    "4. **Cross-finding consistency.** After editing a file for one finding, verify the change does not introduce a new violation of the other findings in this batch or the batch's target files.",
    "5. **Post-fix introduced-risk check.** After applying changes, re-read the touched files and verify: (a) no plan-forbidden concepts leaked in, (b) the same problem was not introduced at a different location, (c) the fix does not create a new finding class (e.g., silent failure → overly broad error handling).",
    "",
  ]
}

function buildDirectFixWorkerTaskPrompt(
  changeId: string,
  fixResult: FixWorkflowResult,
  batch: DirectFixBatch,
  runtimeStateDir: string,
  orchestratorTarget?: string,
): string {
  const planPaths = fixResult.planArtifactPaths ?? {}
  const lines: string[] = [
    `# Direct Fix Worker Task — ${changeId}`,
    "",
    `You are fixing ${batch.findings.length} review finding(s) for change \`${changeId}\`.`,
    `Work only on this batch: \`${batch.batchId}\`.`,
    `Primary target files: ${batch.files.length > 0 ? batch.files.map((file) => `\`${file}\``).join(", ") : "(not specified)"}`,
    "",
    "## Source Change Context (MUST read before editing)",
    "",
    "Read these canonical documents first and keep the fixes aligned with them:",
    `- Design: \`${planPaths.design ?? "(missing)"}\``,
    `- Execution Groups: \`${planPaths.executionGroups ?? "(missing)"}\``,
    `- Standards: \`${planPaths.standards ?? "(missing)"}\``,
    `- Verification: \`${planPaths.verification ?? "(missing)"}\``,
    `- Implementation Tasks: \`${planPaths.implementationTasks ?? "(missing)"}\``,
    "",
    fixResult.verificationCommand
      ? `Final verification command for the change: \`${fixResult.verificationCommand}\``
      : "No final verification command was resolved for the change artifacts.",
    "",
    "## Findings in this batch",
    "",
  ]

  for (const finding of batch.findings) {
    lines.push(`### ${finding.findingId}: ${finding.title}`)
    lines.push(`- Severity: ${finding.severity}`)
    lines.push(`- File: ${finding.file ?? "(not specified)"}`)
    if (finding.line) lines.push(`- Line: ${finding.line}`)
    lines.push(`- Reviewer: ${finding.reviewerRole}`)
    lines.push(`- Evidence: ${finding.evidence}`)
    lines.push(`- Recommendation: ${finding.recommendation}`)
    if (finding.expectedBehavior) lines.push(`- Expected behavior: ${finding.expectedBehavior}`)
    if (finding.fixRequirements) lines.push(`- Fix requirements: ${finding.fixRequirements}`)
    if (finding.validation) lines.push(`- Validation: ${finding.validation}`)
    if (finding.suggestedApproach) lines.push(`- Suggested approach: ${finding.suggestedApproach}`)
    if (finding.whyItMatters) lines.push(`- Why it matters: ${finding.whyItMatters}`)
    const artifactPath = toAbsoluteArtifactPath(runtimeStateDir, finding.artifactPath)
    if (artifactPath) lines.push(`- Raw reviewer artifact: \`${artifactPath}\``)
    lines.push("")
  }

  lines.push(
    ...buildLimitedCoordinationLines(`fix ${changeId} ${batch.batchId}`, orchestratorTarget),
    "- Do not use coordination for routine narration.",
    "",
    "## Required structured result",
    "",
    "End your final response with a single fenced ```json block using this exact top-level key.",
    "Use `already_satisfied` when no edit is needed because the current code already satisfies the finding. Include concrete evidence.",
    "",
    "```json",
    JSON.stringify({
      zflowFixResult: {
        status: "fixed | already_satisfied | blocked | partial",
        findings: [{
          findingId: batch.findings[0]?.findingId ?? "finding-id",
          status: "fixed | already_satisfied | blocked | partial",
          evidence: ["file/path:line or concrete reason"],
          changedFiles: ["file/path.ts"],
          validation: ["command/result or read-only verification"],
          reason: "brief explanation",
        }],
      },
    }, null, 2),
    "```",
    "",
    "## Instructions",
    "",
    "1. Read the source change documents listed above before editing.",
    "2. Read the raw reviewer artifact(s) for this batch before editing.",
    "3. Fix ONLY the findings in this batch. Do not expand scope.",
    "4. Prefer the minimal code change that satisfies the findings and preserves the approved design/standards.",
    "5. Update or add focused tests when behavior changes.",
    "6. Run the most relevant validation/test commands you can for this batch. Use any explicit validation listed above.",
    "7. In your final response, report: changed files, findings addressed, validation run, and any unresolved blocker.",
    "8. Always include the required structured JSON result block. If you made no edits because the finding was already satisfied, set the relevant finding status to `already_satisfied` and include evidence.",
    "",
    ...buildConflictScopeGuidance(),
  )

  return lines.join("\n")
}

function buildDirectFixReport(
  changeId: string,
  fixResult: FixWorkflowResult,
  batchCount: number,
  fixed: DirectFixFindingOutcome[],
  unresolved: DirectFixFindingOutcome[],
): string {
  const alreadySatisfied = fixed.filter((f) => f.status === "already-satisfied")
  const actuallyFixed = fixed.filter((f) => f.status === "fixed")
  const lines: string[] = [
    "# Fix Orchestration Report",
    "",
    `**Change**: ${changeId}`,
    `**Findings processed**: ${fixResult.parsedFindings.length}`,
    `**Batches used**: ${batchCount}`,
    `**Config**: maxAttemptsPerFinding=${fixResult.fixOrchestratorConfig.maxAttemptsPerFinding}, maxGlobalRounds=${fixResult.fixOrchestratorConfig.maxGlobalRounds}`,
    `**Execution mode**: direct command-layer orchestration (no nested fix-orchestrator subagent)`,
    "",
    "## Fixed",
    "",
    ...(actuallyFixed.length > 0
      ? actuallyFixed.map((finding) => `- ${finding.findingId}: ${finding.title} (status: fixed, attempts: ${finding.attempts})${finding.outputPath ? ` \u2014 output: ${finding.outputPath}` : ""}`)
      : ["None."]),
    "",
  ]

  if (alreadySatisfied.length > 0) {
    lines.push(
      "## Already Satisfied",
      "",
      ...alreadySatisfied.map((finding) => `- ${finding.findingId}: ${finding.title} (status: already-satisfied, attempts: ${finding.attempts})${finding.reason ? ` \u2014 ${finding.reason}` : ""}${finding.outputPath ? ` \u2014 output: ${finding.outputPath}` : ""}`),
      "",
    )
  }

  lines.push(
    "## Unresolved",
    "",
    ...(unresolved.length > 0
      ? unresolved.map((finding) => `- ${finding.findingId}: ${finding.title} \u2014 ${finding.reason ?? "worker failed"} (attempts: ${finding.attempts})${finding.outputPath ? ` \u2014 output: ${finding.outputPath}` : ""}`)
      : ["None."]),
    "",
    "## Verification",
    "",
    fixResult.verificationCommand
      ? `- Verification command: \`${fixResult.verificationCommand}\``
      : "- Verification command: (not resolved)",
    unresolved.length > 0
      ? "- Result: partial \u2014 unresolved findings remain"
      : "- Result: worker-level validation completed for all dispatched batches",
    "",
    "## Reviewer Re-check Recommendation",
    "",
    "- Recommend re-running: correctness, integration, security, system",
    `- Focus files: ${[...new Set(fixResult.parsedFindings.map((finding) => finding.file).filter((file): file is string => Boolean(file)))].map((file) => `\`${file}\``).join(", ") || "(none listed)"}`,
  )

  return lines.join("\n")
}

function buildRetryPromptSuffix(
  batch: DirectFixBatch,
  attempt: number,
  previousError?: string,
  previousOutputPath?: string,
): string {
  const lines: string[] = [
    "",
    "## Previous attempt failed",
    `- Attempt #${attempt - 1} error: ${previousError ?? "unknown"}`,
  ]
  if (previousOutputPath) {
    lines.push(`- Previous output: ${previousOutputPath}`)
  }
  lines.push(
    "- Focus on applying concrete code changes. Return changed file diffs in your output.",
    "- If the finding is already addressed and no code change is needed, explain clearly which file(s) already satisfy the requirement and why.",
    "",
  )
  return lines.join("\n")
}

export async function runDirectFixWorkflow(
  options: DirectFixWorkflowOptions,
): Promise<DirectFixWorkflowResult> {
  const { default: fs } = await import("node:fs/promises")
  const cwd = options.cwd
  const changeId = options.changeId
  const fixResult = options.fixResult
  const workerAgent = options.workerAgent ?? "zflow.implement-routine"
  const batches = buildDirectFixBatches(fixResult.parsedFindings, workerAgent)
  const runtimeStateDir = resolveRuntimeStateDir(cwd)
  const versionDir = resolvePlanVersionDir(changeId, fixResult.planVersion, cwd)
  const changeDir = resolveChangeDir(changeId, cwd)
  const maxAttempts = Math.max(1, fixResult.fixOrchestratorConfig.maxAttemptsPerFinding)
  await fs.mkdir(versionDir, { recursive: true })
  await fs.mkdir(changeDir, { recursive: true })
  await cleanupStaleDirectFixArtifacts(versionDir, changeDir)

  const fixed: DirectFixFindingOutcome[] = []
  const unresolved: DirectFixFindingOutcome[] = []

  for (const batch of batches) {
    await options.onBatchStart?.(batch)
    let lastResult: (AgentDispatchResult & { outputPath?: string }) | null = null
    let attempt = 0

    while (attempt < maxAttempts) {
      attempt++
      const outputPath = attempt === 1
        ? `${versionDir}/${batch.batchId}-result.md`
        : `${versionDir}/${batch.batchId}-attempt-${attempt}.md`

      let task = buildDirectFixWorkerTaskPrompt(changeId, fixResult, batch, runtimeStateDir)
      if (attempt > 1 && lastResult) {
        task += buildRetryPromptSuffix(batch, attempt, lastResult.error, lastResult.outputPath)
      }

      lastResult = await options.dispatchService.runAgent({
        agent: batch.workerAgent,
        task,
        cwd,
        ...(options.workerModel ? { model: options.workerModel } : {}),
        ...(options.workerThinking ? { thinking: options.workerThinking } : {}),
        output: outputPath,
        outputMode: "file-only",
        onUpdate: (progress) => {
          void options.onBatchUpdate?.(batch, progress)
        },
      })

      await ensureDispatchOutputFile(lastResult, outputPath, `${batch.batchId} attempt ${attempt}`)

      if (lastResult.ok) break
    }

    await options.onBatchComplete?.(batch, lastResult!)

    const finalResult = lastResult!
    const finalOutput = await readDispatchOutput(finalResult)
    const structuredResult = parseZflowFixResultEnvelope(finalOutput)

    if (structuredResult) {
      const handled = applyStructuredFixResults(
        batch,
        structuredResult,
        fixed,
        unresolved,
        attempt,
        finalResult.outputPath,
      )
      for (const finding of batch.findings) {
        if (!handled.has(finding.findingId)) {
          unresolved.push({
            findingId: finding.findingId,
            title: finding.title,
            severity: finding.severity,
            file: finding.file,
            status: "unresolved",
            attempts: attempt,
            reason: "structured fix result omitted this finding",
            outputPath: finalResult.outputPath,
          })
        }
      }
      continue
    }

    if (finalResult.ok) {
      for (const finding of batch.findings) {
        fixed.push({
          findingId: finding.findingId,
          title: finding.title,
          severity: finding.severity,
          file: finding.file,
          status: "fixed",
          attempts: attempt,
          outputPath: finalResult.outputPath,
        })
      }
      continue
    }

    const checkerOutputPath = `${versionDir}/${batch.batchId}-satisfaction-check.md`
    const checkerResult = await runSatisfactionChecker(
      options,
      changeId,
      fixResult,
      batch,
      finalOutput || finalResult.error || "",
      checkerOutputPath,
    )

    if (checkerResult) {
      const handled = applyStructuredFixResults(
        batch,
        checkerResult,
        fixed,
        unresolved,
        attempt,
        checkerOutputPath,
      )
      for (const finding of batch.findings) {
        if (!handled.has(finding.findingId)) {
          unresolved.push({
            findingId: finding.findingId,
            title: finding.title,
            severity: finding.severity,
            file: finding.file,
            status: "unresolved",
            attempts: attempt,
            reason: "satisfaction checker omitted this finding",
            outputPath: checkerOutputPath,
          })
        }
      }
      continue
    }

    for (const finding of batch.findings) {
      unresolved.push({
        findingId: finding.findingId,
        title: finding.title,
        severity: finding.severity,
        file: finding.file,
        status: "unresolved",
        attempts: attempt,
        reason: finalResult.error ?? "worker failed",
        outputPath: finalResult.outputPath,
      })
    }
  }

  const reportContent = buildDirectFixReport(changeId, fixResult, batches.length, fixed, unresolved)
  const reportPath = `${versionDir}/fix-orchestration-report.md`
  await fs.writeFile(reportPath, reportContent, "utf-8")
  await fs.writeFile(`${changeDir}/fix-orchestration-report.md`, reportContent, "utf-8")

  return {
    changeId,
    planVersion: fixResult.planVersion,
    reportPath,
    batchCount: batches.length,
    fixed,
    unresolved,
    verificationCommand: fixResult.verificationCommand,
  }
}
export async function runChangeFixWorkflow(
  options: FixWorkflowOptions,
): Promise<FixWorkflowResult> {
  const cwd = options.cwd
  const changeId = options.changeId
  const { default: fs } = await import("node:fs/promises")

  await migrateLegacyChangeArtifactsIfPresent(changeId, cwd)
  const planStatePath = resolvePlanStatePath(changeId, cwd)
  let planState: Record<string, unknown>
  try {
    const raw = await fs.readFile(planStatePath, "utf-8")
    planState = JSON.parse(raw)
  } catch {
    throw new Error(`No plan found for change "${changeId}". Run /zflow-change-prepare ${changeId} first.`)
  }

  const planVersion = (planState.approvedVersion ?? planState.currentVersion ?? "v1") as string
  const lifecycleState = (planState.lifecycleState ?? "unknown") as string

  const { findings, rawPath, metadata } = await parseReviewFindings(cwd)
  assertFindingsMatchChange(changeId, metadata, rawPath)

  let selectedFindings = findings
  if (options.findingIndices && options.findingIndices.length > 0) {
    selectedFindings = findings.filter((_, i) => options.findingIndices!.includes(i))
  }

  let verificationCommand: string | undefined
  try {
    const verificationPath = resolvePlanArtifactPath(changeId, planVersion, "verification", cwd)
    const verificationContent = await fs.readFile(verificationPath, "utf-8")
    const cmdMatch = verificationContent.match(/```(?:bash)?\s*\n([\s\S]*?)```/)
    if (cmdMatch) {
      verificationCommand = cmdMatch[1].trim()
    }
  } catch {
    // no verification artifact
  }

  const filesToModify: string[] = []
  try {
    const egPath = resolvePlanArtifactPath(changeId, planVersion, "execution-groups", cwd)
    const egContent = await fs.readFile(egPath, "utf-8")
    const fileMatches = egContent.matchAll(/[`"']([^`"']*\.[a-zA-Z]+)[`"']/g)
    for (const match of fileMatches) {
      const filePath = match[1]
      if (!filesToModify.includes(filePath)) {
        filesToModify.push(filePath)
      }
    }
  } catch {
    // no execution groups artifact
  }

  let fixPlan: string
  if (selectedFindings.length > 0) {
    fixPlan = await buildFixPlan(changeId, selectedFindings, cwd)
  } else {
    const lines: string[] = [
      `# Fix Plan for ${changeId}`,
      "",
      `**Plan Version:** ${planVersion}`,
      `**Plan State:** ${lifecycleState}`,
      "",
      "## Findings",
      "",
      "No structured review findings available. Manual review may be needed.",
      "",
    ]
    if (filesToModify.length > 0) {
      lines.push("## Target Files")
      lines.push("")
      for (const f of filesToModify) {
        lines.push(`- \`${f}\``)
      }
      lines.push("")
    }
    if (verificationCommand) {
      lines.push("## Verification Command")
      lines.push("")
      lines.push("```bash")
      lines.push(verificationCommand)
      lines.push("```")
      lines.push("")
    }
    fixPlan = lines.join("\n")
  }

  const fixOrchestratorConfig = resolveFixOrchestratorConfig()

  return {
    changeId,
    fixPlan,
    filesToModify,
    verificationCommand,
    parsedFindings: selectedFindings,
    rawFindingsPath: rawPath,
    planVersion,
    lifecycleState,
    fixOrchestratorConfig,
    fixOrchestratorTaskPrompt: undefined,
    planArtifactPaths: {
      design: resolvePlanArtifactPath(changeId, planVersion, "design", cwd),
      executionGroups: resolvePlanArtifactPath(changeId, planVersion, "execution-groups", cwd),
      standards: resolvePlanArtifactPath(changeId, planVersion, "standards", cwd),
      verification: resolvePlanArtifactPath(changeId, planVersion, "verification", cwd),
      implementationTasks: resolvePlanArtifactPath(changeId, planVersion, "implementation-tasks", cwd),
    },
  }
}

/**
 * Build the task prompt for the fix orchestrator agent.
 */
export async function buildFixOrchestratorTaskPrompt(
  changeId: string,
  fixResult: FixWorkflowResult,
  findingsPath: string,
  rawReviewerDir?: string,
  cwd?: string,
  orchestratorTarget?: string,
): Promise<string> {
  const config = fixResult.fixOrchestratorConfig
  const planPaths = fixResult.planArtifactPaths
  const lines: string[] = [
    `# Fix Orchestration Task — ${changeId}`,
    "",
    "Agent role: `zflow.fix-orchestrator`.",
    "",
    "You are the fix orchestrator. Your role is to read the code review",
    "findings below, decompose them into fix work items, dispatch fix",
    "subagents, and validate that their work satisfies the original",
    "finding requirements AND the original change documents.",
    "",
    "## Configuration",
    "",
    `- Max attempts per finding: ${config.maxAttemptsPerFinding}`,
    `- Max global rounds: ${config.maxGlobalRounds}`,
    "",
    "## Source Change Context (MUST read before dispatching fix workers)",
    "",
    "The original change was planned and implemented based on these documents.",
    "Fix workers must respect the design intent, standards, and verification",
    "requirements described here. When validating fixes, check that they align",
    "with these documents, not just the individual finding text.",
    "",
  ]

  if (planPaths) {
    lines.push(
      "| Document | Path |",
      "| -------- | ---- |",
      `| Design | \`${planPaths.design}\` |`,
      `| Execution Groups | \`${planPaths.executionGroups}\` |`,
      `| Standards | \`${planPaths.standards}\` |`,
      `| Verification | \`${planPaths.verification}\` |`,
      `| Implementation Tasks | \`${planPaths.implementationTasks}\` |`,
      "",
      "**Read these documents before dispatching any fix worker.**",
      "If a fix would contradict the approved design or standards, note it in",
      "your gap report and escalate rather than silently diverging.",
      "",
    )
  }

  lines.push(
    "## Change context",
    "",
    `- Change ID: ${changeId}`,
    `- Plan version: ${fixResult.planVersion}`,
    `- Plan state: ${fixResult.lifecycleState}`,
    fixResult.verificationCommand
      ? `- Verification command: \`${fixResult.verificationCommand}\``
      : "",
    "",
    "## Findings to address",
    "",
  )

  for (const finding of fixResult.parsedFindings) {
    lines.push(`### ${finding.findingId}: ${finding.title}`)
    lines.push("")
    lines.push(`- **Severity**: ${finding.severity}`)
    lines.push(`- **File**: ${finding.file ?? "(not specified)"}`)
    if (finding.line) lines.push(`- **Line**: ${finding.line}`)
    lines.push(`- **Reviewer**: ${finding.reviewerRole}`)
    lines.push(`- **Evidence**: ${finding.evidence}`)
    lines.push(`- **Recommendation**: ${finding.recommendation}`)
    if (finding.expectedBehavior) lines.push(`- **Expected behavior**: ${finding.expectedBehavior}`)
    if (finding.fixRequirements) lines.push(`- **Fix requirements**: ${finding.fixRequirements}`)
    if (finding.validation) lines.push(`- **Validation**: ${finding.validation}`)
    if (finding.suggestedApproach) lines.push(`- **Suggested approach**: ${finding.suggestedApproach}`)
    if (finding.artifactPath) lines.push(`- **Artifact**: ${finding.artifactPath}`)
    if (finding.whyItMatters) lines.push(`- **Why it matters**: ${finding.whyItMatters}`)
    lines.push("")
  }

  // Collect unique actual artifact paths from the parsed findings themselves
  const artifactPaths = [
    ...new Set(
      fixResult.parsedFindings
        .map((f) => f.artifactPath)
        .filter((p): p is string => !!p && p.trim().length > 0),
    ),
  ]
  if (artifactPaths.length > 0) {
    lines.push("## Raw reviewer artifacts (MUST read for each finding)")
    lines.push("")
    lines.push("The consolidated findings above are summaries. The raw reviewer")
    lines.push("artifacts below contain the full analysis, pseudocode, line-by-line")
    lines.push("evidence, and specific fix strategies from each reviewer agent.")
    lines.push("These are ESSENTIAL context for fix workers.")
    lines.push("")
    lines.push("| Finding | Artifact Path |")
    lines.push("| ------- | ------------- |")
    for (const finding of fixResult.parsedFindings) {
      if (finding.artifactPath && finding.artifactPath.trim().length > 0) {
        lines.push(`| ${finding.findingId} | \`${finding.artifactPath}\` |`)
      }
    }
    lines.push("")
    lines.push("**For each finding you dispatch to a fix worker:**")
    lines.push("1. Read the raw reviewer artifact listed above.")
    lines.push("2. Extract the detailed evidence (file snippets, pseudocode, reasoning).")
    lines.push("3. Include that detail in the fix worker's task prompt.")
    lines.push("4. Use the raw evidence as the validation baseline when checking the fix.")
    lines.push("")
  }

  lines.push(
    "## Conflict Resolution Protocol",
    "",
    "**Treat suggested approaches as advisory only.** The reviewer's",
    "`Suggested approach` field in each finding is a hint, not a mandate.",
    "Evaluate every suggestion against the source design documents,",
    "standards, and all other findings before accepting it.",
    "",
    "**When a suggestion would conflict with plan constraints:**",
    "",
    "1. Read the relevant sections from `design.md`, `standards.md`, and",
    "   `execution-groups.md` for the target file/area.",
    "2. Check whether the suggested approach would introduce later-phase",
    "   scope (for example, adding a real database table in a scaffold-only phase).",
    "3. If the suggestion violates source-document constraints, choose the",
    "   **minimal compliant fix** that satisfies both the finding and the plan.",
    "",
    "**Placeholder/missing-file guidance:**",
    "",
    "- For missing placeholder files, prefer `export {}` comment-only stubs",
    "  or config-path adjustment over real schema/table/runtime behavior.",
    "- Do not add production-adjacent scaffolding unless the source design",
    "  documents explicitly require it.",
    "",
    "**Cross-finding consistency:**",
    "",
    "1. Before dispatching a fix worker, re-read ALL findings in this report.",
    "2. Check whether the proposed fix for one finding would create a new",
    "   violation that another finding or reviewer would reject.",
    "",
    "**Post-fix introduced-risk check:**",
    "",
    "After each fix worker completes, before marking a finding as FIXED:",
    "",
    "1. Read the touched files to verify they do not contain plan-forbidden",
    "   concepts such as later-phase scope, secrets, or hard-coded production config.",
    "2. Re-read the finding evidence and recommendation to ensure the fix did not",
    "   introduce the same problem in a different location.",
    "3. Re-read other findings in the same report to ensure this fix does not",
    "   create a new finding class.",
    "",
  )

  if (findingsPath) {
    lines.push("## Consolidated findings path")
    lines.push("")
    lines.push(`\`${findingsPath}\``)
    lines.push("")
  }

  lines.push(
    ...buildLimitedCoordinationLines(`change ${changeId}`, orchestratorTarget),
    "- When you dispatch fix workers, pass through the same narrow coordination contract.",
    "- Fix workers should prefer `contact_supervisor` when available and use raw `intercom` only as fallback plumbing.",
    ...(orchestratorTarget
      ? [`- If you must pass a raw intercom fallback to a fix worker, use \`${orchestratorTarget}\`.`]
      : []),
    "",
  )

  lines.push(
    "## Instructions",
    "",
    "1. **Read source context first.** Read the design, execution-groups,",
    "   standards, and verification documents listed above. Understand the",
    "   original intent before dispatching any fix worker.",
    "2. **Read raw reviewer artifacts for each finding.** The consolidated",
    "   findings are summaries — the raw artifacts have detailed evidence.",
    "3. Analyze the findings and group by target file.",
    "4. For each finding, choose a fix worker agent:",
    "   - `zflow.implement-routine` for straightforward fixes",
    "   - `zflow.implement-hard` for complex/cross-module/high-severity",
    "5. **Build context-rich worker tasks.** Each task must include:",
    "   - The original finding text (evidence, expected behavior, fix requirements)",
    "   - Relevant excerpts from the raw reviewer artifact",
    "   - Relevant design/standards context from the source documents",
    "   - The exact validation/proof the fix must pass",
    "6. Dispatch workers using `subagent` tool.",
    "7. After each worker completes, validate the fix against:",
    "   - The original finding requirements",
    "   - The source design and standards documents",
    "   - The raw reviewer evidence",
    "8. If incomplete, dispatch again with precise gap details.",
    "9. Respect the retry bounds above.",
    "10. Persist your satisfaction report to " + "`.zflow/plans/" + changeId + "/fix-orchestration-report.md`.",
    "11. Report back with:\n",
    "   - Which findings were FIXED (with attempt count)",
    "   - Which findings are UNRESOLVED (with explanation)",
    "   - Any recommendations for re-review",
    "   - Whether verification passed",
    "   - Any source-document deviations you observed",
    "   - A note about whether the fixes align with the original design intent",
  )

  return lines.join("\n")
}
