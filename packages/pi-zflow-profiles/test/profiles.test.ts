/**
 * profiles.test.ts — Tests for profile schema validation and normalization.
 *
 * Covers:
 *   - Valid profiles file (example.json)
 *   - Missing default profile
 *   - Agent binding references unknown lane
 *   - Lane with empty preferredModels
 *   - Lane with both required: true and optional: true
 *   - Invalid thinking level
 *   - Normalization of omitted flags
 *   - Normalization of explicit flags
 *   - Invalid JSON parsing
 */
import { describe, it } from "node:test"
import * as assert from "node:assert/strict"
import {
  validateProfilesFile,
  parseProfilesFile,
  parseProfilesFileJson,
  normalizeLaneDefinition,
  normalizeAgentBinding,
  normalizeProfileDefinition,
  normalizeProfilesFile,
  ProfileValidationError,
  type ProfilesFile,
  type LaneDefinition,
  type AgentBinding,
  type ProfileDefinition,
} from "../extensions/zflow-profiles/profiles.js"
import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

// ── Helpers ─────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
const EXAMPLE_PATH = resolve(__dirname, "..", "config", "profiles.example.json")

function loadExampleJson(): unknown {
  const raw = readFileSync(EXAMPLE_PATH, "utf8")
  return JSON.parse(raw)
}

// ── Valid profile data for tests ────────────────────────────────

function validProfilesFile(): ProfilesFile {
  return {
    default: {
      description: "Test profile",
      lanes: {
        "scout-cheap": {
          required: true,
          thinking: "low",
          preferredModels: ["openai/gpt-4o-mini"],
        },
        "worker-strong": {
          required: true,
          thinking: "high",
          preferredModels: ["openai/gpt-5.4-codex"],
        },
        "review-logic": {
          optional: true,
          thinking: "medium",
          preferredModels: ["openai/gpt-5.4"],
        },
      },
      agentBindings: {
        scout: {
          lane: "scout-cheap",
          tools: "read, grep, find",
          maxOutput: 4000,
          maxSubagentDepth: 0,
        },
        "zflow.implement-hard": {
          lane: "worker-strong",
          tools: "read, bash, edit, write",
          maxOutput: 12000,
          maxSubagentDepth: 1,
        },
        "zflow.review-logic": {
          lane: "review-logic",
          optional: true,
          tools: "read, grep",
          maxOutput: 8000,
        },
      },
    },
  }
}

// ── Tests ───────────────────────────────────────────────────────

