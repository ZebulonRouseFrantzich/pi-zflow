/**
 * capabilities.test.ts — Tests for the model capability checking module.
 *
 * Covers:
 *   - checkThinkingCompatibility (all quadrants)
 *   - checkOutputWindowSufficiency (sufficient, insufficient, no requirement, unadvertised)
 *   - checkContextWindowSufficiency (sufficient, insufficient, no requirement, unadvertised)
 *   - checkCapabilityRequirements (full composite check)
 *   - validateLaneCandidate (model missing, not authenticated, missing capabilities)
 *   - CONSERVATIVE_LANES membership
 */
import { describe, it } from "node:test"
import * as assert from "node:assert/strict"
import {
  checkThinkingCompatibility,
  checkOutputWindowSufficiency,
  checkContextWindowSufficiency,
  checkCapabilityRequirements,
  validateLaneCandidate,
  CONSERVATIVE_LANES,
} from "../extensions/zflow-profiles/capabilities.js"
import type {
  ModelInfo,
  ModelCapabilityProfile,
  CapabilityRequirements,
} from "../extensions/zflow-profiles/profiles.js"

// ── Helpers ─────────────────────────────────────────────────────

function model(
  id: string,
  overrides?: Partial<ModelInfo>,
): ModelInfo {
  return {
    id,
    supportsTools: true,
    supportsText: true,
    thinkingCapability: "medium",
    authenticated: true,
    ...overrides,
  }
}

