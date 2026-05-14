/**
 * verification.ts — Verification command resolution and execution for pi-zflow.
 *
 * Provides verification command resolution (profile → repo config → auto-detect),
 * execution with output capture, and failure-log integration.
 *
 * ## Verification command resolution policy
 *
 * Precedence (highest first):
 * 1. `verificationCommand` from the active profile
 * 2. explicit shared repo config (e.g. under a `zflow` key in `.pi/settings.json`)
 * 3. auto-detection in this exact order:
 *    - `just ci-fast` when `justfile` exists and the recipe exists
 *    - `npm test` when `package.json` has a `test` script
 *    - `make check` or `make test` when `Makefile` exists
 *    - `cargo test` when `Cargo.toml` exists
 *    - `pytest` when `pyproject.toml` or `setup.py` exists
 *    - otherwise return null (prompt user or explicitly skip)
 *
 * @module pi-zflow-change-workflows/verification
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import * as path from "node:path"
import { resolveFailureLogPath } from "pi-zflow-artifacts/artifact-paths"

// ── Types ───────────────────────────────────────────────────────

/**
 * Result of running a verification command.
 */
export interface VerificationResult {
  /** Whether the verification passed. */
  pass: boolean
  /** The full command that was run. */
  command: string
  /** Standard output from the command. */
  output: string
  /** Duration in milliseconds. */
  duration: number
  /** Error message if the command failed to execute. */
  error?: string
}

// ── Verification command resolution ───────────────────────────

/**
 * Resolve the verification command for a repo using precedence rules.
 *
 * Precedence:
 * 1. `verificationCommand` from the active profile (caller passes this)
 * 2. repo config `.pi/settings.json` under a `zflow` key
 * 3. auto-detection in documented order
 *
 * When auto-detecting, this function logs which command was found via
 * console.info so the caller can inform the user.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @param profileCommand - Optional verification command from the active profile.
 * @returns The resolved command string, or `null` if nothing was found.
 */
export function resolveVerificationCommand(
  repoRoot: string,
  profileCommand?: string,
): string | null {
  // 1. Profile-level command takes highest precedence
  if (profileCommand) {
    return profileCommand
  }

  // 2. Check repo config (`.pi/settings.json` with optional `zflow.verificationCommand`)
  const settingsPath = path.join(repoRoot, ".pi", "settings.json")
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"))
      const repoCommand = settings?.zflow?.verificationCommand
      if (typeof repoCommand === "string" && repoCommand.trim()) {
        return repoCommand.trim()
      }
    } catch {
      // Malformed settings file — skip silently
    }
  }

  // 3. Auto-detection in documented order
  // 3a. `just ci-fast` when justfile exists and has the recipe
  const justfile = path.join(repoRoot, "justfile")
  if (existsSync(justfile)) {
    const content = readFileSync(justfile, "utf-8")
    if (content.includes("ci-fast:")) {
      console.info("[zflow] Auto-detected verification command: just ci-fast")
      return "just ci-fast"
    }
  }

  // 3b. `npm test` when package.json exists and has a test script
  const pkgJson = path.join(repoRoot, "package.json")
  if (existsSync(pkgJson)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, "utf-8"))
      if (pkg.scripts?.test) {
        console.info("[zflow] Auto-detected verification command: npm test")
        return "npm test"
      }
    } catch {
      // Malformed package.json — skip
    }
  }

  // 3c. `make check` or `make test` when Makefile exists
  const makefile = path.join(repoRoot, "Makefile")
  if (existsSync(makefile)) {
    const content = readFileSync(makefile, "utf-8")
    if (content.includes("check:")) {
      console.info("[zflow] Auto-detected verification command: make check")
      return "make check"
    }
    if (content.includes("test:")) {
      console.info("[zflow] Auto-detected verification command: make test")
      return "make test"
    }
  }

  // 3d. `cargo test` when Cargo.toml exists
  if (existsSync(path.join(repoRoot, "Cargo.toml"))) {
    console.info("[zflow] Auto-detected verification command: cargo test")
    return "cargo test"
  }

  // 3e. `pytest` when pyproject.toml or setup.py exists
  if (
    existsSync(path.join(repoRoot, "pyproject.toml")) ||
    existsSync(path.join(repoRoot, "setup.py"))
  ) {
    console.info("[zflow] Auto-detected verification command: pytest")
    return "pytest"
  }

  return null
}

