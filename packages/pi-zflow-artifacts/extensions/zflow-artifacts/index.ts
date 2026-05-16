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
 *   Planner agents must NOT have `edit` or `write` in their frontmatter
 *   `tools:` field. They may have `bash` for read-only exploration (e.g.
 *   `ls`, `grep`, `find`, `cat`); plan-mode enforcement at runtime blocks
 *   write/delete operations via bash policy.
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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { getZflowRegistry } from "pi-zflow-core/registry"
import { PI_ZFLOW_ARTIFACTS_VERSION } from "pi-zflow-core"
import { writePlanArtifact } from "../../src/write-plan-artifact.js"
import type { CapabilityClaim } from "pi-zflow-core/registry"

/** Well-known capability name for artifact write support. */
const ARTIFACTS_CAPABILITY = "artifacts" as const

export default function activateZflowArtifactsExtension(pi: ExtensionAPI): void {
  const registry = getZflowRegistry()

  // ── Claim the capability ──────────────────────────────────────
  const claim: CapabilityClaim = {
    capability: ARTIFACTS_CAPABILITY,
    version: PI_ZFLOW_ARTIFACTS_VERSION,
    provider: "pi-zflow-artifacts",
    sourcePath: import.meta.url,
    compatibilityMode: "compatible",
  }

  const registered = registry.claim(claim)

  // If claim returns null, an incompatible provider already owns this
  // capability -- do not register anything.
  if (!registered) {
    return
  }

  // If the capability already has a service, another compatible
  // instance already initialised fully. No-op to avoid duplicate registration.
  if (registered.service !== undefined) {
    return
  }

  // ── Provide the artifact service ──────────────────────────────
  const artifactService = {
    writePlanArtifact,
  }

  registry.provide(ARTIFACTS_CAPABILITY, artifactService)

  // ── Register zflow_write_plan_artifact tool ───────────────────
  pi.registerTool({
    name: "zflow_write_plan_artifact",
    label: "Write Plan Artifact",
    description:
      "Write a plan artifact (design, execution-groups, standards, or verification) " +
      "for a given change and plan version. Validates parameters, resolves the target " +
      "path under the runtime state directory, writes atomically via temp-file-then-rename, " +
      "and records content hash + mtime in plan-state.json for drift detection.",
    parameters: Type.Object({
      changeId: Type.String({
        description:
          "Change identifier in kebab-case (lowercase letters, digits, and hyphens only). " +
          "Must be a non-empty string matching [a-z0-9][a-z0-9-]*.",
      }),
      planVersion: Type.String({
        description:
          "Plan version label (e.g. 'v1', 'v2'). Must match the pattern /^v\\d+$/.",
      }),
      artifact: Type.String({
        description:
          "Artifact type to write. One of: design, execution-groups, standards, verification.",
      }),
      content: Type.String({
        description:
          "Full markdown content of the artifact. Written atomically to the resolved target path.",
      }),
    }),
    promptSnippet: "zflow_write_plan_artifact(changeId, planVersion, artifact, content) — write a plan artifact file",
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const result = await writePlanArtifact(
        {
          changeId: params.changeId,
          planVersion: params.planVersion,
          artifact: params.artifact,
          content: params.content,
        },
        ctx.cwd,
      )

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
        details: result,
      }
    },
  })
}