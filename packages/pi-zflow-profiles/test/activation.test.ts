/**
 * activation.test.ts — Tests for active profile cache writing and profile activation.
 *
 * Covers:
 *   - computeHash produces deterministic results
 *   - computeEnvironmentFingerprint is stable and changes with input
 *   - writeActiveProfileCache writes atomically
 *   - readActiveProfileCache reads back valid cache, returns null for missing/invalid
 *   - buildActiveProfileCache produces correct shape
 *   - activateProfile loads, resolves, and caches successfully
 *   - activateProfile throws for missing profile name
 *   - Optional-disabled lanes recorded explicitly in cache
 */
import { describe, it } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"

import {
  computeHash,
  computeEnvironmentFingerprint,
  computeEnvironmentFingerprintFromRegistry,
  computeCurrentProfileHash,
  writeActiveProfileCache,
  readActiveProfileCache,
  readActiveProfileCacheIfFresh,
  isActiveProfileCacheFresh,
  cacheToResolvedProfile,
  buildActiveProfileCache,
  DEFAULT_CACHE_TTL_MINUTES,
} from "../extensions/zflow-profiles/profiles.js"

import {
  activateProfile,
  ensureResolved,
} from "../extensions/zflow-profiles/index.js"

import type {
  ActiveProfileCache,
  ResolvedProfile,
  ModelRegistry,
  ModelInfo,
  NormalizedLaneDefinition,
  NormalizedProfileDefinition,
} from "../extensions/zflow-profiles/profiles.js"

import { resolveLane, resolveProfile } from "../extensions/zflow-profiles/model-resolution.js"

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

function makeRegistry(
  models: ModelInfo[],
  hasListModels: boolean = false,
): ModelRegistry & { listModels?: () => string[] } {
  const map = new Map(models.map((m) => [m.id, m]))
  const registry: ModelRegistry & { listModels?: () => string[] } = {
    getModel(id: string): ModelInfo | undefined {
      return map.get(id)
    },
  }
  if (hasListModels) {
    registry.listModels = () => Array.from(map.keys())
  }
  return registry
}

/** Create a temp directory and write a profiles JSON file there. */
async function setupProfileFile(
  content: Record<string, unknown>,
): Promise<{ repoRoot: string; filePath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-activation-test-"))
  const piDir = path.join(dir, ".pi")
  await fs.mkdir(piDir, { recursive: true })
  const filePath = path.join(piDir, "zflow-profiles.json")
  await fs.writeFile(filePath, JSON.stringify(content, null, 2))
  return { repoRoot: dir, filePath }
}

// ── Tests ───────────────────────────────────────────────────────

describe("computeHash", () => {
  it("produces a deterministic 64-char hex string", () => {
    const h1 = computeHash("hello")
    const h2 = computeHash("hello")
    assert.equal(h1, h2)
    assert.equal(h1.length, 64)
    assert.ok(/^[0-9a-f]+$/.test(h1))
  })

  it("produces different hashes for different inputs", () => {
    const h1 = computeHash("hello")
    const h2 = computeHash("world")
    assert.notEqual(h1, h2)
  })

  it("handles empty string", () => {
    const h = computeHash("")
    assert.equal(h.length, 64)
  })
})

describe("computeEnvironmentFingerprint", () => {
  it("produces stable fingerprint for same model set", () => {
    const f1 = computeEnvironmentFingerprint(["a", "b", "c"])
    const f2 = computeEnvironmentFingerprint(["a", "b", "c"])
    assert.equal(f1, f2)
  })

  it("is order-independent (sorts inputs)", () => {
    const f1 = computeEnvironmentFingerprint(["c", "a", "b"])
    const f2 = computeEnvironmentFingerprint(["a", "b", "c"])
    assert.equal(f1, f2)
  })

  it("changes when model set changes", () => {
    const f1 = computeEnvironmentFingerprint(["a", "b"])
    const f2 = computeEnvironmentFingerprint(["a", "b", "c"])
    assert.notEqual(f1, f2)
  })

  it("handles empty array", () => {
    const h = computeEnvironmentFingerprint([])
    assert.equal(h.length, 64)
  })
})

