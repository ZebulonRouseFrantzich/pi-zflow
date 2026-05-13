/**
 * output-conventions.ts — Subagent output handling and artifact persistence conventions.
 *
 * Standardises how report-style agents return structured output and how
 * the orchestrator persists artifacts. Report-style agents return structured
 * markdown; implementation agents may edit/write files in their assigned
 * worktrees.
 *
 * ## Design rules from the master plan
 *
 * - Agents return structured markdown or structured summaries.
 * - The orchestrator persists outputs into runtime-state files or uses
 *   `pi-subagents` artifact directories.
 * - Implementation agents may edit/write in their assigned worktrees.
 * - Report-style agents should NOT get raw `write`.
 * - Output-vs-persistence responsibilities are explicit.
 * - Report-style prompts remind agents to return structured output and
 *   rely on orchestrator persistence rather than writing files.
 *
 * ## Agent role classification
 *
 * ### Report agents (return structured markdown, do not write files)
 * - scout (builtin)
 * - repo-mapper
 * - verifier
 * - review-* agents (correctness, integration, security, logic, system)
 * - plan-review-* agents (correctness, integration, feasibility)
 * - plan-validator
 * - synthesizer
 *
 * ### Implementation agents (may edit/write in their assigned worktrees)
 * - implement-routine
 * - implement-hard
 *
 * ### Hybrid agents (write through restricted tool channels)
 * - planner-frontier (writes plan artifacts via zflow_write_plan_artifact only)
 *
 * @module pi-zflow-agents/output-conventions
 */

// ── Agent role classification ───────────────────────────────────

/**
 * The role an agent plays in terms of output and persistence.
 *
 * - `"report"`: Agent returns structured markdown or summaries. The
 *   orchestrator persists the output. The agent must not use `edit`
 *   or `write` tools.
 * - `"implementation"`: Agent edits/writes files in its assigned
 *   worktree. Output is the filesystem state after changes.
 * - `"hybrid"`: Agent writes through restricted tool channels (e.g.,
 *   planner-frontier via `zflow_write_plan_artifact`). It has write
 *   capability but only through a narrowly scoped tool, not raw
 *   `edit`/`write`.
 */
export type AgentRole = "report" | "implementation" | "hybrid"

/**
 * Structured description of an agent's output convention.
 */
export interface OutputConvention {
  /** The agent runtime name (e.g. "zflow.verifier"). */
  agent: string
  /** Role classification. */
  role: AgentRole
  /**
   * The format the agent should return its output in.
   * - `"structured-markdown"`: Findings, reports, or summaries with
   *   consistent headings, severity, and sections.
   * - `"file-changes"`: The agent writes files in the worktree.
   * - `"plan-artifact"`: The agent writes plan artifacts through a
   *   restricted write tool (zflow_write_plan_artifact).
   */
  outputFormat: "structured-markdown" | "file-changes" | "plan-artifact"
  /**
   * Whether the agent is expected to produce a file or artifact.
   * When true, the orchestrator persists the output.
   */
  persistsOutput: boolean
  /**
   * Brief description of what the agent produces.
   */
  description: string
}

// ── Agent sets ──────────────────────────────────────────────────

/**
 * Agents that produce structured markdown reports and rely on the
 * orchestrator for persistence. These agents must NOT use raw `edit`
 * or `write` tools.
 */
export const REPORT_AGENTS: ReadonlySet<string> = new Set([
  "builtin:scout",
  "builtin:context-builder",
  "zflow.repo-mapper",
  "zflow.verifier",
  "zflow.review-correctness",
  "zflow.review-integration",
  "zflow.review-security",
  "zflow.review-logic",
  "zflow.review-system",
  "zflow.plan-review-correctness",
  "zflow.plan-review-integration",
  "zflow.plan-review-feasibility",
  "zflow.plan-validator",
  "zflow.synthesizer",
])

