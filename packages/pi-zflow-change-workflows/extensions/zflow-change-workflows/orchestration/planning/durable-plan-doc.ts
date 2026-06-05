/**
 * durable-plan-doc.ts — durable plan.md helpers for reviewed planning artifacts.
 */

export const DEFAULT_PUBLISH_REPO_PATH = "docs/zflow-changes"

export interface DurablePlanDocFrontmatter {
  schemaVersion: number
  changeId: string
  status: "draft" | "validated" | "reviewed" | "approved" | "superseded" | "cancelled"
  sourceMode: "adhoc" | "runecontext"
  currentVersion: string | null
  approvedVersion: string | null
  [key: string]: unknown
}

/**
 * Parsed durable plan doc with frontmatter and body.
 */
export interface DurablePlanDoc {
  frontmatter: DurablePlanDocFrontmatter
  body: string
  path: string
  validationErrors: string[]
  bodyValidationErrors: string[]
}

const DURABLE_PLAN_DOC_SCHEMA_VERSION = 1
const DURABLE_PLAN_DOC_STATUSES = new Set<DurablePlanDocFrontmatter["status"]>([
  "draft",
  "validated",
  "reviewed",
  "approved",
  "superseded",
  "cancelled",
])
const DURABLE_PLAN_DOC_SOURCE_MODES = new Set<DurablePlanDocFrontmatter["sourceMode"]>([
  "adhoc",
  "runecontext",
])
const DURABLE_PLAN_DOC_CORE_FRONTMATTER_KEYS = new Set([
  "schemaVersion",
  "changeId",
  "status",
  "sourceMode",
  "currentVersion",
  "approvedVersion",
])

/**
 * Managed-section marker constants used to distinguish auto-generated
 * content from user-authored content inside plan.md.
 *
 * These markers delimit sections that the system may overwrite during
 * updates.  Content outside markers is preserved across updates.
 */
const MANAGED_OPEN_PREFIX = "<!-- zflow-managed:"
const MANAGED_CLOSE = "<!-- /zflow-managed -->"
const MANAGED_SECTION_RE = /<!--\s*zflow-managed:\s*([^\n]*?)\s*-->([\s\S]*?)<!--\s*\/zflow-managed\s*-->/g
const DURABLE_PLAN_DOC_REQUIRED_HEADINGS = [
  "Summary",
  "Goals / Success Criteria",
  "Scope In",
  "Scope Out",
  "Relevant codebase areas",
  "Constraints",
  "Decisions",
  "Risks / Unknowns",
  "Proposed execution outline",
  "Verification approach",
  "Open questions",
] as const
const DURABLE_PLAN_DOC_PLACEHOLDER_LINES = [
  "_Describe the change, why it is needed, and what it accomplishes._",
  "_List the desired outcomes, user-visible success criteria, and technical completion checks._",
  "_What is included in this change._",
  "_What is explicitly excluded._",
  "_Files, modules, services, docs, and neighboring systems that should be inspected or are likely to change._",
  "_Technical, architectural, or process constraints._",
  "_Key decisions and trade-offs made during planning._",
  "_Known risks, open questions, and dependencies._",
  "_High-level execution approach, groups, and order._",
  "_Concrete commands, focused tests, manual checks, and pass/fail expectations._",
  "_Any remaining user decisions or unresolved assumptions that could materially change the plan._",
] as const

interface DurablePlanDocOptions {
  cwd?: string
  repoRoot?: string
  repoRelativeDir?: string
}

export async function resolveDurablePlanRepoRoot(options?: DurablePlanDocOptions): Promise<string> {
  try {
    const { execSync } = await import("node:child_process")
    return (options?.repoRoot) ?? execSync("git rev-parse --show-toplevel", {
      cwd: options?.cwd ?? process.cwd(),
      encoding: "utf-8",
      timeout: 5_000,
    }).trim()
  } catch {
    return options?.repoRoot ?? (options?.cwd ?? process.cwd())
  }
}

function normalizeDurablePlanVersion(value: unknown): string | null {
  return typeof value === "string" && /^v\d+$/.test(value)
    ? value
    : null
}

