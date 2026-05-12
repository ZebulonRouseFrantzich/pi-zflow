# Machine Preflight Report

> **Phase 0, Task 0.5** — Recorded on 2026-05-12.
> Actual machine prerequisite state for the development workstation.

## Summary

| Tool               | Status           | Version                     | Details                                                            |
| ------------------ | ---------------- | --------------------------- | ------------------------------------------------------------------ |
| `rtk`              | ❌ Missing       | —                           | Output compaction unavailable; soft warning only                   |
| `gh`               | ✅ Present       | `2.92.0`                    | Authenticated (GitHub CLI)                                         |
| `glab`             | ❌ Missing       | —                           | Blocks GitLab MR review flows                                      |
| `runectx`          | ✅ Present       | `0.1.0-alpha.14`            | No `runecontext.yaml` in this repo; status check fails as expected |
| `pi --list-models` | ✅ Available     | models resolved             | See below for lane validation                                      |
| `gh auth status`   | ✅ Authenticated | user: ZebulonRouseFrantzich | Active account: true, protocol: ssh                                |
| `glab auth status` | ❌ Missing       | —                           | `glab` CLI not installed                                           |

## Detailed checks

### rtk — Output compaction

```bash
$ rtk --version
# bash: rtk: command not found
```

**Status**: ❌ Missing  
**Impact**: Output compaction via `pi-rtk-optimizer` will be unavailable. This is a soft warning — the harness still works.  
**Resolution**: Install with `npm install -g rtk` or `cargo install rtk` if output compaction is desired.  
**Documented behavior**: Matches `docs/bootstrap-checks.md` soft-failure rule.

### gh — GitHub CLI

```bash
$ gh --version
gh version 2.92.0 (2026-04-28)
https://github.com/cli/cli/releases/tag/v2.92.0

$ gh auth status
github.com
  ✓ Logged in to github.com account ZebulonRouseFrantzich (keyring)
  - Active account: true
  - Git operations protocol: ssh
  - Token: gho_************************************
  - Token scopes: 'admin:public_key', 'gist', 'read:org', 'repo'
```

**Status**: ✅ Present and authenticated  
**Impact**: GitHub PR review flows (`/zflow-review-pr`) can proceed.

### glab — GitLab CLI

```bash
$ glab --version
# bash: glab: command not found
```

**Status**: ❌ Missing  
**Impact**: GitLab MR review flows will be blocked. Only relevant if GitLab PRs are reviewed.  
**Resolution**: Install with `npm install -g glab` or see https://glab.readthedocs.io/  
**Note**: This is a contextual blocker — only blocks GitLab flows, not general operation.

### runectx — RuneContext

```bash
$ runectx --version
result=ok
command=version
version=0.1.0-alpha.14
runecontext_version=0.1.0-alpha.14
non_interactive=false

$ runectx status
result=invalid
command=status
root=/home/zeb/code/pi/pi-zflow
error_message=/home/zeb/code/pi/pi-zflow: no runecontext.yaml found in current directory or ancestors
non_interactive=false
dry_run=false
explain=false
```

**Status**: ✅ Binary present, but no `runecontext.yaml` in this repo  
**Impact**: RuneContext-specific flows will be blocked in this repo until a `runecontext.yaml` is configured. Binary is installed and functional.  
**Note**: This exactly matches the expected behavior — `runectx status` fails informatively when no config exists.

### Model registry and default profile feasibility

```bash
$ pi --list-models
```

All required models resolved successfully. See below for lane-by-lane validation.

---

## Default profile lane validation

Validated against `pi --list-models` output on 2026-05-12:

| Lane                | Primary                         | Fallback                           | Status                 |
| ------------------- | ------------------------------- | ---------------------------------- | ---------------------- |
| `planning-frontier` | `openai-codex/gpt-5.4` ✅       | `opencode-go/mimo-v2.5-pro` ✅     | ✅ Resolved            |
| `worker-cheap`      | `openai-codex/gpt-5.4-mini` ✅  | `opencode-go/deepseek-v4-flash` ✅ | ✅ Resolved            |
| `review-system`     | `openai-codex/gpt-5.3-codex` ✅ | `opencode-go/qwen3.6-plus` ✅      | ✅ Resolved (optional) |

### Full model availability

| Provider       | Models                                                                                                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openai-codex` | `gpt-5.1`, `gpt-5.1-codex-max`, `gpt-5.1-codex-mini`, `gpt-5.2`, `gpt-5.2-codex`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`                     |
| `opencode-go`  | `deepseek-v4-flash`, `deepseek-v4-pro`, `glm-5`, `glm-5.1`, `kimi-k2.5`, `kimi-k2.6`, `mimo-v2.5`, `mimo-v2.5-pro`, `minimax-m2.5`, `minimax-m2.7`, `qwen3.5-plus`, `qwen3.6-plus` |

---

## User-level directory bootstrap

Verified that Phase 0 Task 0.7 directories exist:

| Directory                   | Exists |
| --------------------------- | ------ |
| `~/.pi/agent/agents/zflow/` | ✅     |
| `~/.pi/agent/chains/zflow/` | ✅     |
| `~/.pi/agent/zflow/`        | ✅     |

---

## Gaps and action items

| Gap                      | Action                                       | Priority | Depends on    |
| ------------------------ | -------------------------------------------- | -------- | ------------- |
| `rtk` missing            | Install `rtk` for output compaction support  | Low      | User decision |
| `glab` missing           | Install `glab` for GitLab MR review support  | Low      | User decision |
| No `runecontext.yaml`    | Create if RuneContext integration is needed  | Medium   | Phase 3       |
| Model registry unchanged | Re-run validation if providers/models change | Ongoing  | N/A           |

No Phase 0 blockers.
