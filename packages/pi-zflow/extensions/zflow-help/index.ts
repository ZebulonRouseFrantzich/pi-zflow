/**
 * pi-zflow umbrella extension — /zflow-help command and startup hint
 *
 * Registers the suite-level `/zflow-help` command that aggregates and displays
 * help topics from all child packages. Shows a short startup hint once per
 * extension lifetime on first session start.
 *
 * ## Capability
 *
 * Claims `"zflow-help"` via the shared capability registry. Duplicate loads
 * are silently rejected.
 *
 * ## Commands
 *
 * - `/zflow-help` — suite-level help overview
 * - `/zflow-help overview` — same as no-args
 * - `/zflow-help commands` — flat command list
 * - `/zflow-help flow` — recommended workflow guidance
 * - `/zflow-help <topic>` — drill into a specific topic
 * - `/zflow-help doctor` — capability registry diagnostics
 *
 * @module
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { getZflowRegistry } from "pi-zflow-core"
import type { CapabilityClaim } from "pi-zflow-core"
import type { ZflowHelpTopic } from "pi-zflow-core"
import {
  PI_ZFLOW_VERSION,
  renderAllTopicsMarkdown,
  renderTopicMarkdown,
  sortTopicsByFlow,
  getTopic,
  shortHash,
} from "pi-zflow-core"
import { ZFLOW_HELP_TOPICS as PROFILE_HELP } from "pi-zflow-profiles"
import { readCacheSummary } from "pi-zflow-artifacts"
import { ZFLOW_HELP_TOPICS as AGENTS_HELP } from "pi-zflow-agents"
import { ZFLOW_HELP_TOPICS as PLAN_MODE_HELP } from "pi-zflow-plan-mode"
import { ZFLOW_HELP_TOPICS as ARTIFACTS_HELP } from "pi-zflow-artifacts"
import { ZFLOW_HELP_TOPICS as REVIEW_HELP } from "pi-zflow-review"
import { ZFLOW_HELP_TOPICS as CHANGE_HELP } from "pi-zflow-change-workflows"
import { ZFLOW_HELP_TOPICS as RUNECONTEXT_HELP } from "pi-zflow-runecontext"
import { ZFLOW_HELP_TOPICS as COMPACTION_HELP } from "pi-zflow-compaction"
import { ZFLOW_HELP_TOPICS as DISPATCH_HELP } from "pi-zflow-subagents-bridge"

/** Capability name for duplicate-load guard. */
const CAPABILITY = "zflow-help"

/** All help topics aggregated from child packages. */
const ALL_HELP_TOPICS: ZflowHelpTopic[] = [
  ...PROFILE_HELP,
  ...AGENTS_HELP,
  ...PLAN_MODE_HELP,
  ...ARTIFACTS_HELP,
  ...REVIEW_HELP,
  ...CHANGE_HELP,
  ...RUNECONTEXT_HELP,
  ...COMPACTION_HELP,
  ...DISPATCH_HELP,
]

/** Argument alias map for topic-specific help. */
const TOPIC_ALIASES: Record<string, string> = {
  profiles: "profiles",
  plan: "plan-mode",
  planning: "plan-mode",
  review: "review",
  change: "change",
  agents: "agents",
  artifacts: "artifacts",
  runecontext: "runecontext",
  compaction: "compaction",
  dispatch: "dispatch",
}

/** Recognized argument keywords that do not map to a topic. */
const META_ARGS = new Set([
  "",
  "overview",
  "commands",
  "flow",
  "doctor",
])

export default function activateZflowHelpExtension(pi: ExtensionAPI): void {
  const registry = getZflowRegistry()

  // ── Capability claim (duplicate-load guard) ──────────────────────
  const claim: CapabilityClaim = {
    capability: CAPABILITY,
    version: PI_ZFLOW_VERSION,
    provider: "pi-zflow",
    sourcePath: import.meta.url,
    compatibilityMode: "compatible",
  }

  const registered = registry.claim(claim)
  if (!registered) return
  if (registered.service !== undefined) return
  registry.provide(CAPABILITY, { version: PI_ZFLOW_VERSION, topics: ALL_HELP_TOPICS })

  // ── Startup hint — once per extension lifetime ──────────────────
  let hintShown = false

  pi.on("session_start", (_event, ctx) => {
    if (_event.reason !== "startup") return
    if (!ctx.hasUI) return
    if (hintShown) return
    hintShown = true

    ctx.ui.notify(
      "pi-zflow loaded — type /zflow-help for commands and workflow guidance.",
      "info",
    )
  })

  // ── /zflow-help command ──────────────────────────────────────────
  pi.registerCommand("zflow-help", {
    description:
      "Show pi-zflow help and workflow guidance. " +
      "Topics: overview (default), commands, flow, profiles, " +
      "plan/planning, review, change, agents, doctor.",
    handler: async (args, _ctx) => {
      const arg = args.trim().toLowerCase()

      const rendered = arg === "doctor"
        ? await renderDoctor(_ctx.cwd)
        : renderForArg(arg)
      if (rendered === null) {
        _ctx.ui.notify(
          `Unknown help topic: "${arg}". ` +
          "Try /zflow-help overview, commands, flow, profiles, " +
          "plan, review, change, agents, or doctor.",
          "warning",
        )
        return
      }

      // Send as a persistent message in the conversation.
      pi.sendMessage(
        {
          customType: "zflow-help",
          content: rendered,
          display: true,
        },
        { triggerTurn: false },
      )
    },
  })
}

