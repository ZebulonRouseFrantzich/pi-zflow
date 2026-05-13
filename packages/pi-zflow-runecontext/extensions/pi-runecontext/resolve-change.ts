/**
 * resolve-change.ts — RuneContext change resolution.
 *
 * Implements Phase 3 Task 3.2:
 * Given user input or ambient repo context, resolve which RuneContext
 * change folder is canonical and validate its required documents.
 *
 * Supports three resolution strategies:
 *   1. Explicit `changePath` argument (absolute or relative to repoRoot)
 *   2. Ambient CWD walking — search from CWD upward for a change folder
 *   3. (Future) `runectx` helper output parsing
 *
 * The function determines the change flavor ("plain" or "verified") by
 * checking for the presence of `tasks.md`, then validates that all
 * required files for that flavor exist.
 *
 * @module pi-zflow-runecontext/resolve-change
 */

import * as path from "node:path"
import { fileExists } from "./detect.js"
import {
  MissingRequiredFileError,
  ChangeResolutionError,
} from "./errors.js"

// ── Types ────────────────────────────────────────────────────────

/** Supported RuneContext change document flavors. */
export type RuneChangeFlavor = "plain" | "verified"

/**
 * Map of file keys to their absolute paths within a change folder.
 */
export interface ResolvedRuneChangeFiles {
  proposal: string
  design: string
  standards: string
  verification: string
  status: string
  tasks?: string
  references?: string
}

/**
 * A resolved and validated RuneContext change.
 *
 * `changeId` is a deterministic, filesystem-safe identifier derived from
 * the change path relative to the repo root. It includes enough path
 * context to avoid collisions in monorepo layouts.
 */
export interface ResolvedRuneChange {
  /** Filesystem-safe deterministic identifier for this change. */
  changeId: string
  /** Absolute path to the change folder. */
  changePath: string
  /** Detected document flavor. */
  flavor: RuneChangeFlavor
  /** Absolute paths to all recognised change documents. */
  files: ResolvedRuneChangeFiles
}

// ── Constants ────────────────────────────────────────────────────

/** Required files for the "plain" flavor. */
const PLAIN_REQUIRED_FILES = [
  "proposal.md",
  "design.md",
  "standards.md",
  "verification.md",
  "status.yaml",
] as const

/** Extra required files for the "verified" flavor (on top of plain). */
const VERIFIED_EXTRA_FILES = [
  "tasks.md",
  "references.md",
] as const

/** Primary marker file used to identify a RuneContext change folder. */
const MARKER_FILE = "proposal.md"

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Check whether `dirPath` looks like a RuneContext change folder by
 * checking for the primary marker file (`proposal.md`).
 */
async function isChangeFolder(dirPath: string): Promise<boolean> {
  return fileExists(path.join(dirPath, MARKER_FILE))
}

/**
 * Walk upward from `cwd` toward `repoRoot`, checking each directory for
 * RuneContext change folder markers.
 *
 * Returns the absolute path of the first matching directory, or `null`
 * if no change folder is found between `cwd` and `repoRoot` (inclusive
 * of both).
 */
async function findChangeFolder(
  cwd: string,
  repoRoot: string,
): Promise<string | null> {
  let current = path.resolve(cwd)
  const root = path.resolve(repoRoot)

  // Walk up until we reach or pass repoRoot
  while (current.startsWith(root)) {
    if (await isChangeFolder(current)) {
      return current
    }

    // Stop when we've checked repoRoot itself
    if (current === root) {
      break
    }

    const parent = path.dirname(current)
    // Guard against path.dirname returning the same value (root of filesystem)
    if (parent === current) {
      break
    }
    current = parent
  }

  return null
}

/**
 * Convert a relative path (from repoRoot to the change folder) into a
 * deterministic, filesystem-safe `changeId`.
 *
 * This preserves enough directory context to avoid collisions in monorepo
 * layouts while being safe for use in runtime-state file paths on any OS.
 *
 * @example
 *   "packages/foo/changes/my-change" → "packages_foo_changes_my-change"
 */
function toChangeId(relPath: string): string {
  // Replace path separators with underscores, then strip any
  // remaining characters unsafe for file paths.
  return relPath
    .replace(/[/\\]+/g, "_")
    .replace(/[^a-zA-Z0-9_\-]/g, "_")
    .replace(/^_+|_+$/g, "")
    // Collapse multiple consecutive underscores
    .replace(/_+/g, "_")
}

