/**
 * pi-zflow-core — diagnostic helpers
 *
 * Formatting and inspection utilities for capability conflicts,
 * missing dependencies, command collisions, and general diagnostic
 * messages from the pi-zflow capability registry.
 *
 * @module
 */

import {
  getZflowRegistry,
  type RegistryDiagnostic,
} from "./registry.js"

// ── Severity labels ──────────────────────────────────────────────

const SEVERITY_LABEL: Record<RegistryDiagnostic["level"], string> = {
  info: "ℹ",
  warn: "⚠",
  error: "✖",
}

// ── Formatting ───────────────────────────────────────────────────

/**
 * Format a single registry diagnostic entry for display.
 */
export function formatDiagnostic(diag: RegistryDiagnostic): string {
  const label = SEVERITY_LABEL[diag.level]
  const tag = diag.capability ? `[${diag.capability}]` : ""
  return `${label} ${tag} ${diag.message}`
}

/**
 * Print all accumulated registry diagnostics grouped by severity.
 */
export function printRegistryDiagnostics(): void {
  const registry = getZflowRegistry()
  const diags = registry.getDiagnostics()

  if (diags.length === 0) {
    console.log("ℹ pi-zflow registry: no diagnostics")
    return
  }

  const errors = diags.filter((d) => d.level === "error")
  const warnings = diags.filter((d) => d.level === "warn")
  const infos = diags.filter((d) => d.level === "info")

  if (errors.length > 0) {
    console.group("✖ pi-zflow capability conflicts:")
    for (const d of errors) console.log(formatDiagnostic(d))
    console.groupEnd()
  }
  if (warnings.length > 0) {
    console.group("⚠ pi-zflow capability warnings:")
    for (const d of warnings) console.log(formatDiagnostic(d))
    console.groupEnd()
  }
  if (infos.length > 0) {
    console.group("ℹ pi-zflow capability info:")
    for (const d of infos) console.log(formatDiagnostic(d))
    console.groupEnd()
  }
}

// ── Conflict inspection ──────────────────────────────────────────

/**
 * Check whether a capability is already claimed by another provider.
 *
 * @param capability - Capability name
 * @param provider   - Requesting provider package name
 * @param version    - Requesting provider version
 * @returns A conflict message string if owned by a different provider,
 *          or `null` if the capability is free (or claimed by the same
 *          provider at the same version).
 */
export function checkCapabilityConflict(
  capability: string,
  provider: string,
  version: string,
): string | null {
  const registry = getZflowRegistry()
  const existing = registry.getClaim(capability)
  if (!existing) return null
  if (existing.provider === provider && existing.version === version)
    return null
  return (
    `Capability "${capability}" is already owned by ` +
    `${existing.provider}@${existing.version} (from ${existing.sourcePath}). ` +
    `${provider}@${version} cannot claim it. ` +
    `Use package filtering to exclude one package.`
  )
}

/**
 * Format an actionable installation hint for a missing capability.
 *
 * @param capability     - Missing capability name
 * @param suggestedPackage - Optional explicit npm package name; defaults to
 *                           `pi-zflow-${capability}`
 */
export function formatMissingCapability(
  capability: string,
  suggestedPackage?: string,
): string {
  const pkg = suggestedPackage ?? `pi-zflow-${capability}`
  return (
    `Required capability "${capability}" is not available.\n` +
    `  Install: pi install npm:${pkg}\n` +
    `  Or add "${pkg}" to your Pi package configuration.`
  )
}

/**
 * Check whether a command name would collide with an already-registered
 * command from another package.
 *
 * TODO(phase-2): Implement actual Pi command registry inspection when
 * Pi exposes a command-discovery API. For Phase 1 this validates only
 * the `/zflow-*` naming convention.
 *
 * @param commandName - Full slash command name (e.g. "/zflow-profile")
 * @param packageName - Owning package name for error messages
 * @returns A collision/naming warning string, or `null` if no issue
 */
export function checkCommandCollision(
  commandName: string,
  packageName: string,
): string | null {
  // Phase 1: validate naming convention only
  if (!commandName.startsWith("/zflow-")) {
    return (
      `Command "${commandName}" from ${packageName} does not follow the ` +
      `/zflow-* naming convention. Commands must be namespaced to avoid ` +
      `collisions with other packages.`
    )
  }
  return null
}

// ── Capability summary ───────────────────────────────────────────

/**
 * Print a summary of all registered capabilities and their providers.
 */
export function printCapabilitySummary(): void {
  const registry = getZflowRegistry()
  const caps = registry.getCapabilities()

  if (caps.size === 0) {
    console.log("ℹ No pi-zflow capabilities registered.")
    return
  }

  console.log("pi-zflow capability registry:")
  for (const [name, reg] of caps) {
    const serviceStatus =
      reg.service !== undefined
        ? "✓ provided"
        : "○ claimed (no service yet)"
    const duplicates =
      reg.duplicateSources.length > 0
        ? ` (+${reg.duplicateSources.length} duplicate loads)`
        : ""
    console.log(
      `  ${name}: ${reg.claim.provider}@${reg.claim.version} (${serviceStatus})${duplicates}`,
    )
    for (const src of reg.duplicateSources) {
      console.log(`    └ duplicate: ${src}`)
    }
  }
}
