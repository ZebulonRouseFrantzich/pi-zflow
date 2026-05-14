/**
 * compaction-service.test.ts — Tests for the compaction service module.
 *
 * @module pi-zflow-compaction/test/compaction-service
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

/**
 * Import the module fresh for each test.
 */
async function importModule(cacheBust: string) {
  return import(`../src/compaction-service.js?cache=${cacheBust}`)
}

// ── Mock model registry factory ────────────────────────────────

/**
 * Create a mock model registry that resolves models by (provider, modelId).
 */
function createMockRegistry(availableModels: Array<{ provider: string; modelId: string }>) {
  return {
    find(provider: string, modelId: string): { provider: string; id: string } | undefined {
      const match = availableModels.find(
        (m) => m.provider === provider && m.modelId === modelId,
      )
      return match ? { provider: match.provider, id: match.modelId } : undefined
    },
  }
}

// ── Tests ───────────────────────────────────────────────────────

describe("compaction-service", () => {
  it("getCompactionThreshold returns 0.6", async () => {
    const mod = await importModule("threshold")
    const threshold = mod.getCompactionThreshold()
    assert.equal(threshold, 0.6)
  })

  it("getDefaultArtifactPaths returns expected paths", async () => {
    const mod = await importModule("paths")
    const paths = mod.getDefaultArtifactPaths()

    assert.ok(Array.isArray(paths))
    assert.ok(paths.length > 0)
    assert.ok(paths.includes("repo-map.md"))
    assert.ok(paths.includes("reconnaissance.md"))
    assert.ok(paths.includes("failure-log.md"))
  })

  it("buildCompactionPrompt contains key sections", async () => {
    const mod = await importModule("prompt")
    const prompt = mod.buildCompactionPrompt(
      150,      // messagesToSummarize
      45000,    // tokensBefore
      false,    // hasPreviousSummary
      ["repo-map.md", "failure-log.md"],
    )

    assert.equal(typeof prompt, "string")
    assert.ok(prompt.length > 100, "Prompt should be substantial")

    // Should contain key sections
    assert.ok(
      prompt.includes("Goals and Decisions"),
      "Should include Goals and Decisions section",
    )
    assert.ok(
      prompt.includes("Code Changes and Technical Details"),
      "Should include technical details section",
    )
    assert.ok(
      prompt.includes("Current State and Blockers"),
      "Should include current state section",
    )
    assert.ok(
      prompt.includes("Next Steps"),
      "Should include next steps section",
    )

    // Should reference artifact paths
    assert.ok(
      prompt.includes("repo-map.md"),
      "Should reference repo-map.md artifact",
    )
    assert.ok(
      prompt.includes("failure-log.md"),
      "Should reference failure-log.md artifact",
    )

    // Should mention token count
    assert.ok(
      prompt.includes("45,000") || prompt.includes("45000"),
      "Should include token count in prompt",
    )
  })

  it("buildCompactionPrompt with no custom paths uses defaults", async () => {
    const mod = await importModule("prompt2")
    const prompt = mod.buildCompactionPrompt(10, 5000, false)

    // Default paths should appear
    assert.ok(prompt.includes("repo-map.md"))
    assert.ok(prompt.includes("reconnaissance.md"))
    assert.ok(prompt.includes("failure-log.md"))
  })

  it("buildCompactionPrompt includes previous summary note when hasPreviousSummary is true", async () => {
    const mod = await importModule("prompt3")
    const prompt = mod.buildCompactionPrompt(50, 20000, true)

    assert.ok(
      prompt.includes("previous session summary") ||
        prompt.includes("Previous session summary"),
      "Should reference previous summary when available",
    )
  })

  it("createCompactionService returns a CompactionService with all methods", async () => {
    const mod = await importModule("service")
    const service = mod.createCompactionService()

    assert.ok(service, "Should return a service object")
    assert.equal(typeof service.getCompactionThreshold, "function")
    assert.equal(typeof service.chooseCheapCompactionModel, "function")
    assert.equal(typeof service.buildCompactionPrompt, "function")
    assert.equal(typeof service.getDefaultArtifactPaths, "function")

    // Verify method returns delegate correctly
    assert.equal(service.getCompactionThreshold(), 0.6)
  })

  it("chooseCheapCompactionModel finds Gemini Flash when available", async () => {
    const mod = await importModule("model1")
    const registry = createMockRegistry([
      { provider: "google", modelId: "gemini-2.5-flash" },
    ])

    const model = mod.chooseCheapCompactionModel(registry)

    assert.ok(model, "Should find Gemini Flash")
    assert.equal(model.provider, "google")
    assert.equal(model.id, "gemini-2.5-flash")
  })

  it("chooseCheapCompactionModel falls back to Claude Sonnet when Gemini unavailable", async () => {
    const mod = await importModule("model2")
    const registry = createMockRegistry([
      { provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
    ])

    const model = mod.chooseCheapCompactionModel(registry)

    assert.ok(model, "Should fall back to Claude Sonnet")
    assert.equal(model.provider, "anthropic")
    assert.equal(model.id, "claude-sonnet-4-20250514")
  })

  it("chooseCheapCompactionModel returns undefined when no cheap model found", async () => {
    const mod = await importModule("model3")
    const registry = createMockRegistry([
      { provider: "openai", modelId: "gpt-5" },
    ])

    const model = mod.chooseCheapCompactionModel(registry)

    assert.equal(model, undefined, "Should return undefined when no cheap model is available")
  })

  it("chooseCheapCompactionModel prefers Gemini over Claude when both available", async () => {
    const mod = await importModule("model4")
    const registry = createMockRegistry([
      { provider: "google", modelId: "gemini-2.5-flash" },
      { provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
    ])

    const model = mod.chooseCheapCompactionModel(registry)

    assert.ok(model, "Should find a model")
    assert.equal(model.provider, "google", "Should prefer Gemini over Claude")
    assert.equal(model.id, "gemini-2.5-flash")
  })
})
