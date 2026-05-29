/**
 * handoff.ts — implementation-session handoff and session-fork helpers.
 */

// Phase 7 — Implementation session fork handoff
// ═══════════════════════════════════════════════════════════════════

/**
 * Handoff metadata for an implementation session.
 *
 * Stored in the plan-state.json or as a session metadata entry to
 * preserve the approved plan pointer across session boundaries.
 * This is intentionally separate from git branching — the handoff
 * is a Pi session fork, not a branch creation.
 */
export interface ImplementationHandoff {
  /** Change identifier from the plan */
  changeId: string
  /** Approved plan version label (e.g. "v2") */
  approvedVersion: string
  /** Absolute path to the runtime state directory */
  runtimeStateDir: string
  /** Session ID of the planning session that forked this handoff */
  sourceSessionId?: string
  /** ISO timestamp when the handoff was created */
  forkedAt: string
  /** Canonical plan artifact paths for context injection */
  planArtifactPaths: Record<string, string>
}

/**
 * Build the handoff metadata when transitioning from planning to implementation.
 *
 * Creates an `ImplementationHandoff` object with the approved plan pointer
 * and canonical artifact paths. The caller stores this in the forked
 * session's metadata or in plan-state.json.
 *
 * @param changeId - Change identifier from the plan.
 * @param approvedVersion - Approved plan version label (e.g. "v2").
 * @param runtimeStateDir - Absolute path to the runtime state directory.
 * @param planArtifactPaths - Record of artifact name → absolute file path.
 * @param sourceSessionId - Optional source planning session ID.
 * @returns An ImplementationHandoff object.
 */
export function buildImplementationHandoff(
  changeId: string,
  approvedVersion: string,
  runtimeStateDir: string,
  planArtifactPaths: Record<string, string>,
  sourceSessionId?: string,
): ImplementationHandoff {
  return {
    changeId,
    approvedVersion,
    runtimeStateDir,
    sourceSessionId,
    forkedAt: new Date().toISOString(),
    planArtifactPaths,
  }
}

/**
 * Serialize handoff metadata to a JSON string for session metadata storage.
 *
 * @param handoff - The handoff metadata to serialize.
 * @returns Pretty-printed JSON string.
 */
export function serializeHandoff(handoff: ImplementationHandoff): string {
  return JSON.stringify(handoff, null, 2)
}

/**
 * Deserialize handoff metadata from a JSON string.
 *
 * @param data - JSON string produced by serializeHandoff.
 * @returns The parsed ImplementationHandoff object.
 * @throws If the input is not valid JSON or does not match the expected shape.
 */
export function deserializeHandoff(data: string): ImplementationHandoff {
  const parsed = JSON.parse(data) as Partial<ImplementationHandoff>

  // Validate required fields
  if (!parsed.changeId || typeof parsed.changeId !== "string") {
    throw new Error("Invalid handoff: missing or invalid 'changeId'")
  }
  if (!parsed.approvedVersion || typeof parsed.approvedVersion !== "string") {
    throw new Error("Invalid handoff: missing or invalid 'approvedVersion'")
  }
  if (!parsed.runtimeStateDir || typeof parsed.runtimeStateDir !== "string") {
    throw new Error("Invalid handoff: missing or invalid 'runtimeStateDir'")
  }
  if (!parsed.planArtifactPaths || typeof parsed.planArtifactPaths !== "object") {
    throw new Error("Invalid handoff: missing or invalid 'planArtifactPaths'")
  }

  return {
    changeId: parsed.changeId,
    approvedVersion: parsed.approvedVersion,
    runtimeStateDir: parsed.runtimeStateDir,
    sourceSessionId: parsed.sourceSessionId,
    forkedAt: parsed.forkedAt ?? new Date().toISOString(),
    planArtifactPaths: parsed.planArtifactPaths,
  }
}

/**
 * Build the prompt prefix for an implementation session that received a handoff.
 *
 * This injects the approved plan context into the new session so the model
 * knows exactly what plan to execute without needing the planning session's
 * full transcript.
 *
 * The prompt explicitly distinguishes session forking from git branching.
 *
 * @param handoff - The handoff metadata from the planning session.
 * @returns A markdown string to prepend to the implementation session prompt.
 */
export function buildHandoffPromptPrefix(handoff: ImplementationHandoff): string {
  const lines: string[] = [
    "# Implementation Session",
    "",
    `This session was forked from a planning session for change **${handoff.changeId}**.`,
    "",
    "## Approved Plan Context",
    `- Change ID: ${handoff.changeId}`,
    `- Approved Version: ${handoff.approvedVersion}`,
    `- Runtime State Dir: ${handoff.runtimeStateDir}`,
    `- Forked At: ${handoff.forkedAt}`,
    "",
    "## Plan Artifacts",
  ]

  for (const [key, filePath] of Object.entries(handoff.planArtifactPaths)) {
    lines.push(`- ${key}: \`${filePath}\``)
  }

  lines.push(
    "",
    "## Handoff Rules",
    `- This is a **session fork**, not a git branch creation.`,
    `- No git branches have been created by this handoff.`,
    `- The planning session remains available via session tree/resume.`,
    "",
    `Use \`/zflow-change-implement ${handoff.changeId}\` to begin implementation.`,
  )

  return lines.join("\n")
}

