/**
 * Path guard unit tests.
 *
 * Tests the core path-guard safety model: realpathSafe, isWithinAllowedRoots,
 * matchesBlockedPatterns, canWrite, and resolveSentinelPolicy.
 */
import * as assert from "node:assert"
import { test, describe, mock, before, after } from "node:test"
import * as path from "node:path"
import * as os from "node:os"
import * as fs from "node:fs"

// Import under test
import {
  realpathSafe,
  isWithinAllowedRoots,
  matchesBlockedPatterns,
  canWrite,
  resolveSentinelPolicy,
  DEFAULT_ALLOWED_ROOTS,
  DEFAULT_BLOCKED_PATTERNS,
  DEFAULT_SYMLINK_SAFETY,
  defaultPlannerArtifactPolicy,
} from "../src/path-guard.js"

import type {
  AllowedRoot,
  SentinelPolicy,
  CanWriteResult,
} from "../src/path-guard.js"

const PROJECT_ROOT = "/home/user/project"
const RUNTIME_STATE_DIR = path.join(PROJECT_ROOT, ".git", "pi-zflow")
const TEMP_FALLBACK = path.join(os.tmpdir(), "pi-zflow-test-hash")

// ---------------------------------------------------------------------------
// realpathSafe
// ---------------------------------------------------------------------------

describe("realpathSafe", () => {
  test("allows a relative path inside project root", () => {
    const result = realpathSafe("src/app.ts", PROJECT_ROOT)
    assert.notEqual(result, null)
    assert.ok(result!.startsWith(PROJECT_ROOT))
    assert.ok(result!.endsWith("src/app.ts"))
  })

  test("allows a nested relative path", () => {
    const result = realpathSafe("packages/core/src/index.ts", PROJECT_ROOT)
    assert.notEqual(result, null)
    assert.ok(result!.startsWith(PROJECT_ROOT))
    assert.ok(result!.endsWith("packages/core/src/index.ts"))
  })

  test("rejects relative path escaping via ..", () => {
    const result = realpathSafe("src/../../etc/passwd", PROJECT_ROOT)
    assert.equal(result, null)
  })

  test("rejects deeply nested .. escape", () => {
    const result = realpathSafe("a/b/c/../../../../etc/hosts", PROJECT_ROOT)
    assert.equal(result, null)
  })

  test("allows an absolute path outside project root (temp fallback)", () => {
    const tmpPath = `${TEMP_FALLBACK}/plans/ch42/v1/design.md`
    const result = realpathSafe(tmpPath, PROJECT_ROOT)
    assert.notEqual(
      result,
      null,
      "absolute paths outside project root should NOT be rejected by realpathSafe",
    )
    assert.strictEqual(result, tmpPath)
  })

  test("allows absolute path to runtime state dir", () => {
    const statePath = `${RUNTIME_STATE_DIR}/plans/ch42/v1/design.md`
    const result = realpathSafe(statePath, PROJECT_ROOT)
    assert.notEqual(result, null)
    assert.strictEqual(result, statePath)
  })

  test("allows a plain relative path with dot", () => {
    const result = realpathSafe("./src/main.ts", PROJECT_ROOT)
    assert.notEqual(result, null)
    assert.ok(result!.endsWith("src/main.ts"))
  })

  test("handles empty project root gracefully", () => {
    // Should not crash — even with a silly root
    const result = realpathSafe("/tmp/foo", "/")
    assert.notEqual(result, null)
  })

  test("respects disabled traversal detection", () => {
    // With traversal disabled, relative escape is allowed (lenient mode)
    const result = realpathSafe("src/../../etc/passwd", PROJECT_ROOT, {
      resolveSymlinks: true,
      preventTraversal: false,
    })
    assert.notEqual(result, null)
  })
})

// ---------------------------------------------------------------------------
// isWithinAllowedRoots
// ---------------------------------------------------------------------------