function normalizeDurablePlanDocFrontmatter(
  changeId: string,
  frontmatter: Record<string, unknown>,
): DurablePlanDocFrontmatter {
  const normalized: DurablePlanDocFrontmatter = {
    schemaVersion: typeof frontmatter.schemaVersion === "number"
      ? frontmatter.schemaVersion
      : Number(frontmatter.schemaVersion ?? DURABLE_PLAN_DOC_SCHEMA_VERSION),
    changeId: typeof frontmatter.changeId === "string" && frontmatter.changeId.trim()
      ? frontmatter.changeId.trim()
      : changeId,
    status: DURABLE_PLAN_DOC_STATUSES.has(frontmatter.status as DurablePlanDocFrontmatter["status"])
      ? frontmatter.status as DurablePlanDocFrontmatter["status"]
      : "draft",
    sourceMode: DURABLE_PLAN_DOC_SOURCE_MODES.has(frontmatter.sourceMode as DurablePlanDocFrontmatter["sourceMode"])
      ? frontmatter.sourceMode as DurablePlanDocFrontmatter["sourceMode"]
      : "adhoc",
    currentVersion: normalizeDurablePlanVersion(frontmatter.currentVersion),
    approvedVersion: normalizeDurablePlanVersion(frontmatter.approvedVersion),
  }

  for (const [key, value] of Object.entries(frontmatter)) {
    if (!DURABLE_PLAN_DOC_CORE_FRONTMATTER_KEYS.has(key) && key !== "requestNotes") {
      normalized[key] = value
    }
  }

  return normalized
}

export function validateDurablePlanDocFrontmatter(
  frontmatter: Record<string, unknown>,
  expectedChangeId?: string,
): string[] {
  const errors: string[] = []
  const schemaVersion = typeof frontmatter.schemaVersion === "number"
    ? frontmatter.schemaVersion
    : Number(frontmatter.schemaVersion)
  if (!Number.isInteger(schemaVersion) || schemaVersion !== DURABLE_PLAN_DOC_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${DURABLE_PLAN_DOC_SCHEMA_VERSION}`)
  }

  const changeId = typeof frontmatter.changeId === "string" ? frontmatter.changeId.trim() : ""
  if (!changeId) {
    errors.push("changeId is required")
  } else if (!/^[a-z0-9][a-z0-9-]*$/.test(changeId)) {
    errors.push("changeId must be kebab-case")
  } else if (expectedChangeId && changeId !== expectedChangeId) {
    errors.push(`changeId must match ${expectedChangeId}`)
  }

  if (!DURABLE_PLAN_DOC_STATUSES.has(frontmatter.status as DurablePlanDocFrontmatter["status"])) {
    errors.push(`status must be one of: ${Array.from(DURABLE_PLAN_DOC_STATUSES).join(", ")}`)
  }

  if (!DURABLE_PLAN_DOC_SOURCE_MODES.has(frontmatter.sourceMode as DurablePlanDocFrontmatter["sourceMode"])) {
    errors.push(`sourceMode must be one of: ${Array.from(DURABLE_PLAN_DOC_SOURCE_MODES).join(", ")}`)
  }

  for (const [field, value] of Object.entries({
    currentVersion: frontmatter.currentVersion,
    approvedVersion: frontmatter.approvedVersion,
  })) {
    if (value !== null && value !== undefined && (typeof value !== "string" || !/^v\d+$/.test(value))) {
      errors.push(`${field} must be null or a version like v1`)
    }
  }

  return errors
}

function buildSerializedDurablePlanDocFrontmatter(
  changeId: string,
  frontmatter: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = normalizeDurablePlanDocFrontmatter(changeId, frontmatter)
  const serialized: Record<string, unknown> = {
    schemaVersion: normalized.schemaVersion,
    changeId: normalized.changeId,
    status: normalized.status,
    sourceMode: normalized.sourceMode,
    currentVersion: normalized.currentVersion,
    approvedVersion: normalized.approvedVersion,
  }

  for (const [key, value] of Object.entries(normalized)) {
    if (!DURABLE_PLAN_DOC_CORE_FRONTMATTER_KEYS.has(key)) {
      serialized[key] = value
    }
  }

  return serialized
}

export function normalizeDurablePlanDocBody(body: string): string {
  let normalized = body.trim()
  const fenced = normalized.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i)
  if (fenced) {
    normalized = fenced[1]!.trim()
  }

  normalized = parsePlanDocFrontmatter(normalized).body.trim()
  normalized = normalized.replace(/^#\s+Plan\s*\n+/i, "")
  const freeContent = extractPlanDocSections(normalized).get("__free__")?.trim()
  return freeContent?.trim() || normalized
}

export function validateDurablePlanDocBody(body: string): string[] {
  const normalized = normalizeDurablePlanDocBody(body)
  const errors: string[] = []

  for (const heading of DURABLE_PLAN_DOC_REQUIRED_HEADINGS) {
    const headingRe = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*$`, "mi")
    if (!headingRe.test(normalized)) {
      errors.push(`missing \"## ${heading}\" section`)
    }
  }

  for (const placeholder of DURABLE_PLAN_DOC_PLACEHOLDER_LINES) {
    if (normalized.includes(placeholder)) {
      errors.push(`contains scaffold placeholder text: ${placeholder}`)
    }
  }

  const nonEmptyLines = normalized.split("\n").map((line) => line.trim()).filter(Boolean)
  if (normalized.length < 400 || nonEmptyLines.length < 18) {
    errors.push("plan body is too short; expected a decision-complete plan draft")
  }

  return errors
}

