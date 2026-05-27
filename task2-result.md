# Task 2: Apply-Back Failure Messaging — Implementation Result

## Changes made

### 1. New function: `formatApplyBackFailureMessage()` in orchestration.ts

Added at line 2608. This centralized formatter:

- Reads run.json to determine the change ID
- Always includes the run ID in the message
- Always includes `/zflow-resolve-apply-back <runId>` command
- Lists preserved artifacts (patches dir, integration worktree, resolution prompt)
- Lists strategies attempted (with sensible defaults)
- Provides consistent recovery options (subagent resolution, --resume, --abandon, inspect)

### 2. Updated apply-back failure in `runImplementationPostStartSequence()` (orchestration.ts ~6824)

The apply-back conflict check now:

- Uses the centralized formatter to build a rich failure message
- Passes the failure message to `reportProgress()` so it shows in phase cards
- Updates nextSteps to include `/zflow-resolve-apply-back <runId>` at position 1
- Sets `error` to include the full formatted message

### 3. Updated fresh dispatch path in `/zflow-change-implement` handler (index.ts ~5774)

The apply-back check after `runWorktreeDispatchAndFinalize()` now:

- Imports `path` dynamically for path joins
- Uses `formatApplyBackFailureMessage()` with patches dir, integration worktree path, and strategies
- Calls `ctx.ui.notify(failureMsg, "error")` to display the formatted message
- Phase cards still show the concise status, with detail in the notification

### 4. Updated `--apply-successful` path (index.ts ~5210)

The cascade failure notification now:

- Uses `formatApplyBackFailureMessage()` instead of ad‑hoc text
- Removes the duplicate inline option list (the formatter provides it)
- The resolution prompt notification now includes the follow-up command

### 5. Updated `--resume` path (index.ts ~5470)

The apply-back failure notification now:

- Uses `formatApplyBackFailureMessage()` instead of ad‑hoc text
- Passes patches dir, integration worktree path, and strategies to the formatter

### 6. Added import of `formatApplyBackFailureMessage` to index.ts

### 7. Added tests in `test/apply-back-failure-message.test.ts`

Four test cases:

- Includes run ID in message
- Includes recovery command options
- Works without optional extra fields
- Includes resolution prompt path when provided

## Files modified

- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`
- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/index.ts`
- `packages/pi-zflow-change-workflows/test/apply-back-failure-message.test.ts` (new file)

## Verification

- Tests were written but could not be executed from this session due to path-guard restrictions on `npx`/`node`.
- All 6 locations where apply-back failure messages appear have been updated to use the centralized formatter.
