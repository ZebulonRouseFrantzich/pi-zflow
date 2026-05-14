# Failure-Log Readback Policy

> Before planning similar tasks, read recent relevant failure-log entries to
> improve context construction and planning quality.

## Core rule

The failure log at `<runtime-state-dir>/failure-log.md` records structured
entries about past workflow failures, their root causes, applied fixes, and
prevention recommendations. Before planning or implementing a task that
overlaps with past failure areas, read relevant recent entries to surface
lessons learned.

**Never dump the entire failure log into an agent prompt.** Select only the
most relevant, highest-signal entries.

## When to read the failure log

### Before planning a new change

When a new change request arrives, check the failure log for entries whose
context, root cause, or module touches similar areas. Past planning-quality
failures, tool-limitation workarounds, or integration issues may influence
the new plan's structure and verification strategy.

### Before implementation when previous failures exist

When the change plan references areas with past failures, read the relevant
entries before dispatching implementation agents. Surface previous
prevention recommendations and fix descriptions so implementers can avoid
repeating mistakes.

### During review

When reviewing a completed change, check whether past failures for similar
areas have been addressed. The failure log provides concrete verification
gaps and prevention criteria that reviewers can use as additional check items.

## What NOT to do

- **Do not dump the entire failure log into every agent prompt.** The failure
  log accumulates over time and most entries will be irrelevant to the
  current task. Select only the most relevant subset.
- **Do not include entries that are too old** (more than ~30 days) unless they
  are highly relevant. Patterns, tooling, and codebases evolve; stale entries
  may mislead rather than inform.
- **Do not include more than 3–5 entries** in any single context injection.
  More than that overwhelms the agent with negative examples and reduces the
  signal-to-noise ratio.
- **Do not include entries that are too dissimilar.** If the root cause,
  context, or module is unrelated to the current task, skip it even if the
  keyword match is coincidental.

## Entry format

Each entry in the failure log follows this structure:

```markdown
## <ISO-timestamp>: <context>

- **Expected**: <description>
- **Actual**: <description>
- **Root cause**: <classification>
- **Fix applied**: <description>
- **Prevention**: <recommendation>
```

### Field meanings

| Field         | Required | Description                                                                 |
| ------------- | -------- | --------------------------------------------------------------------------- |
| `timestamp`   | always   | ISO-8601 timestamp of when the failure occurred                             |
| `context`     | always   | Short human-readable context (e.g. which task/module)                       |
| `Expected`    | optional | What was expected to happen                                                 |
| `Actual`      | optional | What actually happened                                                      |
| `Root cause`  | optional | Classification (e.g. `plan-quality`, `verification-gap`, `tool-limitation`) |
| `Fix applied` | optional | Description of the fix that was applied                                     |
| `Prevention`  | optional | Recommendation to prevent recurrence                                        |

### Standard root-cause tags

Use these tags consistently in the `Root cause` field so filtering works
reliably:

- `plan-quality` — The plan was incomplete, ambiguous, or incorrect
- `verification-gap` — Verification did not catch a defect
- `tool-limitation` — A tool or environment constraint caused the failure
- `ownership-conflict` — Multiple agents touched the same file or concern
- `worktree-isolation` — Worktree setup or isolation issue
- `compaction-loss` — Important context was lost during compaction
- `external-change` — An external dependency or configuration changed

## How `findRelevantFailures()` works

The helper `findRelevantFailures(context, cwd)` in `failure-log.ts`:

1. Reads all entries from the failure log file
2. Extracts keywords (words longer than 3 characters) from the free-text
   `context` parameter
3. Scores each entry by how many keywords appear in its combined searchable
   fields (context, rootCause, fixApplied, prevention, expected, actual)
4. Filters out entries with a score of zero
5. Sorts by score (descending), then by timestamp (newest first)
6. Returns matching entries

### Example

```ts
const relevant = await findRelevantFailures("config ownership verification");
// Returns entries matching "config", "ownership", or "verification" keywords
```

## Failure-log readback and compaction-handoff

After compaction: the failure log is a canonical artifact that should be
reread from file (not from the compaction summary). The compaction-handoff
reminder already instructs agents to reread canonical artifacts; the failure
log is included in that list.

Before planning: if the failure log was recently read and no new failures
have been recorded, the cached entries may be reused. However, to avoid
stale context, flush and reread the failure log after every compaction
cycle.

## Integration with orchestration

The `loadRecentFailureLogEntries()` helper in `failure-log-helpers.ts`
provides the recommended interface for orchestration code:

```ts
const { loadRecentFailureLogEntries } =
  await import("pi-zflow-change-workflows");
const failures = await loadRecentFailureLogEntries({
  context: "config ownership validation",
  tags: ["plan-quality", "verification-gap"],
  limit: 3,
  maxAge: 30,
});
```

Callers format the result with `formatFailureLogReadback()` and inject the
concise summary into the planner or implementer prompt, typically as a
reminder fragment or an additional context section.