export function isPlaceholderDurablePlanDocBody(body: string): boolean {
  return validateDurablePlanDocBody(body).some(
    (error) => error.startsWith("contains scaffold placeholder text") || error.startsWith("missing \"##"),
  )
}

function buildPlanDocHeaderSection(
  changeId: string,
  currentVersion: string | null | undefined,
  sourceMode: DurablePlanDocFrontmatter["sourceMode"] = "adhoc",
): string {
  return [
    `${MANAGED_OPEN_PREFIX} header -->`,
    `> Auto-generated entry-point for change **${changeId}**.`,
    `> Latest version: ${currentVersion ?? "none"}.`,
    ...(sourceMode === "runecontext"
      ? ["> RuneContext documents remain the canonical source of truth. This plan.md is a durable review/index entrypoint."]
      : []),
    MANAGED_CLOSE,
  ].join("\n")
}

function injectDraftNotesIntoScaffold(body: string, draftNotes?: string): string {
  if (!draftNotes?.trim()) return body
  return body.replace(
    "_Describe the change, why it is needed, and what it accomplishes._",
    draftNotes.trim(),
  )
}

/**
 * Resolve the absolute path to the durable draft plan doc.
 *
 * Path: `<repoRoot>/<repoRelativeDir>/<changeId>/plan.md`
 *
 * @param changeId - Unique change identifier.
 * @param repoRoot - Repository root path.
 * @param repoRelativeDir - Relative path under repo root (default: `"docs/zflow-changes"`).
 * @returns Absolute path to the plan.md file.
 */
export async function resolveDurablePlanDocPath(
  changeId: string,
  repoRoot: string,
  repoRelativeDir?: string,
): Promise<string> {
  const { default: path } = await import("node:path")
  const rel = repoRelativeDir ?? DEFAULT_PUBLISH_REPO_PATH
  return path.resolve(repoRoot, rel, changeId, "plan.md")
}

export async function listPublishedDurablePlanVersions(
  changeId: string,
  options?: DurablePlanDocOptions,
): Promise<string[]> {
  const { default: fs } = await import("node:fs/promises")
  const { default: path } = await import("node:path")
  const repoRoot = await resolveDurablePlanRepoRoot(options)
  const rel = options?.repoRelativeDir ?? DEFAULT_PUBLISH_REPO_PATH
  const changeDir = path.resolve(repoRoot, rel, changeId)

  try {
    const entries = await fs.readdir(changeDir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && /^v\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => Number.parseInt(b.slice(1), 10) - Number.parseInt(a.slice(1), 10))
  } catch {
    return []
  }
}

/**
 * Parse simple flat-key frontmatter from a plan.md string.
 *
 * Expected format:
 * ```
 * ---
 * key: value
 * key: value
 * ---
 * body...
 * ```
 *
 * Only flat `key: value` lines are parsed.  Keys and values are trimmed.
 * Missing values are stored as null.  Lines that are empty or comments are
 * skipped.  The closing `---` may contain trailing whitespace.
 *
 * @param content - Raw file content.
 * @returns Parsed frontmatter record and the body after the closing `---`,
 *          or an empty record and the full content if no frontmatter is found.
 */
