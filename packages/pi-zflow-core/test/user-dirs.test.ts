/**
 * User directory bootstrap unit tests.
 */
import * as assert from "node:assert"
import { test, describe } from "node:test"
import * as path from "node:path"
import * as os from "node:os"
import * as fs from "node:fs"

import {
  USER_STATE_BASE,
  USER_AGENTS_DIR,
  USER_CHAINS_DIR,
  INSTALL_MANIFEST_PATH,
  ACTIVE_PROFILE_PATH,
  ensureUserDirs,
  checkUserDirs,
  resolveAgentInstallScope,
} from "../src/user-dirs.js"

describe("user directory constants", () => {
  const home = os.homedir()

  test("USER_STATE_BASE is ~/.pi/agent/zflow/", () => {
    assert.ok(USER_STATE_BASE.startsWith(home))
    assert.ok(USER_STATE_BASE.endsWith(path.join(".pi", "agent", "zflow")))
  })

  test("USER_AGENTS_DIR is under ~/.pi/agent/agents/zflow/", () => {
    assert.ok(USER_AGENTS_DIR.startsWith(home))
    assert.ok(USER_AGENTS_DIR.endsWith(path.join(".pi", "agent", "agents", "zflow")))
  })

  test("USER_CHAINS_DIR is under ~/.pi/agent/chains/zflow/", () => {
    assert.ok(USER_CHAINS_DIR.startsWith(home))
    assert.ok(USER_CHAINS_DIR.endsWith(path.join(".pi", "agent", "chains", "zflow")))
  })

  test("INSTALL_MANIFEST_PATH is under ~/.pi/agent/zflow/", () => {
    assert.ok(INSTALL_MANIFEST_PATH.startsWith(home))
    assert.ok(INSTALL_MANIFEST_PATH.endsWith("install-manifest.json"))
  })

  test("ACTIVE_PROFILE_PATH is under ~/.pi/agent/zflow/", () => {
    assert.ok(ACTIVE_PROFILE_PATH.startsWith(home))
    assert.ok(ACTIVE_PROFILE_PATH.endsWith("active-profile.json"))
  })
})

describe("ensureUserDirs", () => {
  test("creates directories idempotently", () => {
    // First call — should create
    ensureUserDirs()

    // Verify they exist
    assert.ok(fs.existsSync(USER_AGENTS_DIR))
    assert.ok(fs.existsSync(USER_CHAINS_DIR))
    assert.ok(fs.existsSync(USER_STATE_BASE))

    // Second call — should not throw (idempotent)
    ensureUserDirs()
  })
})

describe("checkUserDirs", () => {
  test("returns true when directories exist", () => {
    ensureUserDirs()
    assert.ok(checkUserDirs())
  })
})

describe("resolveAgentInstallScope", () => {
  test("returns 'user' by default (no project root)", () => {
    const scope = resolveAgentInstallScope()
    assert.equal(scope, "user")
  })

  test("returns 'user' when called with a project root (default fallback)", () => {
    // The function currently defaults to 'user' in all cases.
    // Project-local detection is deferred to command handlers.
    const scope = resolveAgentInstallScope("/some/project")
    assert.equal(scope, "user")
  })
})
