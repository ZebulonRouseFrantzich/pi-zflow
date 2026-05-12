/**
 * path-guard.ts — Change-workflows path guard stubs.
 *
 * **Phase 0 placeholder.**
 * The full path-guard extension integration will be implemented in Phase 7
 * (`/zflow-change-implement`, `/zflow-clean`).
 *
 * When implemented, this module will:
 *
 *   1. Load the `SentinelPolicy` from the repo's pi-zflow config.
 *   2. Call `canWrite()` before every file write, edit, or destructive
 *      bash command during `/zflow-change-implement`.
 *   3. Block denied writes with actionable error messages.
 *   4. Log soft-blocked writes as warnings.
 *
 * ## Consumption contract
 *
 * ```ts
 * import { canWrite, type SentinelPolicy, type PathGuardContext } from "pi-zflow-core/path-guard"
 *
 * function guardWrite(targetPath: string, intent: WriteIntent): void {
 *   const policy: SentinelPolicy = loadPolicy()   // Phase 7
 *   const context: PathGuardContext = {
 *     policy,
 *     projectRoot: resolveProjectRoot(),
 *     runtimeStateDir: resolveRuntimeStateDir(),
 *     intent,
 *   }
 *   const result = canWrite(targetPath, context)
 *   if (!result.allowed) throw new Error(result.message)
 * }
 * ```
 *
 * See `docs/path-guard-policy.md` for the full design.
 *
 * @module pi-zflow-change-workflows/path-guard
 */

export {}