describe("validateProfilesFile", () => {
  it("accepts a valid profiles file", () => {
    const result = validateProfilesFile(validProfilesFile())
    assert.equal(result.valid, true)
    assert.equal(result.errors.length, 0)
  })

  it("accepts the example config", () => {
    const data = loadExampleJson()
    const result = validateProfilesFile(data)
    if (!result.valid) {
      console.error("Validation errors:", JSON.stringify(result.errors, null, 2))
    }
    assert.equal(result.valid, true)
    assert.equal(result.errors.length, 0)
  })

  it("rejects null/undefined/non-object root", () => {
    for (const val of [null, undefined, "string", 42, true]) {
      const result = validateProfilesFile(val)
      assert.equal(result.valid, false)
      assert.ok(result.errors.length > 0)
      assert.ok(result.errors[0].message.includes("object"))
    }
  })

  it("rejects missing default profile", () => {
    const data = { other: { lanes: {}, agentBindings: {} } }
    const result = validateProfilesFile(data)
    assert.equal(result.valid, false)
    assert.ok(result.errors.some((e) => e.path === "<root>" && e.message.includes("default")))
  })

  it("rejects a profile with non-object value", () => {
    const data = { default: "not-an-object" }
    const result = validateProfilesFile(data)
    assert.equal(result.valid, false)
    assert.ok(result.errors.some((e) => e.path === "default" && e.message.includes("non-null object")))
  })

  it("rejects missing lanes", () => {
    const data = { default: { agentBindings: {} } }
    const result = validateProfilesFile(data)
    assert.equal(result.valid, false)
    assert.ok(result.errors.some((e) => e.path === "default.lanes"))
  })

  it("rejects missing agentBindings", () => {
    const data = {
      default: {
        lanes: { "scout-cheap": { preferredModels: ["openai/gpt-4o-mini"] } },
      },
    }
    const result = validateProfilesFile(data)
    assert.equal(result.valid, false)
    assert.ok(result.errors.some((e) => e.path === "default.agentBindings"))
  })

  it("rejects lane with empty preferredModels", () => {
    const data = {
      default: {
        lanes: {
          "scout-cheap": { preferredModels: [] },
        },
        agentBindings: {
          scout: { lane: "scout-cheap" },
        },
      },
    }
    const result = validateProfilesFile(data)
    assert.equal(result.valid, false)
    assert.ok(
      result.errors.some((e) =>
        e.path.includes("preferredModels") && e.message.includes("non-empty"),
      ),
    )
  })

  it("rejects lane with non-string preferredModels", () => {
    const data = {
      default: {
        lanes: {
          "scout-cheap": { preferredModels: ["valid-model", 42] },
        },
        agentBindings: {
          scout: { lane: "scout-cheap" },
        },
      },
    }
    const result = validateProfilesFile(data)
    assert.equal(result.valid, false)
    assert.ok(
      result.errors.some((e) =>
        e.path.includes("preferredModels") && e.message.includes("non-empty"),
      ),
    )
  })

  it("rejects both required: true and optional: true", () => {
    const data = {
      default: {
        lanes: {
          "scout-cheap": {
            required: true,
            optional: true,
            preferredModels: ["openai/gpt-4o-mini"],
          },
        },
        agentBindings: {
          scout: { lane: "scout-cheap" },
        },
      },
    }
    const result = validateProfilesFile(data)
    assert.equal(result.valid, false)
    assert.ok(
      result.errors.some((e) =>
        e.message.includes("both") && e.message.includes("conflict"),
      ),
    )
  })

  it("rejects invalid thinking level", () => {
    const data = {
      default: {
        lanes: {
          "scout-cheap": {
            thinking: "ultra",
            preferredModels: ["openai/gpt-4o-mini"],
          },
        },
        agentBindings: {
          scout: { lane: "scout-cheap" },
        },
      },
    }
    const result = validateProfilesFile(data)
    assert.equal(result.valid, false)
    assert.ok(
      result.errors.some((e) =>
        e.path.includes("thinking") && e.message.includes("low"),
      ),
    )
  })

  it("rejects agent binding referencing unknown lane", () => {
    const data = {
      default: {
        lanes: {
          "scout-cheap": { preferredModels: ["openai/gpt-4o-mini"] },
        },
        agentBindings: {
          scout: { lane: "nonexistent-lane" },
        },
      },
    }
    const result = validateProfilesFile(data)
    assert.equal(result.valid, false)
    assert.ok(
      result.errors.some((e) =>
        e.path.includes("lane") && e.message.includes("nonexistent-lane"),
      ),
    )
  })

  it("rejects agent binding with missing lane field", () => {
    const data = {
      default: {
        lanes: {
          "scout-cheap": { preferredModels: ["openai/gpt-4o-mini"] },
        },
        agentBindings: {
          scout: { tools: "read" },
        },
      },
    }
    const result = validateProfilesFile(data)
    assert.equal(result.valid, false)
    assert.ok(
      result.errors.some((e) => e.path === "default.agentBindings.scout.lane"),
    )
  })

  it("rejects invalid maxOutput (non-integer)", () => {
    const data = {
      default: {
        lanes: {
          "scout-cheap": { preferredModels: ["openai/gpt-4o-mini"] },
        },
        agentBindings: {
          scout: { lane: "scout-cheap", maxOutput: 12.5 },
        },
      },
    }
    const result = validateProfilesFile(data)
    assert.equal(result.valid, false)
    assert.ok(
      result.errors.some((e) =>
        e.path.includes("maxOutput") && e.message.includes("positive integer"),
      ),
    )
  })

  it("rejects invalid maxOutput (negative)", () => {
    const data = {
      default: {
        lanes: {
          "scout-cheap": { preferredModels: ["openai/gpt-4o-mini"] },
        },
        agentBindings: {
          scout: { lane: "scout-cheap", maxOutput: -1 },
        },
      },
    }
    const result = validateProfilesFile(data)
    assert.equal(result.valid, false)
    assert.ok(
      result.errors.some((e) =>
        e.path.includes("maxOutput") && e.message.includes("positive integer"),
      ),
    )
  })

  it("rejects invalid maxSubagentDepth (negative)", () => {
    const data = {
      default: {
        lanes: {
          "scout-cheap": { preferredModels: ["openai/gpt-4o-mini"] },
        },
        agentBindings: {
          scout: { lane: "scout-cheap", maxSubagentDepth: -1 },
        },
      },
    }
    const result = validateProfilesFile(data)
    assert.equal(result.valid, false)
    assert.ok(
      result.errors.some((e) =>
        e.path.includes("maxSubagentDepth") && e.message.includes("non-negative integer"),
      ),
    )
  })

  it("rejects invalid description (non-string)", () => {
    const data = {
      default: {
        description: 42,
        lanes: {
          "scout-cheap": { preferredModels: ["openai/gpt-4o-mini"] },
        },
        agentBindings: {
          scout: { lane: "scout-cheap" },
        },
      },
    }
    const result = validateProfilesFile(data)
    assert.equal(result.valid, false)
    assert.ok(
      result.errors.some((e) =>
        e.path === "default.description" && e.message.includes("string"),
      ),
    )
  })

  it("rejects invalid verificationCommand (non-string)", () => {
    const data = {
      default: {
        verificationCommand: true,
        lanes: {
          "scout-cheap": { preferredModels: ["openai/gpt-4o-mini"] },
        },
        agentBindings: {
          scout: { lane: "scout-cheap" },
        },
      },
    }
    const result = validateProfilesFile(data)
    assert.equal(result.valid, false)
    assert.ok(
      result.errors.some((e) =>
        e.path === "default.verificationCommand" && e.message.includes("string"),
      ),
    )
  })
})