// ── Rendering dispatch ─────────────────────────────────────────────

/**
 * Render help content for a given argument.
 * Returns null if the argument is not recognized.
 */
function renderForArg(arg: string): string | null {
  if (!arg || arg === "overview") {
    return renderAllTopicsMarkdown(ALL_HELP_TOPICS)
  }

  if (arg === "commands") {
    return renderCommandsList(ALL_HELP_TOPICS)
  }

  if (arg === "flow") {
    return renderFlowGuidance(ALL_HELP_TOPICS)
  }

  if (arg === "doctor") {
    return null
  }

  const topicId = TOPIC_ALIASES[arg]
  if (topicId) {
    const topic = getTopic(ALL_HELP_TOPICS, topicId)
    if (topic) {
      return renderTopicMarkdown(topic).replace(/^## /, "# ")
    }
  }

  return null
}

// ── Sub-renderers ──────────────────────────────────────────────────

/**
 * Render a flat table of all commands across all topics, grouped by package.
 */
function renderCommandsList(topics: ZflowHelpTopic[]): string {
  const sorted = sortTopicsByFlow(topics)
  const lines: string[] = []

  lines.push("# pi-zflow Commands")
  lines.push("")
  lines.push("All available `/zflow-*` commands and tools, organized by package:")
  lines.push("")

  let commandCount = 0
  for (const topic of sorted) {
    if (topic.commands.length === 0) continue
    commandCount += topic.commands.length

    lines.push(`## ${topic.title} (${topic.packageName})`)
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

  if (commandCount === 0) {
    lines.push("No slash commands documented yet.")
    lines.push("")
  }

  lines.push("---")
  lines.push("")
  lines.push("_Type /zflow-help <topic> for detailed guidance on a specific area._")
  lines.push("")

  return lines.join("\n")
}

/**
 * Render just the recommended workflow / flow-guidance section.
 */
function renderFlowGuidance(topics: ZflowHelpTopic[]): string {
  const sorted = sortTopicsByFlow(topics)
  const flowTopics = sorted.filter((t) => t.flowOrder !== undefined)

  const lines: string[] = []

  lines.push("# pi-zflow Recommended Workflow")
  lines.push("")
  lines.push(
    "The recommended order for using pi-zflow commands " +
    "in a typical development cycle:",
  )
  lines.push("")

  for (let i = 0; i < flowTopics.length; i++) {
    const t = flowTopics[i]
    lines.push(`${i + 1}. **${t.title}** — ${t.flowGuidance ?? t.summary}`)
  }

  lines.push("")
  lines.push("### Quick Reference")
  lines.push("")
  lines.push("| Step | Area | Purpose |")
  lines.push("| ---- | ---- | ------- |")
  for (let i = 0; i < flowTopics.length; i++) {
    const t = flowTopics[i]
    const firstCmd = t.commands[0]
    const cmdRef = firstCmd ? `\`${firstCmd.usage}\`` : "—"
    lines.push(`| ${i + 1} | **${t.title}** | ${cmdRef} — ${t.summary} |`)
  }

  lines.push("")
  lines.push("### Typical Cycle")
  lines.push("")
  lines.push(
    "1. **Configure profiles** — Set up lanes and model routing with " +
    "`/zflow-profile` before starting any work.",
  )
  lines.push(
    "2. **Set up agents** — Run `/zflow-setup-agents` to install custom " +
    "agents, chains, and prompt templates if not already installed.",
  )
  lines.push(
    "3. **Plan** — Enter plan mode with `/zflow-plan` to explore the " +
    "codebase and prepare a change brief without risk of mutations.",
  )
  lines.push(
    "4. **Prepare change** — Use `/zflow-change-prepare <change-path>` " +
    "to create a formal plan with execution groups and standards.",
  )
  lines.push(
    "5. **Review plan** — Use `/zflow-review-code` to review the plan " +
    "before implementation. Iterate as needed.",
  )
  lines.push(
    "6. **Implement change** — Run `/zflow-change-implement <change-path>` " +
    "to dispatch work to subagents in isolated worktrees.",
  )
  lines.push(
    "7. **Audit & fix** — Verify results with `/zflow-change-audit` " +
    "and apply fixes with `/zflow-change-fix`.",
  )
  lines.push(
    "8. **Review code** — Use `/zflow-review-code` to review the " +
    "implemented changes against the plan.",
  )
  lines.push(
    "9. **Clean up** — Run `/zflow-clean` to remove temporary " +
    "artifacts, worktrees, and state files.",
  )
  lines.push(
    "10. **Repeat** — Start the next cycle with a new profile switch " +
    "or planning mode session.",
  )
  lines.push("")
  lines.push(
    "_Type /zflow-help <topic> for detailed guidance on a specific area._",
  )

  return lines.join("\n")
}

/**
 * Render diagnostics information from the capability registry.
 */
async function renderDoctor(cwd?: string): Promise<string> {
  const registry = getZflowRegistry()
  const diags = registry.getDiagnostics()
  const caps = registry.getCapabilities()
  const cacheSummary = await readCacheSummary(cwd).catch(() => null)

  const lines: string[] = []
  lines.push("# pi-zflow Diagnostics")
  lines.push("")
  lines.push(`**${caps.size} capabilities registered**`)
  lines.push("")
  lines.push("| Capability | Provider | Version | Service |")
  lines.push("| ---------- | -------- | ------- | ------- |")
  for (const [name, cap] of caps) {
    lines.push(
      `| ${name} | ${cap.claim.provider} | ${cap.claim.version} | ` +
      `${cap.service !== undefined ? "✓" : "✗"} |`,
    )
  }
  lines.push("")
  lines.push("### Session and resume")
  lines.push("")
  lines.push("- Pi `/resume` restores prior **Pi sessions/conversations**.")
  lines.push("- zflow workflow recovery usually uses `/zflow-change-implement <change> --resume` and runtime artifacts, not a new Pi session.")
  lines.push("- Current default zflow change flows do **not** auto-fork a new implementation session after prepare.")
  lines.push("")
  lines.push("### Cache telemetry")
  lines.push("")
  if (cacheSummary) {
    lines.push(`- Health: **${cacheSummary.health}**`)
    lines.push(`- Session turns traced: **${cacheSummary.totalTurns}**`)
    lines.push(`- Provider/model: **${cacheSummary.provider ?? "unknown"} / ${cacheSummary.model ?? "unknown"}**`)
    lines.push(`- Stable prompt fingerprint: \`${shortHash(cacheSummary.stablePromptHash)}\``)
    lines.push(`- Volatile reminder fingerprint: \`${shortHash(cacheSummary.reminderHash)}\``)
    lines.push(`- Cache read/write tokens: **${cacheSummary.cacheReadTokens} / ${cacheSummary.cacheWriteTokens}**`)
    lines.push(`- Average cache hit rate: **${cacheSummary.averageCacheHitRate !== null ? `${(cacheSummary.averageCacheHitRate * 100).toFixed(1)}%` : "unknown"}**`)
    lines.push(`- Last regression cause: **${cacheSummary.lastRegressionCause ?? "none observed"}**`)
    lines.push(`- Recent compaction observed: **${cacheSummary.compactionOccurredRecently ? "yes" : "no"}**`)
  } else {
    lines.push("No cache telemetry recorded yet for the current runtime state.")
  }
  lines.push("")

  if (diags.length > 0) {
    lines.push("### Diagnostics")
    lines.push("")
    for (const d of diags) {
      lines.push(`- **[${d.level}]** ${d.message}`)
    }
    lines.push("")
  } else {
    lines.push("No diagnostics entries. All capability registrations look healthy.")
    lines.push("")
  }

  lines.push("---")
  lines.push("")
  lines.push(`**Child packages providing topics:** ${new Set(ALL_HELP_TOPICS.map((t) => t.packageName)).size}`)
  lines.push(`**Help topics loaded:** ${ALL_HELP_TOPICS.length}`)
  const commandCount = ALL_HELP_TOPICS.reduce((acc, t) => acc + t.commands.length, 0)
  lines.push(`**Commands documented:** ${commandCount}`)

  return lines.join("\n")
}
