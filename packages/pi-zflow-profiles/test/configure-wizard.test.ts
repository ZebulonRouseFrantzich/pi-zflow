/**
 * configure-wizard.test.ts — Tests for the profile configuration wizard.
 *
 * Covers:
 *   - resolveProviderModels (grouping, auth filtering, capability enrichment)
 *   - getSupportedThinkingLevels (reasoning vs non-reasoning, level map filtering)
 *   - initWizardState (defaults, existing values, lane/agent mapping)
 *   - buildProfileDefinition (round-trip from state to JSON)
 *   - buildThinkingSelectItems (select item generation)
 *   - LANE_DESCRIPTIONS and AGENT_DESCRIPTIONS coverage
 */
import { describe, it } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import {
  resolveProviderModels,
  getSupportedThinkingLevels,
  initWizardState,
  buildProfileDefinition,
  buildThinkingSelectItems,
  buildModelSelectItems,
  buildProviderSelectItems,
  LANE_DESCRIPTIONS,
  AGENT_DESCRIPTIONS,
  MULTI_PROVIDER_LANES,
  type DisplayModel,
  type ProviderGroup,
  type WizardEditState,
  type ThinkingLevel,
} from "../extensions/zflow-profiles/tui-components.js"
import {
  resolveConfigureWizardPaths,
  buildProfilesForWizardWrite,
  persistWizardProfileDraft,
} from "../extensions/zflow-profiles/configure-wizard.js"

import type {
  NormalizedProfileDefinition,
  ProfileDefinition,
} from "../extensions/zflow-profiles/profiles.js"

// ── Mock helpers ─────────────────────────────────────────────────

/**
 * Create a minimal mock Pi model registry with the given models.
 */
function mockRegistry(
  models: Array<{
    provider: string
    id: string
    reasoning?: boolean
    thinkingLevelMap?: Record<string, string | null>
    input?: string[]
    contextWindow?: number
    maxTokens?: number
    name?: string
    supportsTools?: boolean
    authenticated?: boolean
  }>,
): {
  getAll(): Array<{
    provider: string
    id: string
    reasoning?: boolean
    thinkingLevelMap?: Record<string, string | null>
    input?: string[]
    contextWindow?: number
    maxTokens?: number
    name?: string
    supportsTools?: boolean
    [key: string]: unknown
  }>
  hasConfiguredAuth(model: {
    provider: string
    id: string
    [key: string]: unknown
  }): boolean
} {
  const authSet = new Set(
    models.filter((m) => m.authenticated !== false).map((m) => `${m.provider}/${m.id}`),
  )
  return {
    getAll() {
      return models.map((m) => ({
        provider: m.provider,
        id: m.id,
        reasoning: m.reasoning,
        thinkingLevelMap: m.thinkingLevelMap,
        input: m.input,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        name: m.name,
        supportsTools: m.supportsTools,
      }))
    },
    hasConfiguredAuth(model: { provider: string; id: string; [key: string]: unknown }): boolean {
      return authSet.has(`${model.provider}/${model.id}`)
    },
  }
}

// ── resolveProviderModels ────────────────────────────────────────

