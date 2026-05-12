/**
 * Package manifest policy tests.
 */
import * as assert from "node:assert"
import { test, describe } from "node:test"
import * as fs from "node:fs"
import * as path from "node:path"

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..")
const PACKAGE_DIR = path.join(REPO_ROOT, "packages")
const CHILD_PACKAGES = [
  "pi-zflow-core",
  "pi-zflow-artifacts",
  "pi-zflow-profiles",
  "pi-zflow-plan-mode",
  "pi-zflow-agents",
  "pi-zflow-review",
  "pi-zflow-change-workflows",
  "pi-zflow-runecontext",
  "pi-zflow-compaction",
  "pi-zflow",
]
const PI_HOST_PEERS = new Set([
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-tui",
  "typebox",
])

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

describe("workspace package manifests", () => {
  test("all child packages exist", () => {
    for (const pkg of CHILD_PACKAGES) {
      const manifest = path.join(PACKAGE_DIR, pkg, "package.json")
      assert.ok(fs.existsSync(manifest), `missing ${manifest}`)
    }
  })

  test("all child package versions are exact local refs", () => {
    for (const pkg of CHILD_PACKAGES) {
      const manifest = readJson(path.join(PACKAGE_DIR, pkg, "package.json"))
      assert.equal(manifest.version, "0.1.0", `${pkg} version should be exact 0.1.0`)
    }
  })

  test("dependencies use exact refs, not latest/ranges", () => {
    for (const pkg of CHILD_PACKAGES) {
      const manifest = readJson(path.join(PACKAGE_DIR, pkg, "package.json"))
      for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
        assert.equal(typeof spec, "string", `${pkg} dependency ${name} should be a string`)
        assert.notEqual(spec, "latest", `${pkg} dependency ${name} must not use latest`)
        assert.ok(!String(spec).startsWith("^") && !String(spec).startsWith("~"), `${pkg} dependency ${name} must be exact, got ${spec}`)
      }
    }
  })

  test("Pi host peerDependencies use documented wildcard exception", () => {
    for (const pkg of CHILD_PACKAGES) {
      const manifest = readJson(path.join(PACKAGE_DIR, pkg, "package.json"))
      for (const [name, spec] of Object.entries(manifest.peerDependencies ?? {})) {
        if (PI_HOST_PEERS.has(name)) {
          assert.equal(spec, "*", `${pkg} host peer ${name} should use wildcard exception`)
        } else {
          assert.notEqual(spec, "latest", `${pkg} peer ${name} must not use latest`)
        }
      }
    }
  })

  test("umbrella package bundles all child packages except itself", () => {
    const umbrella = readJson(path.join(PACKAGE_DIR, "pi-zflow", "package.json"))
    const bundled = new Set(umbrella.bundledDependencies ?? [])
    for (const pkg of CHILD_PACKAGES.filter((p) => p !== "pi-zflow")) {
      assert.equal(umbrella.dependencies[pkg], "0.1.0", `umbrella dependency ${pkg} must be pinned`)
      assert.ok(bundled.has(pkg), `umbrella must bundle ${pkg}`)
    }
  })
})
