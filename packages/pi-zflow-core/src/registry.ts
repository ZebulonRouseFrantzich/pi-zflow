/**
 * pi-zflow-core — shared capability registry
 *
 * Backed by `globalThis` so duplicate physical installs of pi-zflow-core
 * still share one capability map. Child packages use this to claim
 * capability ownership, provide service instances, and discover optional
 * or required dependencies from other packages.
 *
 * Design rules from package-split-details.md:
 * - Same package/capability/version loaded twice: no-op or return existing service.
 * - Compatible provider already loaded: no-op and record both sources for diagnostics.
 * - Incompatible provider/version already loaded: emit a clear diagnostic and do not
 *   register conflicting hooks/tools/commands.
 * - Required missing dependency: command should stop with an actionable message
 *   naming the package to install.
 * - Optional missing dependency: command should degrade only where permitted.
 *
 * @module
 */

// ── Types ────────────────────────────────────────────────────────

/** Version matching strategy for capability claims. */
export type CompatibilityMode = "exact" | "compatible"

/**
 * A capability claim — a package registering that it owns a named capability.
 */
export interface CapabilityClaim {
  /** Capability name (e.g. "profiles", "review", "artifacts") */
  capability: string
  /** Claimed version string (e.g. "0.1.0") */
  version: string
  /** Package name that owns this capability (e.g. "pi-zflow-profiles") */
  provider: string
  /** Source file URL for diagnostics (typically `import.meta.url`) */
  sourcePath: string
  /** How strict version comparison should be. Defaults to "exact". */
  compatibilityMode?: CompatibilityMode
}

/**
 * A registered capability in the registry.
 */
export interface RegisteredCapability {
  /** The original capability claim */
  claim: CapabilityClaim
  /** Additional source paths that claimed the same compatible capability */
  duplicateSources: string[]
  /** Resolved service instance, if provided via `provide()` */
  service: unknown
  /** Timestamp of the first claim in ms since epoch */
  claimedAt: number
}

/** Callback for capability change events. */
export type CapabilityChangeListener = (event: CapabilityChangeEvent) => void

/** Event payload for capability changes. */
export interface CapabilityChangeEvent {
  type: "claimed" | "provided" | "updated" | "removed"
  capability: string
  provider: string
  version: string
}

/** A diagnostic entry accumulated by the registry. */
export interface RegistryDiagnostic {
  level: "info" | "warn" | "error"
  message: string
  capability?: string
  provider?: string
  timestamp: number
}

/**
 * Error thrown when a required capability is not available.
 */
export class MissingCapabilityError extends Error {
  constructor(
    public readonly capability: string,
    message?: string,
  ) {
    super(
      message ??
        `Required capability "${capability}" is not available. ` +
          `Install the package that provides it (e.g. \`pi install npm:pi-zflow-${capability}\`).`,
    )
    this.name = "MissingCapabilityError"
  }
}

/**
 * Error thrown when an incompatible capability claim conflicts with an existing one.
 */
export class IncompatibleCapabilityError extends Error {
  constructor(
    public readonly capability: string,
    public readonly existing: CapabilityClaim,
    public readonly incoming: CapabilityClaim,
    message?: string,
  ) {
    super(
      message ??
        `Incompatible capability "${capability}": ${incoming.provider}@${incoming.version} ` +
          `conflicts with ${existing.provider}@${existing.version}. ` +
          `Use package filtering to exclude one of them.`,
    )
    this.name = "IncompatibleCapabilityError"
  }
}

// ── Global registry key ──────────────────────────────────────────

/** Well-known symbol key for the global registry. */
const GLOBAL_REGISTRY_KEY = Symbol.for("pi-zflow-core:registry")

// ── Version compatibility helpers ────────────────────────────────

/**
 * Check whether two version strings are compatible.
 *
 * For Phase 1 this is a simple equality check. Later phases should
 * implement semver range matching (`^0.1.0` matches `0.1.x`,
 * `>=0.2.0` matches major bumps, etc.).
 *
 * TODO(phase-2): Replace with semver range matching from a library.
 *
 * @param a - First version string
 * @param b - Second version string
 * @param mode - Matching strategy; defaults to "exact"
 */
export function areVersionsCompatible(
  a: string,
  b: string,
  mode: CompatibilityMode = "exact",
): boolean {
  if (mode === "exact") return a === b
  // TODO(phase-2): Implement semver range compatibility
  return a === b
}

