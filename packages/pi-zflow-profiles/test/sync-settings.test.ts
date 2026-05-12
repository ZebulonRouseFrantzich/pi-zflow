/**
 * sync-settings.test.ts — Tests for `.pi/settings.json` sync functionality.
 *
 * Covers:
 *   - buildAgentOverrides (happy path, empty cache, partial bindings)
 *   - formatSyncSummary (renders correct lines, handles empty)
 *   - syncProfileToSettings (writes file, merges existing settings,
 *     creates file if missing, preserves unrelated keys, atomic write,
 *     handles empty overrides)
 *   - SettingsAgentOverride includes all expected fields
 *   - Normal activation does not trigger sync
 */
import { describe, it } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"

import {
  buildAgentOverrides,
  formatSyncSummary,
  syncProfileToSettings,
  activateProfile,
  ensureResolved,
  type SettingsAgentOverride,
  type SyncSettingsResult,
} from "../extensions/zflow-profiles/index.js"

import type {
  ActiveProfileCache,
  CachedResolvedLane,
  CachedAgentBinding,
  ModelRegistry,
  ModelInfo,
} from "../extensions/zflow-profiles/profiles.js"

// ── Helpers ─────────────────────────────────────────────────────

function model(id: string, overrides?: Partial<ModelInfo>): ModelInfo {
  return {
    id,
    supportsTools: true,
    supportsText: true,
    thinkingCapability: "medium",
    authenticated: true,
    ...overrides,
  }
}

function makeRegistry(models: ModelInfo[]): ModelRegistry {
  const map = new Map(models.map((m) => [m.id, m]))
  return {
    getModel(id: string): ModelInfo | undefined {
      return map.get(id)
    },
  }
}

/** Create a sample active profile cache for testing. */
function sampleCache(
  overrides?: Partial<ActiveProfileCache>,
): ActiveProfileCache {
  return {
    profileName: "default",
    sourcePath: "/test/.pi/zflow-profiles.json",
    resolvedAt: new Date().toISOString(),
    ttlMinutes: 15,
    definitionHash: "abc123",
    environmentFingerprint: "def456",
    resolvedLanes: {
      "planning-frontier": {
        model: "openai/gpt-5.4",
        thinking: "high",
        required: true,
        optional: false,
        status: "resolved",
      },
      "worker-strong": {
        model: "openai/gpt-5.4-codex",
        thinking: "high",
        required: true,
        optional: false,
        status: "resolved",
      },
      "review-logic": {
        model: null,
        required: false,
        optional: true,
        status: "disabled-optional",
        reason: "no matching model",
      },
    },
    agentBindings: {
      "zflow.planner-frontier": {
        lane: "planning-frontier",
        resolvedModel: "openai/gpt-5.4",
        tools: "read, grep, find, ls, bash, zflow_write_plan_artifact",
        maxOutput: 12000,
        maxSubagentDepth: 1,
      },
      "zflow.implement-hard": {
        lane: "worker-strong",
        resolvedModel: "openai/gpt-5.4-codex",
        tools: "read, bash, edit, write",
        maxOutput: 15000,
        maxSubagentDepth: 2,
      },
      "zflow.review-logic": {
        lane: "review-logic",
        resolvedModel: null,
      },
    },
    ...overrides,
  }
}

/** Create a temp directory for file-based tests. */
async function tempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "zflow-sync-test-"))
}

/** Write a JSON file and return its path. */
async function writeJson(dir: string, name: string, data: unknown): Promise<string> {
  const filePath = path.join(dir, name)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8")
  return filePath
}

/** Create a profile file for activation-based tests. */
async function setupProfileFile(
  content: Record<string, unknown>,
): Promise<{ repoRoot: string }> {
  const dir = await tempDir()
  const piDir = path.join(dir, ".pi")
  await fs.mkdir(piDir, { recursive: true })
  await fs.writeFile(
    path.join(piDir, "zflow-profiles.json"),
    JSON.stringify(content, null, 2),
  )
  return { repoRoot: dir }
}

// ── Tests ───────────────────────────────────────────────────────

