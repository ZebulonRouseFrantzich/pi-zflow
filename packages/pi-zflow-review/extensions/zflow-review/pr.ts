/**
 * pr.ts — PR/MR URL parsing, host detection, and CLI command builders.
 *
 * Provides pure functions for parsing GitHub PR and GitLab MR URLs,
 * detecting the hosting platform, building `gh`/`glab` API commands,
 * and validating URL format — all without making network calls.
 *
 * ## Usage
 *
 * ```ts
 * import { parsePrUrl, detectHost, buildPrApiCommands, validatePrUrl }
 *   from "pi-zflow-review"
 *
 * const target = parsePrUrl("https://github.com/owner/repo/pull/42")
 * // { platform: "github", owner: "owner", repo: "repo", number: 42, url: "..." }
 *
 * const cmds = buildPrApiCommands(target)
 * // { metadata: "gh api /repos/owner/repo/pulls/42", files: "gh api /repos/owner/repo/pulls/42/files" }
 * ```
 *
 * ## Supported URL patterns
 *
 * **GitHub:**
 * - `https://github.com/{owner}/{repo}/pull/{number}`
 * - `https://github.com/{owner}/{repo}/pull/{number}/files`
 * - `https://github.com/{owner}/{repo}/pull/{number}/commits`
 *
 * **GitLab:**
 * - `https://gitlab.com/{owner}/{repo}/-/merge_requests/{number}`
 * - `https://gitlab.com/{owner}/{repo}/-/merge_requests/{number}/diffs`
 *
 * @module pi-zflow-review/pr
 */

// ── Types ──────────────────────────────────────────────────────

/**
 * Supported hosting platforms for PR/MR review.
 */
export type PrPlatform = "github" | "gitlab"

/**
 * Parsed and resolved PR/MR target coordinates.
 */
export interface ResolvedPrTarget {
  /** Hosting platform */
  platform: PrPlatform
  /** Repository owner (user or org) */
  owner: string
  /** Repository name */
  repo: string
  /** PR/MR number */
  number: number
  /** Full canonical URL to the PR/MR */
  url: string
}

/**
 * CLI command strings for fetching PR/MR data from the platform.
 */
export interface PrApiCommands {
  /** Command to fetch PR/MR metadata (title, description, state, etc.) */
  metadata: string
  /** Command to fetch changed files and patches */
  files: string
}

/**
 * URL validation result.
 */
export interface PrUrlValidation {
  /** Whether the URL is a valid PR/MR URL */
  valid: boolean
  /** Error description when invalid */
  error?: string
}

// ── URL parsing ────────────────────────────────────────────────

/**
 * Regex patterns for GitHub PR and GitLab MR URLs.
 *
 * GitHub: https://github.com/{owner}/{repo}/pull/{number}[/...]
 * GitLab: https://gitlab.com/{owner}/{repo}/-/merge_requests/{number}[/...]
 */
const GITHUB_PR_PATTERN =
  /^https?:\/\/github\.com\/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)\/pull\/(\d+)(?:\/.*)?$/
const GITLAB_MR_PATTERN =
  /^https?:\/\/gitlab\.com\/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)\/-\/merge_requests\/(\d+)(?:\/.*)?$/

/**
 * Parse a GitHub PR or GitLab MR URL into structured target coordinates.
 *
 * @param url - The full PR/MR URL to parse.
 * @returns ResolvedPrTarget with platform, owner, repo, number, and URL.
 * @throws If the URL is not a recognised GitHub PR or GitLab MR URL.
 */
export function parsePrUrl(url: string): ResolvedPrTarget {
  const trimmed = url.replace(/\/+$/, "").split("?")[0] // strip trailing slash and query params
  const cleanUrl = trimmed ?? url

  // Try GitHub pattern
  const ghMatch = cleanUrl.match(GITHUB_PR_PATTERN)
  if (ghMatch) {
    const [, owner, repo, numberStr] = ghMatch
    const number = parseInt(numberStr, 10)
    return {
      platform: "github",
      owner,
      repo,
      number,
      url: `https://github.com/${owner}/${repo}/pull/${number}`,
    }
  }

  // Try GitLab pattern
  const glMatch = cleanUrl.match(GITLAB_MR_PATTERN)
  if (glMatch) {
    const [, owner, repo, numberStr] = glMatch
    const number = parseInt(numberStr, 10)
    return {
      platform: "gitlab",
      owner,
      repo,
      number,
      url: `https://gitlab.com/${owner}/${repo}/-/merge_requests/${number}`,
    }
  }

  throw new Error(
    `Unrecognised PR/MR URL: "${url}". ` +
    "Expected a GitHub PR URL (https://github.com/{owner}/{repo}/pull/{number}) " +
    "or a GitLab MR URL (https://gitlab.com/{owner}/{repo}/-/merge_requests/{number}).",
  )
}

// ── Host detection ─────────────────────────────────────────────

/**
 * Detect the hosting platform from a URL.
 *
 * @param url - The URL to inspect.
 * @returns `"github"` if the URL contains github.com, `"gitlab"` if it
 *   contains gitlab.com, or `null` for unrecognised hosts.
 */
export function detectHost(url: string): PrPlatform | null {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.toLowerCase()

    if (hostname === "github.com") return "github"
    if (hostname === "gitlab.com") return "gitlab"

    return null
  } catch {
    return null
  }
}

// ── CLI command builders ───────────────────────────────────────

/**
 * Build the `gh` / `glab` CLI command strings for fetching PR/MR data.
 *
 * The commands are returned as strings, not executed. The caller is
 * responsible for executing them when needed.
 *
 * **GitHub commands:**
 * - `gh api /repos/{owner}/{repo}/pulls/{number}`
 * - `gh api /repos/{owner}/{repo}/pulls/{number}/files`
 *
 * **GitLab commands:**
 * - `glab api projects/{owner}%2F{repo}/merge_requests/{number}`
 * - `glab api projects/{owner}%2F{repo}/merge_requests/{number}/changes`
 *
 * @param target - Resolved PR/MR target.
 * @returns An object with `metadata` and `files` CLI command strings.
 */
export function buildPrApiCommands(target: ResolvedPrTarget): PrApiCommands {
  if (target.platform === "github") {
    const base = `/repos/${target.owner}/${target.repo}/pulls/${target.number}`
    return {
      metadata: `gh api ${base}`,
      files: `gh api ${base}/files`,
    }
  }

  // GitLab
  const encodedPath = `${target.owner}%2F${target.repo}`
  const base = `projects/${encodedPath}/merge_requests/${target.number}`
  return {
    metadata: `glab api ${base}`,
    files: `glab api ${base}/changes`,
  }
}

// ── URL validation ─────────────────────────────────────────────

/**
 * Validate whether a URL is a recognised GitHub PR or GitLab MR URL.
 *
 * Unlike `parsePrUrl`, this function does not throw — it returns a
 * result object with `{ valid: true }` or `{ valid: false, error: "..." }`.
 *
 * @param url - The URL to validate.
 * @returns A validation result indicating validity and optional error.
 */
export function validatePrUrl(url: string): PrUrlValidation {
  if (typeof url !== "string" || url.trim() === "") {
    return { valid: false, error: "URL must be a non-empty string." }
  }

  try {
    parsePrUrl(url)
    return { valid: true }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return { valid: false, error: message }
  }
}
