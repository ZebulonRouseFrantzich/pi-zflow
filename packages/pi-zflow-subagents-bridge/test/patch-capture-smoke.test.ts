// Import check for patch-capture-regression dependencies
import { test } from "node:test"
import * as assert from "node:assert/strict"
import {
  writePatchFromRange,
  captureCompatPatchAgainstBase,
  validatePatchFile,
} from "../extensions/zflow-subagents-bridge/index.js"

test("bridge module exports patch-capture functions", () => {
  assert.equal(typeof writePatchFromRange, "function")
  assert.equal(typeof captureCompatPatchAgainstBase, "function")
  assert.equal(typeof validatePatchFile, "function")
})
