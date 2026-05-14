/**
 * reread-policy.ts — Canonical artifact reread policy after compaction.
 *
 * Defines which artifacts are mandatory vs optional rereads after a compaction
 * cycle, and provides helpers for building role-specific reread reminders.
 *
 * ## Usage
 *
 * ```ts
 * import {
 *   CANONICAL_ARTIFACTS,
 *   getMandatoryRereads,
 *   getRereadsForRole,
 *   formatRereadReminder,
 * } from "./reread-policy.js"
 *
 * // Get artifacts every agent must reread
 * const mandatory = getMandatoryRereads()
 *
 * // Get role-specific artifacts
 * const forReviewer = getRereadsForRole("reviewer")
 *
 * // Format a human-readable reminder
 * const reminder = formatRereadReminder()
 * ```
 *
 * @module pi-zflow-compaction/reread-policy
 */

// ── Types ───────────────────────────────────────────────────────

/**
 * A canonical artifact entry.
 */
export interface ArtifactEntry {
  /** Unique identifier for this artifact. */
  id: string
  /** File path relative to `<runtime-state-dir>`. */
  path: string
  /** Short description for human-readable output. */
  description: string
  /** Whether every agent should reread this after compaction. */
  mandatory: boolean
}

// ── Constants ───────────────────────────────────────────────────

/**
 * All canonical artifacts that are preserved after compaction.
 *
 * These remain file-backed and should be reread explicitly
 * by agents when exact content is needed for decisions.
 */
export const CANONICAL_ARTIFACTS: readonly ArtifactEntry[] = [
  {
    id: "plan-state",
    path: "plan-state.json",
    description: "Current plan state including phase, version, and completion flags",
    mandatory: true,
  },
  {
    id: "approved-plan",
    path: "approved-plan.md",
    description: "Approved plan document with exact decisions and acceptance criteria",
    mandatory: true,
  },
  {
    id: "repo-map",
    path: "repo-map.md",
    description: "Repository structure overview with key modules and entry points",
    mandatory: true,
  },
  {
    id: "reconnaissance",
    path: "reconnaissance.md",
    description: "Codebase reconnaissance output with conventions and patterns",
    mandatory: true,
  },
  {
    id: "failure-log",
    path: "failure-log.md",
    description: "Recent failure entries with root causes and prevention recommendations",
    mandatory: true,
  },
  {
    id: "findings",
    path: "findings.md",
    description: "Review findings from code or plan review",
    mandatory: false,
  },
  {
    id: "workflow-state",
    path: "workflow-state.json",
    description: "Active workflow state including mode and reminder metadata",
    mandatory: false,
  },
] as const

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Return only the mandatory artifacts that every agent must reread
 * after compaction.
 */
export function getMandatoryRereads(): ArtifactEntry[] {
  return CANONICAL_ARTIFACTS.filter((a) => a.mandatory)
}

/**
 * Return role-specific artifact reread recommendations.
 *
 * Planner-oriented roles need plan artifacts and structure maps.
 * Reviewer roles additionally need findings files.
 * Orchestrator roles additionally need workflow state.
 * Implementation roles need the full mandatory set plus optional
 * artifacts relevant to the current task.
 *
 * @param role - The agent role name (e.g. "planner", "reviewer", "implementer").
 * @returns An array of artifact entries recommended for this role.
 */
export function getRereadsForRole(role: string): ArtifactEntry[] {
  const mandatory = getMandatoryRereads()
  const lowerRole = role.toLowerCase()

  // Base: all mandatory artifacts
  const result = [...mandatory]

  // Reviewer and synthesizer roles need findings
  if (lowerRole.includes("review") || lowerRole.includes("synthesizer")) {
    const findings = CANONICAL_ARTIFACTS.find((a) => a.id === "findings")
    if (findings) result.push(findings)
  }

  // Orchestrator roles need workflow state
  if (lowerRole.includes("orchestrat") || lowerRole.includes("change-implement")) {
    const workflowState = CANONICAL_ARTIFACTS.find((a) => a.id === "workflow-state")
    if (workflowState) result.push(workflowState)
  }

  return result
}

/**
 * Format a human-readable reread reminder string listing artifacts to read.
 *
 * @param artifacts - Artifact entries to include in the reminder.
 *   Defaults to all canonical artifacts (mandatory + optional).
 * @returns A formatted markdown string with artifact paths and descriptions.
 */
export function formatRereadReminder(
  artifacts?: ArtifactEntry[],
): string {
  const entries = artifacts ?? [...CANONICAL_ARTIFACTS]

  if (entries.length === 0) {
    return "**Reread required.** No canonical artifacts are currently tracked."
  }

  const sections: string[] = [
    "**Reread canonical artifacts before continuing.**",
  ]

  const mandatory = entries.filter((a) => a.mandatory)
  const optional = entries.filter((a) => !a.mandatory)

  if (mandatory.length > 0) {
    sections.push("")
    sections.push("**Mandatory rereads:**")
    for (const entry of mandatory) {
      sections.push(`- \`${entry.path}\` — ${entry.description}`)
    }
  }

  if (optional.length > 0) {
    sections.push("")
    sections.push("**Optional rereads (role-specific):**")
    for (const entry of optional) {
      sections.push(`- \`${entry.path}\` — ${entry.description}`)
    }
  }

  sections.push("", "The compaction summary provides orientation, but file-backed artifacts are the authoritative source for exact wording, paths, and implementation details.")

  return sections.join("\n")
}

/**
 * Build a combined compaction-handoff section suitable for injecting
 * into an agent's system prompt after a compaction cycle.
 *
 * Loads the real compaction-handoff reminder fragment if available,
 * appends the role-specific reread artifact reminder, and structures
 * the result as a single `## Compaction Handoff` section.
 *
 * @param agentName - Optional agent name for role-specific artifact selection.
 *   (e.g. "zflow.review-correctness", "builtin:scout", "zflow.implement-routine")
 * @returns A markdown-formatted compaction handoff section string.
 */
export async function buildCompactionHandoffSection(
  agentName?: string,
): Promise<string> {
  const parts: string[] = ["## Compaction Handoff"]

  // Try to load the enhanced reminder fragment from pi-zflow-agents
  try {
    const { loadFragment } = await import("pi-zflow-agents")
    const fragmentContent = await loadFragment("compaction-handoff")
    parts.push("", fragmentContent.trim())
  } catch {
    // Graceful fallback if pi-zflow-agents or fragment is unavailable
    parts.push(
      "",
      "A compaction cycle has completed. Do not rely on cached or summarised state from before compaction.",
    )
  }

  // Append role-specific artifact reread section
  let role: string | undefined
  if (agentName) {
    if (agentName.includes("review") || agentName.includes("synthesizer")) role = "reviewer"
    else if (agentName.includes("orchestrat") || agentName.includes("change-implement")) role = "orchestrator"
    else if (agentName.includes("planner")) role = "planner"
  }

  const artifacts = role ? getRereadsForRole(role) : [...CANONICAL_ARTIFACTS]
  const reminderBody = formatRereadReminder(artifacts)

  parts.push("", reminderBody)

  return parts.join("\n")
}