describe("resolveProviderModels", () => {
  it("groups models by provider", () => {
    const registry = mockRegistry([
      { provider: "openai", id: "gpt-5.4", reasoning: true },
      { provider: "openai", id: "gpt-5.4-mini" },
      { provider: "anthropic", id: "claude-sonnet-4", reasoning: true },
    ])
    const groups = resolveProviderModels(registry)

    assert.equal(groups.length, 2)
    const openai = groups.find((g) => g.name === "openai")
    assert.ok(openai)
    assert.equal(openai.models.length, 2)
    assert.ok(openai.hasAuth)

    const anthropic = groups.find((g) => g.name === "anthropic")
    assert.ok(anthropic)
    assert.equal(anthropic.models.length, 1)
  })

  it("marks providers without auth correctly", () => {
    const registry = mockRegistry([
      { provider: "openai", id: "gpt-5.4", authenticated: false },
    ])
    const groups = resolveProviderModels(registry)

    const openai = groups.find((g) => g.name === "openai")
    assert.ok(openai)
    assert.equal(openai.hasAuth, false)
    assert.equal(openai.models[0]!.authenticated, false)
  })

  it("enriches display models with capabilities", () => {
    const registry = mockRegistry([
      {
        provider: "openai",
        id: "gpt-5.4",
        reasoning: true,
        thinkingLevelMap: { low: null, medium: "medium", high: "high", xhigh: null },
        contextWindow: 200000,
        maxTokens: 64000,
        name: "GPT 5.4",
        supportsTools: true,
      },
    ])
    const groups = resolveProviderModels(registry)

    const model = groups[0].models[0]
    assert.ok(model)
    assert.equal(model.id, "openai/gpt-5.4")
    assert.equal(model.name, "GPT 5.4")
    assert.equal(model.supportsTools, true)
    assert.equal(model.thinkingCapability, "high")
    assert.equal(model.contextWindow, 200000)
    assert.equal(model.maxTokens, 64000)
  })

  it("resolves thinking capability from thinkingLevelMap", () => {
    const registry = mockRegistry([
      {
        provider: "test",
        id: "deep-thinker",
        reasoning: true,
        thinkingLevelMap: { off: null, low: null, medium: "medium", high: "high", xhigh: "xhigh" },
      },
    ])
    const groups = resolveProviderModels(registry)
    // Should pick xhigh since it's the highest supported
    assert.equal(groups[0].models[0]!.thinkingCapability, "xhigh")
  })

  it("handles models without reasoning", () => {
    const registry = mockRegistry([
      { provider: "cheap", id: "fast-model", reasoning: false },
    ])
    const groups = resolveProviderModels(registry)
    assert.equal(groups[0].models[0]!.thinkingCapability, "medium")
  })
})

// ── getSupportedThinkingLevels ───────────────────────────────────

describe("getSupportedThinkingLevels", () => {
  function makeModel(overrides: Partial<DisplayModel> = {}): DisplayModel {
    return {
      id: "test/model",
      name: "Test Model",
      provider: "test",
      supportsTools: true,
      supportsText: true,
      authenticated: true,
      thinkingCapability: "high",
      reasoning: true,
      ...overrides,
    }
  }

  it("returns all levels for reasoning model with no level map", () => {
    const model = makeModel()
    const levels = getSupportedThinkingLevels(model)
    assert.deepEqual(levels, ["off", "low", "medium", "high", "xhigh"])
  })

  it("filters out levels marked null in thinkingLevelMap", () => {
    const model = makeModel({
      thinkingLevelMap: { off: null as unknown as undefined, low: null as unknown as undefined },
    })
    const levels = getSupportedThinkingLevels(model)
    assert.deepEqual(levels, ["medium", "high", "xhigh"])
  })

  it("restricts to off/medium for non-reasoning models", () => {
    const model = makeModel({ reasoning: false })
    const levels = getSupportedThinkingLevels(model)
    assert.deepEqual(levels, ["off", "medium"])
  })
})

// ── buildThinkingSelectItems ─────────────────────────────────────

describe("buildThinkingSelectItems", () => {
  it("builds items for supported levels with current marked", () => {
    const items = buildThinkingSelectItems(
      ["low", "medium", "high"],
      "medium",
    )
    assert.equal(items.length, 3)
    // Current level should be marked
    const mediumItem = items.find((i) => i.value === "medium")
    assert.ok(mediumItem)
    assert.ok(mediumItem.label.startsWith("✓"))
    assert.ok(mediumItem.description.length > 0)
  })

  it("includes descriptive text for each level", () => {
    const items = buildThinkingSelectItems(
      ["off", "low", "medium", "high", "xhigh"],
      "off",
    )
    for (const item of items) {
      assert.ok(item.description, `Missing description for level ${item.value}`)
      assert.ok(typeof item.description === "string")
    }
  })
})

// ── initWizardState ──────────────────────────────────────────────

