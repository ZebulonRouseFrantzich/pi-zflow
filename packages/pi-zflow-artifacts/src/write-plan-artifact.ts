/**
 * write-plan-artifact.ts — Planner artifact write tool (zflow_write_plan_artifact).
 *
 * ## Contract
 *
 * The `zflow_write_plan_artifact` tool is a narrow custom tool registered via
 * the Pi extension API. It is available ONLY to planner/replan agents whose
 * tool allowlist includes it (currently `zflow.planner-frontier`).
 *
 * ### Parameters
 *
 * | Field        | Type   | Validation                                       | Notes                                            |
 * |--------------|--------|--------------------------------------------------|--------------------------------------------------|
 * | `changeId`   | string | `assertSafeChangeId()` — kebab-case + hyphens    | Identifies the change uniquely                   |
 * | `planVersion`| string | Must match `/^v\d+$/` (e.g. "v1", "v2")          | Version label; replanning increments              |
 * | `artifact`   | string | One of: "design", "execution-groups", "standards", "verification" | The four mandatory plan artifact types |
 * | `content`    | string | Markdown body                                    | Full content of the artifact                     |
 *
 * ### Destination path
 *
 *   <runtime-state-dir>/plans/{changeId}/{planVersion}/{artifact}.md
 *
 * Resolved by `resolvePlanArtifactPath()` from `artifact-paths.ts`.
 *
 * ### Safety rules
 *
 * 1. **Path confinement** — The changeId and planVersion are validated before
 *    path construction. The resulting path must normalise under
 *    `<runtime-state-dir>/plans/{changeId}/{planVersion}/`. Path separators
 *    in `changeId`, `..` traversal, and arbitrary directory names in `artifact`
 *    are rejected.
 * 2. **Artifact type allowlist** — Only the four approved artifact kinds
 *    (`design`, `execution-groups`, `standards`, `verification`) are accepted.
 *    Any other value is rejected with a clear error.
 * 3. **Atomic write (temp file + rename)** — Content is written to a `.tmp`
 *    file first, then renamed to the target path. This prevents partial/corrupt
 *    writes from being visible.
 * 4. **Overwrite policy** — Only approved artifact `.md` files may be
 *    overwritten. Non-artifact files under `<runtime-state-dir>/plans/` are
 *    protected.
 * 5. **Metadata recording** — After a successful write, the artifact's
 *    SHA-256 hash and mtime are recorded in `plan-state.json` for drift
 *    detection and compaction recovery.
 * 6. **Role restriction (planner only)** — The tool only answers for agents
 *    that list `zflow_write_plan_artifact` in their frontmatter `tools:` field.
 *    Currently only `zflow.planner-frontier` has this tool.
 *
 * ### Pseudocode
 *
 * ```ts
 * function writePlanArtifact({ changeId, planVersion, artifact, content }) {
 *   assertSafeChangeId(changeId)                          // kebab-case only
 *   assert(/^v\d+$/.test(planVersion))                     // v1, v2, ...
 *   assert(["design", "execution-groups", "standards", "verification"].includes(artifact))
 *   const target = resolvePlanArtifactPath(changeId, planVersion, artifact)
 *   atomicWrite(target, content)                           // write .tmp → rename
 *   recordArtifactMetadata(changeId, planVersion, artifact, hash(content))
 * }
 * ```
 *
 * ### Related enforcement
 *
 * - Planner agents must NOT have `edit`, `write`, or mutation-capable `bash`
 *   in their `tools:` allowlist. This is enforced by the agent frontmatter.
 * - Implementers must NOT write to plan artifact paths. The path guard
 *   (`pi-zflow-core/path-guard`) enforces this with intent-based checks:
 *   planner-artifact writes are gated by `intent: "planner-artifact"`,
 *   implementation writes by `intent: "write"`.
 *
 * @module pi-zflow-artifacts/write-plan-artifact
 */

export {}

