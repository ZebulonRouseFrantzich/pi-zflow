/**
 * manifest.backward-compat.test.ts — Tests for install manifest backward compatibility.
 *
 * Validates that readManifest() accepts legacy `version` field as fallback
 * when `packageVersion` is absent.
 */
import { describe, it, before, after } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"

import { INSTALL_MANIFEST_PATH } from "pi-zflow-core/user-dirs"
import type { InstallManifest } from "pi-zflow-core/schemas"

// Direct import of the module under test
const manifestModule = await import("../extensions/zflow-agents/manifest.js")
const { readManifest, writeManifest, diffManifest } = manifestModule

// We need to override INSTALL_MANIFEST_PATH for test isolation.
// Since it's a const imported via user-dirs, we temporarily redirect
// by creating a sandbox dir and mocking the path via env or by using
// an internal override. The cleanest approach: test the internal helpers
// directly by writing manifest files to a temp path and calling the
// read/write functions when INSTALL_MANIFEST_PATH points there.

let origDir: string | undefined
let sandboxDir: string

before(async () => {
  // Save original path location marker
  // We know INSTALL_MANIFEST_PATH resolves to ~/.pi/agent/zflow/install-manifest.json.
  // For tests we create a sandbox and use cwd tricks in the user-dirs resolution.
  // The simplest approach: create the full path tree under a temp dir and
  // temporarily override HOME so user-dirs resolves there.
  sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "manifest-bc-"))
  origDir = process.env.HOME
  process.env.HOME = sandboxDir
})

after(async () => {
  if (origDir !== undefined) {
    process.env.HOME = origDir
  }
  await fs.rm(sandboxDir, { recursive: true, force: true }).catch(() => {})
})

async function writeManifestRaw(data: Record<string, unknown>): Promise<void> {
  const dir = path.dirname(INSTALL_MANIFEST_PATH)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(INSTALL_MANIFEST_PATH, JSON.stringify(data, null, 2), "utf-8")
}

describe("manifest backward compatibility", () => {
  it("loads manifest with legacy version field and returns packageVersion", async () => {
    await writeManifestRaw({
      version: "0.1.0",
      source: "npm:test-pkg",
      installedAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      installedAgents: ["agent-a.md"],
      installedChains: [],
      installedSkills: [],
    })

    const manifest = await readManifest()
    assert.ok(manifest !== null, "manifest should be loaded")
    assert.equal(manifest!.packageVersion, "0.1.0", "packageVersion should come from legacy version")
  })

  it("throws when both packageVersion and version are missing", async () => {
    await writeManifestRaw({
      source: "npm:test-pkg",
      installedAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      installedAgents: [],
      installedChains: [],
      installedSkills: [],
    })

    await assert.rejects(
      () => readManifest(),
      { message: /missing required field|packageVersion/ },
      "should throw when both version fields are absent",
    )
  })

  it("coerces missing array fields for backward compatibility", async () => {
    await writeManifestRaw({
      packageVersion: "0.2.0",
      source: "npm:test-pkg",
      installedAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      // deliberately missing installedAgents, installedChains, installedSkills
    })

    const manifest = await readManifest()
    assert.ok(manifest !== null)
    assert.deepEqual(manifest!.installedAgents, [], "installedAgents should default to []")
    assert.deepEqual(manifest!.installedChains, [], "installedChains should default to []")
    assert.deepEqual(manifest!.installedSkills, [], "installedSkills should default to []")
  })

  it("writeManifest still writes packageVersion (not legacy version)", async () => {
    // Use writeManifest to persist, then read back raw JSON to check field names
    const manifest: InstallManifest = {
      packageVersion: "0.3.0",
      source: "npm:test-pkg",
      installedAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      installedAgents: [],
      installedChains: [],
      installedSkills: [],
    }

    await writeManifest(manifest)

    // Read raw file to inspect field names
    const raw = await fs.readFile(INSTALL_MANIFEST_PATH, "utf-8")
    const parsed = JSON.parse(raw)

    assert.equal(parsed.packageVersion, "0.3.0", "writeManifest should write packageVersion")
    assert.equal(parsed.version, undefined, "writeManifest should NOT write legacy version field")
  })

  it("diffManifest works with manifest loaded from legacy version", async () => {
    await writeManifestRaw({
      version: "0.4.0",
      source: "npm:test-pkg",
      installedAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      installedAgents: ["existing-agent.md"],
      installedChains: [],
      installedSkills: [],
    })

    const manifest = await readManifest()
    assert.ok(manifest !== null)

    const diff = diffManifest(manifest!, "0.4.0", ["existing-agent.md", "new-agent.md"], [])
    assert.ok(diff.versionChanged === false, "version should not be changed")
    assert.equal(diff.missingAgents.length, 1, "new-agent.md should be missing")
    assert.equal(diff.missingAgents[0], "new-agent.md")
    assert.equal(diff.extraAgents.length, 0)
  })
})
