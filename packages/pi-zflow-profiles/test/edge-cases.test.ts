/**
 * edge-cases.test.ts — Consolidated edge-case integration tests for
 * profile resolution, using fixture files from `test/fixtures/profiles/`.
 *
 * Covers all critical behaviour rules (per Task 2.13):
 *   - missing `default` profile
 *   - binding references unknown lane
 *   - required lane unresolved
 *   - optional lane unresolved
 *   - profile source precedence (project over user fallback)
 *   - cache invalidation on definition hash change
 *   - cache invalidation on TTL expiry
 *   - `worker-strong` not silently downgraded
 *   - sync-project writes only on explicit command
 */
import { describe, it } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { fileURLToPath } from "node:url"
import { readFileSync } from "node:fs"

import {
  parseProfilesFileJson,
  validateProfilesFile,
  ProfileValidationError,
  writeActiveProfileCache,
  readActiveProfileCache,
  readActiveProfileCacheIfFresh,
  isActiveProfileCacheFresh,
  cacheToResolvedProfile,
  computeHash,
  computeCurrentProfileHash,
  buildActiveProfileCache,
  DEFAULT_CACHE_TTL_MINUTES,
} from "../extensions/zflow-profiles/profiles.js"

import {
  resolveProfile,
  resolveLane,
  hasUnresolvedRequiredLanes,
  getLaneStatusSummary,
} from "../extensions/zflow-profiles/model-resolution.js"

import {
  reresolveLane,
} from "../extensions/zflow-profiles/health.js"

import {
  ensureResolved,
  activateProfile,
  buildAgentOverrides,
  syncProfileToSettings,
} from "../extensions/zflow-profiles/index.js"

import type {
  ModelRegistry,
  ModelInfo,
  NormalizedLaneDefinition,
  NormalizedProfileDefinition,
  ActiveProfileCache,
} from "../extensions/zflow-profiles/profiles.js"

// ── Fixture paths ───────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(__dirname, "fixtures", "profiles")

function fixturePath(name: string): string {
  return path.join(FIXTURE_DIR, `${name}.json`)
}

function loadFixture(name: string): unknown {
  const raw = readFileSync(fixturePath(name), "utf8")
  return JSON.parse(raw)
}

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

/** Create a temp directory and copy a fixture file as .pi/zflow-profiles.json. */
async function setupFixture(fixtureName: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-edge-"))
  const piDir = path.join(dir, ".pi")
  await fs.mkdir(piDir, { recursive: true })
  const content = readFileSync(fixturePath(fixtureName), "utf8")
  await fs.writeFile(path.join(piDir, "zflow-profiles.json"), content)
  return dir
}

async function cleanDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true })
}

// ── 1. Missing default profile ──────────────────────────────────

describe("Edge case: missing default profile", () => {
  it("validation rejects fixture missing-default.json", () => {
    const data = loadFixture("missing-default")
    const result = validateProfilesFile(data)
    assert.equal(result.valid, false)
    const defaultErrors = result.errors.filter((e) =>
      e.path === "<root>" && e.message.includes("default"),
    )
    assert.ok(defaultErrors.length > 0)
  })

  it("parseProfilesFileJson throws ProfileValidationError", () => {
    const raw = readFileSync(fixturePath("missing-default"), "utf8")
    assert.throws(
      () => parseProfilesFileJson(raw),
      (err: unknown) => err instanceof ProfileValidationError,
    )
  })
})

// ── 2. Binding references unknown lane ──────────────────────────

describe("Edge case: binding references unknown lane", () => {
  it("validation rejects fixture binding-unknown-lane.json", () => {
    const data = loadFixture("binding-unknown-lane")
    const result = validateProfilesFile(data)
    assert.equal(result.valid, false)
    const laneErrors = result.errors.filter((e) =>
      e.message.includes("references lane") && e.message.includes("nonexistent-lane"),
    )
    assert.ok(laneErrors.length > 0)
  })
})

// ── 3. Required lane unresolved ─────────────────────────────────

