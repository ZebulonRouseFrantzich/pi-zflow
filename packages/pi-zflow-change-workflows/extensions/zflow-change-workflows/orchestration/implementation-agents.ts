import { DISPATCH_SERVICE_CAPABILITY, type DispatchService } from "pi-zflow-core/dispatch-service"
import { getZflowRegistry } from "pi-zflow-core/registry"

import { parseExecutionGroupsMd } from "./execution-groups.js"

export const CANONICAL_ROLE_LABELS = [
  "backend-api",
  "sdk-client",
  "cli-integrations",
] as const

const DEFAULT_IMPLEMENTATION_AGENT_PREFERENCES = [
  "worker",
  "zflow.implement-routine",
  "implement-routine",
  "zflow.implement-hard",
  "implement-hard",
]

const COMPLEX_IMPLEMENTATION_AGENT_PREFERENCES = [
  "zflow.implement-hard",
  "implement-hard",
  "worker",
  "zflow.implement-routine",
  "implement-routine",
]

export interface ImplementationAgentGuidance {
  roleLabels: string[]
  availableAgents: string[]
  implementationAgents: string[]
  defaultAgent: string
  complexAgent: string
}

export interface ImplementationAgentResolution {
  requested: string
  resolved: string
  changed: boolean
  roleLabel?: string
  reason: "unchanged" | "alias" | "role-label" | "unknown"
}

function stripBackticks(value: string): string {
  return value.trim().replace(/^`|`$/g, "").trim()
}

function stripKnownNamespace(value: string): string {
  return value.startsWith("zflow.") ? value.slice("zflow.".length) : value
}

function unique(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(Boolean))]
}

function aliasCandidates(agentName: string): string[] {
  const normalized = stripBackticks(agentName)
  if (!normalized) return []
  const short = stripKnownNamespace(normalized)
  const candidates = [normalized, short]
  if (!normalized.startsWith("zflow.")) {
    candidates.push(`zflow.${normalized}`)
  }
  return unique(candidates)
}

export function matchesKnownAgentName(agentName: string, candidates: string[]): string | undefined {
  for (const candidate of aliasCandidates(agentName)) {
    const match = candidates.find((known) => known === candidate)
    if (match) return match
  }

  const short = stripKnownNamespace(stripBackticks(agentName)).toLowerCase()
  return candidates.find((known) => stripKnownNamespace(known).toLowerCase() === short)
}

function looksLikeImplementationAgent(agentName: string): boolean {
  const short = stripKnownNamespace(agentName).toLowerCase()
  return short === "worker" || short.includes("implement") || short.includes("worker")
}

function pickPreferredAgent(preferences: string[], candidates: string[]): string | undefined {
  for (const preferred of preferences) {
    const match = matchesKnownAgentName(preferred, candidates)
    if (match) return match
  }
  return candidates[0]
}

function normalizeListedAgentName(entry: string | { name?: unknown }): string | undefined {
  if (typeof entry === "string") return entry.trim() || undefined
  if (typeof entry?.name === "string") return entry.name.trim() || undefined
  return undefined
}

export function isCanonicalRoleLabel(value: string): boolean {
  return CANONICAL_ROLE_LABELS.includes(stripBackticks(value) as (typeof CANONICAL_ROLE_LABELS)[number])
}

export async function listDiscoverableDispatchAgents(cwd?: string): Promise<string[]> {
  const dispatch = getZflowRegistry().optional<DispatchService>(DISPATCH_SERVICE_CAPABILITY)
  if (!dispatch || typeof dispatch.listAgents !== "function") return []

  try {
    const listed = await dispatch.listAgents(cwd)
    return unique((listed ?? []).map(normalizeListedAgentName).filter((value): value is string => Boolean(value)))
  } catch {
    return []
  }
}

