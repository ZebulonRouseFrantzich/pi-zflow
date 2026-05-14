/**
 * pi-zflow-change-workflows extension entrypoint
 *
 * Phase 7 implementation:
 * - Path resolution helpers integrated from pi-zflow-artifacts
 * - `resolveAllPaths` convenience helper for workflow commands
 * - Registers `/zflow-change-prepare`, `/zflow-change-implement`,
 *   `/zflow-change-audit`, `/zflow-change-fix`, and `/zflow-clean`
 * - Wires state-driven resume, HITL gates, handoff, prompt reminders,
 *   verification/review sequencing, cleanup, and path-guard enforcement
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

import {
  resolveRuntimeStateDir,
  resolveGitDir,
} from "pi-zflow-core/runtime-paths"

import { getZflowRegistry } from "pi-zflow-core/registry"
import { PI_ZFLOW_CHANGE_WORKFLOWS_VERSION } from "pi-zflow-core"
import type { CapabilityClaim } from "pi-zflow-core/registry"

import {
  resolveStateIndexPath,
  resolvePlanStatePath,
  resolvePlanVersionDir,
  resolveChangeDir,
  resolveRunStatePath,
  resolveReviewDir,
  resolveCodeReviewFindingsPath,
  resolveFailureLogPath,
  resolveRepoMapPath,
  resolveReconnaissancePath,
} from "pi-zflow-artifacts/artifact-paths"

// ── Path resolution helpers ──────────────────────────────────────

/**
 * All workflow-relevant runtime paths resolved once.
 *
 * This is the single authoritative source of runtime path locations
 * for all workflow commands. Every command should call this to get
 * consistent paths throughout the session.
 */
export interface AllWorkflowPaths {
  /** Root of all runtime state artifacts (`<git-dir>/pi-zflow/`). */
  runtimeStateDir: string
  /** Path to the state index JSON file. */
  stateIndexPath: string
  /** Path to the failure log markdown file. */
  failureLogPath: string
  /** Path to the review artifacts directory. */
  reviewDir: string
  /** Path to the code-review-findings.md file. */
  codeReviewFindingsPath: string
  /** Path to the repo-map.md file. */
  repoMapPath: string
  /** Path to the reconnaissance.md file. */
  reconnaissancePath: string
}

/**
 * Resolve all workflow-relevant runtime paths.
 *
 * Centralises path resolution so that every workflow command resolves
 * paths the same way. Accepts an optional working directory for context.
 *
 * @param cwd - Working directory (defaults to `process.cwd()`)
 */
export function resolveAllPaths(cwd?: string): AllWorkflowPaths {
  return {
    runtimeStateDir: resolveRuntimeStateDir(cwd),
    stateIndexPath: resolveStateIndexPath(cwd),
    failureLogPath: resolveFailureLogPath(cwd),
    reviewDir: resolveReviewDir(cwd),
    codeReviewFindingsPath: resolveCodeReviewFindingsPath(cwd),
    repoMapPath: resolveRepoMapPath(cwd),
    reconnaissancePath: resolveReconnaissancePath(cwd),
  }
}

/**
 * Resolve plan-related paths for a specific change and version.
 *
 * @param changeId - Unique change identifier (kebab-case)
 * @param planVersion - Plan version (e.g. "v1")
 * @param cwd - Working directory (defaults to `process.cwd()`)
 */
export function resolvePlanPaths(
  changeId: string,
  planVersion: string,
  cwd?: string,
): {
  changeDir: string
  planVersionDir: string
  planStatePath: string
} {
  return {
    changeDir: resolveChangeDir(changeId, cwd),
    planVersionDir: resolvePlanVersionDir(changeId, planVersion, cwd),
    planStatePath: resolvePlanStatePath(changeId, cwd),
  }
}

/**
 * Resolve run-related paths for a specific run.
 *
 * @param runId - Unique run identifier
 * @param cwd - Working directory (defaults to `process.cwd()`)
 */
export function resolveRunPaths(
  runId: string,
  cwd?: string,
): {
  runStatePath: string
} {
  return {
    runStatePath: resolveRunStatePath(runId, cwd),
  }
}

// ── State-index lifecycle helpers ─────────────────────────────────

import { loadStateIndex, listStateIndexEntries } from "pi-zflow-artifacts/state-index"
import type { StateIndexEntry } from "pi-zflow-artifacts/state-index"

import {
  discoverUnfinishedWork,
  promptResumeChoices,
  checkUnfinishedOnEntry,
  runChangePrepareWorkflow,
  resolveProfileIfAvailable,
  buildRepoMap,
  buildReconnaissance,
  advancePlanLifecycle,
  runPlanValidation,
  runPlanReview,
  approvePlanVersion,
  buildHandoffContext,
  updatePlanState,
  bumpPlanVersion,
  markPlanVersionState,
  buildPlanApprovalQuestions,
  buildImplementationGateQuestions,
  parseInterviewResponse,
  runChangeAuditWorkflow,
  runChangeFixWorkflow,
  runCleanWorkflow,
  detectResumeContext,
  resumeWorkflow,
  abandonWorkflow,
  buildResumePrompt,
  runChangeImplementWorkflow,
  recordImplementationNextSteps,
  finalizeVerification,
  runBoundedFixLoop,
  finalizeCodeReview,
  completeWorkflow,
  runImplementationPostStartSequence,
  buildImplementationHandoff,
  serializeHandoff,
  deserializeHandoff,
  buildHandoffPromptPrefix,
  canForkSession,
  forkImplementationSessionIfAvailable,
  resolvePendingHandoff,
  clearPendingHandoff,
  handlePlanDrift,
  createPlanAmendment,
  buildDriftDetectedReminder,
  buildCodeReviewInputFromContext,
} from "./orchestration.js"

