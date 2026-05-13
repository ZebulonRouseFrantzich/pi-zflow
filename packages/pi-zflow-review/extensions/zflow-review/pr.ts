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

// ── Diff fetch types ───────────────────────────────────────────

/**
 * PR/MR metadata fetched from the hosting platform.
 */
export interface PrMetadata {
  platform: "github" | "gitlab"
  owner: string
  repo: string
  number: number
  title: string
  description: string
  state: string
  headSha: string
  baseSha: string
  url: string
}

/**
 * A single changed file entry from a PR/MR diff.
 */
export interface PrFile {
  path: string
  status: "added" | "modified" | "removed" | "renamed"
  additions: number
  deletions: number
  patch?: string
}

/**
 * Complete diff fetch result for a PR/MR.
 */
export interface PrFetchResult {
  metadata: PrMetadata
  files: PrFile[]
  diffContent: string
}

/**
 * Command runner callback for executing CLI commands.
 * Accepts a shell command string and returns its stdout.
 */
export type CommandRunner = (command: string) => Promise<string>

/**
 * Default command runner that executes CLI commands via child_process.exec.
 */
export const defaultCommandRunner: CommandRunner = async (
  command: string,
): Promise<string> => {
  const { exec } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const execAsync = promisify(exec)
  const { stdout } = await execAsync(command, { timeout: 30_000 })
  return stdout
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

// ── Fetch command builders ─────────────────────────────────────

/**
 * Build the exact CLI commands needed to fetch PR/MR data.
 *
 * Returns the command strings for fetching metadata and changed files.
 *
 * **GitHub:**
 * - `gh api /repos/{owner}/{repo}/pulls/{number}` (metadata)
 * - `gh api /repos/{owner}/{repo}/pulls/{number}/files` (files)
 *
 * **GitLab:**
 * - `glab api projects/{owner}%2F{repo}/merge_requests/{number}` (metadata)
 * - `glab api projects/{owner}%2F{repo}/merge_requests/{number}/changes` (files)
 *
 * @param target - Resolved PR/MR target.
 * @returns An object with `metadata` and `files` command strings.
 */
export function buildFetchCommands(target: ResolvedPrTarget): PrApiCommands {
  // Reuses buildPrApiCommands which already produces the correct commands
  return buildPrApiCommands(target)
}

/**
 * Parse a PR/MR metadata API response into a normalized PrMetadata object.
 *
 * Handles differences between GitHub and GitLab API response shapes.
 *
 * @param platform - The hosting platform.
 * @param data - Parsed JSON response from the metadata API.
 * @returns Normalized PrMetadata.
 */
export function parsePrMetadataResponse(
  platform: PrPlatform,
  data: Record<string, unknown>,
): PrMetadata {
  if (platform === "github") {
    return {
      platform: "github",
      owner: data.head?.repo?.owner?.login as string ?? "",
      repo: data.head?.repo?.name as string ?? "",
      number: data.number as number,
      title: data.title as string ?? "",
      description: data.body as string ?? "",
      state: data.state as string ?? "",
      headSha: data.head?.sha as string ?? "",
      baseSha: data.base?.sha as string ?? "",
      url: data.html_url as string ?? "",
    }
  }

  // GitLab
  return {
    platform: "gitlab",
    owner: "",
    repo: "",
    number: data.iid as number ?? (data.number as number ?? 0),
    title: data.title as string ?? "",
    description: data.description as string ?? "",
    state: data.state as string ?? "",
    headSha: data.sha as string ?? "",
    baseSha: data.diff_refs?.base_sha as string ?? "",
    url: data.web_url as string ?? "",
  }
}

/**
 * Parse a PR/MR files/changes API response into a normalized PrFile array.
 *
 * @param platform - The hosting platform.
 * @param data - Parsed JSON response from the files API.
 * @returns Array of normalized PrFile objects.
 */
export function parsePrFilesResponse(
  platform: PrPlatform,
  data: unknown[],
): PrFile[] {
  if (platform === "github") {
    return data.map((entry: Record<string, unknown>) => ({
      path: (entry.filename as string) ?? (entry.path as string) ?? "",
      status: normalizeFileStatus(entry.status as string),
      additions: (entry.additions as number) ?? 0,
      deletions: (entry.deletions as number) ?? 0,
      patch: (entry.patch as string) ?? undefined,
    }))
  }

  // GitLab
  return data.map((entry: Record<string, unknown>) => ({
    path: (entry.new_path as string) ?? (entry.path as string) ?? "",
    status: normalizeFileStatus(entry.new_file ? "added" : entry.renamed_file ? "renamed" : entry.deleted_file ? "removed" : entry.status as string ?? "modified"),
    additions: 0,
    deletions: 0,
    patch: (entry.diff as string) ?? undefined,
  }))
}

/**
 * Normalize a file status string to the PrFile status union.
 */
function normalizeFileStatus(status: string): PrFile["status"] {
  const s = status?.toLowerCase() ?? ""
  if (s === "added" || s === "add") return "added"
  if (s === "removed" || s === "deleted" || s === "deletion") return "removed"
  if (s === "renamed" || s === "rename") return "renamed"
  return "modified"
}

/**
 * Combine file patches into a single unified diff string.
 *
 * Each file entry produces a standard diff header with its path and patch.
 *
 * @param files - Array of PrFile entries (must have patch content).
 * @returns Combined diff string, or empty string if no files have patches.
 */
export function combineDiffContent(files: PrFile[]): string {
  const parts: string[] = []

  for (const file of files) {
    if (!file.patch) continue
    parts.push(`diff --git a/${file.path} b/${file.path}`)
    parts.push(file.patch)
  }

  return parts.join("\n")
}

/**
 * Fetch PR/MR metadata and diff content using CLI commands.
 *
 * Uses the provided `commandRunner` to execute platform-specific `gh`/`glab`
 * API commands. When no runner is provided, defaults to `defaultCommandRunner`
 * which uses `child_process.exec`.
 *
 * This function is fully diff-based — it does not check out code, run builds,
 * or execute PR code.
 *
 * @param target - Resolved PR/MR target (from parsePrUrl).
 * @param commandRunner - Optional callback for CLI execution (for testing).
 * @returns PrFetchResult with metadata, files, and combined diff content.
 * @throws If API calls fail or return non-JSON responses.
 */
export async function fetchPrDiff(
  target: ResolvedPrTarget,
  commandRunner?: CommandRunner,
): Promise<PrFetchResult> {
  const run = commandRunner ?? defaultCommandRunner
  const cmds = buildFetchCommands(target)

  // Fetch metadata
  const metadataRaw = await run(cmds.metadata)
  const metadataData: Record<string, unknown> = JSON.parse(metadataRaw)
  const metadata = parsePrMetadataResponse(target.platform, metadataData)

  // Fill in owner/repo from target (not always in API response)
  metadata.owner = target.owner
  metadata.repo = target.repo

  // Fetch files
  const filesRaw = await run(cmds.files)
  const filesParsed: unknown = JSON.parse(filesRaw)
  let filesData: unknown[]
  if (Array.isArray(filesParsed)) {
    filesData = filesParsed as unknown[]
  } else {
    // GitLab returns { changes: [...] } or similar wrappers
    const filesObj = filesParsed as Record<string, unknown>
    if (target.platform === "gitlab") {
      const changes = filesObj.changes as unknown[]
      filesData = Array.isArray(changes) ? changes : [filesObj]
    } else {
      filesData = []
    }
  }
  const files = parsePrFilesResponse(target.platform, filesData)

  // Build combined diff content
  const diffContent = combineDiffContent(files)

  return { metadata, files, diffContent }
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

// ── Auth checking ──────────────────────────────────────────────

/**
 * Result of checking CLI authentication for a hosting platform.
 */
export interface AuthStatus {
  /** Whether the CLI is authenticated. */
  authenticated: boolean
  /** The platform that was checked. */
  platform: PrPlatform
  /** Authenticated username, if available. */
  username?: string
  /** Error description when not authenticated or check failed. */
  error?: string
}

/**
 * Whether submission of inline comments is possible.
 */
export interface SubmissionCapability {
  /** Whether inline comment submission is possible. */
  canSubmit: boolean
  /** Result of the authentication check. */
  authStatus: AuthStatus
  /** Human-readable message when submission is not possible. */
  fallbackMessage?: string
}

/**
 * Check whether the `gh` or `glab` CLI is authenticated.
 *
 * Runs the platform's auth status command and parses the output.
 * Returns structured `AuthStatus` with the authenticated flag and
 * the detected username when available.
 *
 * @param platform - The hosting platform to check.
 * @param commandRunner - Optional command runner (defaults to `defaultCommandRunner`).
 * @returns AuthStatus with authenticated flag, username, and optional error.
 */
export async function checkAuthStatus(
  platform: PrPlatform,
  commandRunner?: CommandRunner,
): Promise<AuthStatus> {
  const run = commandRunner ?? defaultCommandRunner

  if (platform === "github") {
    try {
      const stdout = await run("gh auth status 2>&1")
      // Parse "Logged in to github.com as <username>"
      const usernameMatch = stdout.match(/as\s+([^\s]+)/)
      return {
        authenticated: true,
        platform: "github",
        username: usernameMatch?.[1]?.replace(/[^a-zA-Z0-9._-]/g, "") ?? undefined,
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        authenticated: false,
        platform: "github",
        error: message,
      }
    }
  }

  // GitLab
  try {
    const stdout = await run("glab auth status 2>&1")
    // Parse "Logged in to gitlab.com as <username>"
    const usernameMatch = stdout.match(/as\s+([^\s]+)/)
    return {
      authenticated: true,
      platform: "gitlab",
      username: usernameMatch?.[1]?.replace(/[^a-zA-Z0-9._-]/g, "") ?? undefined,
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      authenticated: false,
      platform: "gitlab",
      error: message,
    }
  }
}

/**
 * Determine whether inline comment submission is possible for a platform.
 *
 * Checks CLI authentication and returns a `SubmissionCapability` with
 * a `canSubmit` flag and a fallback message when submission is not
 * possible.
 *
 * @param platform - The hosting platform to check.
 * @param commandRunner - Optional command runner (defaults to `defaultCommandRunner`).
 * @returns SubmissionCapability with canSubmit, authStatus, and fallback message.
 */
export async function checkSubmissionCapability(
  platform: PrPlatform,
  commandRunner?: CommandRunner,
): Promise<SubmissionCapability> {
  const authStatus = await checkAuthStatus(platform, commandRunner)

  if (authStatus.authenticated) {
    return {
      canSubmit: true,
      authStatus,
    }
  }

  const cliName = platform === "github" ? "gh" : "glab"
  return {
    canSubmit: false,
    authStatus,
    fallbackMessage:
      `Authentication for ${platform} not available. ` +
      `To submit inline comments, configure \`${cliName} auth login\`.`,
  }
}

// ── Comment submission command builders ────────────────────────

/**
 * Input for building a submit comment command.
 */
export interface SubmitCommentInput {
  /** The PR/MR target to submit to. */
  target: ResolvedPrTarget
  /** The body text of the comment. */
  body: string
  /** Optional file path for line-specific comments. */
  path?: string
  /** Optional line number for line-specific comments. */
  line?: number
}

/**
 * Build the CLI command string for submitting an inline comment to a
 * PR/MR via `gh` or `glab` API.
 *
 * **GitHub:**
 * ```
 * gh api repos/{owner}/{repo}/pulls/{number}/comments \
 *   --method POST \
 *   -f body="..." \
 *   -f path="..." \
 *   -F line=...
 * ```
 *
 * **GitLab:**
 * ```
 * glab api projects/{owner}%2F{repo}/merge_requests/{number}/notes \
 *   --method POST \
 *   -f body="..."
 * ```
 *
 * @param input - Submit comment input with target, body, optional path and line.
 * @returns The CLI command string for submitting the comment.
 */
export function buildSubmitCommentCommand(input: SubmitCommentInput): string {
  const { target, body, path, line } = input

  if (target.platform === "github") {
    const base = `/repos/${target.owner}/${target.repo}/pulls/${target.number}/comments`
    let cmd = `gh api ${base} --method POST -f body=${JSON.stringify(body)}`
    if (path !== undefined) {
      cmd += ` -f path=${JSON.stringify(path)}`
    }
    if (line !== undefined) {
      cmd += ` -F line=${line}`
    }
    return cmd
  }

  // GitLab
  const encodedPath = `${target.owner}%2F${target.repo}`
  const base = `projects/${encodedPath}/merge_requests/${target.number}/notes`
  let cmd = `glab api ${base} --method POST -f body=${JSON.stringify(body)}`
  if (path !== undefined) {
    cmd += ` -f path=${JSON.stringify(path)}`
  }
  return cmd
}

/**
 * Format a message explaining that submission was skipped due to
 * missing authentication.
 *
 * @param platform - The hosting platform.
 * @param findingsPath - Path to the exported findings file.
 * @returns A human-readable message.
 */
export function formatAuthSkipMessage(
  platform: PrPlatform,
  findingsPath: string,
): string {
  const cliName = platform === "github" ? "gh" : "glab"
  return (
    `Authentication for ${platform} not available. ` +
    `Review findings exported to ${findingsPath}. ` +
    `To submit comments, configure \`${cliName}\` authentication.`
  )
}
