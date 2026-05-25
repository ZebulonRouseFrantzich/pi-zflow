# Task 4 Result: /zflow-change-fix Progress Cards

## Implementation

Enhanced the `/zflow-change-fix` command handler in `index.ts` with comprehensive workflow progress cards matching the visual pattern of `/zflow-change-implement`.

### Changes Made

**File:** `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/index.ts`

### Phase Cards (both plan and apply modes)

| Phase Card ID       | Title             | Plan Mode                                                | Apply Mode                                              |
| ------------------- | ----------------- | -------------------------------------------------------- | ------------------------------------------------------- |
| `review-findings`   | Review Findings   | ✅ Shows loading/ready with file count                   | ✅ Shows loading/ready with target count                |
| `fix-selection`     | Fix Selection     | ✅ Shows interview outcome (all/critical-only/dismissed) | ✅ Shows "pre-selected for apply"                       |
| `fix-orchestrator`  | Fix Orchestrator  | —                                                        | ✅ Shows model/thinking, dispatch status, worker result |
| `fix-workers`       | Fix Workers       | —                                                        | ✅ Subagent cards with live progress                    |
| `verification`      | Verification      | —                                                        | ✅ Shows verification command and status                |
| `workflow-complete` | Workflow Complete | ✅ Shows next steps with --apply command                 | ✅ Shows completion or failure summary                  |

### Subagent Cards

- Worker ID: `fix-1` (ready for expansion when Task 6 adds multi-worker dispatch)
- Full card: agent name (`zflow.implement-routine`), model, thinking level, status (running/completed/failed), current tool, last command
- Status transitions: running → completed or running → failed
- Live updates via `onUpdate` callback from the dispatch service for current tool activity
- Elapsed time tracking via the existing render infrastructure

### Orchestrator Card

- Phase card `fix-orchestrator` serves as the orchestrator visibility card
- Shows: model, thinking level, dispatch service name, current step
- Steps shown: "Planning fix strategy..." → "Dispatching..." → "Worker running..." → "Verification..."
- Terminal states: "Fix worker completed" (completed) / "Fix worker issue" (failed)

### Verification Card

- Shows verification command being prepared
- Shows running status with command name
- Terminal: "Fixes applied. Re-verify with /zflow-change-implement --resume."

### Verification

- Code structure verified by reading the modified handler
- All phase card IDs use consistent naming
- Status transitions are correct: pending → running → completed/failed
- Terminal card shows "Workflow Complete" or "Workflow Needs Attention"