/**
 * Agents that may edit/write files in their assigned worktrees.
 * These agents have `edit` and `write` tools available and their
 * primary output is the changed filesystem state.
 */
export const IMPLEMENTATION_AGENTS: ReadonlySet<string> = new Set([
  "zflow.implement-routine",
  "zflow.implement-hard",
])

/**
 * Agents that write through restricted tool channels (not raw
 * `edit`/`write`). Currently only planner-frontier, which writes
 * plan artifacts via `zflow_write_plan_artifact`.
 */
export const HYBRID_AGENTS: ReadonlySet<string> = new Set([
  "zflow.planner-frontier",
])

// ── Output convention definitions ───────────────────────────────

/**
 * Complete per-agent output conventions.
 *
 * Every agent known to pi-zflow is listed here with its role, format,
 * and persistence behaviour. The orchestrator and prompt assembly
 * use this to determine how to handle each agent's output.
 */
export const OUTPUT_CONVENTIONS: Record<string, OutputConvention> = {
  // Report-style agents
  "builtin:scout": {
    agent: "builtin:scout",
    role: "report",
    outputFormat: "structured-markdown",
    persistsOutput: true,
    description: "Reconnaissance context handoff with affected files, patterns, and constraints",
  },
  "builtin:context-builder": {
    agent: "builtin:context-builder",
    role: "report",
    outputFormat: "structured-markdown",
    persistsOutput: true,
    description: "Analogical code examples with signatures, snippets, and API patterns for worker preparation",
  },
  "zflow.repo-mapper": {
    agent: "zflow.repo-mapper",
    role: "report",
    outputFormat: "structured-markdown",
    persistsOutput: true,
    description: "Tree-structured repository map with file annotations",
  },
  "zflow.verifier": {
    agent: "zflow.verifier",
    role: "report",
    outputFormat: "structured-markdown",
    persistsOutput: true,
    description: "Structured verification report with pass/fail per step",
  },
  "zflow.review-correctness": {
    agent: "zflow.review-correctness",
    role: "report",
    outputFormat: "structured-markdown",
    persistsOutput: true,
    description: "Correctness findings with severity, file, line, impact, suggestion",
  },
  "zflow.review-integration": {
    agent: "zflow.review-integration",
    role: "report",
    outputFormat: "structured-markdown",
    persistsOutput: true,
    description: "Integration findings with severity, file, line, impact, suggestion",
  },
  "zflow.review-security": {
    agent: "zflow.review-security",
    role: "report",
    outputFormat: "structured-markdown",
    persistsOutput: true,
    description: "Security findings with severity, file, line, CVSS-like impact, suggestion",
  },
  "zflow.review-logic": {
    agent: "zflow.review-logic",
    role: "report",
    outputFormat: "structured-markdown",
    persistsOutput: true,
    description: "Algorithmic soundness findings with severity, file, line, example input",
  },
  "zflow.review-system": {
    agent: "zflow.review-system",
    role: "report",
    outputFormat: "structured-markdown",
    persistsOutput: true,
    description: "System-level findings with severity, file, line, performance impact estimate",
  },
  "zflow.plan-review-correctness": {
    agent: "zflow.plan-review-correctness",
    role: "report",
    outputFormat: "structured-markdown",
    persistsOutput: true,
    description: "Plan correctness findings with artifact reference, impact, suggestion",
  },
  "zflow.plan-review-integration": {
    agent: "zflow.plan-review-integration",
    role: "report",
    outputFormat: "structured-markdown",
    persistsOutput: true,
    description: "Plan integration findings with artifact reference, affected modules, suggestion",
  },
  "zflow.plan-review-feasibility": {
    agent: "zflow.plan-review-feasibility",
    role: "report",
    outputFormat: "structured-markdown",
    persistsOutput: true,
    description: "Plan feasibility findings with artifact reference, evidence, suggestion",
  },
  "zflow.plan-validator": {
    agent: "zflow.plan-validator",
    role: "report",
    outputFormat: "structured-markdown",
    persistsOutput: true,
    description: "Structured validation report (PASS/FAIL/CONDITIONAL-PASS) with per-check results",
  },
  "zflow.synthesizer": {
    agent: "zflow.synthesizer",
    role: "report",
    outputFormat: "structured-markdown",
    persistsOutput: true,
    description: "Consolidated review report with deduplicated findings, coverage notes, go/no-go",
  },
  // Implementation agents
  "zflow.implement-routine": {
    agent: "zflow.implement-routine",
    role: "implementation",
    outputFormat: "file-changes",
    persistsOutput: false,
    description: "File edits in assigned worktree; reports done/pass/fail summary",
  },
  "zflow.implement-hard": {
    agent: "zflow.implement-hard",
    role: "implementation",
    outputFormat: "file-changes",
    persistsOutput: false,
    description: "File edits in assigned worktree; reports done/pass/fail with subagent contributions",
  },
  // Hybrid agents
  "zflow.planner-frontier": {
    agent: "zflow.planner-frontier",
    role: "hybrid",
    outputFormat: "plan-artifact",
    persistsOutput: true,
    description: "Plan artifacts written via zflow_write_plan_artifact (design, execution-groups, standards, verification)",
  },
}

