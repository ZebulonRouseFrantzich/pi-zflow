/**
 * help-catalog.ts — pi-zflow help topic types, aggregator, and markdown rendering helpers.
 *
 * Library-only module. Child packages contribute their own help topics;
 * the umbrella `/zflow-help` extension uses these helpers to display help.
 * No Pi extensions, commands, tools, or UI are registered here.
 *
 * @module
 */

// ── Types ────────────────────────────────────────────────────────────

/** A single command within a help topic. */
export interface ZflowCommandHelp {
  /** Command name without leading slash, e.g. "zflow-profile switch" */
  name: string
  /** Usage string including leading slash, e.g. "/zflow-profile switch <name>" */
  usage: string
  /** Brief description of what the command does */
  description: string
}

/** A help topic contributed by a child package or the umbrella aggregator. */
export interface ZflowHelpTopic {
  /** Package that owns this topic, e.g. "pi-zflow-profiles" */
  packageName: string
  /** Unique topic identifier, e.g. "profiles", "plan-mode", "review" */
  id: string
  /** Short human-readable title, e.g. "Profile Management" */
  title: string
  /** One-line summary of what this topic covers */
  summary: string
  /**
   * Flow order hint for suite-level workflow guidance.
   * Lower values come earlier in the recommended workflow sequence.
   * Topics without a flowOrder sort after ordered topics.
   */
  flowOrder?: number
  /** Optional guidance about where this package fits in the overall workflow */
  flowGuidance?: string
  /** Commands exposed by this package */
  commands: ZflowCommandHelp[]
  /** IDs of related topics for cross-referencing */
  relatedTopics?: string[]
  /** Optional sub-topics for drill-down detail (e.g. per-command details) */
  subtopics?: ZflowHelpTopic[]
}

// ── Sort / group helpers ─────────────────────────────────────────────

/**
 * Sort topics by flowOrder (ascending). Topics without flowOrder sort last,
 * preserving their relative input order.
 */
export function sortTopicsByFlow(topics: ZflowHelpTopic[]): ZflowHelpTopic[] {
  return [...topics].sort((a, b) => {
    const ao = a.flowOrder ?? Number.MAX_SAFE_INTEGER
    const bo = b.flowOrder ?? Number.MAX_SAFE_INTEGER
    return ao - bo
  })
}

/**
 * Group topics by their packageName. Returns insertion-order stable entries.
 */
export function groupTopicsByPackage(
  topics: ZflowHelpTopic[],
): Map<string, ZflowHelpTopic[]> {
  const groups = new Map<string, ZflowHelpTopic[]>()
  for (const topic of topics) {
    const list = groups.get(topic.packageName)
    if (list) {
      list.push(topic)
    } else {
      groups.set(topic.packageName, [topic])
    }
  }
  return groups
}

/**
 * Find a topic by its `id` (and optionally a subtopic chain).
 * Returns the topic or undefined if not found.
 *
 * @param topics  - All registered topics
 * @param id      - Topic id to find
 * @param subtopicId - Optional subtopic id to drill into
 */
export function getTopic(
  topics: ZflowHelpTopic[],
  id: string,
  subtopicId?: string,
): ZflowHelpTopic | undefined {
  const topic = topics.find((t) => t.id === id)
  if (!topic || !subtopicId || !topic.subtopics) return topic
  return topic.subtopics.find((st) => st.id === subtopicId)
}

// ── Markdown rendering helpers ───────────────────────────────────────

/**
 * Render a single help topic as a concise markdown section.
 */
export function renderTopicMarkdown(topic: ZflowHelpTopic): string {
  const lines: string[] = []

  lines.push(`## ${topic.title}`)
  lines.push("")
  lines.push(topic.summary)
  lines.push("")

  if (topic.flowGuidance) {
    lines.push(`**Flow guidance:** ${topic.flowGuidance}`)
    lines.push("")
  }

  if (topic.commands.length > 0) {
    lines.push("### Commands")
    lines.push("")
    lines.push("| Command | Usage | Description |")
    lines.push("| ------- | ----- | ----------- |")
    for (const cmd of topic.commands) {
      const escapedUsage = cmd.usage.replace(/\|/g, "\\|")
      const escapedDesc = cmd.description.replace(/\|/g, "\\|")
      lines.push(`| \`${cmd.name}\` | \`${escapedUsage}\` | ${escapedDesc} |`)
    }
    lines.push("")
  }

  if (topic.relatedTopics && topic.relatedTopics.length > 0) {
    lines.push("**Related:** " + topic.relatedTopics.map((r) => `\`${r}\``).join(", "))
    lines.push("")
  }

  if (topic.subtopics && topic.subtopics.length > 0) {
    for (const sub of topic.subtopics) {
      lines.push(renderTopicMarkdown(sub))
    }
  }

  return lines.join("\n")
}

/**
 * Render a full suite-level help document from all provided topics.
 * Topics are sorted by flow order automatically.
 */
export function renderAllTopicsMarkdown(topics: ZflowHelpTopic[]): string {
  const sorted = sortTopicsByFlow(topics)
  const lines: string[] = []

  lines.push("# pi-zflow Help")
  lines.push("")
  lines.push(
    "pi-zflow is a modular Pi harness customization suite. " +
    "Below is the complete list of available commands and workflow guidance.",
  )
  lines.push("")
  lines.push("Use `/zflow-help <topic>` to drill into a specific area.")
  lines.push("")

  // Overview table
  lines.push("## Overview")
  lines.push("")
  lines.push("| Topic | Package | Summary |")
  lines.push("| ----- | ------- | ------- |")
  for (const topic of sorted) {
    lines.push(`| \`${topic.id}\` | ${topic.packageName} | ${topic.summary} |`)
  }
  lines.push("")

  // Flow guidance section
  const flowTopics = sorted.filter((t) => t.flowOrder !== undefined)
  if (flowTopics.length > 0) {
    lines.push("## Recommended Workflow")
    lines.push("")
    lines.push(
      "The recommended order for working with pi-zflow commands " +
      "in a typical development cycle:",
    )
    lines.push("")
    for (let i = 0; i < flowTopics.length; i++) {
      const t = flowTopics[i]
      lines.push(`${i + 1}. **${t.title}** — ${t.flowGuidance ?? t.summary}`)
    }
    lines.push("")
  }

  // Detail sections
  for (const topic of sorted) {
    lines.push(renderTopicMarkdown(topic))
    lines.push("")
    lines.push("---")
    lines.push("")
  }

  lines.push(
    "_Generated by pi-zflow-core/help-catalog. " +
    "File an issue if something is missing or unclear._",
  )
  lines.push("")

  return lines.join("\n")
}

/**
 * Render a compact one-line status summary for a set of topics.
 * Useful for a startup hint or a quick `/zflow-help` overview.
 */
export function renderHelpSummary(topics: ZflowHelpTopic[]): string {
  const count = topics.length
  const commandCount = topics.reduce((acc, t) => acc + t.commands.length, 0)
  const packages = new Set(topics.map((t) => t.packageName))
  return (
    `pi-zflow: ${count} topic${count !== 1 ? "s" : ""}, ` +
    `${commandCount} command${commandCount !== 1 ? "s" : ""}, ` +
    `${packages.size} package${packages.size !== 1 ? "s" : ""} — ` +
    `type /zflow-help for details`
  )
}
