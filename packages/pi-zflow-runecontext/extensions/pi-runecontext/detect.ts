/**
 * detect.ts — RuneContext root detection.
 *
 * Implements Phase 3 Task 3.1:
 * Detect whether the current repo/workspace should be treated as
 * RuneContext-managed by checking for:
 *   - presence of `runecontext.yaml` at the repo root
 *   - successful `runectx status` command
 *
 * The detection result explains why RuneContext mode is or is not active,
 * enabling downstream consumers to understand the detection decision.
 *
 * Behavior rules:
 *   - Missing `runectx` must not break non-RuneContext repos
 *   - Detection result explains why RuneContext mode is or is not active
 *   - No false-positive dependence on a single marker
 *
 * @module pi-zflow-runecontext/detect
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import { execSync } from "node:child_process"

// ── Types ────────────────────────────────────────────────────────

/**
 * RuneContext detection result.
 *
 * Describes whether the repository at the given path is managed by
 * RuneContext, and if so, what detection source triggered the positive
 * result.
 */
export interface RuneContextDetection {
  /** Whether RuneContext is detected and active for this repo. */
  enabled: boolean
  /**
   * Human-readable explanation of why RuneContext mode is or is not
   * active (e.g. "runecontext.yaml found", "runectx status succeeded",
   * "no RuneContext markers detected").
   */
  source: string
  /**
   * The specific detection source that triggered enablement, if
   * `enabled` is `true`. One of "runecontext.yaml" or "runectx status".
   * `undefined` when `enabled` is `false`.
   */
  detectionSource?: "runecontext.yaml" | "runectx status"
  /**
   * The absolute path to the `runecontext.yaml` file, if that was the
   * detection source. `undefined` otherwise.
   */
  runecontextYamlPath?: string
  /**
   * The repository root that was checked. Always populated when returned
   * from `detectRuneContext`.
   */
  repoRoot?: string
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Asynchronously check if a file exists at the given path.
 *
 * @param filePath - Absolute or relative path to check.
 * @returns `true` if the file exists and is accessible, `false` otherwise.
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Attempt to run `runectx status` in the given working directory.
 *
 * This is a best-effort detection helper. If the `runectx` binary is not
 * installed, fails, or times out, the error is caught and `false` is
 * returned — missing `runectx` must never break non-RuneContext repos.
 *
 * @param cwd - Working directory to run the command in.
 * @returns `true` if the command succeeded (exit code 0), `false` otherwise.
 */
export function tryRunectxStatus(cwd: string): boolean {
  try {
    execSync("runectx status", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    })
    return true
  } catch {
    return false
  }
}

// ── Detection ────────────────────────────────────────────────────

/**
 * Detect whether the given repository root is managed by RuneContext.
 *
 * Detection is based on two markers:
 *   1. Presence of a `runecontext.yaml` file at the repo root.
 *   2. Successful `runectx status` invocation (exit code 0).
 *
 * The first positive marker wins. If neither marker is found, RuneContext
 * mode is disabled.
 *
 * @param repoRoot - Absolute path to the repository root directory.
 * @returns A `RuneContextDetection` result describing the detection
 *          decision and its reason.
 */
export async function detectRuneContext(repoRoot: string): Promise<RuneContextDetection> {
  // Check for runecontext.yaml marker
  const yamlPath = path.join(repoRoot, "runecontext.yaml")
  if (await fileExists(yamlPath)) {
    return {
      enabled: true,
      source: "runecontext.yaml found at repo root",
      detectionSource: "runecontext.yaml",
      runecontextYamlPath: yamlPath,
      repoRoot,
    }
  }

  // Try running runectx status
  const ok = tryRunectxStatus(repoRoot)
  if (ok) {
    return {
      enabled: true,
      source: "runectx status succeeded",
      detectionSource: "runectx status",
      repoRoot,
    }
  }

  return {
    enabled: false,
    source:
      "no RuneContext markers detected " +
      "(no runecontext.yaml and runectx status not available or failed)",
    repoRoot,
  }
}
