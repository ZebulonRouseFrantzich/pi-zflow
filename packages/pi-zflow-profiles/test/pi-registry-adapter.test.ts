import { describe, it } from "node:test"
import * as assert from "node:assert/strict"

import { createPiModelRegistryAdapter } from "../extensions/zflow-profiles/pi-registry-adapter.js"
import { computeEnvironmentFingerprintFromRegistry } from "../extensions/zflow-profiles/profiles.js"

function makePiRegistry(options?: { authenticated?: boolean; baseUrl?: string }) {
  const authenticated = options?.authenticated ?? true
  const baseUrl = options?.baseUrl ?? "https://api.example.test/v1"
  return {
    getAll() {
      return [
        {
          provider: "openai",
          id: "gpt-test",
          api: "openai-completions",
          baseUrl,
          reasoning: true,
          input: ["text"],
          contextWindow: 128000,
          maxTokens: 8192,
        },
      ]
    },
    hasConfiguredAuth() {
      return authenticated
    },
  }
}

describe("createPiModelRegistryAdapter", () => {
  it("maps Pi model registry entries into ModelInfo", () => {
    const registry = createPiModelRegistryAdapter(makePiRegistry())
    const model = registry.getModel("openai/gpt-test")

    assert.notEqual(model, undefined)
    assert.equal(model!.id, "openai/gpt-test")
    assert.equal(model!.provider, "openai")
    assert.equal(model!.api, "openai-completions")
    assert.equal(model!.baseUrl, "https://api.example.test/v1")
    assert.equal(model!.supportsTools, true)
    assert.equal(model!.supportsText, true)
    assert.equal(model!.thinkingCapability, "high")
    assert.equal(model!.authenticated, true)
    assert.equal(model!.contextWindow, 128000)
    assert.equal(model!.maxOutput, 8192)
  })

  it("uses getAllModels for fingerprints so auth and provider config changes invalidate cache", () => {
    const fp1 = computeEnvironmentFingerprintFromRegistry(
      createPiModelRegistryAdapter(makePiRegistry({ authenticated: true })),
    )
    const fp2 = computeEnvironmentFingerprintFromRegistry(
      createPiModelRegistryAdapter(makePiRegistry({ authenticated: false })),
    )
    const fp3 = computeEnvironmentFingerprintFromRegistry(
      createPiModelRegistryAdapter(makePiRegistry({ baseUrl: "https://proxy.example.test/v1" })),
    )

    assert.notEqual(fp1, fp2)
    assert.notEqual(fp1, fp3)
  })
})
