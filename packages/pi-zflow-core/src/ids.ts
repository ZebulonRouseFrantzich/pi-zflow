/**
 * pi-zflow-core — namespaced identifier helpers
 *
 * All public commands, tools, message types, events, status keys, and
 * session custom entry types must use the `zflow` prefix to avoid collisions
 * with other Pi packages and built-in resources.
 *
 * @module
 */

// ── Namespace constants ──────────────────────────────────────────

/** Prefix for all public slash commands */
export const COMMAND_PREFIX = "zflow" as const

/** Prefix for all custom tools */
export const TOOL_PREFIX = "zflow" as const

/** Prefix for all event names */
export const EVENT_PREFIX = "zflow" as const

/** Prefix for all session custom entry types */
export const SESSION_ENTRY_PREFIX = "zflow" as const

/** Prefix for status/widget keys */
export const STATUS_KEY_PREFIX = "zflow" as const

/** Prefix for custom message types */
export const MESSAGE_TYPE_PREFIX = "zflow" as const

// ── Identifier helpers ───────────────────────────────────────────

/**
 * Create a namespaced slash command name.
 *
 * @example command("profile") → "/zflow-profile"
 */
export function command(name: string): string {
  return `/${COMMAND_PREFIX}-${name}`
}

/**
 * Create a namespaced custom tool name.
 *
 * @example tool("write_plan_artifact") → "zflow_write_plan_artifact"
 */
export function tool(name: string): string {
  return `${TOOL_PREFIX}_${name}`
}

/**
 * Create a namespaced event name.
 *
 * The colon separator follows Pi event naming conventions.
 *
 * @example event("profileChanged") → "zflow:profileChanged"
 */
export function event(name: string): string {
  return `${EVENT_PREFIX}:${name}`
}

/**
 * Create a namespaced session custom entry type.
 *
 * @example sessionEntryType("planApproved") → "zflow:planApproved"
 */
export function sessionEntryType(name: string): string {
  return `${SESSION_ENTRY_PREFIX}:${name}`
}

/**
 * Create a namespaced status key.
 *
 * @example statusKey("planMode") → "zflow:planMode"
 */
export function statusKey(name: string): string {
  return `${STATUS_KEY_PREFIX}:${name}`
}

/**
 * Create a namespaced custom message type.
 *
 * @example messageType("workflowState") → "zflow:workflowState"
 */
export function messageType(name: string): string {
  return `${MESSAGE_TYPE_PREFIX}:${name}`
}

// ── Validation ───────────────────────────────────────────────────

/** Built-in Pi tool names that default packages must not override. */
export const BUILTIN_TOOLS = new Set([
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "subagent",
  "intercom",
  "interview",
  "web_search",
  "code_search",
  "fetch_content",
  "get_search_content",
])

/**
 * Check whether `name` collides with a built-in Pi tool.
 *
 * Returns a diagnostic message if collision is detected, or `null` if safe.
 */
export function checkBuiltinToolCollision(name: string): string | null {
  if (BUILTIN_TOOLS.has(name)) {
    return (
      `"${name}" is a built-in Pi tool. Default packages must not override built-in tools. ` +
      `Use a namespaced name like "${tool(name)}" instead.`
    )
  }
  return null
}

/**
 * Validate that a command name follows the `/zflow-*` convention.
 *
 * Returns a diagnostic message if invalid, or `null` if valid.
 */
export function checkCommandNaming(name: string): string | null {
  if (!name.startsWith(`/${COMMAND_PREFIX}-`)) {
    return `Command "${name}" does not follow the required /${COMMAND_PREFIX}-* naming convention.`
  }
  return null
}

/**
 * Validate that a tool name follows the `zflow_*` convention.
 *
 * Returns a diagnostic message if invalid, or `null` if valid.
 */
export function checkToolNaming(name: string): string | null {
  if (!name.startsWith(`${TOOL_PREFIX}_`)) {
    return (
      `Tool "${name}" does not follow the required ${TOOL_PREFIX}_* naming convention. ` +
      `Use a namespaced name like "${tool(name)}".`
    )
  }
  return null
}

/**
 * Assert that a changeId string is a safe kebab-case identifier.
 *
 * ChangeId values are used as directory names in the runtime state path.
 * Only lowercase letters, digits, and hyphens are allowed to prevent
 * path traversal and cross-platform filesystem issues.
 *
 * @param changeId - The change identifier to validate.
 * @throws Error if the changeId contains unsafe characters.
 */
export function assertSafeChangeId(changeId: string): void {
  if (typeof changeId !== "string" || changeId.length === 0) {
    throw new Error(
      `Invalid changeId: must be a non-empty string, got ${typeof changeId === "string" ? "empty string" : typeof changeId}`,
    )
  }
  // Allow lowercase letters, digits, hyphens — safe for directory names on all platforms
  if (!/^[a-z0-9][a-z0-9-]*$/.test(changeId)) {
    throw new Error(
      `Unsafe changeId: "${changeId}". ` +
      "ChangeId must be a non-empty kebab-case string matching [a-z0-9][a-z0-9-]*. " +
      "Use only lowercase letters, digits, and hyphens.",
    )
  }
}
