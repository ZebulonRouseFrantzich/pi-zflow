import * as assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  buildFixWorkerWorktreeStrategy,
  extractFixVerificationCommand,
  mergeSuccessfulFixResult,
  selectCanonicalGroupPatchPath,
} from "../extensions/zflow-change-workflows/fix-dispatch.js"

describe("fix-dispatch helpers", () => {
  test("extractFixVerificationCommand returns undefined for missing or placeholder commands", () => {
    assert.equal(extractFixVerificationCommand({ verification: undefined }), undefined)
    assert.equal(extractFixVerificationCommand({ verification: { status: "fail", command: "   " } }), undefined)
  })

  test("extractFixVerificationCommand trims a real command", () => {
    assert.equal(
      extractFixVerificationCommand({ verification: { status: "fail", command: "  npm test -- auth  " } }),
      "npm test -- auth",
    )
  })

  test("buildFixWorkerWorktreeStrategy preserves the original base commit", () => {
    assert.deepEqual(
      buildFixWorkerWorktreeStrategy({ baseCommit: "abc123" }),
      { mode: "isolated", baseRef: "abc123" },
    )
    assert.equal(buildFixWorkerWorktreeStrategy({ baseCommit: undefined }), undefined)
  })

  test("mergeSuccessfulFixResult promotes the fix result as the canonical output", () => {
    const merged = mergeSuccessfulFixResult(
      {
        agent: "zflow.implement-routine",
        groupId: "group-1",
        rawOutput: "original",
        ok: false,
        error: "verification failed",
        patchPath: "/tmp/original.patch",
        changedFiles: ["src/original.ts"],
        baseCommit: "base-a",
        headCommit: "head-a",
        verification: { status: "fail", command: "npm test", output: "boom" },
      },
      {
        agent: "zflow.implement-routine",
        groupId: "group-1",
        rawOutput: "fixed",
        ok: true,
        patchPath: "/tmp/fix.patch",
        changedFiles: ["src/fixed.ts"],
        worktreePath: "/tmp/worktree-fix",
        baseCommit: "base-b",
        headCommit: "head-b",
        verification: { status: "pass", command: "npm test", output: "ok" },
      },
    )

    assert.equal(merged.ok, true)
    assert.equal(merged.error, undefined)
    assert.equal(merged.rawOutput, "fixed")
    assert.equal(merged.patchPath, "/tmp/fix.patch")
    assert.deepEqual(merged.changedFiles, ["src/fixed.ts"])
    assert.equal(merged.worktreePath, "/tmp/worktree-fix")
    assert.equal(merged.baseCommit, "base-b")
    assert.equal(merged.headCommit, "head-b")
    assert.equal(merged.verification?.status, "pass")
  })

  test("selectCanonicalGroupPatchPath prefers a succeeded fix patch", () => {
    assert.equal(
      selectCanonicalGroupPatchPath({
        patchPath: "/tmp/original.patch",
        fixPatchPath: "/tmp/fix.patch",
        fixResult: "succeeded",
      }),
      "/tmp/fix.patch",
    )
    assert.equal(
      selectCanonicalGroupPatchPath({
        patchPath: "/tmp/original.patch",
        fixPatchPath: "/tmp/fix.patch",
        fixResult: "failed",
      }),
      "/tmp/original.patch",
    )
  })
})
