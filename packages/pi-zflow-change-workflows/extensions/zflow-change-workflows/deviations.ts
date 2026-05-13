/**
 * deviations.ts — Plan Drift Protocol implementation.
 *
 * Provides structured deviation reporting and summary synthesis when
 * an approved plan is found to be infeasible during implementation.
 *
 * ## Design
 *
 * - Workers stop making source edits upon detecting drift.
 * - Workers write a deviation report to a structured path.
 * - Deviation reports are synthesized into a summary artifact for replanning.
 * - All paths use `<runtime-state-dir>/plans/{changeId}/deviations/{planVersion}/`.
 *
 * @module pi-zflow-change-workflows/deviations
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import { resolveDeviationDir } from "pi-zflow-artifacts/artifact-paths"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The current status of a deviation report.
 */
export type DeviationStatus = "open" | "resolved" | "superseded"

/**
 * A single deviation report filed by a worker.
 */
export interface DeviationReport {
  /** Change ID that this deviation relates to. */
  changeId: string
  /** Plan version that the deviation references. */
  planVersion: string
  /** Group identifier. */
  group: string
  /** Worker agent name. */
  reportedBy: string
  /** Current status. */
  status: DeviationStatus
  /** The specific instruction from the plan that was infeasible. */
  infeasibleInstruction: string
  /** The actual code structure found. */
  actualStructure: string
  /** What blocks the plan from being followed. */
  blockingConflict: string
  /** Suggested minimal amendment to the plan. */
  suggestedAmendment: string
  /** Files that were inspected. */
  filesInspected: string[]
  /** Files that were affected (modified) before drift was detected. */
  filesAffected: string[]
  /** Whether local edits were reverted. */
  localEditsReverted: boolean
  /** ISO timestamp when the report was created. */
  createdAt: string
}

/**
 * A synthesized summary of multiple deviation reports.
 */
export interface DeviationSummary {
  /** Run ID that produced these deviations. */
  runId: string
  /** Change ID. */
  changeId: string
  /** Plan version. */
  planVersion: string
  /** Groups that filed deviations. */
  affectedGroups: string[]
  /** Common root causes identified across reports. */
  commonRootCauses: string[]
  /** Whether local edits were retained anywhere. */
  editsRetained: boolean
  /** Proposed minimal plan amendments. */
  proposedAmendments: string[]
  /** Recommendation for next action. */
  recommendation: "replan" | "cancel" | "inspect"
  /** ISO timestamp when the summary was created. */
  createdAt: string
}

// ---------------------------------------------------------------------------
// Deviation report operations
// ---------------------------------------------------------------------------

/**
 * Build the file path for a single deviation report.
 *
 * Path: `<runtime-state-dir>/plans/{changeId}/deviations/{planVersion}/{group}-{worker}.md`
 */
export function resolveDeviationReportPath(
  changeId: string,
  planVersion: string,
  group: string,
  worker: string,
  cwd?: string,
): string {
  const dir = resolveDeviationDir(changeId, planVersion, cwd)
  return path.join(dir, `${group}-${worker}.md`)
}

/**
 * Build the file path for the deviation summary.
 *
 * Path: `<runtime-state-dir>/plans/{changeId}/deviations/{planVersion}/deviation-summary.md`
 */
export function resolveDeviationSummaryPath(
  changeId: string,
  planVersion: string,
  cwd?: string,
): string {
  const dir = resolveDeviationDir(changeId, planVersion, cwd)
  return path.join(dir, "deviation-summary.md")
}

/**
 * Format a deviation report as markdown for file storage.
 */
export function formatDeviationReport(report: DeviationReport): string {
  const lines: string[] = [
    "# Deviation Report",
    "",
    `**Change ID**: ${report.changeId}`,
    `**Plan Version**: ${report.planVersion}`,
    `**Group**: ${report.group}`,
    `**Reported by**: ${report.reportedBy}`,
    `**Status**: ${report.status}`,
    `**Created**: ${report.createdAt}`,
    "",
    "## What was planned",
    "",
    report.infeasibleInstruction,
    "",
    "## What was found",
    "",
    report.actualStructure,
    "",
    "## Impact",
    "",
    report.blockingConflict,
    "",
    "## Proposed resolution",
    "",
    report.suggestedAmendment,
    "",
    "## Files inspected",
    "",
    ...report.filesInspected.map((f) => `- ${f}`),
    "",
    "## Files affected",
    "",
    ...(report.filesAffected.length > 0
      ? report.filesAffected.map((f) => `- ${f}`)
      : ["(none)"]),
    "",
    "## Local edits reverted",
    "",
    report.localEditsReverted ? "Yes" : "No",
  ]

  return lines.join("\n")
}

