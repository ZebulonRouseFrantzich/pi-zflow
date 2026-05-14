/**
 * pi-zflow-agents extension entrypoint
 *
 * Registers `/zflow-setup-agents`, `/zflow-update-agents`, and prompt helper commands.
 * Also injects platform documentation paths into the system prompt via `before_agent_start`.
 *
 * Provides the "agents" capability service with install/update/manifest operations
 * so sibling packages can check agent setup status or trigger installs via the
 * shared capability registry (see `registry.optional("agents")`).
 *
 * @module pi-zflow-agents
 */

import {
  buildPlatformDocsSection,
  isPlatformDocsInjected,
  DEFAULT_DOCS_MARKER,
  type PiDocPaths,
  type ZflowDocPaths,
} from "pi-zflow-core/platform-docs"
import { getZflowRegistry } from "pi-zflow-core/registry"
import { PI_ZFLOW_AGENTS_VERSION } from "pi-zflow-core"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { createRequire } from "node:module"
import { existsSync } from "node:fs"

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import {
  installAgentsAndChains,
  checkInstallStatus,
  formatInstallSummary,
} from "./install.js"
import type {
  InstallOptions,
  InstallResult,
} from "./install.js"
import {
  readManifest,
  writeManifest,
  diffManifest,
} from "./manifest.js"
import type { ManifestDiff } from "./manifest.js"

// ── Path resolution helpers ──────────────────────────────────────

/**
 * Resolve pi-zflow documentation paths relative to this extension's location.
 *
 * When running inside Pi's extension loader, `import.meta.url` points to
 * this file inside the installed pi-zflow-agents package. From there we can
 * navigate to sibling packages and the repo root.
 */
function resolveZflowDocPaths(extensionRoot: string): ZflowDocPaths {
  // The extension is at: <package-root>/extensions/zflow-agents/index.ts
  // Package root is two levels up
  const pkgRoot = resolve(extensionRoot, "..", "..")

  // Try to navigate to the umbrella package or repo root
  // When installed as a Pi package: node_modules/pi-zflow-agents/
  // When in a monorepo: packages/pi-zflow-agents/
  //
  // The repo root is where pi-zflow/package.json and pi-config-implementation-plan.md live.
  // From the agents package root, go up 2 more levels to reach repo root in monorepo layout
  let repoRoot = resolve(pkgRoot, "..", "..")

  let implementationPlanPath: string | undefined
  let packageSplitContractPath: string | undefined
  let agentsPath: string | undefined
  let promptFragmentsPath: string | undefined
  let skillsPath: string | undefined

  // Check monorepo layout first
  const implPlan = resolve(repoRoot, "pi-config-implementation-plan.md")
  if (existsSync(implPlan)) {
    implementationPlanPath = implPlan
    packageSplitContractPath = resolve(
      repoRoot,
      "implementation-phases",
      "package-split-details.md",
    )
    agentsPath = resolve(pkgRoot, "agents")
    promptFragmentsPath = resolve(pkgRoot, "prompt-fragments")
    skillsPath = resolve(pkgRoot, "skills")
  } else {
    // Fallback: when installed as standalone npm package, agents/skills/prompts
    // are inside the package itself
    repoRoot = pkgRoot
    implementationPlanPath = undefined
    packageSplitContractPath = undefined
    agentsPath = resolve(pkgRoot, "agents")
    promptFragmentsPath = resolve(pkgRoot, "prompt-fragments")
    skillsPath = resolve(pkgRoot, "skills")
  }

  return {
    implementationPlanPath,
    packageSplitContractPath,
    agentsPath: existsSync(agentsPath) ? agentsPath : undefined,
    promptFragmentsPath: existsSync(promptFragmentsPath) ? promptFragmentsPath : undefined,
    skillsPath: existsSync(skillsPath) ? skillsPath : undefined,
  }
}

/**
 * Resolve Pi's own documentation paths.
 *
 * Uses `createRequire` to find the Pi coding-agent package on disk, then
 * navigates to the standard documentation files. Gracefully degrades when
 * the package cannot be resolved (e.g. during testing without the Pi runtime).
 */
function resolvePiDocPaths(): PiDocPaths {
  const _require = createRequire(import.meta.url)
  let piRoot: string | undefined

  try {
    // Try to find the Pi coding-agent package on disk
    // This works both in global npm installs and local dev
    const piEntry = _require.resolve("@earendil-works/pi-coding-agent")
    piRoot = resolve(piEntry, "..", "..")

    // Verify: Pi's README.md should be at the root
    const readmeCandidate = resolve(piRoot, "README.md")
    if (!existsSync(readmeCandidate)) {
      // Try one level up (dist/ layout)
      piRoot = resolve(piRoot, "..")
    }
  } catch {
    // Graceful degradation: Pi path resolution failed
    piRoot = undefined
  }

  if (!piRoot) {
    return { readmePath: "", docsPath: "", examplesPath: "" }
  }

  const readmePath = resolve(piRoot, "README.md")
  const docsPath = resolve(piRoot, "docs")
  const examplesPath = resolve(piRoot, "examples")

  return {
    readmePath: existsSync(readmePath) ? readmePath : "",
    docsPath: existsSync(docsPath) ? docsPath : "",
    examplesPath: existsSync(examplesPath) ? examplesPath : "",
  }
}

