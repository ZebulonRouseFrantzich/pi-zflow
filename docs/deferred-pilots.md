# Deferred Context / Navigation Systems

> **Policy document.** These context-management and navigation systems are
> intentionally excluded from the v1 foundation. They must not be added
> during Phase 8 or any later phase without explicit re-evaluation and
> approval against the Phase 8 baseline.

## Purpose

The master plan and the Phase 8 design intentionally defer several
context-management and navigation stacks. This document makes those
deferrals explicit so that future contributors understand:

- What was considered and intentionally excluded
- Why it was deferred
- What would trigger re-evaluation
- What alternative is used instead

## Baseline policy

Future experiments with memory, indexing, or navigation stacks must be
**measured against the Phase 8 baseline** rather than layered in casually.
Any new system must demonstrate a clear improvement over the existing
multi-layer approach (prevention + compaction + scout reconnaissance +
code skeletons + repo maps + small skills + output limits + canonical
artifact rereads) before it can be adopted.

## Deferred systems

---

### `pi-dcp`

| Attribute                 | Description                                                                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What it does**          | Data-centric processing framework for structured context extraction and transformation.                                                                    |
| **Why deferred**          | Not needed in the v1 foundation. The existing compaction and prompt-assembly layers handle context construction adequately for the planned workflow scope. |
| **Re-evaluation trigger** | If workflows require structured, cross-session context extraction beyond what compaction summaries and canonical artifact rereads provide.                 |
| **Alternative**           | Canonical artifact rereads (compacted summaries + file-backed artifacts) provide cross-session context continuity without introducing a new framework.     |

---

### `pi-observational-memory`

| Attribute                 | Description                                                                                                                                                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What it does**          | External memory stack for persisting agent observations, decisions, and state across sessions.                                                                                                                                                     |
| **Why deferred**          | External memory stacks remain deferred pilots per the master plan. The v1 foundation relies on file-backed canonical artifacts (plan-state, repo-map, reconnaissance, failure-log) for cross-session state, which is simpler and more transparent. |
| **Re-evaluation trigger** | If workflows require persistent cross-session learning or memory that file-backed artifacts cannot support — for example, accumulating project-wide conventions over many sessions.                                                                |
| **Alternative**           | File-backed canonical artifacts (`plan-state.json`, `repo-map.md`, `reconnaissance.md`, `failure-log.md`) in `<runtime-state-dir>`. These are explicit, inspectable, and do not introduce opaque memory stacks.                                    |

---

### `manifest.build`

| Attribute                 | Description                                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **What it does**          | Build manifest generation and dependency tracking for repository analysis.                                                                                                                                               |
| **Why deferred**          | Not part of the first-pass foundation. Repo-map generation and code-skeleton usage cover the common orientation and dependency-tracking use cases without the complexity of a full build-manifest system.                |
| **Re-evaluation trigger** | If the repo-map approach proves insufficient for understanding complex multi-package dependency graphs, or if build-aware planning (e.g., "which packages are affected by this change?") becomes a workflow requirement. |
| **Alternative**           | Repository maps (`repo-map.md` generated by `buildRepoMap()`) and code skeletons (via the `code-skeleton` skill) provide structural and dependency overview without a build-manifest framework.                          |

---

### `nono`

| Attribute                 | Description                                                                                                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What it does**          | Rule-based policy enforcement and constraint checking for code generation and modification.                                                                                                                                             |
| **Why deferred**          | Not part of the first-pass foundation. The existing plan-validator, deviation protocol (`plan-drift-protocol` skill), and verification/fix-loop workflow provide a lighter-weight constraint-enforcement path.                          |
| **Re-evaluation trigger** | If rule-based policy enforcement becomes a frequent workflow need that the existing validation and deviation-checking layers cannot satisfy — for example, enforcing project-wide coding standards or API constraints programmatically. |
| **Alternative**           | Plan validation (`zflow.plan-validator`), deviation reports (`plan-drift-protocol` skill), and structured verification (verification/fix-loop in `pi-zflow-change-workflows`).                                                          |

---

### Indexed code navigation foundation