describe("isWithinAllowedRoots", () => {
  const roots: AllowedRoot[] = [
    { path: PROJECT_ROOT, label: "project", allowIntent: "implementation" },
  ]

  test("path inside project root returns true", () => {
    assert.ok(isWithinAllowedRoots(`${PROJECT_ROOT}/src/app.ts`, roots, PROJECT_ROOT))
  })

  test("path outside allowed roots returns false", () => {
    assert.ok(!isWithinAllowedRoots("/tmp/unauthorized", roots, PROJECT_ROOT))
  })

  test("does not allow sibling path with same prefix", () => {
    assert.ok(!isWithinAllowedRoots(`${PROJECT_ROOT}-other/src/app.ts`, roots, PROJECT_ROOT))
  })

  test("glob allowed root matches sub-path", () => {
    const globRoot: AllowedRoot[] = [
      { path: `${PROJECT_ROOT}/packages/**`, glob: true },
    ]
    assert.ok(isWithinAllowedRoots(`${PROJECT_ROOT}/packages/core/src/index.ts`, globRoot, PROJECT_ROOT))
    assert.ok(!isWithinAllowedRoots(`${PROJECT_ROOT}/node_modules/pkg/index.js`, globRoot, PROJECT_ROOT))
  })

  test("relative allowed root is resolved against project root", () => {
    const relativeRoots: AllowedRoot[] = [
      { path: ".", label: "cwd" },
    ]
    assert.ok(isWithinAllowedRoots(`${PROJECT_ROOT}/any/file.ts`, relativeRoots, PROJECT_ROOT))
    assert.ok(!isWithinAllowedRoots("/tmp/foo", relativeRoots, PROJECT_ROOT))
  })
})

// ---------------------------------------------------------------------------
// matchesBlockedPatterns
// ---------------------------------------------------------------------------

describe("matchesBlockedPatterns", () => {
  test("blocks .git/** by default", () => {
    const match = matchesBlockedPatterns(
      `${PROJECT_ROOT}/.git/config`,
      DEFAULT_BLOCKED_PATTERNS,
      PROJECT_ROOT,
    )
    assert.notEqual(match, null)
    assert.equal(match!.severity, "error")
  })

  test("allows runtime state dir in .git/ (exclusion carve-out)", () => {
    const statePath = `${RUNTIME_STATE_DIR}/plans/ch42/v1/design.md`
    const match = matchesBlockedPatterns(
      statePath,
      [
        {
          pattern: ".git/**",
          reason: "Git metadata",
          severity: "error",
          exclude: ["<runtime-state-dir>/**"],
        },
      ],
      PROJECT_ROOT,
    )
    // The blocked pattern with exclusion should NOT match — the exclusion
    // carve-out means paths under <runtime-state-dir> are exempt.
    //
    // Note: the exclusion pattern needs the runtime-state-dir placeholder
    // to be resolved. In real usage resolveSentinelPolicy does this.
    // For this test we manually verify the logic with a resolved exclusion.
    const resolvedExcludePattern = `${path.relative(PROJECT_ROOT, RUNTIME_STATE_DIR)}/**`
    const bp = {
      pattern: ".git/**",
      reason: "Git metadata",
      severity: "error" as const,
      exclude: [resolvedExcludePattern],
    }
    const result = matchesBlockedPatterns(statePath, [bp], PROJECT_ROOT)
    assert.equal(result, null, "runtime state path should be exempt from .git/** blocked pattern")
  })
})

// ---------------------------------------------------------------------------
// canWrite
// ---------------------------------------------------------------------------

