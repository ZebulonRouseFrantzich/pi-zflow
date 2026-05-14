/**
 * verification.test.ts — Verification command execution tests.
 *
 * @module pi-zflow-change-workflows/test/verification
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { runVerification } from "../extensions/zflow-change-workflows/verification.js"

function withTempRepo(): { repoRoot: string; cleanup: () => void } {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "zflow-verification-test-"))
  return {
    repoRoot,
    cleanup: () => rmSync(repoRoot, { recursive: true, force: true }),
  }
}

void describe("runVerification", () => {
  void it("captures stdout and stderr when verification passes", async () => {
    const { repoRoot, cleanup } = withTempRepo()
    try {
      const result = await runVerification(
        "printf 'stdout-ok'; printf 'stderr-ok' >&2",
        repoRoot,
      )

      assert.equal(result.pass, true)
      assert.match(result.output, /stdout-ok/)
      assert.match(result.output, /stderr-ok/)
      assert.equal(result.error, undefined)
    } finally {
      cleanup()
    }
  })

  void it("captures stdout and stderr when verification fails", async () => {
    const { repoRoot, cleanup } = withTempRepo()
    try {
      const result = await runVerification(
        "printf 'stdout-fail'; printf 'stderr-fail' >&2; exit 7",
        repoRoot,
      )

      assert.equal(result.pass, false)
      assert.match(result.output, /stdout-fail/)
      assert.match(result.output, /stderr-fail/)
      assert.match(result.error ?? "", /exit code 7/)
    } finally {
      cleanup()
    }
  })
})
