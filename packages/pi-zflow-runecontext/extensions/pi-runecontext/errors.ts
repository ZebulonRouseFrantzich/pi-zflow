/**
 * errors.ts — Custom error types for RuneContext operations.
 *
 * All RuneContext errors extend the base `RuneContextError` class
 * and carry a machine-readable `code` property for downstream error
 * handling (e.g. filtering, logging, or user-facing messages).
 *
 * @module pi-zflow-runecontext/errors
 */

// ── Base ─────────────────────────────────────────────────────────

/**
 * Base error for all RuneContext-related failures.
 *
 * Every subclass provides a `code` property that callers can use
 * to distinguish error types without relying on `name` or message
 * content. This enables robust error handling in test, CLI, and
 * integration contexts.
 */
export class RuneContextError extends Error {
  /**
   * @param message - Human-readable error description.
   * @param code    - Machine-readable error code (e.g. "MISSING_REQUIRED_FILE").
   */
  constructor(message: string, public readonly code: string) {
    super(message)
    this.name = "RuneContextError"
  }
}

// ── Specific error types ────────────────────────────────────────

/**
 * Thrown when a required file is missing from the detected RuneContext
 * change flavor (plain or verified).
 *
 * Provides the filename and the expected absolute path so the caller
 * can surface a precise, actionable error message.
 */
export class MissingRequiredFileError extends RuneContextError {
  /**
   * @param file     - Relative filename that is missing (e.g. "design.md").
   * @param filePath - Absolute path where the file was expected.
   */
  constructor(file: string, filePath: string) {
    super(
      `Missing required RuneContext change file: "${file}" ` +
        `(expected at ${filePath})`,
      "MISSING_REQUIRED_FILE",
    )
    this.name = "MissingRequiredFileError"
  }
}

/**
 * Thrown when no RuneContext change folder can be resolved.
 *
 * This covers both ambient CWD-walking that finds no marker and
 * explicit paths that are not valid change folders.
 */
export class ChangeResolutionError extends RuneContextError {
  /**
   * @param message - Description of the resolution failure.
   */
  constructor(message: string) {
    super(message, "CHANGE_RESOLUTION_FAILED")
    this.name = "ChangeResolutionError"
  }
}

/**
 * Thrown when the `status.yaml` schema is ambiguous or unrecognized
 * and cannot be reliably interpreted.
 */
export class AmbiguousStatusError extends RuneContextError {
  /**
   * @param message - Description of the status ambiguity.
   */
  constructor(message: string) {
    super(message, "AMBIGUOUS_STATUS")
    this.name = "AmbiguousStatusError"
  }
}

/**
 * Thrown when RuneContext detection finds conflicting signals
 * (e.g. multiple detection sources disagree).
 */
export class DetectionConflictError extends RuneContextError {
  /**
   * @param message - Description of the detection conflict.
   */
  constructor(message: string) {
    super(message, "DETECTION_CONFLICT")
    this.name = "DetectionConflictError"
  }
}
