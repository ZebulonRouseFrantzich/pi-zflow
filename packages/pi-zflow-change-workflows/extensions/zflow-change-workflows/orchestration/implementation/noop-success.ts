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

export function isNoEditImplementationGuardError(error?: string): boolean {
  return Boolean(error?.includes(NO_EDIT_IMPLEMENTATION_ERROR))
}

export function looksLikeAlreadyImplementedSummary(output?: string): boolean {
  if (!output) return false
  return ALREADY_IMPLEMENTED_PATTERNS.some((pattern) => pattern.test(output))
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
  if (!verificationPassed) {
    return { accepted: false }
  }

  if (!looksLikeAlreadyImplementedSummary(candidate.rawOutput)) {
    return { accepted: false }
  }

  return {
    accepted: true,
    reason: "Implementation already present; scoped verification passed without additional edits.",
  }
}
