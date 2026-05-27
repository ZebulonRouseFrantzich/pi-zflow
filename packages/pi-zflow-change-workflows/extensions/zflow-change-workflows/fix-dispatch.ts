import type { ParallelTaskResult, TaskWorktreeStrategy } from "pi-zflow-core/dispatch-service"

export type FixDispatchResult = ParallelTaskResult

export interface CanonicalPatchSource {
  patchPath?: string
  fixPatchPath?: string
  fixResult?: string
}

export function extractFixVerificationCommand(
  result: Pick<FixDispatchResult, "verification">,
): string | undefined {
  const command = result.verification?.command?.trim()
  return command ? command : undefined
}

export function buildFixWorkerWorktreeStrategy(
  result: Pick<FixDispatchResult, "baseCommit">,
): TaskWorktreeStrategy | undefined {
  const baseRef = result.baseCommit?.trim()
  if (!baseRef) return undefined
  return {
    mode: "isolated",
    baseRef,
  }
}

export function mergeSuccessfulFixResult(
  original: FixDispatchResult,
  fixResult?: FixDispatchResult,
): FixDispatchResult {
  if (!fixResult) {
    return {
      ...original,
      ok: true,
      error: undefined,
    }
  }

  return {
    ...original,
    ...fixResult,
    ok: true,
    error: undefined,
    verification: fixResult.verification ?? original.verification,
    worktreePath: fixResult.worktreePath ?? original.worktreePath,
    baseCommit: fixResult.baseCommit ?? original.baseCommit,
    headCommit: fixResult.headCommit ?? original.headCommit,
    patchPath: fixResult.patchPath ?? original.patchPath,
    changedFiles: fixResult.changedFiles ?? original.changedFiles,
  }
}

export function selectCanonicalGroupPatchPath(
  source: CanonicalPatchSource | undefined,
): string | undefined {
  if (!source) return undefined
  if (source.fixResult === "succeeded" && source.fixPatchPath) return source.fixPatchPath
  return source.patchPath ?? source.fixPatchPath
}