export function parsePlanDocFrontmatter(
  content: string,
): { frontmatter: Record<string, string | null>; body: string } {
  const trimmed = content.trimStart()
  if (!trimmed.startsWith("---")) {
    return { frontmatter: {}, body: trimmed }
  }

  // Find the closing ---
  const firstNewline = trimmed.indexOf("\n")
  if (firstNewline === -1) {
    return { frontmatter: {}, body: trimmed }
  }

  const secondLine = firstNewline + 1
  const endMarker = trimmed.indexOf("\n---", secondLine)
  if (endMarker === -1) {
    // No closing marker — treat whole thing as body
    return { frontmatter: {}, body: trimmed }
  }

  // Extract frontmatter lines between the two markers
  const rawFrontmatter = trimmed.slice(secondLine, endMarker).trimEnd()
  const body = trimmed.slice(endMarker + 5).trimStart()

  const frontmatter: Record<string, string | null> = {}
  for (const line of rawFrontmatter.split("\n")) {
    const trimmedLine = line.trim()
    if (!trimmedLine || trimmedLine.startsWith("#")) continue
    const colonIdx = trimmedLine.indexOf(":")
    if (colonIdx === -1) {
      // Line without colon — treat as boolean-like
      frontmatter[trimmedLine] = null
      continue
    }
    const key = trimmedLine.slice(0, colonIdx).trim()
    let value: string | null = trimmedLine.slice(colonIdx + 1).trim()
    // Normalize "null" string to actual null
    if (value === "null" || value === "") value = null
    if (key) frontmatter[key] = value
  }

  return { frontmatter, body }
}

/**
 * Serialize frontmatter + body into a plan.md string.
 *
 * @param frontmatter - Flat key-value pairs to write as frontmatter.
 * @param body - Body markdown content.
 * @returns Complete file content with frontmatter delimiters.
 */
export function serializePlanDoc(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const lines: string[] = ["---"]
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === null || value === undefined) {
      lines.push(`${key}: null`)
    } else if (typeof value === "boolean") {
      lines.push(`${key}: ${value}`)
    } else if (typeof value === "number") {
      lines.push(`${key}: ${value}`)
    } else {
      lines.push(`${key}: ${String(value)}`)
    }
  }
  lines.push("---")
  lines.push("")
  lines.push(body.trimStart())
  return lines.join("\n")
}

/**
 * Build a scaffold body for a new durable draft plan doc.
 *
 * Produces a template with managed header + standard sections that users
 * can fill in.  The managed sections are preserved across automated updates.
 *
 * @param changeId - Change identifier for display.
 * @returns A markdown body string with managed markers.
 */
export function scaffoldDurablePlanDocBody(changeId: string, draftNotes?: string): string {
  return injectDraftNotesIntoScaffold([
    buildPlanDocHeaderSection(changeId, null),
    "",
    "## Summary",
    "",
    "_Describe the change, why it is needed, and what it accomplishes._",
    "",
    "## Goals / Success Criteria",
    "",
    "_List the desired outcomes, user-visible success criteria, and technical completion checks._",
    "",
    "## Scope In",
    "",
    "_What is included in this change._",
    "",
    "## Scope Out",
    "",
    "_What is explicitly excluded._",
    "",
    "## Relevant codebase areas",
    "",
    "_Files, modules, services, docs, and neighboring systems that should be inspected or are likely to change._",
    "",
    "## Constraints",
    "",
    "_Technical, architectural, or process constraints._",
    "",
    "## Decisions",
    "",
    "_Key decisions and trade-offs made during planning._",
    "",
    "## Risks / Unknowns",
    "",
    "_Known risks, open questions, and dependencies._",
    "",
    "## Proposed execution outline",
    "",
    "_High-level execution approach, groups, and order._",
    "",
    "## Verification approach",
    "",
    "_Concrete commands, focused tests, manual checks, and pass/fail expectations._",
    "",
    "## Open questions",
    "",
    "_Any remaining user decisions or unresolved assumptions that could materially change the plan._",
    "",
    buildPlanDocVersionIndexSection([]),
  ].join("\n"), draftNotes)
}

/**
 * Extract sections of body text that live between managed markers.
 *
 * Returns a map of managed-section name (the label after "zflow-managed:") to
 * the content between its open and close markers.  Non-managed content is
 * returned as the `"__free__"` key.
 *
 * @param body - The body portion of a plan.md file.
 * @returns Map of section name → content.
 */
