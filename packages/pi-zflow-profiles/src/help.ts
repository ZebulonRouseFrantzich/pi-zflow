/**
 * help.ts — pi-zflow-profiles help topic metadata.
 *
 * Exports help topic constants for the profiles package.
 * Consumed by the umbrella `/zflow-help` extension for suite-level help display.
 *
 * @module pi-zflow-profiles/help
 */

import type { ZflowHelpTopic } from "pi-zflow-core"

/**
 * Help topic describing profile management commands and workflow guidance.
 */
export const PROFILE_HELP_TOPIC: ZflowHelpTopic = {
  packageName: "pi-zflow-profiles",
  id: "profiles",
  title: "Profile Management",
  summary:
    "Load, switch, and validate profiles and lanes for model routing " +
    "and agent configuration.",
  flowOrder: 10,
  flowGuidance:
    "Start here. Configure your active profile before using other " +
    "pi-zflow commands. Profiles define which models, tools, and " +
    "settings are available in each development context.",
  commands: [
    {
      name: "zflow-profile",
      usage: "/zflow-profile",
      description: "Show active profile summary.",
    },
    {
      name: "zflow-profile default",
      usage: "/zflow-profile default",
      description: "Activate the default profile.",
    },
    {
      name: "zflow-profile show",
      usage: "/zflow-profile show",
      description: "Display detailed profile information.",
    },
    {
      name: "zflow-profile lanes",
      usage: "/zflow-profile lanes",
      description: "Show lane definitions and status.",
    },
    {
      name: "zflow-profile refresh",
      usage: "/zflow-profile refresh",
      description: "Force re-resolution of the profile.",
    },
    {
      name: "zflow-profile sync-project",
      usage: "/zflow-profile sync-project",
      description: "Write resolved overrides to .pi/settings.json.",
    },
  ],
  relatedTopics: ["agents", "plan-mode"],
}

/**
 * All help topics exported by pi-zflow-profiles.
 */
export const ZFLOW_HELP_TOPICS: ZflowHelpTopic[] = [PROFILE_HELP_TOPIC]
