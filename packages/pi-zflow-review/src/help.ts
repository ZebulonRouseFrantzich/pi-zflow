/**
 * help.ts — pi-zflow-review help topic metadata.
 *
 * Exports help topic constants for the review package.
 * Consumed by the umbrella `/zflow-help` extension for suite-level help display.
 *
 * @module pi-zflow-review/help
 */

import type { ZflowHelpTopic } from "pi-zflow-core"

/**
 * Help topic describing code review commands and workflow guidance.
 */
export const REVIEW_HELP_TOPIC: ZflowHelpTopic = {
  packageName: "pi-zflow-review",
  id: "review",
  title: "Code Review",
  summary:
    "Review code changes against planning documents and review " +
    "external pull requests or merge requests.",
  flowOrder: 40,
  flowGuidance:
    "Use after implementing changes to verify correctness before " +
    "merging. Also useful before implementation to review a plan " +
    "for gaps or risks. Can be run multiple times in a cycle.",
  commands: [
    {
      name: "zflow-review-code",
      usage: "/zflow-review-code [change-id]",
      description:
        "Review local code changes against planning documents.",
    },
    {
      name: "zflow-review-pr",
      usage: "/zflow-review-pr <url>",
      description: "Review an external GitHub PR or GitLab MR.",
    },
  ],
  relatedTopics: ["change", "profiles"],
}

/**
 * All help topics exported by pi-zflow-review.
 */
export const ZFLOW_HELP_TOPICS: ZflowHelpTopic[] = [REVIEW_HELP_TOPIC]