describe("initWizardState", () => {
  function emptyGroups(): ProviderGroup[] {
    return []
  }

  it("initialises from metadata when no profile exists", () => {
    const state = initWizardState("default", null, emptyGroups())

    assert.equal(state.profileName, "default")
    // Should have lanes from LANE_DESCRIPTIONS
    assert.ok(state.lanes.length > 0)
    // Should have agents from AGENT_DESCRIPTIONS
    assert.ok(state.agentBindings.length > 0)
  })

  it("preserves existing lane values as defaults", () => {
    const existing: NormalizedProfileDefinition = {
      lanes: {
        "planning-frontier": {
          required: true,
          optional: false,
          thinking: "xhigh",
          preferredModels: ["openai/gpt-5.5", "opencode-go/mimo-v2.5-pro"],
        },
      },
      agentBindings: {
        "zflow.planner-frontier": {
          lane: "planning-frontier",
          optional: false,
          tools: "read, write",
          maxOutput: 12000,
          maxSubagentDepth: 1,
        },
      },
    }

    const groups: ProviderGroup[] = [
      {
        name: "openai",
        models: [
          {
            id: "openai/gpt-5.5",
            name: "GPT 5.5",
            provider: "openai",
            supportsTools: true,
            supportsText: true,
            authenticated: true,
            thinkingCapability: "xhigh",
            reasoning: true,
            contextWindow: 200000,
            maxTokens: 64000,
          },
        ],
        hasAuth: true,
      },
    ]

    const state = initWizardState("default", existing, groups)

    const plannerLane = state.lanes.find((l) => l.laneName === "planning-frontier")
    assert.ok(plannerLane, "planning-frontier lane should exist")
    assert.deepEqual(plannerLane.selectedModels, ["openai/gpt-5.5", "opencode-go/mimo-v2.5-pro"])
    assert.equal(plannerLane.thinking, "xhigh")

    const plannerAgent = state.agentBindings.find((a) => a.agentName === "zflow.planner-frontier")
    assert.ok(plannerAgent, "planner agent should exist")
    assert.equal(plannerAgent.tools, "read, write")
    assert.equal(plannerAgent.maxOutput, 12000)
    assert.equal(plannerAgent.maxSubagentDepth, 1)
  })

  it("populates defaults for lanes without existing config", () => {
    const state = initWizardState("default", null, emptyGroups())
    const reviewLanes = state.lanes.filter((l) => l.laneName.startsWith("review-"))
    for (const lane of reviewLanes) {
      assert.equal(lane.multiProvider, true, `${lane.laneName} should be multi-provider`)
    }
  })
})

// ── buildProfileDefinition ───────────────────────────────────────

describe("buildProfileDefinition", () => {
  it("round-trips: wizard state → profile JSON", () => {
    const state: WizardEditState = {
      profileName: "default",
      lanes: [
        {
          laneName: "planning-frontier",
          description: "Deep reasoning for planning",
          selectedModels: ["openai/gpt-5.5"],
          thinking: "high",
          required: true,
          optional: false,
          multiProvider: false,
        },
        {
          laneName: "review-security",
          description: "Security review",
          selectedModels: ["anthropic/claude-sonnet-4", "openai/gpt-5.4"],
          thinking: "high",
          required: true,
          optional: false,
          multiProvider: true,
        },
      ],
      agentBindings: [
        {
          agentName: "zflow.planner-frontier",
          description: "Planner",
          lane: "planning-frontier",
          thinking: "high",
          tools: "read, write",
          maxOutput: 12000,
          maxSubagentDepth: 1,
          optional: false,
        },
      ],
    }

    const profile = buildProfileDefinition(state)

    // Lane structure
    assert.ok(profile.lanes["planning-frontier"])
    assert.equal(profile.lanes["planning-frontier"].thinking, "high")
    assert.deepEqual(profile.lanes["planning-frontier"].preferredModels, ["openai/gpt-5.5"])

    assert.ok(profile.lanes["review-security"])
    assert.deepEqual(profile.lanes["review-security"].preferredModels, [
      "anthropic/claude-sonnet-4",
      "openai/gpt-5.4",
    ])

    // Agent binding structure
    assert.ok(profile.agentBindings["zflow.planner-frontier"])
    assert.equal(profile.agentBindings["zflow.planner-frontier"].lane, "planning-frontier")
    assert.equal(profile.agentBindings["zflow.planner-frontier"].tools, "read, write")
    assert.equal(profile.agentBindings["zflow.planner-frontier"].maxOutput, 12000)
  })

  it("omits undefined optional fields", () => {
    const state: WizardEditState = {
      profileName: "default",
      lanes: [
        {
          laneName: "scout-cheap",
          description: "Scout",
          selectedModels: [],
          thinking: "low",
          required: true,
          optional: false,
          multiProvider: false,
        },
      ],
      agentBindings: [
        {
          agentName: "scout",
          description: "Scout",
          lane: "scout-cheap",
          thinking: "low",
          tools: "",
          maxOutput: 0,
          maxSubagentDepth: 0,
          optional: false,
        },
      ],
    }

    const profile = buildProfileDefinition(state)
    assert.equal(profile.agentBindings["scout"].tools, undefined)
    assert.equal(profile.agentBindings["scout"].maxOutput, undefined)
  })
})

