# Future Idea — Cache Telemetry and Diagnostics

> Status: future-ideas planning artifact only.
> Do not implement until explicitly approved.

## Purpose

Give pi-zflow first-class visibility into provider-side prompt-cache behavior so
future cost-optimization work can be measured, diagnosed, and tuned safely.

This proposal is the observability companion to cache-stable prompt assembly.
Without it, cache improvements and regressions are difficult to evaluate.

## Why this is worth considering

pi-zflow currently has strong context-management design work, but it does not
yet provide a zflow-specific diagnostic answer to questions like:

- Are cache reads improving or getting worse?
- Which workflow modes are most cache-hostile?
- Did a prompt fingerprint change cause a cache regression?
- Was the regression caused by compaction, a model switch, or a reminder?
- Which active profile is cheapest in practice for long sessions?

A telemetry layer would make those answers inspectable without introducing raw
prompt logging or external analytics dependencies.

## Goals

1. Record redacted per-turn cache metrics.
2. Explain major cache regressions with likely cause tags.
3. Surface cache health in zflow diagnostics and profile validation.
4. Enable before/after measurement for prompt-stability and DCP-lite work.
5. Support cross-session forensics without storing raw prompt text by default.

## Non-goals

- Do not send data to external services.
- Do not store raw prompts by default.
- Do not add a heavyweight analytics UI before operational basics exist.
- Do not make telemetry a prerequisite for core workflows.

## Proposed ownership

| Concern | Owning package | Responsibilities |
| --- | --- | --- |
| Turn-level cache capture and regression analysis | `pi-zflow-compaction` | Per-turn logging, cause heuristics, current-session summaries |
| Profile-aware cache guidance | `pi-zflow-profiles` | Validation output and lane/provider recommendations |
| Shared data model and hashing helpers | `pi-zflow-core` | Metric schemas, safe fingerprint helpers, storage path helpers |
| Help/doctor surfacing | `pi-zflow` umbrella | Incorporate cache health into suite-level diagnostics |

## Design principles

1. **Redacted by default** — record fingerprints, counters, and cause tags rather than raw prompt text.
2. **Operationally useful first** — prioritize current-session health over beautiful reporting.
3. **Cross-session aware second** — add forensics once the per-turn model is stable.
4. **Provider-aware, not provider-dependent** — support whichever metrics are available from active lanes.
5. **Explain regressions** — not just numbers, but likely causes.

## Data capture model

For each assistant turn, record a cache trace entry.

### Suggested fields

```ts
interface ZflowCacheTraceEntry {
  sessionId: string
  turnId: string
  timestamp: string
  cwdHash: string
  workflowMode: string | null
  agentName: string | null
  profileName: string | null
  provider: string | null
  model: string | null
  stablePromptHash: string | null
  reminderHash: string | null
  contextUsagePercent: number | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  cacheHitRate: number | null
  compactionOccurredRecently: boolean
  promptFingerprintChanged: boolean
  modelChanged: boolean
  modeChanged: boolean
  toolBurstHint: boolean
  regressionCause: string | null
}
```

### Storage expectations

Use zflow-owned storage rather than ad hoc files.

#### Current-session trace

Suggested path:

```text
<runtime-state-dir>/cache/session-cache-trace.jsonl
```

Purpose:
- current-session history
- doctor/status summaries
- local debugging

#### Cross-session trace index

Suggested path:

```text
<user-state-dir>/cache/cache-trace.jsonl
```

Purpose:
- cross-session forensics
- profile comparisons
- historical regression analysis

### Privacy posture

By default, a trace entry should **not** contain:

- raw prompt text
- raw command text
- raw file paths in multi-session summaries
- literal user content

Instead, prefer:

- hashes
- normalized identifiers
- redacted cause categories

## Metric derivation

### Primary metrics

- `inputTokens`
- `outputTokens`
- `cacheReadTokens`
- `cacheWriteTokens`
- `cacheHitRate`
- `contextUsagePercent`

### Derived indicators

- whether cache warmed successfully
- whether a regression exceeded threshold
- whether the prompt fingerprint changed
- whether the change followed a mode switch
- whether compaction or idle time likely affected cache state

### Cache hit rate heuristic

When supported by provider metrics:

```text
cacheHitRate = cacheReadTokens / max(inputTokens, 1)
```

If the provider exposes only partial cache data, the system should clearly mark
confidence as partial rather than implying false precision.

## Regression heuristics

A cache regression should be classified with a likely cause tag where possible.

### Suggested cause tags

- `model-changed`
- `provider-changed`
- `stable-prompt-changed`
- `mode-changed`
- `compaction-recent`
- `idle-gap-exceeded`
- `large-tool-payload`
- `diagnostic-injection-changed`
- `unknown`

### Detection approach

At minimum, regression analysis should compare the current turn to recent prior
turns in the same session and ask:

1. Did provider or model change?
2. Did the stable prompt hash change?
3. Did the active workflow mode change?
4. Did compaction occur recently?
5. Was there a large idle gap since last turn?
6. Did a large tool output or diagnostic injection enter the context?

If multiple causes are plausible, the entry may record a primary cause plus a
secondary list.

## Diagnostic surfaces

## 1. Lightweight diagnostics

