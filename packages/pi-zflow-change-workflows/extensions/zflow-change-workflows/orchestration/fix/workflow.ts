/**
 * workflow.ts — change-audit and change-fix orchestration helpers.
 */

import {
  resolveCodeReviewFindingsPath,
  resolvePlanArtifactPath,
  resolvePlanStatePath,
  resolvePlanVersionDir,
} from "pi-zflow-artifacts/artifact-paths"

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

/**
 * Run the `/zflow-change-fix <change-path>` workflow.
 */
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

  // ── Conflict-resolution protocol ─────────────────────────────
  lines.push("## Conflict Resolution Protocol")
  lines.push("")
  lines.push("**Treat suggested approaches as advisory only.** The reviewer's")
  lines.push("\"Suggested approach\" field in each finding is a hint, not a mandate.")
  lines.push("The fix orchestrator must evaluate every suggestion against the source")
  lines.push("design documents, standards, and all other findings before accepting it.")
  lines.push("")
  lines.push("**When a suggestion would conflict with plan constraints:**")
  lines.push("")
  lines.push("1. Read the relevant sections from `design.md`, `standards.md`, and")
  lines.push("   `execution-groups.md` for the target file/area.")
  lines.push("2. Check whether the suggested approach would introduce later-phase")
  lines.push("   scope (e.g., adding a real database table in a scaffold-only phase).")
  lines.push("3. If the suggestion violates source-document constraints, choose the")
  lines.push("   **minimal compliant fix** that satisfies both the finding AND the")
  lines.push("   plan. Override the suggestion and document why in your gap report.")
  lines.push("")
  lines.push("**Placeholder/missing-file guidance:**")
  lines.push("")
  lines.push("- For findings about missing placeholder files (schema.ts, config stubs),")
  lines.push("  prefer `export {}` comment-only stubs or config-path removal/adjustment.")
  lines.push("- Do not add real schema tables, runtime behavior, or production-adjacent")
  lines.push("  scaffolding unless the source design documents explicitly require it.")
  lines.push("- When in doubt, the more minimal fix is correct.")
  lines.push("")
  lines.push("**Cross-finding consistency:**")
  lines.push("")
  lines.push("1. Before dispatching a fix worker, re-read ALL findings in this report.")
  lines.push("2. Check whether the proposed fix for one finding would create a new")
  lines.push("   violation that another finding or another reviewer would reject.")
  lines.push("3. If a tension exists, document the trade-off in the worker task and")
  lines.push("   choose the approach that satisfies the larger set of constraints.")
  lines.push("")
  lines.push("**Post-fix introduced-risk check:**")
  lines.push("")
  lines.push("After each fix worker completes, before marking a finding as FIXED:")
  lines.push("")
  lines.push("1. Read the touched files to verify they don't contain plan-forbidden")
  lines.push("   concepts (later-phase scope, runtime behavior in scaffold phases,")
  lines.push("   secrets, hard-coded production config, etc.).")
  lines.push("2. Re-read the finding's evidence and recommendation — did the fix")
  lines.push("   accidentally introduce the same problem in a different location?")
  lines.push("3. Re-read the OTHER findings in the same report — does the fix create")
  lines.push("   a new finding that another reviewer would flag?")
  lines.push("4. Only mark the finding as FIXED after the introduced-risk check passes.")
  lines.push("")

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
