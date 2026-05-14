/**
 * prompt-fragments.ts — Prompt fragment loading and injection helpers.
 *
 * Loads mode fragments and runtime reminders from the pi-zflow-agents
 * package's prompt-fragments directory. These helpers are used by
 * extension activation code to inject the right fragments at the right
 * times — they are complementary to the `assemblePrompt()` function in
 * pi-zflow-agents, which is used for subagent launch planning.
 *
 * ## Key difference from `assemblePrompt()`
 *
 * - `assemblePrompt()` is for building a whole subagent prompt from
 *   agent role + mode + reminders + artifacts.
 * - These helpers are for injecting fragments into hook contexts
 *   (before_agent_start, before_tool_call) where only a specific
 *   mode fragment or reminder set is needed, not a full agent prompt.
 *
 * ## Usage in hooks
 *
 * ```ts
 * import { loadFragment, buildModeInjection } from "./prompt-fragments.js"
 *
 * pi.on("before_agent_start", async (event) => {
 *   const modeInjection = await buildModeInjection("plan-mode")
 *   return {
 *     systemPrompt: event.systemPrompt + `\n\n${modeInjection}`,
 *   }
 * })
 * ```
 *
 * @module pi-zflow-change-workflows/prompt-fragments
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

// ── Types ──────────────────────────────────────────────────────

/**
 * Supported reminder identifiers.
 */
export type ReminderId =
  | "tool-denied"
  | "plan-mode-active"
  | "approved-plan-loaded"
  | "drift-detected"
  | "compaction-handoff"
  | "external-file-change"
  | "verification-status"

/**
 * Supported mode fragment identifiers.
 */
export type ModeFragment =
  | "change-prepare"
  | "change-implement"
  | "plan-mode"
  | "review-pr"
  | "zflow-clean"
  | "root-orchestrator"

// ── Fragment directory resolution ──────────────────────────────

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * Resolve the prompt-fragments directory relative to this extension's
 * location in the monorepo.
 *
 * From: packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/
 * To:   packages/pi-zflow-agents/prompt-fragments/
 */
function resolveFragmentsDir(): string {
  return path.resolve(
    __dirname,
    "..", "..", "..",       // up to packages/
    "pi-zflow-agents",
    "prompt-fragments",
  )
}

/**
 * Resolve the path for a specific fragment file.
 *
 * Mode fragments are at `prompt-fragments/modes/{name}.md`
 * (except `root-orchestrator` which is at `prompt-fragments/{name}.md`).
 * Reminder fragments are at `prompt-fragments/reminders/{name}.md`.
 */
function resolveFragmentPath(name: ModeFragment | ReminderId): string {
  const base = resolveFragmentsDir()

  // Root orchestrator is at the top level of prompt-fragments/
  if (name === "root-orchestrator") {
    return path.join(base, `${name}.md`)
  }

  // Mode fragments are under modes/
  const modeNames: ModeFragment[] = [
    "change-prepare", "change-implement", "plan-mode",
    "review-pr", "zflow-clean",
  ]
  if ((modeNames as string[]).includes(name)) {
    return path.join(base, "modes", `${name}.md`)
  }

  // Reminder fragments are under reminders/
  return path.join(base, "reminders", `${name}.md`)
}

// ── Fragment loading ───────────────────────────────────────────

/**
 * Load a prompt fragment by name.
 *
 * Reads the content of the fragment file from the pi-zflow-agents
 * package's prompt-fragments directory. Throws if the file does not
 * exist, so callers should catch appropriately.
 *
 * @param name - The fragment identifier to load.
 * @returns The raw fragment content as a string.
 */
export async function loadFragment(name: ModeFragment | ReminderId): Promise<string> {
  const filePath = resolveFragmentPath(name)
  try {
    return await fs.readFile(filePath, "utf-8")
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException
    if (nodeErr.code === "ENOENT") {
      throw new Error(
        `Prompt fragment "${name}" not found at "${filePath}". ` +
        `Ensure pi-zflow-agents is installed and prompt-fragments are present.`,
      )
    }
    throw err
  }
}

/**
 * Build a runtime reminder injection string from a list of reminder IDs.
 *
 * Loads each reminder fragment and concatenates them with blank-line
 * separators. Silently skips reminders whose fragment files cannot be
 * loaded.
 *
 * @param reminders - Array of reminder IDs to inject.
 * @returns Joined reminder text (empty string if none were loaded).
 */
export async function buildReminderInjection(reminders: ReminderId[]): Promise<string> {
  const parts: string[] = []
  for (const r of reminders) {
    try {
      const content = await loadFragment(r)
      parts.push(content.trim())
    } catch {
      // Silently skip reminders whose files don't exist
    }
  }
  return parts.join("\n\n")
}

/**
 * Build a mode fragment injection string.
 *
 * Loads the specified mode fragment. Returns an empty string if the
 * fragment cannot be loaded (graceful fallback).
 *
 * @param mode - The mode fragment to load.
 * @returns The fragment content, or empty string on error.
 */
export async function buildModeInjection(mode: ModeFragment): Promise<string> {
  try {
    return await loadFragment(mode)
  } catch {
    return ""
  }
}

/**
 * Check whether a specific fragment file exists on disk.
 *
 * Useful for conditional injection without throwing.
 *
 * @param name - The fragment identifier to check.
 * @returns True if the fragment file exists.
 */
export async function fragmentExists(name: ModeFragment | ReminderId): Promise<boolean> {
  try {
    const filePath = resolveFragmentPath(name)
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}
