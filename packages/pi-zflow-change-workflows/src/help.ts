/**
 * help.ts — pi-zflow-change-workflows help topic metadata.
 *
 * Exports help topic constants for the change-workflows package.
 * Consumed by the umbrella `/zflow-help` extension for suite-level help display.
 *
 * @module pi-zflow-change-workflows/help
 */

import type { ZflowHelpTopic } from "pi-zflow-core"

/**
 * Help topic describing change workflow commands and their order within
 * the full pi-zflow development lifecycle.
 */
export const CHANGE_HELP_TOPIC: ZflowHelpTopic = {
  packageName: "pi-zflow-change-workflows",
  id: "change",
  title: "Change Workflows",
  summary:
    "Formal artifact-first change orchestration: create durable change plan " +
    "entrypoints, prepare versioned change docs, implement changes in " +
    "isolated worktrees, audit results against plans, apply fixes, and " +
    "clean up temporary artifacts. Durable plan drafts and prepared docs " +
    "live under docs/zflow-changes/; runtime/review logs remain under .zflow/.",
  flowOrder: 30,
  flowGuidance:
    "Core workflow: prepare a change plan, review it, implement it " +
    "via subagent dispatch, audit the result, apply any fixes, then " +
    "clean up worktrees and temporary state. The typical cycle is: " +
    "prepare \u2192 review \u2192 implement \u2192 audit \u2192 fix \u2192 review \u2192 clean.",
  commands: [
    {
      name: "zflow-change-plan",
      usage: "/zflow-change-plan <description|change-id|path> [-- notes]",
      description:
        "Draft a detailed durable docs/zflow-changes/<id>/plan.md file for a change. " +
        "You can provide a freeform change description, an explicit change id, or a " +
        "change path; if no description is supplied, the workflow prompts for one. " +
        "The command explores repo context, drafts a decision-rich single plan.md, and " +
        "shows progress while it runs.",
    },
    {
      name: "zflow-change-prepare",
      usage: "/zflow-change-prepare <change-id|change-folder|plan-file>",
      description:
        "Prepare formal versioned change docs from a reviewed durable plan.md " +
        "or other change request input. Accepts a change id, change folder, or " +
        "direct plan.md path. Generates versioned " +
        "plan artifacts (design, execution-groups, standards, verification, " +
        "implementation-tasks), validates them, runs plan review, and publishes " +
        "durable copies to docs/zflow-changes/<id>/<version>/ for review and commit. " +
        "Runtime state and review logs remain under .zflow/.",
    },
    {
      name: "zflow-change-implement",
      usage: "/zflow-change-implement <change-path>",
      description:
        "Implement a prepared change plan, dispatching work to " +
        "subagents in isolated worktrees.",
    },
    {
      name: "zflow-change-audit",
      usage: "/zflow-change-audit <change-id>",
      description:
        "Audit the implementation of a change against its plan " +
        "for completeness and correctness.",
    },
    {
      name: "zflow-change-fix",
      usage: "/zflow-change-fix <change-id>",
      description:
        "Apply fixes identified during audit or review for a change.",
    },
    {
      name: "zflow-resolve-apply-back",
      usage: "/zflow-resolve-apply-back <run-id>",
      description:
        "Ask a resolver subagent to complete a failed smart apply-back " +
        "using the preserved integration worktree, verify that all group " +
        "patches are covered, and apply the verified consolidated patch.",
    },
    {
      name: "zflow-clean",
      usage: "/zflow-clean",
      description:
        "Clean up temporary artifacts, worktrees, and state files.",
    },
  ],
  relatedTopics: ["plan-mode", "review", "profiles", "artifacts", "dispatch"],
}

/**
 * All help topics exported by pi-zflow-change-workflows.
 */
export const ZFLOW_HELP_TOPICS: ZflowHelpTopic[] = [CHANGE_HELP_TOPIC]
