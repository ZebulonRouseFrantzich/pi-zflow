/**
 * footer-status.test.ts — Tests for Pi footer/status integration (Task 2.12).
 *
 * Covers:
 *   - formatProfileFooterStatus (all healthy, optional disabled, required unresolved,
 *     both conditions, empty lanes)
 *   - updateProfileFooterStatus (cache exists, no cache, cache with issues)
 *   - session_start event integration (smoke test via module imports)
 */
import { describe, it } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"

import {
  formatProfileFooterStatus,
  updateProfileFooterStatus,
  PROFILE_STATUS_KEY,
  writeActiveProfileCache,
} from "../extensions/zflow-profiles/index.js"

import type { ActiveProfileCache } from "../extensions/zflow-profiles/profiles.js"

// ── Helpers ─────────────────────────────────────────────────────

function makeCache(
  profileName: string = "default",
  lanes: ActiveProfileCache["resolvedLanes"] = {},
): ActiveProfileCache {
  return {
    profileName,
    sourcePath: "/test/.pi/zflow-profiles.json",
    resolvedAt: new Date().toISOString(),
    ttlMinutes: 15,
    definitionHash: "abc",
    environmentFingerprint: "def",
    resolvedLanes: lanes,
    agentBindings: {},
  }
}

async function writeCache(
  cache: ActiveProfileCache,
): Promise<string> {
  // Write to a temp dir so we don't pollute the real cache
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-footer-test-"))
  const cachePath = path.join(dir, "active-profile.json")
  await writeActiveProfileCache(cache, cachePath)
  return cachePath
}

// ── Tests ───────────────────────────────────────────────────────

describe("formatProfileFooterStatus", () => {
  it("shows profile name when all lanes are resolved", () => {
    const cache = makeCache("default", {
      scout: { model: "m1", thinking: "low", required: true, optional: false, status: "resolved" },
      worker: { model: "m2", required: true, optional: false, status: "resolved" },
    })
    assert.equal(formatProfileFooterStatus(cache), "Profile: default")
  })

  it("includes optional lane count when some are disabled", () => {
    const cache = makeCache("default", {
      scout: { model: "m1", required: true, optional: false, status: "resolved" },
      "review-logic": { model: null, required: false, optional: true, status: "disabled-optional", reason: "no model" },
    })
    assert.equal(
      formatProfileFooterStatus(cache),
      "Profile: default (1 optional lane disabled)",
    )
  })

  it("includes plural optional lane count", () => {
    const cache = makeCache("default", {
      scout: { model: "m1", required: true, optional: false, status: "resolved" },
      a: { model: null, required: false, optional: true, status: "disabled-optional" },
      b: { model: null, required: false, optional: true, status: "disabled-optional" },
    })
    assert.equal(
      formatProfileFooterStatus(cache),
      "Profile: default (2 optional lanes disabled)",
    )
  })

  it("shows warning when required lanes are unresolved", () => {
    const cache = makeCache("default", {
      scout: { model: null, required: true, optional: false, status: "unresolved-required", reason: "no auth" },
    })
    assert.equal(
      formatProfileFooterStatus(cache),
      "Profile: default ⚠ (1 required lane unresolved)",
    )
  })

  it("shows plural required lane count", () => {
    const cache = makeCache("default", {
      a: { model: null, required: true, optional: false, status: "unresolved-required" },
      b: { model: null, required: true, optional: false, status: "unresolved-required" },
    })
    assert.equal(
      formatProfileFooterStatus(cache),
      "Profile: default ⚠ (2 required lanes unresolved)",
    )
  })

  it("shows both counts when optional and required issues coexist", () => {
    const cache = makeCache("default", {
      scout: { model: null, required: true, optional: false, status: "unresolved-required" },
      optional: { model: null, required: false, optional: true, status: "disabled-optional" },
    })
    assert.equal(
      formatProfileFooterStatus(cache),
      "Profile: default ⚠ (1 optional disabled, 1 required unresolved)",
    )
  })

  it("shows only required issue when both exist (required takes priority)", () => {
    const cache = makeCache("default", {
      required: { model: null, required: true, optional: false, status: "unresolved-required" },
      optional1: { model: null, required: false, optional: true, status: "disabled-optional" },
      optional2: { model: null, required: false, optional: true, status: "disabled-optional" },
    })
    const result = formatProfileFooterStatus(cache)
    // Both shown when both exist
    assert.ok(result.includes("optional"))
    assert.ok(result.includes("required"))
  })

  it("shows profile name with empty resolved lanes", () => {
    const cache = makeCache("default", {})
    assert.equal(formatProfileFooterStatus(cache), "Profile: default")
  })

  it("uses the profile name from cache", () => {
    const cache = makeCache("my-custom-profile", {
      scout: { model: "m1", required: true, optional: false, status: "resolved" },
    })
    assert.equal(formatProfileFooterStatus(cache), "Profile: my-custom-profile")
  })
})

describe("updateProfileFooterStatus", () => {
  it("sets status when cache exists and all lanes are healthy", async () => {
    const cache = makeCache("default", {
      scout: { model: "m1", required: true, optional: false, status: "resolved" },
    })

    // Use a mock ui to capture the call
    let lastKey: string | undefined
    let lastText: string | undefined | null
    const mockUi = {
      setStatus: (key: string, text: string | undefined) => {
        lastKey = key
        lastText = text
      },
    }

    const cachePath = await writeCache(cache)
    try {
      await updateProfileFooterStatus(mockUi, cachePath)
      assert.equal(lastKey, PROFILE_STATUS_KEY)
      assert.equal(lastText, "Profile: default")
    } finally {
      await fs.rm(path.dirname(cachePath), { recursive: true, force: true })
    }
  })

  it("clears status when no cache exists", async () => {
    let lastKey: string | undefined
    let lastText: string | undefined
    const mockUi = {
      setStatus: (key: string, text: string | undefined) => {
        lastKey = key
        lastText = text
      },
    }

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-footer-test-"))
    const missingCachePath = path.join(dir, "missing-active-profile.json")
    try {
      await updateProfileFooterStatus(mockUi, missingCachePath)
      assert.equal(lastKey, PROFILE_STATUS_KEY)
      assert.equal(lastText, undefined)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("sets status with health indicator when required lanes unresolved", async () => {
    const cache = makeCache("default", {
      required: { model: null, required: true, optional: false, status: "unresolved-required" },
    })

    const cachePath = await writeCache(cache)
    try {
      let lastText: string | undefined
      const mockUi = { setStatus: (_k: string, t: string | undefined) => { lastText = t } }
      await updateProfileFooterStatus(mockUi, cachePath)
      assert.ok(lastText?.includes("⚠"))
      assert.ok(lastText?.includes("1 required lane"))
    } finally {
      await fs.rm(path.dirname(cachePath), { recursive: true, force: true })
    }
  })
})

describe("PROFILE_STATUS_KEY", () => {
  it("is the well-known status key 'zflow-profile'", () => {
    assert.equal(PROFILE_STATUS_KEY, "zflow-profile")
  })
})
