/**
 * plan-artifact-validator.test.ts — Unit tests for deterministic markdown
 * contract validation of plan artifacts.
 */
import * as assert from "node:assert"
import { test, describe } from "node:test"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"

import {
  validateAllPlanArtifacts,
  validateSingleArtifact,
  isPlaceholderOrEmpty,
  CANONICAL_ARTIFACT_IDS,
} from "../extensions/zflow-change-workflows/plan-artifact-validator.js"
import type {
  ArtifactValidationResult,
  AllArtifactsValidationResult,
} from "../extensions/zflow-change-workflows/plan-artifact-validator.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal git repo with plan artifact files.
 */
async function createTestDirWithArtifacts(
  artifacts: Record<string, string>,
  changeId: string = "test-change",
  planVersion: string = "v1",
): Promise<{ baseDir: string; artifactsDir: string }> {
  const { execFileSync } = await import("node:child_process")
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-test-validate-"))
  execFileSync("git", ["init"], { cwd: baseDir, encoding: "utf-8", stdio: "pipe" })
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: baseDir, encoding: "utf-8", stdio: "pipe" })
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: baseDir, encoding: "utf-8", stdio: "pipe" })

  // Create a .zflow directory structure like the runtime would
  const artDir = path.join(baseDir, ".zflow", "plans", changeId, planVersion)
  await fs.mkdir(artDir, { recursive: true })

  for (const [name, content] of Object.entries(artifacts)) {
    await fs.writeFile(path.join(artDir, `${name}.md`), content, "utf-8")
  }

  // Write plan-state.json
  const planDir = path.join(baseDir, ".zflow", "plans", changeId)
  await fs.writeFile(
    path.join(planDir, "plan-state.json"),
    JSON.stringify({
      changeId,
      currentVersion: planVersion,
      lifecycleState: "draft",
    }),
    "utf-8",
  )

  return { baseDir, artifactsDir: artDir }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_EXECUTION_GROUPS = `# Execution Groups

> Generated plan for implementing auth feature.

## Group 1: Implement login handler

Brief paragraph describing this group.

**Files:** src/auth/login.ts, src/auth/types.ts
**Agent:** zflow.implement-routine
**Dependencies:** none
**Scoped verification:** npm test -- --testPathPattern=src/auth/login
**Parallelizable:** true

## Group 2: Implement logout handler

**Files:** src/auth/logout.ts, src/auth/session.ts
**Agent:** zflow.implement-routine
**Dependencies:** Group 1
**Scoped verification:** npm test -- --testPathPattern=src/auth/logout
**Parallelizable:** false
`

const VALID_DESIGN = `# Design

## Architecture

We use a service-based architecture with dependency injection.

## Components

- AuthService: handles login/logout flows
- SessionManager: manages session state

## Data flow

User -> Controller -> AuthService -> Repository
`

const VALID_STANDARDS = `# Standards

## Code style

- Use TypeScript with strict mode
- Prefer named exports
- Use async/await over raw promises

## Testing

- Unit tests for all services
- Integration tests for endpoints
`

const VALID_VERIFICATION = `# Verification

## Commands

Run these commands to verify the implementation:

\`\`\`bash
npm run build
npm test
npm run lint
\`\`\`

## Expected Results

All tests should pass with no errors or warnings.
`

