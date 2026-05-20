/**
 * pi-zflow-runecontext
 *
 * RuneContext detection, change-doc flavor parsing,
 * canonical doc resolution, and prompt-with-preview write-back support.
 *
 * # Public API
 *
 * Downstream consumers (Phase 7 – pi-zflow-change-workflows) should
 * import from this package's default entry point. The public surface is
 * defined in `api.ts` and includes:
 *
 *   - **Detection**        – `detectRuneContext`, `fileExists`, `tryRunectxStatus`
 *   - **Resolution**       – `resolveRuneChange`, `ResolvedRuneChange`
 *   - **Reading**          – `readRuneContextDocs`, `RuneDocs`
 *   - **Precedence**       – `classifyArtifact`, `getRequirementsSource`
 *   - **Derivation**       – `deriveExecutionGroupsFromRuneDocs`
 *   - **Status mapping**   – `mapHarnessStateToRuneStatus`
 *   - **Amendments**       – `createAmendment`, `approveAmendment`, `writeApprovedAmendment`
 *   - **Guards**           – `validateRuneContextWriteTarget`, `isWriteAllowedInRuneContextTree`
 *   - **Errors**           – `RuneContextError`, `MissingRequiredFileError`, etc.
 *   - **Service interface** – `RuneContextService`, `createRuneContextService`
 *
 * @module pi-zflow-runecontext
 */

export const PACKAGE_VERSION = "0.1.0" as const

export type {
  // ── Detection ──
  RuneContextDetection,
  // ── Resolution ──
  RuneChangeFlavor,
  ResolvedRuneChangeFiles,
  ResolvedRuneChange,
  ResolveRuneChangeInput,
  // ── Reading ──
  RuneDoc,
  RuneStatus,
  RuneDocs,
  // ── Precedence ──
  RequirementsSource,
  DerivationStatus,
  // ── Derivation ──
  DerivedExecutionGroup,
  DerivedTask,
  DerivedExecutionGroups,
  // ── Status mapping ──
  HarnessState,
  WriteBackPolicy,
  StatusMappingResult,
  StatusVocabulary,
  // ── Amendments ──
  RuneContextAmendment,
  WriteBackResult,
  // ── Service interface ──
  RuneContextService,
} from "./api.js"

export {
  // ── Detection ──
  detectRuneContext,
  fileExists,
  tryRunectxStatus,
  // ── Resolution ──
  resolveRuneChange,
  // ── Reading ──
  readRuneContextDocs,
  // ── Precedence ──
  getRequirementsSource,
  classifyArtifact,
  isCanonicalArtifact,
  listCanonicalDocNames,
  listDerivedArtifactNames,
  // ── Derivation ──
  deriveExecutionGroupsFromRuneDocs,
  parseTasksMd,
  inferGroupsFromDocs,
  // ── Status mapping ──
  mapHarnessStateToRuneStatus,
  buildRuntimeMetadata,
  shouldOfferWriteBack,
  // ── Amendments ──
  createAmendment,
  approveAmendment,
  writeApprovedAmendment,
  // ── Guards ──
  isWriteAllowedInRuneContextTree,
  validateRuneContextWriteTarget,
  getForbiddenArtifacts,
  // ── Errors ──
  RuneContextError,
  MissingRequiredFileError,
  ChangeResolutionError,
  AmbiguousStatusError,
  DetectionConflictError,
  // ── Service interface ──
  createRuneContextService,
} from "./api.js"

// Help topic metadata for suite-level /zflow-help display
export { ZFLOW_HELP_TOPICS, RUNECONTEXT_HELP_TOPIC } from "./help.js"
