/**
 * pi-zflow-compaction extension entrypoint
 *
 * Registers `session_before_compact` hooks and proactive compaction triggers.
 *
 * ## Capability
 *
 * Claims `"compaction"` via shared capability registry (`getZflowRegistry()`).
 * Duplicate loads are silently rejected. Coexists with `pi-rtk-optimizer`
 * which owns first-pass command rewriting and output compaction; this package
 * owns the `session_before_compact` hook and compaction handoff reminders.
 *
 * ## Behaviour
 *
 * - Proactive compaction at ~60% context usage with a cheap summarization model
 * - Falls back to default compaction if no cheap model is available or auth fails
 * - After compaction, injects the `compaction-handoff` reminder so the model
 *   rereads canonical file-backed artifacts before continuing
 * - Preserves references to canonical artifact paths (repo-map, reconnaissance,
 *   failure-log, active plans) in the compaction summary
 *
 * ## Usage
 *
 * ```ts
 * import activate from "pi-zflow-compaction"
 * // Pi extension loader calls activate(pi) automatically
 * ```
 *
 * @module pi-zflow-compaction
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { complete } from "@earendil-works/pi-ai"
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent"
import { getZflowRegistry } from "pi-zflow-core/registry"
import type { CapabilityClaim } from "pi-zflow-core/registry"
import { PI_ZFLOW_COMPACTION_VERSION } from "pi-zflow-core"
import {
  createCompactionService,
  getCompactionThreshold,
  chooseCheapCompactionModel,
  buildCompactionPrompt,
  getDefaultArtifactPaths,
} from "../../src/compaction-service.js"
import { ensureRtkOrAlert } from "../../src/rtk-check.js"
import { buildCompactionHandoffSection } from "../../src/reread-policy.js"

export default function activateZflowCompactionExtension(pi: ExtensionAPI): void {
  const registry = getZflowRegistry()

  // ── Capability claim ────────────────────────────────────────────

  const claim: CapabilityClaim = {
    capability: "compaction",
    version: PI_ZFLOW_COMPACTION_VERSION,
    provider: "pi-zflow-compaction",
    sourcePath: import.meta.url,
    compatibilityMode: "compatible",
  }

  const registered = registry.claim(claim)

  if (!registered) {
    // Another incompatible provider already claimed this capability
    return
  }

  // If the capability already has a service, another compatible instance
  // already initialised fully. No-op to avoid duplicate registration.
  if (registered.service !== undefined) {
    return
  }

  // ── Compaction service ──────────────────────────────────────────

  const compactionService = createCompactionService()
  registry.provide("compaction", compactionService)

  // ── State for handoff reminder injection ─────────────────────────

  // Set to true after a compaction cycle completes so the next agent start
  // receives the compaction-handoff reminder.
  let pendingCompactionHandoff = false

  // ── State for proactive compaction guard ─────────────────────────

  // Guards against repeatedly triggering compaction within the same high-usage
  // period.  Set when we proactively call ctx.compact(); cleared on
  // session_compact so a new cycle can be triggered after the compaction
  // finishes and usage climbs again.
  let compactionInProgress = false

  // Minimum token count that must have been consumed *after* the last
  // compaction before we consider triggering another one.  Avoids rapid
  // cycles when usage hovers just above the threshold.
  let lastCompactionTokens: number | null = null
  const MIN_TOKEN_DELTA = 5_000

  // ── Bootstrap: check rtk availability at startup ─────────────────

  // Non-blocking: alert the user if rtk is missing, but do not prevent
  // extension activation. Output compaction still works without rtk.
  ensureRtkOrAlert().catch(() => {
    // Silently ignore startup check failures — already alerted via console.warn
  })

  // ── Proactive compaction trigger (turn_end) ─────────────────────
  //
  // After every turn, check whether context usage has reached the
  // proactive threshold (60 %).  If so, kick off compaction via
  // ctx.compact() so that the session manager fires
  // session_before_compact on the *next* opportunity rather than waiting
  // until overflow.
  //
  // A guard flag (compactionInProgress) prevents repeated triggers
  // while a compaction is already underway.  The minimum-token-delta
  // check prevents rapid cycles when usage hovers just above the
  // threshold.

  pi.on("turn_end", (_event, ctx) => {
    if (compactionInProgress) {
      // A compaction we requested is still in flight or has just
      // finished — let usage climb again before re-evaluating.
      return {}
    }

    const threshold = getCompactionThreshold()

    // Check usage via the official context-usage API if available.
    const usage = ctx.getContextUsage()

    let shouldTrigger = false

    if (usage && usage.percent !== null) {
      shouldTrigger = usage.percent / 100 >= threshold
    } else if (usage && usage.tokens !== null && usage.contextWindow > 0) {
      // Fallback: compute ratio from raw token count.
      shouldTrigger = usage.tokens / usage.contextWindow >= threshold
    }
    // else: no usage data yet — skip this turn.

    if (!shouldTrigger) return {}

    // Minimum-token-delta guard: avoid re-compacting immediately.
    if (lastCompactionTokens !== null && usage && usage.tokens !== null) {
      const delta = usage.tokens - lastCompactionTokens
      if (delta < MIN_TOKEN_DELTA) {
        return {}
      }
    }

    // Trigger compaction.  The custom instruction tells the compaction
    // pipeline to preserve canonical artifact references.
    compactionInProgress = true
    if (usage && usage.tokens !== null) {
      lastCompactionTokens = usage.tokens
    }

    ctx.compact({
      customInstructions:
        "Preserve references to canonical artifacts (plan-state, repo-map, " +
        "reconnaissance, failure-log) so the model rereads them after compaction.",
    })

    return {}
  })

  // ── session_before_compact hook ─────────────────────────────────

  pi.on("session_before_compact", async (event, ctx) => {
    const { preparation, signal } = event
    const { tokensBefore, firstKeptEntryId, previousSummary, messagesToSummarize } = preparation

    // Use ctx.getContextUsage() to determine whether proactive compaction
    // is warranted.  This is more accurate than the old hard-coded 100k
    // window heuristic.  When the provider exposes usage data we rely on
    // that; otherwise we fall back to tokensBefore / contextWindow.
    const threshold = getCompactionThreshold()
    const usage = ctx.getContextUsage()

    let shouldCustomize = false

    if (usage && usage.percent !== null) {
      shouldCustomize = usage.percent / 100 >= threshold
    } else if (usage && usage.contextWindow > 0) {
      shouldCustomize = tokensBefore / usage.contextWindow >= threshold
    } else {
      // Fallback only when we have no context-usage data at all.
      shouldCustomize = tokensBefore > 30_000
    }

    if (!shouldCustomize) {
      // Below threshold — let default compaction handle it if needed
      return {}
    }

    // Try to find a cheap summarization model
    const model = chooseCheapCompactionModel(ctx.modelRegistry as Parameters<typeof chooseCheapCompactionModel>[0])

    if (!model) {
      ctx.ui.notify(
        "No cheap compaction model available; using default compaction behavior",
        "warning",
      )
      return {}
    }

    // Resolve request auth for the summarization model
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
    if (!auth.ok) {
      ctx.ui.notify(`Compaction auth failed: ${auth.error}`, "warning")
      return {}
    }
    if (!auth.apiKey) {
      ctx.ui.notify(`No API key for ${model.provider}, using default compaction`, "warning")
      return {}
    }

    // Combine all messages for summarization
    const allMessages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]

    ctx.ui.notify(
      `Proactive compaction: summarizing ${allMessages.length} messages ` +
      `(${tokensBefore.toLocaleString()} tokens) with ${model.id}...`,
      "info",
    )

    // Convert messages to readable text format
    const conversationText = serializeConversation(convertToLlm(allMessages))

    // Include previous summary context if available
    const previousContext = previousSummary
      ? `\n\nPrevious session summary for context:\n${previousSummary}`
      : ""

    // Build the compaction prompt with artifact path references
    const promptText = buildCompactionPrompt(
      messagesToSummarize.length,
      tokensBefore,
      !!previousSummary,
      getDefaultArtifactPaths(),
    )

    // Build summary messages
    const summaryMessages = [
      {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text: `${promptText}${previousContext}\n\n<conversation>\n${conversationText}\n</conversation>`,
          },
        ],
        timestamp: Date.now(),
      },
    ]

    try {
      const response = await complete(
        model,
        { messages: summaryMessages },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          maxTokens: 8192,
          signal,
        },
      )

      const summary = response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n")

      if (!summary.trim()) {
        if (!signal.aborted) {
          ctx.ui.notify("Compaction summary was empty; using default compaction", "warning")
        }
        return {}
      }

      // Signal that handoff reminder should be injected on next agent start
      pendingCompactionHandoff = true

      return {
        compaction: {
          summary,
          firstKeptEntryId,
          tokensBefore,
        },
      }
    } catch (error) {
      ctx.ui.notify(
        `Compaction with ${model.id} failed: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      )
      // Fall through to default compaction
      return {}
    }
  })

  // ── session_compact hook ────────────────────────────────────────

  pi.on("session_compact", (_event, ctx) => {
    // After successful compaction, flag that the next agent start should
    // receive the compaction-handoff reminder so it rereads canonical artifacts.
    pendingCompactionHandoff = true

    // Reset the proactive-trigger guard so a new compaction can be
    // triggered once usage climbs back above threshold.
    compactionInProgress = false

    // Persist a lightweight marker entry so the compaction fact and
    // canonical artifact paths survive session resume/reload.
    // On resume, before_agent_start can discover this entry via
    // ctx.sessionManager.getEntries() and re-inject the handoff.
    try {
      const now = new Date().toISOString()
      const paths = getDefaultArtifactPaths()
      // Workflow mode is not tracked by this module directly; it is
      // managed by pi-zflow-change-workflows.  The modes field is
      // a placeholder for discovery by sibling extensions.
      pi.appendEntry("zflow-compaction", {
        compactedAt: now,
        artifactPaths: paths,
        modes: [] as string[],
      })
    } catch {
      // Non-critical: marker entry is a best-effort persistence
      // enhancement.  Failure does not break compaction handoff
      // within the same session (pendingCompactionHandoff still works).
    }
  })

  // ── before_agent_start hook ─────────────────────────────────────

  pi.on("before_agent_start", async (event, ctx) => {
    if (!pendingCompactionHandoff) {
      return {}
    }

    // Clear the flag so the reminder is only injected once
    pendingCompactionHandoff = false

    // Build the enhanced compaction-handoff section with real fragment +
    // role-specific artifact reread reminders.
    const handoffSection = await buildCompactionHandoffSection()

    // Also check for persisted compaction entries from pi.appendEntry()
    // that were written during previous session compact cycles.  This
    // allows the handoff reminder to survive session resume/reload.
    let persistedPathsSection = ""
    try {
      if (ctx && typeof ctx.sessionManager?.getEntries === "function") {
        const entries = ctx.sessionManager.getEntries()
          .filter((e: { customType?: string }) => e.customType === "zflow-compaction")
        if (entries.length > 0) {
          // Use the most recent entry's artifact paths
          const last = entries[entries.length - 1] as unknown as {
            compactedAt?: string
            artifactPaths?: string[]
          }
          const paths = last.artifactPaths
          if (paths && paths.length > 0) {
            persistedPathsSection =
              "\n\n### Persisted compact marker\n" +
              "A previous compaction marker was found in session entries:\n" +
              paths.map((p: string) => `- \`<runtime-state-dir>/${p}\``).join("\n") +
              (last.compactedAt ? `\n\n_Compacted at: ${last.compactedAt}_` : "")
          }
        }
      }
    } catch {
      // Non-critical: persisted entry discovery is best-effort
    }

    return {
      systemPrompt: event.systemPrompt + `\n\n${handoffSection}${persistedPathsSection}`,
    }
  })
}
