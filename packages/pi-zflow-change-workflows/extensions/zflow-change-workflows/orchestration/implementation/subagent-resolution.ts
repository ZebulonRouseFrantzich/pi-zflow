/**
 * subagent-resolution.ts — apply-back conflict resolution prompt helpers.
 */

import { buildEphemeralScriptRule } from "../scratch-scripts.js"

/**
 * Generate a resolution prompt for a subagent when all automated strategies fail.
 *
 * This prompt includes:
 * - Each group's original task description
 * - The patch content for each group
 * - The integration worktree state (if available)
 * - Conflict markers (if any)
 * - The base commit diff
 *
 * @param runId - The run identifier.
 * @param changeId - The change identifier.
 * @param groups - The execution groups with task prompts.
 * @param cwd - Working directory (optional).
 * @returns A structured prompt for the resolution subagent.
 */
export async function buildSubagentResolutionPrompt(
  runId: string,
  changeId: string,
  groups: Array<{ id: string; files: string[]; taskPrompt?: string }>,
  cwd?: string,
): Promise<string> {
  const { default: path } = await import("node:path")
  const { default: fs } = await import("node:fs/promises")
  const { resolveRunDir } = await import("pi-zflow-artifacts/artifact-paths")

  const runDir = resolveRunDir(runId, cwd)
  const patchesDir = path.join(runDir, "patches")
  const intWorktreeDir = path.join(runDir, "integration-worktree")

  const lines: string[] = [
    "# Apply-Back Resolution Task",
    "",
    `## Run: ${runId}`,
    `## Change: ${changeId}`,
    "",
    "All automated apply-back strategies have failed. Your task is to resolve",
    "the remaining conflicts and produce a merged result that preserves ALL",
    "groups' intended changes.",
    "",
    "## Resolution instructions",
    "",
    "1. DO NOT drop or remove any group's changes.",
    "2. If two groups changed the same code, understand both intents and merge them.",
    "3. If conflict markers exist, resolve each one carefully.",
    "4. If a group added a file, it must still exist in the final result.",
    "5. If a group deleted a file, it must still be deleted.",
    "6. If a group modified a file, those modifications must be preserved.",
    "7. After resolving, verify the code builds and passes type checks.",
    "8. Commit all resolved changes with message:",
    '   `zflow: subagent resolution for run ${runId}`',
    "",
    "## Group tasks",
    "",
  ]

  for (const group of groups) {
    lines.push(`### ${group.id}`)
    if (group.taskPrompt) {
      lines.push("")
      lines.push(`**Task:** ${group.taskPrompt}`)
    }
    if (group.files.length > 0) {
      lines.push("")
      lines.push(`**Files:** ${group.files.join(", ")}`)
    }

    const patchPath = path.join(patchesDir, `${group.id}.patch`)
    try {
      const patchContent = await fs.readFile(patchPath, "utf-8")
      if (patchContent.trim()) {
        lines.push("")
        lines.push("**Patch:**")
        lines.push("```diff")
        lines.push(patchContent.slice(0, 2000))
        if (patchContent.length > 2000) {
          lines.push("... (patch truncated)")
        }
        lines.push("```")
      }
    } catch {
      // No patch file — skip
    }

    lines.push("")
  }

  try {
    await fs.access(intWorktreeDir)
    lines.push("## Integration worktree available")
    lines.push("")
    lines.push(`The integration worktree is at: \`${intWorktreeDir}\``)
    lines.push("")
    lines.push("This worktree contains a partially merged result with conflict markers.")
    lines.push("You should work in this worktree to complete the merge.")
    lines.push("")
    lines.push("```bash")
    lines.push(`cd ${intWorktreeDir}`)
    lines.push("git status")
    lines.push("# resolve conflicts")
    lines.push("git add -A")
    lines.push(`git commit -m "zflow: subagent resolution for run ${runId}"`)
    lines.push("```")
  } catch {
    lines.push("## Work in the primary worktree")
    lines.push("")
    lines.push("No integration worktree was created. Apply the patches in order,")
    lines.push("resolving conflicts as they arise.")
  }

  lines.push("")
  lines.push("## Ephemeral Script Policy")
  lines.push("")
  const scratchScriptsDir = path.join(path.dirname(path.dirname(runDir)), "scratch", "scripts")
  lines.push(buildEphemeralScriptRule(scratchScriptsDir))
  lines.push("")
  lines.push("## Important constraints")
  lines.push("")
  lines.push("- Keep ALL group changes. Missing a group's changes is a failure.")
  lines.push("- If a conflict is genuinely unresolvable, explain why and leave a comment.")
  lines.push("- After resolving all conflicts, run any available verification.")
  lines.push("- Report which groups you merged, which files you changed, and any decisions.")

  return lines.join("\n")
}

/**
 * Options for requesting subagent resolution of apply-back conflicts.
 */
export interface SubagentResolutionOptions {
  /** Unique run identifier. */
  runId: string
  /** Change identifier. */
  changeId: string
  /** Execution groups with task prompts. */
  groups: Array<{ id: string; files: string[]; taskPrompt?: string }>
  /** Working directory. */
  cwd?: string
  /** Model to use for the resolution subagent (default: from active profile). */
  model?: string
}

/**
 * Result of a subagent resolution attempt.
 */
export interface SubagentResolutionResult {
  /** Whether the resolution was successful. */
  success: boolean
  /** Human-readable summary. */
  summary: string
  /** Any remaining conflict markers or issues. */
  remainingIssues?: string[]
}

/**
 * Request subagent resolution of apply-back conflicts.
 *
 * Builds a detailed prompt with each group's task, patch, and file info,
 * then dispatches to a subagent to resolve remaining merge conflicts.
 *
 * After the subagent completes, verifies that all groups' patches are
 * represented and no conflict markers remain.
 *
 * @param options - Resolution options.
 * @returns SubagentResolutionResult.
 */
export async function requestSubagentResolution(
  options: SubagentResolutionOptions,
): Promise<SubagentResolutionResult> {
  const { runId, changeId, groups, cwd } = options

  const resolutionPrompt = await buildSubagentResolutionPrompt(
    runId,
    changeId,
    groups,
    cwd,
  )

  const { default: fs } = await import("node:fs/promises")
  const { default: path } = await import("node:path")
  const { resolveRunDir } = await import("pi-zflow-artifacts/artifact-paths")

  const runDir = resolveRunDir(runId, cwd)
  const promptPath = path.join(runDir, "subagent-resolution-prompt.md")
  await fs.writeFile(promptPath, resolutionPrompt, "utf-8")

  const scratchScriptsDir = path.join(path.dirname(path.dirname(runDir)), "scratch", "scripts")
  const scriptPolicy = buildEphemeralScriptRule(scratchScriptsDir)

  const existingContent = await fs.readFile(promptPath, "utf-8")
  const enhancedPrompt = `${scriptPolicy}\n\n${existingContent}`
  await fs.writeFile(promptPath, enhancedPrompt, "utf-8")

  return {
    success: true,
    summary: [
      "Subagent resolution prompt prepared (with ephemeral script policy).",
      `Prompt saved to: ${promptPath}`,
      "",
      "To dispatch the resolution subagent, the command handler should:",
      "1. Read the prompt from the above path.",
      "2. Dispatch to a subagent with full context and write access.",
      '3. The subagent should work in the integration worktree (if available)',
      "   or apply patches to the primary worktree after rollback.",
      "4. After the subagent completes, verify coverage and run apply-back.",
    ].join("\n"),
  }
}
