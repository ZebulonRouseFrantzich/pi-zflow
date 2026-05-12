# Path Guard and Sentinel Policy — Allowlist-First Mutation Safety

> **Policy document.** Phase 0, Task 0.10.
> Defines the inputs needed by the future path guard, the allowlist-first model,
> and the configuration contract that later safety/orchestration code will enforce.

## Objective

Every mutating operation in pi-zflow must be gated by a **path guard** that
prevents writes to sensitive or unauthorised locations. This document defines:

1. The **allowlist-first security model**.
2. The **inputs** the path guard needs from configuration and runtime context.
3. The **write-intent distinction** (planner vs implementer).
4. The **default sentinel policy** shipped with pi-zflow-core.

## Allowlist-first model

> **Nothing is writable by default.** Every write target must be explicitly
> approved by the path guard.

The decision algorithm (`canWrite()`):

```
1. Resolve the real path (reject symlink escape and ".." traversal).
2. ✅ Is it within an allowed root?              → continue
   ❌ Not in any allowed root                    → DENY
3. ✅ Does it NOT match any blocked pattern?     → continue
   ❌ Matches blocked pattern (severity: error)   → DENY
   ⚠ Matches blocked pattern (severity: warn)    → ALLOW with diagnostic
4. ✅ Does write intent match the root's intent?  → ALLOW
   ❌ Intent mismatch (e.g. implementer writing   → DENY
      to planner-artifact directory)
```

This replaces the implicit "everything is writable" default with an explicit,
**auditable** allowlist. Every new project root or temp worktree must be added
to the allowlist before writes are accepted.

## Inputs needed by the future path guard

### 1. Configuration inputs (from `SentinelPolicy`)

These are static configuration values loaded at startup (from a config file,
environment, or hard-coded defaults):

