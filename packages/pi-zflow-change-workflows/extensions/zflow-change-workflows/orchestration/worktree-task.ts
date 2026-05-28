/**
 * worktree-task.ts — worktree dispatch task types and prompt builders.
 */

import type { TaskWorktreeStrategy } from "pi-zflow-core/dispatch-service"

import type { DispatchExecutionGroup } from "./execution-groups.js"

// ── Worktree dispatch helpers (Phase 5) ───────────────────────

/**
 * A single task for worktree dispatch, representing one execution group.
 */
export interface WorktreeGroupTask {
  /** Group identifier from execution-groups.md. */
  groupId: string
  /** The agent runtime name assigned to this group. */
  agent: string
  /** The assembled task prompt for this group. */
  task: string
  /** Files this group is expected to write (for preflight overlap check). */
  claimedFiles: string[]
  /** Plan dependencies for this task/group. */
  dependencies: string[]
  /** Optional richer worktree execution strategy for this task. */
  worktreeStrategy?: TaskWorktreeStrategy
  /** Optional scoped verification command from the plan. */
  scopedVerification?: string
  /** Output path for the worktree result manifest (relative to run dir). */
  outputRelativePath: string
}

/**
 * Configuration for a worktree dispatch operation.
 */
export interface WorktreeDispatchConfig {
  /** Unique run identifier. */
  runId: string
  /** Absolute path to the repository root. */
  repoRoot: string
  /** Change identifier from the plan. */
  changeId: string
  /** Plan version (e.g. "v1"). */
  planVersion: string
  /** Exact intercom target for the supervising orchestrator, when known. */
  orchestratorTarget?: string
}