describe("buildAgentOverrides", () => {
  it("creates overrides for all bindings with resolved models", () => {
    const cache = sampleCache()
    const overrides = buildAgentOverrides(cache)

    // Should have 2 overrides (review-logic has null model, skipped)
    const agentNames = Object.keys(overrides)
    assert.equal(agentNames.length, 2)
    assert.ok(agentNames.includes("zflow.planner-frontier"))
    assert.ok(agentNames.includes("zflow.implement-hard"))
    assert.ok(!agentNames.includes("zflow.review-logic"))
  })

  it("includes all expected fields in each override", () => {
    const cache = sampleCache()
    const overrides = buildAgentOverrides(cache)

    const planner = overrides["zflow.planner-frontier"]
    assert.equal(planner.model, "openai/gpt-5.4")
    assert.equal(planner.tools, "read, grep, find, ls, bash, zflow_write_plan_artifact")
    assert.equal(planner.maxOutput, 12000)
    assert.equal(planner.maxSubagentDepth, 1)

    const implement = overrides["zflow.implement-hard"]
    assert.equal(implement.model, "openai/gpt-5.4-codex")
    assert.equal(implement.tools, "read, bash, edit, write")
    assert.equal(implement.maxOutput, 15000)
    assert.equal(implement.maxSubagentDepth, 2)
  })

  it("returns empty object when no bindings have resolved models", () => {
    const cache = sampleCache({
      agentBindings: {
        a: { lane: "x", resolvedModel: null },
        b: { lane: "y", resolvedModel: null },
      },
    })
    const overrides = buildAgentOverrides(cache)
    assert.equal(Object.keys(overrides).length, 0)
  })

  it("returns empty object for empty agent bindings", () => {
    const cache = sampleCache({ agentBindings: {} })
    const overrides = buildAgentOverrides(cache)
    assert.equal(Object.keys(overrides).length, 0)
  })

  it("omits optional fields when not present", () => {
    const cache = sampleCache({
      agentBindings: {
        "zflow.basic": {
          lane: "scout",
          resolvedModel: "openai/gpt-4o-mini",
        },
      },
    })
    const overrides = buildAgentOverrides(cache)
    const basic = overrides["zflow.basic"]
    assert.equal(basic.model, "openai/gpt-4o-mini")
    assert.equal(basic.tools, undefined)
    assert.equal(basic.maxOutput, undefined)
    assert.equal(basic.maxSubagentDepth, undefined)
  })

  it("includes maxSubagentDepth=0 when explicitly set", () => {
    const cache = sampleCache({
      agentBindings: {
        "zflow.zero-depth": {
          lane: "scout",
          resolvedModel: "m1",
          maxSubagentDepth: 0,
        },
      },
    })
    const overrides = buildAgentOverrides(cache)
    assert.equal(overrides["zflow.zero-depth"].maxSubagentDepth, 0)
  })

  it("handles large number of bindings", () => {
    const bindings: Record<string, CachedAgentBinding> = {}
    for (let i = 0; i < 100; i++) {
      bindings[`agent-${i}`] = {
        lane: "l",
        resolvedModel: `model-${i}`,
      }
    }
    const cache = sampleCache({ agentBindings: bindings })
    const overrides = buildAgentOverrides(cache)
    assert.equal(Object.keys(overrides).length, 100)
  })

  it("does not mutate the input cache", () => {
    const cache = sampleCache()
    const originalJson = JSON.stringify(cache)
    buildAgentOverrides(cache)
    assert.equal(JSON.stringify(cache), originalJson)
  })
})

