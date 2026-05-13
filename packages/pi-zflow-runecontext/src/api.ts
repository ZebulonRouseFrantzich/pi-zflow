/**
 * api.ts — Public API surface for pi-zflow-runecontext
 *
 * This is the stable, documented entry point that Phase 7
 * (pi-zflow-change-workflows) and other downstream consumers should
 * import from. All types and functions are re-exported from the
 * extension implementation modules under `extensions/pi-runecontext/`.
 *
 * The API is grouped into logical sections:
 *   - Detection        — detecting RuneContext-managed repos
 *   - Resolution       — resolving and validating change folders
 *   - Reading          — reading canonical change documents
 *   - Precedence       — canonical vs derived artifact classification
 *   - Derivation       — execution-group derivation from canonical docs
 *   - Status mapping   — harness state → RuneContext status mapping
 *   - Amendments       — creation, approval, and write-back of amendments
 *   - Guards           — write-target validation inside RuneContext trees
 *   - Errors           — custom error types
 *
 * @module pi-zflow-runecontext/api
 */

// ── Imports ───────────────────────────────────────────────────────
// Import the actual implementations so they are available as local
// bindings for `typeof` in the service interface below. They are then
// re-exported unchanged.

import {
  detectRuneContext as _detectRuneContext,
  fileExists as _fileExists,
  tryRunectxStatus as _tryRunectxStatus,
} from "../extensions/pi-runecontext/detect.js"

import {
  resolveRuneChange as _resolveRuneChange,
} from "../extensions/pi-runecontext/resolve-change.js"

import {
  readRuneContextDocs as _readRuneContextDocs,
} from "../extensions/pi-runecontext/read-docs.js"

import {
  getRequirementsSource as _getRequirementsSource,
  classifyArtifact as _classifyArtifact,
  isCanonicalArtifact as _isCanonicalArtifact,
  listCanonicalDocNames as _listCanonicalDocNames,
  listDerivedArtifactNames as _listDerivedArtifactNames,
} from "../extensions/pi-runecontext/precedence.js"

import {
  deriveExecutionGroupsFromRuneDocs as _deriveExecutionGroupsFromRuneDocs,
  parseTasksMd as _parseTasksMd,
  inferGroupsFromDocs as _inferGroupsFromDocs,
} from "../extensions/pi-runecontext/derive.js"

import {
  mapHarnessStateToRuneStatus as _mapHarnessStateToRuneStatus,
  buildRuntimeMetadata as _buildRuntimeMetadata,
  shouldOfferWriteBack as _shouldOfferWriteBack,
  createAmendment as _createAmendment,
  approveAmendment as _approveAmendment,
  writeApprovedAmendment as _writeApprovedAmendment,
} from "../extensions/pi-runecontext/runectx.js"

import {
  isWriteAllowedInRuneContextTree as _isWriteAllowedInRuneContextTree,
  validateRuneContextWriteTarget as _validateRuneContextWriteTarget,
  getForbiddenArtifacts as _getForbiddenArtifacts,
} from "../extensions/pi-runecontext/guards.js"

import {
  RuneContextError as _RuneContextError,
  MissingRequiredFileError as _MissingRequiredFileError,
  ChangeResolutionError as _ChangeResolutionError,
  AmbiguousStatusError as _AmbiguousStatusError,
  DetectionConflictError as _DetectionConflictError,
} from "../extensions/pi-runecontext/errors.js"

// ── Type re-exports ───────────────────────────────────────────────

export type { RuneContextDetection } from "../extensions/pi-runecontext/detect.js"

export type {
  RuneChangeFlavor,
  ResolvedRuneChangeFiles,
  ResolvedRuneChange,
  ResolveRuneChangeInput,
} from "../extensions/pi-runecontext/resolve-change.js"

export type {
  RuneDoc,
  RuneStatus,
  RuneDocs,
} from "../extensions/pi-runecontext/read-docs.js"

export type {
  RequirementsSource,
  DerivationStatus,
} from "../extensions/pi-runecontext/precedence.js"

export type {
  DerivedExecutionGroup,
  DerivedTask,
  DerivedExecutionGroups,
} from "../extensions/pi-runecontext/derive.js"

