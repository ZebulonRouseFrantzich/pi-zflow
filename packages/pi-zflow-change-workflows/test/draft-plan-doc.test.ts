/**
 * draft-plan-doc.test.ts — Unit tests for durable draft-plan (plan.md) helpers.
 */
import * as assert from "node:assert"
import { test, describe } from "node:test"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { execFileSync } from "node:child_process"

import {
  parsePlanDocFrontmatter,
  serializePlanDoc,
  scaffoldDurablePlanDocBody,
  extractPlanDocSections,
  buildPlanDocVersionIndexSection,
  writeDurablePlanDoc,
  readDurablePlanDoc,
  publishPlanArtifacts,
  resolveDurablePlanDocPath,
  resolveChangeImplementTarget,
  validateDurablePlanDocFrontmatter,
  validateDurablePlanDocBody,
  listPublishedDurablePlanVersions,
  buildPrepareNotesFromDurablePlanDoc,
} from "../extensions/zflow-change-workflows/orchestration.js"

const COMPLETE_PLAN_BODY = [
  "## Summary",
  "",
  "Draft a durable plan.md that captures a read-only Oracle and MSSQL entitlements change.",
  "",
  "## Goals / Success Criteria",
  "",
  "- Keep one reviewed durable plan.md.",
  "- Compile versioned docs during prepare.",
  "",
  "## Scope In",
  "",
  "- Durable planning workflow changes.",
  "",
  "## Scope Out",
  "",
  "- Source implementation for the target product change.",
  "",
  "## Relevant codebase areas",
  "",
  "- packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/orchestration.ts",
  "- packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/index.ts",
  "",
  "## Constraints",
  "",
  "- Keep .zflow runtime-only.",
  "",
  "## Decisions",
  "",
  "- plan.md is the reviewed intake doc.",
  "",
  "## Risks / Unknowns",
  "",
  "- The drafter must emit stable headings and concrete file references.",
  "",
  "## Proposed execution outline",
  "",
  "1. Explore the repo.\n2. Draft plan.md.\n3. Review plan.md.\n4. Prepare versioned docs.",
  "",
  "## Verification approach",
  "",
  "- Run targeted durable-plan and prepare tests.",
  "",
  "## Open questions",
  "",
  "- None.",
].join("\n")