describe("formatSyncSummary", () => {
  it("renders overrides with all fields", () => {
    const overrides: Record<string, SettingsAgentOverride> = {
      "zflow.planner-frontier": {
        model: "openai/gpt-5.4",
        tools: "read, write",
        maxOutput: 12000,
        maxSubagentDepth: 1,
      },
    }

    const lines = formatSyncSummary(overrides, "/project/.pi/settings.json")
    const output = lines.join("\n")

    assert.ok(output.includes("/project/.pi/settings.json"))
    assert.ok(output.includes("zflow.planner-frontier"))
    assert.ok(output.includes("openai/gpt-5.4"))
    assert.ok(output.includes("read, write"))
    assert.ok(output.includes("12000"))
    assert.ok(output.includes("1"))
    assert.ok(output.includes("Continue?"))
  })

  it("renders overrides without optional fields", () => {
    const overrides: Record<string, SettingsAgentOverride> = {
      "zflow.basic": {
        model: "m1",
      },
    }

    const lines = formatSyncSummary(overrides, "/s.json")
    const output = lines.join("\n")

    assert.ok(output.includes("m1"))
    assert.ok(!output.includes("tools:"))
    assert.ok(!output.includes("maxOutput:"))
    assert.ok(!output.includes("maxSubagentDepth:"))
  })

  it("sorts agent names alphabetically", () => {
    const overrides: Record<string, SettingsAgentOverride> = {
      "zflow.zzz": { model: "m3" },
      "zflow.aaa": { model: "m1" },
      "zflow.mmm": { model: "m2" },
    }

    const lines = formatSyncSummary(overrides, "/s.json")
    const agentLines = lines.filter((l) => l.trim().startsWith("zflow."))

    // Should be sorted: aaa, mmm, zzz
    assert.ok(agentLines[0].includes("zflow.aaa"))
    assert.ok(agentLines[1].includes("zflow.mmm"))
    assert.ok(agentLines[2].includes("zflow.zzz"))
  })

  it("handles empty overrides", () => {
    const lines = formatSyncSummary({}, "/s.json")
    assert.ok(lines.join("\n").includes("The following agent overrides will be written"))
    assert.ok(lines.join("\n").includes("Continue?"))
  })
})