// Type for an execution group used by worktree dispatch

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
 * Build a worker task prompt for a single execution group.
 *
 * Produces a compact, actionable prompt that tells the worker agent:
 * - what to implement (scoped to this group's files)
 * - what not to touch
 * - what context artifacts to read
 * - how to validate
 * - when to escalate
 *
 * @param group - The execution group to build a task for.
 * @param config - Dispatch configuration (run ID, repo root, etc.).
 * @param planArtifactPaths - Paths to canonical plan artifacts.
 * @returns A task prompt string for the worker agent.
 */
export function buildWorkerTask(
  group: DispatchExecutionGroup,
  config: WorktreeDispatchConfig,
  planArtifactPaths?: Record<string, string>,
): string {
  const lines: string[] = []

  // Handle coalesced groups (merged from multiple original groups)
  if (group.coalescedFrom && group.coalescedFrom.length > 1) {
    lines.push(
      `# Task: ${group.coalescedFrom.join(" + ")}`,
      "",
      `This worktree implements multiple execution groups that share files or have ` +
      `dependencies. They have been combined so you can implement them together ` +
      `in dependency order within this single worktree.`,
      "",
      `## Coalesced groups`,
    )
    for (const origId of group.coalescedFrom) {
      lines.push(`- ${origId}`)
    }
    lines.push("")
  } else {
    lines.push(
      `# Task: ${group.id}`,
      "",
      `Execute the approved plan for group **${group.id}** using the configured worktree orchestration for this group.`,
      "",
    )
  }

  const scopeDesc = group.coalescedFrom && group.coalescedFrom.length > 1
    ? `- Files you may modify across all sub-groups: ${group.files.join(", ") || "(none specified)"}`
    : `- Files you may modify: ${group.files.join(", ") || "(none specified)"}`

  lines.push(
    `## Run context`,
    `- Run ID: ${config.runId}`,
    `- Change: ${config.changeId}`,
    `- Plan version: ${config.planVersion}`,
    `- Repo root: ${config.repoRoot}`,
    "",
    `## Scope`,
    scopeDesc,
    `- Agent: ${group.agent}`,
  )

  if (group.executionMode === "shared-staging") {
    lines.push(
      `- Execution mode: shared-staging`,
      `- Workspace ID: ${group.workspaceId ?? "(missing)"}`,
      `- Workspace concurrency: ${group.workspaceConcurrency ?? "serialized"}`,
    )
    if (group.executionRationale) {
      lines.push(`- Execution rationale: ${group.executionRationale}`)
    }
    lines.push(
      "",
      "This task runs in a planner-declared shared staging workspace.",
      "Preserve sibling workspace changes. Do not revert or overwrite unrelated",
      "changes already present in the shared workspace.",
    )
  }

  if (group.baseStrategy === "dependency-lineage") {
    lines.push(
      `- Base strategy: dependency-lineage`,
      "- This task may start from a dependency lineage ref that already contains",
      "  approved dependency changes not yet applied back to the primary worktree.",
    )
  }

  lines.push(
    "",
    `## Rules`,
    `1. ONLY modify files listed in your scope above. Do NOT touch files outside this list.`,
    `2. If an instruction in the plan is impossible, stop work and file a deviation report.`,
    `3. Prefer batch edits for multi-file changes (use the \`edit\` tool with \`multi\` parameter).`,
    `4. For complex refactors, use patch mode to apply structured diffs.`,
    `5. Create temporary commits as needed using format: \`[pi-worker] ${group.id}: <step>\`.`,
    `6. After implementation, run the scoped verification command if provided.`,
    `7. Do NOT launch subagents.`,
    `8. Do NOT commit to the primary branch. Your worktree commits are disposable.`,
    `9. Report all changed files and verification results in your output summary.`,
    ``,
    `## Ephemeral Script Policy`,
    `Any temporary helper script MUST be written ONLY to:`,
    `\`<runtime-state-dir>/runs/${config.runId}/scratch/scripts/\``,
    `Never write helper scripts to the repo root, scripts/, test/, tests/, src/, or lib/.`,
  )

  if (group.dependencies.length > 0) {
    lines.push(
      "",
      "## Dependencies",
      `This group depends on: ${group.dependencies.join(", ")}.`,
      "Those groups have already completed in their own worktrees.",
      "If you need output from a dependency, read the plan artifacts.",
    )
  }

  if (group.scopedVerification) {
    const commands = group.scopedVerification.split("\n").filter(Boolean)
    if (commands.length > 1) {
      // Multi-command (coalesced groups): render each separately so the
      // agent runs them as individual guarded bash calls, not shell-chained.
      lines.push(
        "",
        "## Scoped verification",
        "After implementing, run each of the following verification commands",
        "separately (do NOT chain them with `&&`, `;`, or `|`):",
        "",
      )
      for (let i = 0; i < commands.length; i++) {
        lines.push(
          `### Verification ${i + 1}`,
          "",
          "```bash",
          commands[i]!,
          "```",
          "",
        )
      }
      lines.push(
        "Include the verification result (pass/fail/output) for each command",
        "in your summary.",
        "Do NOT invent or run repo-wide verification commands. Run only the",
        "scoped verification commands specified above.",
      )
    } else {
      // Single command (non-coalesced group)
      lines.push(
        "",
        "## Scoped verification",
        "After implementing, run the following command to verify your changes:",
        "",
        "```bash",
        commands[0]!,
        "```",
        "",
        "Include the verification result (pass/fail/output) in your summary.",
        "Do NOT invent or run repo-wide verification commands. Run only the",
        "scoped verification command specified above.",
      )
    }
  } else {
    lines.push(
      "",
      "## Verification",
      "No scoped verification command was specified in the plan.",
      "STOP and report a plan-quality gap: the plan is missing a Scoped verification",
      "command for this group. Do NOT invent or run your own verification.",
    )
  }

  if (planArtifactPaths && Object.keys(planArtifactPaths).length > 0) {
    lines.push(
      "",
      "## Plan artifacts",
      "The following plan documents are available:",
      ...Object.entries(planArtifactPaths).map(
        ([key, val]) => `- ${key}: \`${val}\``,
      ),
    )

    // Point the worker to their group's detailed task spec
    const implTasksPath = planArtifactPaths["implementationTasks"]
    if (implTasksPath) {
      lines.push(
        "",
        "## Implementation task spec",
        `Your group \`${group.id}\` has a corresponding section in \`implementation-tasks.md\``,
        `that contains detailed context, pseudocode, acceptance criteria, and self-checks.`,
        "Read it before starting implementation:",
        "",
        `1. Open \`${implTasksPath}\``,
        `2. Find the section matching \`${group.id}\` or \`## Group ${group.id.replace("group-", "")}:\``,
        `3. Review the objective, scope, likely files, checklist, pseudocode, and self-checks`,
        "",
        "If the implementation-tasks.md file is missing or lacks a section for your group,",
        "STOP and report a plan-quality gap: the plan is missing a task spec for this group.",
      )
    }
  }

  lines.push(
    "",
    ...buildLimitedCoordinationLines(`group ${group.id}`, config.orchestratorTarget),
    "",
    "## Output format",
    "When finished, provide:",
    "1. Summary of changes made",
    "2. List of changed files (relative to repo root)",
    "3. Verification result",
    "4. Any unexpected issues or deviations",
  )

  return lines.join("\n")
}