// ── Agent information helpers ───────────────────────────────────

/**
 * All known agents in the pi-zflow system.
 */
export const ALL_AGENTS: ReadonlySet<string> = new Set([
  ...REPORT_AGENTS,
  ...IMPLEMENTATION_AGENTS,
  ...HYBRID_AGENTS,
])

/**
 * Classify an agent by its output role.
 *
 * @param agentName - The agent runtime name (e.g. "zflow.verifier").
 * @returns The agent's role classification.
 * @throws If the agent name is not recognised.
 */
export function getAgentRole(agentName: string): AgentRole {
  if (REPORT_AGENTS.has(agentName)) return "report"
  if (IMPLEMENTATION_AGENTS.has(agentName)) return "implementation"
  if (HYBRID_AGENTS.has(agentName)) return "hybrid"
  throw new Error(`Unknown agent: "${agentName}". No output convention registered.`)
}

/**
 * Get the output convention for a known agent.
 *
 * @param agentName - The agent runtime name.
 * @returns The output convention for the agent.
 * @throws If the agent name is not recognised.
 */
export function getOutputConvention(agentName: string): OutputConvention {
  const convention = OUTPUT_CONVENTIONS[agentName]
  if (!convention) {
    throw new Error(
      `Unknown agent: "${agentName}". ` +
        "Register a convention in OUTPUT_CONVENTIONS or use isKnownAgent() to check first.",
    )
  }
  return convention
}

/**
 * Check whether an agent name is known to the output conventions system.
 *
 * @param agentName - The agent runtime name.
 * @returns True if the agent has a registered output convention.
 */
export function isKnownAgent(agentName: string): boolean {
  return ALL_AGENTS.has(agentName)
}

/**
 * Get all report-style agent names.
 *
 * @returns An array of agent names classified as report-style.
 */
export function getReportAgents(): string[] {
  return [...REPORT_AGENTS].sort()
}

/**
 * Get all implementation agent names.
 *
 * @returns An array of agent names classified as implementation-style.
 */
export function getImplementationAgents(): string[] {
  return [...IMPLEMENTATION_AGENTS].sort()
}

/**
 * Get all hybrid agent names.
 *
 * @returns An array of agent names classified as hybrid.
 */
export function getHybridAgents(): string[] {
  return [...HYBRID_AGENTS].sort()
}

// ── Output instruction generation ───────────────────────────────

/**
 * Generate output convention instructions for a given agent.
 *
 * These instructions are designed to be appended to the agent's prompt
 * as a reminder of how to handle output and persistence. They reinforce
 * the separation between reporting (structured markdown, no file writes)
 * and implementation (file edits allowed).
 *
 * @param agentName - The agent runtime name.
 * @returns A string of output convention instructions suitable for inclusion
 *          in the agent's assembled prompt. Returns an empty string if the
 *          agent is not recognised.
 */
