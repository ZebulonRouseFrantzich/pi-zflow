/**
 * findings.ts — review finding parsing and fix-plan generation.
 */

/**
 * A single finding parsed from the code-review-findings.md file.
 */
export interface ParsedFinding {
  /** Stable identifier like "finding-1", "finding-2". */
  findingId: string
  /** Severity level. */
  severity: "critical" | "major" | "minor" | "nit"
  /** Short title of the finding. */
  title: string
  /** Source file path, if available. */
  file?: string
  /** Source line number, if available. */
  line?: number
  /** Reviewer role that identified this finding. */
  reviewerRole: string
  /** Detailed evidence from the reviewer. */
  evidence: string
  /** Recommendation for fixing the issue. */
  recommendation: string
  /** Path to the raw reviewer artifact for traceability. */
  artifactPath?: string
  /** Why the finding matters. */
  whyItMatters?: string
  /** What the code SHOULD do instead (enriched field for fix orchestrator). */
  expectedBehavior?: string
  /** Concrete things a fix must accomplish (enriched field for fix orchestrator). */
  fixRequirements?: string
  /** How to verify the fix works (enriched field for fix orchestrator). */
  validation?: string
  /** Optional hint for the fix worker (enriched field for fix orchestrator). */
  suggestedApproach?: string
}

/**
 * Parse review findings from the canonical code-review-findings.md file.
 */