export function extractPlanDocSections(body: string): Map<string, string> {
  const sections = new Map<string, string>()
  const freeParts: string[] = []
  let lastIndex = 0

  for (const match of body.matchAll(MANAGED_SECTION_RE)) {
    const index = match.index ?? 0
    if (index > lastIndex) {
      freeParts.push(body.slice(lastIndex, index))
    }
    sections.set(match[1]!.trim(), match[0])
    lastIndex = index + match[0].length
  }

  if (lastIndex < body.length) {
    freeParts.push(body.slice(lastIndex))
  }

  sections.set("__free__", freeParts.join("").trim())
  return sections
}

/**
 * Build a managed section string for the version index.
 *
 * @param versions - Array of version label strings (e.g. `["v1", "v2"]`).
 * @returns The fully formatted managed section including markers.
 */
export function buildPlanDocVersionIndexSection(versions: string[]): string {
  const lines: string[] = [
    `${MANAGED_OPEN_PREFIX} version-index -->`,
    "## Published versions",
    "",
  ]
  if (versions.length === 0) {
    lines.push("_No versioned documents published yet._")
  } else {
    for (const v of versions) {
      lines.push(`- [${v}](./${v}/) — plan artifacts for this version`)
    }
  }
  lines.push(MANAGED_CLOSE)
  return lines.join("\n")
}

/**
 * Update or create the durable draft plan doc (plan.md).
 *
 * If the file already exists, reads it, merges the provided frontmatter
 * values (without removing unknown keys), and rebuilds managed sections
 * while preserving user-authored body content outside managed markers.
 *
 * If the file does not exist, creates it with the given frontmatter and
 * a scaffold body.
 *
 * @param changeId - Unique change identifier.
 * @param frontmatterValues - Frontmatter values to merge.
 * @param options
 * @param options.cwd - Working directory (optional).
 * @param options.repoRoot - Explicit repo root (optional).
 * @param options.repoRelativeDir - Relative path under repo root (default: `"docs/zflow-changes"`).
 * @param options.publishedVersions - Array of version labels for the version-index managed section.
 * @returns The absolute path to the updated plan.md.
 */
export async function writeDurablePlanDoc(
  changeId: string,
  frontmatterValues: Partial<DurablePlanDocFrontmatter>,
  options?: DurablePlanDocOptions & {
    publishedVersions?: string[]
    draftNotes?: string
    bodyContent?: string
  },
): Promise<string> {
  const { default: fs } = await import("node:fs/promises")
  const { default: path } = await import("node:path")
  const repoRoot = await resolveDurablePlanRepoRoot(options)
  const planDocPath = await resolveDurablePlanDocPath(changeId, repoRoot, options?.repoRelativeDir)

  await fs.mkdir(path.dirname(planDocPath), { recursive: true })

  let existingContent: string | null = null
  try {
    existingContent = await fs.readFile(planDocPath, "utf-8")
  } catch {
    existingContent = null
  }

  if (existingContent !== null) {
    const { frontmatter: existingFM, body } = parsePlanDocFrontmatter(existingContent)
    const sections = extractPlanDocSections(body)
    const serializedFrontmatter = buildSerializedDurablePlanDocFrontmatter(changeId, {
      ...existingFM,
      ...frontmatterValues,
    })
    const validationErrors = validateDurablePlanDocFrontmatter(serializedFrontmatter, changeId)
    if (validationErrors.length > 0) {
      throw new Error(`Invalid durable plan.md frontmatter: ${validationErrors.join("; ")}`)
    }

    const normalizedFrontmatter = normalizeDurablePlanDocFrontmatter(changeId, serializedFrontmatter)
    const headerSection = buildPlanDocHeaderSection(
      changeId,
      normalizedFrontmatter.currentVersion,
      normalizedFrontmatter.sourceMode,
    )
    const versionIndexSection = options?.publishedVersions
      ? buildPlanDocVersionIndexSection(options.publishedVersions)
      : (sections.get("version-index") ?? buildPlanDocVersionIndexSection([]))
    const freeContent = options?.bodyContent !== undefined
      ? normalizeDurablePlanDocBody(options.bodyContent)
      : (sections.get("__free__") ?? "")
    const newBody = [headerSection, freeContent, versionIndexSection]
      .filter((part) => part.trim())
      .join("\n\n")

    await fs.writeFile(planDocPath, serializePlanDoc(serializedFrontmatter, newBody), "utf-8")
    return planDocPath
  }

  const serializedFrontmatter = buildSerializedDurablePlanDocFrontmatter(changeId, {
    schemaVersion: frontmatterValues.schemaVersion ?? DURABLE_PLAN_DOC_SCHEMA_VERSION,
    changeId: frontmatterValues.changeId ?? changeId,
    status: frontmatterValues.status ?? "draft",
    sourceMode: frontmatterValues.sourceMode ?? "adhoc",
    currentVersion: frontmatterValues.currentVersion ?? null,
    approvedVersion: frontmatterValues.approvedVersion ?? null,
  })
  const validationErrors = validateDurablePlanDocFrontmatter(serializedFrontmatter, changeId)
  if (validationErrors.length > 0) {
    throw new Error(`Invalid durable plan.md frontmatter: ${validationErrors.join("; ")}`)
  }

  const normalizedFrontmatter = normalizeDurablePlanDocFrontmatter(changeId, serializedFrontmatter)
  const publishedVersions = options?.publishedVersions ?? []
  const baseBody = options?.bodyContent !== undefined
    ? normalizeDurablePlanDocBody(options.bodyContent)
    : (extractPlanDocSections(scaffoldDurablePlanDocBody(changeId, options?.draftNotes)).get("__free__") ?? "")
  const body = [
    buildPlanDocHeaderSection(changeId, normalizedFrontmatter.currentVersion, normalizedFrontmatter.sourceMode),
    baseBody,
    buildPlanDocVersionIndexSection(publishedVersions),
  ].filter((part) => part.trim()).join("\n\n")

  await fs.writeFile(planDocPath, serializePlanDoc(serializedFrontmatter, body), "utf-8")
  return planDocPath
}

