/**
 * help.ts — pi-zflow-runecontext help topic metadata.
 *
 * Exports help topic constants for the runecontext package.
 * Consumed by the umbrella `/zflow-help` extension for suite-level help display.
 *
 * @module pi-zflow-runecontext/help
 */

import type { ZflowHelpTopic } from "pi-zflow-core"

/**
 * Help topic describing RuneContext integration capabilities.
 */
export const RUNECONTEXT_HELP_TOPIC: ZflowHelpTopic = {
  packageName: "pi-zflow-runecontext",
  id: "runecontext",
  title: "RuneContext Integration",
  summary:
    "Detect RuneContext-managed projects, resolve change documents, " +
    "read canonical docs, derive execution groups, and support " +
    "write-back amendments.",
  flowGuidance:
    "Used automatically by change workflows when working in " +
    "RuneContext-managed repositories. No direct user commands; " +
    "provides service integration for /zflow-change-* commands.",
  commands: [],
  relatedTopics: ["change", "artifacts"],
}

/**
 * All help topics exported by pi-zflow-runecontext.
 */
export const ZFLOW_HELP_TOPICS: ZflowHelpTopic[] = [RUNECONTEXT_HELP_TOPIC]