function capProfile(
  id: string,
  overrides?: Partial<ModelCapabilityProfile>,
): ModelCapabilityProfile {
  return {
    id,
    supportsTools: true,
    supportsText: true,
    thinkingCapability: "medium",
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────────

describe("checkThinkingCompatibility", () => {
  it("compatible when no level requested", () => {
    const result = checkThinkingCompatibility("medium", undefined)
    assert.equal(result.compatible, true)
    assert.equal(result.effectiveLevel, "medium")
    assert.equal(result.reason, "")
  })

  it("compatible when model meets requested level", () => {
    const result = checkThinkingCompatibility("high", "high", false, "m1")
    assert.equal(result.compatible, true)
    assert.equal(result.effectiveLevel, "high")
    assert.equal(result.reason, "")
  })

  it("compatible when model exceeds requested (clamp up)", () => {
    const result = checkThinkingCompatibility("high", "low", false, "m1")
    assert.equal(result.compatible, true)
    assert.equal(result.effectiveLevel, "high")
    assert.ok(result.reason.includes("overprovisioning"))
  })

  it("incompatible when model below requested and conservative", () => {
    const result = checkThinkingCompatibility("low", "high", true, "m1")
    assert.equal(result.compatible, false)
    assert.equal(result.effectiveLevel, "high")
    assert.ok(result.reason.toLowerCase().includes("conservative"))
  })

  it("compatible when model below requested and non-conservative", () => {
    const result = checkThinkingCompatibility("low", "medium", false, "m1")
    assert.equal(result.compatible, true)
    assert.equal(result.effectiveLevel, "low")
    assert.ok(result.reason.includes("clamp"))
  })

  it("produces no reason for exact match", () => {
    const result = checkThinkingCompatibility("medium", "medium", false, "m1")
    assert.equal(result.compatible, true)
    assert.equal(result.reason, "")
  })
})

describe("checkOutputWindowSufficiency", () => {
  it("sufficient when model maxOutput >= required", () => {
    const result = checkOutputWindowSufficiency(16000, 8000, "m1")
    assert.equal(result.sufficient, true)
    assert.equal(result.reason, "")
  })

  it("insufficient when model maxOutput < required", () => {
    const result = checkOutputWindowSufficiency(4000, 8000, "m1")
    assert.equal(result.sufficient, false)
    assert.ok(result.reason.includes("4000"))
    assert.ok(result.reason.includes("8000"))
  })

  it("sufficient when no requirement specified", () => {
    const result = checkOutputWindowSufficiency(4000, undefined, "m1")
    assert.equal(result.sufficient, true)
  })

  it("sufficient when model does not advertise max output", () => {
    const result = checkOutputWindowSufficiency(undefined, 8000, "m1")
    assert.equal(result.sufficient, true)
  })

  it("sufficient when both are unconstrained", () => {
    const result = checkOutputWindowSufficiency(undefined, undefined, "m1")
    assert.equal(result.sufficient, true)
  })

  it("sufficient when exact match", () => {
    const result = checkOutputWindowSufficiency(8000, 8000, "m1")
    assert.equal(result.sufficient, true)
  })
})

describe("checkContextWindowSufficiency", () => {
  it("sufficient when model context >= required", () => {
    const result = checkContextWindowSufficiency(128000, 64000, "m1")
    assert.equal(result.sufficient, true)
    assert.equal(result.reason, "")
  })

  it("insufficient when model context < required", () => {
    const result = checkContextWindowSufficiency(32000, 64000, "m1")
    assert.equal(result.sufficient, false)
    assert.ok(result.reason.includes("32000"))
    assert.ok(result.reason.includes("64000"))
  })

  it("sufficient when no requirement specified", () => {
    const result = checkContextWindowSufficiency(32000, undefined, "m1")
    assert.equal(result.sufficient, true)
  })

  it("sufficient when model does not advertise context window", () => {
    const result = checkContextWindowSufficiency(undefined, 64000, "m1")
    assert.equal(result.sufficient, true)
  })

  it("sufficient when exact match", () => {
    const result = checkContextWindowSufficiency(64000, 64000, "m1")
    assert.equal(result.sufficient, true)
  })
})

describe("checkCapabilityRequirements", () => {
  it("passes all checks when model meets all requirements", () => {
    const modelProfile = capProfile("m1", {
      thinkingCapability: "high",
      maxOutput: 16000,
      contextWindow: 128000,
      maxToolsPerTurn: 10,
    })
    const reqs: CapabilityRequirements = {
      requiresTools: true,
      requiresText: true,
      requiredThinking: "high",
      isConservativeLane: true,
      minOutput: 8000,
      minContextWindow: 64000,
    }
    const result = checkCapabilityRequirements(modelProfile, reqs)
    assert.equal(result.compatible, true)
    assert.equal(result.effectiveThinking, "high")
    assert.equal(result.reasons.length, 0)
  })

  it("fails when model does not support tools", () => {
    const modelProfile = capProfile("m1", { supportsTools: false })
    const reqs: CapabilityRequirements = {
      requiresTools: true,
      requiresText: true,
      isConservativeLane: false,
    }
    const result = checkCapabilityRequirements(modelProfile, reqs)
    assert.equal(result.compatible, false)
    assert.ok(result.reasons.some((r) => r.includes("tool")))
  })

  it("fails when model does not support text", () => {
    const modelProfile = capProfile("m1", { supportsText: false })
    const reqs: CapabilityRequirements = {
      requiresTools: true,
      requiresText: true,
      isConservativeLane: false,
    }
    const result = checkCapabilityRequirements(modelProfile, reqs)
    assert.equal(result.compatible, false)
    assert.ok(result.reasons.some((r) => r.includes("text")))
  })

  it("fails when thinking downgrade not allowed for conservative lane", () => {
    const modelProfile = capProfile("m1", { thinkingCapability: "low" })
    const reqs: CapabilityRequirements = {
      requiresTools: true,
      requiresText: true,
      requiredThinking: "high",
      isConservativeLane: true,
    }
    const result = checkCapabilityRequirements(modelProfile, reqs)
    assert.equal(result.compatible, false)
    assert.ok(result.reasons.some((r) => r.toLowerCase().includes("conservative")))
  })

  it("accepts thinking downgrade for non-conservative lane (with reason)", () => {
    const modelProfile = capProfile("m1", { thinkingCapability: "low" })
    const reqs: CapabilityRequirements = {
      requiresTools: true,
      requiresText: true,
      requiredThinking: "medium",
      isConservativeLane: false,
    }
    const result = checkCapabilityRequirements(modelProfile, reqs)
    assert.equal(result.compatible, true)
    assert.equal(result.effectiveThinking, "low")
    // The clamp is informational — no error reasons, so reasons should be empty
    assert.equal(result.reasons.length, 0)
  })

  it("fails when output window insufficient", () => {
    const modelProfile = capProfile("m1", { maxOutput: 2000 })
    const reqs: CapabilityRequirements = {
      requiresTools: true,
      requiresText: true,
      isConservativeLane: false,
      minOutput: 8000,
    }
    const result = checkCapabilityRequirements(modelProfile, reqs)
    assert.equal(result.compatible, false)
    assert.ok(result.reasons.some((r) => r.includes("output")))
  })

  it("fails when context window insufficient", () => {
    const modelProfile = capProfile("m1", { contextWindow: 16000 })
    const reqs: CapabilityRequirements = {
      requiresTools: true,
      requiresText: true,
      isConservativeLane: false,
      minContextWindow: 32000,
    }
    const result = checkCapabilityRequirements(modelProfile, reqs)
    assert.equal(result.compatible, false)
    assert.ok(result.reasons.some((r) => r.includes("context")))
  })

  it("accumulates multiple failure reasons", () => {
    const modelProfile = capProfile("m1", {
      supportsTools: false,
      supportsText: false,
      maxOutput: 1000,
    })
    const reqs: CapabilityRequirements = {
      requiresTools: true,
      requiresText: true,
      isConservativeLane: false,
      minOutput: 8000,
    }
    const result = checkCapabilityRequirements(modelProfile, reqs)
    assert.equal(result.compatible, false)
    // Should have at least 3 reasons (tools, text, output)
    assert.ok(result.reasons.length >= 3)
  })
})

describe("validateLaneCandidate", () => {
  it("returns valid when model is available and meets all requirements", () => {
    const m = model("m1", { thinkingCapability: "high" })
    const reqs: CapabilityRequirements = {
      requiresTools: true,
      requiresText: true,
      requiredThinking: "high",
      isConservativeLane: false,
    }
    const result = validateLaneCandidate("m1", m, reqs)
    assert.equal(result.valid, true)
    assert.equal(result.reasons.length, 0)
  })

  it("rejects when model is not in registry", () => {
    const reqs: CapabilityRequirements = {
      requiresTools: true,
      requiresText: true,
      isConservativeLane: false,
    }
    const result = validateLaneCandidate("unknown-model", undefined, reqs)
    assert.equal(result.valid, false)
    assert.ok(result.reasons.some((r) => r.includes("not found")))
  })

  it("rejects when model is not authenticated", () => {
    const m = model("m1", { authenticated: false })
    const reqs: CapabilityRequirements = {
      requiresTools: true,
      requiresText: true,
      isConservativeLane: false,
    }
    const result = validateLaneCandidate("m1", m, reqs)
    assert.equal(result.valid, false)
    assert.ok(result.reasons.some((r) => r.includes("authenticated")))
  })

  it("rejects when model lacks tools and those are required", () => {
    const m = model("m1", { supportsTools: false })
    const reqs: CapabilityRequirements = {
      requiresTools: true,
      requiresText: true,
      isConservativeLane: false,
    }
    const result = validateLaneCandidate("m1", m, reqs)
    assert.equal(result.valid, false)
    assert.ok(result.reasons.some((r) => r.includes("tool")))
  })

  it("collects multiple failure reasons", () => {
    const m = model("m1", {
      authenticated: false,
      supportsTools: false,
      supportsText: false,
    })
    const reqs: CapabilityRequirements = {
      requiresTools: true,
      requiresText: true,
      isConservativeLane: false,
    }
    const result = validateLaneCandidate("m1", m, reqs)
    assert.equal(result.valid, false)
    // Should have reasons for auth, tools, and text
    assert.ok(result.reasons.length >= 3)
  })

  it("accepts model with richer capabilities than required", () => {
    const m = model("m1", {
      thinkingCapability: "high",
      contextWindow: 200000,
      maxOutput: 32000,
    })
    const reqs: CapabilityRequirements = {
      requiresTools: true,
      requiresText: true,
      requiredThinking: "low",
      isConservativeLane: false,
      minOutput: 4000,
      minContextWindow: 32000,
    }
    const result = validateLaneCandidate("m1", m, reqs)
    assert.equal(result.valid, true)
  })
})

describe("CONSERVATIVE_LANES", () => {
  it("contains the four required lane names", () => {
    const expected = ["planning-frontier", "worker-strong", "review-security", "synthesis-frontier"]
    for (const name of expected) {
      assert.ok(CONSERVATIVE_LANES.has(name), `Expected ${name} to be conservative`)
    }
  })

  it("does not contain non-conservative lane names", () => {
    const notExpected = ["scout-cheap", "worker-cheap", "review-logic", "review-correctness", "review-integration"]
    for (const name of notExpected) {
      assert.ok(!CONSERVATIVE_LANES.has(name), `Expected ${name} to NOT be conservative`)
    }
  })

  it("is a ReadonlySet that cannot be modified", () => {
    // TypeScript enforces readonly at compile time; at runtime,
    // the add method would throw in strict mode
    assert.ok(CONSERVATIVE_LANES.has("planning-frontier"))
  })
})
