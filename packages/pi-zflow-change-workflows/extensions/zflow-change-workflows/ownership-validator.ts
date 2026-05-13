/**
 * ownership-validator.ts — File ownership and dependency validation.
 *
 * Prevents conflicting parallel writes by validating file ownership
 * boundaries and dependency order from execution-groups.md before
 * workers are launched.
 *
 * ## Design
 *
 * - `detectOwnershipConflicts()` finds files claimed by multiple groups.
 * - `validateOwnershipAndDependencies()` resolves conflicts using
 *   dependency order, or fails if sequencing is ambiguous.
 *
 * @module pi-zflow-change-workflows/ownership-validator
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A logical task group from `execution-groups.md`.
 */
export interface ExecutionGroup {
  /** Unique group identifier (e.g. "group-1", "group-2"). */
  id: string
  /** Files this group claims to write, relative to repo root. */
  files: string[]
  /** IDs of groups that must complete before this one. */
  dependencies: string[]
  /** Whether this group can run in parallel with others. */
  parallelizable: boolean
}

/**
 * A file ownership conflict between two or more groups.
 */
export interface OwnershipConflict {
  /** The conflicting file path. */
  file: string
  /** Group IDs that claim this file. */
  groups: string[]
}

/**
 * Result of ownership validation and conflict resolution.
 */
export interface OwnershipValidationResult {
  /** Whether the group set is valid for dispatch. */
  valid: boolean
  /** All detected conflicts (empty when valid or resolvable). */
  conflicts: OwnershipConflict[]
  /**
   * Groups that must run sequentially due to overlapping ownership
   * and explicit dependency ordering. Each sub-array is a chain of
   * groups that overlap the same files.
   */
  sequentialGroups: string[][]
  /**
   * Human-readable summary of the validation result.
   */
  summary: string
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Detect files claimed by multiple parallelizable groups.
 *
 * @param groups - All execution groups to check.
 * @returns Array of ownership conflicts.
 */
export function detectOwnershipConflicts(
  groups: ExecutionGroup[],
): OwnershipConflict[] {
  const owners = new Map<string, string[]>()

  // Build file → group mapping
  for (const group of groups) {
    if (!group.parallelizable) continue // non-parallel groups don't conflict at this level
    for (const file of group.files) {
      const existing = owners.get(file) ?? []
      owners.set(file, [...existing, group.id])
    }
  }

  // Return files claimed by more than one group
  const conflicts: OwnershipConflict[] = []
  for (const [file, groupIds] of owners) {
    if (groupIds.length > 1) {
      conflicts.push({ file, groups: groupIds })
    }
  }

  return conflicts
}

/**
 * Build a dependency graph as a Map from group ID to its dependencies.
 */
function buildDependencyGraph(
  groups: ExecutionGroup[],
): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>()
  for (const group of groups) {
    graph.set(group.id, new Set(group.dependencies))
  }
  return graph
}

/**
 * Check whether a dependency order is unambiguous and acyclic.
 *
 * Returns false if there are cycles or if conflicting groups don't
 * have a clear dependency ordering between them.
 */
function hasClearDependencyOrder(
  conflicts: OwnershipConflict[],
  groups: Map<string, ExecutionGroup>,
  graph: Map<string, Set<string>>,
): boolean {
  // For each conflict, check that every pair of conflicting groups
  // has a clear dependency path (direct or transitive).
  for (const conflict of conflicts) {
    for (let i = 0; i < conflict.groups.length; i++) {
      for (let j = i + 1; j < conflict.groups.length; j++) {
        const a = conflict.groups[i]
        const b = conflict.groups[j]

        // Check if a depends on b or b depends on a
        const aDeps = graph.get(a)
        const bDeps = graph.get(b)

        if (!aDeps || !bDeps) {
          return false
        }

        const aDependsOnB = aDeps.has(b)
        const bDependsOnA = bDeps.has(a)

        if (!aDependsOnB && !bDependsOnA) {
          // No explicit dependency between conflicting groups
          return false
        }
      }
    }
  }
  return true
}

/**
 * Check for cycles in the dependency graph.
 */
