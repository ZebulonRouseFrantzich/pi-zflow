# Code-Skeleton Usage Policy

> **Usage guide for the `code-skeleton` skill in context-optimized workflows.**
> Phase 8 — Context Management Optimization.

## Overview

The `code-skeleton` skill provides compact module structure summaries (exports,
signatures, types) without requiring full source reads. It is one of several
context-optimization layers designed to reduce token consumption while
preserving architectural understanding.

Skeletons are **advisory structural maps** — they tell you what a module
exposes and how it connects, but not how it works internally.

## When to produce skeletons

| Scenario                       | Rationale                                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| **Before planning**            | Understand which modules a change affects and their public interfaces before writing the design artifact. |
| **Context handoff**            | Give another agent a structural overview without passing hundreds of lines of source code.                |
| **After compaction**           | Re-establish module understanding quickly after a compaction cycle rather than re-reading full files.     |
| **Review preparation**         | Map the modules touched by a change before reviewing the diff.                                            |
| **Rapid codebase exploration** | Get a sense of module boundaries and APIs before deciding which files need detailed reading.              |

## When NOT to use skeletons

| Scenario                          | Do this instead                                                                                 |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Implementation details matter** | Use full `read` to get exact code. Skeletons omit bodies, logic, and edge cases.                |
| **File is small (<50 lines)**     | Read the full file — it costs fewer tokens than producing a skeleton.                           |
| **Content already in context**    | Reuse what is already available. A skeleton duplicates effort.                                  |
| **You need to edit the file**     | Always read the full file before editing. A skeleton is not sufficient for exact text matching. |
| **Debugging or tracing a bug**    | Skeletons omit implementation logic. Use full reads or targeted `grep`.                         |

## Output format

Each module skeleton is a compact markdown section capturing public API surface
and key connections. Keep each skeleton to **≤30 lines** of markdown per file.

### Standard skeleton shape

```markdown
### `path/to/module.ts`

**Exports:**

- `interface Config { ... }` — key fields
- `function createRouter(routes: Route[]): Router` — signature and one-line purpose
- `type Route = { path: string; handler: Handler }` — key types

**Imports from this module (major consumers):**

- `src/api/index.ts` — uses `createRouter`
- `src/middleware/auth.ts` — uses `SessionStore`

**Patterns to follow:**

- Async initialiser pattern (create + init)
- Error handling: returns `Result<T, Error>` union
```

### Conventions

- **Exports only.** List public API surface. Internal/private functions can be
  omitted unless directly relevant to the change.
- **Signatures with purpose.** Show parameter names, types, return type, and a
  one-line purpose. Omit implementation bodies entirely.
- **Imports / consumers.** List only the most significant consumers. Use
  `grep -r "from './module'"` or equivalent to find them.
- **Patterns.** Note conventions an implementer should match (error handling,
  initialisation, logging, async patterns, etc.).
- **≤30 lines.** If a skeleton exceeds 30 lines, the file may have too many
  responsibilities — consider whether a refactor is warranted.

### Module map convention

When describing a set of related files, produce a compact module map:

```text
src/
  api/
    routes.ts          → defines HTTP routes, uses middleware/auth
    middleware/
      auth.ts          → SessionStore-based auth guard
      logging.ts       → request logging wrapper
  core/
    router.ts          → createRouter(), core routing logic
    session.ts         → SessionStore, session lifecycle
    types.ts           → Config, Route, shared types
  index.ts             → exports createApp(), wires everything together
```

## Example: typical skeleton

Given a file `src/auth/service.ts` that exports:

```ts
export interface AuthConfig { issuer: string; audience: string }
export interface AuthService { verify(token: string): Promise<UserClaims> }
export function createAuthService(config: AuthConfig): AuthService { ... }
```

The skeleton would be:

```markdown
### `src/auth/service.ts`

**Exports:**

- `createAuthService(config: AuthConfig): AuthService` — factory for auth verification
- `AuthConfig { issuer: string; audience: string }` — configuration shape
- `AuthService { verify(token: string): Promise<UserClaims> }` — verification contract

**Imports from this module:**

- `src/api/routes.ts` — calls `createAuthService` at startup
```

This skeleton uses 9 lines and conveys the module's full public surface.

## Relationship to repository-map skill

| Skill            | Purpose                       | Granularity               | When to use                         |
| ---------------- | ----------------------------- | ------------------------- | ----------------------------------- |
| `repository-map` | High-level directory overview | Whole repo or subsystem   | Initial orientation                 |
| `code-skeleton`  | Detailed module structure     | Specific files or modules | Planning, handoff, after compaction |

Start with a repo map for orientation, then produce skeletons for the specific
modules you will modify.

## Relationship to other context layers

- **Scout reconnaissance:** Provides curated file lists and architecture
  summaries. Use scout to decide which modules need skeletons.
- **Compaction:** After a compaction cycle, generate skeletons for modules that
  were discussed before compaction rather than re-reading full files.
- **Full reads:** When editing a file or debugging, always read the full file.
  Skeletons are not a substitute for exact source text.