/**
 * Write a deviation report to disk.
 *
 * Creates the deviations directory if it does not exist.
 *
 * @param report - The deviation report to persist.
 * @param cwd - Working directory for runtime state resolution.
 */
export async function writeDeviationReport(
  report: DeviationReport,
  cwd?: string,
): Promise<string> {
  const filePath = resolveDeviationReportPath(
    report.changeId,
    report.planVersion,
    report.group,
    report.reportedBy,
    cwd,
  )

  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, formatDeviationReport(report), "utf-8")

  return filePath
}

/**
 * Read all deviation reports for a given plan version.
 *
 * Scans the deviations directory and returns parsed reports.
 *
 * @param changeId - Change ID.
 * @param planVersion - Plan version.
 * @param cwd - Working directory.
 * @returns Array of parsed deviation reports.
 */
export async function readDeviationReports(
  changeId: string,
  planVersion: string,
  cwd?: string,
): Promise<DeviationReport[]> {
  const dir = resolveDeviationDir(changeId, planVersion, cwd)

  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    // Directory does not exist — no deviations
    return []
  }

  const reports: DeviationReport[] = []
  for (const entry of entries) {
    if (entry === "deviation-summary.md") continue
    if (!entry.endsWith(".md")) continue

    const filePath = path.join(dir, entry)
    const content = await fs.readFile(filePath, "utf-8")
    const report = parseDeviationReport(content, changeId, planVersion)
    if (report) {
      reports.push(report)
    }
  }

  return reports
}

// ---------------------------------------------------------------------------
// Deviation summary synthesis
// ---------------------------------------------------------------------------

/**
 * Synthesize multiple deviation reports into a summary artifact.
 *
 * Extracts common root causes and generates a recommendation.
 *
 * @param runId - The run ID that produced these deviations.
 * @param changeId - Change ID.
 * @param planVersion - Plan version.
 * @param reports - Array of deviation reports to synthesize.
 * @returns A synthesized deviation summary.
 */
export function synthesizeDeviationSummary(
  runId: string,
  changeId: string,
  planVersion: string,
  reports: DeviationReport[],
): DeviationSummary {
  const affectedGroups = [...new Set(reports.map((r) => r.group))]
  const editsRetained = reports.some((r) => !r.localEditsReverted)

  // Extract common themes from suggested amendments
  const commonRootCauses = extractCommonRootCauses(reports)
  const proposedAmendments = reports.map((r) => r.suggestedAmendment)

  // Determine recommendation
  const recommendation = determineRecommendation(reports)

  return {
    runId,
    changeId,
    planVersion,
    affectedGroups,
    commonRootCauses,
    editsRetained,
    proposedAmendments: [...new Set(proposedAmendments)],
    recommendation,
    createdAt: new Date().toISOString(),
  }
}

/**
 * Write a deviation summary to disk.
 *
 * @param summary - The synthesized summary.
 * @param cwd - Working directory.
 * @returns The file path written to.
 */
export async function writeDeviationSummary(
  summary: DeviationSummary,
  cwd?: string,
): Promise<string> {
  const filePath = resolveDeviationSummaryPath(
    summary.changeId,
    summary.planVersion,
    cwd,
  )

  const content = formatDeviationSummary(summary)

  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, "utf-8")

  return filePath
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse a markdown deviation report back into a DeviationReport struct.
 *
 * This is a best-effort parser that extracts known fields from the
 * markdown structure.
 */
