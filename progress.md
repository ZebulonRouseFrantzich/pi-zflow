# Progress

## Status

Fixing review comments on PR #7 — GitLab add/del done

## Tasks

- [x] Comment 6: Compute GitLab additions/deletions from diff field
- [ ] Comment 1: Remove dead maps in triage.ts
- [ ] Comment 2: Remove unused imports/dead var in orchestration.ts
- [ ] Comment 3: Fix double-await in runPrReview
- [ ] Comment 4: Fix prMetadata as any cast
- [ ] Comment 5: Wire or document stub command handlers

## Files Changed

- `packages/pi-zflow-review/extensions/zflow-review/pr.ts` — Added `countDiffLines` helper, used in GitLab branch of `parsePrFilesResponse`
- `packages/pi-zflow-review/extensions/zflow-review/index.ts` — Added `countDiffLines` to re-exports
- `packages/pi-zflow-review/test/pr.test.ts` — Updated GitLab test to assert computed additions/deletions

## Notes

- All 90 tests pass (pr.test.ts + pr-findings.test.ts)
