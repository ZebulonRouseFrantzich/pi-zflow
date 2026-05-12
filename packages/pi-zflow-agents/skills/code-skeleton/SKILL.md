---
name: code-skeleton
description: |
  Compact module maps and signature overviews that describe code structure
  without requiring full source reads. Used during planning, context
  building, and review to understand module shapes efficiently.
---

# Code Skeleton

Use this skill when you need to understand a module's structure, exports, and
signatures without reading every line of source. A skeleton is a compact
structural summary.

## When to Produce a Skeleton

- **Planning** — to understand which modules a change affects and their public
  interfaces, before writing the design artifact.
- **Context building** — to give another agent a structural overview without
  passing hundreds of lines of source.
- **Review preparation** — to map the modules touched by a change before
  reviewing the diff.
- **After compaction** — when rereading canonical state, a skeleton is faster
  than re-reading full source files.

## Skeleton Format

A module skeleton captures:

```markdown
### `path/to/module.ts`

**Exports**:

- `interface Config { ... }` — key fields (list the main ones)
- `function createRouter(routes: Route[]): Router` — signature and one-line purpose
- `type Route = { path: string; handler: Handler }` — key types
- `class SessionStore extends EventEmitter` — public methods and inheritance

**Imports from this module** (major consumers):

- `src/api/index.ts` — uses `createRouter`
- `src/middleware/auth.ts` — uses `SessionStore`

**Patterns to follow**:

- Async initialiser pattern (create + init)
- Error handling: returns `Result<T, Error>` union
```

### Conventions

- **Exports**: list only public API surface. Internal/private functions can be
  omitted unless they are relevant to the change.
- **Signatures**: show parameter names and types, return type, and one-line
  purpose. Omit implementation details.
- **Imports from this module**: list only the most significant consumers.
  `grep -r "from './module'"` or equivalent can find these.
- **Patterns to follow**: note conventions that an implementer should match
  (error handling, initialisation, logging, etc.).
- Keep each skeleton to **≤30 lines** of markdown per file. If a file needs
  more, it may be a sign the file has too many responsibilities.

## Module Map Convention

When describing a set of related files (e.g. all files in a change), produce a
module map:

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

This map is useful as a quick reference during implementation and review.

## Relationship to Repository-Map Skill

- **Repository map** (`repository-map` skill): a high-level overview of the
  entire repo or a large subsystem. Useful for initial orientation.
- **Code skeleton** (this skill): a detailed structural summary of specific
  modules. Useful for planning and implementation.

When planning a change, start with a repo map for orientation, then produce
skeletons for the specific modules you will modify.