async function createTestRepo(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-draft-plan-"))
  execFileSync("git", ["init"], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  await fs.writeFile(path.join(tmpDir, "README.md"), "# Test", "utf-8")
  execFileSync("git", ["add", "."], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  return tmpDir
}

async function writeRuntimePlanArtifacts(
  runtimeStateDir: string,
  changeId: string,
  planVersion: string,
): Promise<void> {
  const versionDir = path.join(runtimeStateDir, "plans", changeId, planVersion)
  await fs.mkdir(versionDir, { recursive: true })

  const content: Record<string, string> = {
    "design.md": "# Design\n\nTest design document.",
    "execution-groups.md": "# Execution Groups\n\nTest execution groups.",
    "standards.md": "# Standards\n\nTest standards document.",
    "verification.md": "# Verification\n\nTest verification plan.",
    "implementation-tasks.md": "# Implementation Tasks\n\n## Group 1: Test\n\n### Objective\nTest implementation",
  }

  for (const [fileName, fileContent] of Object.entries(content)) {
    await fs.writeFile(path.join(versionDir, fileName), fileContent, "utf-8")
  }
}

describe("parsePlanDocFrontmatter", () => {
  test("parses flat key:value frontmatter", () => {
    const content = [
      "---",
      "schemaVersion: 1",
      "changeId: my-change",
      "status: draft",
      "sourceMode: adhoc",
      "currentVersion: null",
      "approvedVersion: null",
      "---",
      "# Plan",
      "",
      "Body content.",
    ].join("\n")

    const { frontmatter, body } = parsePlanDocFrontmatter(content)
    assert.equal(frontmatter.schemaVersion, "1")
    assert.equal(frontmatter.changeId, "my-change")
    assert.equal(frontmatter.status, "draft")
    assert.equal(frontmatter.sourceMode, "adhoc")
    assert.equal(frontmatter.currentVersion, null)
    assert.equal(frontmatter.approvedVersion, null)
    assert.ok(body.startsWith("# Plan"))
  })

  test("returns empty frontmatter when no leading delimiter exists", () => {
    const { frontmatter, body } = parsePlanDocFrontmatter("# Plan\n\nNo frontmatter.\n")
    assert.deepEqual(frontmatter, {})
    assert.equal(body, "# Plan\n\nNo frontmatter.\n")
  })
})

describe("serializePlanDoc", () => {
  test("round-trips frontmatter and body", () => {
    const serialized = serializePlanDoc({ changeId: "test", currentVersion: null }, "# Summary\n\nBody")
    const { frontmatter, body } = parsePlanDocFrontmatter(serialized)
    assert.equal(frontmatter.changeId, "test")
    assert.equal(frontmatter.currentVersion, null)
    assert.ok(body.includes("# Summary"))
  })
})

describe("scaffoldDurablePlanDocBody", () => {
  test("produces expected managed sections", () => {
    const body = scaffoldDurablePlanDocBody("my-change")
    assert.ok(body.includes("zflow-managed: header"))
    assert.ok(body.includes("zflow-managed: version-index"))
    assert.ok(body.includes("## Summary"))
    assert.ok(body.includes("## Scope In"))
  })

  test("injects draft notes into the summary section", () => {
    const body = scaffoldDurablePlanDocBody("my-change", "Draft the Oracle and MSSQL read-only surface")
    assert.ok(body.includes("Draft the Oracle and MSSQL read-only surface"))
    assert.ok(!body.includes("_Describe the change, why it is needed, and what it accomplishes._"))
  })
})

describe("extractPlanDocSections", () => {
  test("extracts managed and free sections", () => {
    const body = [
      "<!-- zflow-managed: header -->",
      "> Header content.",
      "<!-- /zflow-managed -->",
      "",
      "## Free section",
      "",
      "User content here.",
      "",
      "<!-- zflow-managed: version-index -->",
      "## Published versions",
      "",
      "- [v1](./v1/)",
      "<!-- /zflow-managed -->",
    ].join("\n")

    const sections = extractPlanDocSections(body)
    assert.ok(sections.get("header")?.includes("Header content."))
    assert.ok(sections.get("version-index")?.includes("[v1]"))
    assert.ok(sections.get("__free__")?.includes("## Free section"))
  })
})

describe("buildPlanDocVersionIndexSection", () => {
  test("renders version links", () => {
    const section = buildPlanDocVersionIndexSection(["v2", "v1"])
    assert.ok(section.includes("[v2](./v2/)"))
    assert.ok(section.includes("[v1](./v1/)"))
  })
})

describe("writeDurablePlanDoc / readDurablePlanDoc", () => {
  test("creates plan.md from scratch with scaffold body", async () => {
    const repoRoot = await createTestRepo()
    try {
      const planDocPath = await writeDurablePlanDoc("test-change", {
        changeId: "test-change",
        status: "draft",
        sourceMode: "adhoc",
      }, { repoRoot })

      const content = await fs.readFile(planDocPath, "utf-8")
      assert.ok(content.includes("changeId: test-change"))
      assert.ok(content.includes("status: draft"))
      assert.ok(content.includes("## Summary"))
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })

  test("stores draft notes in the body without inflating frontmatter", async () => {
    const repoRoot = await createTestRepo()
    try {
      await writeDurablePlanDoc("notes-test", {
        changeId: "notes-test",
      }, { repoRoot, draftNotes: "Capture the initial Oracle read-only API scope" })

      const doc = await readDurablePlanDoc("notes-test", { repoRoot })
      assert.equal(doc?.frontmatter.requestNotes, undefined)
      assert.ok(doc?.body.includes("Capture the initial Oracle read-only API scope"))
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })

  test("adds RuneContext canonical guidance when sourceMode is runecontext", async () => {
    const repoRoot = await createTestRepo()
    try {
      await writeDurablePlanDoc("runecontext-test", {
        changeId: "runecontext-test",
        sourceMode: "runecontext",
      }, { repoRoot })

      const doc = await readDurablePlanDoc("runecontext-test", { repoRoot })
      assert.ok(doc?.body.includes("RuneContext documents remain the canonical source of truth"))
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })

  test("preserves published version index when updating status without passing versions", async () => {
    const repoRoot = await createTestRepo()
    try {
      await writeDurablePlanDoc("preserve-versions", {
        changeId: "preserve-versions",
        currentVersion: "v2",
      }, { repoRoot, publishedVersions: ["v2", "v1"] })

      await writeDurablePlanDoc("preserve-versions", {
        status: "approved",
        approvedVersion: "v2",
      }, { repoRoot })

      const doc = await readDurablePlanDoc("preserve-versions", { repoRoot })
      assert.equal(doc?.frontmatter.status, "approved")
      assert.equal(doc?.frontmatter.approvedVersion, "v2")
      assert.ok(doc?.body.includes("[v2]"))
      assert.ok(doc?.body.includes("[v1]"))
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })
})

describe("publishPlanArtifacts plan.md integration", () => {
  test("creates sibling plan.md when publishing versioned artifacts", async () => {
    const repoRoot = await createTestRepo()
    try {
      const runtimeStateDir = path.join(repoRoot, ".zflow")
      await writeRuntimePlanArtifacts(runtimeStateDir, "integration-test", "v1")

      const result = await publishPlanArtifacts("integration-test", "v1", {
        cwd: repoRoot,
        runtimeStateDir,
      })

      const planDocPath = path.join(path.dirname(result.durableDir), "plan.md")
      const content = await fs.readFile(planDocPath, "utf-8")
      assert.ok(content.includes("changeId: integration-test"))
      assert.ok(content.includes("currentVersion: v1"))
      assert.ok(content.includes("[v1]"))
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })
})

describe("validateDurablePlanDocFrontmatter", () => {
  test("rejects invalid schema and version values", () => {
    const errors = validateDurablePlanDocFrontmatter({
      schemaVersion: 2,
      changeId: "Bad Change",
      status: "bogus",
      sourceMode: "other",
      currentVersion: "version-one",
      approvedVersion: 5,
    }, "good-change")

    assert.ok(errors.some((error) => error.includes("schemaVersion must be 1")))
    assert.ok(errors.some((error) => error.includes("changeId")))
    assert.ok(errors.some((error) => error.includes("status must be one of")))
    assert.ok(errors.some((error) => error.includes("sourceMode must be one of")))
    assert.ok(errors.some((error) => error.includes("currentVersion")))
    assert.ok(errors.some((error) => error.includes("approvedVersion")))
  })
})

describe("validateDurablePlanDocBody", () => {
  test("rejects scaffold placeholder bodies", () => {
    const errors = validateDurablePlanDocBody(scaffoldDurablePlanDocBody("scaffold-test"))
    assert.ok(errors.some((error) => error.includes("placeholder")))
  })

  test("accepts detailed plan bodies", () => {
    const errors = validateDurablePlanDocBody(COMPLETE_PLAN_BODY)
    assert.deepEqual(errors, [])
  })
})

describe("buildPrepareNotesFromDurablePlanDoc", () => {
  test("combines durable draft context with existing notes", async () => {
    const repoRoot = await createTestRepo()
    try {
      await writeDurablePlanDoc("prepare-notes", {
        changeId: "prepare-notes",
        status: "draft",
      }, { repoRoot, bodyContent: COMPLETE_PLAN_BODY })
      const doc = await readDurablePlanDoc("prepare-notes", { repoRoot })
      const notes = buildPrepareNotesFromDurablePlanDoc(doc, "manual note")
      assert.ok(notes.includes("manual note"))
      assert.ok(notes.includes("Durable draft plan.md path:"))
      assert.ok(notes.includes("Draft a durable plan.md that captures a read-only Oracle and MSSQL entitlements change."))
      assert.ok(!notes.includes("Durable draft frontmatter validation errors:"))
      assert.ok(!notes.includes("Durable draft body validation errors:"))
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })

  test("includes RuneContext and validation guidance when relevant", async () => {
    const repoRoot = await createTestRepo()
    try {
      const planDocPath = path.join(repoRoot, "docs", "zflow-changes", "invalid-rune", "plan.md")
      await fs.mkdir(path.dirname(planDocPath), { recursive: true })
      await fs.writeFile(planDocPath, [
        "---",
        "schemaVersion: 2",
        "changeId: invalid-rune",
        "status: draft",
        "sourceMode: runecontext",
        "currentVersion: vX",
        "approvedVersion: null",
        "---",
        "# Plan",
      ].join("\n"), "utf-8")

      const doc = await readDurablePlanDoc("invalid-rune", { repoRoot })
      const notes = buildPrepareNotesFromDurablePlanDoc(doc, undefined)
      assert.ok(notes.includes("RuneContext note:"))
      assert.ok(notes.includes("Durable draft frontmatter validation errors:"))
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })
})

describe("listPublishedDurablePlanVersions", () => {
  test("lists version directories newest first", async () => {
    const repoRoot = await createTestRepo()
    try {
      const baseDir = path.join(repoRoot, "docs", "zflow-changes", "version-list-test")
      await fs.mkdir(path.join(baseDir, "v1"), { recursive: true })
      await fs.mkdir(path.join(baseDir, "v3"), { recursive: true })
      await fs.mkdir(path.join(baseDir, "v2"), { recursive: true })
      const versions = await listPublishedDurablePlanVersions("version-list-test", { repoRoot })
      assert.deepEqual(versions, ["v3", "v2", "v1"])
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })
})

describe("resolveChangeImplementTarget with plan.md", () => {
  test("resolves change ID from plan.md path when manifest exists", async () => {
    const repoRoot = await createTestRepo()
    try {
      const runtimeStateDir = path.join(repoRoot, ".zflow")
      const runtimeChangeId = "docs-change-ideas-cl-mphn61g6"
      const durableChangeId = "cloudflare-target-architecture"
      const planVersion = "v1"

      await writeRuntimePlanArtifacts(runtimeStateDir, runtimeChangeId, planVersion)
      await fs.writeFile(
        path.join(runtimeStateDir, "plans", runtimeChangeId, "plan-state.json"),
        JSON.stringify({ changeId: runtimeChangeId, approvedVersion: planVersion }, null, 2),
        "utf-8",
      )

      const result = await publishPlanArtifacts(runtimeChangeId, planVersion, {
        cwd: repoRoot,
        runtimeStateDir,
      })
      const durableDir = path.join(repoRoot, "docs", "zflow-changes", durableChangeId, planVersion)
      await fs.mkdir(path.dirname(durableDir), { recursive: true })
      await fs.rename(result.durableDir, durableDir)
      await fs.rm(path.dirname(result.durableDir), { recursive: true, force: true })
      const manifestPath = path.join(durableDir, "manifest.json")
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"))
      manifest.changeId = durableChangeId
      manifest.previousRuntimeChangeId = runtimeChangeId
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8")

      const fromPlanDoc = await resolveChangeImplementTarget(`docs/zflow-changes/${durableChangeId}/plan.md`, repoRoot)
      assert.equal(fromPlanDoc.changeId, runtimeChangeId)
      assert.equal(fromPlanDoc.durableChangeId, durableChangeId)
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })
})

describe("resolveDurablePlanDocPath", () => {
  test("resolves to the expected path", async () => {
    const resolved = await resolveDurablePlanDocPath("test-change", "/repo/root")
    assert.ok(resolved.endsWith(path.join("docs", "zflow-changes", "test-change", "plan.md")))
  })
})
