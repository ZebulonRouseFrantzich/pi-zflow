export interface ImplementationNoopCandidate {
  ok: boolean
  error?: string
  rawOutput?: string
  verification?: {
    status?: string
    command?: string
    output?: string
  }
}

export interface AcceptedImplementationNoop {
  accepted: boolean
  reason?: string
}

const NO_EDIT_IMPLEMENTATION_ERROR = "Subagent completed without making edits for an implementation task."

const ALREADY_IMPLEMENTED_PATTERNS = [
  /already implemented/i,
  /already complete/i,
  /fully verified/i,
  /no changes needed/i,
  /implementation(?:\s+and\s+verification)?\s+.*complete/i,
]

const VERIFICATION_EVIDENCE_PATTERNS = [
  /verification results/i,
  /\*\*PASS\*\*/i,
  /tests pass/i,
  /\btests?\s+passed\b/i,
  /test suites?:\s*\d+\s+passed/i,
  /compile cleanly/i,
]

export function isNoEditImplementationGuardError(error?: string): boolean {
  return Boolean(error?.includes(NO_EDIT_IMPLEMENTATION_ERROR))
}

export function looksLikeAlreadyImplementedSummary(output?: string): boolean {
  if (!output) return false
  return ALREADY_IMPLEMENTED_PATTERNS.some((pattern) => pattern.test(output))
}

export function looksLikeVerificationPassedEvidence(output?: string): boolean {
  if (!output) return false
  return VERIFICATION_EVIDENCE_PATTERNS.filter((pattern) => pattern.test(output)).length >= 2
}

export function acceptImplementationNoopResult(
  candidate: ImplementationNoopCandidate,
): AcceptedImplementationNoop {
  if (candidate.ok) {
    return { accepted: false }
  }
  if (!isNoEditImplementationGuardError(candidate.error)) {
    return { accepted: false }
  }

  const verificationStatus = candidate.verification?.status?.toLowerCase()
  const verificationPassed = verificationStatus === "pass" || verificationStatus === "passed"
  const outputShowsAlreadyImplemented = looksLikeAlreadyImplementedSummary(candidate.rawOutput)
  const outputShowsVerificationEvidence = looksLikeVerificationPassedEvidence(candidate.rawOutput)

  if (!outputShowsAlreadyImplemented) {
    return { accepted: false }
  }

  if (!verificationPassed && !outputShowsVerificationEvidence) {
    return { accepted: false }
  }

  return {
    accepted: true,
    reason: "Implementation already present; scoped verification passed without additional edits.",
  }
}

export function acceptAlreadyImplementedEvidenceResult(
  candidate: ImplementationNoopCandidate,
): AcceptedImplementationNoop {
  if (!looksLikeAlreadyImplementedSummary(candidate.rawOutput)) {
    return { accepted: false }
  }

  if (!looksLikeVerificationPassedEvidence(candidate.rawOutput)) {
    return { accepted: false }
  }

  return {
    accepted: true,
    reason: "Implementation already present; worker output includes strong verification evidence despite bridge-side verification failure.",
  }
}
