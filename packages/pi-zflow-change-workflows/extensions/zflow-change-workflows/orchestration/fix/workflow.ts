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
import { getZflowRegistry } from "pi-zflow-core/registry"
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
  inferRootCause,
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
  familyKey: string
  familyLabel: string
  rootCause: string
  recurrenceCount: number
  isRecurring: boolean
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

export interface GlobalRoundState {
  round: number
  maxRounds: number
  recurrenceByFamily: Record<string, number>
}

export interface DirectFixWorkflowResult {
  changeId: string
  planVersion: string
  reportPath: string
  batchCount: number
  fixed: DirectFixFindingOutcome[]
  unresolved: DirectFixFindingOutcome[]
  verificationCommand?: string
  globalRoundsUsed: number
  globalRoundsMax: number
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

function collectStructuredChangedFiles(
  envelope: ZflowFixResultEnvelope | undefined,
  batch: DirectFixBatch,
): string[] {
  if (!envelope) return batch.files
  const changed = new Set<string>()
  for (const finding of batch.findings) {
    const result = structuredResultForFinding(envelope, finding)
    for (const file of result?.changedFiles ?? []) {
      if (file.trim()) changed.add(file.trim())
    }
  }
  for (const file of envelope.zflowFixResult.changedFiles ?? []) {
    if (file.trim()) changed.add(file.trim())
  }
  if (changed.size === 0) {
    for (const file of batch.files) changed.add(file)
  }
  return [...changed]
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
    "Do not edit files. Inspect only the source files, plan artifacts, review finding text, and worker output. Verify the whole finding family/root cause, not just a worker claim.",
    "",
    "## Required JSON result",
    "",
    "Return a single JSON object in a fenced ```json block using this exact top-level key:",
    "",
    "```json",
    JSON.stringify({
      zflowFixResult: {
        status: "fixed | already_satisfied | not_satisfied | uncertain",
        findings: [{
          findingId: "finding-id",
          status: "fixed | already_satisfied | not_satisfied | uncertain",
          evidence: ["file/path:line or concrete reason"],
          changedFiles: [],
          validation: ["read-only checks performed"],
          reason: "brief explanation",
        }],
      },
    }, null, 2),
    "```",
    "",
    "Use `fixed` when the current repository state now satisfies the requirement because of newly-applied changes. Use `already_satisfied` only when the requirement was already met before the attempted fix. Otherwise use `not_satisfied` or `uncertain`.",
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
  let result: AgentDispatchResult & { outputPath?: string }
  try {
    result = await options.dispatchService.runAgent({
      agent: "zflow.fix-satisfaction-checker",
      task: buildFixSatisfactionCheckerPrompt(changeId, fixResult, batch, workerOutput),
      cwd: options.cwd,
      ...(options.workerModel ? { model: options.workerModel } : {}),
      output: outputPath,
      outputMode: "file-only",
    })
  } catch (error) {
    result = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      outputPath,
    }
  }
  const resultWithPath = { ...result, outputPath: result.outputPath ?? outputPath }
  await ensureDispatchOutputFile(resultWithPath, outputPath, "satisfaction-checker")
  const checkerOutput = await readDispatchOutput(resultWithPath)
  return parseZflowFixResultEnvelope(checkerOutput)
}