function parseDeviationReport(
  content: string,
  changeId: string,
  planVersion: string,
): DeviationReport | null {
  const lines = content.split("\n")
  let group = ""
  let reportedBy = ""
  let status: DeviationStatus = "open"
  let infeasibleInstruction = ""
  let actualStructure = ""
  let blockingConflict = ""
  let suggestedAmendment = ""
  let localEditsReverted = true
  let createdAt = ""
  const filesInspected: string[] = []
  const filesAffected: string[] = []

  let section: string | null = null

  for (const line of lines) {
    if (line.startsWith("**Group**:")) {
      group = line.slice("**Group**:".length).trim()
    } else if (line.startsWith("**Reported by**:")) {
      reportedBy = line.slice("**Reported by**:".length).trim()
    } else if (line.startsWith("**Status**:")) {
      const raw = line.slice("**Status**:".length).trim().toLowerCase()
      if (raw === "resolved") status = "resolved"
      else if (raw === "superseded") status = "superseded"
      else status = "open"
    } else if (line.startsWith("**Created**:")) {
      createdAt = line.slice("**Created**:".length).trim()
    } else if (line === "## What was planned") {
      section = "planned"
    } else if (line === "## What was found") {
      section = "found"
    } else if (line === "## Impact") {
      section = "impact"
    } else if (line === "## Proposed resolution") {
      section = "resolution"
    } else if (line === "## Files inspected") {
      section = "inspected"
    } else if (line === "## Files affected") {
      section = "affected"
    } else if (line === "## Local edits reverted") {
      section = "reverted"
    } else if (line.startsWith("## ")) {
      section = null
    } else if (section === "planned") {
      infeasibleInstruction += (infeasibleInstruction ? "\n" : "") + line
    } else if (section === "found") {
      actualStructure += (actualStructure ? "\n" : "") + line
    } else if (section === "impact") {
      blockingConflict += (blockingConflict ? "\n" : "") + line
    } else if (section === "resolution") {
      suggestedAmendment += (suggestedAmendment ? "\n" : "") + line
    } else if (section === "inspected" && line.startsWith("- ")) {
      filesInspected.push(line.slice(2))
    } else if (section === "affected" && line.startsWith("- ")) {
      const val = line.slice(2)
      if (val !== "(none)") filesAffected.push(val)
    } else if (section === "reverted" && line.trim().toLowerCase() === "no") {
      localEditsReverted = false
    }
  }

  if (!group || !reportedBy) return null

  return {
    changeId,
    planVersion,
    group,
    reportedBy,
    status,
    infeasibleInstruction: infeasibleInstruction.trim(),
    actualStructure: actualStructure.trim(),
    blockingConflict: blockingConflict.trim(),
    suggestedAmendment: suggestedAmendment.trim(),
    filesInspected,
    filesAffected,
    localEditsReverted,
    createdAt,
  }
}

/**
 * Format a DeviationSummary as markdown.
 */
function formatDeviationSummary(summary: DeviationSummary): string {
  const lines: string[] = [
    "# Deviation Summary",
    "",
    `**Run ID**: ${summary.runId}`,
    `**Change ID**: ${summary.changeId}`,
    `**Plan Version**: ${summary.planVersion}`,
    `**Created**: ${summary.createdAt}`,
    "",
    "## Affected groups",
    "",
    ...summary.affectedGroups.map((g) => `- ${g}`),
    "",
    "## Common root causes",
    "",
    ...(summary.commonRootCauses.length > 0
      ? summary.commonRootCauses.map((c) => `- ${c}`)
      : ["(none identified)"]),
    "",
    "## Local edits retained",
    "",
    summary.editsRetained ? "Yes — inspect retained artifacts before cleanup" : "No",
    "",
    "## Proposed plan amendments",
    "",
    ...summary.proposedAmendments.map((a) => `- ${a}`),
    "",
    "## Recommendation",
    "",
    summary.recommendation === "replan"
      ? "**Replan**: Create a new plan version incorporating these amendments."
      : summary.recommendation === "cancel"
        ? "**Cancel**: Abandon this change and inspect retained artifacts."
        : "**Inspect**: Review retained artifacts before deciding next steps.",
  ]

  return lines.join("\n")
}

/**
 * Extract common root causes from deviation reports.
 */
function extractCommonRootCauses(reports: DeviationReport[]): string[] {
  const causes: string[] = []

  // Check for common patterns across reports
  const hasModuleBoundaryIssues = reports.some(
    (r) =>
      r.blockingConflict.includes("module") ||
      r.blockingConflict.includes("boundary") ||
      r.blockingConflict.includes("file"),
  )
  const hasMissingDependency = reports.some(
    (r) =>
      r.blockingConflict.includes("depend") ||
      r.blockingConflict.includes("missing"),
  )
  const hasApiMismatch = reports.some(
    (r) =>
      r.blockingConflict.includes("API") ||
      r.blockingConflict.includes("interface") ||
      r.blockingConflict.includes("signature"),
  )
  const hasStructuralDrift = reports.some(
    (r) =>
      r.blockingConflict.includes("does not exist") ||
      r.blockingConflict.includes("not found"),
  )

  if (hasModuleBoundaryIssues) {
    causes.push("Plan targets incorrect module boundaries or file paths")
  }
  if (hasMissingDependency) {
    causes.push("Missing or incompatible dependencies not accounted for in plan")
  }
  if (hasApiMismatch) {
    causes.push("API or interface signatures differ from plan assumptions")
  }
  if (hasStructuralDrift) {
    causes.push("Actual code structure differs from plan's assumptions")
  }

  if (causes.length === 0) {
    causes.push("Plan infeasibility due to unanticipated codebase state")
  }

  return causes
}

/**
 * Determine the best recommendation based on deviation reports.
 */
export function determineRecommendation(
  reports: DeviationReport[],
): "replan" | "cancel" | "inspect" {
  if (reports.length === 0) return "inspect"

  // If any report has edits that were NOT reverted, suggest inspect
  if (reports.some((r) => !r.localEditsReverted)) {
    return "inspect"
  }

  // If all edits were reverted, recommend replan
  return "replan"
}
