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
import { PI_ZFLOW_PLAN_MODE_VERSION } from "pi-zflow-core"
import {
  activatePlanMode,
  deactivatePlanMode,
  getPlanModeStatus,
  isPlanModeActive,
} from "./state.js"

export default function activateZflowPlanModeExtension(pi: ExtensionAPI): void {
  const registry = getZflowRegistry()

  // Claim the "plan-mode" capability — guards against duplicate loads
  const claimed = registry.claim({
    capability: "plan-mode",
    version: PI_ZFLOW_PLAN_MODE_VERSION,
    provider: "pi-zflow-plan-mode",
    sourcePath: import.meta.url,
  })

  if (!claimed) {
    // Another compatible provider already claimed this capability
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
