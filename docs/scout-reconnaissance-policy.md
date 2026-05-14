# Scout Reconnaissance Policy

> **Canonical reference for scout-based reconnaissance in pi-zflow workflows.**
> Defines what scout provides, what it should not do, and how its output feeds into planning and implementation.

## Role

Scout is a lazy-loading reconnaissance agent. It provides a concise, high-signal overview of the codebase relevant to the current task area. Scout runs before planning or implementation to give agents and the orchestrator a structural map of the relevant subsystem.

Scout is **advisory, not restrictive**. Its output is a starting point for deeper exploration. Workers may — and should — read additional files beyond what scout lists when the task requires it.

## Expected output qualities

A good scout reconnaissance report includes:

| Quality                              | Description                                                                                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Curated file list**                | The most important files for the task area, not every file in the repo. Grouped by directory with 1-line purpose annotations.                                                               |
| **Architecture summary**             | Key directories, entry points, configuration files, module boundaries, and dependency relationships. Covers only the relevant subsystem.                                                    |
| **Current patterns and conventions** | Code style, testing patterns, build steps, import/export conventions observed in the relevant area.                                                                                         |
| **Test structure and build steps**   | How tests are organised, what test framework is used, how to run specific tests, build commands and their outputs.                                                                          |
| **Hidden constraints**               | Gotchas, deprecation markers, unusual patterns, commonly-misread files, dependencies that are easy to miss.                                                                                 |
| **Conciseness**                      | Total output fits within the `maxOutput` limit (6000 characters). Focuses on signal, not volume. Skips boilerplate, generated code, and vendored dependencies unless specifically relevant. |

## Output format

Scout output follows a structured markdown format with clear sections:

```markdown
### Architecture Overview

Brief description of the subsystem structure, key directories (max 3 levels deep), entry points, config files, and module boundaries.

### Patterns and Conventions

Code style, testing framework/patterns, build steps, import conventions observed in the relevant area.

### Key Files

Curated list of the most important files for the current task, grouped by directory with 1-line purpose annotations.

### Hidden Constraints

Gotchas, deprecations, unusual patterns, commonly-misread files, easy-to-miss dependencies.

### Recommendations

Suggested files to read for deeper understanding, areas needing special attention, test files to consult.
```

## What scout should NOT do

- **Dump entire file contents.** Scout lists files and annotates purpose; it does not include full file contents or large code blocks.
- **List every file in the repo.** Scout curates. If the relevant subsystem is large, scout offers to produce focused maps for sub-areas rather than one giant list.
- **Make implementation decisions.** Scout reports structure and patterns. It does not design solutions, write code, or decide implementation strategy.
- **Override worker file reads.** Workers must read files themselves for exact details. Scout's annotations are summaries, not replacements for direct file access.
- **Run expensive or noisy operations.** Scout avoids full-tree greps, unbounded bash commands, and operations that would consume disproportionate context or time.

## Relationship to other context layers

| Layer                                                       | Role                                                                         |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Scout reconnaissance** (this policy)                      | Lazy-loading structural overview, advisory only                              |
| **Code skeleton** (`code-skeleton` skill)                   | Detailed structural summary of specific modules (exports, signatures, types) |
| **Repository map** (`repository-map` skill)                 | High-level directory overview for orientation, generated when needed         |
| **Context guard** (`pi-mono-context-guard`)                 | Prevention layer: deduplicates reads, bounds output, limits raw grep         |
| **Compaction** (`pi-rtk-optimizer` + `pi-zflow-compaction`) | Output compaction and session compaction at ~60–70% usage                    |

When planning a change, start with scout for orientation, use code skeletons for the specific modules you will modify, and refer to the repo map for structural context.

## Usage in workflows

- **Prepare phase**: scout runs first to provide codebase context for the planner.
- **Implement phase**: scout output is available as optional context for workers.
- **After compaction**: if scout output is stale, regenerate it rather than relying on the compaction summary.

## Acceptance criteria

- Scout output is concise, structured, and fits within `maxOutput`.
- Scout helps narrow context without blocking necessary follow-up reads.
- Workers know that scout output is advisory and may read additional files.
- Scout does not dump raw file contents or exhaustive file listings.