describe("Edge case: required lane unresolved", () => {
  it("activation throws on required lane unresolved", async () => {
    const repoRoot = await setupFixture("required-unresolved")
    const registry = makeRegistry([]) // no models available
    try {
      await assert.rejects(
        () => activateProfile("default", { repoRoot, registry }),
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err)
          return (
            msg.includes("unresolved required lanes") &&
            msg.includes("scout-cheap")
          )
        },
      )
    } finally {
      await cleanDir(repoRoot)
    }
  })

  it("resolveLane returns unresolved-required for required lane with no valid models", () => {
    const laneDef: NormalizedLaneDefinition = {
      required: true,
      optional: false,
      preferredModels: ["no-such-model"],
    }
    const result = resolveLane("test-lane", laneDef, makeRegistry([]))
    assert.equal(result.status, "unresolved-required")
    assert.equal(result.model, null)
    assert.equal(result.required, true)
    assert.equal(result.optional, false)
  })
})

// ── 4. Optional lane unresolved ─────────────────────────────────

describe("Edge case: optional lane unresolved", () => {
  it("activation succeeds with optional lane disabled", async () => {
    const repoRoot = await setupFixture("optional-unresolved")
    const registry = makeRegistry([model("available-model")])
    try {
      const resolved = await activateProfile("default", { repoRoot, registry })
      assert.equal(resolved.resolvedLanes["scout-cheap"].status, "resolved")
      assert.equal(resolved.resolvedLanes["review-logic"].status, "disabled-optional")
      assert.equal(hasUnresolvedRequiredLanes(resolved), false)
    } finally {
      await cleanDir(repoRoot)
    }
  })

  it("resolveLane returns disabled-optional for optional lane with no valid models", () => {
    const laneDef: NormalizedLaneDefinition = {
      required: false,
      optional: true,
      preferredModels: ["no-such-model"],
    }
    const result = resolveLane("test-optional", laneDef, makeRegistry([]))
    assert.equal(result.status, "disabled-optional")
    assert.equal(result.model, null)
    assert.equal(result.required, false)
    assert.equal(result.optional, true)
  })
})

// ── 5. Profile source precedence ────────────────────────────────

describe("Edge case: profile source precedence", () => {
  it("loads project-local file when both exist (project overrides user)", async () => {
    const repoRoot = await setupFixture("valid-full")

    // Also create a user-level fallback file
    const userDir = path.join(os.homedir(), ".pi", "agent")
    const userProfilesPath = path.join(userDir, "zflow-profiles.json")
    await fs.mkdir(userDir, { recursive: true })
    await fs.writeFile(userProfilesPath, JSON.stringify({
      default: {
        lanes: { "user-only": { preferredModels: ["user-model"] } },
        agentBindings: {},
      },
    }))

    try {
      const { loadProfiles } = await import("../extensions/zflow-profiles/index.js")
      const loaded = await loadProfiles(repoRoot)
      // Should have chosen the project file, which has "scout-cheap" lane
      assert.ok(loaded.profiles.default.lanes["scout-cheap"])
      assert.equal(loaded.profiles.default.lanes["user-only"], undefined)
      assert.equal(loaded.source, path.join(repoRoot, ".pi", "zflow-profiles.json"))
    } finally {
      await cleanDir(repoRoot)
      await fs.unlink(userProfilesPath).catch(() => {})
    }
  })

  it("falls back to user file when project file does not exist", async () => {
    const userDir = path.join(os.homedir(), ".pi", "agent")
    const userProfilesPath = path.join(userDir, "zflow-profiles.json")
    await fs.mkdir(userDir, { recursive: true })
    await fs.writeFile(userProfilesPath, JSON.stringify({
      default: {
        lanes: { "user-lane": { preferredModels: ["m1"] } },
        agentBindings: {},
      },
    }))

    try {
      const { loadProfiles } = await import("../extensions/zflow-profiles/index.js")
      // No project file exists — use a non-existent repo root
      const loaded = await loadProfiles("/tmp/nonexistent-project-xyz-edge")
      assert.ok(loaded.profiles.default.lanes["user-lane"])
      assert.equal(loaded.source, userProfilesPath)
    } finally {
      await fs.unlink(userProfilesPath).catch(() => {})
    }
  })
})