// ── Internal registry state ──────────────────────────────────────

/**
 * Complete state object stored on globalThis.
 */
interface RegistryState {
  capabilities: Map<string, RegisteredCapability>
  listeners: Map<string, Set<CapabilityChangeListener>>
  diagnostics: RegistryDiagnostic[]
  initialized: boolean
}

function createInitialState(): RegistryState {
  return {
    capabilities: new Map(),
    listeners: new Map(),
    diagnostics: [],
    initialized: true,
  }
}

// ── Registry accessor ────────────────────────────────────────────

/**
 * Get or create the shared zflow registry singleton.
 *
 * Uses `Symbol.for("pi-zflow-core:registry")` so that multiple physical
 * copies of pi-zflow-core (loaded through different package roots in
 * the Pi module loader) all share the same underlying state.
 *
 * No import-time side effects beyond initializing the global object
 * on first access.
 */
export function getZflowRegistry(): ZflowRegistry {
  const existing = (globalThis as any)[GLOBAL_REGISTRY_KEY] as
    | RegistryState
    | undefined
  if (existing?.initialized) {
    return new ZflowRegistry(existing)
  }
  const state = createInitialState()
  ;(globalThis as any)[GLOBAL_REGISTRY_KEY] = state
  return new ZflowRegistry(state)
}

/**
 * Reset the shared registry state.
 *
 * Intended for testing only. Calling this mid-session will orphan any
 * existing `ZflowRegistry` instances and all registered capabilities.
 */
export function resetZflowRegistry(): void {
  delete (globalThis as any)[GLOBAL_REGISTRY_KEY]
}

// ── ZflowRegistry class ──────────────────────────────────────────

/**
 * Shared capability registry for pi-zflow child packages.
 *
 * Every method reads from and writes to the shared `globalThis`-backed
 * state, so all copies of pi-zflow-core in the process observe the same
 * capabilities and services.
 */
export class ZflowRegistry {
  constructor(private readonly state: RegistryState) {}

  // ── Claim ────────────────────────────────────────────────────

  /**
   * Claim ownership of a capability.
   *
   * | Scenario | Behaviour |
   * |---|---|
   * | First claim for this capability | Registers and emits `claimed` event |
   * | Same provider + same version again | No-op; returns existing registration |
   * | Different provider, compatible version | Records duplicate source; returns existing |
   * | Different provider, incompatible version | Emits error diagnostic; returns `null` |
   *
   * @returns The registered capability if the claim was accepted or
   *          already existed, or `null` if the claim was rejected due
   *          to an incompatible existing claim.
   */
  claim(claim: CapabilityClaim): RegisteredCapability | null {
    const existing = this.state.capabilities.get(claim.capability)

    if (existing) {
      const compatible = areVersionsCompatible(
        existing.claim.version,
        claim.version,
        claim.compatibilityMode,
      )

      // Same provider + same version → no-op
      if (compatible && existing.claim.provider === claim.provider) {
        this.addDiagnostic({
          level: "info",
          message: `Capability "${claim.capability}" already claimed by ${existing.claim.provider}@${existing.claim.version}; duplicate load from ${claim.provider}@${claim.version} is a no-op.`,
          capability: claim.capability,
          provider: claim.provider,
        })
        return existing
      }

      // Compatible version from a different provider → record duplicate source
      if (compatible) {
        existing.duplicateSources.push(
          `${claim.provider}@${claim.version} (${claim.sourcePath})`,
        )
        this.addDiagnostic({
          level: "info",
          message: `Capability "${claim.capability}" already provided by ${existing.claim.provider}@${existing.claim.version}; also loaded from ${claim.provider}@${claim.version}.`,
          capability: claim.capability,
          provider: claim.provider,
        })
        return existing
      }

      // Incompatible version → error, reject claim
      this.addDiagnostic({
        level: "error",
        message:
          `Incompatible capability "${claim.capability}": ` +
          `${claim.provider}@${claim.version} (from ${claim.sourcePath}) ` +
          `conflicts with ${existing.claim.provider}@${existing.claim.version}. ` +
          `Use package filtering to exclude one of them.`,
        capability: claim.capability,
        provider: claim.provider,
      })
      return null
    }

    // First claim
    const registered: RegisteredCapability = {
      claim: { ...claim },
      duplicateSources: [],
      service: undefined,
      claimedAt: Date.now(),
    }
    this.state.capabilities.set(claim.capability, registered)
    this.emitChange({
      type: "claimed",
      capability: claim.capability,
      provider: claim.provider,
      version: claim.version,
    })
    return registered
  }