/**
 * Check whether session fork capability is available.
 *
 * Returns true if `pi.forkSession` or equivalent session fork API
 * is available. This is a best-effort check; the caller should
 * handle the case where forking is not available gracefully.
 */
export function canForkSession(): boolean {
  // Session forking depends on Pi runtime version and available APIs.
  // At minimum, check that we're in a Pi session environment.
  try {
    return typeof process !== "undefined" &&
      typeof process.env !== "undefined" &&
      "PI_SESSION_ID" in process.env
  } catch {
    return false
  }
}

// ── Fork implementation session helper ────────────────────────────

/**
 * Result of attempting to fork an implementation session.
 */
export interface ForkSessionResult {
  /** Whether the session was successfully forked via ctx API. */
  forked: boolean
  /** Path to the new session file, if forked via ctx API. */
  sessionFile?: string
  /** Path to the handoff artifact file, if fallback was used. */
  handoffArtifactPath?: string
  /** The serialized handoff metadata (for reference). */
  handoffJson: string
  /** The handoff prompt prefix (for injecting into the new session). */
  handoffPromptPrefix: string
  /** Human-readable instructions for next steps. */
  message: string
}

/**
 * Attempt to fork a new implementation session with handoff metadata.
 *
 * Tries, in order:
 * 1. `ctx.newSession()` — creates a fresh session with handoff prompt as the first user message
 * 2. `ctx.fork()` — forks from the current leaf entry with handoff metadata
 * 3. Falls back to writing a `.handoff.json` artifact file under `<runtime-state-dir>/runs/`
 *
 * Uses defensive dynamic checks so it works even with partial `ctx` stubs.
 * Does NOT create git branches.
 *
 * @param ctx - A command-handler context-like object (may have `newSession`, `fork`, `ui`).
 * @param handoff - The implementation handoff metadata.
 * @returns A ForkSessionResult describing what happened.
 */
