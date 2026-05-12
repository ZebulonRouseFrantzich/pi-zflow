/**
 * bash-policy.ts — Plan-mode restricted bash policy stubs.
 *
 * **Phase 0 placeholder.**
 * The full bash-policy integration will be implemented in Phase 2
 * (`/zflow-plan`, `/zflow-plan status`, `/zflow-plan exit`).
 *
 * When implemented, this module will:
 *
 *   1. Intercept bash tool calls during planning mode.
 *   2. Parse commands to extract write targets (mv, cp, rm, redirects, etc.).
 *   3. Call `canWrite()` for each write target with `intent: "planner-artifact"`.
 *   4. Block denied write targets with actionable error messages.
 *   5. Allow read-only commands (cat, ls, grep, find, etc.) without restriction.
 *
 * ## Consumption contract
 *
 * ```ts
 * import { canWrite, type SentinelPolicy } from "pi-zflow-core/path-guard"
 *
 * function applyBashPolicy(command: string, policy: SentinelPolicy): BashPolicyResult {
 *   const writeTargets = parseWriteTargets(command)   // Phase 2
 *   const denied = writeTargets.filter(target => !canWrite(target, { ... }))
 *   if (denied.length > 0) {
 *     return { allowed: false, denied }
 *   }
 *   return { allowed: true }
 * }
 * ```
 *
 * See `docs/path-guard-policy.md` for the full design.
 *
 * @module pi-zflow-plan-mode/bash-policy
 */

export {}
