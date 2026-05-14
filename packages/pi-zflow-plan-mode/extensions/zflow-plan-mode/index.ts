/**
 * pi-zflow-plan-mode extension entrypoint
 *
 * Registers `/zflow-plan` commands, active-tool restriction, and read-only bash policy.
 *
 * ## Commands
 *
 * - `/zflow-plan` — toggle plan mode on/off
 * - `/zflow-plan status` — show current plan mode state
 * - `/zflow-plan exit` — exit plan mode
 *
 * ## Capability
 *
 * Claims `"plan-mode"` via shared capability registry (`getZflowRegistry()`).
 * Duplicate loads are silently rejected.
 *
 * ## Usage
 *
 * ```ts
 * import activate from "pi-zflow-plan-mode"
 * // Pi extension loader calls activate(pi) automatically
 * ```
 *
 * @module pi-zflow-plan-mode
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { getZflowRegistry } from "pi-zflow-core/registry"
import type { CapabilityClaim } from "pi-zflow-core/registry"
import { PI_ZFLOW_PLAN_MODE_VERSION } from "pi-zflow-core"
import {
  activatePlanMode,
  deactivatePlanMode,
  getPlanModeStatus,
  isPlanModeActive,
} from "./state.js"
import { validatePlanModeBash } from "./bash-policy.js"
import { loadFragment } from "pi-zflow-agents"

export default function activateZflowPlanModeExtension(pi: ExtensionAPI): void {
  const registry = getZflowRegistry()

  // Claim the "plan-mode" capability — guards against duplicate loads
  const claim: CapabilityClaim = {
    capability: "plan-mode",
    version: PI_ZFLOW_PLAN_MODE_VERSION,
    provider: "pi-zflow-plan-mode",
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

  // ── Plan mode service ────────────────────────────────────────────

  const planModeService = {
    getPlanModeStatus,
    activatePlanMode: (source?: string) => activatePlanMode(source ?? "zflow-plan"),
    deactivatePlanMode,
    isPlanModeActive,
  }

  registry.provide("plan-mode", planModeService)

  // ── Tool restriction hooks ──────────────────────────────────────

  // When plan mode is active, reduce available tools to read-only exploration
  // and intercept bash commands to reject mutations.
  pi.on("before_agent_start", async (event) => {
    if (!isPlanModeActive()) {
      return {}
    }

    // Restrict available tools: exclude edit, write, and mutation-capable tools
    const restrictedTools = [
      "read", "bash", "grep", "find", "ls",
      "web_search", "code_search", "fetch_content",
      "get_search_content", "interview", "subagent",
      "read_notebook", "contact_supervisor", "intercom",
    ]

    // Load the plan-mode prompt fragment for injection
    let planModeFragment = ""
    try {
      planModeFragment = await loadFragment("plan-mode")
    } catch {
      // Fallback: inject a simple reminder if the fragment file is unavailable
      planModeFragment = "## Plan Mode Active\n\n" +
        "You are in read-only plan mode. Source code mutations are blocked. " +
        "Focus on analysis, exploration, and planning. Do not attempt to edit or write files. " +
        "Use `bash` for read-only exploration commands only."
    }

    return {
      systemPrompt: event.systemPrompt + `\n\n${planModeFragment}`,
      selectedTools: restrictedTools,
    }
  })

  // Intercept tool calls to enforce plan mode restrictions
  pi.on("before_tool_call", (event) => {
    if (!isPlanModeActive()) {
      return {}
    }

    // Block edit and write tools entirely
    if (event.toolName === "edit" || event.toolName === "write") {
      return {
        blocked: true,
        message: `Tool "${event.toolName}" is blocked in plan mode. Use read-only exploration (read, grep, find, bash).`,
      }
    }

    // Intercept bash commands to reject mutations
    if (event.toolName === "bash") {
      const command = event.args?.command ?? ""
      const result = validatePlanModeBash(command)
      if (!result.allowed) {
        return {
          blocked: true,
          message: `Blocked in plan mode: ${result.reason}\n\nCommand: ${command}\n\nUse read-only commands (cat, ls, grep, find, git log, git diff, git status) instead.`,
        }
      }
    }

    return {}
  })

  // ── Command: /zflow-plan ────────────────────────────────────────

  pi.registerCommand("zflow-plan", {
    description: "Toggle read-only planning mode. Use 'status' to inspect, 'exit' to deactivate.",
    handler: async (args: string, ctx: {
      ui: { notify: (message: string, type?: "info" | "warning" | "error") => void }
    }): Promise<void> => {
      const subcommand = args.trim()

      if (subcommand === "status") {
        const status = getPlanModeStatus()
        const parts = [`Plan mode: ${status.state}`]
        if (status.activatedAt) {
          parts.push(`(since ${status.activatedAt})`)
        }
        if (status.activationSource) {
          parts.push(`[activated via: ${status.activationSource}]`)
        }
        ctx.ui.notify(parts.join(" "))
        return
      }

      if (subcommand === "exit") {
        if (!isPlanModeActive()) {
          ctx.ui.notify("Plan mode is not active.", "warning")
          return
        }
        deactivatePlanMode()
        ctx.ui.notify("Plan mode deactivated. Normal editing is restored.")
        return
      }

      // Toggle (default behavior with no subcommand)
      if (isPlanModeActive()) {
        deactivatePlanMode()
        ctx.ui.notify("Plan mode deactivated. Normal editing is restored.")
      } else {
        activatePlanMode("zflow-plan")
        ctx.ui.notify(
          "Plan mode activated.\n" +
          "• Read-only exploration is enabled.\n" +
          "• Source mutations are blocked.\n" +
          "• Your requests to implement will be treated as planning requests until you run /zflow-plan exit.",
        )
      }
    },
  })
}
