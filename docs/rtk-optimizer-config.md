# RTK Optimizer Configuration

> **Canonical reference for the first-pass compaction and command-rewriting layer.**
> `pi-rtk-optimizer` is the second line of defense against context-window waste.
> It operates at the tool-result interception layer, compacting noisy tool output
> and rewriting bash commands to `rtk` equivalents.

## Overview

`pi-rtk-optimizer` is an external Pi extension installed globally. It is **not**
part of the pi-zflow monorepo but is a required runtime dependency for all
pi-zflow sessions. It hooks into Pi's event system at two points:

- **`tool_call`** — Rewrites `bash` commands to `rtk` equivalents or emits suggestions
- **`tool_result`** — Compacts completed tool output before it enters the context window

Its configuration file lives at a platform-specific path:

| Config path                                           | Condition                                   |
| ----------------------------------------------------- | ------------------------------------------- |
| `~/.pi/agent/extensions/pi-rtk-optimizer/config.json` | Default when `PI_CODING_AGENT_DIR` is unset |
| `$PI_CODING_AGENT_DIR/extensions/.../config.json`     | When `PI_CODING_AGENT_DIR` is set           |

## Role in the context-management stack

```
Prevention layer:       pi-mono-context-guard   (tool-call interception)
                        ↓
First-pass compaction:  pi-rtk-optimizer        (command rewriting + output compaction)
                        ↓
Hook ownership:         pi-zflow-compaction     (session_before_compact, handoff reminders)
                        ↓
Canonical rereads:      orchestration layer     (file-backed artifact rereads after compaction)
```

- **pi-rtk-optimizer** owns command rewriting and output compaction. It is the
  first pass that reduces noise from every `bash` and tool result in the session.
- **pi-zflow-compaction** owns `session_before_compact` hooks, proactive compaction
  triggers (~60–70% usage), and compaction handoff reminders. It orchestrates
  _when_ to compact and _what_ to preserve, not how to rewrite or truncate output.
- These two packages are complementary and designed to coexist.

## Recommended configuration

### Core settings

| Setting                    | Recommended | Reason                                                               |
| -------------------------- | ----------- | -------------------------------------------------------------------- |
| `enabled`                  | `true`      | Master switch; must be on for any compaction to occur                |
| `mode`                     | `"rewrite"` | Auto-rewrite bash commands to rtk equivalents (faster, more compact) |
| `guardWhenRtkMissing`      | `true`      | Run original commands when rtk binary is unavailable                 |
| `showRewriteNotifications` | `true`      | Show rewrite notices in TUI for debugging and awareness              |

### Output compaction pipeline: enabled by default

These stages are lossless or nearly lossless for coding workflows and should be
enabled in all profiles:

| Setting                                  | Recommended | Impact                                                |
| ---------------------------------------- | ----------- | ----------------------------------------------------- |
| `outputCompaction.enabled`               | `true`      | Master switch for the entire compaction pipeline      |
| `outputCompaction.stripAnsi`             | `true`      | Removes terminal color codes (always safe)            |
| `outputCompaction.aggregateTestOutput`   | `true`      | Summarizes test runner output to pass/fail counts     |
| `outputCompaction.filterBuildOutput`     | `true`      | Extracts only errors/warnings from build output       |
| `outputCompaction.compactGitOutput`      | `true`      | Condenses `git status`, `git log`, `git diff` output  |
| `outputCompaction.aggregateLinterOutput` | `true`      | Summarizes linter output to warning/error counts      |
| `outputCompaction.groupSearchOutput`     | `true`      | Groups `grep`/`rg` results by file                    |
| `outputCompaction.truncate.enabled`      | `true`      | Enables hard character-limit truncation               |
| `outputCompaction.truncate.maxChars`     | `12000`     | Hard cap at ~12k characters per tool result           |
| `outputCompaction.trackSavings`          | `true`      | Tracks compaction metrics (viewable via `/rtk stats`) |

