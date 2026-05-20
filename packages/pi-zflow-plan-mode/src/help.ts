/**
 * help.ts — pi-zflow-plan-mode help topic metadata.
 *
 * Exports help topic constants for the plan-mode package.
 * Consumed by the umbrella `/zflow-help` extension for suite-level help display.
 *
 * @module pi-zflow-plan-mode/help
 */

import type { ZflowHelpTopic } from "pi-zflow-core"

/**
 * Help topic describing read-only planning mode commands and workflow guidance.
 */
export const PLAN_MODE_HELP_TOPIC: ZflowHelpTopic = {
  packageName: "pi-zflow-plan-mode",
  id: "plan-mode",
  title: "Read-Only Planning Mode",
  summary:
    "Enter or exit ad-hoc read-only planning mode with restricted " +
    "tools and bash policy to prevent accidental mutations.",
  flowOrder: 20,
  flowGuidance:
    "Use after profile setup and agent installation. Activate plan " +
    "mode before exploration or formal change preparation to block " +
    "source mutations and keep the session focused on planning.",
  commands: [
    {
      name: "zflow-plan",
      usage: "/zflow-plan",
      description: "Toggle read-only planning mode on/off.",
    },
    {
      name: "zflow-plan status",
      usage: "/zflow-plan status",
      description: "Show current plan mode state and activation details.",
    },
    {
      name: "zflow-plan exit",
      usage: "/zflow-plan exit",
      description: "Exit plan mode and restore normal editing.",
    },
  ],
  relatedTopics: ["profiles", "change"],
}

/**
 * All help topics exported by pi-zflow-plan-mode.
 */
export const ZFLOW_HELP_TOPICS: ZflowHelpTopic[] = [PLAN_MODE_HELP_TOPIC]
