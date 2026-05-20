/**
 * help.ts — pi-zflow-subagents-bridge help topic metadata.
 *
 * Exports help topic constants for the subagents-bridge package.
 * Consumed by the umbrella `/zflow-help` extension for suite-level help display.
 *
 * @module pi-zflow-subagents-bridge/help
 */

import type { ZflowHelpTopic } from "pi-zflow-core"

/**
 * Help topic describing the dispatch bridge infrastructure.
 */
export const DISPATCH_HELP_TOPIC: ZflowHelpTopic = {
  packageName: "pi-zflow-subagents-bridge",
  id: "dispatch",
  title: "Dispatch Bridge",
  summary:
    "Subagent dispatch adapter that bridges pi-zflow's typed " +
    "dispatch interface with the runtime subagent backend for " +
    "worktree-isolated execution.",
  flowGuidance:
    "Infrastructure for change implementation dispatch. Used " +
    "automatically by /zflow-change-implement. No direct user " +
    "commands; registers the zflow-dispatch capability in the " +
    "shared registry for use by change workflows.",
  commands: [],
  relatedTopics: ["change", "agents"],
}

/**
 * All help topics exported by pi-zflow-subagents-bridge.
 */
export const ZFLOW_HELP_TOPICS: ZflowHelpTopic[] = [DISPATCH_HELP_TOPIC]