### Preserving exact file reads: disabled by default

These settings are **off by default** because they alter exact source file content,
which can cause edit-mismatch failures:

| Setting                                       | Recommended | Reason                                                             |
| --------------------------------------------- | ----------- | ------------------------------------------------------------------ |
| `outputCompaction.readCompaction.enabled`     | `false`     | Preserves exact file reads for editing workflows. Lossy compaction |
|                                               |             | of `read` output can cause "old text does not match" edit errors.  |
| `outputCompaction.sourceCodeFilteringEnabled` | `false`     | Keeps source code filtering off. Only enable in aggressive         |
|                                               |             | cost-saving mode when edit accuracy is less critical.              |
| `outputCompaction.sourceCodeFiltering`        | `"none"`    | Filter level when enabled: `"none"`, `"minimal"`, `"aggressive"`.  |
|                                               |             | Default to `"none"`; use `"minimal"` for cost savings,             |
|                                               |             | `"aggressive"` only when explicitly approved.                      |
| `outputCompaction.preserveExactSkillReads`    | `true`      | Keeps reads under Pi skill directories exact, bypassing read       |
|                                               |             | compaction even if readCompaction is later enabled.                |

### Smart truncation: optional cost-saving enhancement

| Setting                                   | Recommended | Reason                                                            |
| ----------------------------------------- | ----------- | ----------------------------------------------------------------- |
| `outputCompaction.smartTruncate.enabled`  | `false`     | Smart line-based truncation (preserves file boundaries, important |
|                                           |             | lines). Safe to enable for additional cost savings.               |
| `outputCompaction.smartTruncate.maxLines` | `220`       | Maximum lines after smart truncation (default).                   |

Smart truncation is less aggressive than hard truncation because it preserves
file boundaries and important lines. Enable it when sessions routinely hit
context limits despite hard truncation.

## Recommended config file

The recommended config is provided as a separate file for easy copying:

```
docs/rtk-optimizer-recommended-config.json
```

## Tuning for specific profiles

### Default profile (balanced cost/quality)

Use the recommended config as-is. Compaction is aggressive on noisy tool output
(test, build, git, linter, search) but conservative on exact source reads.

### Cost-saving profile

In addition to the defaults, enable:

```json
{
  "outputCompaction": {
    "readCompaction": { "enabled": true },
    "sourceCodeFilteringEnabled": true,
    "sourceCodeFiltering": "minimal",
    "smartTruncate": { "enabled": true, "maxLines": 120 }
  }
}
```

This enables read compaction and minimal source filtering. Test carefully to
ensure edits still apply correctly.

### Audit / debugging profile

Disable lossy compaction to preserve full output for evidence gathering:

```json
{
  "outputCompaction": {
    "readCompaction": { "enabled": false },
    "sourceCodeFilteringEnabled": false,
    "sourceCodeFiltering": "none",
    "truncate": { "enabled": false }
  }
}
```

## Behavioral notes

### Read compaction and edit mismatches

When read compaction, source filtering, and truncation are active, Pi injects a
troubleshooting note for repeated file-edit mismatches. If edits fail because
"old text does not match", disable read compaction via `/rtk`, re-read the file,
apply the edit, then re-enable compaction.

### Missing rtk binary

The optimizer degrades gracefully when the `rtk` binary is missing. Command
rewriting is skipped (raw commands run unchanged), but output compaction still
works. The bootstrap check in `docs/bootstrap-checks.md` alerts the user to
install `rtk`.

### Skill-read preservation

`preserveExactSkillReads` keeps reads under Pi skill directories exact. When set
to `true` (recommended), it bypasses read compaction for:

- Global Pi skills: `~/.pi/agent/skills` (or `$PI_CODING_AGENT_DIR/skills`)
- User skills: `~/.agents/skills`
- Project skills: `.pi/skills`
- Ancestor skills: `.agents/skills` in parent directories

This ensures agent skill files are always read exactly, preserving their full
instruction content.