| Attribute                 | Description                                                                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **What it does**          | Full indexed code navigation (cross-reference index, symbol search, dependency graph) for precise codebase understanding.                                                                                                                  |
| **Why deferred**          | Complexity is not justified in v1. The combination of repository maps, code skeletons, grep/find/bash exploration, and scout reconnaissance provides adequate codebase understanding for the planned workflow scope.                       |
| **Re-evaluation trigger** | If the existing exploration tools (repo-map, scout, grep/find) prove insufficient for navigating very large codebases (>100k files) or for tasks requiring precise cross-reference resolution (e.g., "find all callers of this function"). |
| **Alternative**           | Layered approach: repo maps for orientation → code skeletons for structure → targeted `grep`/`find`/`rg` for precise queries → scout for task-specific reconnaissance.                                                                     |

---

### `codemapper` stack

| Attribute                 | Description                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What it does**          | Symbol-indexing and code-navigation stack that provides cross-reference databases and query interfaces.                                                                                                       |
| **Why deferred**          | Not part of the indexed-navigation foundation per the master plan. The `codemapper` stack is intentionally excluded from the v1 foundation to avoid premature commitment to a specific indexing architecture. |
| **Re-evaluation trigger** | Same as indexed code navigation above. If indexed navigation is later piloted, a thin wrapper around `cymbal` should be preferred over adopting `codemapper` as a foundation.                                 |
| **Alternative**           | Same layered approach as indexed code navigation above. If indexed navigation is piloted later, use a thin wrapper around **`cymbal`** rather than `codemapper`.                                              |

## Relationship to current context management layers

The Phase 8 context management layers handle the use cases that these deferred
systems would address, using simpler, more transparent mechanisms:

| Deferred system           | Phase 8 equivalent                                        | Why simpler                                              |
| ------------------------- | --------------------------------------------------------- | -------------------------------------------------------- |
| `pi-dcp`                  | Compaction summaries + canonical artifact rereads         | No new framework; leverages existing Pi compaction hooks |
| `pi-observational-memory` | File-backed artifacts in `<runtime-state-dir>`            | Explicit, inspectable, no opaque memory stack            |
| `manifest.build`          | Repo maps + code skeletons                                | No build-analysis dependency; pure file-tree + grep      |
| `nono`                    | Plan validation + deviation protocol + verification loops | Lighter weight; no rule engine needed                    |
| Indexed code nav          | Repo maps + scout + grep/find                             | No index build/maintenance cost; sufficient for v1 scope |
| `codemapper` stack        | Same layered approach; `cymbal` wrapper if needed later   | Avoids premature architecture commitment                 |

## When to revisit

Re-evaluation of any deferred system should be triggered by **measured
pain points** in real workflow use — not by theoretical improvements or
availability of new tools. Before proposing adoption of a deferred system,
the proponent must:

1. Document the specific workflow gap or failure mode that the deferred
   system would address.
2. Demonstrate that the Phase 8 baseline (prevention + compaction + scout +
   code skeletons + repo maps + small skills + output limits + canonical
   artifact rereads) cannot address the gap with reasonable effort.
3. Measure the expected improvement in cost, latency, or reliability
   against the Phase 8 baseline.
4. Obtain explicit approval from the project maintainers before
   implementing or integrating the deferred system.

## Related documentation

- `README.md` — project overview with high-level deferral reference
- `docs/architecture/package-ownership.md` — single-owner policy and
  prohibited competitors
- `docs/context-guard-policy.md` — prevention layer (pi-mono-context-guard)
- `docs/rtk-optimizer-config.md` — first-pass compaction (pi-rtk-optimizer)
- `docs/compaction-reread-policy.md` — canonical artifact reread policy
- `docs/scout-reconnaissance-policy.md` — scout reconnaissance guidelines
- `docs/code-skeleton-usage.md` — code skeleton usage policy
- `docs/skill-loading-policy.md` — skill and prompt fragment loading policy
- `docs/max-output-policy.md` — output limit enforcement
- `docs/failure-log-readback-policy.md` — failure log readback policy