import {
  loadFragment,
  buildReminderInjection,
  buildModeInjection,
  fragmentExists,
} from "./prompt-fragments.js"

import type {
  ReminderId,
  ModeFragment,
} from "./prompt-fragments.js"

import type {
  PrepareWorkflowOptions,
  PrepareWorkflowResult,
  ImplementationHandoff,
  ForkSessionResult,
  ImplementWorkflowOptions,
  ImplementWorkflowResult,
  UnfinishedOnEntryResult,
  CodeReviewInputContext,
  AuditWorkflowOptions,
  AuditWorkflowResult,
  FixWorkflowOptions,
  FixWorkflowResult,
  CleanWorkflowOptions,
  CleanWorkflowResult,
  ResumeContext,
  DriftResolution,
} from "./orchestration.js"

import {
  resolveVerificationCommand,
  runVerification,
  appendFailureLog,
  runVerificationFixLoop,
} from "./verification.js"

import {
  readFailureLog,
  findRelevantFailures,
  appendFailureEntry,
  formatFailureLogEntries,
  parseFailureLog,
} from "./failure-log.js"

import type { FailureLogEntry } from "./failure-log.js"

// ── Path guard helpers ────────────────────────────────────────────

import {
  guardWrite,
  guardBashCommand,
  isGitWriteCommand,
  buildToolDeniedReminder,
} from "./path-guard.js"

import type {
  GuardResult,
  GuardIntent,
  GuardOptions,
  PostStartSequenceOptions,
  PostStartSequenceResult,
} from "./path-guard.js"

import type {
  VerificationResult,
  FixLoopOptions,
  FixLoopResult,
  FixAttempt,
} from "./verification.js"

export {
  discoverUnfinishedWork,
  promptResumeChoices,
  checkUnfinishedOnEntry,
  runChangePrepareWorkflow,
  resolveProfileIfAvailable,
  buildRepoMap,
  buildReconnaissance,
  advancePlanLifecycle,
  runPlanValidation,
  runPlanReview,
  approvePlanVersion,
  buildHandoffContext,
  updatePlanState,
  bumpPlanVersion,
  markPlanVersionState,
  runChangeImplementWorkflow,
  recordImplementationNextSteps,
  finalizeVerification,
  runBoundedFixLoop,
  finalizeCodeReview,
  completeWorkflow,
  runImplementationPostStartSequence,
  loadFragment,
  buildReminderInjection,
  buildModeInjection,
  fragmentExists,
  buildImplementationHandoff,
  serializeHandoff,
  deserializeHandoff,
  buildHandoffPromptPrefix,
  canForkSession,
  resolveVerificationCommand,
  runVerification,
  appendFailureLog,
  runVerificationFixLoop,
  detectResumeContext,
  resumeWorkflow,
  abandonWorkflow,
  buildResumePrompt,
  handlePlanDrift,
  createPlanAmendment,
  buildDriftDetectedReminder,
  buildCodeReviewInputFromContext,
  runChangeAuditWorkflow,
  runChangeFixWorkflow,
  runCleanWorkflow,
  readFailureLog,
  findRelevantFailures,
  appendFailureEntry,
  formatFailureLogEntries,
  parseFailureLog,
  buildPlanApprovalQuestions,
  buildImplementationGateQuestions,
  parseInterviewResponse,
  runStructuredInterview,
}

export type {
  StateIndexEntry,
  ReminderId,
  ModeFragment,
  PrepareWorkflowOptions,
  PrepareWorkflowResult,
  ImplementationHandoff,
  ForkSessionResult,
  ImplementWorkflowOptions,
  ImplementWorkflowResult,
  VerificationResult,
  FixLoopOptions,
  FixLoopResult,
  FixAttempt,
  DriftResolution,
  CodeReviewInputContext,
  AuditWorkflowOptions,
  AuditWorkflowResult,
  FixWorkflowOptions,
  FixWorkflowResult,
  CleanWorkflowOptions,
  CleanWorkflowResult,
  FailureLogEntry,
  ResumeContext,
  GuardResult,
  GuardIntent,
  GuardOptions,
}

// ── Structured interview helper ─────────────────────────────────

/**
 * Minimal type for a context with interview/UI capability.
 *
 * Permissive to avoid depending on concrete Pi internals — any object
 * matching one of the recognised shapes will work.
 */
export interface InterviewableContext {
  /** Direct interview function (future Pi API). */
  interview?: (payload: string) => Promise<string | undefined> | string | undefined
  /** Nested UI context. */
  ui?: {
    interview?: (payload: string) => Promise<string | undefined> | string | undefined
    /** Single-select from options. */
    select?: (title: string, options: string[], extra?: Record<string, unknown>) => Promise<string | undefined>
    /** Confirm dialog (boolean). */
    confirm?: (title: string, message: string, extra?: Record<string, unknown>) => Promise<boolean>
    /** Plain text input. */
    input?: (title: string, placeholder?: string, extra?: Record<string, unknown>) => Promise<string | undefined>
    /** Non-blocking notification. */
    notify: (message: string, type?: "info" | "warning" | "error") => void
  }
  /**
   * The Pi runtime model registry, available when the handler runs inside
   * a Pi extension command context. Provides model discovery and auth checks.
   *
   * When present, profile resolution can check lane models against
   * real model availability. When absent, lane-health checks are skipped
   * and all resolved lanes are assumed healthy.
   */
  modelRegistry?: {
    getAll(): Array<{
      provider: string
      id: string
      api?: string
      baseUrl?: string
      reasoning?: boolean
      input?: string[]
      contextWindow?: number
      maxTokens?: number
      [key: string]: unknown
    }>
    hasConfiguredAuth(model: {
      provider: string
      id: string
      [key: string]: unknown
    }): boolean
  }
}