/**
 * Read and parse an existing durable draft plan doc.
 *
 * Returns null if the file does not exist.
 *
 * @param changeId - Unique change identifier.
 * @param options
 * @param options.cwd - Working directory (optional).
 * @param options.repoRoot - Explicit repo root (optional).
 * @param options.repoRelativeDir - Relative path under repo root (default: `"docs/zflow-changes"`).
 * @returns Parsed plan doc or null.
 */
export async function readDurablePlanDoc(
  changeId: string,
  options?: DurablePlanDocOptions,
): Promise<DurablePlanDoc | null> {
  const { default: fs } = await import("node:fs/promises")
  const repoRoot = await resolveDurablePlanRepoRoot(options)
  const planDocPath = await resolveDurablePlanDocPath(changeId, repoRoot, options?.repoRelativeDir)

  try {
    const content = await fs.readFile(planDocPath, "utf-8")
    const { frontmatter: rawFM, body } = parsePlanDocFrontmatter(content)
    const validationErrors = validateDurablePlanDocFrontmatter(rawFM, changeId)
    const bodyValidationErrors = validateDurablePlanDocBody(body)
    const frontmatter = normalizeDurablePlanDocFrontmatter(changeId, rawFM)
    return { frontmatter, body, path: planDocPath, validationErrors, bodyValidationErrors }
  } catch {
    return null
  }
}

export function buildPrepareNotesFromDurablePlanDoc(
  draftPlan: DurablePlanDoc | null,
  prepareNotes?: string,
): string {
  const parts: string[] = []
  if (prepareNotes?.trim()) {
    parts.push(prepareNotes.trim())
  }
  if (!draftPlan) {
    return parts.join("\n\n")
  }

  parts.push([
    `Durable draft plan.md path: ${draftPlan.path}`,
    `Durable draft status: ${draftPlan.frontmatter.status}`,
    `Durable draft source mode: ${draftPlan.frontmatter.sourceMode}`,
    draftPlan.frontmatter.currentVersion ? `Durable draft current version: ${draftPlan.frontmatter.currentVersion}` : "",
    draftPlan.frontmatter.approvedVersion ? `Durable draft approved version: ${draftPlan.frontmatter.approvedVersion}` : "",
    ...(draftPlan.frontmatter.sourceMode === "runecontext"
      ? ["RuneContext note: treat RuneContext documents as canonical; this durable draft is a review/index entrypoint only."]
      : []),
    draftPlan.validationErrors.length > 0
      ? `Durable draft frontmatter validation errors: ${draftPlan.validationErrors.join("; ")}`
      : "",
    draftPlan.bodyValidationErrors.length > 0
      ? `Durable draft body validation errors: ${draftPlan.bodyValidationErrors.join("; ")}`
      : "",
    "Durable draft plan.md body:",
    draftPlan.body,
  ].filter(Boolean).join("\n"))

  return parts.join("\n\n")
}
