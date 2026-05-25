# Task 1 Result: Deterministic Markdown Guardrails for /zflow-change-prepare

## Implemented Changes

### 1. NEW: `plan-artifact-validator.ts`

**File:** `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/plan-artifact-validator.ts`

Contains:

- **`validateAllPlanArtifacts()`** - Validates all five canonical plan artifacts against format contracts.
- **`validateSingleArtifact()`** - Validates a single artifact by name.
- **`buildRepairPrompt()`** - Builds a targeted repair prompt for the planner with exact parser errors.
- **`runArtifactRepair()`** - Dispatches planner with focused fix instructions, re-validates, stops after max attempts.
- **`isPlaceholderOrEmpty()`** - Checks whether a value like "TBD", "TODO", or "" is a placeholder.
- **Constants** like `CANONICAL_ARTIFACT_IDS`, `MIN_CONTENT_LENGTHS`, `PLACEHOLDER_PATTERNS`.

Validation rules per artifact:

| Artifact                  | Rules                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execution-groups.md`     | Must have group headings (`## Group X: Name`, `## GX — Name`, `## Execution Group X: Name`); each group needs Files, Scoped verification (no TBD/empty), unique IDs |
| `design.md`               | Must exist with >=50 chars, no [TODO]/placeholder/TBD markers                                                                                                       |
| `standards.md`            | Must exist with >=50 chars, no placeholder markers                                                                                                                  |
| `verification.md`         | Must exist with >=50 chars, no placeholders, at least one code fence                                                                                                |
| `implementation-tasks.md` | Must exist with >=100 chars, no placeholder markers                                                                                                                 |

### 2. UPDATED: `orchestration.ts`

**File:** `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts`

Changes:

- **Planner prompt updated** (in `runPrepareAgentsIfAvailable()`): Replaced the old "## Critical: execution-groups.md format" section with a stricter "## CRITICAL: Machine-Readable Format Contract" that includes:
  - Required fields per group (Files, Agent, Dependencies, Scoped verification, Parallelizable)
  - Explicit VALID/INVALID examples
  - Minimum content lengths for each artifact
  - "Failure is OK" section normalizing repair passes
- **Validation step added to `runChangePrepareWorkflow()`**: After agent dispatch and `ensureImplementationTasksArtifact()`, calls `validateAllPlanArtifacts()`. If validation fails, attempts automated repair via `runArtifactRepair()` (up to 2 attempts). Success or failure is reported via the progress callback.

### 3. UPDATED: `index.ts`

**File:** `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/index.ts`

Changes:

- Imported `validateAllPlanArtifacts` and validator types from `./plan-artifact-validator.js`
- Added Step 2b (strict format validation) in the prepare command handler: after `runPlanValidation()` succeeds, calls `validateAllPlanArtifacts()` as an additional gate. If it fails, the approval interview is skipped and the user sees detailed format errors.
- Added validator functions (`validateAllPlanArtifacts`, `validateSingleArtifact`, `runArtifactRepair`) and types (`ArtifactValidationResult`, `AllArtifactsValidationResult`, `ArtifactRepairResult`) to the module re-exports.

### 4. NEW: `test/plan-artifact-validator.test.ts`

**File:** `packages/pi-zflow-change-workflows/test/plan-artifact-validator.test.ts`

Tests:

1. All valid artifacts pass validation
2. Execution groups with TBD scoped verification fails
3. Execution groups with empty scoped verification fails
4. Execution groups missing Files section fails
5. Execution groups with duplicate group IDs fails
6. Execution groups with no group headings fails
7. Design with [TODO] marker fails
8. Execution groups with G-shorthand heading format (`## G1 — Name`) passes
9. Execution groups with "Execution Group" heading format passes
10. Missing artifact file fails
11. Verification without code fence fails
12. Letter-first group IDs (`A1`, `B2`) pass
13. Implementation-tasks too short fails
14. `validateSingleArtifact` works for execution-groups
15. `validateSingleArtifact` returns failure for missing artifact

## Validation Notes

- **Tests not run**: Bash execution is blocked by the parent session's path guard. Manual verification of code structure has been done.
- **Integration**: The validation runs both inside `runChangePrepareWorkflow()` (automated, with repair) and as a hard gate in the prepare command handler before the approval interview.
- **Backward compatibility**: The existing `runPlanValidation()` is preserved alongside the new validator. Both must pass before approval can proceed.