// ── configure wizard file targeting / draft persistence ─────────

describe("configure wizard write targeting", () => {
  it("defaults to the global user profile path", () => {
    const paths = resolveConfigureWizardPaths()
    assert.equal(
      paths.finalWritePath,
      path.join(os.homedir(), ".pi", "agent", "zflow-profiles.json"),
    )
    assert.equal(
      paths.wipPath,
      path.join(os.homedir(), ".pi", "agent", ".zflow-profile-configure-wip.json"),
    )
  })

  it("merges the edited profile into existing profiles for write-back", () => {
    const state: WizardEditState = {
      profileName: "default",
      lanes: [
        {
          laneName: "worker-cheap",
          description: "Worker lane",
          selectedModels: ["github-copilot/gpt-5-mini"],
          thinking: "high",
          required: true,
          optional: false,
          multiProvider: false,
        },
      ],
      agentBindings: [
        {
          agentName: "zflow.implement-routine",
          description: "Routine implementer",
          lane: "worker-cheap",
          thinking: "high",
          tools: "read, bash, edit, write",
          maxOutput: 8000,
          maxSubagentDepth: 0,
          optional: false,
        },
      ],
    }

    const profiles = buildProfilesForWizardWrite(state, {
      other: {
        description: "keep me",
        lanes: {},
        agentBindings: {},
      },
    } as unknown as ProfileDefinition)

    assert.ok(profiles.default)
    assert.ok(profiles.other)
    assert.deepEqual(
      profiles.default.lanes["worker-cheap"].preferredModels,
      ["github-copilot/gpt-5-mini"],
    )
  })

  it("creates and updates the target profile file as draft progress is saved", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-profile-wizard-"))
    const writePath = path.join(tmpDir, "zflow-profiles.json")
    const wipPath = path.join(tmpDir, ".zflow-profile-configure-wip.json")

    const state: WizardEditState = {
      profileName: "default",
      lanes: [
        {
          laneName: "review-correctness",
          description: "Correctness review",
          selectedModels: ["github-copilot/claude-sonnet-4.6"],
          thinking: "medium",
          required: true,
          optional: false,
          multiProvider: true,
        },
      ],
      agentBindings: [
        {
          agentName: "zflow.review-correctness",
          description: "Correctness reviewer",
          lane: "review-correctness",
          thinking: "medium",
          tools: "read, grep, find, ls",
          maxOutput: 10000,
          maxSubagentDepth: 0,
          optional: false,
        },
      ],
    }

    await persistWizardProfileDraft(state, {
      writePath,
      wipPath,
      existingProfiles: {},
      existingProfile: null,
    })

    const firstWrite = JSON.parse(await fs.readFile(writePath, "utf8"))
    const firstWip = JSON.parse(await fs.readFile(wipPath, "utf8"))
    assert.deepEqual(
      firstWrite.default.lanes["review-correctness"].preferredModels,
      ["github-copilot/claude-sonnet-4.6"],
    )
    assert.deepEqual(firstWip.lanes[0].selectedModels, ["github-copilot/claude-sonnet-4.6"])

    state.lanes[0]!.selectedModels = ["github-copilot/gpt-5.4"]
    state.agentBindings[0]!.thinking = "high"

    await persistWizardProfileDraft(state, {
      writePath,
      wipPath,
      existingProfiles: {},
      existingProfile: null,
    })

    const secondWrite = JSON.parse(await fs.readFile(writePath, "utf8"))
    assert.deepEqual(
      secondWrite.default.lanes["review-correctness"].preferredModels,
      ["github-copilot/gpt-5.4"],
    )
    assert.equal(secondWrite.default.agentBindings["zflow.review-correctness"].lane, "review-correctness")
  })
})

// ── Descriptions coverage ────────────────────────────────────────

describe("lane descriptions", () => {
  it("has descriptions for all 10 built-in lanes", () => {
    const expectedLanes = [
      "scout-cheap",
      "planning-frontier",
      "worker-cheap",
      "worker-strong",
      "review-correctness",
      "review-integration",
      "review-security",
      "review-logic",
      "review-system",
      "synthesis-frontier",
    ]
    for (const lane of expectedLanes) {
      assert.ok(LANE_DESCRIPTIONS[lane], `Missing description for lane: ${lane}`)
    }
  })
})

