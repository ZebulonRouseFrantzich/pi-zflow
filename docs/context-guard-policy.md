# Context Guard Policy

> **Canonical reference for the prevention layer of context management.**
> `pi-mono-context-guard` is the first line of defense against context-window waste.
> It operates at the tool-call interception layer to prevent redundant or unbounded
> output before it enters the transcript.

## Overview

`pi-mono-context-guard` (v1.7.3) is an external Pi extension installed globally.
It is **not** part of the pi-zflow monorepo but is a required runtime dependency
for all pi-zflow sessions. It intercepts Pi tool calls and applies three safeguards
that reduce unnecessary token consumption.

## The three safeguards

### 1. Auto-limit `read` calls

If the model calls `read` without a `limit` parameter, the guard injects a default
limit of **120 lines** and shows a notification. The model can paginate with `offset`
to continue reading.

```json
// Model calls:
{ "path": "src/index.ts" }

// Effective call:
{ "path": "src/index.ts", "limit": 120 }
```

### 2. Deduplicate unchanged `read` calls

If the same file is read again with the same `offset` and `limit`, and the file
has not changed on disk, the guard blocks the duplicate read and returns a short
stub instead of resending the file content.

**Cache invalidation conditions.** A cached entry is reused only when all of the
following are true:

- The same file path is requested
- The same `offset` is requested
- The same `limit` is requested
- The file's modification time has not changed

When a file changes on disk, the cache entry is invalidated. The guard also
listens for the `context-guard:file-modified` event so companion extensions
(such as `pi-mono-multi-edit`) can evict stale cache entries immediately after
writes.

### 3. Bound raw `rg` output in `bash`

If a `bash` command uses `rg` (or `grep`) without an output-bounding operator
such as `head`, `tail`, or `wc`, the guard appends `| head -60` automatically.

```bash
# Model calls:
rg "TODO" src

# Effective command:
rg "TODO" src | head -60
```

## Default configuration

| Setting           | Default | Description                                 |
| ----------------- | ------- | ------------------------------------------- |
| `read` auto-limit | `120`   | Lines to read when no limit is specified    |
| `rg` head limit   | `60`    | Lines to cap raw rg/grep output             |
| Read guard        | enabled | Auto-insert `limit` parameter               |
| Read dedup guard  | enabled | Suppress duplicate reads of unchanged files |
| Raw `rg` guard    | enabled | Append `\| head -60` to unbounded rg calls  |

## Policy rules

### Dedup cache scoping

The dedup cache is **per-session and per-process** only. It is not shared across:

- Separate subagent processes (each subagent has its own cache)
- Isolated worktrees (each worktree session gets a fresh cache)
- Restarted sessions (the cache is in-memory and lost on restart)

This means subagents launched via `pi-subagents` with `worktree: true` will each
have independent dedup caches. This is by design — it prevents stale dedup entries
from one worktree from serving reads against modified files in another.

### When suppression is acceptable

The guard may suppress a `read` call when:

1. The exact same file, offset, and limit was already read in the same process
2. The file has not been modified since the last read
3. The caller is operating in the same session context (same mode, same task)

### When reads must bypass dedup

Subagents and orchestrators MUST be able to reread files after modifications or
across isolated worktrees. The following scenarios are not affected by dedup
because they involve file changes or separate processes:

- After writing a file, the next `read` uses a new modification time → cache miss
- Across subagent launches in separate processes → no shared cache
- After compaction, canonical artifact rereads use explicit paths → fresh reads

## Relationship to the context-management stack

```
Prevention layer:       pi-mono-context-guard   (tool-call interception)
                        ↓
First-pass compaction:  pi-rtk-optimizer        (command rewriting + output compaction)
                        ↓
Hook ownership:         pi-zflow-compaction     (session_before_compact, handoff reminders)
                        ↓
Canonical rereads:      orchestration layer     (file-backed artifact rereads after compaction)
```

The prevention layer is the cheapest and most aggressive filter. It stops waste
before it enters the transcript. Later layers (compaction, post-compaction rereads)
handle what escapes this first filter.

## Integration with pi-zflow workflows

- The guard is **always active** when `pi-mono-context-guard` is installed. No
  pi-zflow-specific activation is required.
- Workflow commands (`/zflow-change-prepare`, `/zflow-change-implement`) rely on
  the guard being installed to prevent unbounded reads during implementation steps.
- Subagent worktrees each get independent dedup caches; the guard does not
  interfere with cross-worktree isolation.
- After compaction, the compaction-handoff reminder tells agents to reread
  canonical artifacts. Since the guard's dedup only applies within the same
  process to unchanged files, a file-backed artifact that was read before
  compaction could still be served from cache if it has not changed. For
  critical rereads, agents should ensure they read with a modified offset or
  rely on the guard cache being independent per subagent process.
