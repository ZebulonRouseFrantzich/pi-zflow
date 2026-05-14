/**
 * compaction-service.ts — Proactive compaction service for pi-zflow-compaction.
 *
 * Encapsulates compaction policy logic: threshold detection, cheap model
 * selection, summarization prompt construction, and canonical artifact
 * path preservation.
 *
 * ## Usage
 *
 * ```ts
 * import { getCompactionThreshold, chooseCheapCompactionModel } from "./compaction-service.js"
 *
 * const threshold = getCompactionThreshold()
 * const model = chooseCheapCompactionModel(ctx.modelRegistry)
 * ```
 *
 * @module pi-zflow-compaction/compaction-service
 */

import type { Model } from "@earendil-works/pi-ai"

// ── Types ───────────────────────────────────────────────────────

/**
 * A model registry compatible with the compaction service.
 *
 * Duck-typed subset of `ctx.modelRegistry` so tests can provide
 * a minimal mock without importing the full Pi type.
 */
export interface ModelRegistryLike {
  find(provider: string, modelId: string): Model | undefined
}

/**
 * Compaction service exposed via the shared capability registry.
 */
export interface CompactionService {
  /** Get the proactive compaction usage ratio threshold (0.0–1.0). */
  getCompactionThreshold(): number
  /** Find the cheapest available summarization model. */
  chooseCheapCompactionModel(registry: ModelRegistryLike): Model | undefined
  /** Build a summarization prompt that preserves canonical artifact paths. */
  buildCompactionPrompt(
    messagesToSummarize: number,
    tokensBefore: number,
    hasPreviousSummary: boolean,
    artifactPaths?: string[],
  ): string
  /** List of canonical artifact paths to preserve after compaction. */
  getDefaultArtifactPaths(): string[]
}

// ── Constants ───────────────────────────────────────────────────

/**
 * Compaction triggers proactively when context usage reaches this ratio.
 * Phase 8 decision: trigger at 60–70% usage.
 * We use 0.6 (60%) as the proactive threshold.
 */
const COMPACTION_THRESHOLD = 0.6

/**
 * Default canonical artifact paths relative to `<runtime-state-dir>`.
 * These are preserved after compaction for exact rereads.
 *
 * ## Canonical artifact paths preserved during compaction
 *
 * These files remain backed by actual file content on disk and
 * should NOT be fully summarised — instead, agents reread them
 * directly from disk after a compaction cycle.
 *
 * ### Mandatory rereads (every agent after compaction)
 *
 * | Artifact       | Path pattern                            | Description                                    |
 * |----------------|-----------------------------------------|------------------------------------------------|
 * | Repo map       | `<runtime-state-dir>/repo-map.md`       | Repository structure overview                  |
 * | Reconnaissance | `<runtime-state-dir>/reconnaissance.md` | Codebase reconnaissance output                 |
 * | Failure log    | `<runtime-state-dir>/failure-log.md`    | Recent failure entries                         |
 * | Plan state     | `<runtime-state-dir>/plans/`            | Current plan phase, version, completion flags  |
 *
 * ### Optional rereads (role-specific)
 *
 * | Artifact       | Path pattern                              | Description                |
 * |----------------|-------------------------------------------|----------------------------|
 * | Review findings| `<runtime-state-dir>/findings.md`         | Code or plan review finds  |
 * | Workflow state | `<runtime-state-dir>/workflow-state.json` | Active workflow mode/reminder metadata |
 *
 * ### Rationale
 *
 * - Plan state directories track lifecycle transitions (draft → reviewed →
 *   approved → executing → completed). After compaction the model must know
 *   which phase the workflow is in to continue correctly.
 * - Approved plan artifacts (design, execution-groups, standards, verification)
 *   are the authoritative source of what to implement and how to verify it.
 *   They must be reread rather than reconstructed from a compacted summary.
 * - The failure log must be reread so the model sees the exact error messages
 *   and root causes, not a paraphrased compacted reference.
 * - Findings and workflow-state are role-specific: review agents need findings,
 *   orchestrators need workflow state.
 *
 * These identifiers match `CANONICAL_ARTIFACTS` in `reread-policy.ts`.
 */
const DEFAULT_ARTIFACT_PATHS: string[] = [
  "repo-map.md",
  "reconnaissance.md",
  "failure-log.md",
  "plans/",
  "findings.md",
  "workflow-state.json",
]