describe("canWrite", () => {
  const policy: SentinelPolicy = {
    description: "test policy",
    allowedRoots: [
      { path: PROJECT_ROOT, label: "project", allowIntent: "implementation" },
    ],
    blockedPatterns: [
      { pattern: ".git/**", reason: "Git metadata", severity: "error", exclude: ["<runtime-state-dir>/**"] },
      { pattern: "node_modules/**", reason: "PM managed", severity: "error" },
      { pattern: ".env*", reason: "Secrets", severity: "error" },
    ],
    symlinkSafety: { resolveSymlinks: true, preventTraversal: true },
    plannerArtifactPolicy: {
      allowedArtifactDirs: [
        "<runtime-state-dir>/plans/**",
        "<runtime-state-dir>/review/**",
        "<runtime-state-dir>/state-index.json",
      ],
    },
  }

  test("allows implementation write to project root", () => {
    const result = canWrite(`${PROJECT_ROOT}/src/app.ts`, {
      policy: resolveSentinelPolicy({}, PROJECT_ROOT, RUNTIME_STATE_DIR),
      projectRoot: PROJECT_ROOT,
      runtimeStateDir: RUNTIME_STATE_DIR,
      intent: "implementation",
    })
    assert.ok(result.allowed, `expected allowed, got: ${result.message}`)
  })

  test("denies write to .git/config", () => {
    const result = canWrite(`${PROJECT_ROOT}/.git/config`, {
      policy: resolveSentinelPolicy({}, PROJECT_ROOT, RUNTIME_STATE_DIR),
      projectRoot: PROJECT_ROOT,
      runtimeStateDir: RUNTIME_STATE_DIR,
      intent: "implementation",
    })
    assert.ok(!result.allowed, `expected denied, got: ${result.message}`)
  })

  test("allows planner-artifact write to runtime state dir", () => {
    // Use the resolved sentinel policy which adds runtime state dirs to allowed roots
    const resolved = resolveSentinelPolicy({}, PROJECT_ROOT, RUNTIME_STATE_DIR)
    const result = canWrite(`${RUNTIME_STATE_DIR}/plans/ch42/v1/design.md`, {
      policy: resolved,
      projectRoot: PROJECT_ROOT,
      runtimeStateDir: RUNTIME_STATE_DIR,
      intent: "planner-artifact",
    })
    assert.ok(result.allowed, `expected allowed, got: ${result.message}`)
  })

  test("allows planner-artifact write to review dir", () => {
    const resolved = resolveSentinelPolicy({}, PROJECT_ROOT, RUNTIME_STATE_DIR)
    const result = canWrite(`${RUNTIME_STATE_DIR}/review/code-review-findings.md`, {
      policy: resolved,
      projectRoot: PROJECT_ROOT,
      runtimeStateDir: RUNTIME_STATE_DIR,
      intent: "planner-artifact",
    })
    assert.ok(result.allowed, `expected allowed, got: ${result.message}`)
  })

  test("denies implementation write to runtime state dir", () => {
    const resolved = resolveSentinelPolicy({}, PROJECT_ROOT, RUNTIME_STATE_DIR)
    const result = canWrite(`${RUNTIME_STATE_DIR}/plans/ch42/v1/design.md`, {
      policy: resolved,
      projectRoot: PROJECT_ROOT,
      runtimeStateDir: RUNTIME_STATE_DIR,
      intent: "implementation",
    })
    assert.ok(!result.allowed, `expected denied, got: ${result.message}`)
  })

  test("denies planner-artifact write to source code", () => {
    const resolved = resolveSentinelPolicy({}, PROJECT_ROOT, RUNTIME_STATE_DIR)
    const result = canWrite(`${PROJECT_ROOT}/src/app.ts`, {
      policy: resolved,
      projectRoot: PROJECT_ROOT,
      runtimeStateDir: RUNTIME_STATE_DIR,
      intent: "planner-artifact",
    })
    assert.ok(!result.allowed, `expected denied, got: ${result.message}`)
  })

  test("allows planner-artifact write to temp fallback", () => {
    const fallbackStateDir = `${TEMP_FALLBACK}`
    const resolved = resolveSentinelPolicy({}, PROJECT_ROOT, fallbackStateDir)
    const result = canWrite(`${fallbackStateDir}/plans/ch42/v1/design.md`, {
      policy: resolved,
      projectRoot: PROJECT_ROOT,
      runtimeStateDir: fallbackStateDir,
      intent: "planner-artifact",
    })
    assert.ok(result.allowed, `expected allowed, got: ${result.message}`)
  })

  test("denies sibling temp fallback path with same prefix", () => {
    const fallbackStateDir = `${TEMP_FALLBACK}`
    const resolved = resolveSentinelPolicy({}, PROJECT_ROOT, fallbackStateDir)
    const result = canWrite(`${fallbackStateDir}-other/plans/ch42/v1/design.md`, {
      policy: resolved,
      projectRoot: PROJECT_ROOT,
      runtimeStateDir: fallbackStateDir,
      intent: "planner-artifact",
    })
    assert.ok(!result.allowed, `expected denied, got: ${result.message}`)
  })

  test("denies write to node_modules", () => {
    const resolved = resolveSentinelPolicy({}, PROJECT_ROOT, RUNTIME_STATE_DIR)
    const result = canWrite(`${PROJECT_ROOT}/node_modules/pkg/index.js`, {
      policy: resolved,
      projectRoot: PROJECT_ROOT,
      runtimeStateDir: RUNTIME_STATE_DIR,
      intent: "implementation",
    })
    assert.ok(!result.allowed, `expected denied, got: ${result.message}`)
  })

  test("allows system-intent writes despite soft-blocked patterns", () => {
    // System intent bypasses soft blocks (severity: warn)
    const policyWithWarn: SentinelPolicy = {
      ...policy,
      blockedPatterns: [
        ...policy.blockedPatterns,
        { pattern: "dist/**", reason: "Build output", severity: "warn" },
      ],
    }
    // Use a policy where dist is blocked with warn
    const customPolicy: SentinelPolicy = {
      description: "test",
      allowedRoots: [{ path: PROJECT_ROOT, label: "project", allowIntent: "implementation" }],
      blockedPatterns: [
        { pattern: "dist/**", reason: "Build output", severity: "warn" },
      ],
      symlinkSafety: { resolveSymlinks: true, preventTraversal: true },
      plannerArtifactPolicy: { allowedArtifactDirs: [] },
    }
    const resolved = resolveSentinelPolicy(customPolicy, PROJECT_ROOT, RUNTIME_STATE_DIR)
    const result = canWrite(`${PROJECT_ROOT}/dist/bundle.js`, {
      policy: resolved,
      projectRoot: PROJECT_ROOT,
      runtimeStateDir: RUNTIME_STATE_DIR,
      intent: "system",
    })
    assert.ok(result.allowed, "system intent should bypass warn-severity blocked patterns")
  })
})

