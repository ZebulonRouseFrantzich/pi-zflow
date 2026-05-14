/**
 * Tests for pi-zflow-plan-mode state machine.
 *
 * @module pi-zflow-plan-mode/test/plan-mode-state
 */

import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"

import {
  getPlanModeStatus,
  activatePlanMode,
  deactivatePlanMode,
  isPlanModeActive,
  resetPlanMode,
} from "../extensions/zflow-plan-mode/state.js"
import type { PlanModeStatus } from "../extensions/zflow-plan-mode/state.js"

describe("plan-mode state", () => {
  beforeEach(() => {
    resetPlanMode()
  })

  it("starts inactive", () => {
    assert.equal(isPlanModeActive(), false)
    const status = getPlanModeStatus()
    assert.equal(status.state, "inactive")
    assert.equal(status.activatedAt, null)
    assert.equal(status.activationSource, null)
  })

  it("activate sets state to active with timestamp and source", () => {
    const status = activatePlanMode("zflow-plan")
    assert.equal(status.state, "active")
    assert.equal(status.activationSource, "zflow-plan")
    assert.ok(status.activatedAt, "activatedAt should be set")
    // Verify it's a valid ISO timestamp
    assert.doesNotThrow(() => new Date(status.activatedAt!))
  })

  it("isPlanModeActive returns true after activation", () => {
    activatePlanMode("test")
    assert.equal(isPlanModeActive(), true)
  })

  it("deactivatePlanMode resets to inactive", () => {
    activatePlanMode("test")
    deactivatePlanMode()
    assert.equal(isPlanModeActive(), false)
    const status = getPlanModeStatus()
    assert.equal(status.state, "inactive")
    assert.equal(status.activatedAt, null)
    assert.equal(status.activationSource, null)
  })

  it("activate while already active is a no-op", () => {
    const first = activatePlanMode("first")
    const second = activatePlanMode("second")
    // Should retain the first activation's details
    assert.equal(second.state, "active")
    assert.equal(second.activationSource, "first")
    assert.equal(second.activatedAt, first.activatedAt)
  })

  it("deactivate while already inactive is a no-op", () => {
    const status = deactivatePlanMode()
    assert.equal(status.state, "inactive")
  })

  it("resetPlanMode clears all state", () => {
    activatePlanMode("test")
    resetPlanMode()
    assert.equal(isPlanModeActive(), false)
    assert.equal(getPlanModeStatus().activatedAt, null)
  })

  it("getPlanModeStatus returns current snapshot", () => {
    activatePlanMode("zflow-plan")
    const status1 = getPlanModeStatus()
    assert.equal(status1.state, "active")

    deactivatePlanMode()
    const status2 = getPlanModeStatus()
    assert.equal(status2.state, "inactive")

    // status1 snapshot should still reflect old state (immutable return)
    assert.equal(status1.state, "active")
  })
})
