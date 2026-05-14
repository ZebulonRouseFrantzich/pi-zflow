/**
 * artifact-paths.test.ts — Unit tests for artifact-paths.ts cwd propagation.
 */
import * as assert from "node:assert"
import { test, describe } from "node:test"
import * as path from "node:path"
import * as os from "node:os"
import { createHash } from "node:crypto"

import {
  resolveChangeDir,
  resolvePlanDir,
  resolvePlanVersionDir,
  resolvePlanArtifactPath,
  resolvePlanStatePath,
} from "../src/artifact-paths.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stableHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12)
}

/**
 * Compute the expected runtime state dir for a non-git cwd.
 * Duplicates resolveRuntimeStateDir logic without importing private function.
 */
function expectedRuntimeDir(cwd: string): string {
  return path.join(os.tmpdir(), `pi-zflow-${stableHash(cwd)}`)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("artifact-paths cwd propagation", () => {
  /**
   * Use a temporary directory outside any git repo as the fake cwd.
   * The directory need not exist — resolveRuntimeStateDir only calls
   * `git rev-parse --git-dir` which will fail for non-repo dirs,
   * causing it to fall through to the hash-based tmpdir path.
   */
  const testCwd = path.join(os.tmpdir(), "pi-zflow-artifact-paths-test-cwd")
  const otherCwd = path.join(os.tmpdir(), "pi-zflow-artifact-paths-test-other")
  const runtimeDir = expectedRuntimeDir(testCwd)
  const otherRuntimeDir = expectedRuntimeDir(otherCwd)

  const changeId = "ch42"
  const version = "3"
  const planVersion = "v3"

  test("resolveChangeDir uses cwd parameter", () => {
    const result = resolveChangeDir(changeId, testCwd)
    const expected = path.join(runtimeDir, "plans", changeId)
    assert.equal(result, expected)

    // Different cwd produces different path
    const otherResult = resolveChangeDir(changeId, otherCwd)
    assert.notEqual(result, otherResult)
  })

  test("resolvePlanDir uses cwd parameter", () => {
    const result = resolvePlanDir(changeId, version, testCwd)
    const expected = path.join(runtimeDir, "plans", changeId, `v${version}`)
    assert.equal(result, expected)

    // Different cwd produces different path
    const otherResult = resolvePlanDir(changeId, version, otherCwd)
    assert.notEqual(result, otherResult)
  })

  test("resolvePlanVersionDir uses cwd parameter", () => {
    const result = resolvePlanVersionDir(changeId, planVersion, testCwd)
    const expected = path.join(runtimeDir, "plans", changeId, "v3")
    assert.equal(result, expected)

    const otherResult = resolvePlanVersionDir(changeId, planVersion, otherCwd)
    assert.notEqual(result, otherResult)
  })

  test("resolvePlanArtifactPath uses cwd parameter", () => {
    const result = resolvePlanArtifactPath(changeId, planVersion, "design", testCwd)
    const expected = path.join(runtimeDir, "plans", changeId, "v3", "design.md")
    assert.equal(result, expected)

    const otherResult = resolvePlanArtifactPath(changeId, planVersion, "design", otherCwd)
    assert.notEqual(result, otherResult)
  })

  test("resolvePlanStatePath uses cwd parameter", () => {
    const result = resolvePlanStatePath(changeId, testCwd)
    const expected = path.join(runtimeDir, "plans", changeId, "plan-state.json")
    assert.equal(result, expected)

    const otherResult = resolvePlanStatePath(changeId, otherCwd)
    assert.notEqual(result, otherResult)
  })

  test("resolvePlanDir without cwd defaults to process.cwd()", () => {
    // When no cwd given, resolveRuntimeStateDir uses process.cwd()
    const noCwdResult = resolvePlanDir(changeId, version)
    const withCwdResult = resolvePlanDir(changeId, version, process.cwd())
    assert.equal(noCwdResult, withCwdResult)
  })

  test("resolvePlanStatePath without cwd defaults to process.cwd()", () => {
    const noCwdResult = resolvePlanStatePath(changeId)
    const withCwdResult = resolvePlanStatePath(changeId, process.cwd())
    assert.equal(noCwdResult, withCwdResult)
  })
})
