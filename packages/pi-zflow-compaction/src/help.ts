/**
 * help.ts — pi-zflow-compaction help topic metadata.
 *
 * Exports help topic constants for the compaction package.
 * Consumed by the umbrella `/zflow-help` extension for suite-level help display.
 *
 * @module pi-zflow-compaction/help
 */

import type { ZflowHelpTopic } from "pi-zflow-core"

/**
 * Help topic describing context management / compaction capabilities.
 */
export const COMPACTION_HELP_TOPIC: ZflowHelpTopic = {
  packageName: "pi-zflow-compaction",
  id: "compaction",
  title: "Context Management",
  summary:
    "Proactive compaction hooks and compaction handoff reminders " +
    "to manage session context usage and prevent token overflow.",
  flowGuidance:
    "Runs automatically in the background during long sessions. " +
    "No direct user commands needed. Integrates with the session " +
    "lifecycle to compact context at ~60% usage and inject handoff " +
    "reminders so the model rereads canonical artifact paths.",
  commands: [],
  relatedTopics: ["change"],
}

/**
 * All help topics exported by pi-zflow-compaction.
 */
export const ZFLOW_HELP_TOPICS: ZflowHelpTopic[] = [COMPACTION_HELP_TOPIC]