export type {
  HarnessState,
  WriteBackPolicy,
  StatusMappingResult,
  StatusVocabulary,
} from "../extensions/pi-runecontext/runectx.js"

export type {
  RuneContextAmendment,
  WriteBackResult,
} from "../extensions/pi-runecontext/runectx.js"

// ── Detection ─────────────────────────────────────────────────────

export const detectRuneContext = _detectRuneContext
export const fileExists = _fileExists
export const tryRunectxStatus = _tryRunectxStatus

// ── Resolution ────────────────────────────────────────────────────

export const resolveRuneChange = _resolveRuneChange

// ── Reading ───────────────────────────────────────────────────────

export const readRuneContextDocs = _readRuneContextDocs

// ── Precedence ────────────────────────────────────────────────────

export const getRequirementsSource = _getRequirementsSource
export const classifyArtifact = _classifyArtifact
export const isCanonicalArtifact = _isCanonicalArtifact
export const listCanonicalDocNames = _listCanonicalDocNames
export const listDerivedArtifactNames = _listDerivedArtifactNames

// ── Derivation ────────────────────────────────────────────────────

export const deriveExecutionGroupsFromRuneDocs = _deriveExecutionGroupsFromRuneDocs
export const parseTasksMd = _parseTasksMd
export const inferGroupsFromDocs = _inferGroupsFromDocs

// ── Status mapping ────────────────────────────────────────────────

export const mapHarnessStateToRuneStatus = _mapHarnessStateToRuneStatus
export const buildRuntimeMetadata = _buildRuntimeMetadata
export const shouldOfferWriteBack = _shouldOfferWriteBack

// ── Amendments ────────────────────────────────────────────────────

export const createAmendment = _createAmendment
export const approveAmendment = _approveAmendment
export const writeApprovedAmendment = _writeApprovedAmendment

// ── Guards ────────────────────────────────────────────────────────

export const isWriteAllowedInRuneContextTree = _isWriteAllowedInRuneContextTree
export const validateRuneContextWriteTarget = _validateRuneContextWriteTarget
export const getForbiddenArtifacts = _getForbiddenArtifacts

// ── Errors ────────────────────────────────────────────────────────

export const RuneContextError = _RuneContextError
export const MissingRequiredFileError = _MissingRequiredFileError
export const ChangeResolutionError = _ChangeResolutionError
export const AmbiguousStatusError = _AmbiguousStatusError
export const DetectionConflictError = _DetectionConflictError

// ── Service interface ─────────────────────────────────────────────

/**
 * Service interface for RuneContext integration.
 *
 * Phase 7 (pi-zflow-change-workflows) should consume this interface
 * via the capability registry or direct import. It bundles the key
 * functions a workflow orchestrator needs to detect, resolve, read,
 * map, amend, and guard RuneContext changes.
 */
export interface RuneContextService {
  /** Detect whether a repo is RuneContext-managed. */
  detect: typeof detectRuneContext
  /** Resolve and validate a RuneContext change folder. */
  resolveChange: typeof resolveRuneChange
  /** Read canonical change documents from a resolved change. */
  readDocs: typeof readRuneContextDocs
  /** Map a harness state to a RuneContext status value. */
  mapStatus: typeof mapHarnessStateToRuneStatus
  /** Create a new amendment targeting a change folder. */
  createAmendment: typeof createAmendment
  /** Mark an amendment as approved for write-back. */
  approveAmendment: typeof approveAmendment
  /** Write an approved amendment's document changes to disk. */
  writeAmendment: typeof writeApprovedAmendment
  /** Validate whether a write target is allowed inside a RuneContext tree. */
  validateWriteTarget: typeof validateRuneContextWriteTarget
}

/**
 * Build a {@link RuneContextService} instance from the live module imports.
 *
 * Convenience helper for callers that want to construct the service
 * object in one call rather than manually wiring each reference.
 */
export function createRuneContextService(): RuneContextService {
  return {
    detect: detectRuneContext,
    resolveChange: resolveRuneChange,
    readDocs: readRuneContextDocs,
    mapStatus: mapHarnessStateToRuneStatus,
    createAmendment,
    approveAmendment,
    writeAmendment: writeApprovedAmendment,
    validateWriteTarget: validateRuneContextWriteTarget,
  }
}