/**
 * Parse a simplified questions payload to extract the first single-choice
 * question and its options for a fallback `ui.select` or `ui.confirm` call.
 */
function extractFirstChoice(questionsJson: string): {
  title: string
  question: string
  options: string[]
} | null {
  try {
    const parsed = JSON.parse(questionsJson)
    const title = parsed.title ?? "Decision Required"
    const q = parsed.questions?.[0]
    if (!q) return null
    if (q.type === "single" && Array.isArray(q.options)) {
      return {
        title,
        question: q.question,
        options: q.options.map((o: { label: string }) => o.label),
      }
    }
    return { title, question: q.question ?? "Proceed?", options: ["Yes", "No"] }
  } catch {
    return null
  }
}

/** Map a fallback select choice to a decision string. */
function selectToDecision(
  selected: string | undefined,
  questionsJson: string,
): { decision: string; revisionNotes?: string } | null {
  if (!selected) {
    return { decision: "cancel" }
  }
  // Match the selected label against the options in the JSON payload
  try {
    const parsed = JSON.parse(questionsJson)
    const q = parsed.questions?.[0]
    if (q?.type === "single" && Array.isArray(q.options)) {
      const matched = q.options.find(
        (o: { label: string }) => o.label === selected,
      )
      if (matched?.label?.startsWith?.("Approve") || matched?.label === "Yes") {
        return { decision: "approve" }
      }
      if (matched?.label?.startsWith?.("Request Revisions")) {
        return { decision: "revise", revisionNotes: "Revision requested via gate" }
      }
      if (matched?.label?.startsWith?.("Cancel") || matched?.label === "No") {
        return { decision: "cancel" }
      }
      // Other labels map to a "continue" decision
      return { decision: "continue" }
    }
  } catch {
    // fall through
  }
  return { decision: "continue" }
}

/**
 * Run a structured interview with the user, adapting to whatever UI
 * capabilities the context provides.
 *
 * Priority order:
 * 1. `ctx.interview(payload)` — future Pi native interview API
 * 2. `ctx.ui.interview(payload)` — future Pi UI interview API
 * 3. `ctx.ui.select()` / `ctx.ui.confirm()` — fallback for single-choice questions
 * 4. `ctx.ui.notify()` — last-resort notification
 *
 * @param ctx - The extension command context (or any InterviewableContext).
 * @param questionsJson - JSON string produced by buildPlanApprovalQuestions()
 *                        or buildImplementationGateQuestions().
 * @param fallbackMessage - Concise message to show when no interactive UI is
 *                          available.
 * @returns Parsed decision + optional revision notes, or null if the
 *          context had no usable UI at all.
 */
async function runStructuredInterview(
  ctx: InterviewableContext,
  questionsJson: string,
  fallbackMessage: string,
): Promise<{ decision: string; revisionNotes?: string } | null> {
  // 1. Try ctx.interview (native Pi interview API)
  if (typeof ctx.interview === "function") {
    const raw = await Promise.resolve(ctx.interview(questionsJson))
    if (raw !== undefined) {
      return parseInterviewResponse(raw)
    }
  }

  // 2. Try ctx.ui.interview
  if (typeof ctx.ui?.interview === "function") {
    const raw = await Promise.resolve(ctx.ui.interview(questionsJson))
    if (raw !== undefined) {
      return parseInterviewResponse(raw)
    }
  }

  // 3. Fall back to ctx.ui.select / ctx.ui.confirm
  const choice = extractFirstChoice(questionsJson)
  if (choice && typeof ctx.ui?.select === "function") {
    const selected = await ctx.ui.select(
      `${choice.title}: ${choice.question}`,
      choice.options,
    )
    const result = selectToDecision(selected, questionsJson)
    if (result) return result
  }

  // 4. Fall back to ctx.ui.confirm (binary yes/no)
  if (typeof ctx.ui?.confirm === "function") {
    const ok = await ctx.ui.confirm(
      "Approve?",
      fallbackMessage,
    )
    return { decision: ok ? "approve" : "cancel" }
  }

  // 5. No interactive UI — notify and return a safe default
  if (typeof ctx.ui?.notify === "function") {
    ctx.ui.notify(fallbackMessage, "info")
  }
  return { decision: "inspect" }
}

// ═══════════════════════════════════════════════════════════════════
// Workflow mode/reminder state management
// ═══════════════════════════════════════════════════════════════════
//
// In-memory state for the current active workflow mode and active
// runtime reminders. The before_agent_start hook reads this state to
// inject prompt fragments and reminders into the system prompt.
//
// State is set by command handlers and cleared when the mode/state
// ends. Exported for testability.

let _activeWorkflowMode: ModeFragment | null = null
let _activeReminders: Set<ReminderId> = new Set()

/**
 * Set the current active workflow mode.
 * The before_agent_start hook will inject the corresponding mode fragment.
 */
export function setActiveWorkflowMode(mode: ModeFragment | null): void {
  _activeWorkflowMode = mode
}

/**
 * Get the current active workflow mode.
 */
export function getActiveWorkflowMode(): ModeFragment | null {
  return _activeWorkflowMode
}

/**
 * Activate a runtime reminder. Duplicates are ignored.
 */
export function addReminder(reminder: ReminderId): void {
  _activeReminders.add(reminder)
}

/**
 * Deactivate a runtime reminder.
 */
export function removeReminder(reminder: ReminderId): void {
  _activeReminders.delete(reminder)
}

/**
 * Get all currently active reminders.
 */
export function getActiveReminders(): ReminderId[] {
  return [..._activeReminders]
}

/**
 * Clear all active reminders.
 */
export function clearReminders(): void {
  _activeReminders.clear()
}

/**
 * Reset both mode and reminders (clean slate).
 */
export function resetWorkflowState(): void {
  _activeWorkflowMode = null
  _activeReminders.clear()
}