// ── Implementation ──────────────────────────────────────────────

/**
 * Return the proactive compaction threshold ratio.
 *
 * When estimated context usage reaches this ratio of the context window,
 * the `session_before_compact` hook should trigger custom compaction.
 */
export function getCompactionThreshold(): number {
  return COMPACTION_THRESHOLD
}

/**
 * Find the cheapest available summarization model.
 *
 * Preference order (cheapest first):
 * 1. Google Gemini 2.5 Flash
 * 2. Anthropic Claude Sonnet 4
 * 3. Any available model (undefined = let default compaction handle it)
 *
 * @param registry - A model registry-like object for lookups.
 * @returns The cheapest available model, or `undefined` if none found.
 */
export function chooseCheapCompactionModel(
  registry: ModelRegistryLike,
): Model | undefined {
  // Preference 1: Gemini Flash (cheap, fast)
  const geminiFlash = registry.find("google", "gemini-2.5-flash")
  if (geminiFlash) return geminiFlash

  // Preference 2: Claude Sonnet 4 (moderate cost, good quality)
  const claudeSonnet = registry.find("anthropic", "claude-sonnet-4-20250514")
  if (claudeSonnet) return claudeSonnet

  // Fallback: let the caller decide (default compaction)
  return undefined
}

/**
 * Build a summarization prompt that preserves understanding of canonical
 * artifact paths and instructs the model to produce a concise structured
 * summary suitable for continuing work.
 *
 * @param messagesToSummarize - Number of messages being summarized.
 * @param tokensBefore - Estimated token count before compaction.
 * @param hasPreviousSummary - Whether a previous compaction summary exists.
 * @param artifactPaths - Optional list of canonical artifact paths to reference.
 * @returns A user-role message content string for the summarization model.
 */
export function buildCompactionPrompt(
  messagesToSummarize: number,
  tokensBefore: number,
  hasPreviousSummary: boolean,
  artifactPaths?: string[],
): string {
  const paths = artifactPaths && artifactPaths.length > 0
    ? artifactPaths
    : DEFAULT_ARTIFACT_PATHS

  const pathList = paths.map((p) => `  - \`<runtime-state-dir>/${p}\``).join("\n")

  const previousContextNote = hasPreviousSummary
    ? "\n\nA previous session summary is available and will be provided for context. Incorporate its information into the new summary."
    : ""

  return [
    "You are a conversation summarizer for a coding session. Create a concise structured summary of the conversation that preserves all information needed to continue the work effectively.",
    "",
    `This compaction cycle summarizes approximately ${messagesToSummarize} messages (${tokensBefore.toLocaleString()} tokens).`,
    previousContextNote,
    "",
    "## Instructions",
    "",
    "1. Capture the main goals, objectives, and design decisions discussed.",
    "2. Note all file changes, code modifications, and technical details.",
    "3. Record the current state of ongoing work and any blockers.",
    "4. List next steps that were planned or suggested.",
    "5. Preserve references to canonical artifact paths so the model rereads them after compaction.",
    "",
    "## Canonical Artifacts (file-backed, reread after compaction)",
    "",
    "These artifacts remain authoritative on disk. Do not summarize their contents —",
    "the model will reread them directly after compaction:",
    "",
    pathList,
    "",
    "## Format",
    "",
    "Write the summary as structured markdown with these sections:",
    "",
    "### Goals and Decisions",
    "### Code Changes and Technical Details",
    "### Current State and Blockers",
    "### Next Steps",
    "",
    "Keep the summary under 200 lines. Be thorough but concise — this summary",
    "replaces the summarized conversation turns so future agents must be able to",
    "continue from this point without missing important context.",
  ].join("\n")
}

/**
 * Return the default list of canonical artifact paths (relative to
 * `<runtime-state-dir>`) that should be preserved and recommended for
 * reread after compaction.
 */
export function getDefaultArtifactPaths(): string[] {
  return [...DEFAULT_ARTIFACT_PATHS]
}

/**
 * Create the default compaction service instance.
 */
export function createCompactionService(): CompactionService {
  return {
    getCompactionThreshold,
    chooseCheapCompactionModel,
    buildCompactionPrompt,
    getDefaultArtifactPaths,
  }
}
