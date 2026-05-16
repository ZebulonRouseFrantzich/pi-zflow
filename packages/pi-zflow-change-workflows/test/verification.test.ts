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
  void it("captures stdout and stderr when shell verification passes", async () => {
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

  void it("captures stdout and stderr when shell verification fails", async () => {
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

  void it("captures stdout and stderr when argv verification passes", async () => {
    const { repoRoot, cleanup } = withTempRepo()
    try {
      const result = await runVerification(
        { command: "node", args: ["-e", "console.log('argv-ok')"] },
        repoRoot,
      )

      assert.equal(result.pass, true)
      assert.match(result.output, /argv-ok/)
      assert.equal(result.error, undefined)
    } finally {
      cleanup()
    }
  })

  void it("captures stdout and stderr when argv verification fails", async () => {
    const { repoRoot, cleanup } = withTempRepo()
    try {
      const result = await runVerification(
        { command: "node", args: ["-e", "process.exit(3)"] },
        repoRoot,
      )

      assert.equal(result.pass, false)
      assert.match(result.error ?? "", /exit code 3/)
    } finally {
      cleanup()
    }
  })

  void it("treats shell metacharacters in argv args as literal text (no shell interpretation)", async () => {
    const { repoRoot, cleanup } = withTempRepo()
    try {
      // Pass a semicolon as a literal argument — if it went through a shell
      // the semicolon would separate commands.  spawnSync keeps it literal.
      const result = await runVerification(
        { command: "node", args: ["-e",
          "const sep = process.argv[1]; console.log('literal:', JSON.stringify(sep))",
          "; echo 'this-should-not-run'"] },
        repoRoot,
      )

      assert.equal(result.pass, true)
      // The semicolon should appear literally, not cause a second command
      assert.match(result.output, /"; echo/)
      // Only the intended output should be present
      assert.match(result.output, /literal:/)
    } finally {
      cleanup()
    }
  })

  void it("serialises argv commands to a human-readable display string", async () => {
    const { repoRoot, cleanup } = withTempRepo()
    try {
      const result = await runVerification(
        { command: "node", args: ["-e", "true"] },
        repoRoot,
      )

      assert.match(result.command, /^node -e true$/)
    } finally {
      cleanup()
    }
  })
})