// ── 6. Cache invalidation on definition hash change ─────────────

describe("Edge case: cache invalidation on definition hash change", () => {
  it("ensureResolved re-activates when profile file content changes", async () => {
    const repoRoot = await setupFixture("all-resolved")
    const registry = makeRegistry([
      model("available-model"),
      model("available-model-hi", { thinkingCapability: "high" }),
    ])
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-edge-cache-"))
    const cachePath = path.join(cacheDir, "active-profile.json")

    try {
      // First call: activates and writes cache with hash of all-resolved content
      const first = await ensureResolved(undefined, { repoRoot, registry, cachePath })
      assert.equal(first.resolvedLanes["scout-cheap"].model, "available-model")

      // Now replace the profile file content with a different model
      const piDir = path.join(repoRoot, ".pi")
      await fs.writeFile(
        path.join(piDir, "zflow-profiles.json"),
        JSON.stringify({
          default: {
            lanes: {
              "scout-cheap": { required: true, thinking: "low", preferredModels: ["other-model"] },
              "worker-strong": { required: true, thinking: "high", preferredModels: ["available-model-hi"] },
            },
            agentBindings: {
              scout: { lane: "scout-cheap" },
              implement: { lane: "worker-strong" },
            },
          },
        }),
      )

      const updatedRegistry = makeRegistry([
        model("other-model", { thinkingCapability: "low" }),
        model("available-model-hi", { thinkingCapability: "high" }),
      ])

      // Second call: definition hash changed → must re-resolve
      const second = await ensureResolved(undefined, { repoRoot, registry: updatedRegistry, cachePath })
      assert.equal(second.resolvedLanes["scout-cheap"].model, "other-model")
    } finally {
      await cleanDir(repoRoot)
      await cleanDir(cacheDir)
    }
  })

  it("isActiveProfileCacheFresh returns false when definition hash changes", () => {
    const cache: ActiveProfileCache = {
      profileName: "default",
      sourcePath: "/s.json",
      resolvedAt: new Date().toISOString(),
      ttlMinutes: 15,
      definitionHash: "old-hash",
      environmentFingerprint: "fp",
      resolvedLanes: {},
      agentBindings: {},
    }
    assert.equal(isActiveProfileCacheFresh(cache, "new-different-hash"), false)
  })
})

// ── 7. Cache invalidation on TTL expiry ─────────────────────────

describe("Edge case: cache invalidation on TTL expiry", () => {
  it("readActiveProfileCacheIfFresh returns null for expired cache", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-edge-cache-"))
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
      await cleanDir(dir)
    }
  })

  it("ensureResolved re-activates when cached profile is expired", async () => {
    const repoRoot = await setupFixture("all-resolved")
    // Must provide models that satisfy ALL required lanes in the fixture,
    // including worker-strong which requires "available-model-hi" with high thinking
    const registry = makeRegistry([
      model("available-model"),
      model("available-model-hi", { thinkingCapability: "high" }),
    ])
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-edge-cache-"))
    const cachePath = path.join(cacheDir, "active-profile.json")

    try {
      // First call: activates and writes cache
      await ensureResolved(undefined, { repoRoot, registry, cachePath })

      // Manually age the cache
      const oldCache: ActiveProfileCache = {
        profileName: "default",
        sourcePath: path.join(repoRoot, ".pi", "zflow-profiles.json"),
        resolvedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1 hour ago
        ttlMinutes: 15,
        definitionHash: "old",
        environmentFingerprint: "old",
        resolvedLanes: {},
        agentBindings: {},
      }
      await writeActiveProfileCache(oldCache, cachePath)

      // Second call: cache expired → re-activates
      const second = await ensureResolved(undefined, { repoRoot, registry, cachePath })
      assert.equal(second.resolvedLanes["scout-cheap"].model, "available-model")
    } finally {
      await cleanDir(repoRoot)
      await cleanDir(cacheDir)
    }
  })
})

// ── 8. worker-strong not silently downgraded ────────────────────