describe("syncProfileToSettings", () => {
  it("writes agent overrides to a new settings file", async () => {
    const dir = await tempDir()
    try {
      const settingsPath = path.join(dir, ".pi", "settings.json")
      const cache = sampleCache()

      const result = await syncProfileToSettings(cache, settingsPath)

      assert.equal(result.count, 2)
      assert.equal(result.settingsPath, settingsPath)
      assert.deepEqual(result.agents.sort(), [
        "zflow.implement-hard",
        "zflow.planner-frontier",
      ])

      // Verify the file was written correctly
      const written = JSON.parse(await fs.readFile(settingsPath, "utf8"))
      assert.ok(written.subagents)
      assert.ok(written.subagents.agentOverrides)
      assert.equal(
        written.subagents.agentOverrides["zflow.planner-frontier"].model,
        "openai/gpt-5.4",
      )
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("merges with existing settings without destroying unrelated keys", async () => {
    const dir = await tempDir()
    try {
      // Pre-write a settings file with unrelated keys
      const existingSettings = {
        someKey: "keep-me",
        subagents: {
          unrelatedConfig: "also-keep-me",
        },
      }
      const settingsPath = await writeJson(dir, "settings.json", existingSettings)

      const cache = sampleCache()
      const result = await syncProfileToSettings(cache, settingsPath)

      assert.equal(result.count, 2)

      // Verify existing keys are preserved
      const written = JSON.parse(await fs.readFile(settingsPath, "utf8"))
      assert.equal(written.someKey, "keep-me")
      assert.equal(written.subagents.unrelatedConfig, "also-keep-me")
      assert.ok(written.subagents.agentOverrides)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("replaces existing agentOverrides when merging", async () => {
    const dir = await tempDir()
    try {
      // Pre-write a settings file with existing agent overrides
      const existingSettings = {
        subagents: {
          agentOverrides: {
            "old-agent": { model: "old-model" },
          },
          unrelatedConfig: "keep-me",
        },
      }
      const settingsPath = await writeJson(dir, "settings.json", existingSettings)

      const cache = sampleCache()
      const result = await syncProfileToSettings(cache, settingsPath)

      assert.equal(result.count, 2)

      const written = JSON.parse(await fs.readFile(settingsPath, "utf8"))
      // Old overrides should be REPLACED by new ones
      assert.equal(written.subagents.agentOverrides["old-agent"], undefined)
      // Unrelated config should be preserved
      assert.equal(written.subagents.unrelatedConfig, "keep-me")
      // New overrides should be written
      assert.equal(
        written.subagents.agentOverrides["zflow.planner-frontier"].model,
        "openai/gpt-5.4",
      )
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("returns count=0 and empty agents when no bindings have resolved models", async () => {
    const dir = await tempDir()
    try {
      const settingsPath = path.join(dir, "settings.json")
      const cache = sampleCache({
        agentBindings: {
          a: { lane: "x", resolvedModel: null },
        },
      })

      const result = await syncProfileToSettings(cache, settingsPath)
      assert.equal(result.count, 0)
      assert.deepEqual(result.agents, [])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("creates parent directories automatically", async () => {
    const dir = await tempDir()
    try {
      const deepPath = path.join(dir, "a", "b", "c", "settings.json")
      const cache = sampleCache()

      const result = await syncProfileToSettings(cache, deepPath)
      assert.equal(result.count, 2)

      // File should exist at the deep path
      const exists = await fs.access(deepPath).then(() => true).catch(() => false)
      assert.equal(exists, true)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("writes atomically (no temp left behind)", async () => {
    const dir = await tempDir()
    try {
      const settingsPath = path.join(dir, "settings.json")
      const cache = sampleCache()

      await syncProfileToSettings(cache, settingsPath)

      // No .tmp files should remain
      const entries = await fs.readdir(dir)
      const tmpFiles = entries.filter((e) => e.endsWith(".tmp"))
      assert.equal(tmpFiles.length, 0)
      assert.ok(entries.includes("settings.json"))
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("handles concurrent safe overwrites", async () => {
    const dir = await tempDir()
    try {
      const settingsPath = path.join(dir, "settings.json")

      // Write twice in sequence
      const cache1 = sampleCache({
        agentBindings: {
          agentA: { lane: "x", resolvedModel: "model-a" },
        },
      })
      await syncProfileToSettings(cache1, settingsPath)

      const cache2 = sampleCache({
        agentBindings: {
          agentB: { lane: "y", resolvedModel: "model-b" },
        },
      })
      await syncProfileToSettings(cache2, settingsPath)

      // Second write should have replaced the first's overrides (merged)
      const written = JSON.parse(await fs.readFile(settingsPath, "utf8"))
      assert.ok(written.subagents.agentOverrides.agentB)
      assert.equal(written.subagents.agentOverrides.agentB.model, "model-b")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe("sync-to-settings: normal activation does not trigger sync", () => {
  it("activateProfile does not write to .pi/settings.json", async () => {
    const { repoRoot } = await setupProfileFile({
      default: {
        lanes: {
          scout: { required: true, preferredModels: ["m1"] },
        },
        agentBindings: {
          s: { lane: "scout" },
        },
      },
    })

    const registry = makeRegistry([model("m1")])

    try {
      await activateProfile("default", { repoRoot, registry })

      // Verify no settings.json was created
      const settingsPath = path.join(repoRoot, ".pi", "settings.json")
      const exists = await fs.access(settingsPath).then(() => true).catch(() => false)
      assert.equal(exists, false, "activateProfile should not create .pi/settings.json")
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })

  it("ensureResolved does not write to .pi/settings.json", async () => {
    const { repoRoot } = await setupProfileFile({
      default: {
        lanes: {
          scout: { required: true, preferredModels: ["m1"] },
        },
        agentBindings: {
          s: { lane: "scout" },
        },
      },
    })

    const registry = makeRegistry([model("m1")])
    const cacheDir = await tempDir()
    const cachePath = path.join(cacheDir, "active-profile.json")

    try {
      await ensureResolved(undefined, { repoRoot, registry, cachePath })

      // Verify no settings.json was created in the repo
      const settingsPath = path.join(repoRoot, ".pi", "settings.json")
      const exists = await fs.access(settingsPath).then(() => true).catch(() => false)
      assert.equal(exists, false, "ensureResolved should not create .pi/settings.json")
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
      await fs.rm(cacheDir, { recursive: true, force: true })
    }
  })
})