// ---------------------------------------------------------------------------
// canWrite — intent-scoped roots
// ---------------------------------------------------------------------------

describe("canWrite with intent-scoped roots", () => {
  test("planner-artifact root denies implementation write", () => {
    const customPolicy: SentinelPolicy = {
      description: "intent test",
      allowedRoots: [
        { path: "/tmp/plans", label: "plans", allowIntent: "planner-artifact" },
        { path: PROJECT_ROOT, label: "project", allowIntent: "implementation" },
      ],
      blockedPatterns: [],
      symlinkSafety: { resolveSymlinks: true, preventTraversal: true },
      plannerArtifactPolicy: { allowedArtifactDirs: ["/tmp/plans/**"] },
    }
    const resolved = resolveSentinelPolicy(customPolicy, PROJECT_ROOT, RUNTIME_STATE_DIR)

    // Implementation write to the plans dir should be denied.
    // No root permits implementation writes under /tmp/plans,
    // so the correct reason is "outside-allowed-roots".
    const result = canWrite("/tmp/plans/ch42/design.md", {
      policy: resolved,
      projectRoot: PROJECT_ROOT,
      runtimeStateDir: RUNTIME_STATE_DIR,
      intent: "implementation",
    })
    assert.ok(!result.allowed, `expected denied, got: ${result.message}`)
    assert.equal(result.reason, "outside-allowed-roots",
      `expected outside-allowed-roots (no root matches both path and intent), got: ${result.reason}`)
  })

  test("planner-artifact root allows planner-artifact write", () => {
    const customPolicy: SentinelPolicy = {
      description: "intent test",
      allowedRoots: [
        { path: "/tmp/plans", label: "plans", allowIntent: "planner-artifact" },
      ],
      blockedPatterns: [],
      symlinkSafety: { resolveSymlinks: true, preventTraversal: true },
      plannerArtifactPolicy: { allowedArtifactDirs: ["/tmp/plans/**"] },
    }
    const resolved = resolveSentinelPolicy(customPolicy, PROJECT_ROOT, RUNTIME_STATE_DIR)

    const result = canWrite("/tmp/plans/ch42/design.md", {
      policy: resolved,
      projectRoot: PROJECT_ROOT,
      runtimeStateDir: RUNTIME_STATE_DIR,
      intent: "planner-artifact",
    })
    assert.ok(result.allowed, `expected allowed, got: ${result.message}`)
  })

  test("implementation root denies planner-artifact write", () => {
    const customPolicy: SentinelPolicy = {
      description: "intent test",
      allowedRoots: [
        { path: PROJECT_ROOT, label: "project", allowIntent: "implementation" },
      ],
      blockedPatterns: [],
      symlinkSafety: { resolveSymlinks: true, preventTraversal: true },
      plannerArtifactPolicy: { allowedArtifactDirs: [] },
    }
    const resolved = resolveSentinelPolicy(customPolicy, PROJECT_ROOT, RUNTIME_STATE_DIR)

    const result = canWrite(`${PROJECT_ROOT}/src/app.ts`, {
      policy: resolved,
      projectRoot: PROJECT_ROOT,
      runtimeStateDir: RUNTIME_STATE_DIR,
      intent: "planner-artifact",
    })

    // Planner writes should be blocked because the only roots allow only implementation
    assert.ok(!result.allowed, `expected denied, got: ${result.message}`)
    assert.ok(
      result.reason === "intent-mismatch" || result.reason === "outside-allowed-roots",
      `reason should be intent-mismatch or outside-allowed-roots, got: ${result.reason}`,
    )
  })

  test("undefined allowIntent matches any intent", () => {
    const customPolicy: SentinelPolicy = {
      description: "intent test",
      allowedRoots: [
        { path: PROJECT_ROOT, label: "project" },  // no allowIntent
      ],
      blockedPatterns: [],
      symlinkSafety: { resolveSymlinks: true, preventTraversal: true },
      plannerArtifactPolicy: {
        allowedArtifactDirs: [`${PROJECT_ROOT}/plans/**`],
      },
    }
    const resolved = resolveSentinelPolicy(customPolicy, PROJECT_ROOT, RUNTIME_STATE_DIR)

    // Implementation write should be allowed
    assert.ok(canWrite(`${PROJECT_ROOT}/src/app.ts`, {
      policy: resolved,
      projectRoot: PROJECT_ROOT,
      runtimeStateDir: RUNTIME_STATE_DIR,
      intent: "implementation",
    }).allowed)

    // Planner-artifact write should also be allowed (no intent restriction on root,
    // and path is within allowed artifact dirs)
    const result = canWrite(`${PROJECT_ROOT}/plans/ch42/design.md`, {
      policy: resolved,
      projectRoot: PROJECT_ROOT,
      runtimeStateDir: RUNTIME_STATE_DIR,
      intent: "planner-artifact",
    })
    assert.ok(result.allowed, `expected allowed, got: ${result.message}`)
  })

  test("system intent bypasses all intent restrictions", () => {
    const customPolicy: SentinelPolicy = {
      description: "intent test",
      allowedRoots: [
        { path: "/tmp/plans", label: "plans", allowIntent: "planner-artifact" },
      ],
      blockedPatterns: [],
      symlinkSafety: { resolveSymlinks: true, preventTraversal: true },
      plannerArtifactPolicy: { allowedArtifactDirs: [] },
    }
    const resolved = resolveSentinelPolicy(customPolicy, PROJECT_ROOT, RUNTIME_STATE_DIR)

    // System writes should bypass the planner-artifact-only restriction
    const result = canWrite("/tmp/plans/ch42/design.md", {
      policy: resolved,
      projectRoot: PROJECT_ROOT,
      runtimeStateDir: RUNTIME_STATE_DIR,
      intent: "system",
    })
    assert.ok(result.allowed, `system should bypass intent restriction, got: ${result.message}`)
  })
})

