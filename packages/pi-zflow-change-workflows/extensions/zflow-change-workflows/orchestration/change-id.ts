/**
 * change-id.ts — semantic change-id derivation helpers shared across workflows.
 */

const CHANGE_ID_NOISE_TOKENS = new Set([
  "change",
  "changes",
  "idea",
  "ideas",
  "doc",
  "docs",
  "plan",
  "draft",
  "spec",
  "specification",
  "combined",
])

/**
 * Derive a stable, semantic change identifier from a path or title.
 *
 * The durable change-doc directory is intended to be reviewed and committed,
 * so it should describe the change rather than the source file location or a
 * timestamp. For file paths, this uses the basename/stem and removes common
 * planning-document noise words such as `combined` and `spec`.
 *
 * @param changePath - Path or title supplied to `/zflow-change-prepare`.
 * @returns A kebab-case semantic identifier, or null when no useful slug exists.
 */
export function deriveSemanticChangeId(changePath?: string): string | null {
  if (!changePath) return null
  const cleaned = changePath.trim().replace(/^@+/, "")
  if (!cleaned) return null

  const parts = cleaned.split(/[\\/]/).filter(Boolean)
  const durableIndex = parts.lastIndexOf("zflow-changes")
  if (durableIndex !== -1 && parts[durableIndex + 1]) {
    return parts[durableIndex + 1]!.toLowerCase()
  }

  const segment = parts.at(-1) ?? cleaned
  const stem = segment.replace(/\.[^.]+$/, "")
  const tokens = stem
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .split("-")
    .filter(Boolean)

  const semanticTokens = tokens.filter((token) => !CHANGE_ID_NOISE_TOKENS.has(token))
  const chosenTokens = semanticTokens.length >= 2 ? semanticTokens : tokens
  const slug = chosenTokens.join("-").slice(0, 72).replace(/-+$/g, "")
  return slug || null
}

/**
 * Generate a change identifier.
 *
 * If a `changePath` is provided, derives a stable semantic slug from its
 * basename/title. Otherwise creates a timestamp-only fallback ID.
 *
 * @param changePath - Optional path/title to derive the slug from.
 * @returns A kebab-case change ID string.
 */
export function generateChangeId(changePath?: string): string {
  return deriveSemanticChangeId(changePath) ?? `change-${Date.now().toString(36)}`
}
