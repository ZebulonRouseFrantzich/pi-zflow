# Task 3 Result: Unified /zflow-change-fix Workflow

## Changes Made

### 1. `orchestration.ts` — New functions and updated FixWorkflowResult

**File:** `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`

**New exports:**

| Export                         | Type           | Purpose                                                                                                                                                                                                           |
| ------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ParsedFinding`                | interface      | Structured finding with `findingId`, `severity`, `title`, `file`, `line`, `reviewerRole`, `evidence`, `recommendation`, `artifactPath`, `whyItMatters`                                                            |
| `parseReviewFindings()`        | async function | Parses `code-review-findings.md` into `{ findings: ParsedFinding[], rawPath, rawContent }`. Splits on h3 headings, extracts file/line/evidence/recommendation using regex, infers severity from parent h2 section |
| `buildFixSelectionQuestions()` | function       | Returns JSON string for pi-interview with "Fix All Findings" (recommended), "Select Findings to Fix" (multi-select), and "Cancel" options, plus a conditional multi-select question                               |
| `buildFixPlan()`               | async function | Returns markdown document with fix plan header, finding details (id, severity, file, evidence, recommendation), fix strategy, and target files section                                                            |

**Updated:**

- `FixWorkflowResult` — added `parsedFindings: ParsedFinding[]`, `rawFindingsPath?: string`, `planVersion: string`, `lifecycleState: string`
- `runChangeFixWorkflow()` — now uses `parseReviewFindings()` for structured parsing instead of ad-hoc line matching, and `buildFixPlan()` for plan generation

### 2. `index.ts` — Rewritten command handler

**File:** `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/index.ts`

Old behavior:

- Two-step flow: `/zflow-change-fix <id>` (plan only) / `/zflow-change-fix <id> --apply` (apply)

New behavior:

- **One command flow:** `/zflow-change-fix <id>` loads findings, presents fix selection via structured interview, builds fix plan, dispatches fix worker, and reports results — all in one command
- `--plan-only` kept as hidden legacy option for plan-only users
- `--apply` kept as backward-compat alias (same behavior as default)
- Progress cards with phases: Review Findings → Fix Selection → Fix Orchestrator → Fix Workers → Verification → Workflow Complete
- Subagent card showing fix worker model/thinking/current tool

**New imports/exports added:**

- `ParsedFinding` type
- `parseReviewFindings`, `buildFixSelectionQuestions`, `buildFixPlan` exported

### 3. `change-fix.test.ts` — Unit tests

**File:** `packages/pi-zflow-change-workflows/test/change-fix.test.ts`

8 test cases:

1. parseReviewFindings: parses critical finding with all fields
2. parseReviewFindings: parses major finding correctly
3. parseReviewFindings: finds all 4 severities
4. parseReviewFindings: finding IDs start with "finding-"
5. parseReviewFindings: returns empty for empty findings file
6. parseReviewFindings: returns empty when file doesn't exist
7. buildFixPlan: includes all selected findings + their IDs and titles
8. buildFixPlan: includes Target Files section with file paths
9. buildFixPlan: includes severity counts (crit/maj/min/nit)
10. buildFixPlan: works with empty findings array

## Validation

- Code structure verified via read
- Exports chain verified: orchestration.ts exports → index.ts imports → index.ts re-exports
- All functions have correct TypeScript return types
- Test file covers business logic paths (parsing, plan building, edge cases)

## Open Risks

- Tests could not be executed due to path-guard restrictions on bash/node
- Second step of interview (multi-select for specific findings) returns default fallback since the handler uses `runStructuredInterview` which ultimately falls through to confirm() — the full pi-interview multi-select flow depends on runtime availability