describe("normalizeLaneDefinition", () => {
  it("defaults to required when neither flag is set", () => {
    const result = normalizeLaneDefinition({ preferredModels: ["m"] })
    assert.equal(result.required, true)
    assert.equal(result.optional, false)
  })

  it("sets required=true when required explicitly", () => {
    const result = normalizeLaneDefinition({
      required: true,
      preferredModels: ["m"],
    })
    assert.equal(result.required, true)
    assert.equal(result.optional, false)
  })

  it("sets optional=true when optional explicitly", () => {
    const result = normalizeLaneDefinition({
      optional: true,
      preferredModels: ["m"],
    })
    assert.equal(result.required, false)
    assert.equal(result.optional, true)
  })

  it("preserves thinking level", () => {
    const result = normalizeLaneDefinition({
      thinking: "high",
      preferredModels: ["m"],
    })
    assert.equal(result.thinking, "high")
  })

  it("allows undefined thinking", () => {
    const result = normalizeLaneDefinition({ preferredModels: ["m"] })
    assert.equal(result.thinking, undefined)
  })
})

describe("normalizeAgentBinding", () => {
  it("defaults optional to false", () => {
    const result = normalizeAgentBinding({ lane: "test" })
    assert.equal(result.optional, false)
  })

  it("preserves explicit optional", () => {
    const result = normalizeAgentBinding({ lane: "test", optional: true })
    assert.equal(result.optional, true)
  })

  it("preserves tools", () => {
    const result = normalizeAgentBinding({ lane: "test", tools: "read,write" })
    assert.equal(result.tools, "read,write")
  })

  it("preserves maxOutput", () => {
    const result = normalizeAgentBinding({ lane: "test", maxOutput: 8000 })
    assert.equal(result.maxOutput, 8000)
  })

  it("preserves maxSubagentDepth", () => {
    const result = normalizeAgentBinding({ lane: "test", maxSubagentDepth: 1 })
    assert.equal(result.maxSubagentDepth, 1)
  })
})