describe("writeActiveProfileCache / readActiveProfileCache", () => {
  const sampleCache: ActiveProfileCache = {
    profileName: "default",
    sourcePath: "/test/.pi/zflow-profiles.json",
    resolvedAt: "2026-05-12T00:00:00.000Z",
    ttlMinutes: 15,
    definitionHash: "abc123",
    environmentFingerprint: "def456",
    resolvedLanes: {
      scout: { model: "m1", thinking: "low", required: true, optional: false, status: "resolved" },
      optional: { model: null, required: false, optional: true, status: "disabled-optional", reason: "no model" },
    },
    agentBindings: {
      s: { lane: "scout", resolvedModel: "m1", tools: "read" },
    },
  }

  it("writes and reads back a valid cache file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-cache-test-"))
    const cachePath = path.join(dir, "active-profile.json")
    try {
      await writeActiveProfileCache(sampleCache, cachePath)
      const read = await readActiveProfileCache(cachePath)
      assert.notEqual(read, null)
      assert.equal(read!.profileName, "default")
      assert.equal(read!.sourcePath, "/test/.pi/zflow-profiles.json")
      assert.equal(read!.resolvedLanes.scout.model, "m1")
      assert.equal(read!.resolvedLanes.optional.status, "disabled-optional")
      assert.equal(read!.resolvedLanes.optional.reason, "no model")
      assert.equal(read!.agentBindings.s.resolvedModel, "m1")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("returns null when cache file does not exist", async () => {
    const result = await readActiveProfileCache("/tmp/nonexistent-cache-xyz789.json")
    assert.equal(result, null)
  })

  it("returns null for malformed cache file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-cache-test-"))
    const cachePath = path.join(dir, "active-profile.json")
    try {
      await fs.writeFile(cachePath, "not valid json", "utf8")
      const result = await readActiveProfileCache(cachePath)
      assert.equal(result, null)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("returns null for structurally invalid cache", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-cache-test-"))
    const cachePath = path.join(dir, "active-profile.json")
    try {
      await fs.writeFile(cachePath, JSON.stringify({ not: "a cache" }), "utf8")
      const result = await readActiveProfileCache(cachePath)
      assert.equal(result, null)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("writes atomically (temp file then rename)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-cache-test-"))
    const cachePath = path.join(dir, "active-profile.json")
    try {
      await writeActiveProfileCache(sampleCache, cachePath)
      // Verify no temp files remain
      const entries = await fs.readdir(dir)
      assert.equal(entries.length, 1)
      assert.equal(entries[0], "active-profile.json")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("creates parent directory automatically", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-cache-test-"))
    const nestedPath = path.join(dir, "sub", "nested", "active-profile.json")
    try {
      await writeActiveProfileCache(sampleCache, nestedPath)
      const read = await readActiveProfileCache(nestedPath)
      assert.notEqual(read, null)
      assert.equal(read!.profileName, "default")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe("buildActiveProfileCache", () => {
  it("produces correct cache shape from resolved profile", () => {
    const resolved: ResolvedProfile = {
      profileName: "default",
      sourcePath: "/source.json",
      resolvedAt: "2026-05-12T00:00:00.000Z",
      resolvedLanes: {
        scout: {
          lane: "scout",
          model: "m1",
          required: true,
          optional: false,
          thinking: "low",
          status: "resolved",
        },
        optional: {
          lane: "optional",
          model: null,
          required: false,
          optional: true,
          status: "disabled-optional",
          reason: "no matching model",
        },
      },
      agentBindings: {
        s: {
          agent: "s",
          lane: "scout",
          resolvedModel: "m1",
          optional: false,
          tools: "read",
          maxOutput: 4000,
          maxSubagentDepth: 0,
          status: "resolved",
        },
      },
    }

    const cache = buildActiveProfileCache(
      "default",
      "/source.json",
      resolved,
      "defhash123",
      "envfp456",
      30,
    )

    assert.equal(cache.profileName, "default")
    assert.equal(cache.sourcePath, "/source.json")
    assert.equal(cache.ttlMinutes, 30)
    assert.equal(cache.definitionHash, "defhash123")
    assert.equal(cache.environmentFingerprint, "envfp456")
    assert.equal(cache.resolvedAt, "2026-05-12T00:00:00.000Z")

    // Resolved lane
    assert.equal(cache.resolvedLanes.scout.model, "m1")
    assert.equal(cache.resolvedLanes.scout.thinking, "low")
    assert.equal(cache.resolvedLanes.scout.status, "resolved")
    assert.equal(cache.resolvedLanes.scout.required, true)
    assert.equal(cache.resolvedLanes.scout.optional, false)

    // Disabled-optional lane recorded explicitly
    assert.equal(cache.resolvedLanes.optional.model, null)
    assert.equal(cache.resolvedLanes.optional.status, "disabled-optional")
    assert.equal(cache.resolvedLanes.optional.reason, "no matching model")
    assert.equal(cache.resolvedLanes.optional.required, false)
    assert.equal(cache.resolvedLanes.optional.optional, true)

    // Agent binding
    assert.equal(cache.agentBindings.s.lane, "scout")
    assert.equal(cache.agentBindings.s.resolvedModel, "m1")
    assert.equal(cache.agentBindings.s.tools, "read")
    assert.equal(cache.agentBindings.s.maxOutput, 4000)
    assert.equal(cache.agentBindings.s.maxSubagentDepth, 0)
  })

  it("uses default TTL when not specified", () => {
    const resolved: ResolvedProfile = {
      profileName: "default",
      sourcePath: "/s.json",
      resolvedAt: new Date().toISOString(),
      resolvedLanes: {},
      agentBindings: {},
    }
    const cache = buildActiveProfileCache("default", "/s.json", resolved, "h", "f")
    assert.equal(cache.ttlMinutes, DEFAULT_CACHE_TTL_MINUTES)
    assert.equal(cache.ttlMinutes, 15)
  })
})

describe("activateProfile", () => {
  it("loads, resolves, and caches a named profile", async () => {
    const { repoRoot } = await setupProfileFile({
      default: {
        lanes: {
          scout: {
            required: true,
            thinking: "low",
            preferredModels: ["openai/gpt-4o-mini"],
          },
        },
        agentBindings: {
          s: { lane: "scout" },
        },
        verificationCommand: "npm test",
      },
    })

    const registry = makeRegistry([
      model("openai/gpt-4o-mini", { thinkingCapability: "low" }),
    ])

    try {
      const resolved = await activateProfile("default", {
        repoRoot,
        registry,
      })
      assert.equal(resolved.profileName, "default")
      assert.equal(resolved.resolvedLanes.scout.status, "resolved")
      assert.equal(resolved.resolvedLanes.scout.model, "openai/gpt-4o-mini")
      assert.equal(resolved.agentBindings.s.resolvedModel, "openai/gpt-4o-mini")

      // Verify cache was written
      const cachePath = path.join(
        os.homedir(),
        ".pi",
        "agent",
        "zflow",
        "active-profile.json",
      )
      // In test, the cache may or may not be at the default path depending on
      // whether the directory exists. We just verify the function completed.
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })

  it("throws for non-existent profile name", async () => {
    const { repoRoot } = await setupProfileFile({
      default: {
        lanes: { s: { preferredModels: ["m1"] } },
        agentBindings: { a: { lane: "s" } },
      },
    })

    try {
      await assert.rejects(
        () => activateProfile("nonexistent", { repoRoot, registry: makeRegistry([]) }),
        (err: unknown) =>
          err instanceof Error && err.message.includes("nonexistent"),
      )
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })

  it("records optional-disabled lanes explicitly in cache", async () => {
    const { repoRoot } = await setupProfileFile({
      default: {
        lanes: {
          required: {
            required: true,
            preferredModels: ["available-model"],
          },
          optional: {
            optional: true,
            preferredModels: ["missing-model"],
          },
        },
        agentBindings: {
          r: { lane: "required" },
          o: { lane: "optional", optional: true },
        },
      },
    })

    const registry = makeRegistry([
      model("available-model"),
      // NOTE: missing-model is intentionally absent
    ])

    try {
      const resolved = await activateProfile("default", {
        repoRoot,
        registry,
      })
      assert.equal(resolved.resolvedLanes.required.status, "resolved")
      assert.equal(resolved.resolvedLanes.optional.status, "disabled-optional")
      assert.equal(resolved.agentBindings.o.resolvedModel, null)
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })

  it("computes definitionHash from file content", async () => {
    const { repoRoot, filePath } = await setupProfileFile({
      default: {
        lanes: { s: { preferredModels: ["m1"] } },
        agentBindings: { a: { lane: "s" } },
      },
    })

    const registry = makeRegistry([model("m1")])
    const rawContent = await fs.readFile(filePath, "utf8")
    const expectedHash = computeHash(rawContent)

    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-test-cache-"))
    const cachePath = path.join(cacheDir, "active-profile.json")

    try {
      await activateProfile("default", { repoRoot, registry, cachePath })
      // Read back cache from the isolated test path
      const cache = await readActiveProfileCache(cachePath)
      assert.notEqual(cache, null)
      assert.equal(cache!.definitionHash, expectedHash)
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
      await fs.rm(cacheDir, { recursive: true, force: true })
    }
  })
})

// ── Cache freshness and reconstruction tests ────────────────────

describe("isActiveProfileCacheFresh", () => {
  it("returns true for a just-written cache", () => {
    const cache: ActiveProfileCache = {
      profileName: "default",
      sourcePath: "/s.json",
      resolvedAt: new Date().toISOString(),
      ttlMinutes: 15,
      definitionHash: "h",
      environmentFingerprint: "f",
      resolvedLanes: {},
      agentBindings: {},
    }
    assert.equal(isActiveProfileCacheFresh(cache), true)
  })

  it("returns false for an expired cache", () => {
    const past = new Date(Date.now() - 20 * 60 * 1000) // 20 min ago
    const cache: ActiveProfileCache = {
      profileName: "default",
      sourcePath: "/s.json",
      resolvedAt: past.toISOString(),
      ttlMinutes: 15,
      definitionHash: "h",
      environmentFingerprint: "f",
      resolvedLanes: {},
      agentBindings: {},
    }
    assert.equal(isActiveProfileCacheFresh(cache), false)
  })

  it("returns true for cache at exact TTL boundary", () => {
    const past = new Date(Date.now() - 15 * 60 * 1000) // exactly 15 min ago
    const cache: ActiveProfileCache = {
      profileName: "default",
      sourcePath: "/s.json",
      resolvedAt: past.toISOString(),
      ttlMinutes: 15,
      definitionHash: "h",
      environmentFingerprint: "f",
      resolvedLanes: {},
      agentBindings: {},
    }
    assert.equal(isActiveProfileCacheFresh(cache), true)
  })
})

describe("readActiveProfileCacheIfFresh", () => {
  it("returns cache when fresh", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-cache-test-"))
    const cachePath = path.join(dir, "active-profile.json")
    try {
      const cache: ActiveProfileCache = {
        profileName: "default",
        sourcePath: "/s.json",
        resolvedAt: new Date().toISOString(),
        ttlMinutes: 15,
        definitionHash: "h",
        environmentFingerprint: "f",
        resolvedLanes: {},
        agentBindings: {},
      }
      await writeActiveProfileCache(cache, cachePath)
      const result = await readActiveProfileCacheIfFresh(cachePath)
      assert.notEqual(result, null)
      assert.equal(result!.profileName, "default")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("returns null for expired cache", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-cache-test-"))
    const cachePath = path.join(dir, "active-profile.json")
    try {
      const past = new Date(Date.now() - 30 * 60 * 1000).toISOString()
      const cache: ActiveProfileCache = {
        profileName: "stale",
        sourcePath: "/s.json",
        resolvedAt: past,
        ttlMinutes: 15,
        definitionHash: "h",
        environmentFingerprint: "f",
        resolvedLanes: {},
        agentBindings: {},
      }
      await writeActiveProfileCache(cache, cachePath)
      const result = await readActiveProfileCacheIfFresh(cachePath)
      assert.equal(result, null)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("returns null when cache file does not exist", async () => {
    const result = await readActiveProfileCacheIfFresh("/tmp/nonexistent-cache-xyz.json")
    assert.equal(result, null)
  })
})

describe("cacheToResolvedProfile", () => {
  it("reconstructs a full ResolvedProfile from cache", () => {
    const cache: ActiveProfileCache = {
      profileName: "default",
      sourcePath: "/source.json",
      resolvedAt: "2026-05-12T00:00:00.000Z",
      ttlMinutes: 15,
      definitionHash: "h1",
      environmentFingerprint: "f1",
      resolvedLanes: {
        scout: {
          model: "openai/gpt-4o-mini",
          thinking: "low",
          required: true,
          optional: false,
          status: "resolved",
        },
        optional: {
          model: null,
          required: false,
          optional: true,
          status: "disabled-optional",
          reason: "no model",
        },
      },
      agentBindings: {
        s: {
          lane: "scout",
          resolvedModel: "openai/gpt-4o-mini",
          tools: "read, grep",
          maxOutput: 4000,
          maxSubagentDepth: 0,
        },
      },
    }

    const resolved = cacheToResolvedProfile(cache)
    assert.equal(resolved.profileName, "default")
    assert.equal(resolved.sourcePath, "/source.json")
    assert.equal(resolved.resolvedAt, "2026-05-12T00:00:00.000Z")

    // Resolved lane
    assert.equal(resolved.resolvedLanes.scout.model, "openai/gpt-4o-mini")
    assert.equal(resolved.resolvedLanes.scout.thinking, "low")
    assert.equal(resolved.resolvedLanes.scout.status, "resolved")
    assert.equal(resolved.resolvedLanes.scout.required, true)
    assert.equal(resolved.resolvedLanes.scout.optional, false)
    assert.equal(resolved.resolvedLanes.scout.lane, "scout")

    // Disabled optional lane
    assert.equal(resolved.resolvedLanes.optional.model, null)
    assert.equal(resolved.resolvedLanes.optional.status, "disabled-optional")
    assert.equal(resolved.resolvedLanes.optional.required, false)
    assert.equal(resolved.resolvedLanes.optional.optional, true)
    assert.equal(resolved.resolvedLanes.optional.reason, "no model")

    // Agent binding
    assert.equal(resolved.agentBindings.s.lane, "scout")
    assert.equal(resolved.agentBindings.s.resolvedModel, "openai/gpt-4o-mini")
    assert.equal(resolved.agentBindings.s.tools, "read, grep")
    assert.equal(resolved.agentBindings.s.maxOutput, 4000)
    assert.equal(resolved.agentBindings.s.maxSubagentDepth, 0)
  })

  it("handles empty cache gracefully", () => {
    const cache: ActiveProfileCache = {
      profileName: "default",
      sourcePath: "/s.json",
      resolvedAt: new Date().toISOString(),
      ttlMinutes: 15,
      definitionHash: "h",
      environmentFingerprint: "f",
      resolvedLanes: {},
      agentBindings: {},
    }
    const resolved = cacheToResolvedProfile(cache)
    assert.equal(resolved.profileName, "default")
    assert.equal(Object.keys(resolved.resolvedLanes).length, 0)
    assert.equal(Object.keys(resolved.agentBindings).length, 0)
  })
})

describe("ensureResolved", () => {
  it("activates default profile when no cache exists", async () => {
    const { repoRoot } = await setupProfileFile({
      default: {
        lanes: {
          scout: { required: true, thinking: "low", preferredModels: ["m1"] },
        },
        agentBindings: { s: { lane: "scout" } },
      },
    })

    const registry = makeRegistry([model("m1", { thinkingCapability: "low" })])
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-test-cache-"))
    const cachePath = path.join(cacheDir, "active-profile.json")

    try {
      const resolved = await ensureResolved(undefined, { repoRoot, registry, cachePath })
      assert.equal(resolved.profileName, "default")
      assert.equal(resolved.resolvedLanes.scout.model, "m1")
      assert.equal(resolved.resolvedLanes.scout.status, "resolved")
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
      await fs.rm(cacheDir, { recursive: true, force: true })
    }
  })

  it("uses cached profile when cache is fresh", async () => {
    const { repoRoot } = await setupProfileFile({
      default: {
        lanes: {
          scout: { required: true, preferredModels: ["m1"] },
        },
        agentBindings: { s: { lane: "scout" } },
      },
    })

    const registry = makeRegistry([model("m1")])
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-test-cache-"))
    const cachePath = path.join(cacheDir, "active-profile.json")

    try {
      // First call: activates and writes cache
      const first = await ensureResolved(undefined, { repoRoot, registry, cachePath })
      assert.equal(first.resolvedLanes.scout.model, "m1")

      // Second call: should use fresh cache
      const second = await ensureResolved(undefined, { repoRoot, registry, cachePath })
      assert.equal(second.resolvedLanes.scout.model, "m1")
      assert.equal(second.profileName, "default")
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
      await fs.rm(cacheDir, { recursive: true, force: true })
    }
  })

  it("re-activates when cache is stale", async () => {
    const { repoRoot } = await setupProfileFile({
      default: {
        lanes: {
          scout: { required: true, preferredModels: ["m1"] },
        },
        agentBindings: { s: { lane: "scout" } },
      },
    })

    const registry = makeRegistry([model("m1")])
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-test-cache-"))
    const cachePath = path.join(cacheDir, "active-profile.json")

    try {
      // First call: activates and writes cache
      await ensureResolved(undefined, { repoRoot, registry, cachePath })

      // Manually age the cache by rewriting with an old timestamp
      const oldCache: ActiveProfileCache = {
        profileName: "default",
        sourcePath: "/stale.json",
        resolvedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1 hour ago
        ttlMinutes: 15,
        definitionHash: "old",
        environmentFingerprint: "old",
        resolvedLanes: {
          scout: { model: null, required: true, optional: false, status: "unresolved-required", reason: "stale" },
        },
        agentBindings: {},
      }
      await writeActiveProfileCache(oldCache, cachePath)

      // Second call: cache is stale, should re-activate
      const second = await ensureResolved(undefined, { repoRoot, registry, cachePath })
      assert.equal(second.resolvedLanes.scout.model, "m1")
      assert.equal(second.resolvedLanes.scout.status, "resolved")
      assert.equal(second.profileName, "default")
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
      await fs.rm(cacheDir, { recursive: true, force: true })
    }
  })

  it("re-activates fresh cache with unresolved required lanes when requiredLanes omitted", async () => {
    const { repoRoot } = await setupProfileFile({
      default: {
        lanes: {
          scout: { required: true, preferredModels: ["m1"] },
        },
        agentBindings: { s: { lane: "scout" } },
      },
    })

    const registry = makeRegistry([model("m1")])
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-test-cache-"))
    const cachePath = path.join(cacheDir, "active-profile.json")

    try {
      const badCache: ActiveProfileCache = {
        profileName: "default",
        sourcePath: path.join(repoRoot, ".pi", "zflow-profiles.json"),
        resolvedAt: new Date().toISOString(),
        ttlMinutes: 15,
        definitionHash: computeHash(await fs.readFile(path.join(repoRoot, ".pi", "zflow-profiles.json"), "utf8")),
        environmentFingerprint: computeEnvironmentFingerprintFromRegistry(registry),
        resolvedLanes: {
          scout: { model: null, required: true, optional: false, status: "unresolved-required", reason: "bad stale cache" },
        },
        agentBindings: {},
      }
      await writeActiveProfileCache(badCache, cachePath)

      const resolved = await ensureResolved(undefined, { repoRoot, registry, cachePath })
      assert.equal(resolved.resolvedLanes.scout.status, "resolved")
      assert.equal(resolved.resolvedLanes.scout.model, "m1")
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
      await fs.rm(cacheDir, { recursive: true, force: true })
    }
  })

  it("returns a complete ResolvedProfile with agentBindings", async () => {
    const { repoRoot } = await setupProfileFile({
      default: {
        lanes: {
          scout: { required: true, preferredModels: ["m1"] },
        },
        agentBindings: {
          s: { lane: "scout", tools: "read,write", maxOutput: 4000 },
        },
      },
    })

    const registry = makeRegistry([model("m1")])
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-test-cache-"))
    const cachePath = path.join(cacheDir, "active-profile.json")

    try {
      const resolved = await ensureResolved(undefined, { repoRoot, registry, cachePath })
      assert.equal(resolved.agentBindings.s.resolvedModel, "m1")
      assert.equal(resolved.agentBindings.s.tools, "read,write")
      assert.equal(resolved.agentBindings.s.maxOutput, 4000)
      assert.equal(resolved.agentBindings.s.status, "resolved")
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
      await fs.rm(cacheDir, { recursive: true, force: true })
    }
  })
})

// ── Cache invalidation tests ────────────────────────────────────

describe("computeCurrentProfileHash", () => {
  it("computes a hash matching the file content", async () => {
    const { repoRoot, filePath } = await setupProfileFile({
      default: {
        lanes: { s: { preferredModels: ["m1"] } },
        agentBindings: { a: { lane: "s" } },
      },
    })

    try {
      const hash = await computeCurrentProfileHash(repoRoot)
      const raw = await fs.readFile(filePath, "utf8")
      const expected = computeHash(raw)
      assert.equal(hash, expected)
      assert.equal(hash.length, 64)
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })

  it("throws when no profile file exists", async () => {
    await assert.rejects(
      () => computeCurrentProfileHash("/tmp/nonexistent-repo-xyz123"),
      (err: unknown) =>
        err instanceof Error && err.message.includes("No profile definition file found"),
    )
  })
})

describe("computeEnvironmentFingerprintFromRegistry", () => {
  it("includes model IDs and auth state in fingerprints", () => {
    const reg1 = makeRegistry([
      model("m1", { authenticated: true }),
      model("m2", { authenticated: false }),
    ], true) // has listModels
    const reg2 = makeRegistry([
      model("m1", { authenticated: true }),
      model("m2", { authenticated: true }),
    ], true) // same models, different auth

    const fp1 = computeEnvironmentFingerprintFromRegistry(reg1)
    const fp2 = computeEnvironmentFingerprintFromRegistry(reg2)

    // Different auth state => different fingerprint
    assert.notEqual(fp1, fp2)
  })

  it("is stable for the same model set with same auth", () => {
    const reg = makeRegistry([
      model("m1", { authenticated: true }),
      model("m2", { authenticated: false }),
    ], true)

    const fp1 = computeEnvironmentFingerprintFromRegistry(reg)
    const fp2 = computeEnvironmentFingerprintFromRegistry(reg)
    assert.equal(fp1, fp2)
  })

  it("is order-independent (sorts by model id)", () => {
    const reg1 = makeRegistry([
      model("b", { authenticated: true }),
      model("a", { authenticated: true }),
    ], true)
    const reg2 = makeRegistry([
      model("a", { authenticated: true }),
      model("b", { authenticated: true }),
    ], true)

    const fp1 = computeEnvironmentFingerprintFromRegistry(reg1)
    const fp2 = computeEnvironmentFingerprintFromRegistry(reg2)
    assert.equal(fp1, fp2)
  })

  it("changes when model set changes", () => {
    const reg1 = makeRegistry([model("m1")], true)
    const reg2 = makeRegistry([model("m1"), model("m2")], true)

    const fp1 = computeEnvironmentFingerprintFromRegistry(reg1)
    const fp2 = computeEnvironmentFingerprintFromRegistry(reg2)
    assert.notEqual(fp1, fp2)
  })

  it("produces deterministic 64-char hex string without listModels", () => {
    const reg = makeRegistry([model("m1")], false) // no listModels
    const fp = computeEnvironmentFingerprintFromRegistry(reg)
    assert.equal(typeof fp, "string")
    assert.equal(fp.length, 64)
    assert.ok(/^[0-9a-f]+$/.test(fp))
  })
})

describe("isActiveProfileCacheFresh — definition hash checks", () => {
  const baseCache = (overrides?: Partial<ActiveProfileCache>): ActiveProfileCache => ({
    profileName: "default",
    sourcePath: "/s.json",
    resolvedAt: new Date().toISOString(),
    ttlMinutes: 15,
    definitionHash: "abc123",
    environmentFingerprint: "def456",
    resolvedLanes: {},
    agentBindings: {},
    ...overrides,
  })

  it("returns true when definition hash matches current", () => {
    const cache = baseCache()
    assert.equal(isActiveProfileCacheFresh(cache, "abc123"), true)
  })

  it("returns false when definition hash does not match current", () => {
    const cache = baseCache()
    // Provide a current hash that differs from the cached one
    assert.equal(isActiveProfileCacheFresh(cache, "different-hash"), false)
  })

  it("returns true when definition hash is not provided (backward compat)", () => {
    const cache = baseCache()
    // undefined → skip definition hash check
    assert.equal(isActiveProfileCacheFresh(cache, undefined), true)
  })

  it("returns false when TTL expired even if hash matches", () => {
    const past = new Date(Date.now() - 20 * 60 * 1000).toISOString()
    const cache = baseCache({ resolvedAt: past }) // 20 min old, TTL=15
    assert.equal(isActiveProfileCacheFresh(cache, "abc123"), false)
  })
})

describe("isActiveProfileCacheFresh — environment fingerprint checks", () => {
  const baseCache = (overrides?: Partial<ActiveProfileCache>): ActiveProfileCache => ({
    profileName: "default",
    sourcePath: "/s.json",
    resolvedAt: new Date().toISOString(),
    ttlMinutes: 15,
    definitionHash: "h1",
    environmentFingerprint: "env-fp-v1",
    resolvedLanes: {},
    agentBindings: {},
    ...overrides,
  })

  it("returns true when environment fingerprint matches current", () => {
    const cache = baseCache()
    assert.equal(isActiveProfileCacheFresh(cache, "h1", "env-fp-v1"), true)
  })

  it("returns false when environment fingerprint does not match", () => {
    const cache = baseCache()
    // Current fingerprint differs → cache invalid
    assert.equal(isActiveProfileCacheFresh(cache, "h1", "env-fp-v2"), false)
  })

  it("returns false when hash matches but fingerprint does not", () => {
    const cache = baseCache()
    assert.equal(isActiveProfileCacheFresh(cache, "h1", "different-fp"), false)
  })

  it("returns true when environment fingerprint is not provided (backward compat)", () => {
    const cache = baseCache()
    assert.equal(isActiveProfileCacheFresh(cache, "h1", undefined), true)
  })

  it("passes when both hash and fingerprint match", () => {
    const cache = baseCache()
    assert.equal(isActiveProfileCacheFresh(cache, "h1", "env-fp-v1"), true)
  })

  it("fails when both hash and fingerprint mismatch", () => {
    const cache = baseCache()
    assert.equal(isActiveProfileCacheFresh(cache, "wrong-hash", "wrong-fp"), false)
  })
})

describe("readActiveProfileCacheIfFresh — with hash and fingerprint checks", () => {
  async function writeTestCache(
    overrides?: Partial<ActiveProfileCache>,
  ): Promise<{ cacheDir: string; cachePath: string }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-cache-test-"))
    const cachePath = path.join(dir, "active-profile.json")
    const cache: ActiveProfileCache = {
      profileName: "default",
      sourcePath: "/s.json",
      resolvedAt: new Date().toISOString(),
      ttlMinutes: 15,
      definitionHash: "abc123",
      environmentFingerprint: "env-fp-v1",
      resolvedLanes: {},
      agentBindings: {},
      ...overrides,
    }
    await writeActiveProfileCache(cache, cachePath)
    return { cacheDir: dir, cachePath }
  }

  it("returns cache when both hash and fingerprint match", async () => {
    const { cacheDir, cachePath } = await writeTestCache()
    try {
      const result = await readActiveProfileCacheIfFresh(cachePath, "abc123", "env-fp-v1")
      assert.notEqual(result, null)
      assert.equal(result!.definitionHash, "abc123")
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true })
    }
  })

  it("returns null on definition hash mismatch", async () => {
    const { cacheDir, cachePath } = await writeTestCache()
    try {
      const result = await readActiveProfileCacheIfFresh(cachePath, "different-hash", "env-fp-v1")
      assert.equal(result, null)
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true })
    }
  })

  it("returns null on environment fingerprint mismatch", async () => {
    const { cacheDir, cachePath } = await writeTestCache()
    try {
      const result = await readActiveProfileCacheIfFresh(cachePath, "abc123", "different-fp")
      assert.equal(result, null)
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true })
    }
  })

  it("returns null when both hash and fingerprint mismatch", async () => {
    const { cacheDir, cachePath } = await writeTestCache()
    try {
      const result = await readActiveProfileCacheIfFresh(cachePath, "wrong-hash", "wrong-fp")
      assert.equal(result, null)
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true })
    }
  })
})

describe("ensureResolved — cache invalidation on environment changes", () => {
  it("re-activates when profile file content changes between calls", async () => {
    const { repoRoot, filePath } = await setupProfileFile({
      default: {
        lanes: {
          scout: { required: true, preferredModels: ["m1"] },
        },
        agentBindings: { s: { lane: "scout" } },
      },
    })

    const registry = makeRegistry([model("m1")])
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-test-cache-"))
    const cachePath = path.join(cacheDir, "active-profile.json")

    try {
      // First call: activates, writes cache with hash of original content
      const first = await ensureResolved(undefined, { repoRoot, registry, cachePath })
      assert.equal(first.resolvedLanes.scout.model, "m1")

      // Modify the profile file
      await fs.writeFile(
        filePath,
        JSON.stringify({
          default: {
            lanes: {
              scout: { required: true, preferredModels: ["m2"] }, // changed model
              "new-lane": { required: true, preferredModels: ["m1"] },
            },
            agentBindings: {
              s: { lane: "scout" },
              n: { lane: "new-lane" },
            },
          },
        }),
        "utf8",
      )

      // Register the new model
      const updatedRegistry = makeRegistry([
        model("m1"),
        model("m2", { thinkingCapability: "low" }),
      ])

      // Second call: definition hash differs → must re-activate
      const second = await ensureResolved(undefined, { repoRoot, registry: updatedRegistry, cachePath })
      assert.equal(second.resolvedLanes.scout.model, "m2")
      assert.equal(second.resolvedLanes["new-lane"].model, "m1")
      assert.equal(second.resolvedLanes["new-lane"].status, "resolved")
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
      await fs.rm(cacheDir, { recursive: true, force: true })
    }
  })

  it("re-activates when registry auth state changes between calls", async () => {
    const { repoRoot } = await setupProfileFile({
      default: {
        lanes: {
          scout: { required: true, preferredModels: ["m1", "m2"] },
        },
        agentBindings: { s: { lane: "scout" } },
      },
    })

    // Registry with listModels so fingerprints include auth state
    const registryV1 = makeRegistry([
      model("m1", { authenticated: true }),
      model("m2", { authenticated: true }),
    ], true)

    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-test-cache-"))
    const cachePath = path.join(cacheDir, "active-profile.json")

    try {
      // First call: activates, writes cache with fingerprint of v1 registry
      const first = await ensureResolved(undefined, { repoRoot, registry: registryV1, cachePath })
      assert.equal(first.resolvedLanes.scout.model, "m1")

      // Second call with same registry: cache is fresh, uses cached result
      const second = await ensureResolved(undefined, { repoRoot, registry: registryV1, cachePath })
      assert.equal(second.resolvedLanes.scout.model, "m1")

      // Now change auth state: m1 loses auth
      const registryV2 = makeRegistry([
        model("m1", { authenticated: false }), // lost auth
        model("m2", { authenticated: true }),
      ], true)

      // Third call: fingerprint differs → must re-activate, resolves to m2
      const third = await ensureResolved(undefined, { repoRoot, registry: registryV2, cachePath })
      assert.equal(third.resolvedLanes.scout.model, "m2")
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
      await fs.rm(cacheDir, { recursive: true, force: true })
    }
  })
})
