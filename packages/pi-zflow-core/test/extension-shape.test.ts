/**
 * extension-shape.test.ts — Verifies that every Pi extension entrypoint
 * exports a default factory function, which is required by the Pi extension
 * loader (docs/extensions.md:153–160: "An extension exports a default factory
 * function that receives ExtensionAPI").
 *
 * Each child package with a `pi.extensions` manifest must have entrypoints
 * that export a function (not an object with an `activate()` method), because
 * Pi extensions are factory functions called with `ExtensionAPI`.
 *
 * Pi discovers extensions either by direct file entrypoints (for example
 * `./index.ts`) or by scanning listed directories for subdirectories containing
 * an `index.ts`. So `./extensions` means it finds all subdirectories like
 * `./extensions/zflow-artifacts/index.ts`, `./extensions/zflow-profiles/index.ts`,
 * etc.
 */

import { describe, it } from "node:test"
import { ok } from "node:assert/strict"
import { existsSync, readdirSync, statSync } from "node:fs"
import { resolve, dirname, basename } from "node:path"
import { fileURLToPath } from "node:url"

// Resolve the workspace root from this test file's location
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

/**
 * Discover all extension entrypoints from a manifest path.
 *
 * Pi supports both direct file entrypoints and directory-based discovery.
 * This function mirrors that behavior.
 */
function discoverExtensionIndexPaths(extPath: string): string[] {
  const paths: string[] = []

  if (!existsSync(extPath)) return paths

  const stats = statSync(extPath)
  if (stats.isFile()) {
    return [extPath]
  }

  const entries = readdirSync(extPath, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const indexPath = resolve(extPath, entry.name, "index.ts")
      if (existsSync(indexPath)) {
        paths.push(indexPath)
      }
    }
  }

  return paths
}

describe("extension shape", () => {
  // ── Individual package extension tests ───────────────────────────

  const packagesWithExtensions = [
    "packages/pi-zflow-artifacts",
    "packages/pi-zflow-profiles",
    "packages/pi-zflow-plan-mode",
    "packages/pi-zflow-agents",
    "packages/pi-zflow-review",
    "packages/pi-zflow-change-workflows",
    "packages/pi-zflow-runecontext",
    "packages/pi-zflow-compaction",
  ]

  for (const pkgPath of packagesWithExtensions) {
    const fullPkgRoot = resolve(workspaceRoot, pkgPath)
    const extDir = resolve(fullPkgRoot, "extensions")

    if (!existsSync(extDir)) continue

    const indexPaths = discoverExtensionIndexPaths(extDir)

    for (const indexPath of indexPaths) {
      const extName = basename(dirname(indexPath))
      it(`${pkgPath}/extensions/${extName} exports a function`, async () => {
        const mod = await import(indexPath)
        const exported = mod.default

        ok(typeof exported === "function",
          `Expected default export to be a function in ${indexPath}, ` +
          `but got "${typeof exported}". ` +
          `Pi extensions must export a factory function (default export).`)
      })
    }
  }

  // ── Umbrella manifest test ───────────────────────────────────────

  it("all umbrella extension paths resolve to function exports", async () => {
    const umbrellaManifest = resolve(workspaceRoot, "packages/pi-zflow", "package.json")
    const { default: umbrellaPkg } = await import(umbrellaManifest, { with: { type: "json" } })
    const extPaths: string[] = umbrellaPkg.pi?.extensions ?? []

    ok(extPaths.length > 0, "Umbrella manifest must declare at least one extension path")

    let totalExtensions = 0

    for (const extPath of extPaths) {
      let fullExtDir: string

      // Path relative to umbrella package (e.g. "./extensions/zflow-help")
      if (extPath.startsWith("./") || extPath.startsWith("../")) {
        fullExtDir = resolve(dirname(umbrellaManifest), extPath)
      } else {
        // node_modules/<pkg>/extensions — resolve to the actual monorepo package
        // e.g. node_modules/pi-zflow-artifacts/extensions → packages/pi-zflow-artifacts/extensions
        const parts = extPath.replace(/^node_modules\//, "").split("/")
        const pkgName = parts[0]
        const actualPkgDir = resolve(workspaceRoot, `packages/${pkgName}`)

        if (existsSync(actualPkgDir)) {
          // In monorepo layout, the extensions path is relative to the package root
          fullExtDir = resolve(actualPkgDir, ...parts.slice(1))
        } else {
          const workspaceNodeModulesPath = resolve(workspaceRoot, extPath)
          const umbrellaLocalPath = resolve(dirname(umbrellaManifest), extPath)
          fullExtDir = existsSync(workspaceNodeModulesPath)
            ? workspaceNodeModulesPath
            : umbrellaLocalPath
        }
      }

      const indexPaths = discoverExtensionIndexPaths(fullExtDir)

      ok(indexPaths.length > 0,
        `No extension index.ts found under ${fullExtDir} (umbrella path ${extPath})`)

      totalExtensions += indexPaths.length

      const isExternalNodeModulesPath = extPath.startsWith("node_modules/") && !existsSync(resolve(workspaceRoot, extPath.replace(/^node_modules\//, "packages/")))
      if (isExternalNodeModulesPath) {
        continue
      }

      for (const indexPath of indexPaths) {
        const mod = await import(indexPath)
        ok(typeof mod.default === "function",
          `Extension at ${indexPath} must export a function (umbrella path ${extPath})`)
      }
    }

    ok(totalExtensions >= 1, `Found ${totalExtensions} extensions via umbrella manifest`)
  })

  // ── Root manifest test ──────────────────────────────────────────

  it("all root Pi manifest extension paths resolve to function exports", async () => {
    const rootManifest = resolve(workspaceRoot, "package.json")
    const { default: rootPkg } = await import(rootManifest, { with: { type: "json" } })
    const extPaths: string[] = rootPkg.pi?.extensions ?? []

    ok(extPaths.length > 0, "Root manifest must declare extension paths for direct GitHub installs")

    let totalExtensions = 0

    for (const extPath of extPaths) {
      const fullExtDir = resolve(dirname(rootManifest), extPath)
      const indexPaths = discoverExtensionIndexPaths(fullExtDir)

      ok(indexPaths.length > 0,
        `No extension index.ts found under ${fullExtDir} (root path ${extPath})`)

      totalExtensions += indexPaths.length

      const isExternalNodeModulesPath = extPath.startsWith("node_modules/") && !existsSync(resolve(workspaceRoot, extPath.replace(/^node_modules\//, "packages/")))
      if (isExternalNodeModulesPath) {
        continue
      }

      for (const indexPath of indexPaths) {
        const mod = await import(indexPath)
        ok(typeof mod.default === "function",
          `Extension at ${indexPath} must export a function (root path ${extPath})`)
      }
    }

    ok(totalExtensions >= 1, `Found ${totalExtensions} extensions via root manifest`)
  })
})
