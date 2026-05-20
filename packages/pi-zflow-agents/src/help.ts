/**
 * help.ts — pi-zflow-agents help topic metadata.
 *
 * Exports help topic constants for the agents package.
 * Consumed by the umbrella `/zflow-help` extension for suite-level help display.
 *
 * @module pi-zflow-agents/help
 */

import type { ZflowHelpTopic } from "pi-zflow-core"

/**
 * Help topic describing agent setup/update commands and workflow guidance.
 */
export const AGENTS_HELP_TOPIC: ZflowHelpTopic = {
  packageName: "pi-zflow-agents",
  id: "agents",
  title: "Agent Setup",
  summary:
    "Install or update custom agent markdown, chains, skills, and " +
    "prompt templates for subagent workflows.",
  flowOrder: 15,
  flowGuidance:
    "Run after profile configuration to ensure custom agents and " +
    "chains are installed and up to date before starting " +
    "planning or implementation work.",
  commands: [
    {
      name: "zflow-setup-agents",
      usage: "/zflow-setup-agents",
      description:
        "Install pi-zflow custom agents, chains, and prompt templates.",
    },
    {
      name: "zflow-update-agents",
      usage: "/zflow-update-agents",
      description:
        "Update previously installed agents and chains to the " +
        "latest versions.",
    },
  ],
  relatedTopics: ["profiles", "plan-mode", "change"],
}

/**
 * All help topics exported by pi-zflow-agents.
 */
export const ZFLOW_HELP_TOPICS: ZflowHelpTopic[] = [AGENTS_HELP_TOPIC]