// ── Agents service interface ───────────────────────────────────

/**
 * Service interface exposed through the zflow registry for sibling
 * packages that need agent/chain installation status and operations
 * without importing the agents module directly.
 */
export interface AgentsService {
  /** Install or update agents and chains from the package to user-level directories. */
  installAgentsAndChains: typeof installAgentsAndChains
  /** Check whether agent installation is up to date. */
  checkInstallStatus: typeof checkInstallStatus
  /** Build a human-readable summary of the installation result. */
  formatInstallSummary: typeof formatInstallSummary
  /** Read the install manifest from disk. */
  readManifest: typeof readManifest
  /** Write the install manifest to disk atomically. */
  writeManifest: typeof writeManifest
  /** Compare the manifest against the current package state. */
  diffManifest: typeof diffManifest
}

// ── Extension factory ────────────────────────────────────────────

export default function activateZflowAgentsExtension(pi: ExtensionAPI): void {
  // ── Platform documentation injection ────────────────────────────

  pi.on("before_agent_start", (event) => {
    // Check if the `read` tool is available. If read is disabled, skip
    // injection since the model cannot read documentation files anyway.
    const activeTools = event.systemPromptOptions.selectedTools
    if (activeTools && !activeTools.includes("read")) {
      // `read` tool is disabled — skip injection silently
      return {}
    }

    // Dedup: check if docs section was already injected
    if (isPlatformDocsInjected(event.systemPrompt)) {
      return {}
    }

    // Resolve paths
    const extensionRoot = dirname(fileURLToPath(import.meta.url))
    const piPaths = resolvePiDocPaths()
    const zflowPaths = resolveZflowDocPaths(extensionRoot)

    // Build the docs section
    const docsSection = buildPlatformDocsSection({
      pi: piPaths,
      zflow: zflowPaths,
    })

    if (!docsSection) {
      return {}
    }

    // Append to the system prompt
    return {
      systemPrompt: event.systemPrompt + docsSection,
    }
  })

  // ── Agent/chain setup commands — Phase 4/7 ──────────────────────
  // Claim the "agents" capability and register setup/update commands

  const registry = getZflowRegistry()

  const claimed = registry.claim({
    capability: "agents",
    version: PI_ZFLOW_AGENTS_VERSION,
    provider: "pi-zflow-agents",
    sourcePath: import.meta.url,
  })

  if (!claimed) return

  // If the capability already has a service, another compatible
  // instance already initialised fully. No-op to avoid duplicate
  // command registration (coexistence rule 7).
  if (claimed.service !== undefined) {
    return
  }

  // ── Build and provide the agents service ──────────────────────
  const agentsService: AgentsService = {
    installAgentsAndChains,
    checkInstallStatus,
    formatInstallSummary,
    readManifest,
    writeManifest,
    diffManifest,
  }

  registry.provide("agents", agentsService)

  pi.registerCommand("zflow-setup-agents", {
    description: "Install pi-zflow agent markdown files and chains into Pi-subagents discovery directories",
    handler: async (args: string, ctx: {
      ui: { notify: (message: string, type?: "info" | "warning" | "error") => void }
    }): Promise<void> => {
      const force = args.trim() === "--force"
      const { installAgentsAndChains, formatInstallSummary } = await import("./install.js")

      ctx.ui.notify(
        force
          ? "Setting up agents (force mode)..."
          : "Setting up agents...",
      )

      try {
        const result = await installAgentsAndChains({ force })

        if (result.success) {
          ctx.ui.notify("Agent setup completed successfully.", "info")
          ctx.ui.notify(formatInstallSummary(result, false), "info")
        } else {
          ctx.ui.notify(
            `Agent setup completed with ${result.errors.length} error(s).`,
            "warning",
          )
          ctx.ui.notify(formatInstallSummary(result, false), "warning")
        }
      } catch (err: unknown) {
        ctx.ui.notify(
          `Agent setup failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        )
      }
    },
  })

  pi.registerCommand("zflow-update-agents", {
    description: "Update installed pi-zflow agents and chains to the latest package version",
    handler: async (args: string, ctx: {
      ui: { notify: (message: string, type?: "info" | "warning" | "error") => void }
    }): Promise<void> => {
      const force = args.trim() === "--force"
      const { installAgentsAndChains, formatInstallSummary, checkInstallStatus } = await import("./install.js")

      const diff = await checkInstallStatus()

      if (diff && !diff.needsUpdate) {
        ctx.ui.notify("Agents are already up to date.", "info")
        return
      }

      ctx.ui.notify(
        force
          ? "Updating agents (force mode)..."
          : "Updating agents...",
      )

      try {
        const result = await installAgentsAndChains({ force, update: true })

        if (result.success) {
          ctx.ui.notify("Agent update completed successfully.", "info")
          ctx.ui.notify(formatInstallSummary(result, true), "info")
        } else {
          ctx.ui.notify(
            `Agent update completed with ${result.errors.length} error(s).`,
            "warning",
          )
          ctx.ui.notify(formatInstallSummary(result, true), "warning")
        }
      } catch (err: unknown) {
        ctx.ui.notify(
          `Agent update failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        )
      }
    },
  })
}