describe("normalizeProfileDefinition", () => {
  it("normalizes all lanes and bindings", () => {
    const profile: ProfileDefinition = {
      description: "test",
      verificationCommand: "npm test",
      lanes: {
        lane1: { preferredModels: ["m1"] },
        lane2: { optional: true, thinking: "high", preferredModels: ["m2"] },
      },
      agentBindings: {
        agent1: { lane: "lane1" },
        agent2: { lane: "lane2", optional: true, maxOutput: 8000 },
      },
    }

    const result = normalizeProfileDefinition(profile)
    assert.equal(result.description, "test")
    assert.equal(result.verificationCommand, "npm test")

    // Lane1: no flags → required
    assert.equal(result.lanes.lane1.required, true)
    assert.equal(result.lanes.lane1.optional, false)

    // Lane2: optional
    assert.equal(result.lanes.lane2.required, false)
    assert.equal(result.lanes.lane2.optional, true)
    assert.equal(result.lanes.lane2.thinking, "high")

    // Agent1: no optional flag
    assert.equal(result.agentBindings.agent1.optional, false)
    assert.equal(result.agentBindings.agent1.lane, "lane1")

    // Agent2: optional
    assert.equal(result.agentBindings.agent2.optional, true)
    assert.equal(result.agentBindings.agent2.maxOutput, 8000)
  })
})

describe("normalizeProfilesFile", () => {
  it("normalizes all profiles", () => {
    const profiles: ProfilesFile = {
      default: {
        lanes: {
          scout: { preferredModels: ["m1"] },
        },
        agentBindings: {
          s: { lane: "scout" },
        },
      },
      alt: {
        description: "alt profile",
        lanes: {
          work: { optional: true, preferredModels: ["m2"] },
        },
        agentBindings: {
          w: { lane: "work", optional: true },
        },
      },
    }

    const result = normalizeProfilesFile(profiles)
    assert.ok("default" in result)
    assert.ok("alt" in result)
    assert.equal(result.default.lanes.scout.required, true)
    assert.equal(result.alt.lanes.work.optional, true)
  })
})

describe("parseProfilesFile", () => {
  it("parses and validates a valid profiles file", () => {
    const data = validProfilesFile()
    const { profiles, validation } = parseProfilesFile(data)
    assert.equal(validation.valid, true)
    assert.ok("default" in profiles)
  })

  it("throws ProfileValidationError for invalid input", () => {
    const data = {
      default: {
        lanes: {
          scout: { preferredModels: [] },
        },
        agentBindings: {
          s: { lane: "scout" },
        },
      },
    }
    assert.throws(
      () => parseProfilesFile(data),
      (err: unknown) => err instanceof ProfileValidationError,
    )
  })
})

describe("parseProfilesFileJson", () => {
  it("parses valid JSON", () => {
    const json = JSON.stringify(validProfilesFile())
    const { profiles } = parseProfilesFileJson(json)
    assert.ok("default" in profiles)
  })

  it("throws ProfileValidationError for invalid JSON", () => {
    assert.throws(
      () => parseProfilesFileJson("not valid json {{{"),
      (err: unknown) => err instanceof ProfileValidationError,
    )
  })

  it("throws ProfileValidationError for semantically invalid JSON", () => {
    const json = JSON.stringify({
      default: {
        lanes: {
          scout: { preferredModels: [] },
        },
        agentBindings: {
          s: { lane: "scout" },
        },
      },
    })
    assert.throws(
      () => parseProfilesFileJson(json),
      (err: unknown) => err instanceof ProfileValidationError,
    )
  })
})

describe("example config", () => {
  it("loads and validates cleanly", () => {
    const data = loadExampleJson()
    const result = validateProfilesFile(data)
    if (!result.valid) {
      console.error("Example config validation errors:", JSON.stringify(result.errors, null, 2))
    }
    assert.equal(result.valid, true)
  })

  it("parses without throwing", () => {
    const data = loadExampleJson()
    assert.doesNotThrow(() => parseProfilesFile(data))
  })
})