async function runFocusedFixReview(
  changeId: string,
  fixResult: FixWorkflowResult,
  batch: DirectFixBatch,
  changedFiles: string[],
  cwd?: string,
): Promise<{ ok: boolean, summary: string, findingsPath?: string }> {
  const reviewService = getZflowRegistry().optional<Record<string, Function>>("review")
  if (!reviewService || typeof reviewService.runCodeReview !== "function") {
    return { ok: true, summary: "review service unavailable; targeted post-fix review skipped" }
  }

  const { default: fs } = await import("node:fs/promises")
  const diffFile = `${resolvePlanVersionDir(changeId, fixResult.planVersion, cwd)}/${batch.batchId}-focused-review.diff`
  let diffBundle = ""
  try {
    const { execFile } = await import("node:child_process")
    diffBundle = await new Promise<string>((resolve) => {
      execFile("git", ["diff", "--", ...(changedFiles.length > 0 ? changedFiles : batch.files)], { cwd }, (error, stdout) => {
        if (error) {
          resolve("")
          return
        }
        resolve(stdout)
      })
    })
  } catch {
    diffBundle = ""
  }
  try {
    await fs.writeFile(diffFile, diffBundle, "utf-8")
  } catch { /* best-effort */ }

  const planningArtifacts = {
    design: fixResult.planArtifactPaths?.design ?? resolvePlanArtifactPath(changeId, fixResult.planVersion, "design", cwd),
    executionGroups: fixResult.planArtifactPaths?.executionGroups ?? resolvePlanArtifactPath(changeId, fixResult.planVersion, "execution-groups", cwd),
    standards: fixResult.planArtifactPaths?.standards ?? resolvePlanArtifactPath(changeId, fixResult.planVersion, "standards", cwd),
    verification: fixResult.planArtifactPaths?.verification ?? resolvePlanArtifactPath(changeId, fixResult.planVersion, "verification", cwd),
  }

  try {
    const result = await (reviewService.runCodeReview as Function)({
      source: `Implementation of ${changeId}`,
      repoPath: cwd ?? process.cwd(),
      branch: "(focused-fix-review)",
      planningArtifacts,
      verificationStatus: "passed",
      diffBundle: diffBundle || undefined,
      diffSource: diffBundle ? "focused-fix-review" : "focused-fix-review-empty-diff",
      modifiedFiles: changedFiles.length > 0 ? changedFiles : batch.files,
      targetPath: changedFiles.length === 1 ? changedFiles[0] : undefined,
      focusReview: {
        mode: "fix-follow-up",
        targetFiles: changedFiles.length > 0 ? changedFiles : batch.files,
        targetFamilies: [batch.familyKey],
        priorFindings: batch.findings.map((finding) => ({
          findingId: finding.findingId,
          title: finding.title,
          severity: finding.severity,
          file: finding.file,
          findingFamily: finding.findingFamily ?? batch.familyKey,
          canonicalKey: finding.canonicalKey,
        })),
      },
      cwd,
    }) as { severity?: { critical: number, major: number }, summary?: string, findingsPath?: string, coverageNotes?: string[] }

    const critical = result.severity?.critical ?? 0
    const major = result.severity?.major ?? 0
    if (critical > 0 || major > 0) {
      return {
        ok: false,
        summary: result.summary ?? `targeted post-fix review found ${critical} critical and ${major} major issues`,
        findingsPath: result.findingsPath,
      }
    }

    return {
      ok: true,
      summary: result.summary ?? "targeted post-fix review passed",
      findingsPath: result.findingsPath,
    }
  } catch (error) {
    return {
      ok: true,
      summary: `targeted post-fix review unavailable: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
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

function normalizeFamilyConcern(finding: ParsedFinding): string {
  const seed = finding.findingFamily ?? finding.canonicalKey ?? finding.expectedBehavior ?? finding.fixRequirements ?? finding.title
  return seed
    .toLowerCase()
    .replace(/^[a-z-]+:/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 6)
    .join("-") || "general"
}

function resolveBatchFamily(finding: ParsedFinding): { familyKey: string, familyLabel: string, rootCause: string } {
  const rootCause = finding.rootCause ?? inferRootCause(finding)
  const familyKey = finding.findingFamily ?? `${rootCause}:${normalizeFamilyConcern(finding)}`
  const familyLabel = familyKey.replace(/:/g, " / ")
  return { familyKey, familyLabel, rootCause }
}

function selectWorkerAgentForBatch(batch: Omit<DirectFixBatch, "workerAgent">, defaultAgent: string): string {
  if (batch.severity === "critical") return "zflow.implement-hard"
  if (batch.isRecurring) return "zflow.implement-hard"
  if (batch.files.length > 1) return "zflow.implement-hard"
  if (batch.findings.length > 3) return "zflow.implement-hard"
  if (["security", "performance", "architecture", "contract"].includes(batch.rootCause)) return "zflow.implement-hard"
  return defaultAgent
}

function batchesConflict(a: DirectFixBatch, b: DirectFixBatch): boolean {
  if (a.files.length === 0 || b.files.length === 0) return true
  return a.files.some((file) => b.files.includes(file))
}

function partitionBatchesIntoWaves(batches: DirectFixBatch[]): DirectFixBatch[][] {
  const waves: DirectFixBatch[][] = []
  for (const batch of batches) {
    let placed = false
    for (const wave of waves) {
      if (wave.every((existing) => !batchesConflict(existing, batch))) {
        wave.push(batch)
        placed = true
        break
      }
    }
    if (!placed) {
      waves.push([batch])
    }
  }
  return waves
}

export function buildFamilyClusters(findings: ParsedFinding[]): Map<string, ParsedFinding[]> {
  const grouped = new Map<string, ParsedFinding[]>()
  for (const finding of findings) {
    const { familyKey } = resolveBatchFamily(finding)
    const cluster = grouped.get(familyKey)
    if (cluster) {
      cluster.push(finding)
    } else {
      grouped.set(familyKey, [finding])
    }
  }
  return grouped
}

export function buildDirectFixBatches(
  findings: ParsedFinding[],
  workerAgent: string = "zflow.implement-routine",
  recurrenceByFamily: Record<string, number> = {},
): DirectFixBatch[] {
  const clusters = buildFamilyClusters(findings)
  const batches: DirectFixBatch[] = []

  for (const cluster of clusters.values()) {
    const first = cluster[0]
    const { familyKey, familyLabel, rootCause } = resolveBatchFamily(first)
    const files = [...new Set(cluster.map((finding) => finding.file).filter((file): file is string => Boolean(file)))]
    const severity = cluster.reduce<ParsedFinding["severity"]>((worst, finding) => {
      return severityRank(finding.severity) < severityRank(worst) ? finding.severity : worst
    }, first.severity)
    const recurrenceCount = Math.max(
      recurrenceByFamily[familyKey] ?? 0,
      ...cluster.map((finding) => finding.recurrenceCount ?? 0),
    )
    const provisional: Omit<DirectFixBatch, "workerAgent"> = {
      batchId: `batch-${batches.length + 1}`,
      fileKey: familyKey,
      files,
      findings: cluster,
      severity,
      familyKey,
      familyLabel,
      rootCause,
      recurrenceCount,
      isRecurring: recurrenceCount > 1,
    }
    batches.push({
      ...provisional,
      workerAgent: selectWorkerAgentForBatch(provisional, workerAgent),
    })
  }

  return batches.sort((a, b) => {
    const sevDiff = severityRank(a.severity) - severityRank(b.severity)
    if (sevDiff !== 0) return sevDiff
    if (a.recurrenceCount !== b.recurrenceCount) return b.recurrenceCount - a.recurrenceCount
    if (a.findings.length !== b.findings.length) return b.findings.length - a.findings.length
    return a.familyKey.localeCompare(b.familyKey)
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
    `Finding family: \`${batch.familyKey}\` (${batch.familyLabel})`,
    `Root cause: ${batch.rootCause}`,
    `Recurrence count: ${batch.recurrenceCount}`,
    `Primary target files: ${batch.files.length > 0 ? batch.files.map((file) => `\`${file}\``).join(", ") : "(not specified)"}`,
    batch.isRecurring
      ? "This family has recurred across review loops. Prefer a deeper, root-cause-complete fix rather than a narrow patch."
      : "This is the first known fix round for this finding family.",
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
    if (finding.rootCause) lines.push(`- Root cause: ${finding.rootCause}`)
    if (finding.findingFamily) lines.push(`- Finding family: ${finding.findingFamily}`)
    if (finding.canonicalKey) lines.push(`- Canonical key: ${finding.canonicalKey}`)
    if (typeof finding.recurrenceCount === "number") lines.push(`- Recurrence count: ${finding.recurrenceCount}`)
    const artifactPath = toAbsoluteArtifactPath(runtimeStateDir, finding.artifactPath)
    if (artifactPath) lines.push(`- Primary raw reviewer artifact: \`${artifactPath}\``)
    for (const extraPath of finding.artifactPaths ?? []) {
      const absolute = toAbsoluteArtifactPath(runtimeStateDir, extraPath)
      if (absolute && absolute !== artifactPath) {
        lines.push(`- Supporting raw reviewer artifact: \`${absolute}\``)
      }
    }
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
    "3. Fix ONLY the findings in this batch, but fix them at the root-cause/family level so the same issue does not survive into the next review loop.",
    "4. Prefer the minimal code change that satisfies the findings and preserves the approved design/standards. Do not silently leave sibling files in the same finding family inconsistent.",
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
  globalRoundsUsed: number,
): string {
  const alreadySatisfied = fixed.filter((f) => f.status === "already-satisfied")
  const actuallyFixed = fixed.filter((f) => f.status === "fixed")
  const lines: string[] = [
    "# Fix Orchestration Report",
    "",
    `**Change**: ${changeId}`,
    `**Findings processed**: ${fixResult.parsedFindings.length}`,
    `**Batches used**: ${batchCount}`,
    `**Global rounds used**: ${globalRoundsUsed}/${fixResult.fixOrchestratorConfig.maxGlobalRounds}`,
    `**Config**: maxAttemptsPerFinding=${fixResult.fixOrchestratorConfig.maxAttemptsPerFinding}, maxGlobalRounds=${fixResult.fixOrchestratorConfig.maxGlobalRounds}`,
    `**Execution mode**: direct command-layer orchestration (no nested fix-orchestrator subagent)`,
    `**Clustering mode**: canonical finding family/root-cause clustering with backward-compatible fallbacks`,
    `**Worker routing**: recurring, multi-file, critical, security, contract, architecture, and performance clusters escalate to zflow.implement-hard`,
    `**Validation mode**: worker output + satisfaction checker + targeted post-fix review when available`,
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
      ? "- Result: partial — unresolved findings remain after independent checks"
      : "- Result: independent checker/review validation completed for all dispatched batches",
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
  const runtimeStateDir = resolveRuntimeStateDir(cwd)
  const versionDir = resolvePlanVersionDir(changeId, fixResult.planVersion, cwd)
  const changeDir = resolveChangeDir(changeId, cwd)
  const maxAttempts = Math.max(1, fixResult.fixOrchestratorConfig.maxAttemptsPerFinding)
  const maxRounds = Math.max(1, fixResult.fixOrchestratorConfig.maxGlobalRounds)
  await fs.mkdir(versionDir, { recursive: true })
  await fs.mkdir(changeDir, { recursive: true })
  await cleanupStaleDirectFixArtifacts(versionDir, changeDir)

  const fixedById = new Map<string, DirectFixFindingOutcome>()
  const unresolvedById = new Map<string, DirectFixFindingOutcome>()
  const recurrenceByFamily: Record<string, number> = {}
  let pendingFindings = [...fixResult.parsedFindings]
  let totalBatchCount = 0
  let roundsUsed = 0

  const runBatch = async (batch: DirectFixBatch): Promise<{ batch: DirectFixBatch, fixed: DirectFixFindingOutcome[], unresolved: DirectFixFindingOutcome[] }> => {
    await options.onBatchStart?.(batch)
    let lastResult: (AgentDispatchResult & { outputPath?: string }) | null = null
    let workerEnvelope: ZflowFixResultEnvelope | undefined
    let workerOutput = ""
    let attempt = 0

    while (attempt < maxAttempts) {
      attempt++
      const outputPath = attempt === 1
        ? `${versionDir}/${batch.batchId}-result.md`
        : `${versionDir}/${batch.batchId}-attempt-${attempt}.md`

      let task = buildDirectFixWorkerTaskPrompt(changeId, fixResult, batch, runtimeStateDir)
      if (batch.isRecurring) {
        task += `\n## Recurrence escalation\n- This family has already survived ${batch.recurrenceCount - 1} prior review loop(s). Solve the root cause completely.\n`
      }
      if (attempt > 1 && lastResult) {
        task += buildRetryPromptSuffix(batch, attempt, lastResult.error, lastResult.outputPath)
      }

      try {
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
      } catch (error) {
        lastResult = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          outputPath,
          rawOutput: "",
        }
      }

      await ensureDispatchOutputFile(lastResult, outputPath, `${batch.batchId} attempt ${attempt}`)
      workerOutput = await readDispatchOutput(lastResult)
      workerEnvelope = parseZflowFixResultEnvelope(workerOutput)

      if (workerEnvelope) {
        break
      }
      if (lastResult.ok) {
        break
      }
    }

    await options.onBatchComplete?.(batch, lastResult!)

    const fixed: DirectFixFindingOutcome[] = []
    const unresolved: DirectFixFindingOutcome[] = []
    const checkerOutputPath = `${versionDir}/${batch.batchId}-satisfaction-check.md`
    const checkerResult = await runSatisfactionChecker(
      options,
      changeId,
      fixResult,
      batch,
      workerOutput || lastResult?.error || "",
      checkerOutputPath,
    )

    if (!checkerResult) {
      for (const finding of batch.findings) {
        unresolved.push({
          findingId: finding.findingId,
          title: finding.title,
          severity: finding.severity,
          file: finding.file,
          status: "unresolved",
          attempts: attempt,
          reason: lastResult?.error ?? "independent checker did not return a structured verdict",
          outputPath: lastResult?.outputPath ?? checkerOutputPath,
        })
      }
      return { batch, fixed, unresolved }
    }

    const handled = applyStructuredFixResults(
      batch,
      checkerResult,
      fixed,
      unresolved,
      attempt,
      checkerOutputPath,
    )

    const changedFiles = collectStructuredChangedFiles(workerEnvelope ?? checkerResult, batch)
    const shouldRunFocusedReview = batch.severity === "critical" || batch.severity === "major" || batch.isRecurring || batch.workerAgent === "zflow.implement-hard" || changedFiles.length > 1
    if (shouldRunFocusedReview && fixed.length > 0 && unresolved.length === 0) {
      const reviewResult = await runFocusedFixReview(changeId, fixResult, batch, changedFiles, cwd)
      if (!reviewResult.ok) {
        for (const finding of batch.findings) {
          fixed.splice(0, fixed.length)
          unresolved.push({
            findingId: finding.findingId,
            title: finding.title,
            severity: finding.severity,
            file: finding.file,
            status: "unresolved",
            attempts: attempt,
            reason: reviewResult.summary,
            outputPath: reviewResult.findingsPath ?? checkerOutputPath,
          })
        }
      }
    }

    for (const finding of batch.findings) {
      if (!handled.has(finding.findingId) && !fixed.find((entry) => entry.findingId === finding.findingId) && !unresolved.find((entry) => entry.findingId === finding.findingId)) {
        unresolved.push({
          findingId: finding.findingId,
          title: finding.title,
          severity: finding.severity,
          file: finding.file,
          status: "unresolved",
          attempts: attempt,
          reason: "independent checker omitted this finding",
          outputPath: checkerOutputPath,
        })
      }
    }

    return { batch, fixed, unresolved }
  }

  while (pendingFindings.length > 0 && roundsUsed < maxRounds) {
    roundsUsed++
    const batches = buildDirectFixBatches(pendingFindings, workerAgent, recurrenceByFamily)
    totalBatchCount += batches.length
    const waves = partitionBatchesIntoWaves(batches)
    const nextPending: ParsedFinding[] = []

    for (const wave of waves) {
      const waveResults = wave.length > 1
        ? await Promise.all(wave.map((batch) => runBatch(batch)))
        : [await runBatch(wave[0])]

      for (const result of waveResults) {
        for (const outcome of result.fixed) {
          fixedById.set(outcome.findingId, outcome)
          unresolvedById.delete(outcome.findingId)
        }
        for (const outcome of result.unresolved) {
          unresolvedById.set(outcome.findingId, outcome)
          const originalFinding = result.batch.findings.find((finding) => finding.findingId === outcome.findingId)
          if (originalFinding) {
            nextPending.push({
              ...originalFinding,
              recurrenceCount: Math.max(originalFinding.recurrenceCount ?? 1, result.batch.recurrenceCount + 1),
            })
          }
        }
      }
    }

    pendingFindings = nextPending
    for (const finding of pendingFindings) {
      const { familyKey } = resolveBatchFamily(finding)
      recurrenceByFamily[familyKey] = Math.max(recurrenceByFamily[familyKey] ?? 1, finding.recurrenceCount ?? 2)
    }
  }

  const fixed = [...fixedById.values()].sort((a, b) => a.findingId.localeCompare(b.findingId))
  const unresolved = pendingFindings.length > 0
    ? pendingFindings.map((finding) => unresolvedById.get(finding.findingId) ?? {
        findingId: finding.findingId,
        title: finding.title,
        severity: finding.severity,
        file: finding.file,
        status: "unresolved" as const,
        attempts: maxAttempts,
        reason: `global round budget exhausted after ${roundsUsed} round(s)`,
      })
    : [...unresolvedById.values()].sort((a, b) => a.findingId.localeCompare(b.findingId))

  const reportContent = buildDirectFixReport(changeId, fixResult, totalBatchCount, fixed, unresolved, roundsUsed)
  const reportPath = `${versionDir}/fix-orchestration-report.md`
  await fs.writeFile(reportPath, reportContent, "utf-8")
  await fs.writeFile(`${changeDir}/fix-orchestration-report.md`, reportContent, "utf-8")

  return {
    changeId,
    planVersion: fixResult.planVersion,
    reportPath,
    batchCount: totalBatchCount,
    fixed,
    unresolved,
    verificationCommand: fixResult.verificationCommand,
    globalRoundsUsed: roundsUsed,
    globalRoundsMax: maxRounds,
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
