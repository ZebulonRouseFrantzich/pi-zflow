/**
 * write-plan-artifact.ts — Planner artifact write tool (zflow_write_plan_artifact).
 *
 * **Phase 1 placeholder.**
 * The full write-plan-artifact implementation will be part of Phase 2+ when
 * the planner workflow is built.
 *
 * TODO(phase-2): Implement zflow_write_plan_artifact tool.
 *   - Register as a Pi custom tool via the Pi extension API
 *   - Only allow writes under `<runtime-state-dir>/plans/{changeId}/v{n}/`
 *   - Use canWrite() from pi-zflow-core/path-guard with intent: "planner-artifact"
 *   - Atomic write (write to .tmp, then rename)
 *   - Return stable details shape for rendering/state reconstruction
 *   - Participate in Pi's file mutation queue
 *
 * @module pi-zflow-artifacts/write-plan-artifact
 */

export {}
