import * as assert from "node:assert"
import { describe, test } from "node:test"
import * as fs from "node:fs/promises"
import * as fsSync from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import {
  hasExternalPathDependencies,
  materializeExternalPathDependencies,
  normalizeExternalPathDependenciesConfig,
} from "../src/external-path-dependencies.js"

function chmodTreeWritable(target: string): void {
  if (!fsSync.existsSync(target)) return
  const stat = fsSync.lstatSync(target)
  if (stat.isDirectory()) {
    fsSync.chmodSync(target, 0o755)
    for (const entry of fsSync.readdirSync(target)) chmodTreeWritable(path.join(target, entry))
  } else if (!stat.isSymbolicLink()) {
    fsSync.chmodSync(target, 0o644)
  }
}

async function makeRepoFixture(): Promise<{ root: string; repo: string; sibling: string; worktree: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-zflow-external-deps-"))
  const repo = path.join(root, "reSET")
  const sibling = path.join(root, "device-firmware")
  const worktree = path.join(root, "sandbox", "pi-worktree-1")
  await fs.mkdir(path.join(repo, "apps", "mobile"), { recursive: true })
  await fs.mkdir(path.join(sibling, "packages", "pkg_a", "lib"), { recursive: true })
  await fs.mkdir(path.join(sibling, "packages", "pkg_b", "lib"), { recursive: true })
  await fs.mkdir(worktree, { recursive: true })
  await fs.writeFile(path.join(sibling, "packages", "pkg_a", "lib", "a.dart"), "// a\n")
  await fs.writeFile(path.join(sibling, "packages", "pkg_a", "pubspec.yaml"), [
    "name: pkg_a",
    "dependencies:",
    "  pkg_b:",
    "    path: ../pkg_b",
    "",
  ].join("\n"))
  await fs.writeFile(path.join(sibling, "packages", "pkg_b", "pubspec.yaml"), "name: pkg_b\n")
  await fs.writeFile(path.join(repo, "apps", "mobile", "pubspec.yaml"), [
    "name: reset_app",
    "dependencies:",
    "  pkg_a:",
    "    path: ../../../device-firmware/packages/pkg_a",
    "",
  ].join("\n"))
  return { root, repo, sibling, worktree }
}

describe("external path dependencies", () => {
  test("normalizes config with auto-copy default", () => {
    assert.deepEqual(normalizeExternalPathDependenciesConfig(undefined), { mode: "copy-readonly", allow: [] })
    assert.deepEqual(normalizeExternalPathDependenciesConfig({ mode: "off", allow: ["../deps"] }), { mode: "off", allow: ["../deps"] })
  })

  test("detects manifest-declared sibling pubspec path dependencies", async () => {
    const fixture = await makeRepoFixture()
    try {
      assert.equal(hasExternalPathDependencies(fixture.repo), true)
      await fs.writeFile(path.join(fixture.repo, "pi-zflow.config.json"), JSON.stringify({ externalPathDependencies: { mode: "off" } }))
      assert.equal(hasExternalPathDependencies(fixture.repo), false)
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true })
    }
  })

  test("copies manifest-declared sibling pubspec path dependencies into the sandbox", async () => {
    const fixture = await makeRepoFixture()
    try {
      const result = materializeExternalPathDependencies({
        repoRoot: fixture.repo,
        worktreeRoot: fixture.worktree,
      })

      assert.equal(result.mode, "copy-readonly")
      assert.equal(result.materialized.length, 2)
      const pkgA = path.join(fixture.root, "sandbox", "device-firmware", "packages", "pkg_a", "pubspec.yaml")
      const pkgB = path.join(fixture.root, "sandbox", "device-firmware", "packages", "pkg_b", "pubspec.yaml")
      assert.equal(fsSync.existsSync(pkgA), true)
      assert.equal(fsSync.existsSync(pkgB), true)
      assert.equal((fsSync.statSync(pkgA).mode & 0o222), 0)
    } finally {
      chmodTreeWritable(fixture.root)
      await fs.rm(fixture.root, { recursive: true, force: true })
    }
  })

  test("replaces stale symlink ancestors instead of following them", async () => {
    const fixture = await makeRepoFixture()
    const realSiblingSentinel = path.join(fixture.sibling, "packages", "pkg_a", "sentinel.txt")
    try {
      const sandboxSibling = path.join(fixture.root, "sandbox", "device-firmware")
      await fs.symlink(fixture.sibling, sandboxSibling)

      const result = materializeExternalPathDependencies({
        repoRoot: fixture.repo,
        worktreeRoot: fixture.worktree,
      })

      assert.equal(result.materialized.length, 2)
      assert.equal(fsSync.lstatSync(sandboxSibling).isSymbolicLink(), false)
      assert.equal(fsSync.existsSync(path.join(sandboxSibling, "packages", "pkg_a", "pubspec.yaml")), true)
      assert.equal(fsSync.existsSync(realSiblingSentinel), false)
    } finally {
      chmodTreeWritable(fixture.root)
      await fs.rm(fixture.root, { recursive: true, force: true })
    }
  })

  test("can be disabled by config", async () => {
    const fixture = await makeRepoFixture()
    try {
      const result = materializeExternalPathDependencies({
        repoRoot: fixture.repo,
        worktreeRoot: fixture.worktree,
        config: { mode: "off" },
      })
      assert.equal(result.materialized.length, 0)
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true })
    }
  })
})