// ── Verification execution ────────────────────────────────────

/**
 * Run a verification command and capture the result.
 *
 * Executes the given command via `bash -c` in the repo root directory.
 * Captures stdout, stderr, exit code, and duration.
 *
 * @param command - The shell command to run.
 * @param repoRoot - Absolute path to the repository root.
 * @returns A `VerificationResult` with pass/fail, output, and timing.
 */
export async function runVerification(
  command: string,
  repoRoot: string,
): Promise<VerificationResult> {
  const start = Date.now()

  try {
    const output = execFileSync("bash", ["-c", command], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 15 * 60 * 1000, // 15 minutes
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024, // 10 MB
    })

    const redacted = redactSecrets(output)

    return {
      pass: true,
      command,
      output: redacted,
      duration: Date.now() - start,
    }
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException & {
      stdout?: string
      stderr?: string
      status?: number
    }

    const rawOutput = (nodeErr.stdout ?? "") + "\n" + (nodeErr.stderr ?? "")
    const redacted = redactSecrets(rawOutput)

    return {
      pass: false,
      command,
      output: redacted,
      duration: Date.now() - start,
      error: nodeErr.message ?? String(err),
    }
  }
}

// ── Failure log integration ────────────────────────────────────

/**
 * Append a structured failure entry to the failure log.
 *
 * Writes to `<runtime-state-dir>/failure-log.md`. Creates the file and
 * parent directory if they don't exist.
 *
 * @param context - Short human-readable context label (e.g. "Apply-back conflict").
 * @param details - Multi-line markdown body with expected, actual, root cause, fix.
 * @param cwd - Working directory (optional, for resolving runtime state dir).
 */
export async function appendFailureLog(
  context: string,
  details: string,
  cwd?: string,
): Promise<void> {
  const { default: fs } = await import("node:fs/promises")
  const failureLogPath = resolveFailureLogPath(cwd)

  const entry = [
    "",
    `## ${new Date().toISOString()}: ${context}`,
    details,
    "",
  ].join("\n")

  try {
    await fs.appendFile(failureLogPath, entry, "utf-8")
  } catch {
    // Ensure parent directory exists
    await fs.mkdir(path.dirname(failureLogPath), { recursive: true })
    await fs.appendFile(failureLogPath, entry, "utf-8")
  }
}

// ── Internal helpers ──────────────────────────────────────────

/**
 * Redact strings that look like secrets from verification output.
 *
 * Patterns redacted:
 * - Bearer tokens, API keys, auth headers
 * - AWS secret keys, GitHub tokens, npm tokens
 * - Generic `key=value` pairs where the value looks like a token
 * - Long hex/base64 strings that look like hashes or secrets
 *
 * @param text - Raw output to redact.
 * @returns Redacted output with secrets replaced by `[REDACTED]`.
 */
export function redactSecrets(text: string): string {
  return text
    // Bearer tokens and authorization headers
    .replace(/(Bearer\s+)[a-zA-Z0-9\-._~+/]{20,}/gi, "$1[REDACTED]")
    .replace(/(Authorization:\s*)[^\n\r]{10,}/gi, "$1[REDACTED]")
    // AWS secret keys
    .replace(/AKIA[0-9A-Z]{16}/g, "AKIA[REDACTED]")
    // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
    .replace(/(ghp_|gho_|ghu_|ghs_|ghr_)[a-zA-Z0-9]{36,}/g, "$1[REDACTED]")
    // npm tokens (npm_)
    .replace(/npm_[a-zA-Z0-9]{36,}/g, "npm_[REDACTED]")
    // Generic API keys and tokens in key=value format
    .replace(/(API[_-]?KEY|API[_-]?TOKEN|SECRET[_-]?KEY|ACCESS[_-]?KEY)[=:]\s*['"]?[a-zA-Z0-9\-._~+/]{16,}['"]?/gi, "$1=[REDACTED]")
    // Long hex strings (likely hashes or tokens, 32+ hex chars)
    .replace(/\b[0-9a-fA-F]{32,}\b/g, "[REDACTED-HEX]")
    // Long base64 strings (40+ chars of base64)
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, "[REDACTED-BASE64]")
}
