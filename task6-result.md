Task 6 implemented successfully.

Changes:

Part A — Enriched Reviewer Findings:

- Updated 5 reviewer agents (correctness, integration, logic, security, system) with enriched finding format
- Updated synthesizer to preserve finding IDs, add fixPriority, group by file
- Updated review-context.ts findings format instructions with optional enriched fields
- Updated ParsedFinding interface and parseReviewFindings to extract new fields

Part B — Fix Orchestrator:

- Created fix-orchestrator.md agent with 4-phase workflow (Analyze → Dispatch → Validate → Report)
- Added FixOrchestratorConfig interface and resolveFixOrchestratorConfig function
  - Configurable via env vars: ZFLOW_FIX_MAX_ATTEMPTS_PER_FINDING, ZFLOW_FIX_MAX_GLOBAL_ROUNDS
  - Precedence: env vars → profile settings → defaults (2, 3)
- Added buildFixOrchestratorTaskPrompt helper that builds the orchestrator agent task
- Updated fix command handler to dispatch zflow.fix-orchestrator
- Added test file with 7 test cases
