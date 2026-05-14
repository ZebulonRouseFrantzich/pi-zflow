/**
 * pi-zflow-core — shared config schemas
 *
 * Type definitions for configuration objects shared across pi-zflow
 * packages. These are pure TypeScript types (no runtime schemas) for
 * Phase 1.
 *
 * TODO(phase-2): Replace pure TS types with TypeBox runtime schemas for
 * config validation once the validation strategy is settled.
 *
 * @module
 */

// ── Profile configuration ────────────────────────────────────────

/** A single provider/model binding for a lane. */
export interface LaneBinding {
  /** Provider identifier (e.g. "openai-codex", "opencode-go") */
  provider: string
  /** Model identifier (e.g. "gpt-5.4", "mimo-v2.5-pro") */
  model: string
}

/** A logical lane with optional fallback. */
export interface ProfileLane {
  /** Primary model binding */
  primary: LaneBinding
  /** Optional fallback model for redundancy */
  fallback?: LaneBinding
  /** Human-readable lane description */
  description?: string
}

/** A named profile with named lane bindings. */
export interface Profile {
  /** Unique profile name (e.g. "default", "codex-only") */
  name: string
  /** Optional human-readable description */
  description?: string
  /** Lane bindings keyed by lane name (e.g. "planning-frontier", "worker-cheap") */
  lanes: Record<string, ProfileLane>
}

/** Top-level profiles configuration file shape. */
export interface ProfilesConfig {
  /** Name of the default profile to activate on startup */
  defaultProfile: string
  /** All available profiles */
  profiles: Profile[]
}

// ── Agent binding configuration ──────────────────────────────────

/** Metadata about a custom agent definition. */
export interface AgentDefinition {
  /** Agent runtime name (e.g. "zflow.planner-frontier") */
  name: string
  /** Optional display label */
  label?: string
  /** Human-readable description */
  description?: string
  /** File path to the agent markdown file */
  path?: string
}

/** Metadata about a chain definition. */
export interface ChainDefinition {
  /** Chain runtime name (e.g. "zflow.plan-and-implement") */
  name: string
  /** Optional display label */
  label?: string
  /** Human-readable description */
  description?: string
  /** File path to the chain markdown file */
  path?: string
}

/** Install manifest recording deployed agents, chains, and skills. */
export interface InstallManifest {
  /** Package version that was installed (matches package.json version) */
  packageVersion: string
  /** Source reference (npm package name, local path, or git ref) */
  source: string
  /** ISO 8601 timestamp of initial installation */
  installedAt: string
  /** ISO 8601 timestamp of last update */
  updatedAt: string
  /** Filenames of installed agent markdown files (e.g. ["planner-frontier.md"]) */
  installedAgents: string[]
  /** Filenames of installed chain markdown files (e.g. ["parallel-review.chain.md"]) */
  installedChains: string[]
  /** Directory names of installed skill directories (e.g. ["change-doc-workflow"]) */
  installedSkills: string[]
}

/** Descriptor for a custom tool registration. */
export interface ToolRegistration {
  /** Namespaced tool name (e.g. "zflow_write_plan_artifact") */
  name: string
  /** Optional tool description */
  description?: string
}
