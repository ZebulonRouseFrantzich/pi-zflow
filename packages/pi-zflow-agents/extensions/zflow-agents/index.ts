/**
 * pi-zflow-agents extension entrypoint
 *
 * Registers `/zflow-setup-agents`, `/zflow-update-agents`, and prompt helper commands.
 * Also injects platform documentation paths into the system prompt via `before_agent_start`.
 *
 * TODO(phase-4): Implement agent/chain setup flow.
 *   - claim("agents", ...) via getZflowRegistry()
 *   - provide("agents", agentsService) with install/update/manifest logic
 *   - Register `/zflow-setup-agents`, `/zflow-update-agents` commands
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
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { createRequire } from "node:module"

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

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

  // Verify by checking for the implementation plan
  const { existsSync } = require("fs") as typeof import("fs")
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
 * Uses `require.resolve` to find the Pi agent package on disk, then
 * navigates to the standard documentation files.
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
    const { existsSync } = require("fs") as typeof import("fs")
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

  const { existsSync } = require("fs") as typeof import("fs")
  const readmePath = resolve(piRoot, "README.md")
  const docsPath = resolve(piRoot, "docs")
  const examplesPath = resolve(piRoot, "examples")

  return {
    readmePath: existsSync(readmePath) ? readmePath : "",
    docsPath: existsSync(docsPath) ? docsPath : "",
    examplesPath: existsSync(examplesPath) ? examplesPath : "",
  }
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

  // ── Agent/chain setup commands — Phase 4 ─────────────────────────
  // TODO(phase-4): Implement agent/chain setup flow.
  //   - claim("agents", ...) via getZflowRegistry()
  //   - provide("agents", agentsService)
  //   - Register /zflow-setup-agents, /zflow-update-agents
}
