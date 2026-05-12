/**
 * platform-docs.ts — Platform documentation section builder
 *
 * Builds the "Platform Documentation" markdown section that is injected into
 * the system prompt via the `before_agent_start` extension hook. It ensures
 * Pi and pi-zflow self-documentation awareness is preserved even when
 * `APPEND_SYSTEM.md` is used or when a user supplies a `SYSTEM.md` replacement.
 *
 * This is a pure utility — it does not import from the Pi SDK or have any
 * side effects. The extension code is responsible for resolving paths and
 * calling this function.
 *
 * @module
 */

// ── Types ────────────────────────────────────────────────────────

/** Paths for Pi's own documentation. */
export interface PiDocPaths {
  /** Absolute path to Pi's README.md */
  readmePath: string
  /** Absolute path to Pi's docs/ directory */
  docsPath: string
  /** Absolute path to Pi's examples/ directory */
  examplesPath: string
}

/** Paths for pi-zflow documentation assets. */
export interface ZflowDocPaths {
  /** Absolute path to the repo-level implementation plan */
  implementationPlanPath?: string
  /** Absolute path to the package-split contract */
  packageSplitContractPath?: string
  /** Absolute path to the agents/ directory */
  agentsPath?: string
  /** Absolute path to the prompt-fragments/ directory */
  promptFragmentsPath?: string
  /** Absolute path to the skills/ directory */
  skillsPath?: string
}

/** Options for building the documentation section. */
export interface PlatformDocsOptions {
  pi: PiDocPaths
  zflow: ZflowDocPaths
  /**
   * Marker string embedded as an HTML comment to detect duplicate injection.
   * Extensions check for this marker in `event.systemPrompt` before appending.
   */
  marker?: string
}

// ── Defaults ─────────────────────────────────────────────────────

/** Default marker comment for duplicate-injection detection. */
export const DEFAULT_DOCS_MARKER = "<!-- pi-zflow:platform-docs -->"

/** Pi documentation cross-reference topics. */
const PI_DOC_TOPICS =
  "extensions (docs/extensions.md, examples/extensions/), " +
  "themes (docs/themes.md), skills (docs/skills.md), " +
  "prompt templates (docs/prompt-templates.md), " +
  "TUI components (docs/tui.md), keybindings (docs/keybindings.md), " +
  "SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), " +
  "adding models (docs/models.md), pi packages (docs/packages.md)"

// ── Builder ──────────────────────────────────────────────────────

/**
 * Build the "Platform Documentation" markdown section.
 *
 * @returns The markdown string, including a leading newline and the marker
 *          comment for deduplication, or an empty string if no paths are
 *          available.
 */
export function buildPlatformDocsSection(options: PlatformDocsOptions): string {
  const { pi, zflow, marker = DEFAULT_DOCS_MARKER } = options

  // If neither Pi nor pi-zflow paths are available, return empty
  if (!pi.readmePath && !pi.docsPath && !zflow.agentsPath) {
    return ""
  }

  const lines: string[] = []
  lines.push("")
  lines.push("## Platform Documentation")
  lines.push("")

  // Pi documentation section
  if (pi.readmePath || pi.docsPath || pi.examplesPath) {
    lines.push("Pi documentation (read when asked about pi itself, its SDK, extensions, themes, skills, or TUI):")
    if (pi.readmePath) lines.push(`- Main documentation: ${pi.readmePath}`)
    if (pi.docsPath) lines.push(`- Additional docs: ${pi.docsPath}/`)
    if (pi.examplesPath) lines.push(`- Examples: ${pi.examplesPath}/ (extensions, custom tools, SDK)`)
    lines.push(`- When asked about: ${PI_DOC_TOPICS}`)
    lines.push("")
  }

  // pi-zflow documentation section
  if (zflow.implementationPlanPath || zflow.packageSplitContractPath || zflow.agentsPath || zflow.skillsPath) {
    lines.push("Pi Zflow documentation (read when asked about zflow itself, its packages, agents, or workflows):")
    if (zflow.implementationPlanPath) lines.push(`- Implementation plan: ${zflow.implementationPlanPath}`)
    if (zflow.packageSplitContractPath) lines.push(`- Package split contract: ${zflow.packageSplitContractPath}`)
    if (zflow.agentsPath) lines.push(`- Agent definitions: ${zflow.agentsPath}/`)
    if (zflow.promptFragmentsPath) lines.push(`- Prompt fragments: ${zflow.promptFragmentsPath}/`)
    if (zflow.skillsPath) lines.push(`- Skills: ${zflow.skillsPath}/`)
    lines.push("")
  }

  // Closing instruction
  lines.push(
    "When working on pi or pi-zflow topics, read the docs and examples, " +
    "and follow .md cross-references before implementing.",
  )
  lines.push("")
  lines.push(marker)
  lines.push("")

  return lines.join("\n")
}

/**
 * Check whether the docs section has already been injected into a system prompt.
 */
export function isPlatformDocsInjected(
  systemPrompt: string,
  marker: string = DEFAULT_DOCS_MARKER,
): boolean {
  return systemPrompt.includes(marker)
}