const VALID_IMPLEMENTATION_TASKS = `# Implementation Tasks

## Context

This file contains implementation task specs for each execution group.

## Group 1: Implement login handler

### Objective
Implement the login handler per the design doc.

### Scope
Included:
- Login handler behavior and related auth types.

Excluded:
- Unrelated auth refactors.

### Likely files touched
- src/auth/login.ts
- src/auth/types.ts

### Context to read first
- design.md authentication section
- existing auth tests around src/auth/login.ts

### Implementation checklist
1. Review design and nearby auth tests.
2. Update src/auth/login.ts to validate the request payload and issue the login flow.
3. Update src/auth/types.ts if the handler requires new type shape.
4. Run scoped verification.

### Pseudocode / implementation sketch
- Update src/auth/login.ts to parse the login request and delegate to the existing auth service.
- Keep src/auth/types.ts aligned with the request/response shape used by the handler.
- Preserve existing auth error handling rather than introducing a parallel flow.

### Acceptance criteria
- Login handler follows the approved request/response design.
- Auth types remain consistent with the handler implementation.

### Scoped verification
\`\`\`bash
npm test -- src/auth/login.test.ts
\`\`\`

### Self-check before completion
- [ ] Only login-handler files changed.
- [ ] Scoped verification was run.

### Drift triggers
- Required auth flow changes extend outside src/auth/login.ts and src/auth/types.ts.
- The approved verification command no longer matches the repo test layout.

## Group 2: Implement logout handler

### Objective
Implement the logout handler and session cleanup path.

### Scope
Included:
- Logout handler behavior.
- Session invalidation updates.

Excluded:
- Login flow changes.

### Likely files touched
- src/auth/logout.ts
- src/auth/session.ts

### Context to read first
- design.md session-management section
- existing logout and session tests

### Implementation checklist
1. Inspect existing logout/session flow.
2. Update src/auth/logout.ts to trigger the approved logout behavior.
3. Update src/auth/session.ts to invalidate the active session state cleanly.
4. Run scoped verification.

### Pseudocode / implementation sketch
- Update src/auth/logout.ts to call the shared session invalidation path instead of duplicating cleanup logic.
- Keep src/auth/session.ts as the single owner of session teardown semantics.
- Preserve the current response contract for logout callers.

### Acceptance criteria
- Logout handler clears the approved session state.
- Session helper behavior stays consistent for downstream callers.

### Scoped verification
\`\`\`bash
npm test -- src/auth/logout.test.ts
\`\`\`

### Self-check before completion
- [ ] Only logout/session files changed.
- [ ] Scoped verification was run.

### Drift triggers
- Session invalidation requires changes outside src/auth/logout.ts and src/auth/session.ts.
- Logout semantics in the approved design no longer match the codebase.
`

const LEGACY_EXECUTION_GROUPS_VARIANT = `# test-change — Execution Groups (v1)

## Phase 1 — API surface

### Group G1 — Backend logic
- **Owner agent:** backend-api
- **Task description:** Add read/query methods and DTO definitions.
- **Files touched (≤7):**
  1. \`src/backend/licenseManager.ts\`
  2. \`src/backend/interfaces.ts\`
- **Dependencies:** none
- **Review tags:** \`backend\`, \`oracle\`
- **Scoped verification:**
  - \`npm test -- backend\`
  - \`npm run build\`
- **Expected verification outcome:**
  - Backend logic compiles.
- **Execution mode:** isolated
- **Base strategy:** head

### Group G2 — Endpoint wrappers
- **Owner agent:** backend-api
- **Task description:** Add read-only endpoint wrappers.
- **Files touched (≤7):**
  1. \`src/api/get-oracle.ts\`
  2. \`src/api/function.json\`
- **Dependencies:** \`G1\`
- **Review tags:** \`backend\`, \`oracle\`
- **Scoped verification:**
  - \`npm test -- api\`
- **Expected verification outcome:**
  - Endpoint wrappers compile.
- **Execution mode:** isolated
- **Base strategy:** dependency-lineage
- **Execution rationale:** wrappers depend directly on backend logic from G1.
`

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("isPlaceholderOrEmpty", () => {
  test("returns true for empty string", () => {
    assert.strictEqual(isPlaceholderOrEmpty(""), true)
  })

  test("returns true for whitespace", () => {
    assert.strictEqual(isPlaceholderOrEmpty("   "), true)
  })

  test("returns true for TBD", () => {
    assert.strictEqual(isPlaceholderOrEmpty("TBD"), true)
  })

  test("returns true for tbd", () => {
    assert.strictEqual(isPlaceholderOrEmpty("tbd"), true)
  })

  test("returns true for TODO", () => {
    assert.strictEqual(isPlaceholderOrEmpty("TODO"), true)
  })

  test("returns true for empty brackets []", () => {
    assert.strictEqual(isPlaceholderOrEmpty("[]"), true)
  })

  test("returns false for a real command", () => {
    assert.strictEqual(isPlaceholderOrEmpty("npm test"), false)
  })

  test("returns false for a full file path", () => {
    assert.strictEqual(isPlaceholderOrEmpty("src/auth/login.ts"), false)
  })
})