// ═══════════════════════════════════════════════════════════════════
// Profile preflight helper
// ═══════════════════════════════════════════════════════════════════

/**
 * Attempt to resolve the active profile via the registry's profile
 * service.  This is the first step in both prepare and implement
 * workflows (Phase 7, Profile.ensureResolved()).
 *
 * @returns true if profile was resolved, false if no service is
 *          available (workflow may proceed advisory-only).
 * @throws never — errors are reported via ui and return false.
 */
async function ensureProfileResolved(ctx: InterviewableContext): Promise<boolean> {
  const notify = ctx.ui?.notify ?? (() => {})
  const reg = getZflowRegistry()
  if (reg.has("profiles")) {
    const profileService = reg.optional<{ ensureResolved?: (...args: unknown[]) => Promise<unknown> }>("profiles")
    if (profileService && typeof profileService.ensureResolved === "function") {
      try {
        // Convert the Pi model registry if available, so lane-health preflight
        // can check real model availability and authentication.
        let options: Record<string, unknown> = {}
        if (ctx.modelRegistry) {
          const { createPiModelRegistryAdapter } = await import("pi-zflow-profiles")
          options.registry = createPiModelRegistryAdapter(ctx.modelRegistry)
        }
        await profileService.ensureResolved(undefined, options)
        notify("✅ Profile resolved.", "info")
        return true
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        notify(
          `⚠️ Profile service available but ensureResolved() failed: ${message}. ` +
          "Proceeding without explicit profile — verification command detection may be used.",
          "warning",
        )
        // Advisory-only; workflow may still proceed.
        return false
      }
    }
  }
  notify(
    "ℹ️ No profile service found in registry. Proceeding without explicit profile. " +
    (ctx.modelRegistry
      ? "Run /zflow-profile default to resolve a profile with lane-health checks."
      : "Run a profile setup command first or configure via pi-zflow-profiles. ") +
    "Verification will fall back to auto-detection.",
    "info",
  )
  return false
}

// ── Extension activation ────────────────────────────────────────

const CHANGE_WORKFLOWS_CAPABILITY = "change-workflows" as const