export async function resolveImplementationAgentGuidance(cwd?: string): Promise<ImplementationAgentGuidance> {
  const availableAgents = await listDiscoverableDispatchAgents(cwd)
  let implementationAgents = availableAgents.filter(looksLikeImplementationAgent)

  if (implementationAgents.length === 0) {
    implementationAgents = ["zflow.implement-routine", "zflow.implement-hard"]
  }

  const defaultAgent = pickPreferredAgent(DEFAULT_IMPLEMENTATION_AGENT_PREFERENCES, implementationAgents) ?? implementationAgents[0]!
  const complexAgent = pickPreferredAgent(COMPLEX_IMPLEMENTATION_AGENT_PREFERENCES, implementationAgents) ?? defaultAgent

  return {
    roleLabels: [...CANONICAL_ROLE_LABELS],
    availableAgents,
    implementationAgents,
    defaultAgent,
    complexAgent,
  }
}

export function normalizeImplementationAgentName(
  agentName: string,
  guidance: ImplementationAgentGuidance,
): ImplementationAgentResolution {
  const requested = stripBackticks(agentName)
  if (!requested) {
    return {
      requested,
      resolved: guidance.defaultAgent,
      changed: true,
      reason: "unknown",
    }
  }

  const matchedImplementationAgent = matchesKnownAgentName(requested, guidance.implementationAgents)
  if (matchedImplementationAgent) {
    return {
      requested,
      resolved: matchedImplementationAgent,
      changed: matchedImplementationAgent !== requested,
      reason: matchedImplementationAgent === requested ? "unchanged" : "alias",
    }
  }

  if (guidance.availableAgents.length > 0) {
    const matchedAvailableAgent = matchesKnownAgentName(requested, guidance.availableAgents)
    if (matchedAvailableAgent) {
      return {
        requested,
        resolved: matchedAvailableAgent,
        changed: matchedAvailableAgent !== requested,
        reason: matchedAvailableAgent === requested ? "unchanged" : "alias",
      }
    }
  }

  if (isCanonicalRoleLabel(requested)) {
    return {
      requested,
      resolved: guidance.defaultAgent,
      changed: guidance.defaultAgent !== requested,
      roleLabel: requested,
      reason: "role-label",
    }
  }

  return {
    requested,
    resolved: requested,
    changed: false,
    reason: "unknown",
  }
}