Expose a concise cache summary through existing zflow surfaces.

### `/zflow-help doctor`

Suggested additions:

- current provider/model
- current session cache read/write totals
- last regression cause
- stable prompt fingerprint status
- whether compaction recently occurred
- whether this profile appears cache-friendly

### `pi-zflow-profiles` validation

Suggested additions:

- whether active lanes expose cache metrics
- whether profile composition is likely cache-friendly
- whether active workflow settings are volatile enough to hurt cache reuse
- whether optional provider-specific recommendations apply

## 2. Dedicated cache commands (optional later)

Not required for the first pass, but worth designing for.

Potential names:

- `/zflow-cache-status`
- `/zflow-cache-history`
- `/zflow-cache-forensics`

The first should be operational and immediate; the latter two can come later.

## Current-session summary model

A current-session summary should answer:

- What is the current cache health?
- Did it get worse recently?
- Why does zflow think it got worse?
- Is the prompt prefix stable?
- Did compaction, drift, or model changes correlate with the drop?

### Suggested health buckets

- `healthy`
- `warming`
- `degraded`
- `unknown`

These buckets should be heuristic, but the basis for classification should be
visible in doctor output.

## Cross-session forensics

After the current-session telemetry is stable, zflow can support redacted
forensics across historical sessions.

### Questions for cross-session analysis

- Which workflow mode shows the worst cache hit rates?
- Which profiles or providers are cheapest in real use?
- Which reminder types correlate with regressions?
- How often do stable prompt hash changes occur within a session?
- Do post-compaction turns regress more than expected?

### Forensics patterns worth supporting later

- `breakdown` — count regressions by likely cause
- `hotspots` — largest cache hit drops
- `correlate` — correlation between events and regressions
- `idle` — regressions after inactivity windows

## Integration with future prompt-stability work

This telemetry layer is a dependency for evaluating `cache-stable-prompt-assembly.md`.

When prompt-stability work lands, telemetry should be able to show:

- whether stable prompt fingerprints changed less often
- whether cache read tokens increased within comparable workflows
- whether reminder injection still correlates with regressions

## Integration with future DCP-lite work

This telemetry layer is also a dependency for evaluating `dcp-lite-outbound-pruning.md`.

It should help answer:

- whether payload pruning materially reduces input tokens
- whether pruning improves cache effectiveness or only reduces payload size
- whether pruning introduces unexpected cache regressions

## Suggested staged rollout

### Stage 1 — redacted turn capture

- capture per-turn cache metrics
- write current-session JSONL trace
- show lightweight doctor summary

### Stage 2 — regression heuristics

- classify major drops by likely cause
- include stable prompt fingerprint comparisons
- surface cause tags in doctor output

### Stage 3 — profile and cross-session analysis

- integrate cache health into profile validation
- add cross-session redacted forensics
- compare profiles/providers over time

## Suggested file/path additions if approved

Potential new artifacts:

```text
<runtime-state-dir>/cache/session-cache-trace.jsonl
<runtime-state-dir>/cache/cache-summary.json
<user-state-dir>/cache/cache-trace.jsonl
<user-state-dir>/cache/cache-forensics.json
```

The exact path contract should be documented alongside other state paths in
`docs/foundation-versions.md` if implemented.

## Suggested documentation updates if approved

- `README.md` — mention cache observability as a zflow optimization capability
- `docs/foundation-versions.md` — record telemetry storage paths if adopted
- `docs/bootstrap-checks.md` — mention provider metrics availability caveats where relevant
- `docs/compaction-reread-policy.md` — note cache telemetry interactions after compaction
- `docs/prompt-boundary-policy.md` — mention stable prompt fingerprints and cache diagnostics

## Suggested tests

### Unit tests

- trace entry creation from provider usage data
- regression classification heuristics
- redaction rules for persisted trace data
- cache health bucket classification

### Integration tests

- session trace records multiple turns correctly
- prompt fingerprint change is reflected in regression analysis
- model switch is recorded as a distinct likely cause
- compaction event is correlated into the next turn's trace
- profile validation can summarize cache-related conditions

### Manual validation

- inspect current-session doctor output during long sessions
- compare telemetry before/after prompt-stability changes
- confirm no raw prompt text is written by default

## Risks and tradeoffs

| Risk | Mitigation |
| --- | --- |
| Metrics differ by provider | Record confidence and raw availability explicitly |
| Diagnostics become noisy | Start with lightweight summaries and clear thresholds |
| Privacy concerns from session traces | Default to hashes and redacted cause tags |
| Overfitting heuristics to one provider | Keep cause classification heuristic and explainable |

## Open questions

1. Should cache telemetry be enabled by default or opt-in at first?
2. Which cache summary belongs in `/zflow-help doctor` versus dedicated cache commands?
3. Should cross-session traces live only under `<user-state-dir>`, or also be exportable to project-local runtime state for reproducibility?
4. Should the regression threshold be globally configured, provider-aware, or profile-aware?

## Approval checklist for future implementation

Before implementation begins, confirm:

- the exact trace schema
- storage locations and retention policy
- redaction policy
- cache-health bucket definitions
- regression-cause taxonomy
- which existing commands should surface cache diagnostics first