// ---------------------------------------------------------------------------
// canWrite — symlink escape for new files
// ---------------------------------------------------------------------------

describe("canWrite with symlinks for non-existent files", () => {
  let tmpDir: string
  let projectDir: string
  let insideSymDir: string
  let outsideSymDir: string
  let outsideDir: string

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-zflow-symlink-test-"))
    projectDir = path.join(tmpDir, "project")
    insideSymDir = path.join(projectDir, "link-inside")
    outsideDir = path.join(tmpDir, "outside-target")
    outsideSymDir = path.join(projectDir, "link-outside")

    // Create project structure
    fs.mkdirSync(path.join(projectDir, "src"), { recursive: true })
    fs.writeFileSync(path.join(projectDir, "README.md"), "test", "utf-8")

    // Create an outside target
    fs.mkdirSync(outsideDir, { recursive: true })
    fs.writeFileSync(path.join(outsideDir, "secrets.txt"), "secret", "utf-8")

    // Create symlinks
    fs.mkdirSync(path.join(projectDir, "sublinked"))
    fs.writeFileSync(path.join(projectDir, "sublinked", "data.txt"), "inside data", "utf-8")
    fs.symlinkSync(path.join(projectDir, "sublinked"), insideSymDir, "dir")
    fs.symlinkSync(outsideDir, outsideSymDir, "dir")
  })

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test("blocks write to new file under symlinked dir pointing outside project root", () => {
    const customPolicy: SentinelPolicy = {
      description: "symlink test",
      allowedRoots: [
        { path: projectDir, label: "project", allowIntent: "implementation" },
      ],
      blockedPatterns: [],
      symlinkSafety: { resolveSymlinks: true, preventTraversal: true },
      plannerArtifactPolicy: { allowedArtifactDirs: [] },
    }
    const resolved = resolveSentinelPolicy(customPolicy, projectDir, RUNTIME_STATE_DIR)
    const newFilePath = path.join(outsideSymDir, "new-malicious-file.txt")

    // The symlinked dir points outside project root, so writing a new file there should be blocked
    const result = canWrite(newFilePath, {
      policy: resolved,
      projectRoot: projectDir,
      runtimeStateDir: RUNTIME_STATE_DIR,
      intent: "implementation",
    })
    assert.ok(!result.allowed, `expected blocked, got: ${result.message}`)
    assert.equal(result.reason, "outside-allowed-roots",
      `expected outside-allowed-roots, got: ${result.reason}`)
  })

  test("allows write to new file under symlinked dir pointing inside project root", () => {
    const customPolicy: SentinelPolicy = {
      description: "symlink test",
      allowedRoots: [
        { path: projectDir, label: "project", allowIntent: "implementation" },
      ],
      blockedPatterns: [],
      symlinkSafety: { resolveSymlinks: true, preventTraversal: true },
      plannerArtifactPolicy: { allowedArtifactDirs: [] },
    }
    const resolved = resolveSentinelPolicy(customPolicy, projectDir, RUNTIME_STATE_DIR)
    const newFilePath = path.join(insideSymDir, "new-allowed-file.txt")

    const result = canWrite(newFilePath, {
      policy: resolved,
      projectRoot: projectDir,
      runtimeStateDir: RUNTIME_STATE_DIR,
      intent: "implementation",
    })
    assert.ok(result.allowed, `expected allowed, got: ${result.message}`)
  })
})