export function buildImplementationAgentPromptLines(guidance: ImplementationAgentGuidance): string[] {
  const implementationAgents = guidance.implementationAgents.map((agent) => `\`${agent}\``).join(", ")
  const roleLabels = guidance.roleLabels.map((label) => `\`${label}\``).join(", ")

  return [
    "### CRITICAL: Dispatchable agent names vs human role labels",
    "",
    `Use ONLY these real implementation agent names in \`**Agent:**\`: ${implementationAgents}`,
    `If you want a human ownership label, add optional \`**Role label:**\` using one of: ${roleLabels}`,
    "Do NOT put role labels like `backend-api`, `sdk-client`, or `cli-integrations` in `**Agent:**`.",
    guidance.complexAgent !== guidance.defaultAgent
      ? `Use \`${guidance.defaultAgent}\` for routine groups. Use \`${guidance.complexAgent}\` only for unusually complex or risky groups.`
      : `Use \`${guidance.defaultAgent}\` for implementation groups in this environment.`,
    guidance.availableAgents.length > 0
      ? `Discovered dispatch agents in the active environment: ${guidance.availableAgents.map((agent) => `\`${agent}\``).join(", ")}`
      : "No dispatch-time agent discovery was available, so the guidance above falls back to zflow's canonical implementation agents.",
  ]
}

export function canonicalizeExecutionGroupsAgentFields(
  markdown: string,
  guidance: ImplementationAgentGuidance,
): { content: string; changed: boolean } {
  let changed = false

  const content = markdown
    .replace(
      /^(\s*(?:[-*+]\s+)?)\*\*(Owner\s+agent|Agent|Owner):\*\*\s+`?([^`\n]+)`?\s*$/gim,
      (_, prefix: string, _fieldName: string, rawValue: string) => {
        const resolution = normalizeImplementationAgentName(rawValue, guidance)
        if (resolution.reason === "role-label") {
          changed = true
          return `${prefix}**Role label:** ${resolution.roleLabel}\n${prefix}**Agent:** ${resolution.resolved}`
        }
        if (_fieldName.toLowerCase() !== "agent" || resolution.changed) {
          changed = true
          return `${prefix}**Agent:** ${resolution.resolved}`
        }
        return _
      },
    )
    .replace(
      /^(\s*)(Owner\s+agent|Agent|Owner):\s+`?([^`\n]+)`?\s*$/gim,
      (_, indent: string, _fieldName: string, rawValue: string) => {
        const resolution = normalizeImplementationAgentName(rawValue, guidance)
        if (resolution.reason === "role-label") {
          changed = true
          return `${indent}Role label: ${resolution.roleLabel}\n${indent}Agent: ${resolution.resolved}`
        }
        if (_fieldName.toLowerCase() !== "agent" || resolution.changed) {
          changed = true
          return `${indent}Agent: ${resolution.resolved}`
        }
        return _
      },
    )

  return { content, changed }
}

export function canonicalizeImplementationTasksAgentFields(
  markdown: string,
  guidance: ImplementationAgentGuidance,
): { content: string; changed: boolean } {
  let changed = false

  const content = markdown.replace(
    /^(\s*)Assigned agent:\s+`?([^`\n]+)`?(\s*)$/gim,
    (_, indent: string, rawValue: string, trailing: string) => {
      const resolution = normalizeImplementationAgentName(rawValue, guidance)
      const suffix = trailing || "  "
      if (resolution.reason === "role-label") {
        changed = true
        return `${indent}Assigned role label: \`${resolution.roleLabel}\`${suffix}\n${indent}Assigned agent: \`${resolution.resolved}\`${suffix}`
      }
      if (resolution.changed) {
        changed = true
        return `${indent}Assigned agent: \`${resolution.resolved}\`${suffix}`
      }
      return _
    },
  )

  return { content, changed }
}

export function backfillImplementationTasksLikelyFiles(
  markdown: string,
  executionGroupsMarkdown: string,
): { content: string; changed: boolean } {
  const executionGroups = parseExecutionGroupsMd(executionGroupsMarkdown)
  if (executionGroups.length === 0) {
    return { content: markdown, changed: false }
  }

  const filesByGroupId = new Map(
    executionGroups.map((group) => [group.id, group.files.filter(Boolean)]),
  )

  let changed = false
  const sections = markdown.split(/(?=^##\s+Group\s+)/m)
  const nextSections = sections.map((section, index) => {
    if (index === 0) return section

    const groupIdMatch = section.match(/^Group ID:\s*`([^`]+)`/m)
    const groupId = groupIdMatch?.[1]?.trim()
    if (!groupId) return section

    const files = filesByGroupId.get(groupId) ?? []
    if (files.length === 0) return section

    const blockPattern = /(### Likely files touched\s*\n\s*\n\| File \| Operation \| Reason \| Notes \|\n\| --- \| --- \| --- \| --- \|\n)([\s\S]*?)(?=\n### Context to read first)/m
    const blockMatch = section.match(blockPattern)
    if (!blockMatch) return section

    const existingRows = blockMatch[2] ?? ""
    const hasPlaceholder = existingRows.includes("No files listed in execution-groups.md; stop and report a plan-quality gap before editing.")
    const hasConcreteFile = files.some((file) => existingRows.includes(`\`${file}\``))
    if (!hasPlaceholder && hasConcreteFile) return section

    const replacementRows = files
      .map((file) => `| \`${file}\` | modify | Required by ${groupId} scope | Follow existing local patterns before editing |`)
      .join("\n") + "\n"

    const nextSection = section.replace(blockPattern, `$1${replacementRows}`)
    if (nextSection !== section) changed = true
    return nextSection
  })

  return {
    content: nextSections.join(""),
    changed,
  }
}
