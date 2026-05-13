/**
 * precedence.ts — Canonical-vs-derived precedence utilities for RuneContext mode.
 *
 * Implements Phase 3 Task 3.4:
 * Prevent derived orchestration artifacts from competing with RuneContext
 * source documents by providing explicit classification functions.
 *
 * Key rules:
 *   - In RuneContext mode, canonical RuneContext docs (proposal.md, design.md,
 *     etc.) are the source of requirements. Derived artifacts (execution-groups.md,
 *     plan-state.json, etc.) must never be treated as authoritative.
 *   - If a plan drift or amendment implies requirement changes, the change
 *     must be written to the canonical docs first (after approval), then
 *     derivatives are regenerated.
 *   - In adhoc mode, versioned plan artifacts are canonical and
 *     execution-groups.md is canonical — no RuneContext docs exist.
 *
 * @module pi-zflow-runecontext/precedence
 */

// ── Types ────────────────────────────────────────────────────────

/**
 * Identifies the authoritative source of requirements for the current mode.
 *
 * - `"canonical-runecontext-docs"`: RuneContext change documents
 *   (proposal.md, design.md, etc.) are the source of truth.
 * - `"versioned-plan-artifacts"`: pi-zflow's own versioned plan artifacts
 *   (execution-groups.md, plan-state.json, etc.) are the source of truth.
 */
export type RequirementsSource =
  | "canonical-runecontext-docs"
  | "versioned-plan-artifacts"

/**
 * Whether a given artifact is authoritative or derived in the current mode.
 *
 * - `"canonical"`: The artifact is a source of truth — its content drives
 *   planning, implementation, and review.
 * - `"derived"`: The artifact is generated from canonical sources and must
 *   never override them. If a requirement changes, the canonical source
 *   must be updated first.
 * - `"runtime-only"`: The artifact is not recognised in the current mode;
 *   it may be a temporary or external file with no defined precedence.
 */
export type DerivationStatus = "canonical" | "derived" | "runtime-only"

// ── Constants ────────────────────────────────────────────────────

/** Canonical RuneContext document file names (RuneContext mode only). */
const CANONICAL_RUNECONTEXT_DOCS: readonly string[] = [
  "proposal.md",
  "design.md",
  "standards.md",
  "verification.md",
  "tasks.md",
  "references.md",
  "status.yaml",
] as const

/** Derived/orchestration artifact file names (RuneContext mode only). */
const DERIVED_ARTIFACTS: readonly string[] = [
  "execution-groups.md",
  "plan-state.json",
  "run.json",
  "deviation-report.md",
  "review-findings.md",
  "repo-map.md",
  "reconnaissance.md",
] as const

/** Artifact names considered canonical in adhoc mode. */
const ADHOC_CANONICAL_ARTIFACTS: readonly string[] = [
  "execution-groups.md",
  "plan-state.json",
  "run.json",
] as const

// ── Classification helpers ───────────────────────────────────────

/**
 * Determine the authoritative source of requirements for the given mode.
 *
 * @param mode - The operating mode ("runecontext" or "adhoc").
 * @returns The requirements source label.
 */
export function getRequirementsSource(
  mode: "runecontext" | "adhoc",
): RequirementsSource {
  return mode === "runecontext"
    ? "canonical-runecontext-docs"
    : "versioned-plan-artifacts"
}

/**
 * Classify a named artifact by its derivation status in the given mode.
 *
 * @param artifactName - The file or artifact name to classify (e.g. "proposal.md").
 * @param mode - The operating mode ("runecontext" or "adhoc").
 * @returns The derivation status of the artifact.
 */
export function classifyArtifact(
  artifactName: string,
  mode: "runecontext" | "adhoc",
): DerivationStatus {
  if (mode === "runecontext") {
    if (isCanonicalRunecontextDoc(artifactName)) {
      return "canonical"
    }
    if (isDerivedArtifact(artifactName)) {
      return "derived"
    }
    return "runtime-only"
  }

  // Adhoc mode
  if (isAdhocCanonicalArtifact(artifactName)) {
    return "canonical"
  }
  return "runtime-only"
}

/**
 * Check whether an artifact is canonical (authoritative) in the given mode.
 *
 * This is a convenience wrapper around `classifyArtifact` for readability
 * in conditional checks.
 *
 * @param artifactName - The file or artifact name to check.
 * @param mode - The operating mode ("runecontext" or "adhoc").
 * @returns `true` if the artifact is canonical in the given mode.
 */
export function isCanonicalArtifact(
  artifactName: string,
  mode: "runecontext" | "adhoc",
): boolean {
  return classifyArtifact(artifactName, mode) === "canonical"
}

/**
 * Return the list of recognised canonical RuneContext document names.
 *
 * These are the source-of-truth documents in RuneContext mode:
 * proposal.md, design.md, standards.md, verification.md, tasks.md,
 * references.md, status.yaml.
 *
 * @returns An array of canonical document file names.
 */
export function listCanonicalDocNames(): string[] {
  return [...CANONICAL_RUNECONTEXT_DOCS]
}

/**
 * Return the list of recognised derived/orchestration artifact names.
 *
 * These are the artifacts that are **derived** from canonical docs in
 * RuneContext mode: execution-groups.md, plan-state.json, run.json,
 * deviation-report.md, review-findings.md, repo-map.md, reconnaissance.md.
 *
 * @returns An array of derived artifact file names.
 */
export function listDerivedArtifactNames(): string[] {
  return [...DERIVED_ARTIFACTS]
}

// ── Internal helpers ─────────────────────────────────────────────

/**
 * Check if `name` is a recognised canonical RuneContext doc.
 */
function isCanonicalRunecontextDoc(name: string): boolean {
  return (CANONICAL_RUNECONTEXT_DOCS as readonly string[]).includes(name)
}

/**
 * Check if `name` is a recognised derived artifact.
 */
function isDerivedArtifact(name: string): boolean {
  return (DERIVED_ARTIFACTS as readonly string[]).includes(name)
}

/**
 * Check if `name` is a recognised canonical artifact in adhoc mode.
 */
function isAdhocCanonicalArtifact(name: string): boolean {
  return (ADHOC_CANONICAL_ARTIFACTS as readonly string[]).includes(name)
}
