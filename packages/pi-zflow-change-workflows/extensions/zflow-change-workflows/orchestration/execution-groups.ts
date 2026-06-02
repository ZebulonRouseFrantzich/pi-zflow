/**
 * execution-groups.ts — parsing and coalescing helpers for execution-groups.md.
 */

// ── Execution groups parsing ──────────────────────────────────

/**
 * Parse execution-groups.md content into ExecutionGroup objects.
 *
 * Accepts several heading formats to be resilient to LLM output variance:
 *
 * ```markdown
 * ## Group 1: descriptive name
 * ## G1 — descriptive name
 * ## Execution Group 1: descriptive name
 * # Group 1: descriptive name          (h1 also accepted)
 * ```
 *
 * Field keys are matched with or without leading `- ` bullet and with or
 * without the "Scoped" prefix on verification:
 *
 * ```markdown
 * **Files:** path/to/file.ts, another/file.ts
 * - **Files:** path/to/file.ts, another/file.ts
 * **Verification:** optional scoped verification text
 * - **Scoped verification:** optional scoped verification text
 * ```
 */
export function parseExecutionGroupsMd(mdContent: string): DispatchExecutionGroup[] {
  const groups: DispatchExecutionGroup[] = []
  const lines = mdContent.split("\n")
  let currentGroup: Partial<DispatchExecutionGroup> | null = null
  let collectingFiles = false
  let collectingDependencies = false
  let collectingVerification = false
  let inVerificationFence = false

  const normalizeDependency = (dependency: string): string => {
    const trimmed = dependency.trim().replace(/^`|`$/g, "").replace(/^\[|\]$/g, "").trim()
    if (!trimmed) return ""

    const withoutGroupWord = trimmed.replace(/^Groups?\s+/i, "").trim()
    if (/^G[A-Za-z]?\d+[A-Za-z]?$/i.test(withoutGroupWord)) {
      return `group-${withoutGroupWord.toLowerCase()}`
    }

    // Bare alphanumeric group ID: "1A", "A1", "2", "b3"
    const bareMatch = withoutGroupWord.match(/^([A-Za-z]?\d+[A-Za-z]?|\d+[A-Za-z]?)$/i)
    if (bareMatch) return `group-${bareMatch[1].toLowerCase()}`
    return trimmed
  }

  const extractGroupDependencies = (value: string): string[] => {
    const dependencies: string[] = []
    const rangePattern = /\b(?:G|Groups?)\s*(\d+)([A-Za-z])\s*(?:-|–|—|to)\s*(?:(\d+))?([A-Za-z])\b/gi
    let rangeMatch: RegExpExecArray | null
    while ((rangeMatch = rangePattern.exec(value)) !== null) {
      const startNumber = Number.parseInt(rangeMatch[1]!, 10)
      const startLetter = rangeMatch[2]!.toLowerCase()
      const endNumber = Number.parseInt(rangeMatch[3] ?? rangeMatch[1]!, 10)
      const endLetter = rangeMatch[4]!.toLowerCase()

      if (startNumber === endNumber && startLetter.length === 1 && endLetter.length === 1) {
        const startCode = startLetter.charCodeAt(0)
        const endCode = endLetter.charCodeAt(0)
        if (startCode <= endCode) {
          for (let code = startCode; code <= endCode; code++) {
            dependencies.push(`group-${startNumber}${String.fromCharCode(code)}`)
          }
        }
      } else if (startNumber <= endNumber) {
        dependencies.push(`group-${startNumber}${startLetter}`)
        dependencies.push(`group-${endNumber}${endLetter}`)
      }
    }

    const gRefPattern = /\bG([A-Za-z]?\d+[A-Za-z]?|\d+[A-Za-z]?)\b/gi
    let match: RegExpExecArray | null
    while ((match = gRefPattern.exec(value)) !== null) {
      dependencies.push(`group-g${match[1]!.toLowerCase()}`)
    }

    const groupWordPattern = /\bGroups?\s+([A-Za-z]?\d+[A-Za-z]?|\d+[A-Za-z]?)\b/gi
    while ((match = groupWordPattern.exec(value)) !== null) {
      dependencies.push(normalizeDependency(match[1]!))
    }

    // Dependency prose often uses a single plural prefix followed by a list,
    // e.g. "Groups 1A and 1B" or "Groups 1A, 1B, and 1C". After the prefix,
    // later IDs may not repeat "Group", so collect alphanumeric group tokens
    // from that list-like tail as well. Numeric-only refs are handled above
    // when directly prefixed by Group/G to avoid confusing prose numbers with
    // group IDs.
    if (/\bGroups?\b/i.test(value)) {
      const alphanumericRefs = value.match(/\b[A-Za-z]?\d+[A-Za-z]?\b/g) ?? []
      for (const ref of alphanumericRefs) {
        if (/^[A-Za-z]?\d+[A-Za-z]?$/.test(ref)) {
          dependencies.push(`group-${ref.toLowerCase()}`)
        }
      }
    }

    return [...new Set(dependencies)]
  }

  const appendDependencies = (value: string): void => {
    if (!currentGroup) return
    const extracted = extractGroupDependencies(value)
    if (extracted.length === 0) return
    currentGroup.dependencies = [...new Set([...(currentGroup.dependencies ?? []), ...extracted])]
  }

  const appendVerification = (value: string): void => {
    if (!currentGroup) return
    const trimmed = value.trim()
    if (!trimmed || trimmed.startsWith("````".slice(0, 3))) return
    currentGroup.scopedVerification = [currentGroup.scopedVerification, trimmed].filter(Boolean).join("\n")
  }

  const isNextGroupSubsection = (value: string): boolean => {
    return /^(Expected outcome|Expected verification outcome|Expected outcome \/ acceptance criteria|Acceptance criteria|Self-checks|Drift trigger|reviewTags|Manual checks|Implementation task spec|Implementation notes):/i.test(value.trim())
  }

  const pushCurrentGroup = (): void => {
    if (!currentGroup?.id) return
    groups.push({
      id: currentGroup.id,
      files: currentGroup.files ?? [],
      dependencies: currentGroup.dependencies ?? [],
      agent: currentGroup.agent ?? "zflow.implement-routine",
      parallelizable: currentGroup.parallelizable ?? true,
      taskPrompt: currentGroup.taskPrompt ?? "",
      scopedVerification: currentGroup.scopedVerification,
      executionMode: currentGroup.executionMode ?? "isolated",
      workspaceConcurrency: currentGroup.workspaceConcurrency ?? "serialized",
      baseStrategy: currentGroup.baseStrategy ?? "head",
      workspaceId: currentGroup.workspaceId,
      executionRationale: currentGroup.executionRationale,
    })
  }

  for (const line of lines) {
    // Accept h1-h4 headings: ## Group 1: Name, # Group 1: Name,
    // ## G1 — Name, ## Execution Group 1: Name.
    // Group IDs may be digit-first (1, 1A) or letter-first (A1, B2, C3a).
    const groupMatch = line.match(/^#{1,4}\s+Group\s+([A-Za-z]?\d+[A-Za-z]?|\d+[A-Za-z]?)\s*(?::|[—-])\s+(.+)$/i) ??
      line.match(/^#{1,4}\s+G([A-Za-z]?\d+[A-Za-z]?|\d+[A-Za-z]?)\s+[—-]\s+(.+)$/i) ??
      line.match(/^#{1,4}\s+Execution\s+Group\s+([A-Za-z]?\d+[A-Za-z]?|\d+[A-Za-z]?)\s*(?::|[—-])\s+(.+)$/i)
    if (groupMatch) {
      pushCurrentGroup()
      currentGroup = {
        id: `group-${groupMatch[1].toLowerCase()}`,
        files: [],
        dependencies: [],
        agent: "zflow.implement-routine",
        taskPrompt: groupMatch[2],
        parallelizable: true,
        executionMode: "isolated",
        workspaceConcurrency: "serialized",
        baseStrategy: "head",
      }
      collectingFiles = false
      collectingDependencies = false
      collectingVerification = false
      inVerificationFence = false
      continue
    }

    if (!currentGroup) continue

    if (/^#{1,6}\s+/.test(line)) {
      collectingFiles = false
      collectingDependencies = false
      collectingVerification = false
      inVerificationFence = false
    }

    const filesHeaderMatch = line.match(/-\s+\*\*Files?(?:\/paths)?:\*\*\s*$/i) ??
      line.match(/^\*\*Files?(?:\/paths)?:\*\*\s*$/i) ??
      line.match(/^Files?(?:\s+touched)?(?:\/paths)?(?:\s*\([^)]*\))?:\s*$/i) ??
      line.match(/^\*\*Primary\s+files?(?:\/paths)?\s+touched:\*\*\s*$/i)
    if (filesHeaderMatch) {
      collectingFiles = true
      collectingDependencies = false
      collectingVerification = false
      continue
    }

    const filesMatch = line.match(/-\s+\*\*Files?(?:\/paths)?:\*\*\s+(.+)/i) ??
      line.match(/^\*\*Files?(?:\/paths)?:\*\*\s+(.+)/i) ??
      line.match(/^\*\*Primary\s+files?(?:\/paths)?\s+touched:\*\*\s+(.+)/i) ??
      line.match(/^Files?(?:\s+touched)?(?:\/paths)?(?:\s*\([^)]*\))?:\s+(.+)$/i)
    if (filesMatch) {
      currentGroup.files = filesMatch[1].split(",").map((f: string) => f.trim()).filter(Boolean)
      collectingFiles = false
      continue
    }

    if (collectingFiles) {
      const fileItemMatch = line.match(/^\s*(?:[-*]|\d+\.)\s+`?([^`\n]+?)`?(?:\s+\(new\))?\s*$/)
      if (fileItemMatch && !fileItemMatch[1].startsWith("**")) {
        currentGroup.files = [...(currentGroup.files ?? []), fileItemMatch[1].trim()]
        continue
      }
      if (line.trim().startsWith("- **") || line.trim().startsWith("**") || /^[A-Z][A-Za-z\s]+:/.test(line.trim())) collectingFiles = false
    }

    const agentMatch = line.match(/-\s+\*\*Agent:\*\*\s+(.+)/i) ??
      line.match(/^\*\*Agent:\*\*\s+(.+)/i) ??
      line.match(/-\s+\*\*Owner\s+agent:\*\*\s+(.+)/i) ??
      line.match(/^\*\*Owner\s+agent:\*\*\s+(.+)/i) ??
      line.match(/^Owner agent:\s+`?([^`\n]+)`?/i)
    if (agentMatch) {
      currentGroup.agent = agentMatch[1].trim().replace(/^`|`$/g, "").trim()
      continue
    }

    const ownerMatch = line.match(/-\s+\*\*Owner:\*\*\s+`?([^`\n]+)`?/i) ??
      line.match(/^\*\*Owner:\*\*\s+`?([^`\n]+)`?/i)
    if (ownerMatch) {
      currentGroup.agent = ownerMatch[1].trim().replace(/^`|`$/g, "").trim()
      continue
    }

    const taskMatch = line.match(/-\s+\*\*Task:\*\*\s+(.+)/i) ??
      line.match(/^\*\*Task:\*\*\s+(.+)/i) ??
      line.match(/^Task description:\s+(.+)/i)
    if (taskMatch) {
      currentGroup.taskPrompt = taskMatch[1].trim()
      continue
    }

    const depMatch = line.match(/-\s+\*\*Dependencies:\*\*\s+(.+)/i) ??
      line.match(/^\*\*Dependencies:\*\*\s+(.+)/i)
    if (depMatch) {
      const explicitDependencies = depMatch[1]
        .replace(/^`|`$/g, "")
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map(normalizeDependency)
        .filter(Boolean)
      currentGroup.dependencies = [...new Set([...(currentGroup.dependencies ?? []), ...explicitDependencies])]
      appendDependencies(depMatch[1])
      continue
    }

    const depHeaderMatch = line.match(/^Dependencies:\s*$/i)
    if (depHeaderMatch) {
      collectingDependencies = true
      collectingFiles = false
      collectingVerification = false
      continue
    }

    if (collectingDependencies) {
      const depItemMatch = line.match(/^\s*[-*]\s+(.+)$/)
      if (depItemMatch) {
        appendDependencies(depItemMatch[1])
        continue
      }
      if (/^[A-Z][A-Za-z\s]+:/.test(line.trim())) collectingDependencies = false
    }

    const verifHeaderMatch = line.match(/-\s+\*\*(?:Scoped\s+)?[Vv]erification:\*\*\s*$/i) ??
      line.match(/^\*\*(?:Scoped\s+)?[Vv]erification:\*\*\s*$/i) ??
      line.match(/^(?:Scoped\s+)?[Vv]erification:\s*$/i)
    if (verifHeaderMatch) {
      collectingVerification = true
      collectingFiles = false
      collectingDependencies = false
      inVerificationFence = false
      continue
    }

    const verifMatch = line.match(/-\s+\*\*(?:Scoped\s+)?[Vv]erification:\*\*\s+(.+)/i) ??
      line.match(/^\*\*(?:Scoped\s+)?[Vv]erification:\*\*\s+(.+)/i) ??
      line.match(/^(?:Scoped\s+)?[Vv]erification:\s+(.+)/i)
    if (verifMatch) {
      currentGroup.scopedVerification = verifMatch[1].trim()
      collectingVerification = false
      continue
    }

    if (collectingVerification) {
      if (line.trim().startsWith("```")) {
        inVerificationFence = !inVerificationFence
        continue
      }
      if (inVerificationFence) {
        appendVerification(line)
        continue
      }
      if (isNextGroupSubsection(line)) {
        collectingVerification = false
        continue
      }
      const verificationItemMatch = line.match(/^\s+-\s+(.+)$/)
      if (verificationItemMatch && !verificationItemMatch[1].startsWith("**")) {
        // Strip all backticks from the captured text and join with newlines
        const cleaned = verificationItemMatch[1].trim().replace(/`/g, "").trim()
        if (cleaned) {
          currentGroup.scopedVerification = [currentGroup.scopedVerification, cleaned].filter(Boolean).join("\n")
        }
        continue
      }
    }

    const parallelMatch = line.match(/-\s+\*\*Parallelizable:\*\*\s+(.+)/i) ??
      line.match(/^\*\*Parallelizable:\*\*\s+(.+)/i) ??
      line.match(/^Parallelizable:\s+(.+)/i)
    if (parallelMatch) {
      currentGroup.parallelizable = parallelMatch[1].trim().toLowerCase() === "yes" ||
        parallelMatch[1].trim().toLowerCase() === "true"
      continue
    }

    const executionModeMatch = line.match(/-\s+\*\*Execution\s+mode:\*\*\s+(.+)/i) ??
      line.match(/^\*\*Execution\s+mode:\*\*\s+(.+)/i) ??
      line.match(/^Execution\s+mode:\s+(.+)/i)
    if (executionModeMatch) {
      const mode = executionModeMatch[1].trim().toLowerCase()
      currentGroup.executionMode = mode === "shared-staging" ? "shared-staging" : "isolated"
      continue
    }

    const workspaceIdMatch = line.match(/-\s+\*\*Workspace\s+ID:\*\*\s+(.+)/i) ??
      line.match(/^\*\*Workspace\s+ID:\*\*\s+(.+)/i) ??
      line.match(/^Workspace\s+ID:\s+(.+)/i)
    if (workspaceIdMatch) {
      currentGroup.workspaceId = workspaceIdMatch[1].trim().replace(/^`|`$/g, "").trim()
      continue
    }

    const workspaceConcurrencyMatch = line.match(/-\s+\*\*Workspace\s+concurrency:\*\*\s+(.+)/i) ??
      line.match(/^\*\*Workspace\s+concurrency:\*\*\s+(.+)/i) ??
      line.match(/^Workspace\s+concurrency:\s+(.+)/i)
    if (workspaceConcurrencyMatch) {
      const concurrency = workspaceConcurrencyMatch[1].trim().toLowerCase()
      currentGroup.workspaceConcurrency = concurrency === "concurrent" ? "concurrent" : "serialized"
      continue
    }

    const baseStrategyMatch = line.match(/-\s+\*\*Base\s+strategy:\*\*\s+(.+)/i) ??
      line.match(/^\*\*Base\s+strategy:\*\*\s+(.+)/i) ??
      line.match(/^Base\s+strategy:\s+(.+)/i)
    if (baseStrategyMatch) {
      const baseStrategy = baseStrategyMatch[1].trim().toLowerCase()
      currentGroup.baseStrategy = baseStrategy === "dependency-lineage" ? "dependency-lineage" : "head"
      continue
    }

    const executionRationaleMatch = line.match(/-\s+\*\*Execution\s+rationale:\*\*\s+(.+)/i) ??
      line.match(/^\*\*Execution\s+rationale:\*\*\s+(.+)/i) ??
      line.match(/^Execution\s+rationale:\s+(.+)/i)
    if (executionRationaleMatch) {
      currentGroup.executionRationale = executionRationaleMatch[1].trim()
      continue
    }
  }

  // Push the last group
  pushCurrentGroup()

  return groups
}

export interface DispatchExecutionGroup {
  id: string
  agent: string
  files: string[]
  dependencies: string[]
  taskPrompt: string
  scopedVerification?: string
  parallelizable?: boolean
  executionMode?: "isolated" | "shared-staging"
  workspaceId?: string
  workspaceConcurrency?: "serialized" | "concurrent"
  baseStrategy?: "head" | "dependency-lineage"
  executionRationale?: string
  /** When set, this is a coalesced group that merges multiple original groups. */
  coalescedFrom?: string[]
}

/**
 * Coalesce execution groups that share files and have no explicit ordering.
 *
 * Builds a graph where edges connect groups that share at least one file AND
 * have no dependency relationship (direct or transitive). Groups with explicit
 * ordering (Group B depends on Group A) are not coalesced — the apply-back
 * engine patches them sequentially in topological order.
 *
 * Groups in each connected component (file-sharing + independent) are merged
 * into a single coalesced group so they run in the same worktree and produce
 * compatible patches from the same base commit.
 *
 * @param groups - The dispatch execution groups to coalesce.
 * @returns A new array of groups with connected components merged.
 */
export function coalesceConnectedGroups(
  groups: DispatchExecutionGroup[],
): DispatchExecutionGroup[] {
  if (groups.length <= 1) return groups

  // ── Build transitive dependency closure ─────────────────────
  // Used to avoid coalescing groups that already have explicit dependency
  // ordering — the apply-back engine applies patches in topological order,
  // so sequential groups don't need to run in the same worktree.
  const transitiveDeps = new Map<string, Set<string>>()
  for (const g of groups) {
    const closure = new Set<string>()
    const stack = [...g.dependencies]
    while (stack.length > 0) {
      const depId = stack.pop()!
      if (closure.has(depId)) continue
      closure.add(depId)
      const depGroup = groups.find(x => x.id === depId)
      if (depGroup) {
        for (const d of depGroup.dependencies) {
          if (!closure.has(d)) stack.push(d)
        }
      }
    }
    transitiveDeps.set(g.id, closure)
  }

  // ── Build adjacency list ────────────────────────────────────
  // Two groups are connected if they share at least one file AND have
  // no explicit dependency ordering between them (neither directly nor
  // transitively depends on the other). Groups with dependency ordering
  // don't need coalescing — the apply-back engine handles them by
  // applying patches in topological order.
  const groupIds = groups.map(g => g.id)
  const adjacency = new Map<string, string[]>()
  for (const g of groups) adjacency.set(g.id, [])

  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i]!
      const b = groups[j]!
      const aExplicitShared = a.executionMode === "shared-staging"
      const bExplicitShared = b.executionMode === "shared-staging"
      if (aExplicitShared || bExplicitShared) {
        // Planner-declared shared workspaces are first-class orchestration
        // units. Do not implicitly coalesce them here; the dispatch layer
        // will honor their shared workspace strategy explicitly.
        continue
      }
      const shareFiles = a.files.some(f => b.files.includes(f))
      const independent = !(transitiveDeps.get(a.id)?.has(b.id) || transitiveDeps.get(b.id)?.has(a.id))

      if (shareFiles && independent) {
        adjacency.get(a.id)!.push(b.id)
        adjacency.get(b.id)!.push(a.id)
      }
    }
  }

  // ── Find connected components ───────────────────────────────
  const visited = new Set<string>()
  const components: string[][] = []

  for (const id of groupIds) {
    if (visited.has(id)) continue
    const component: string[] = []
    const stack = [id]
    while (stack.length > 0) {
      const nodeId = stack.pop()!
      if (visited.has(nodeId)) continue
      visited.add(nodeId)
      component.push(nodeId)
      for (const neighbor of adjacency.get(nodeId) ?? []) {
        if (!visited.has(neighbor)) stack.push(neighbor)
      }
    }
    components.push(component)
  }

  // ── Merge each component into a single group ────────────────
  const groupMap = new Map(groups.map(g => [g.id, g]))
  const result: DispatchExecutionGroup[] = []

  const idMap = new Map<string, string>()

  for (const component of components) {
    if (component.length === 1) {
      // No coalescing needed for singleton components
      const group = groupMap.get(component[0]!)!
      idMap.set(group.id, group.id)
      result.push(group)
      continue
    }

    const members = component.map(id => groupMap.get(id)!).filter(Boolean)
    const componentSet = new Set(component)

    // Merged files (union, deduplicated, preserving order)
    const mergedFiles: string[] = []
    const seenFiles = new Set<string>()
    for (const m of members) {
      for (const f of m.files) {
        if (!seenFiles.has(f)) {
          seenFiles.add(f)
          mergedFiles.push(f)
        }
      }
    }

    // Merged dependencies: union of all member dep IDs minus IDs within this component
    const depsSet = new Set<string>()
    for (const m of members) {
      for (const d of m.dependencies) {
        if (!componentSet.has(d)) depsSet.add(d)
      }
    }
    const mergedDeps = [...depsSet]

    // Merged task prompt: describe each original subgroup
    const mergedPrompt = members.length === 2
      ? members.map((m, i) => `Sub-group ${i + 1} — ${m.taskPrompt}`).join("\n")
      : members.map((m, i) => `Sub-group ${i + 1} (${m.id}): ${m.taskPrompt}`).join("\n")

    // Merged scoped verification: join with newlines so each command
    // stays separate. Do NOT shell-chain with `&&` because guarded bash
    // execution rejects multi-command syntax. Each command is rendered
    // individually in the worker task prompt so the agent runs them as
    // separate guarded bash calls.
    const verificationCmds = members
      .map(m => m.scopedVerification)
      .filter((v): v is string => v !== undefined && v !== "")
    const mergedVerification = verificationCmds.length > 0
      ? verificationCmds.join("\n")
      : undefined

    // Agent: use the deepest dependency member (one that no other member depends on),
    // or fall back to the first member's agent.
    const leafMember = members.find(m => !members.some(other => other.dependencies.includes(m.id)))
    const mergedAgent = leafMember?.agent ?? members[0]!.agent

    // Merged ID: join original IDs with "~" separator
    // Sort so IDs are stable (group-1, group-2, etc.)
    component.sort()
    const mergedId = component.join("~")

    for (const id of component) {
      idMap.set(id, mergedId)
    }

    result.push({
      id: mergedId,
      agent: mergedAgent,
      files: mergedFiles,
      dependencies: mergedDeps,
      taskPrompt: mergedPrompt,
      scopedVerification: mergedVerification,
      executionMode: "isolated",
      workspaceConcurrency: "serialized",
      baseStrategy: "head",
      coalescedFrom: [...component],
    })
  }

  // Remap dependencies that point at groups inside a coalesced component to
  // the new coalesced group ID. This preserves apply-back ordering without
  // leaving dependencies that reference no dispatched group.
  return result.map((group) => {
    const remappedDeps = group.dependencies
      .map((dep) => idMap.get(dep) ?? dep)
      .filter((dep) => dep !== group.id)
    return {
      ...group,
      dependencies: [...new Set(remappedDeps)],
    }
  })
}

/**
 * Build the narrow control-plane contract included in worker/orchestrator tasks.
 */