describe("agent descriptions", () => {
  it("has descriptions for all built-in agents", () => {
    const expectedAgents = [
      "scout",
      "zflow.planner-frontier",
      "zflow.plan-validator",
      "context-builder",
      "zflow.implement-routine",
      "zflow.implement-hard",
      "zflow.verifier",
      "zflow.review-correctness",
      "zflow.review-integration",
      "zflow.review-security",
      "zflow.review-logic",
      "zflow.review-system",
      "zflow.synthesizer",
      "zflow.repo-mapper",
      "zflow.plan-review-correctness",
      "zflow.plan-review-integration",
      "zflow.plan-review-feasibility",
    ]
    for (const agent of expectedAgents) {
      assert.ok(AGENT_DESCRIPTIONS[agent], `Missing description for agent: ${agent}`)
    }
  })
})

// ── Multi-provider lanes ─────────────────────────────────────────

describe("multi-provider lanes", () => {
  it("marks review lanes for multi-provider selection", () => {
    assert.ok(MULTI_PROVIDER_LANES.has("review-correctness"))
    assert.ok(MULTI_PROVIDER_LANES.has("review-integration"))
    assert.ok(MULTI_PROVIDER_LANES.has("review-security"))
    assert.ok(MULTI_PROVIDER_LANES.has("review-logic"))
    assert.ok(MULTI_PROVIDER_LANES.has("review-system"))
  })

  it("does not mark non-review lanes", () => {
    assert.equal(MULTI_PROVIDER_LANES.has("planning-frontier"), false)
    assert.equal(MULTI_PROVIDER_LANES.has("worker-cheap"), false)
    assert.equal(MULTI_PROVIDER_LANES.has("synthesis-frontier"), false)
  })
})

// ── buildModelSelectItems ────────────────────────────────────────

describe("buildModelSelectItems", () => {
  function makeModel(overrides: Partial<DisplayModel> = {}): DisplayModel {
    return {
      id: "openai/gpt-5.4",
      name: "GPT 5.4",
      provider: "openai",
      supportsTools: true,
      supportsText: true,
      authenticated: true,
      thinkingCapability: "high",
      reasoning: true,
      contextWindow: 200000,
      maxTokens: 64000,
      ...overrides,
    }
  }

  it("builds items with capability info in description", () => {
    const models = [makeModel()]
    const items = buildModelSelectItems(models)

    assert.equal(items.length, 1)
    assert.ok(items[0]!.description.includes("high"), "should show thinking capability")
    assert.ok(items[0]!.description.includes("200k"), "should show context window")
  })

  it("marks current selection with checkmark", () => {
    const models = [
      makeModel({ id: "openai/gpt-5.4", name: "GPT 5.4" }),
      makeModel({ id: "anthropic/claude", name: "Claude" }),
    ]
    const items = buildModelSelectItems(models, "openai/gpt-5.4")

    assert.equal(items[0]!.label.startsWith("✓"), true, "selected model should have checkmark")
    assert.equal(items[1]!.label.startsWith("  "), true, "unselected model should not")
  })

  it("shows not-authenticated warning", () => {
    const models = [makeModel({ authenticated: false })]
    const items = buildModelSelectItems(models)

    assert.ok(items[0]!.description.includes("not authenticated"))
  })
})

// ── buildProviderSelectItems ─────────────────────────────────────

describe("buildProviderSelectItems", () => {
  it("shows auth status and model count", () => {
    const groups: ProviderGroup[] = [
      {
        name: "openai",
        hasAuth: true,
        models: [
          {
            id: "openai/gpt-5.4",
            name: "GPT 5.4",
            provider: "openai",
            supportsTools: true,
            supportsText: true,
            authenticated: true,
            thinkingCapability: "high",
            reasoning: true,
          },
        ],
      },
      {
        name: "unconfigured",
        hasAuth: false,
        models: [],
      },
    ]

    const items = buildProviderSelectItems(groups)
    assert.equal(items.length, 2)
    assert.ok(items[0]!.description.includes("✓"))
    assert.ok(items[1]!.description.includes("✗"))
  })
})