export async function parseReviewFindings(
  cwd?: string,
): Promise<{
  findings: ParsedFinding[]
  rawPath: string
  rawContent: string
}> {
  const { default: fs } = await import("node:fs/promises")
  const { resolveCodeReviewFindingsPath } = await import("pi-zflow-artifacts/artifact-paths")

  const rawPath = resolveCodeReviewFindingsPath(cwd)
  let rawContent: string

  try {
    rawContent = await fs.readFile(rawPath, "utf-8")
  } catch {
    rawContent = ""
  }

  if (!rawContent || rawContent.trim().length === 0) {
    return { findings: [], rawPath, rawContent: "" }
  }

  const findings: ParsedFinding[] = []
  let findingCounter = 0
  const blocks = rawContent.split(/(?=^### )/m).filter(Boolean)

  for (const block of blocks) {
    const headingMatch = block.match(/^### (.+)$/m)
    if (!headingMatch) continue

    const title = headingMatch[1].trim()
    if (/^(Critical|Major|Minor|Nit|None)[\s.:]|^None\.$/i.test(title)) continue
    if (/^(Coverage|Reviewed|Verification|Findings Summary)/i.test(title)) continue

    if (/^(Reviewed (the |scope: )|I reviewed |Security review scope)/i.test(title)) {
      const firstEvidenceLine = block.split("\n").find((l) => /^\*\*Evidence\*\*:/i.test(l))?.replace(/^\*\*Evidence\*\*:\s*/i, "").trim() ?? ""
      const normalizedTitle = title.toLowerCase().replace(/\s+/g, " ")
      const normalizedEvidence = firstEvidenceLine.toLowerCase().replace(/\s+/g, " ")
      if (normalizedTitle === normalizedEvidence || normalizedEvidence.includes(normalizedTitle.substring(0, 30))) {
        continue
      }
    }

    findingCounter++
    const findingId = `finding-${findingCounter}`

    let severity: ParsedFinding["severity"] = "minor"
    const sectionBefores = rawContent.slice(0, rawContent.indexOf(block)).split("\n").filter(Boolean)
    const lastSectionHeading = sectionBefores.reverse().find((l) => /^## (Critical|Major|Minor)(?: Findings?)?$|^## Nits?$/i.test(l))
    if (lastSectionHeading) {
      const sev = lastSectionHeading.replace(/^## /i, "").replace(/ Findings?$/i, "").trim().toLowerCase()
      if (sev === "critical") severity = "critical"
      else if (sev === "major") severity = "major"
      else if (sev === "minor") severity = "minor"
      else if (/^nit/i.test(sev)) severity = "nit"
    }

    const fileMatch = block.match(/\*\*File\*\*:\s*`?([^`\n]+)`?/i)
    const lineMatch = block.match(/\*\*Lines?\*\*:\s*(\d+)/i)
    const supportMatch = block.match(/\*\*Reviewer support\*\*:\s*(.+)$/im)
    const evidenceBlockMatch = block.match(/\*\*Evidence\*\*:\s*([\s\S]+?)(?=\n\*\*[^*\n]+\*\*|\n\*\*$|$)/i)
    const evidenceMulti = evidenceBlockMatch ? evidenceBlockMatch[1].trim() : ""
    const whyBlockMatch = block.match(/\*\*Why it matters\*\*:\s*([\s\S]+?)(?=\n\*\*[^*\n]+\*\*|\n\*\*$|$)/i)
    const whyMulti = whyBlockMatch ? whyBlockMatch[1].trim() : ""
    const recBlockMatch = block.match(/\*\*Recommendation\*\*:\s*([\s\S]+?)(?=\n\*\*[^*\n]+\*\*|\n\*\*$|$)/i)
    const recMulti = recBlockMatch ? recBlockMatch[1].trim() : ""
    const evidenceLineMatch = block.match(/\*\*Evidence\*\*:\s*(.+)$/im)
    const whyLineMatch = block.match(/\*\*Why it matters\*\*:\s*(.+)$/im)
    const recLineMatch = block.match(/\*\*Recommendation\*\*:\s*(.+)$/im)
    const artifactMatch = block.match(/\*\*Artifact[^:]*\*\*:\s*`?([^`\n]+)`?/i)
    const expectedBehaviorMatch = block.match(/\*\*Expected behavior\*\*:\s*(.+)$/im)
    const fixRequirementsMatch = block.match(/\*\*Fix requirements\*\*:\s*(.+)$/im)
    const validationMatch = block.match(/\*\*Validation\*\*:\s*(.+)$/im)
    const suggestedApproachMatch = block.match(/\*\*Suggested approach\*\*:\s*(.+)$/im)

    const evidence = evidenceMulti || (evidenceLineMatch ? evidenceLineMatch[1].trim() : "")
    const recommendation = recMulti || (recLineMatch ? recLineMatch[1].trim() : "")
    const whyItMatters = whyMulti || (whyLineMatch ? whyLineMatch[1].trim() : "")

    findings.push({
      findingId,
      severity,
      title,
      file: fileMatch ? fileMatch[1].trim() : undefined,
      line: lineMatch ? Number.parseInt(lineMatch[1], 10) : undefined,
      reviewerRole: supportMatch ? supportMatch[1].trim() : "reviewer",
      evidence: evidence || (block.split("\n").slice(1, 4).join(" ").trim().slice(0, 300) || title),
      recommendation: recommendation || "Review the finding and apply appropriate fix.",
      artifactPath: artifactMatch ? artifactMatch[1].trim() : undefined,
      whyItMatters: whyItMatters || undefined,
      expectedBehavior: expectedBehaviorMatch ? expectedBehaviorMatch[1].trim() : undefined,
      fixRequirements: fixRequirementsMatch ? fixRequirementsMatch[1].trim() : undefined,
      validation: validationMatch ? validationMatch[1].trim() : undefined,
      suggestedApproach: suggestedApproachMatch ? suggestedApproachMatch[1].trim() : undefined,
    })
  }

  return { findings, rawPath, rawContent }
}

/**
 * Build a structured JSON interview question payload for the fix selection gate.
 */
export function buildFixSelectionQuestions(
  changeId: string,
  findings: ParsedFinding[],
): string {
  const critical = findings.filter((f) => f.severity === "critical").length
  const major = findings.filter((f) => f.severity === "major").length
  const minor = findings.filter((f) => f.severity === "minor").length
  const nit = findings.filter((f) => f.severity === "nit").length

  const findingOptions = findings.map((f) => ({
    label: `[${f.severity.toUpperCase()}] ${f.findingId}: ${f.title.slice(0, 80)}${f.file ? ` (${f.file})` : ""}`,
    content: `${f.severity.toUpperCase()}: ${f.title}${f.file ? `\nFile: ${f.file}` : ""}${f.line ? `:${f.line}` : ""}\nEvidence: ${f.evidence.slice(0, 200)}`,
  }))

  const summaryParts: string[] = []
  if (critical > 0) summaryParts.push(`${critical} critical`)
  if (major > 0) summaryParts.push(`${major} major`)
  if (minor > 0) summaryParts.push(`${minor} minor`)
  if (nit > 0) summaryParts.push(`${nit} nits`)

  const summary = summaryParts.length > 0
    ? `${findings.length} total — ${summaryParts.join(", ")}`
    : "No findings"

  return JSON.stringify({
    title: `Fix Selection — ${changeId}`,
    description: `Found ${summary} for change "${changeId}".\n\nHow would you like to proceed?`,
    questions: [
      {
        id: "action",
        type: "single",
        question: "Which fixes would you like to apply?",
        options: [
          {
            label: "Fix All Findings",
            content: "Apply fixes for all findings.",
            recommended: true,
          },
          ...(findingOptions.length > 1
            ? [{
                label: "Select Findings to Fix",
                content: "Choose which specific findings to fix.",
              }]
            : []),
          {
            label: "Cancel",
            content: "Cancel — no fixes applied.",
          },
        ],
        recommended: "Fix All Findings",
      },
      {
        id: "selectedFindings",
        type: "multi",
        question: "Select which findings to fix:",
        options: findingOptions,
        condition: { field: "action", value: "Select Findings to Fix" },
      },
    ],
  })
}

/**
 * Build a markdown fix plan document from selected findings.
 */
export async function buildFixPlan(
  changeId: string,
  selectedFindings: ParsedFinding[],
  cwd?: string,
): Promise<string> {
  const critical = selectedFindings.filter((f) => f.severity === "critical").length
  const major = selectedFindings.filter((f) => f.severity === "major").length
  const minor = selectedFindings.filter((f) => f.severity === "minor").length
  const nit = selectedFindings.filter((f) => f.severity === "nit").length

  const targetFiles = [...new Set(selectedFindings.filter((f) => f.file).map((f) => f.file!))].sort()

  const lines: string[] = [
    `# Fix Plan for ${changeId}`,
    "",
    `**Generated:** ${new Date().toISOString()}`,
    `**Findings to fix:** ${selectedFindings.length} (${critical}/${major}/${minor}/${nit})`,
    "",
    "## Findings",
    "",
  ]

  for (const finding of selectedFindings) {
    lines.push(`### ${finding.findingId}: ${finding.title}`)
    lines.push(`**Severity:** ${finding.severity}`)
    if (finding.file) lines.push(`**File:** \`${finding.file}\`${finding.line ? ` (line ${finding.line})` : ""}`)
    if (finding.reviewerRole) lines.push(`**Reviewer:** ${finding.reviewerRole}`)
    if (finding.evidence) lines.push(`**Evidence:** ${finding.evidence}`)
    if (finding.recommendation) lines.push(`**Recommendation:** ${finding.recommendation}`)
    if (finding.artifactPath) lines.push(`**Artifact:** \`${finding.artifactPath}\``)
    if (finding.whyItMatters) lines.push(`**Why it matters:** ${finding.whyItMatters}`)
    lines.push("")
  }

  lines.push("## Fix Strategy")
  lines.push("")
  lines.push("- Each finding will be assigned to a fix worker.")
  lines.push("- Workers must read the full finding evidence before fixing.")
  lines.push("- After each fix, verification will confirm the fix resolved the issue.")
  lines.push("- Max 2 attempts per finding, 3 global rounds.")
  lines.push("")

  if (targetFiles.length > 0) {
    lines.push("## Target Files")
    lines.push("")
    for (const file of targetFiles) {
      lines.push(`- \`${file}\``)
    }
    lines.push("")
  }

  return lines.join("\n")
}
