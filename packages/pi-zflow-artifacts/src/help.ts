/**
 * help.ts — pi-zflow-artifacts help topic metadata.
 *
 * Exports help topic constants for the artifacts package.
 * Consumed by the umbrella `/zflow-help` extension for suite-level help display.
 *
 * @module pi-zflow-artifacts/help
 */

import type { ZflowHelpTopic } from "pi-zflow-core"

/**
 * Help topic describing runtime artifact path helpers and the
 * zflow_write_plan_artifact tool.
 */
export const ARTIFACTS_HELP_TOPIC: ZflowHelpTopic = {
  packageName: "pi-zflow-artifacts",
  id: "artifacts",
  title: "Runtime Artifacts",
  summary:
    "Runtime state path resolution, plan/run/review artifact path " +
    "builders, atomic writes, and the zflow_write_plan_artifact tool.",
  flowGuidance:
    "Infrastructure used by change workflows and review commands. " +
    "The zflow_write_plan_artifact tool is the only write mechanism " +
    "available to planner agents during plan mode.",
  commands: [
    {
      name: "zflow_write_plan_artifact",
      usage: "zflow_write_plan_artifact",
      description:
        "Write a plan artifact (design, groups, standards, " +
        "verification) for a change and plan version. " +
        "(LLM tool, not a slash command.)",
    },
  ],
  relatedTopics: ["change", "plan-mode"],
}

/**
 * All help topics exported by pi-zflow-artifacts.
 */
export const ZFLOW_HELP_TOPICS: ZflowHelpTopic[] = [ARTIFACTS_HELP_TOPIC]
