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
 * Pi discovers extensions by scanning the listed directories for subdirectories
 * containing an `index.ts`. So `./extensions` means it finds all subdirectories
 * like `./extensions/zflow-artifacts/index.ts`, `./extensions/zflow-profiles/index.ts`,
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
 * Discover all extension index.ts files under a given extensions directory.
 *
 * Pi scans each listed extension directory for subdirectories containing
 * an index.ts. This function mirrors that discovery logic.
 */
function discoverExtensionIndexPaths(extDir: string): string[] {
  const paths: string[] = []

  if (!existsSync(extDir)) return paths

  const entries = readdirSync(extDir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const indexPath = resolve(extDir, entry.name, "index.ts")
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
      // In workspace dev, node_modules/<pkg>/extensions is a virtual path.
      // Resolve it to the actual package in the monorepo:
      //   node_modules/pi-zflow-artifacts/extensions → packages/pi-zflow-artifacts/extensions
      const parts = extPath.replace(/^node_modules\//, "").split("/")
      const pkgName = parts[0]
      const actualPkgDir = resolve(workspaceRoot, `packages/${pkgName}`)

      let fullExtDir: string
      if (existsSync(actualPkgDir)) {
        // In monorepo layout, the extensions path is relative to the package root
        fullExtDir = resolve(actualPkgDir, ...parts.slice(1))
      } else {
        // Fallback: resolve relative to the umbrella package
        fullExtDir = resolve(dirname(umbrellaManifest), extPath)
      }

      const indexPaths = discoverExtensionIndexPaths(fullExtDir)

      ok(indexPaths.length > 0,
        `No extension index.ts found under ${fullExtDir} (umbrella path ${extPath})`)

      totalExtensions += indexPaths.length

      for (const indexPath of indexPaths) {
        const mod = await import(indexPath)
        ok(typeof mod.default === "function",
          `Extension at ${indexPath} must export a function (umbrella path ${extPath})`)
      }
    }

    ok(totalExtensions >= 1, `Found ${totalExtensions} extensions via umbrella manifest`)
  })
})