export function getOutputInstructions(agentName: string): string {
  const role = getAgentRole(agentName)
  const convention = getOutputConvention(agentName)

  const parts: string[] = [
    "## Output conventions",
  ]

  switch (role) {
    case "report": {
      parts.push(
        "",
        "You are a report-style agent. Your output is a structured markdown report.",
        "",
        "### Rules",
        "",
        "- **Do not use `edit`, `write`, or mutation-capable tools.**",
        "  Your tools are limited to read-only operations.",
        "- **Return structured markdown** with clear headings, severity levels,",
        "  and actionable detail.",
        "- **Do not write files.** The orchestrator persists your output into",
        "  runtime-state directories.",
        "- **Your report is captured and persisted automatically.** Focus on",
        "  producing thorough, structured findings.",
        "",
        `Expected format: ${convention.outputFormat}`,
        `Your role: ${convention.description}`,
      )
      break
    }
    case "implementation": {
      parts.push(
        "",
        "You are an implementation agent. Your primary output is the changed",
        "filesystem state in your assigned worktree.",
        "",
        "### Rules",
        "",
        "- **Use `edit` and `write` tools** to modify files as specified in",
        "  your assigned plan group.",
        "- **Run scoped verification** after implementing.",
        "- **Report a summary** of what was done, what passed/failed, and any",
        "  observations or residual risks.",
        "- **Your file changes are the output.** The orchestrator does not",
        "  need to persist an additional report from you beyond the summary.",
        "",
        `Your role: ${convention.description}`,
      )
      break
    }
    case "hybrid": {
      parts.push(
        "",
        "You are a hybrid agent with a restricted write channel.",
        "",
        "### Rules",
        "",
        "- **Use your restricted write tool to produce artifacts.**",
        "  Do not use `edit` or `write` for unrestricted mutations.",
        "- **The orchestrator persists your artifacts.**",
        "- **Return a summary** of what was produced and any observations.",
        "",
        `Expected format: ${convention.outputFormat}`,
        `Your role: ${convention.description}`,
      )
      break
    }
  }

  return parts.join("\n")
}

/**
 * Get output instructions suitable for the overall orchestrator context.
 *
 * This is a distilled version describing how the orchestrator should handle
 * outputs from subagents of each role. Intended for inclusion in the main
 * orchestrator prompt rather than individual subagent prompts.
 *
 * @returns A string containing orchestrator-level output handling instructions.
 */
export function getOrchestratorOutputInstructions(): string {
  return [
    "## Subagent output handling",
    "",
    "Subagent outputs are handled according to their role:",
    "",
    "### Report-style agents (scout, repo-mapper, verifier, review-*, plan-review-*, synthesizer)",
    "",
    "- **They return structured markdown.**",
    "- **Persist their output** into runtime-state files or pi-subagents artifact directories.",
    "- **Do not grant them `edit` or `write` tools.**",
    "- They rely on you (the orchestrator) to capture and persist their findings.",
    "",
    "### Implementation agents (implement-routine, implement-hard)",
    "",
    "- **They edit files in their assigned worktree.**",
    "- **The file changes ARE the primary output.**",
    "- Collect their summary report for the run log, but the filesystem state is the deliverable.",
    "",
    "### Hybrid agents (planner-frontier)",
    "",
    "- **They write through restricted tools** (zflow_write_plan_artifact).",
    "- **The orchestrator persists those artifacts** into the plan directory.",
    "",
    "### General rules",
    "",
    "- Do not ask report agents to write files. That violates their role contract.",
    "- Do not ask implementation agents to produce structured reports as their primary output.",
    "- Persist report outputs to `<runtime-state-dir>/review/` or the appropriate artifact path.",
    "- Use the reviewer manifest to track which reviewers ran and what they produced.",
  ].join("\n")
}