| Input                                       | Type               | Description                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allowedRoots`                              | `AllowedRoot[]`    | Directories where mutations are permitted. Each has a path, optional glob flag, and optional intent restriction.                                                                                                                                                                  |
| `blockedPatterns`                           | `BlockedPattern[]` | Glob patterns for paths that must never be mutated, even inside allowed roots. Each has a pattern, reason, severity, and optional `exclude[]` patterns for intentional carve-outs (e.g., `.git/**` excludes `<runtime-state-dir>/**` because runtime state lives inside `.git/`). |
| `symlinkSafety.resolveSymlinks`             | `boolean`          | Whether to follow symlinks and check the real path against the allowlist.                                                                                                                                                                                                         |
| `symlinkSafety.preventTraversal`            | `boolean`          | Whether to reject `..` traversal that escapes the project root.                                                                                                                                                                                                                   |
| `plannerArtifactPolicy.allowedArtifactDirs` | `string[]`         | Glob patterns for directories where planner artifact writes are permitted.                                                                                                                                                                                                        |

### 2. Runtime inputs (from `PathGuardContext`)

These are resolved at the time of the write operation:

| Input             | Type                      | Description                                                                                       |
| ----------------- | ------------------------- | ------------------------------------------------------------------------------------------------- |
| `projectRoot`     | `string`                  | Resolved working-tree root (where `.git/` lives).                                                 |
| `runtimeStateDir` | `string`                  | Resolved `<git-dir>/pi-zflow/` or temp fallback.                                                  |
| `intent`          | `WriteIntent`             | What kind of write this is: `"planner-artifact"`, `"implementation"`, `"system"`, or `"unknown"`. |
| `meta`            | `Record<string, string>?` | Extra diagnostic metadata (run id, agent name).                                                   |

### 3. The write target

| Input        | Type     | Description                                             |
| ------------ | -------- | ------------------------------------------------------- |
| `targetPath` | `string` | The file or directory path the caller intends to write. |

## Write-intent distinction

The path guard distinguishes **four write intents**, each with different
permissions:

| Intent               | Allowed roots                                  | Blocked patterns                      | Planner artifact dirs                               |
| -------------------- | ---------------------------------------------- | ------------------------------------- | --------------------------------------------------- |
| `"planner-artifact"` | All allowed roots                              | Yes                                   | ✅ Permitted (and enforced)                         |
| `"implementation"`   | All allowed roots except planner-artifact dirs | Yes                                   | ❌ Denied — implementers must not modify plan state |
| `"system"`           | All allowed roots                              | Soft-blocked only (`"warn"` severity) | ✅ Permitted (cleanup operations)                   |
| `"unknown"`          | Conservative: denied unless explicitly allowed | Yes                                   | ❌ Denied                                           |

### Why this matters

- Must-preserve Decision #14: **"The planner must never modify source code."**
  Planner writes are restricted to `<runtime-state-dir>/plans/` and similar
  artifact directories. If a planner tries to write to `src/app.ts`, the
  path guard denies it.
- Conversely, **implementers must not trample plan state**. Worker subagents
  are denied writes to `<runtime-state-dir>/plans/`, keeping plan artifacts
  safe from accidental modification.

## Default sentinel policy

The baseline policy is defined in:

```
packages/pi-zflow-core/config/sentinel-policy.default.json
```

### Default allowed roots

| Root                            | Intent             | Purpose                                        |
| ------------------------------- | ------------------ | ---------------------------------------------- |
| `.` (project root)              | `implementation`   | The repo working tree — implementation writes  |
| `<runtime-state-dir>/plans/**`  | `planner-artifact` | Plan artifacts (via `plannerArtifactPolicy`)   |
| `<runtime-state-dir>/review/**` | `planner-artifact` | Review artifacts (via `plannerArtifactPolicy`) |

### Default blocked patterns (severity: error)

| Pattern                                       | Reason                   | Notes                                                                  |
| --------------------------------------------- | ------------------------ | ---------------------------------------------------------------------- |
| `.git/**`                                     | Git internals            | Excludes `<runtime-state-dir>/**` (runtime state lives inside `.git/`) |
| `.gitignore`, `.gitattributes`, `.gitmodules` | Git config files         |                                                                        |
| `node_modules/**`                             | Package-manager managed  |                                                                        |
| `.env*`                                       | Environment/secret files |                                                                        |
| `**/*.pem`, `**/*.key`                        | Private key files        |                                                                        |
| `**/credentials*`, `**/secrets/**`            | Credential files         |                                                                        |
| `~/.ssh/**`, `~/.aws/**`, `~/.pi/**`          | User-sensitive config    |                                                                        |
| `~/.config/**`                                | User config (warn)       |                                                                        |

### Default blocked patterns (severity: warn)

| Pattern        | Reason                               |
| -------------- | ------------------------------------ |
| `dist/**`      | Build output (modify source instead) |
| `.cache/**`    | Cache directory                      |
| `.next/**`     | Next.js build output                 |
| `~/.config/**` | User config (soft-blocked)           |

> Patterns with severity `"warn"` allow the write but emit a diagnostic.
> They are candidates for hardening once the foundation is stable.

## How later phases will consume this

### Phase 2: Planning mode (`pi-zflow-plan-mode`)

The `/zflow-plan` mode activates a **restricted bash policy** that wraps every
bash tool call with a `canWrite()` check. Any write denied by the path guard
is blocked with an actionable error message.

**File**: `packages/pi-zflow-plan-mode/extensions/zflow-plan-mode/bash-policy.ts`

```ts
// Pseudocode for Phase 2
import { canWrite } from "pi-zflow-core/path-guard";

function implementBashPolicy(ctx, policy) {
  // 1. Intercept bash tool calls
  // 2. Parse the command to extract write targets (mv, cp, rm, redirects, etc.)
  // 3. For each write target, call canWrite()
  // 4. If denied, block the command and show the denial reason
  // 5. If warned, execute but log the warning
}
```

### Phase 7: Change workflows (`pi-zflow-change-workflows`)

The `/zflow-change-implement` workflow calls `canWrite()` before every file
write, edit, or destructive bash command. This is the primary enforcement
point for the allowlist-first model.

**File**: `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/path-guard.ts`

```ts
// Pseudocode for Phase 7
import { canWrite } from "pi-zflow-core/path-guard";

function guardWrite(targetPath, intent, policy) {
  const result = canWrite(targetPath, {
    policy,
    projectRoot: resolveProjectRoot(),
    runtimeStateDir: resolveRuntimeStateDir(),
    intent,
  });
  if (!result.allowed) {
    throw new Error(result.message);
  }
}
```

## TypeScript types / importable reference

The full path guard contract is defined in:

```
packages/pi-zflow-core/src/path-guard.ts
```

Key exports:

- `SentinelPolicy` — Complete policy configuration object
- `AllowedRoot` — A single allowlist entry
- `BlockedPattern` — A single deny pattern
- `SymlinkSafetyConfig` — Symlink and traversal safety config
- `PlannerArtifactPolicy` — Planner artifact write policy
- `WriteIntent` — `"planner-artifact" | "implementation" | "system" | "unknown"`
- `PathGuardContext` — Full runtime context for `canWrite()`
- `CanWriteResult` — `{ allowed, message, reason?, matchedPattern? }`
- `canWrite()` — The core path-guard decision function
- `realpathSafe()` — Safe realpath rejecting symlink escape and traversal
- `isWithinAllowedRoots()` — Check if a path is within allowed roots
- `matchesBlockedPatterns()` — Check if a path matches blocked patterns
- `resolveSentinelPolicy()` — Build a fully-resolved policy from defaults + overrides

## Related

- `packages/pi-zflow-core/src/path-guard.ts` — TypeScript contract and runner
- `packages/pi-zflow-core/config/sentinel-policy.default.json` — Default policy
- `packages/pi-zflow-core/config/sentinel-policy.schema.json` — JSON Schema
- `packages/pi-zflow-plan-mode/extensions/zflow-plan-mode/bash-policy.ts` — Phase 2 bash policy (stub)
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/path-guard.ts` — Phase 7 path guard (stub)
- `docs/architecture/package-ownership.md` — Overlap-avoidance policy
