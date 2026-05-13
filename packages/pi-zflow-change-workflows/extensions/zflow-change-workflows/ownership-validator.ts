/**
 * ownership-validator.ts — File ownership and dependency validation for execution groups.
 *
 * Prevents conflicting parallel writes before workers are launched by detecting
 * when multiple groups claim the same file. Also validates that dependency order
 * is explicit enough to resolve any overlaps safely.
 *
 * ## Design rules
 *
 * - This module validates BEFORE workers are dispatched. It does not enforce
 *   ordering during execution — that is the apply-back engine's job.
 * - File ownership is defined by the `execution-groups.md` plan artifact.
 * - If overlap exists and dependency order is explicit, groups must run
 *   sequentially. If ordering is ambiguous, dispatch is blocked.
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
  /** Group identifier (e.g. "group-1", "group-2"). */
  readonly id: string
  /** Files this group claims to write or modify. */
  readonly files: string[]
  /** IDs of groups that must complete before this one. */
  readonly dependencies: string[]
  /** Whether this group can run in parallel with others. */
  readonly parallelizable: boolean
}

/**
 * A detected ownership conflict — one file claimed by multiple groups.
 */
export interface OwnershipConflict {
  /** The conflicting file path. */
  readonly file: string
  /** Group IDs that claim this file. */
  readonly groups: string[]
}

/**
 * Result of ownership and dependency validation.
 */
export interface OwnershipValidationResult {
  /** Whether the groups are valid for parallel execution. */
  readonly valid: boolean
  /** Detected ownership conflicts (empty when valid). */
  readonly conflicts: OwnershipConflict[]
  /**
   * Groups that must run sequentially due to conflicts.
   * Each inner array is a set of conflicting groups that must be sequenced.
   * Empty when valid and conflict-free, or when explicit ordering exists.
   */
  readonly sequentialGroups: string[][]
  /** Human-readable summary for diagnostics / logging. */
  readonly summary: string
}

// ---------------------------------------------------------------------------
// Validation logic
// ---------------------------------------------------------------------------

/**
 * Detect files that are claimed by more than one group.
 *
 * @param groups - Execution groups to inspect.
 * @returns Array of ownership conflicts, one per overlapping file.
 */
export function detectOwnershipConflicts(
  groups: ExecutionGroup[],
): OwnershipConflict[] {
  const owners = new Map<string, string[]>()

  for (const group of groups) {
    for (const file of group.files) {
      const existing = owners.get(file) ?? []
      owners.set(file, [...existing, group.id])
    }
  }

  return [...owners.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([file, groupIds]) => ({ file, groups: groupIds }))
}

/**
 * Validate ownership and dependencies between execution groups.
 *
 * ## Validation rules
 *
 * 1. **No overlap in parallel groups** — if two groups marked `parallelizable`
 *    claim the same file, that is invalid unless explicit dependency order
 *    disambiguates the overlap.
 * 2. **Explicit dependencies** — if one group already depends on the other
 *    (directly or transitively), the overlap is resolved by ordering.
 * 3. **Ambiguous overlap** — if an overlap exists between groups that do not
 *    have a direct or transitive dependency relationship, the result is
 *    `valid: false`. Dispatch must be halted.
 *
 * @param groups - Execution groups to validate.
 * @returns Validation result with conflicts and sequential groupings.
 */
export function validateOwnershipAndDependencies(
  groups: ExecutionGroup[],
): OwnershipValidationResult {
  const conflicts = detectOwnershipConflicts(groups)

  // Fast path: no conflicts at all
  if (conflicts.length === 0) {
    return {
      valid: true,
      conflicts: [],
      sequentialGroups: [],
      summary: "No ownership conflicts detected. All parallelizable groups can run concurrently.",
    }
  }

  // Collect all group IDs involved in any conflict
  const conflictingGroupIds = new Set<string>()
  for (const conflict of conflicts) {
    for (const groupId of conflict.groups) {
      conflictingGroupIds.add(groupId)
    }
  }

  // Build adjacency maps for dependency checking
  const depMap = new Map<string, Set<string>>()
  for (const group of groups) {
    depMap.set(group.id, new Set(group.dependencies))
  }

  /**
   * Check whether `from` has a direct or transitive dependency on `to`.
   */
  function dependsOn(from: string, to: string, visited: Set<string> = new Set()): boolean {
    if (from === to) return false
    if (visited.has(from)) return false
    visited.add(from)

    const deps = depMap.get(from)
    if (!deps || deps.size === 0) return false
    if (deps.has(to)) return true

    for (const dep of deps) {
      if (dependsOn(dep, to, visited)) return true
    }
    return false
  }

  // For each conflict, verify that EVERY pair of conflicting groups has
  // explicit dependency ordering (one depends on the other directly or
  // transitively). This ensures a deterministic execution order.
  const unresolvedConflicts: OwnershipConflict[] = []

  for (const conflict of conflicts) {
    const groupsInConflict = conflict.groups
    // Check that for every pair (a,b) with a!==b, at least one direction
    // of dependency exists.
    const allPairsOrdered = groupsInConflict.every((a) =>
      groupsInConflict.every(
        (b) => a === b || dependsOn(a, b) || dependsOn(b, a),
      ),
    )

    if (!allPairsOrdered) {
      unresolvedConflicts.push(conflict)
    }
  }

  if (unresolvedConflicts.length === 0) {
    // Every conflict has an existing explicit dependency between all
    // participating groups — safe to proceed with sequential execution.
    return {
      valid: true,
      conflicts: [],
      sequentialGroups:
        conflictingGroupIds.size > 0
          ? [[...conflictingGroupIds]]
          : [],
      summary: `Ownership conflicts detected but dependency order is explicit. Conflicting groups will run sequentially: ${[...conflictingGroupIds].sort().join(", ")}.`,
    }
  }

  // Some conflicts cannot be resolved by existing dependencies
  const unresolvedPaths = [
    ...new Set(unresolvedConflicts.flatMap((c) => c.groups)),
  ]

  return {
    valid: false,
    conflicts: unresolvedConflicts,
    sequentialGroups: [],
    summary: [
      "Ownership validation FAILED — ambiguous file overlaps with no explicit dependency order.",
      "",
      `Conflicting groups: ${unresolvedPaths.sort().join(", ")}`,
      "",
      "Unresolved file conflicts:",
      ...unresolvedConflicts.map(
        (c) => `  - "${c.file}" claimed by ${c.groups.join(", ")}`,
      ),
      "",
      "Fix: add explicit dependencies in execution-groups.md between these groups,",
      "or separate their file ownership so they no longer write to the same files.",
    ].join("\n"),
  }
}
