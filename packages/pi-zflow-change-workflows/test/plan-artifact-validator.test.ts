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

### Likely files touched
- src/auth/login.ts
- src/auth/types.ts

### Implementation checklist
1. Review design
2. Implement changes
3. Run scoped verification
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
    const artifacts = {
      "design": VALID_DESIGN,
      "execution-groups": LEGACY_EXECUTION_GROUPS_VARIANT,
      "standards": VALID_STANDARDS,
      "verification": VALID_VERIFICATION,
      "implementation-tasks": VALID_IMPLEMENTATION_TASKS,
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
    const artifacts = {
      "design": VALID_DESIGN,
      "execution-groups": letterFirstEG,
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