// ---------------------------------------------------------------------------
// resolveSentinelPolicy integration
// ---------------------------------------------------------------------------

describe("resolveSentinelPolicy", () => {
  test("resolves default policy with runtime state dir substituted", () => {
    const resolved = resolveSentinelPolicy({}, PROJECT_ROOT, RUNTIME_STATE_DIR)
    assert.ok(resolved.allowedRoots.length > 0)
    assert.ok(resolved.plannerArtifactPolicy.allowedArtifactDirs.length > 0)

    // Check that <runtime-state-dir> placeholders are resolved
    for (const dir of resolved.plannerArtifactPolicy.allowedArtifactDirs) {
      assert.ok(!dir.includes("<runtime-state-dir>"), `unresolved placeholder in: ${dir}`)
    }
  })

  test("includes runtime state dir in resolved allowed roots", () => {
    const resolved = resolveSentinelPolicy({}, PROJECT_ROOT, RUNTIME_STATE_DIR)
    const found = resolved.allowedRoots.some(
      (r) => r.path === RUNTIME_STATE_DIR || r.path.startsWith(RUNTIME_STATE_DIR),
    )
    assert.ok(found, `runtime state dir ${RUNTIME_STATE_DIR} should be in allowed roots`)
  })

  test("includes runtime state dir in resolved allowed roots for temp fallback", () => {
    const resolved = resolveSentinelPolicy({}, PROJECT_ROOT, TEMP_FALLBACK)
    const found = resolved.allowedRoots.some(
      (r) => r.path === TEMP_FALLBACK || r.path.startsWith(TEMP_FALLBACK),
    )
    assert.ok(found, `temp fallback ${TEMP_FALLBACK} should be in allowed roots`)
  })

  test("merges user overrides correctly", () => {
    const override: Partial<SentinelPolicy> = {
      description: "custom policy",
      allowedRoots: [
        { path: "/custom/root", label: "custom" },
      ],
    }
    const resolved = resolveSentinelPolicy(override, PROJECT_ROOT, RUNTIME_STATE_DIR)
    assert.equal(resolved.description, "custom policy")
    // Should include custom root and runtime state roots
    const hasCustom = resolved.allowedRoots.some((r) => r.path === "/custom/root")
    assert.ok(hasCustom, "custom root should be present")
    const hasRuntime = resolved.allowedRoots.some(
      (r) => r.path === RUNTIME_STATE_DIR || r.path.startsWith(RUNTIME_STATE_DIR),
    )
    assert.ok(hasRuntime, "runtime state dir should be present even with custom roots")
  })
})