describe("validateAllPlanArtifacts", () => {
  test("all valid artifacts pass validation", async () => {
    const artifacts = {
      "design": VALID_DESIGN,
      "execution-groups": VALID_EXECUTION_GROUPS,
      "standards": VALID_STANDARDS,
      "verification": VALID_VERIFICATION,
      "implementation-tasks": VALID_IMPLEMENTATION_TASKS,
    }

    const { baseDir } = await createTestDirWithArtifacts(artifacts)
    try {
      const result = await validateAllPlanArtifacts("test-change", "v1", baseDir)
      const failingResults = result.results.filter(r => !r.valid)
      const failDetails = failingResults.map(r => `${r.artifact}: ${r.issues.join("; ")}`).join(" | ")
      assert.strictEqual(result.valid, true, `Expected all valid: ${result.summary}. Failing: ${failDetails}`)
      assert.strictEqual(result.results.length, 5, "Should have 5 artifact results")
      for (const r of result.results) {
        assert.strictEqual(r.valid, true, `Artifact "${r.artifact}" should be valid`)
      }
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true })
    }
  })

  test("execution-groups with TBD scoped verification fails", async () => {
    const invalidEG = VALID_EXECUTION_GROUPS.replace(
      "**Scoped verification:** npm test -- --testPathPattern=src/auth/login",
      "**Scoped verification:** TBD",
    )
    const artifacts = {
      "design": VALID_DESIGN,
      "execution-groups": invalidEG,
      "standards": VALID_STANDARDS,
      "verification": VALID_VERIFICATION,
      "implementation-tasks": VALID_IMPLEMENTATION_TASKS,
    }

    const { baseDir } = await createTestDirWithArtifacts(artifacts)
    try {
      const result = await validateAllPlanArtifacts("test-change", "v1", baseDir)
      assert.strictEqual(result.valid, false, "Should fail with TBD verification")
      const egResult = result.results.find((r) => r.artifact === "execution-groups")
      assert.ok(egResult, "execution-groups result should exist")
      assert.strictEqual(egResult!.valid, false)
      const hasPlaceholderIssue = egResult!.issues.some((i) => i.toLowerCase().includes("tbd"))
      assert.strictEqual(hasPlaceholderIssue, true, "Should mention TBD")
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true })
    }
  })

  test("execution-groups with empty scoped verification fails", async () => {
    const invalidEG = `# Execution Groups

## Group 1: Login handler

**Files:** src/auth/login.ts
**Agent:** zflow.implement-routine
**Dependencies:** none
**Scoped verification:** 
**Parallelizable:** true
`
    const artifacts = {
      "design": VALID_DESIGN,
      "execution-groups": invalidEG,
      "standards": VALID_STANDARDS,
      "verification": VALID_VERIFICATION,
      "implementation-tasks": VALID_IMPLEMENTATION_TASKS,
    }

    const { baseDir } = await createTestDirWithArtifacts(artifacts)
    try {
      const result = await validateAllPlanArtifacts("test-change", "v1", baseDir)
      const egResult = result.results.find((r) => r.artifact === "execution-groups")
      const issues = egResult ? egResult.issues.join("; ") : "no eg result"
      assert.strictEqual(result.valid, false, "Should fail with empty verification. EG issues: " + issues)
      assert.ok(egResult)
      assert.strictEqual(egResult!.valid, false)
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true })
    }
  })

  test("execution-groups requiring shared-staging without workspace id fail", async () => {
    const invalidEG = `# Execution Groups

## Group 1: Shared auth route

**Files:** src/auth.ts
**Agent:** zflow.implement-routine
**Dependencies:** none
**Scoped verification:** npm test -- auth
**Parallelizable:** false
**Execution mode:** shared-staging
**Execution rationale:** needs shared filesystem context
`
    const artifacts = {
      "design": VALID_DESIGN,
      "execution-groups": invalidEG,
      "standards": VALID_STANDARDS,
      "verification": VALID_VERIFICATION,
      "implementation-tasks": VALID_IMPLEMENTATION_TASKS,
    }

    const { baseDir } = await createTestDirWithArtifacts(artifacts)
    try {
      const result = await validateAllPlanArtifacts("test-change", "v1", baseDir)
      assert.strictEqual(result.valid, false)
      const egResult = result.results.find((r) => r.artifact === "execution-groups")
      assert.ok(egResult)
      assert.ok(
        egResult!.issues.some((issue) => /workspace|shared-staging/i.test(issue)),
        `expected a workspace/shared-staging issue, got: ${egResult!.issues.join("; ")}`,
      )
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true })
    }
  })

  test("dependency-lineage without dependencies fails", async () => {
    const invalidEG = `# Execution Groups

## Group 1: Downstream API task

**Files:** src/api.ts
**Agent:** zflow.implement-hard
**Dependencies:** none
**Scoped verification:** npm test -- api
**Parallelizable:** false
**Base strategy:** dependency-lineage
**Execution rationale:** wants pending dependency changes visible
`
    const artifacts = {
      "design": VALID_DESIGN,
      "execution-groups": invalidEG,
      "standards": VALID_STANDARDS,
      "verification": VALID_VERIFICATION,
      "implementation-tasks": VALID_IMPLEMENTATION_TASKS,
    }

    const { baseDir } = await createTestDirWithArtifacts(artifacts)
    try {
      const result = await validateAllPlanArtifacts("test-change", "v1", baseDir)
      assert.strictEqual(result.valid, false)
      const egResult = result.results.find((r) => r.artifact === "execution-groups")
      assert.ok(egResult)
      assert.ok(egResult!.issues.some((issue) => issue.includes("dependency-lineage")))
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true })
    }
  })

  test("execution-groups missing Files section fails", async () => {
    // Remove the files lines from group 1
    const invalidEG = VALID_EXECUTION_GROUPS.replace(
      "**Files:** src/auth/login.ts, src/auth/types.ts\n",
      "",
    )
    const artifacts = {
      "design": VALID_DESIGN,
      "execution-groups": invalidEG,
      "standards": VALID_STANDARDS,
      "verification": VALID_VERIFICATION,
      "implementation-tasks": VALID_IMPLEMENTATION_TASKS,
    }

    const { baseDir } = await createTestDirWithArtifacts(artifacts)
    try {
      const result = await validateAllPlanArtifacts("test-change", "v1", baseDir)
      assert.strictEqual(result.valid, false, "Should fail with missing Files section")
      const egResult = result.results.find((r) => r.artifact === "execution-groups")
      assert.ok(egResult)
      assert.strictEqual(egResult!.valid, false)
      const hasFilesIssue = egResult!.issues.some((i) => i.toLowerCase().includes("files"))
      assert.strictEqual(hasFilesIssue, true, "Should mention missing Files")
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true })
    }
  })

  test("execution-groups with duplicate group IDs fails", async () => {
    // Create a second group with the same ID as the first
    const duplicateEG = `# Execution Groups

## Group 1: Login handler

**Files:** src/auth/login.ts
**Agent:** zflow.implement-routine
**Dependencies:** none
**Scoped verification:** npm test
**Parallelizable:** true

## Group 1: Another description

**Files:** src/auth/logout.ts
**Agent:** zflow.implement-routine
**Dependencies:** none
**Scoped verification:** npm test
**Parallelizable:** true
`
    const artifacts = {
      "design": VALID_DESIGN,
      "execution-groups": duplicateEG,
      "standards": VALID_STANDARDS,
      "verification": VALID_VERIFICATION,
      "implementation-tasks": VALID_IMPLEMENTATION_TASKS,
    }

    const { baseDir } = await createTestDirWithArtifacts(artifacts)
    try {
      const result = await validateAllPlanArtifacts("test-change", "v1", baseDir)
      assert.strictEqual(result.valid, false, "Should fail with duplicate group IDs")
      const egResult = result.results.find((r) => r.artifact === "execution-groups")
      assert.ok(egResult)
      assert.strictEqual(egResult!.valid, false)
      const hasDuplicateIssue = egResult!.issues.some((i) => i.toLowerCase().includes("duplicate"))
      assert.strictEqual(hasDuplicateIssue, true, "Should mention duplicate")
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true })
    }
  })

  test("execution-groups with no group headings fails", async () => {
    const noHeadingEG = `# Execution Groups

Some text but no proper group headings.
`
    const artifacts = {
      "design": VALID_DESIGN,
      "execution-groups": noHeadingEG,
      "standards": VALID_STANDARDS,
      "verification": VALID_VERIFICATION,
      "implementation-tasks": VALID_IMPLEMENTATION_TASKS,
    }

    const { baseDir } = await createTestDirWithArtifacts(artifacts)
    try {
      const result = await validateAllPlanArtifacts("test-change", "v1", baseDir)
      assert.strictEqual(result.valid, false, "Should fail with no group headings")
      const egResult = result.results.find((r) => r.artifact === "execution-groups")
      assert.ok(egResult)
      assert.strictEqual(egResult!.valid, false)
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true })
    }
  })

  test("design with [TODO] marker fails", async () => {
    const designWithTodo = `# Design\n\n[TODO] Write the design section`
    const artifacts = {
      "design": designWithTodo,
      "execution-groups": VALID_EXECUTION_GROUPS,
      "standards": VALID_STANDARDS,
      "verification": VALID_VERIFICATION,
      "implementation-tasks": VALID_IMPLEMENTATION_TASKS,
    }

    const { baseDir } = await createTestDirWithArtifacts(artifacts)
    try {
      const result = await validateAllPlanArtifacts("test-change", "v1", baseDir)
      assert.strictEqual(result.valid, false, "Should fail with TODO marker")
      const designResult = result.results.find((r) => r.artifact === "design")
      assert.ok(designResult)
      assert.strictEqual(designResult!.valid, false)
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true })
    }
  })

  test("execution-groups with G-shorthand heading format passes", async () => {
    const shorthandEG = `# Execution Groups

## G1 — Login handler

**Files:** src/auth/login.ts
**Agent:** zflow.implement-routine
**Dependencies:** none
**Scoped verification:** npm test -- --testPathPattern=src/auth/login
**Parallelizable:** true
`
    const artifacts = {
      "design": VALID_DESIGN,
      "execution-groups": shorthandEG,
      "standards": VALID_STANDARDS,
      "verification": VALID_VERIFICATION,
      "implementation-tasks": VALID_IMPLEMENTATION_TASKS,
    }

    const { baseDir } = await createTestDirWithArtifacts(artifacts)
    try {
      const result = await validateAllPlanArtifacts("test-change", "v1", baseDir)
      assert.strictEqual(result.valid, true, `Expected valid: ${result.summary}`)
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true })
    }
  })

  test("execution-groups with legacy planner labels and omitted parallelizable pass", async () => {
    const legacyImplementationTasks = `# Implementation Tasks

## Group G1: Backend logic

### Objective
Add backend read/query methods and DTO definitions.

### Scope
Included:
- src/backend/licenseManager.ts
- src/backend/interfaces.ts

Excluded:
- Endpoint wrappers.

### Likely files touched
- src/backend/licenseManager.ts
- src/backend/interfaces.ts

### Context to read first
- Existing backend query code
- DTO conventions in src/backend/interfaces.ts

### Implementation checklist
1. Extend src/backend/licenseManager.ts with the new read/query methods.
2. Update src/backend/interfaces.ts with the DTO definitions those methods require.
3. Run backend verification.

### Pseudocode / implementation sketch
- Update src/backend/licenseManager.ts so the read/query methods reuse existing backend data access instead of adding a parallel path.
- Keep src/backend/interfaces.ts as the source of truth for the DTO shapes used by the new methods.

### Acceptance criteria
- Backend logic compiles.
- DTOs line up with the new backend methods.

### Scoped verification
\`\`\`bash
npm test -- backend
npm run build
\`\`\`

### Self-check before completion
- [ ] Backend files only.
- [ ] Verification ran.

### Drift triggers
- A required DTO change spills into endpoint wrappers.

## Group G2: Endpoint wrappers

### Objective
Add the read-only endpoint wrappers for the backend methods.

### Scope
Included:
- src/api/get-oracle.ts
- src/api/function.json

Excluded:
- Backend method redesign.

### Likely files touched
- src/api/get-oracle.ts
- src/api/function.json

### Context to read first
- Backend logic from G1
- Existing endpoint wrapper patterns

### Implementation checklist
1. Read the backend changes from G1.
2. Update src/api/get-oracle.ts to call the new backend read path.
3. Keep src/api/function.json aligned with the endpoint contract.
4. Run API verification.

### Pseudocode / implementation sketch
- Update src/api/get-oracle.ts so the endpoint wrapper delegates to the backend logic added in G1.
- Keep src/api/function.json synchronized with the wrapper's route/function metadata.

### Acceptance criteria
- Endpoint wrappers compile.
- Wrapper metadata matches the backend route.

### Scoped verification
\`\`\`bash
npm test -- api
\`\`\`

### Self-check before completion
- [ ] API wrapper files only.
- [ ] Verification ran.

### Drift triggers
- Wrapper changes require backend API redesign.
`
    const artifacts = {
      "design": VALID_DESIGN,
      "execution-groups": LEGACY_EXECUTION_GROUPS_VARIANT,
      "standards": VALID_STANDARDS,
      "verification": VALID_VERIFICATION,
      "implementation-tasks": legacyImplementationTasks,
    }

    const { baseDir } = await createTestDirWithArtifacts(artifacts)
    try {
      const result = await validateAllPlanArtifacts("test-change", "v1", baseDir)
      assert.strictEqual(result.valid, true, `Expected legacy variant to validate: ${result.summary}`)
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true })
    }
  })

  test("execution-groups with Execution Group heading format passes", async () => {
    const execFormatEG = `# Execution Groups

## Execution Group 1: Login handler

**Files:** src/auth/login.ts
**Agent:** zflow.implement-routine
**Dependencies:** none
**Scoped verification:** npm test -- --testPathPattern=src/auth/login
**Parallelizable:** true
`
    const artifacts = {
      "design": VALID_DESIGN,
      "execution-groups": execFormatEG,
      "standards": VALID_STANDARDS,
      "verification": VALID_VERIFICATION,
      "implementation-tasks": VALID_IMPLEMENTATION_TASKS,
    }

    const { baseDir } = await createTestDirWithArtifacts(artifacts)
    try {
      const result = await validateAllPlanArtifacts("test-change", "v1", baseDir)
      assert.strictEqual(result.valid, true, `Expected valid: ${result.summary}`)
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true })
    }
  })

  test("missing artifact file fails", async () => {
    const { baseDir } = await createTestDirWithArtifacts({}, "test-change", "v1")
    try {
      const result = await validateAllPlanArtifacts("test-change", "v1", baseDir)
      assert.strictEqual(result.valid, false, "Should fail with missing artifacts")
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true })
    }
  })

  test("verification without code fence fails", async () => {
    const verifNoFence = `# Verification\n\nRun tests to verify correctness.\n`
    const artifacts = {
      "design": VALID_DESIGN,
      "execution-groups": VALID_EXECUTION_GROUPS,
      "standards": VALID_STANDARDS,
      "verification": verifNoFence,
      "implementation-tasks": VALID_IMPLEMENTATION_TASKS,
    }

    const { baseDir } = await createTestDirWithArtifacts(artifacts)
    try {
      const result = await validateAllPlanArtifacts("test-change", "v1", baseDir)
      assert.strictEqual(result.valid, false, "Should fail without code fence")
      const verifResult = result.results.find((r) => r.artifact === "verification")
      assert.ok(verifResult)
      assert.strictEqual(verifResult!.valid, false)
      const hasCodeFenceIssue = verifResult!.issues.some((i) => i.toLowerCase().includes("code fence"))
      assert.strictEqual(hasCodeFenceIssue, true, "Should mention code fence")
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true })
    }
  })

  test("execution-groups with letter-first group IDs passes", async () => {
    const letterFirstEG = `# Execution Groups

## Group A1: Auth module

**Files:** src/auth/login.ts
**Agent:** zflow.implement-routine
**Dependencies:** none
**Scoped verification:** npm test
**Parallelizable:** true

## Group B2: User module

**Files:** src/user/profile.ts
**Agent:** zflow.implement-routine
**Dependencies:** A1
**Scoped verification:** npm test
**Parallelizable:** true
`
    const letterFirstTasks = `# Implementation Tasks

## Group A1: Auth module

### Objective
Update the auth module entrypoint.

### Scope
Included:
- src/auth/login.ts

Excluded:
- User profile work.

### Likely files touched
- src/auth/login.ts

### Context to read first
- Existing auth module behavior.

### Implementation checklist
1. Inspect src/auth/login.ts.
2. Apply the auth module change.
3. Run npm test.

### Pseudocode / implementation sketch
- Update src/auth/login.ts to implement the auth-module behavior described in Group A1.

### Acceptance criteria
- Auth module behavior passes verification.

### Scoped verification
\`\`\`bash
npm test
\`\`\`

### Self-check before completion
- [ ] Auth file only.

### Drift triggers
- Auth change expands beyond src/auth/login.ts.

## Group B2: User module

### Objective
Update the user module entrypoint.

### Scope
Included:
- src/user/profile.ts

Excluded:
- Auth module work.

### Likely files touched
- src/user/profile.ts

### Context to read first
- Existing user profile behavior.

### Implementation checklist
1. Inspect src/user/profile.ts.
2. Apply the user module change.
3. Run npm test.

### Pseudocode / implementation sketch
- Update src/user/profile.ts so the user-module change depends on A1 without duplicating auth logic.

### Acceptance criteria
- User module behavior passes verification.

### Scoped verification
\`\`\`bash
npm test
\`\`\`

### Self-check before completion
- [ ] User profile file only.

### Drift triggers
- User module change expands beyond src/user/profile.ts.
`
    const artifacts = {
      "design": VALID_DESIGN,
      "execution-groups": letterFirstEG,
      "standards": VALID_STANDARDS,
      "verification": VALID_VERIFICATION,
      "implementation-tasks": letterFirstTasks,
    }

    const { baseDir } = await createTestDirWithArtifacts(artifacts)
    try {
      const result = await validateAllPlanArtifacts("test-change", "v1", baseDir)
      assert.strictEqual(result.valid, true, `Expected valid: ${result.summary}`)
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true })
    }
  })

  test("implementation-tasks too short fails", async () => {
    const shortTasks = `# Tasks\n\nToo short.\n`  // less than 100 chars
    const artifacts = {
      "design": VALID_DESIGN,
      "execution-groups": VALID_EXECUTION_GROUPS,
      "standards": VALID_STANDARDS,
      "verification": VALID_VERIFICATION,
      "implementation-tasks": shortTasks,
    }

    const { baseDir } = await createTestDirWithArtifacts(artifacts)
    try {
      const result = await validateAllPlanArtifacts("test-change", "v1", baseDir)
      assert.strictEqual(result.valid, false, "Should fail with short implementation-tasks")
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true })
    }
  })

  test("synthesized implementation-tasks fails validation", async () => {
    const synthesizedTasks = `# Implementation Tasks

<!-- zflow-synthesized-artifact: implementation-tasks -->

## Group 1: Implement login handler

### Objective
Implement the login handler.

### Scope
Included only the planned files.

### Likely files touched
- src/auth/login.ts
- src/auth/types.ts

### Context to read first
- design.md

### Implementation checklist
1. Read files.
2. Make changes.

### Pseudocode / implementation sketch
read design.md, standards.md, verification.md, and execution-groups.md for group-1
for each likely touched file:
  make the smallest change that satisfies the group objective

### Acceptance criteria
- Objective implemented.

### Scoped verification
\`\`\`bash
npm test -- src/auth/login.test.ts
\`\`\`

### Self-check before completion
- [ ] Done

### Drift triggers
- Scope changes
`

    const artifacts = {
      "design": VALID_DESIGN,
      "execution-groups": VALID_EXECUTION_GROUPS,
      "standards": VALID_STANDARDS,
      "verification": VALID_VERIFICATION,
      "implementation-tasks": synthesizedTasks,
    }

    const { baseDir } = await createTestDirWithArtifacts(artifacts)
    try {
      const result = await validateSingleArtifact("test-change", "v1", "implementation-tasks", baseDir)
      assert.strictEqual(result.valid, false)
      assert.ok(result.issues.some((issue) => issue.includes("synthesized recovery artifact")))
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true })
    }
  })

  test("validateSingleArtifact works for execution-groups", async () => {
    const artifacts = {
      "execution-groups": VALID_EXECUTION_GROUPS,
    }

    const { baseDir } = await createTestDirWithArtifacts(artifacts)
    try {
      const result = await validateSingleArtifact("test-change", "v1", "execution-groups", baseDir)
      assert.strictEqual(result.valid, true)
      assert.strictEqual(result.artifact, "execution-groups")
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true })
    }
  })

  test("validateSingleArtifact returns failure for missing artifact", async () => {
    const { baseDir } = await createTestDirWithArtifacts({}, "test-change", "v1")
    try {
      const result = await validateSingleArtifact("test-change", "v1", "design", baseDir)
      assert.strictEqual(result.valid, false)
      assert.ok(result.issues[0]?.includes("not found"))
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true })
    }
  })
})
