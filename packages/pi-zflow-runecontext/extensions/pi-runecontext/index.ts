/**
 * pi-zflow-runecontext extension entrypoint
 *
 * Registers RuneContext detection, change-doc parsing, and canonical doc
 * resolution services. Note the extension directory is `pi-runecontext`
 * (not `zflow-runecontext`) for consistency with the canonical tool naming.
 *
 * Phase 3 Task 3.1: On activation, the extension:
 *   1. Claims the "runecontext" capability via `getZflowRegistry()`.
 *   2. Guards against duplicate loads — if "runecontext" is already claimed
 *      by a compatible provider, it no-ops.
 *   3. Re-exports RuneContext detection utilities for sibling packages.
 *
 * @module pi-zflow-runecontext/index
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { getZflowRegistry, PI_ZFLOW_RUNECONTEXT_VERSION } from "pi-zflow-core"
import type { CapabilityClaim } from "pi-zflow-core"

import {
  detectRuneContext,
  fileExists,
  tryRunectxStatus,
} from "./detect.js"

import {
  createRuneContextService,
} from "../../src/api.js"

export type { RuneContextDetection } from "./detect.js"
export {
  detectRuneContext,
  fileExists,
  tryRunectxStatus,
}

// Re-export change resolution types and functions (Task 3.2)
export type {
  RuneChangeFlavor,
  ResolvedRuneChangeFiles,
  ResolvedRuneChange,
  ResolveRuneChangeInput,
} from "./resolve-change.js"
export { resolveRuneChange } from "./resolve-change.js"

// Re-export canonical doc reader types and function (Task 3.3)
export type {
  RuneDoc,
  RuneStatus,
  RuneDocs,
} from "./read-docs.js"
export { readRuneContextDocs } from "./read-docs.js"

// Re-export precedence utilities (Task 3.4)
export type {
  RequirementsSource,
  DerivationStatus,
} from "./precedence.js"
export {
  getRequirementsSource,
  classifyArtifact,
  isCanonicalArtifact,
  listCanonicalDocNames,
  listDerivedArtifactNames,
} from "./precedence.js"

// Re-export execution-group derivation types and functions (Task 3.5)
export type {
  DerivedExecutionGroup,
  DerivedTask,
  DerivedExecutionGroups,
} from "./derive.js"
export {
  deriveExecutionGroupsFromRuneDocs,
  parseTasksMd,
  inferGroupsFromDocs,
} from "./derive.js"

// Re-export status mapping types and functions (Task 3.6)
export type {
  HarnessState,
  WriteBackPolicy,
  StatusMappingResult,
  StatusVocabulary,
} from "./runectx.js"
export {
  mapHarnessStateToRuneStatus,
  buildRuntimeMetadata,
  shouldOfferWriteBack,
} from "./runectx.js"

// Re-export amendment flow types and functions (Task 3.7)
export type {
  RuneContextAmendment,
  WriteBackResult,
} from "./runectx.js"
export {
  createAmendment,
  approveAmendment,
  writeApprovedAmendment,
} from "./runectx.js"

// Re-export write-target guard functions (Task 3.8)
export {
  isWriteAllowedInRuneContextTree,
  validateRuneContextWriteTarget,
  getForbiddenArtifacts,
  getCanonicalDocNames,
} from "./guards.js"

// Re-export custom error classes (Task 3.10)
export {
  RuneContextError,
  MissingRequiredFileError,
  ChangeResolutionError,
  AmbiguousStatusError,
  DetectionConflictError,
} from "./errors.js"

/** Well-known capability name for RuneContext support. */
export const RUNECONTEXT_CAPABILITY = "runecontext" as const

/**
 * Activate the pi-zflow-runecontext extension.
 *
 * Claims the "runecontext" capability in the shared zflow registry and
 * immediately provides a {@link RuneContextService} instance so that
 * downstream consumers (e.g. Phase 7 pi-zflow-change-workflows) can
 * discover RuneContext functionality via `registry.get("runecontext")`.
 *
 * If the capability is already claimed by a compatible provider, the
 * activation is a no-op (duplicate load guard).
 *
 * @param pi - The Pi extension API provided by the harness.
 */
export default function activateZflowRunecontextExtension(pi: ExtensionAPI): void {
  const registry = getZflowRegistry()

  // ── Build the capability claim ────────────────────────────────
  const claim: CapabilityClaim = {
    capability: RUNECONTEXT_CAPABILITY,
    version: PI_ZFLOW_RUNECONTEXT_VERSION,
    provider: "pi-zflow-runecontext",
    sourcePath: import.meta.url,
    compatibilityMode: "compatible",
  }

  // ── Claim the capability ──────────────────────────────────────
  const registered = registry.claim(claim)

  // If claim returns null, an incompatible provider already owns this
  // capability — do not register anything.
  if (!registered) {
    // A diagnostic was already emitted by the registry.
    return
  }

  // If the capability already has a service, another compatible
  // instance already initialised fully. No-op to avoid duplicate
  // command registration and session hooks.
  if (registered.service !== undefined) {
    return
  }

  // ── Provide the RuneContext service ───────────────────────────
  registry.provide(RUNECONTEXT_CAPABILITY, createRuneContextService())
}
