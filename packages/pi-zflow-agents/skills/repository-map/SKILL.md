---
name: repository-map
description: |
  Generating and using high-level repository maps for orientation,
  planning, and context handoff. Covers map formats, generation
  techniques, and how to read/interpret the result.
---

# Repository Map

Use this skill when you need a high-level structural overview of a repository
or subsystem — before planning, during context building, or when returning
after compaction.

## What a Repo Map Is

A repository map is a concise tree-style overview of the project's directory
structure, key files, and relationships. It is **not** a full file listing or
a code dump — it is a navigational aid.

Example:

```
src/
  api/
    routes.ts               # HTTP route definitions
    middleware/
      auth.ts               # Authentication guard
      logging.ts            # Request logging
  core/
    router.ts               # Route matching and dispatch
    session.ts              # Session management
    types.ts                # Shared type definitions
  index.ts                  # App entry point
tests/
  api/
    routes.test.ts           # Route integration tests
  core/
    router.test.ts           # Router unit tests
docs/
  architecture.md            # System architecture overview
  change.md                  # Active change document
package.json                 # Dependencies and scripts
```

## When to Generate a Repo Map

- **Initial orientation** — when starting work on an unfamiliar repository.
- **Before planning** — to understand which areas a change will touch.
- **Context handoff** — when passing context to another agent, include a repo
  map so they can navigate independently.
- **After compaction** — regenerate the map rather than relying on memory.

## Generation Techniques

Use tools available in the environment:

```bash
# Full tree (depth 3, exclude noise)
find . -maxdepth 3 -type f \
  ! -path '*/node_modules/*' \
  ! -path '*/.git/*' \
  ! -path '*/dist/*' \
  ! -path '*/build/*' \
  | sort

# Focused on a subsystem
find src/api -type f | sort

# Show directory structure only
find src -type d | sort

# Show entry points (main files)
find . -maxdepth 2 -name 'index.ts' -o -name 'main.ts' -o -name 'index.js' | sort
```

For large repositories, focus on the subsystem relevant to the change rather
than generating a full repo map.

## Map Format Conventions

Keep maps readable and useful:

- **Indentation** shows directory nesting.
- **Comments** (`#`) after file paths describe the file's purpose in 5–10 words.
- **Omit** generated files, lockfiles, vendored dependencies, and config files
  that are not relevant to the change.
- **Group** related files under their directory.
- **Include** test files alongside source to show the testing structure.

## Using the Map

- **For planning**: identify all directories and files the change will affect.
  Note any gaps (missing tests, missing docs) that the plan should address.
- **For context building**: annotate the map with notes about patterns,
  conventions, and pitfalls (e.g. "all API routes use try/catch wrappers").
- **For review**: compare the map of what was changed against the map of what
  was planned. Mismatches indicate potential drift.

## Relationship to Code-Skeleton Skill

- **Repository map** (this skill): a high-level directory overview for
  orientation.
- **Code skeleton** (`code-skeleton` skill): a detailed structural summary of
  specific modules for implementation.

When planning a change, start with a repo map for orientation, then produce
skeletons for the specific modules you will modify.
