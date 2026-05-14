# Long-Session Smoke Tests — Context Management & Compaction Validation

> Manual test recipes for validating Phase 8 context management optimizations
> in realistic long-running multi-agent sessions. These tests exercise the
> interaction between prevention, compaction, artifact rereads, and bounded
> output — not just individual features in isolation.

## Prerequisites

Before running any smoke test:

1. **Agents and chains installed**:

   ```bash
   pi /zflow-setup-agents
   ```

2. **Required extensions active** in the Pi session:
   - `pi-mono-context-guard` — prevention layer (read limits, dedup, rg bounding)
   - `pi-rtk-optimizer` — command rewriting and output compaction
   - `pi-zflow-compaction` — proactive compaction hooks and handoff reminders
   - `pi-subagents` — subagent runtime

3. **Active profile resolved** with at least one valid lane:

   ```bash
   pi /zflow-profile validate
   ```

4. **Runtime state directory initialised**:

   ```bash
   pi /zflow-profile switch default   # or any valid profile
   ```

---

## Table of Contents

1. [Scenario 1 — Long Planning Session with Compaction](#scenario-1--long-planning-session-with-compaction)
2. [Scenario 2 — Implementation Session with Bounded Output](#scenario-2--implementation-session-with-bounded-output)
3. [Scenario 3 — Canonical Artifact Reread After Compaction](#scenario-3--canonical-artifact-reread-after-compaction)
4. [Scenario 4 — Missing `rtk` Warning Path](#scenario-4--missing-rtk-warning-path)
5. [Scenario 5 — Context-Guard Duplicate-Read Suppression](#scenario-5--context-guard-duplicate-read-suppression)
6. [Scenario 6 — Review Session with Compacted Logs](#scenario-6--review-session-with-compacted-logs)

---

## Scenario 1 — Long Planning Session with Compaction

### Objective

Verify that proactive compaction fires around 60–70% context usage during a
long planning session, and that the handoff reminder is injected so the agent
rereads canonical artifacts afterward.

### Steps

1. **Start a planning session**:

   ```bash
   pi /zflow-change-prepare <change-path>
   ```

   Use a change path that covers multiple packages (e.g. `packages/pi-zflow-change-workflows`).

2. **Accumulate context** — Perform reconnaissance and planning steps that
   generate many tool outputs:
   - Run `builtin:scout` reconnaissance over a broad area
   - Produce a detailed plan artifact with multiple implementation groups
   - Read several source files with different offsets (simulating deep analysis)

3. **Monitor for compaction trigger**:

   Watch session output for a notification resembling:

   ```
   Proactive compaction: summarizing N messages (X,XXX tokens) with google/gemini-2.5-flash...
   ```

   This indicates the `pi-zflow-compaction` extension found the usage ratio at
   or above ~60% (the configured threshold).

4. **Verify handoff reminder appears in the next turn**:

   After compaction completes, the next agent action should include text
   matching:

   ```
   **Compaction handoff.** A compaction cycle has completed...
   ```

5. **Continue working** — produce the final plan artifact.

### Expected results

- Compaction fires proactively (before context overflow) at roughly 60%+ usage.
- The compaction-handoff reminder is injected in the next agent start.
- The agent continues planning coherently after compaction — it does not lose
  track of the change path, scope, or decisions already made.
- The compaction summary preserves references to canonical artifact paths
  (`repo-map.md`, `reconnaissance.md`, `plan-state.json`) so subsequent steps
  can reread them.

### Validation checklist

- [ ] Proactive compaction notification appeared before context overflow
- [ ] Compaction-handoff reminder text appeared
- [ ] Final plan artifact is complete and coherent (no lost context)
- [ ] Artifact paths are referenced in the compaction summary

---

## Scenario 2 — Implementation Session with Bounded Output

### Objective

Verify that every agent invoked during an implementation workflow respects its
configured `maxOutput` limit.

### Steps

1. **Start an implementation session**:

   ```bash
   pi /zflow-change-implement <change-path>
   ```

2. **Run through the full workflow**: scout → context-builder →
   implement-routine → verifier → code-review swarm → synthesizer.

3. **Capture each agent's output** — either from session logs or by watching
   the subagent results.

4. **Measure each output** — for each subagent result, check the total
   character count of the response content.

### Expected results

| Agent                     | Expected `maxOutput` | Allowable range |
| ------------------------- | -------------------- | --------------- |
| `builtin:scout`           | 6000                 | 5000–7000       |
| `builtin:context-builder` | 6000                 | 5000–7000       |
| `zflow.implement-routine` | 8000                 | 7000–9000       |
| `zflow.verifier`          | 6000                 | 5000–7000       |
| `zflow.review-*`          | 8000–10000           | per agent tier  |
| `zflow.synthesizer`       | 12000                | 11000–13000     |

No agent output should exceed its configured `maxOutput`.

### Validation checklist

- [ ] Scout output ≤ 6000 characters
- [ ] Implement-routine output ≤ 8000 characters
- [ ] Verifier output ≤ 6000 characters
- [ ] Reviewer outputs within per-tier ranges
- [ ] Synthesizer output ≤ 12000 characters

---

## Scenario 3 — Canonical Artifact Reread After Compaction

### Objective

Confirm that after a compaction cycle, agents reread file-backed canonical
artifacts for exact details rather than relying on the compaction summary
alone.

### Steps

1. **Complete a planning phase** that produces:
   - A plan artifact at `<runtime-state-dir>/plan-state.json`
   - A `repo-map.md` at `<runtime-state-dir>/repo-map.md`
   - A `reconnaissance.md` at `<runtime-state-dir>/reconnaissance.md`

2. **Accumulate enough context to trigger compaction** — perform several
   turns of analysis and tool use until the 60% threshold is crossed.

3. **After compaction fires**, observe the next subagent launch.

4. **Check the subagent's prompt** (via session logs) for explicit `read` calls
   targeting the canonical artifacts:
   - `read plan-state.json`
   - `read repo-map.md`
   - `read reconnaissance.md`

5. **Verify the agent makes correct decisions** based on exact details from
   the artifacts, not vague or incorrect summaries.

### Expected results

- The compaction summary summarises older turns but does **not** replace the
  file-backed artifacts.
- The next agent after compaction launches with `read` calls to the canonical
  artifacts.
- The agent's subsequent output references exact file paths, line numbers, and
  plan details that could only come from the artifacts, not from a summary.
- The compaction-handoff reminder is present in the system prompt:
  ```
  **Compaction handoff.** A compaction cycle has completed.
  Do not rely on cached or summarised state from before compaction.
  Reread canonical artifacts — especially plan documents,
  `plan-state.json`, and the approved plan — for exact decisions
  and current state before continuing.
  ```

### Validation checklist

- [ ] At least one canonical artifact is reread via `read` after compaction
- [ ] Agent output references exact details from the artifacts
- [ ] Compaction-handoff reminder is injected into the system prompt
- [ ] Agent does not rely solely on compaction summary for implementation
      decisions

---

## Scenario 4 — Missing `rtk` Warning Path

### Objective

Verify that when the `rtk` binary is not installed, the system degrades
gracefully with a visible warning and that output compaction still functions.

### Steps

1. **Check if `rtk` is available**:

   ```bash
   which rtk
   ```

   If it is available, capture its path and temporarily rename or move it:

   ```bash
   RTK_PATH="$(command -v rtk)"
   mv "$RTK_PATH" /tmp/rtk-backup
   ```

2. **Start a new Pi session** (or reload the current one) so the
   `pi-zflow-compaction` extension performs its startup check.

3. **Watch the Pi output** for the warning message:

   ```
   Install rtk for command rewriting. Output compaction will still work without it.
   ```

4. **Run a few tool commands** — for example, a `grep` or `bash` command that
   produces output:

   ```bash
   grep -r "export" packages/pi-zflow-compaction/src/ | head -20
   ```

5. **Verify output compaction still works** — the `pi-rtk-optimizer` extension
   should still compact the tool output (strip ANSI, truncate at 12k chars,
   aggregate test output, etc.) even without `rtk` for command rewriting.

6. **Restore `rtk`**:

   ```bash
   mv /tmp/rtk-backup "$RTK_PATH"
   ```

### Expected results

- The warning message is displayed once on startup or first use.
- All tool commands run normally (raw commands are not rewritten).
- Output compaction pipeline still applies ANSI stripping, truncation, test
  aggregation, and other compaction stages.
- No crash, hang, or silent degradation.

### Validation checklist

- [ ] Warning message appeared: "Install rtk for command rewriting..."
- [ ] Session continues without `rtk`
- [ ] Tool output is compacted (truncated, ANSI-stripped)
- [ ] No errors or crashes

---

## Scenario 5 — Context-Guard Duplicate-Read Suppression

### Objective

Verify that `pi-mono-context-guard` suppresses duplicate `read` calls to
unchanged files within the same session.

### Steps

1. **Ensure `pi-mono-context-guard` is active** — confirm it is installed:

   ```bash
   ls ~/.pi/agent/extensions/pi-mono-context-guard/
   ```

2. **Start a planning or implementation session** (or any interactive session).

3. **Read a file** using the `read` tool (without specifying a `limit`):

   ```text
   read packages/pi-zflow-core/src/index.ts
   ```

   Verify the guard injects a default `limit: 120`.

4. **Read the same file again** with the same path, offset, and no
   intervening modifications to the file:

   ```text
   read packages/pi-zflow-core/src/index.ts
   ```

5. **Observe the second read** — it should be suppressed with a short stub
   message instead of re-sending the file content.

6. **Modify the file** (e.g. add a comment), then read it again:

   ```text
   read packages/pi-zflow-core/src/index.ts
   ```

7. **Observe the third read** — it should return the full file content because
   the file's modification time changed, invalidating the cache.

### Expected results

- The first read gets a default `limit: 120` injected.
- The second read (same path, same offset, file unchanged) is suppressed with
  a cache-hit stub.
- The third read (after file modification) returns full content because the
  cache was invalidated.

### Validation checklist

- [ ] First read is limited to 120 lines by default
- [ ] Second read of unchanged file is suppressed
- [ ] Third read after file modification returns full content
- [ ] Token usage is lower than it would be without the guard

---

## Scenario 6 — Review Session with Compacted Logs

### Objective

Verify that a code review session after a long implementation workflow receives
compacted, bounded output that is still accurate enough for meaningful review
findings.

### Steps

1. **Run a full implementation workflow** for a multi-package change:

   ```bash
   pi /zflow-change-implement <change-path>
   ```

   The change should be complex enough to generate significant tool output
   (multiple file edits, test runs, git operations).

2. **After implementation succeeds, run the review swarm**:

   ```bash
   pi /zflow-review-code
   ```

   Or trigger the review step through the implementation workflow's built-in
   code-review swarm.

3. **Observe the reviewer prompts** — each reviewer should receive:
   - Compacted tool output from the implementation phase
   - A focused diff (not the full implementation transcript)
   - Bounded output within their `maxOutput` tier (8000–10000 characters)

4. **Verify review findings are accurate** despite compaction:
   - Correctness issues should be identified correctly
   - Security concerns should be surfaced
   - Integration problems should be detected
   - False positives from truncated/compacted input should be minimal

5. **Compare with a non-compacted baseline** (optional): run the same review
   with compaction disabled (`/rtk` → disable output compaction) and note any
   differences in review quality.

### Expected results

- Each reviewer receives compacted, bounded input.
- Review findings are meaningful and accurate despite compaction.
- The synthesizer produces a consolidated findings report that references
  specific file paths and line numbers.
- False-positive rate is not significantly higher than non-compacted baseline.

### Validation checklist

- [ ] Reviewer prompts are bounded by `maxOutput` limits
- [ ] Review findings reference specific files and line numbers
- [ ] Findings are accurate (correctness/security/integration issues identified)
- [ ] Synthesized report is coherent and actionable

---

## Quick Validation Recipe

Run one representative scenario for each optimisation layer:

```bash
# Layer: Prevention (Scenario 5)
# Manual: duplicate a read call within a session
read docs/bootstrap-checks.md
read docs/bootstrap-checks.md   # expected: suppressed

# Layer: Compaction (Scenario 1)
# Manual: start /zflow-change-prepare, fill context until compaction fires

# Layer: Canonical reread (Scenario 3)
# Manual: after compaction, check that the agent reads plan-state.json

# Layer: Bounded output (Scenario 2)
# Manual: /zflow-change-implement, verify each agent output size

# Layer: Graceful degradation (Scenario 4)
# Manual: temporarily remove rtk, start session, verify warning appears

# Layer: Review with compaction (Scenario 6)
# Manual: /zflow-review-code after a long implementation, check findings
```

## Troubleshooting

| Symptom                                    | Likely cause                                                      | Fix                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Compaction never fires                     | Usage ratio stays below 60% threshold                             | Add more tool outputs, or lower the threshold in `compaction-service.ts` |
| Handoff reminder missing                   | `pendingCompactionHandoff` flag not set                           | Check `session_compact` hook in compaction extension                     |
| `rtk` warning not showing                  | `ensureRtkOrAlert()` not called at startup                        | Check compaction extension bootstrap                                     |
| Duplicate reads not suppressed             | File modified between reads, or cache scoped to different process | Expected behaviour — dedup is per-process                                |
| Reviewer misses findings due to truncation | `maxOutput` too low for review tier                               | Increase `maxOutput` for the review agent in `EXPECTED_MAX_OUTPUT`       |
