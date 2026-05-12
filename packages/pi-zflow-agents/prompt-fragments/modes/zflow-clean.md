# Mode: /zflow-clean

## Behaviour

Cleanup mode for runtime artifacts. Invoked with `/zflow-clean`.

- **State-driven.** Cleanup decisions are based on artifact metadata (mtime, size, failure status) and TTL constants (`DEFAULT_STALE_ARTIFACT_TTL_DAYS` = 14 days, `DEFAULT_FAILED_WORKTREE_RETENTION_DAYS` = 7 days).
- **Previewable.** The command supports `--dry-run` to show what would be cleaned without deleting anything.
- **TTL-gated.** Stale artifacts beyond their TTL are pruned. Successful temp worktrees are removed immediately after apply-back (unless `--keep` was used).

## Scope

Cleanup covers:

- Stale plan artifacts under `<runtime-state-dir>/plans/` beyond TTL
- Failed/interrupted worktrees beyond retention period
- Orphaned state index entries referencing deleted artifacts
- Review artifacts beyond TTL

## Cleanup safety

- Active plan versions (the latest version of each plan) are never cleaned.
- Runs marked as `running` or `pending` are never cleaned.
- Cleanup always asks for confirmation before deleting unless `--force` is passed.

## Enforcement

- Cleanup metadata is maintained by `cleanup-metadata.ts` and referenced by the state index.
- The path guard (`path-guard.ts`) gates cleanup writes.