  // ── Provide ──────────────────────────────────────────────────

  /**
   * Set the service instance for a previously claimed capability.
   *
   * The capability **must** already be claimed via `claim()` first.
   *
   * @throws {Error} If the capability has not been claimed yet.
   */
  provide<T = unknown>(capability: string, service: T): void {
    const existing = this.state.capabilities.get(capability)
    if (!existing) {
      throw new Error(
        `Cannot provide service for unclaimed capability "${capability}". Call claim() first.`,
      )
    }
    existing.service = service
    this.emitChange({
      type: "provided",
      capability,
      provider: existing.claim.provider,
      version: existing.claim.version,
    })
  }

  // ── Get (required) ───────────────────────────────────────────

  /**
   * Get a service instance for a **required** capability.
   *
   * Throws `MissingCapabilityError` if the capability has not been
   * claimed and provided. The error message includes an actionable
   * hint naming the package to install.
   *
   * Use `optional()` for capabilities that may be absent.
   */
  get<T = unknown>(capability: string): T {
    const existing = this.state.capabilities.get(capability)
    if (!existing) {
      throw new MissingCapabilityError(
        capability,
        `Required capability "${capability}" is not available. ` +
          `Install the package that provides it ` +
          `(e.g. \`pi install npm:pi-zflow-${capability}\`).`,
      )
    }
    if (existing.service === undefined) {
      throw new MissingCapabilityError(
        capability,
        `Capability "${capability}" is claimed by ${existing.claim.provider} ` +
          `but no service has been provided yet. This is likely a load-order issue. ` +
          `Ensure ${existing.claim.provider} initialises before consumers.`,
      )
    }
    return existing.service as T
  }

  // ── Optional ─────────────────────────────────────────────────

  /**
   * Get a service instance for an **optional** capability.
   *
   * Returns `undefined` if the capability is not claimed or not yet
   * provided. Callers should degrade gracefully when an optional
   * dependency is absent.
   */
  optional<T = unknown>(capability: string): T | undefined {
    const existing = this.state.capabilities.get(capability)
    if (!existing) return undefined
    return existing.service as T | undefined
  }

  // ── Listen ───────────────────────────────────────────────────

  /**
   * Subscribe to capability change events.
   *
   * Returns an unsubscribe function. The listener is invoked for
   * `claimed`, `provided`, `updated`, and `removed` events on the
   * named capability.
   */
  onChange(
    capability: string,
    listener: CapabilityChangeListener,
  ): () => void {
    if (!this.state.listeners.has(capability)) {
      this.state.listeners.set(capability, new Set())
    }
    const listeners = this.state.listeners.get(capability)!
    listeners.add(listener)

    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        this.state.listeners.delete(capability)
      }
    }
  }

  // ── Diagnostics ──────────────────────────────────────────────

  /** Append a diagnostic entry to the shared log. */
  addDiagnostic(diag: Omit<RegistryDiagnostic, "timestamp">): void {
    this.state.diagnostics.push({ ...diag, timestamp: Date.now() })
  }

  /** Get all accumulated diagnostic entries (read-only snapshot). */
  getDiagnostics(): readonly RegistryDiagnostic[] {
    return [...this.state.diagnostics]
  }

  /** Get a snapshot of all registered capabilities. */
  getCapabilities(): ReadonlyMap<string, RegisteredCapability> {
    return new Map(this.state.capabilities)
  }

  /** Check whether a capability has been claimed. */
  has(capability: string): boolean {
    return this.state.capabilities.has(capability)
  }

  /** Get the claim for a capability, or `undefined` if not claimed. */
  getClaim(capability: string): CapabilityClaim | undefined {
    return this.state.capabilities.get(capability)?.claim
  }

  // ── Internal ─────────────────────────────────────────────────

  private emitChange(event: CapabilityChangeEvent): void {
    const listeners = this.state.listeners.get(event.capability)
    if (!listeners) return
    for (const listener of listeners) {
      try {
        listener(event)
      } catch (err) {
        this.addDiagnostic({
          level: "error",
          message: `Capability change listener for "${event.capability}" threw: ${err}`,
          capability: event.capability,
        })
      }
    }
  }
}