function hasCycles(graph: Map<string, Set<string>>): boolean {
  const visited = new Set<string>()
  const inStack = new Set<string>()

  function dfs(node: string): boolean {
    if (inStack.has(node)) return true
    if (visited.has(node)) return false

    visited.add(node)
    inStack.add(node)

    const deps = graph.get(node)
    if (deps) {
      for (const dep of deps) {
        if (dfs(dep)) return true
      }
    }

    inStack.delete(node)
    return false
  }

  for (const node of graph.keys()) {
    if (dfs(node)) return true
  }

  return false
}

/**
 * Compute topological order of groups.
 *
 * Returns an array of group IDs in dependency order, or null if
 * the graph has cycles.
 */
export function topoSortGroups(groups: ExecutionGroup[]): string[] | null {
  const graph = buildDependencyGraph(groups)

  if (hasCycles(graph)) return null

  // Kahn's algorithm
  const inDegree = new Map<string, number>()
  const adjacency = new Map<string, string[]>()

  for (const group of groups) {
    inDegree.set(group.id, 0)
    adjacency.set(group.id, [])
  }

  for (const group of groups) {
    for (const dep of group.dependencies) {
      const deps = adjacency.get(dep) ?? []
      deps.push(group.id)
      adjacency.set(dep, deps)
      inDegree.set(group.id, (inDegree.get(group.id) ?? 0) + 1)
    }
  }

  const queue: string[] = []
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id)
  }

  const sorted: string[] = []
  while (queue.length > 0) {
    const node = queue.shift()!
    sorted.push(node)

    for (const neighbor of adjacency.get(node) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1
      inDegree.set(neighbor, newDegree)
      if (newDegree === 0) queue.push(neighbor)
    }
  }

  if (sorted.length !== groups.length) return null

  return sorted
}

/**
 * Find all nodes that participate in cycles.
 */
function findCycleNodes(graph: Map<string, Set<string>>): string[] {
  const cycleNodes: string[] = []
  const visited = new Set<string>()

  for (const start of graph.keys()) {
    if (visited.has(start)) continue
    const path = new Set<string>()

    function dfs(node: string): boolean {
      if (path.has(node)) {
        // Record all nodes in the cycle path
        for (const n of path) {
          if (!cycleNodes.includes(n)) cycleNodes.push(n)
        }
        cycleNodes.push(node)
        return true
      }
      if (visited.has(node)) return false

      visited.add(node)
      path.add(node)

      const deps = graph.get(node)
      if (deps) {
        for (const dep of deps) {
          dfs(dep)
        }
      }

      path.delete(node)
      return false
    }

    dfs(start)
  }

  return [...new Set(cycleNodes)]
}

/**
 * Group conflicting groups into sequential chains.
 *
 * Groups that share ownership conflicts are grouped together;
 * within each chain they must run sequentially.
 */
function buildSequentialGroups(
  conflicts: OwnershipConflict[],
  groups: Map<string, ExecutionGroup>,
  sortedGroups: string[],
): string[][] {
  // Build conflict adjacency: which groups are related through conflicts
  const conflictEdges = new Map<string, Set<string>>()

  for (const conflict of conflicts) {
    for (let i = 0; i < conflict.groups.length; i++) {
      for (let j = i + 1; j < conflict.groups.length; j++) {
        const a = conflict.groups[i]
        const b = conflict.groups[j]
        if (!conflictEdges.has(a)) conflictEdges.set(a, new Set())
        if (!conflictEdges.has(b)) conflictEdges.set(b, new Set())
        conflictEdges.get(a)!.add(b)
        conflictEdges.get(b)!.add(a)
      }
    }
  }

  // Find connected components in the conflict graph
  const visited = new Set<string>()
  const components: string[][] = []

  for (const groupId of sortedGroups) {
    if (visited.has(groupId)) continue
    if (!conflictEdges.has(groupId)) continue

    const component: string[] = []
    const stack = [groupId]

    while (stack.length > 0) {
      const node = stack.pop()!
      if (visited.has(node)) continue
      visited.add(node)
      component.push(node)

      for (const neighbor of conflictEdges.get(node) ?? []) {
        if (!visited.has(neighbor)) {
          stack.push(neighbor)
        }
      }
    }

    if (component.length > 1) {
      components.push(component)
    }
  }

  return components
}

