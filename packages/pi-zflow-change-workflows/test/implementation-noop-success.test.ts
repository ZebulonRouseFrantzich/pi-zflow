import * as assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  acceptImplementationNoopResult,
  isNoEditImplementationGuardError,
  looksLikeAlreadyImplementedSummary,
} from "../extensions/zflow-change-workflows/orchestration/implementation/noop-success.js"

describe("implementation noop-success helpers", () => {
  test("detects the implementation no-edit guard message", () => {
    assert.equal(
      isNoEditImplementationGuardError(
        "Subagent completed without making edits for an implementation task.\nIt appears to have returned planning or scratchpad output instead of applying changes.",
      ),
      true,
    )
    assert.equal(isNoEditImplementationGuardError("unknown agent"), false)
  })

  test("recognizes already-implemented summaries", () => {
    assert.equal(
      looksLikeAlreadyImplementedSummary("Already implemented and fully verified. No changes needed."),
      true,
    )
    assert.equal(
      looksLikeAlreadyImplementedSummary("I inspected the repo and wrote a plan."),
      false,
    )
  })

  test("accepts no-edit results when verification passed and output confirms work already exists", () => {
    const accepted = acceptImplementationNoopResult({
      ok: false,
      error: "Subagent completed without making edits for an implementation task.\nIt appears to have returned planning or scratchpad output instead of applying changes.",
      rawOutput: "All implementation and verification for Group G1 is complete. Already implemented and fully verified. No changes needed.",
      verification: {
        status: "pass",
        command: "yarn jest --runInBand logic/tests/licenseManager.oracleEntitlements.test.ts",
      },
    })

    assert.equal(accepted.accepted, true)
    assert.match(accepted.reason ?? "", /already present/i)
  })

  test("accepts no-edit results when output itself contains strong verification evidence", () => {
    const accepted = acceptImplementationNoopResult({
      ok: false,
      error: "Subagent completed without making edits for an implementation task.\nIt appears to have returned planning or scratchpad output instead of applying changes.",
      rawOutput: [
        "All implementation and verification for Group G1 is complete.",
        "",
        "**Result:** Already implemented and fully verified. No changes needed.",
        "",
        "## Verification results",
        "| 1 | `yarn jest --runInBand logic/tests/licenseManager.oracleEntitlements.test.ts` | **PASS** — 11/11 tests pass |",
        "| 2 | `yarn tsc-all` | **PASS** — All functionapps compile cleanly |",
      ].join("\n"),
    })

    assert.equal(accepted.accepted, true)
  })

  test("rejects no-edit results without passing verification", () => {
    const accepted = acceptImplementationNoopResult({
      ok: false,
      error: "Subagent completed without making edits for an implementation task.\nIt appears to have returned planning or scratchpad output instead of applying changes.",
      rawOutput: "Already implemented and fully verified. No changes needed.",
      verification: {
        status: "skipped",
      },
    })

    assert.equal(accepted.accepted, false)
  })
})
