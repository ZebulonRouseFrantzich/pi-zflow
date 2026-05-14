/**
 * rtk-check.ts — RTK binary availability check and user alerting.
 *
 * The `rtk` binary is required for command rewriting in pi-rtk-optimizer.
 * When `rtk` is missing, command rewriting degrades gracefully but the
 * user should be alerted so they can install it. Output compaction still
 * works without `rtk`.
 *
 * ## Usage
 *
 * ```ts
 * import { ensureRtkOrAlert } from "pi-zflow-compaction"
 *
 * const result = await ensureRtkOrAlert()
 * if (!result.available) {
 *   // Command rewriting unavailable; alert already shown to user
 * }
 * ```
 *
 * @module pi-zflow-compaction/rtk-check
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

// ── Types ───────────────────────────────────────────────────────

/**
 * Result of an RTK binary availability check.
 */
export interface RtkCheckResult {
  /** Whether the `rtk` binary was found and executed successfully. */
  available: boolean
  /** Version string from `rtk --version`, if available. */
  version?: string
  /** Resolved path to the `rtk` binary, if available. */
  path?: string
}

// ── Check implementation ────────────────────────────────────────

/**
 * Check whether the `rtk` binary is available on the system PATH.
 *
 * Runs `rtk --version` with a 5-second timeout. Returns the version
 * string and binary path on success, or `{ available: false }` if the
 * binary is not found or fails to execute.
 *
 * @returns An `RtkCheckResult` describing the availability of `rtk`.
 */
export async function checkRtkAvailability(): Promise<RtkCheckResult> {
  try {
    const { stdout } = await execFileAsync("rtk", ["--version"], {
      timeout: 5000,
    })
    const version = stdout.trim().split("\n")[0]

    // Resolve the full path to the rtk binary via `which`.
    // Gracefully degrade if path resolution fails — the version
    // check already confirmed availability.
    let resolvedPath: string | undefined
    try {
      const { stdout: pathStdout } = await execFileAsync("which", ["rtk"], {
        timeout: 3000,
      })
      resolvedPath = pathStdout.trim().split("\n")[0] || undefined
    } catch {
      // Path resolution failed; return result without path.
    }

    return { available: true, version, path: resolvedPath }
  } catch {
    return { available: false }
  }
}

/**
 * Alert the user that `rtk` is not installed.
 *
 * Calls `console.warn` with the standard alert message. Output
 * compaction will still work without `rtk`; only command rewriting
 * requires it.
 */
export async function alertRtkMissing(): Promise<void> {
  console.warn(
    "Install rtk for command rewriting. Output compaction will still work without it.",
  )
}

/**
 * Combined check-and-alert: check availability and alert if missing.
 *
 * This is the primary entry point for startup/bootstrap checks.
 * It runs the availability check, emits a warning if `rtk` is not
 * found, and returns the check result so callers can decide how to
 * proceed.
 *
 * @returns The `RtkCheckResult` from the availability check.
 */
export async function ensureRtkOrAlert(): Promise<RtkCheckResult> {
  const result = await checkRtkAvailability()
  if (!result.available) {
    await alertRtkMissing()
  }
  return result
}