/**
 * Validate file ownership boundaries and dependency order.
 *
 * Checks:
 * 1. No parallelizable groups claim the same file.
 * 2. If conflicts exist and dependencies are explicit, schedule sequentially.
 * 3. If conflicts exist and sequencing is ambiguous, return invalid.
 *
 * @param groups - All execution groups to validate.
 * @returns Validation result with conflicts and suggested sequential groups.
 */
export function validateOwnershipAndDependencies(
  groups: ExecutionGroup[],
): OwnershipValidationResult {
  const groupMap = new Map(groups.map((g) => [g.id, g]))

  // Step 1: Detect ownership conflicts (only between parallelizable groups)
  const conflicts = detectOwnershipConflicts(groups)

  // Step 2: Check for cycles in dependency graph (always, even without conflicts)
  const graph = buildDependencyGraph(groups)
  if (hasCycles(graph)) {
    const cycleNodes = findCycleNodes(graph)
    const summary = conflicts.length > 0
      ? [
          `Ownership conflicts detected in ${conflicts.length} file(s),`,
          "and the dependency graph contains cycles.",
          "Cyclic groups: " + [...new Set(cycleNodes)].join(", "),
          "",
          "Conflicts:",
          ...conflicts.map(
            (c) => `  - ${c.file}: claimed by ${c.groups.join(", ")}`,
          ),
          "",
          "Fix the cycle in execution-groups.md before dispatching.",
        ].join("\n")
      : [
          "Dependency graph contains cycles.",
          "Cyclic groups: " + [...new Set(cycleNodes)].join(", "),
          "",
          "Fix the cycle in execution-groups.md before dispatching.",
        ].join("\n")

    return {
      valid: false,
      conflicts,
      sequentialGroups: [],
      summary,
    }
  }

  if (conflicts.length === 0) {
    return {
      valid: true,
      conflicts: [],
      sequentialGroups: [],
      summary: "No ownership conflicts detected. All groups can proceed.",
    }
  }

  // Step 3: Check if conflicting groups have explicit dependency ordering
  const hasOrdering = hasClearDependencyOrder(conflicts, groupMap, graph)

  if (!hasOrdering) {
    return {
      valid: false,
      conflicts,
      sequentialGroups: [],
      summary: [
        `Ownership conflicts detected in ${conflicts.length} file(s),`,
        "and conflicting groups lack explicit dependency ordering.",
        "",
        "Conflicts:",
        ...conflicts.map(
          (c) => `  - ${c.file}: claimed by ${c.groups.join(", ")}`,
        ),
        "",
        "Resolution options:",
        "  1. Add explicit dependencies between conflicting groups in execution-groups.md",
        "  2. Remove conflicting file claims from parallelizable groups",
        "  3. Mark conflicting groups as non-parallelizable",
      ].join("\n"),
    }
  }

  // Step 4: Build topological order and sequential groups
  const sorted = topoSortGroups(groups)
  if (!sorted) {
    return {
      valid: false,
      conflicts,
      sequentialGroups: [],
      summary: "Failed to compute topological order (inconsistent state).",
    }
  }

  const sequentialGroups = buildSequentialGroups(conflicts, groupMap, sorted)

  return {
    valid: true,
    conflicts,
    sequentialGroups,
    summary: [
      `Ownership conflicts detected in ${conflicts.length} file(s),`,
      "but dependency order is clear. Conflicting groups will run sequentially.",
      "",
      "Conflicts:",
      ...conflicts.map(
        (c) => `  - ${c.file}: claimed by ${c.groups.join(", ")}`,
      ),
      "",
      sequentialGroups.length > 0
        ? `Sequential chains: ${sequentialGroups.map((g) => g.join(" → ")).join("; ")}`
        : "No sequential chains required.",
      "",
      `Apply order: ${sorted.join(" → ")}`,
    ].join("\n"),
  }
}
