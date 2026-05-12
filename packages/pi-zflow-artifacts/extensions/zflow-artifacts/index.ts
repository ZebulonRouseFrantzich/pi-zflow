/**
 * pi-zflow-artifacts extension entrypoint
 *
 * Registers the `zflow_write_plan_artifact` tool and runtime path helpers.
 *
 * ## Tool registration contract: zflow_write_plan_artifact
 *
 * When the tool is registered (Phase 2+), it must:
 *
 * 1. Use `getZflowRegistry()` to claim the "artifacts" capability before
 *    registering the tool. If "artifacts" is already claimed by a compatible
 *    provider, no-op. If claimed by an incompatible provider, emit a clear
 *    diagnostic and do not register.
 * 2. Register the tool via the Pi extension API (platform-dependent — see
 *    `@earendil-works/pi-coding-agent` docs).
 * 3. Accept the four contract parameters: `changeId`, `planVersion`,
 *    `artifact`, `content`.
 * 4. Validate with `assertSafeChangeId()`, `assert(/^v\d+$/.test(planVersion))`,
 *    and allowlist check for artifact type.
 * 5. Resolve the target via `resolvePlanArtifactPath()` and write atomically
 *    with temp-file-then-rename.
 * 6. Record hash + mtime in plan-state.json via `recordArtifactMetadata()`.
 * 7. Return a stable `details` shape: `{ ok: boolean, path: string,
 *    artifact: string, hash: string, mtime: number }`.
 *
 * ## Safety invariants
 *
 * - The tool is the ONLY write mechanism available to planner agents.
 *   Planner agents must NOT have `edit`, `write`, or `bash` in their
 *   frontmatter `tools:` field.
 * - The tool participates in Pi's file mutation queue when the platform
 *   supports it.
 * - The registered tool name is `zflow_write_plan_artifact`.
 *
 * ## Path guard integration
 *
 * The tool uses `canWrite()` from `pi-zflow-core/path-guard` with
 * `intent: "planner-artifact"` to verify that the resolved target is within
 * the allowed plan artifact path. This is separate from the
 * `intent: "write"` used by implementers.
 *
 * See `README.md` for the full tool contract.
 * See `src/write-plan-artifact.ts` for the implementation contract.
 * See `src/artifact-paths.ts` for `resolvePlanArtifactPath()`.
 */
import type { Extension } from "@earendil-works/pi-coding-agent"

const extension: Extension = {
  name: "pi-zflow-artifacts",
  version: "0.1.0",
  activate() {
    // Phase 2+:
    //   1. const registry = getZflowRegistry()
    //   2. registry.claim({ capability: "artifacts", version: "0.1.0", provider: "pi-zflow-artifacts" })
    //   3. Register zflow_write_plan_artifact tool
    //   4. registry.provide("artifacts", artifactService)
    //
    // See src/state-index.ts, src/plan-state.ts, src/run-state.ts,
    // src/cleanup-metadata.ts, src/write-plan-artifact.ts
  },
}

export default extension
