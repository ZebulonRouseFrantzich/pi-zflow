/**
 * manifest.ts — Install manifest tracking for deployed agents and chains.
 *
 * ## Overview
 *
 * The install manifest at `~/.pi/agent/zflow/install-manifest.json` records
 * what was installed and when. It is the source of truth for:
 * - Detecting whether `/zflow-setup-agents` has been run
 * - Detecting version drift between the package and deployed files
 * - Providing a clean list of installed files for `/zflow-update-agents`
 * - Supporting cleanup of stale/extra files
 *
 * ## Manifest schema
 *
 * ```typescript
 * interface InstallManifest {
 *   version: string           // Package version at install time
 *   source: string            // npm:pi-zflow-agents@<pin> or local path
 *   installedAt: string       // ISO 8601 first install timestamp
 *   updatedAt: string         // ISO 8601 last update timestamp
 *   installedAgents: string[] // e.g. ["planner-frontier.md", ...]
 *   installedChains: string[] // e.g. ["parallel-review.chain.md", ...]
 *   installedSkills: string[] // e.g. ["change-doc-workflow", ...]
 * }
 * ```
 *
 * The type is defined in `pi-zflow-core/src/schemas.ts` as `InstallManifest`.
 *
 * ## Read / Write operations
 *
 * ### `readManifest(): InstallManifest | null`
 *
 * Reads `~/.pi/agent/zflow/install-manifest.json`.
 * - If the file does not exist → return `null` (first-time install).
 * - If the file exists but is malformed JSON → throw with a clear error
 *   message that includes the file path and the parse error.
 * - Otherwise → return the parsed `InstallManifest`.
 *
 * ### `writeManifest(manifest: InstallManifest): void`
 *
 * Writes `~/.pi/agent/zflow/install-manifest.json`.
 * - Creates the parent directory (`~/.pi/agent/zflow/`) if it does not exist.
 * - Writes the manifest with 2-space indentation for readability.
 * - Uses atomic write (write to `.tmp`, then rename) to prevent corruption.
 *
 * ## Diff detection
 *
 * ### `diffManifest(manifest: InstallManifest, packageVersion: string): ManifestDiff`
 *
 * Compares the manifest against the current package state:
 *
 * ```typescript
 * interface ManifestDiff {
 *   versionChanged: boolean        // manifest.version !== packageVersion
 *   oldVersion: string | null
 *   newVersion: string
 *   missingAgents: string[]        // in package but not in manifest
 *   missingChains: string[]        // in package but not in manifest
 *   extraAgents: string[]          // in manifest but not in package (stale)
 *   extraChains: string[]          // in manifest but not in package (stale)
 *   needsUpdate: boolean           // versionChanged OR missingAgents/chains
 * }
 * ```
 *
 * This function is called by `/zflow-update-agents` to determine what needs
 * to change.
 *
 * ## Stale file cleanup
 *
 * After an update, files that were deployed by a previous version but are no
 * longer in the package are **not automatically deleted**. Instead, they are
 * listed as "extra" in the diff output. The user can:
 * - Run `/zflow-setup-agents --clean` to remove stale files.
 * - Manually delete them from the install target directory.
 *
 * A future enhancement may automatically prompt for cleanup when stale files
 * are detected.
 *
 * ## Migration between versions
 *
 * When the manifest schema changes (e.g. a new field is added in a future
 * version), the `readManifest()` function should:
 * - Accept manifests with missing optional fields (backward-compatible).
 * - Fill in defaults for any missing required fields where sensible.
 * - If the manifest is irreparably incompatible, warn and recreate.
 *
 * @module pi-zflow-agents/manifest
 */

export {}