describe("Edge case: worker-strong not silently downgraded", () => {
  it("reresolveLane rejects cheap models for worker-strong", () => {
    const profileDef: NormalizedProfileDefinition = {
      lanes: {
        "worker-strong": {
          required: true,
          optional: false,
          thinking: "high",
          preferredModels: ["cheap-model", "good-model"],
        },
      },
      agentBindings: {},
    }
    const registry = makeRegistry([
      model("cheap-model", { thinkingCapability: "medium" }),
      model("good-model", { thinkingCapability: "high" }),
    ])

    const result = reresolveLane("worker-strong", profileDef, registry, [])
    assert.notEqual(result, null)
    assert.equal(result!.model, "good-model")
    // The cheap model is silently skipped — it must not be selected
  })

  it("resolve with example config does not map worker-strong to a cheap model", () => {
    const data = loadFixture("valid-full")
    const { profiles } = parseProfilesFileJson(JSON.stringify(data))
    const profileDef = profiles.default

    const registry = makeRegistry([
      model("openai/gpt-4o-mini", { thinkingCapability: "low" }),
      model("openai/gpt-5.4", { thinkingCapability: "high" }),
      model("openai/gpt-4o", { thinkingCapability: "medium" }),
      model("openai/gpt-5.4-codex", { thinkingCapability: "high" }),
    ])

    const resolved = resolveProfile("default", profileDef, "/fixture.json", registry)
    const wsLane = resolved.resolvedLanes["worker-strong"]
    assert.equal(wsLane.status, "resolved")
    assert.notEqual(wsLane.model, "openai/gpt-4o") // Not a cheap model
    assert.notEqual(wsLane.model, "openai/gpt-4o-mini")
    assert.equal(wsLane.model, "openai/gpt-5.4-codex")
  })
})

// ── 9. Sync-project writes only on explicit command ─────────────

describe("Edge case: sync-project writes only on explicit command", () => {
  it("normal activation (activateProfile) does not create .pi/settings.json", async () => {
    const repoRoot = await setupFixture("all-resolved")
    const registry = makeRegistry([
      model("available-model"),
      model("available-model-hi", { thinkingCapability: "high" }),
    ])
    try {
      await activateProfile("default", { repoRoot, registry })
      const settingsPath = path.join(repoRoot, ".pi", "settings.json")
      const exists = await fs.access(settingsPath).then(() => true).catch(() => false)
      assert.equal(exists, false, "activateProfile must not create .pi/settings.json")
    } finally {
      await cleanDir(repoRoot)
    }
  })

  it("normal activation (ensureResolved) does not create .pi/settings.json", async () => {
    const repoRoot = await setupFixture("all-resolved")
    const registry = makeRegistry([
      model("available-model"),
      model("available-model-hi", { thinkingCapability: "high" }),
    ])
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-edge-cache-"))
    const cachePath = path.join(cacheDir, "active-profile.json")
    try {
      await ensureResolved(undefined, { repoRoot, registry, cachePath })
      const settingsPath = path.join(repoRoot, ".pi", "settings.json")
      const exists = await fs.access(settingsPath).then(() => true).catch(() => false)
      assert.equal(exists, false, "ensureResolved must not create .pi/settings.json")
    } finally {
      await cleanDir(repoRoot)
      await cleanDir(cacheDir)
    }
  })

  it("syncProfileToSettings writes only when explicitly called", async () => {
    const repoRoot = await setupFixture("all-resolved")
    const registry = makeRegistry([
      model("available-model"),
      model("available-model-hi", { thinkingCapability: "high" }),
    ])
    try {
      // Activate profile to create cache
      await activateProfile("default", { repoRoot, registry })

      // Now explicitly sync
      const cache = await readActiveProfileCache()
      assert.notEqual(cache, null)

      const settingsPath = path.join(repoRoot, ".pi", "settings.json")
      const result = await syncProfileToSettings(cache!, settingsPath)
      assert.ok(result.count > 0)
      assert.equal(result.settingsPath, settingsPath)

      // Verify file was created
      const exists = await fs.access(settingsPath).then(() => true).catch(() => false)
      assert.equal(exists, true)
    } finally {
      await cleanDir(repoRoot)
    }
  })
})