export default function activateZflowChangeWorkflowsExtension(pi: ExtensionAPI): void {
  const registry = getZflowRegistry()

  // ── Capability claim (guards against duplicate loads) ──────────
  const claim: CapabilityClaim = {
    capability: CHANGE_WORKFLOWS_CAPABILITY,
    version: PI_ZFLOW_CHANGE_WORKFLOWS_VERSION,
    provider: "pi-zflow-change-workflows",
    sourcePath: import.meta.url,
    compatibilityMode: "compatible",
  }

  const registered = registry.claim(claim)

  // If claim returns null, an incompatible provider already owns this
  // capability — do not register anything.
  if (!registered) {
    return
  }

  // If the capability already has a service, another compatible
  // instance already initialised fully. No-op to avoid duplicate
  // command registration.
  if (registered.service !== undefined) {
    return
  }

  // Provide a minimal service marker so duplicate loads see service !== undefined
  registry.provide(CHANGE_WORKFLOWS_CAPABILITY, { activated: true })

  // ── Agent setup check ─────────────────────────────────────────
  // Check if the zflow-agents capability is available via registry.
  // If not, emit a one-time warning that setup hasn't been run yet.
  let agentsSetupChecked = false
  try {
    if (registry.has("agents")) {
      agentsSetupChecked = true
    }
  } catch {
    // Registry not available — skip check
  }

  // ── Tool call interception: path guard ───────────────────────
  // Intercept write/edit tool calls to enforce path guard policy.
  // Intercept bash commands to block destructive operations when
  // inappropriate (e.g. planning mode).
  const homeDir = typeof process !== "undefined"
    ? (process.env.HOME || process.env.USERPROFILE || "/home/user")
    : "/home/user"

  pi.on("tool_call", async (event, ctx) => {
    const { isToolCallEventType } = await import("@earendil-works/pi-coding-agent")

    // ── Guard "write" and "edit" tool calls ───────────────────
    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      // Determine the target path from the tool input
      let targetPath = ""
      if (isToolCallEventType("write", event)) {
        targetPath = event.input.path ?? ""
      } else if (isToolCallEventType("edit", event)) {
        targetPath = event.input.path ?? ""
      }

      if (!targetPath) return // no path to check

      // Resolve project root
      let projectRoot = process.cwd()
      try {
        const { execSync } = await import("node:child_process")
        projectRoot = execSync("git rev-parse --show-toplevel", {
          cwd: process.cwd(),
          encoding: "utf-8",
          timeout: 5_000,
        }).trim()
      } catch {
        // Not in a git repo — use cwd as project root
      }

      const options: GuardOptions = {
        projectRoot,
        runtimeStateDir: resolveRuntimeStateDir(process.cwd()),
      }

      const result = guardWrite(targetPath, options)

      if (!result.allowed) {
        const reminder = buildToolDeniedReminder(result)
        return { block: true, reason: reminder }
      }
    }

    // ── Guard "bash" tool calls ───────────────────────────────
    if (isToolCallEventType("bash", event)) {
      const command = event.input.command ?? ""

      // Resolve project root
      let projectRoot = process.cwd()
      try {
        const { execSync } = await import("node:child_process")
        projectRoot = execSync("git rev-parse --show-toplevel", {
          cwd: process.cwd(),
          encoding: "utf-8",
          timeout: 5_000,
        }).trim()
      } catch {
        // Not in a git repo — use cwd as project root
      }

      const options: GuardOptions = {
        projectRoot,
        runtimeStateDir: resolveRuntimeStateDir(process.cwd()),
      }

      const result = guardBashCommand(command, options)

      if (!result.allowed) {
        const reminder = buildToolDeniedReminder(result)
        return { block: true, reason: reminder }
      }
    }
  })

  // ── before_agent_start hook: inject mode fragments and reminders ──

  pi.on("before_agent_start", async (event) => {
    const mode = getActiveWorkflowMode()
    const reminders = getActiveReminders()
    if (!mode && reminders.length === 0) {
      return // nothing to inject
    }

    let injections: string[] = []

    // Inject the current mode fragment (e.g. change-prepare, change-implement)
    if (mode) {
      const modeText = await buildModeInjection(mode)
      if (modeText) {
        injections.push(modeText)
      }
    }

    // Inject active runtime reminders
    if (reminders.length > 0) {
      const reminderText = await buildReminderInjection(reminders)
      if (reminderText) {
        injections.push(reminderText)
      }
    }

    if (injections.length === 0) {
      return
    }

    // Append injections to the system prompt
    return {
      systemPrompt: event.systemPrompt + "\n\n" + injections.join("\n\n"),
    }
  })

  // ── Command: /zflow-clean ─────────────────────────────────────

  pi.registerCommand("zflow-clean", {
    description: "Clean stale runtime artifacts, orphaned worktrees, and expired metadata",
    handler: async (args: string, ctx: InterviewableContext): Promise<void> => {
      // Parse arguments
      const parts = args.trim().split(/\s+/)
      const options: CleanWorkflowOptions = {}
      for (let i = 0; i < parts.length; i++) {
        switch (parts[i]) {
          case "--dry-run":
            options.dryRun = true
            break
          case "--orphans":
            options.orphans = true
            break
          case "--older-than":
            i++
            if (i < parts.length) {
              options.olderThan = parseInt(parts[i], 10)
              if (isNaN(options.olderThan)) {
                ctx.ui.notify(`Invalid --older-than value: ${parts[i]}`, "error")
                return
              }
            }
            break
          default:
            ctx.ui.notify(`Unknown option: ${parts[i]}`, "warning")
            break
        }
      }

      ctx.ui.notify(
        options.dryRun
          ? "🧹 Dry-run cleanup — previewing stale artifacts..."
          : "🧹 Running cleanup...",
      )

      try {
        const result = await runCleanWorkflow(options)

        ctx.ui.notify(result.summary, "info")

        if (options.dryRun) {
          ctx.ui.notify(
            `Preview: ${result.cleaned} artifact(s) would be cleaned, ${result.kept} kept.`,
            "info",
          )
          ctx.ui.notify("Run without --dry-run to actually clean.", "info")
        } else {
          if (result.errors.length > 0) {
            ctx.ui.notify(
              `Cleaned ${result.cleaned} artifact(s). ${result.errors.length} error(s) occurred.`,
              result.errors.length > 0 ? "warning" : "info",
            )
          } else {
            ctx.ui.notify(`Cleaned ${result.cleaned} artifact(s).`, "info")
          }
        }
      } catch (err: unknown) {
        ctx.ui.notify(
          `Cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        )
      }
    },
  })

  // ── Command: /zflow-change-prepare ────────────────────────────

  pi.registerCommand("zflow-change-prepare", {
    description: "Run the formal change preparation workflow for a given change path or RuneContext",
    handler: async (args: string, ctx: InterviewableContext): Promise<void> => {
      const changePath = args.trim()
      if (!changePath) {
        ctx.ui.notify("Usage: /zflow-change-prepare <change-path>", "warning")
        return
      }

      // Step 0: Profile preflight (Phase 7 — Profile.ensureResolved() is step 1)
      await ensureProfileResolved(ctx)

      // Set active workflow mode so before_agent_start injects the change-prepare fragment
      setActiveWorkflowMode("change-prepare")
      const cleanupMode = () => { resetWorkflowState() }

      // Derive a path slug (same logic as generateChangeId without the timestamp)
      const pathSlug = changePath
        .replace(/[^a-zA-Z0-9]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .toLowerCase()
        .slice(0, 20)

      // Check for unfinished work via checkUnfinishedOnEntry if we can derive changeId
      if (pathSlug) {
        const unfinishedCheck = await checkUnfinishedOnEntry(pathSlug)
        if (unfinishedCheck.hasUnfinishedWork) {
          const choices = unfinishedCheck.choices.map(
            (c) => `  - ${c.action}: ${c.description}`,
          ).join("\n")
          ctx.ui.notify(
            `⚠️ Unfinished work detected for change matching "${pathSlug}".\n\n` +
            `Last phase: ${unfinishedCheck.lastPhase}\n` +
            `Unfinished runs: ${unfinishedCheck.unfinishedRunIds.join(", ")}\n` +
            `\nAvailable options:\n${choices}\n\n` +
            "Use /zflow-clean or manually resolve before retrying, or proceed with a different change path.",
            "warning",
          )
          cleanupMode()
          return
        }
      }

      ctx.ui.notify(`📋 Preparing change plan for "${changePath}"...`)

      try {
        // Step 1: Run the initial prepare workflow (creates plan state, version dir, etc.)
        const result = await runChangePrepareWorkflow({
          changePath,
        })

        ctx.ui.notify(
          `✅ Phase 1 complete: Plan created for change "${result.changeId}" (${result.planVersion}).`,
          "info",
        )
        ctx.ui.notify(
          `   Plan state at: ${result.planStatePath}`,
          "info",
        )

        // Check if RuneContext was detected as canonical — notify the user
        const planStateRuneContext = (result.initialPlanState as Record<string, unknown>)?.runeContext as Record<string, unknown> | undefined
        if (planStateRuneContext && (planStateRuneContext as Record<string, unknown>).canonical === true) {
          const docs = (planStateRuneContext as Record<string, unknown>).canonicalDocs as string[] | undefined
          ctx.ui.notify(
            `📋 RuneContext detected for "${changePath}".\n` +
            `   Canonical RuneContext docs will be used as the requirements source.\n` +
            (docs && docs.length > 0 ? `   Available docs: ${docs.join(", ")}` : ""),
            "info",
          )
        }

        // Step 2: Validate plan artifacts
        ctx.ui.notify(`🔍 Validating plan artifacts for "${result.changeId}" v${result.planVersion}...`, "info")
        const validation = await runPlanValidation(result.changeId, result.planVersion)
        if (validation.pass) {
          await advancePlanLifecycle(result.changeId, "validated")
          ctx.ui.notify(`✅ Plan validation passed for "${result.changeId}" v${result.planVersion}.`, "info")
        } else {
          ctx.ui.notify(
            `⚠️ Plan validation found issues:\n${validation.issues.map((i) => `  - ${i}`).join("\n")}`,
            "warning",
          )
          ctx.ui.notify("Plan artifacts need attention before proceeding to review.", "warning")
        }

        // Step 3: Run plan review
        ctx.ui.notify(`📋 Running plan review for "${result.changeId}" v${result.planVersion}...`, "info")
        const reviewResult = await runPlanReview(result.changeId, result.planVersion)
        if (reviewResult.pass) {
          await advancePlanLifecycle(result.changeId, "reviewed")
          ctx.ui.notify(`✅ Plan review passed for "${result.changeId}".`, "info")
        } else {
          ctx.ui.notify(
            `⚠️ Plan review found issues: ${reviewResult.summary}`,
            "warning",
          )
        }

        // Step 4: Run structured interview for plan approval
        const approvalQuestions = buildPlanApprovalQuestions(
          result.changeId,
          result.planVersion,
          `Change path: ${changePath}\nReview status: ${reviewResult.pass ? "passed" : "needs attention"}\nValidation: ${validation.pass ? "passed" : "has issues"}`,
        )

        const interviewResult = await runStructuredInterview(
          ctx,
          approvalQuestions,
          `Plan "${result.changeId}" version ${result.planVersion} is ready. ` +
          `Use the interactive UI to approve, request revisions, or cancel.`,
        )

        if (!interviewResult) {
          // No usable UI at all — log paths for manual inspection
          ctx.ui.notify(
            `📌 Plan "${result.changeId}" version ${result.planVersion} is ready for review.\n` +
            `Plan artifacts:\n` +
            `  - design: ${result.artifactPaths.design}\n` +
            `  - execution-groups: ${result.artifactPaths.executionGroups}\n` +
            `  - standards: ${result.artifactPaths.standards}\n` +
            `  - verification: ${result.artifactPaths.verification}\n\n` +
            `Run /zflow-change-audit ${result.changeId} to inspect.`,
            "info",
          )
          return
        }

        switch (interviewResult.decision) {
          case "approve": {
            await approvePlanVersion(result.changeId, result.planVersion)
            ctx.ui.notify(
              `✅ Plan "${result.changeId}" version ${result.planVersion} approved.`,
              "info",
            )

            // Build implementation handoff and attempt session fork
            const handoff = buildImplementationHandoff(
              result.changeId,
              result.planVersion,
              resolveRuntimeStateDir(),
              result.artifactPaths,
            )

            const forkResult = await forkImplementationSessionIfAvailable(
              ctx as unknown as Record<string, unknown>,
              handoff,
            )

            if (forkResult.forked && forkResult.sessionFile) {
              // Successfully forked into a new implementation session
              ctx.ui.notify(
                `🚀 Forked implementation session.\n` +
                `  Session file: ${forkResult.sessionFile}\n` +
                `  Change: ${handoff.changeId} v${handoff.approvedVersion}\n` +
                `  No git branches were created.\n` +
                `  The planning session remains available via session tree/resume.\n` +
                `  Run \`/zflow-change-implement ${handoff.changeId}\` in the new session to begin.`,
                "info",
              )
            } else if (forkResult.handoffArtifactPath) {
              // Fallback: handoff artifact written
              ctx.ui.notify(
                `📋 Handoff artifact written to: ${forkResult.handoffArtifactPath}\n` +
                `  Change: ${handoff.changeId} v${handoff.approvedVersion}\n` +
                `  No session fork API was available — handoff data persisted for next session.\n` +
                `  Use \`/zflow-change-implement ${handoff.changeId}\` to load the handoff.\n` +
                `  No git branches were created.`,
                "info",
              )
            } else {
              // No fork and no artifact — show inline handoff data
              ctx.ui.notify(
                `📋 Handoff data prepared for change "${handoff.changeId}" v${handoff.approvedVersion}.\n` +
                `  Pass \`/zflow-change-implement ${handoff.changeId}\` to begin implementation.`,
                "info",
              )
            }

            // Present handoff summary and next steps
            ctx.ui.notify(
              `\n📋 Implementation handoff summary:\n` +
              `  • Plan: ${handoff.changeId} v${handoff.approvedVersion}\n` +
              `  • Handoff mode: ${forkResult.forked ? "session-fork" : forkResult.handoffArtifactPath ? "artifact-file" : "inline"}\n` +
              `  • Artifacts:\n` +
              `    - design: ${handoff.planArtifactPaths.design ?? "N/A"}\n` +
              `    - execution-groups: ${handoff.planArtifactPaths.executionGroups ?? "N/A"}\n` +
              `    - verification: ${handoff.planArtifactPaths.verification ?? "N/A"}\n` +
              `  • Next: Run \`/zflow-change-implement ${handoff.changeId}\``,
              "info",
            )
            break
          }
          case "revise": {
            await bumpPlanVersion(result.changeId)
            await advancePlanLifecycle(result.changeId, "draft")
            ctx.ui.notify(
              `📝 Revision requested for "${result.changeId}". ` +
              (interviewResult.revisionNotes
                ? `Notes: ${interviewResult.revisionNotes}`
                : "A new plan version will be created."),
              "info",
            )
            break
          }
          case "cancel": {
            await updatePlanState(result.changeId, {
              lifecycleState: "cancelled",
            })
            ctx.ui.notify(
              `🛑 Plan "${result.changeId}" version ${result.planVersion} cancelled by user.`,
              "warning",
            )
            break
          }
          default: {
            // "inspect" or unknown — log paths for manual review
            ctx.ui.notify(
              `📌 Plan "${result.changeId}" version ${result.planVersion} is ready for review.\n` +
              `Decision: ${interviewResult.decision}. Use /zflow-change-audit ${result.changeId} to inspect.`,
              "info",
            )
            break
          }
        }
      } catch (err: unknown) {
        ctx.ui.notify(
          `Change preparation failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        )
      } finally {
        // Clear mode and reminders regardless of outcome
        resetWorkflowState()
      }
    },
  })

  // ── Command: /zflow-change-implement ──────────────────────────

  pi.registerCommand("zflow-change-implement", {
    description: "Execute the approved plan for a change — worktree dispatch, verification, review",
    handler: async (args: string, ctx: InterviewableContext): Promise<void> => {
      // Parse --force flag from args
      const parts = args.trim().split(/\s+/)
      const force = parts.includes("--force")
      const changeId = parts.filter(p => p !== "--force").join(" ")

      if (!changeId) {
        ctx.ui.notify(
          "Usage: /zflow-change-implement <change-id> [--force]\n\n" +
          "  --force    Proceed even if the primary worktree has uncommitted changes.",
          "warning",
        )
        return
      }

      // Step 0: Profile preflight (Phase 7 — Profile.ensureResolved() is step 1)
      await ensureProfileResolved(ctx)

      // Set active workflow mode so before_agent_start injects change-implement fragment
      setActiveWorkflowMode("change-implement")
      const cleanupMode = (): void => { resetWorkflowState() }

      // Check for unfinished work on this change
      const unfinishedCheck = await checkUnfinishedOnEntry(changeId)
      if (unfinishedCheck.hasUnfinishedWork) {
        const choices = unfinishedCheck.choices.map(
          (c) => `  - ${c.action}: ${c.description}`,
        ).join("\n")
        ctx.ui.notify(
          `⚠️ Unfinished work detected for change "${changeId}".\n\n` +
          `Last phase: ${unfinishedCheck.lastPhase}\n` +
          `Unfinished runs: ${unfinishedCheck.unfinishedRunIds.join(", ")}\n` +
          (unfinishedCheck.retainedWorktrees.length > 0
            ? `Retained worktrees: ${unfinishedCheck.retainedWorktrees.join(", ")}\n`
            : "") +
          `\nAvailable options:\n${choices}\n\n` +
          "Use /zflow-clean or /zflow-change-audit to inspect and clean up before retrying.",
          "warning",
        )
        cleanupMode()
        return
      }

      // ── Detect and load pending handoff artifacts ──────────────
      // If a handoff artifact exists from a previous /zflow-change-prepare approval,
      // load it for cross-session context. This allows the implementation to proceed
      // even when the fork API was unavailable.
      const existingHandoff = await resolvePendingHandoff(changeId)
      if (existingHandoff) {
        ctx.ui.notify(
          `📋 Loaded handoff artifact for "${changeId}" v${existingHandoff.approvedVersion}.`,
          "info",
        )
        // Clear the artifact so it's not re-read on subsequent invocations
        await clearPendingHandoff(changeId)
      }

      ctx.ui.notify(`⚙️ Implementing change "${changeId}"...`)

      try {
        // Set approved-plan-loaded reminder — the approved plan is about to be loaded
        addReminder("approved-plan-loaded")

        const result = await runChangeImplementWorkflow({
          changeId,
          force,
        })

        if (force) {
          ctx.ui.notify(
            "⚠️ Dirty worktree — proceeding because --force was passed. " +
            "Uncommitted changes may interfere with worktree isolation.",
            "warning",
          )
        }

        ctx.ui.notify(
          `⚙️ Implementation for "${result.changeId}" (${result.planVersion}) ` +
          `started with status: ${result.status}. Run ID: ${result.runId}`,
          "info",
        )

        // Once an approved plan is loaded and execution begins, clear the
        // approved-plan-loaded reminder.
        removeReminder("approved-plan-loaded")

        // ── Run the combined post-start sequence ─────────────────
        // This advances through verification → fix loop → code review → complete
        // where possible, persisting every phase transition to run.json and state-index.
        const postResult = await runImplementationPostStartSequence(
          result.runId,
          {
            skipDispatchWait: true, // We just created the run; don't wait for dispatch
          },
        )

        // Set verification-status reminder based on the sequence outcome
        if (postResult.verificationStatus === "passed" || postResult.verificationStatus === "pending") {
          addReminder("verification-status")
        } else if (postResult.verificationStatus === "failed") {
          addReminder("verification-status")
          ctx.ui.notify(
            `⚠️ Final verification ${postResult.verificationStatus}. ` +
            `Check run.json for details. Phase: ${postResult.phase}`,
            "warning",
          )
        } else if (postResult.verificationStatus === "skipped") {
          addReminder("verification-status")
          ctx.ui.notify(
            `ℹ️ Final verification was skipped. Review will be advisory.`,
            "info",
          )
        }

        // Report the resulting phase/status
        ctx.ui.notify(
          `📋 Post-start sequence phase: ${postResult.phase}, status: ${postResult.status}.`,
          "info",
        )

        if (postResult.error) {
          ctx.ui.notify(`⚠️ ${postResult.error}`, "warning")
        }

        // Print next steps from the post-start sequence (file-backed via run.json)
        const nextStepsText = postResult.nextSteps.length > 0
          ? postResult.nextSteps
              .map((s, i) => `  ${i + 1}. ${s.replace(/^\d+\.\s*/, "")}`)
              .join("\n")
          : "  No further steps — workflow is complete."
        ctx.ui.notify(
          `📋 Next steps (persisted in run.json):\n${nextStepsText}\n\n` +
          `Use /zflow-change-audit ${changeId} to check workflow status at any time.`,
          "info",
        )
      } catch (err: unknown) {
        ctx.ui.notify(
          `Implementation failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        )
      } finally {
        // Clear mode and reminders regardless of outcome
        resetWorkflowState()
      }
    },
  })

  // ── Command: /zflow-change-audit ──────────────────────────────

  pi.registerCommand("zflow-change-audit", {
    description: "Audit an approved plan's verification status and deviation reports",
    handler: async (args: string, ctx: InterviewableContext): Promise<void> => {
      const changeId = args.trim()
      if (!changeId) {
        ctx.ui.notify("Usage: /zflow-change-audit <change-id>", "warning")
        return
      }

      ctx.ui.notify(`🔍 Auditing change "${changeId}"...`)

      try {
        const result = await runChangeAuditWorkflow({
          changeId,
        })

        // Present full summary
        ctx.ui.notify(result.summary, "info")

        // Emit recommended actions as additional notifications
        for (const action of result.recommendedActions) {
          ctx.ui.notify(`→ ${action}`, "info")
        }

        // Suggest re-run commands based on status
        const status = result.status
        if (status === "approved" || status === "executing") {
          ctx.ui.notify(
            `Tip: Run /zflow-review-code ${changeId} to (re-)run code review, ` +
            `or /zflow-change-implement ${changeId} if not yet executed.`,
            "info",
          )
        }

        // Structured gate when verification failed
        if (result.verificationStatus === "failed") {
          const gateQuestions = buildImplementationGateQuestions(
            changeId,
            "verification-failure",
            `Verification failed for change "${changeId}" (${result.planVersion}).\n${result.summary}`,
          )

          const gateResult = await runStructuredInterview(
            ctx,
            gateQuestions,
            `Verification failed for "${changeId}". Choose how to proceed: auto-fix loop, manual review, or skip.`,
          )

          if (gateResult) {
            switch (gateResult.decision) {
              case "continue": {
                // "Auto-fix Loop" was selected — redirect to fix workflow
                ctx.ui.notify(
                  `→ Run /zflow-change-fix ${changeId} to start the auto-fix loop.`,
                  "info",
                )
                break
              }
              case "approve": {
                // "Skip Verification" or equivalent — mark as advisory
                ctx.ui.notify(
                  `→ Verification skipped for "${changeId}". Review will be advisory.`,
                  "info",
                )
                break
              }
              default: {
                // "Manual Review" or "cancel" — just show the notification
                ctx.ui.notify(
                  `→ Manual review chosen for "${changeId}". Use /zflow-change-fix ${changeId} when ready.`,
                  "info",
                )
                break
              }
            }
          }
        }
      } catch (err: unknown) {
        ctx.ui.notify(
          `Audit failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        )
      }
    },
  })

  // ── Command: /zflow-change-fix ────────────────────────────────

  pi.registerCommand("zflow-change-fix", {
    description: "Iterate on verification/code-review failures for an approved change",
    handler: async (args: string, ctx: InterviewableContext): Promise<void> => {
      const changeId = args.trim()
      if (!changeId) {
        ctx.ui.notify("Usage: /zflow-change-fix <change-id>", "warning")
        return
      }

      ctx.ui.notify(`🔧 Running fix workflow for change "${changeId}"...`)

      try {
        const result = await runChangeFixWorkflow({
          changeId,
        })

        // Present the fix plan
        ctx.ui.notify(result.fixPlan, "info")
        if (result.filesToModify.length > 0) {
          ctx.ui.notify(
            `Files to modify: ${result.filesToModify.map(f => `\`${f}\``).join(", ")}`,
            "info",
          )
        }

        // Structured gate presenting review-finding fix options
        const gateQuestions = buildImplementationGateQuestions(
          changeId,
          "review-findings",
          `Fix plan for "${changeId}":\n${result.fixPlan}\n` +
          (result.filesToModify.length > 0
            ? `Target files: ${result.filesToModify.join(", ")}`
            : "No specific files identified."),
        )

        const gateResult = await runStructuredInterview(
          ctx,
          gateQuestions,
          `Fix plan ready for "${changeId}". Choose approach: fix all, critical/major only, or dismiss findings.`,
        )

        if (gateResult) {
          switch (gateResult.decision) {
            case "continue": {
              // "Fix All" — proceed with full fix scope
              ctx.ui.notify(
                `🛠 Applying all fixes for "${changeId}".`,
                "info",
              )
              break
            }
            case "approve": {
              // "Fix Critical/Major" or equivalent
              ctx.ui.notify(
                `🛠 Applying critical/major fixes for "${changeId}".`,
                "info",
              )
              break
            }
            default: {
              // "Dismiss" or "cancel"
              ctx.ui.notify(
                `⏭ Findings dismissed for "${changeId}". Proceeding without fixes.`,
                "info",
              )
              break
            }
          }
        }

        // Offer next steps
        if (result.verificationCommand) {
          ctx.ui.notify(
            `After applying fixes, run the following verification command:\n` +
            `\`\`\`bash\n${result.verificationCommand}\n\`\`\``,
            "info",
          )
        }
        ctx.ui.notify(
          `Tip: After fixes are applied, update the plan lifecycle via ` +
          `the planning workflow and re-run /zflow-review-code ${changeId} to re-verify.`,
          "info",
        )
      } catch (err: unknown) {
        ctx.ui.notify(
          `Fix workflow failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        )
      }
    },
  })
}
