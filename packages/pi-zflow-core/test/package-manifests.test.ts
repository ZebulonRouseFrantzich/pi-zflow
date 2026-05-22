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
  "pi-zflow-subagents-bridge",
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

function assertManifestPathsExist(manifestPath: string, resourcePaths: string[] | undefined, label: string): void {
  assert.ok(resourcePaths?.length, `${label} manifest must declare ${label} paths`)

  for (const resourcePath of resourcePaths) {
    const fullPath = path.resolve(path.dirname(manifestPath), resourcePath)
    assert.ok(fs.existsSync(fullPath), `${label} path should exist: ${resourcePath}`)
  }
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
        assert.ok(!String(spec).startsWith("file:"), `${pkg} dependency ${name} must be installable from GitHub, got ${spec}`)
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

  test("repository root is an installable Pi package for direct GitHub installs", () => {
    const rootManifestPath = path.join(REPO_ROOT, "package.json")
    const root = readJson(rootManifestPath)

    assert.ok(root.private, "repository root should remain a private workspace package")
    assert.ok(root.keywords?.includes("pi-package"), "repository root should be discoverable as a Pi package")
    assert.ok(root.keywords?.includes("pi-zflow"), "repository root should be tagged as pi-zflow")

    assertManifestPathsExist(rootManifestPath, root.pi?.extensions, "extensions")
    assertManifestPathsExist(rootManifestPath, root.pi?.skills, "skills")
    assertManifestPathsExist(rootManifestPath, root.pi?.prompts, "prompts")

    assert.ok(root.pi.extensions.includes("packages/pi-zflow/extensions"), "root manifest should expose umbrella help extension")
    for (const pkg of CHILD_PACKAGES.filter((p) => p !== "pi-zflow-core" && p !== "pi-zflow")) {
      const child = readJson(path.join(PACKAGE_DIR, pkg, "package.json"))
      if (child.pi?.extensions?.length) {
        assert.ok(root.pi.extensions.includes(`packages/${pkg}/extensions`), `root manifest should expose ${pkg} extensions`)
      }
    }
  })
})