/**
 * Validate that every file in `requiredFiles` exists under `changePath`.
 * Throws a descriptive error listing the first missing file.
 */
async function validateFiles(
  changePath: string,
  requiredFiles: readonly string[],
): Promise<void> {
  for (const file of requiredFiles) {
    const filePath = path.join(changePath, file)
    if (!(await fileExists(filePath))) {
      throw new MissingRequiredFileError(file, filePath)
    }
  }
}

// ── Input type ───────────────────────────────────────────────────

export interface ResolveRuneChangeInput {
  /** Absolute path to the repository root. */
  repoRoot: string
  /**
   * Optional explicit path to the change folder.
   * If relative, resolved against `repoRoot`. If not provided, the
   * current working directory is searched upward for a change folder.
   */
  changePath?: string
}

// ── Main resolver ────────────────────────────────────────────────

/**
 * Resolve and validate a RuneContext change folder.
 *
 * Resolution strategy (in priority order):
 *   1. If `input.changePath` is provided, use it directly.
 *   2. Otherwise, search from `process.cwd()` upward toward `repoRoot`
 *      for a directory containing the primary marker (`proposal.md`).
 *
 * Flavour is determined by checking for `tasks.md` or `references.md`:
 *   - Either present → "verified" (requires tasks.md + references.md)
 *   - Neither present → "plain"
 *
 * After resolution, all required files for the detected flavour are
 * validated. If any are missing, an error names the first absent file.
 *
 * @param input - Resolution parameters.
 * @returns A fully resolved and validated `ResolvedRuneChange`.
 * @throws If no change folder can be resolved, the path is not a valid
 *         change folder, or required documents are missing.
 */
export async function resolveRuneChange(
  input: ResolveRuneChangeInput,
): Promise<ResolvedRuneChange> {
  const { repoRoot, changePath: explicitPath } = input
  const root = path.resolve(repoRoot)

  // ── Step 1: Resolve the change folder absolute path ────────────
  let absChangePath: string

  if (explicitPath !== undefined && explicitPath !== "") {
    // Explicit path — resolve relative to repoRoot if not absolute
    absChangePath = path.resolve(root, explicitPath)
  } else {
    // Ambient resolution — walk up from CWD
    const cwd = process.cwd()
    const found = await findChangeFolder(cwd, root)

    if (found === null) {
      throw new ChangeResolutionError(
        `Cannot resolve RuneContext change folder: no change folder found ` +
          `from current directory (${cwd}) up to repo root (${root}). ` +
          `Provide an explicit change-path argument, or change into a RuneContext ` +
          `change directory.`,
      )
    }

    absChangePath = found
  }

  // ── Step 2: Verify the resolved path is a valid change folder ──
  if (!(await isChangeFolder(absChangePath))) {
    throw new ChangeResolutionError(
      `The given path does not appear to be a RuneContext change folder: ` +
        `${absChangePath} (no ${MARKER_FILE} found).`,
    )
  }

  // ── Step 3: Determine flavor ───────────────────────────────────
  const hasTasks = await fileExists(path.join(absChangePath, "tasks.md"))
  const hasRefs = await fileExists(path.join(absChangePath, "references.md"))
  const flavor: RuneChangeFlavor = (hasTasks || hasRefs) ? "verified" : "plain"

  // ── Step 4: Validate required files ────────────────────────────
  await validateFiles(absChangePath, PLAIN_REQUIRED_FILES)

  if (flavor === "verified") {
    await validateFiles(absChangePath, VERIFIED_EXTRA_FILES)
  }

  // ── Step 5: Compute deterministic changeId ─────────────────────
  const relPath = path.relative(root, absChangePath)
  const changeId = toChangeId(relPath)

  // ── Step 6: Build result ───────────────────────────────────────
  const files: ResolvedRuneChangeFiles = {
    proposal: path.join(absChangePath, "proposal.md"),
    design: path.join(absChangePath, "design.md"),
    standards: path.join(absChangePath, "standards.md"),
    verification: path.join(absChangePath, "verification.md"),
    status: path.join(absChangePath, "status.yaml"),
  }

  if (flavor === "verified") {
    files.tasks = path.join(absChangePath, "tasks.md")
    files.references = path.join(absChangePath, "references.md")
  }

  return {
    changeId,
    changePath: absChangePath,
    flavor,
    files,
  }
}