export async function forkImplementationSessionIfAvailable(
  ctx: Record<string, unknown>,
  handoff: ImplementationHandoff,
): Promise<ForkSessionResult> {
  const handoffJson = serializeHandoff(handoff)
  const handoffPromptPrefix = buildHandoffPromptPrefix(handoff)

  // ── Attempt 1: ctx.newSession() ──────────────────────────────
  const newSession = (ctx as Record<string, unknown>).newSession
  if (typeof newSession === "function") {
    try {
      const parentSession =
        typeof (ctx as Record<string, unknown>).sessionManager !== "undefined" &&
        typeof (ctx as Record<string, unknown>).sessionManager !== "string" &&
        typeof (ctx as Record<string, unknown>).sessionManager === "object" &&
        (ctx as Record<string, unknown>).sessionManager !== null
          ? ((ctx as Record<string, unknown>).sessionManager as Record<string, unknown>).getSessionFile
            ? typeof (ctx as Record<string, unknown>).sessionManager === "object" &&
              (ctx as Record<string, unknown>).sessionManager !== null &&
              typeof ((ctx as Record<string, unknown>).sessionManager as Record<string, unknown>).getSessionFile === "function"
              ? await ((ctx as Record<string, unknown>).sessionManager as { getSessionFile: () => string | Promise<string> }).getSessionFile()
              : undefined
            : undefined
          : undefined

      // Call ctx.newSession with handoff prompt sent as a user message
      // so the forked session knows it's an implementation session.
      const result = await (newSession as (opts?: Record<string, unknown>) => Promise<{ cancelled: boolean; sessionFile?: string }>)({
        parentSession,
        withSession: async (forkedCtx: Record<string, unknown>) => {
          const sendMsg = (forkedCtx as Record<string, unknown>).sendUserMessage
          if (typeof sendMsg === "function") {
            await (sendMsg as (msg: string) => Promise<void>)(handoffPromptPrefix)
          }
        },
      })

      if (!result.cancelled && result.sessionFile) {
        return {
          forked: true,
          sessionFile: result.sessionFile,
          handoffJson,
          handoffPromptPrefix,
          message: `✅ Implementation session forked.\n  Session file: ${result.sessionFile}\n  Change: ${handoff.changeId} v${handoff.approvedVersion}\n  Use \`/zflow-change-implement ${handoff.changeId}\` to begin.`,
        }
      }
    } catch {
      // newSession failed — fall through
    }
  }

  // ── Attempt 2: ctx.fork() ────────────────────────────────────
  // Requires an entryId — not always available in command context.
  // If this fails, proceed to fallback.
  const forkFn = (ctx as Record<string, unknown>).fork
  if (typeof forkFn === "function") {
    try {
      // Try to get the current entryId from ctx
      const currentEntryId =
        typeof (ctx as Record<string, unknown>).entryId === "string"
          ? (ctx as Record<string, unknown>).entryId as string
          : undefined

      if (currentEntryId) {
        const forkResult = await (forkFn as (entryId: string, opts?: Record<string, unknown>) => Promise<{ cancelled: boolean }>)(
          currentEntryId,
          {
            position: "at",
            withSession: async (forkedCtx: Record<string, unknown>) => {
              const sendMsg = (forkedCtx as Record<string, unknown>).sendUserMessage
              if (typeof sendMsg === "function") {
                await (sendMsg as (msg: string) => Promise<void>)(handoffPromptPrefix)
              }
            },
          },
        )

        if (!forkResult.cancelled) {
          return {
            forked: true,
            sessionFile: "forked-session",
            handoffJson,
            handoffPromptPrefix,
            message: `✅ Implementation session forked from current leaf.\n  Change: ${handoff.changeId} v${handoff.approvedVersion}\n  Use \`/zflow-change-implement ${handoff.changeId}\` to begin implementation.`,
          }
        }
      }
    } catch {
      // ctx.fork failed — fall through
    }
  }

  // ── Fallback: Write handoff artifact file ────────────────────
  // Write to <runtime-state-dir>/runs/<changeId>-handoff.json
  try {
    const { default: fs } = await import("node:fs/promises")
    const { default: path } = await import("node:path")
    const { resolveRuntimeStateDir } = await import("pi-zflow-core/runtime-paths")

    const runtimeStateDir = resolveRuntimeStateDir()
    const runsDir = path.join(runtimeStateDir, "runs")
    const handoffFilename = `${handoff.changeId}-handoff.json`
    const handoffArtifactPath = path.join(runsDir, handoffFilename)

    await fs.mkdir(runsDir, { recursive: true })
    await fs.writeFile(handoffArtifactPath, handoffJson, "utf-8")

    return {
      forked: false,
      handoffArtifactPath,
      handoffJson,
      handoffPromptPrefix,
      message:
        `📋 Handoff artifact written to: ${handoffArtifactPath}\n` +
        `  Change: ${handoff.changeId} v${handoff.approvedVersion}\n` +
        `  No session fork API was available.\n` +
        `  Use \`/zflow-change-implement ${handoff.changeId}\` to load the handoff and begin implementation.\n` +
        `  No git branches were created.`,
    }
  } catch (err) {
    // Last-resort: return handoff data inline
    return {
      forked: false,
      handoffJson,
      handoffPromptPrefix,
      message:
        `⚠️ Could not write handoff artifact.\n` +
        `  Change: ${handoff.changeId} v${handoff.approvedVersion}\n` +
        `  Error: ${err instanceof Error ? err.message : String(err)}\n` +
        `  Handoff data:\n${handoffJson}\n\n` +
        `  Pass this data to \`/zflow-change-implement ${handoff.changeId}\` manually.`,
    }
  }
}

/**
 * Resolve a pending handoff artifact for a given changeId.
 *
 * Reads `<runtime-state-dir>/runs/<changeId>-handoff.json` if it exists.
 * Returns null if no handoff artifact is found.
 *
 * @param changeId - The change identifier to look up.
 * @param cwd - Working directory (optional).
 */
export async function resolvePendingHandoff(
  changeId: string,
  cwd?: string,
): Promise<ImplementationHandoff | null> {
  try {
    const { default: fs } = await import("node:fs/promises")
    const { default: path } = await import("node:path")
    const { resolveRuntimeStateDir } = await import("pi-zflow-core/runtime-paths")

    const runtimeStateDir = resolveRuntimeStateDir(cwd)
    const handoffPath = path.join(runtimeStateDir, "runs", `${changeId}-handoff.json`)
    const raw = await fs.readFile(handoffPath, "utf-8")
    return deserializeHandoff(raw)
  } catch {
    return null
  }
}

/**
 * Remove a pending handoff artifact for a given changeId.
 *
 * @param changeId - The change identifier.
 * @param cwd - Working directory (optional).
 */
export async function clearPendingHandoff(
  changeId: string,
  cwd?: string,
): Promise<void> {
  try {
    const { default: fs } = await import("node:fs/promises")
    const { default: path } = await import("node:path")
    const { resolveRuntimeStateDir } = await import("pi-zflow-core/runtime-paths")

    const runtimeStateDir = resolveRuntimeStateDir(cwd)
    const handoffPath = path.join(runtimeStateDir, "runs", `${changeId}-handoff.json`)
    await fs.rm(handoffPath, { force: true })
  } catch {
    // Non-critical; ignore
  }
}

// ═══════════════════════════════════════════════════════════════════
