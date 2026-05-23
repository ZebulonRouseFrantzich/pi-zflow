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
    "Formal artifact-first change orchestration: prepare plans, " +
    "implement changes in isolated worktrees, audit results against " +
    "plans, apply fixes, and clean up temporary artifacts. " +
    "Durable plan documents are published to the repo under " +
    "docs/zflow-changes/ for review and commit; runtime/review " +
    "logs remain under .zflow/.",
  flowOrder: 30,
  flowGuidance:
    "Core workflow: prepare a change plan, review it, implement it " +
    "via subagent dispatch, audit the result, apply any fixes, then " +
    "clean up worktrees and temporary state. The typical cycle is: " +
    "prepare \u2192 review \u2192 implement \u2192 audit \u2192 fix \u2192 review \u2192 clean.",
  commands: [
    {
      name: "zflow-change-prepare",
      usage: "/zflow-change-prepare <change-path>",
      description:
        "Prepare a formal change plan from a change request document. " +
        "Generates four plan artifacts (design, execution-groups, " +
        "standards, verification), validates them, runs plan review, " +
        "and publishes durable copies to docs/zflow-changes/<id>/<version>/ " +
        "for review and commit. Runtime state and review logs remain " +
        "under .zflow/.",
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
