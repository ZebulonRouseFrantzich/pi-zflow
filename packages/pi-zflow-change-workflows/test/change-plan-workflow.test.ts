/**
 * change-plan-workflow.test.ts — Tests for `/zflow-change-plan` orchestration.
 */
import * as assert from "node:assert"
import { describe, test, afterEach } from "node:test"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { execFileSync } from "node:child_process"

import {
  runChangePlanWorkflow,
  readDurablePlanDoc,
  scaffoldDurablePlanDocBody,
  writeDurablePlanDoc,
} from "../extensions/zflow-change-workflows/orchestration.js"

import { getZflowRegistry, resetZflowRegistry } from "pi-zflow-core/registry"
import { DISPATCH_SERVICE_CAPABILITY } from "pi-zflow-core/dispatch-service"

async function createTestRepo(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-test-change-plan-"))
  execFileSync("git", ["init"], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  await fs.mkdir(path.join(tmpDir, "src"), { recursive: true })
  await fs.writeFile(path.join(tmpDir, "README.md"), "# Test Repo\n\nRepository for change-plan workflow tests.\n", "utf-8")
  await fs.writeFile(path.join(tmpDir, "src", "entitlements.ts"), "export function readOnlyEntitlements() { return [] }\n", "utf-8")
  await fs.writeFile(path.join(tmpDir, "package.json"), JSON.stringify({ name: "test-repo", scripts: { test: "node --test" } }, null, 2), "utf-8")
  execFileSync("git", ["add", "."], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  return tmpDir
}

afterEach(() => {
  resetZflowRegistry()
})

describe("runChangePlanWorkflow", () => {
  test("creates a detailed durable plan.md from dispatched planner output", async () => {
    const repoRoot = await createTestRepo()
    let receivedTask = ""
    try {
      const registry = getZflowRegistry()
      registry.claim({
        capability: DISPATCH_SERVICE_CAPABILITY,
        version: "0.1.0",
        provider: "test-dispatch",
        sourcePath: import.meta.url,
      })
      registry.provide(DISPATCH_SERVICE_CAPABILITY, {
        name: "test-dispatch",
        runAgent: async (input: any) => {
          receivedTask = input.task
          const body = [
            "```markdown",
            "## Summary",
            "",
            "Deliver a durable reviewed plan.md for a read-only Oracle and MSSQL entitlements change.",
            "",
            "## Goals / Success Criteria",
            "",
            "- Capture one detailed durable plan.md.",
            "- Keep versioned prepared docs immutable.",
            "",
            "## Scope In",
            "",
            "- Planning workflow changes for durable change docs.",
            "",
            "## Scope Out",
            "",
            "- Source-code implementation of the business change.",
            "",
            "## Relevant codebase areas",
            "",
            "- src/entitlements.ts",
            "- docs/zflow-changes/oracle-mssql-entitlements-readonly/plan.md",
            "",
            "## Constraints",
            "",
            "- Keep .zflow as runtime-only state.",
            "- Keep plan.md human-reviewable.",
            "",
            "## Decisions",
            "",
            "- Draft plan.md first, then compile versioned artifacts during prepare.",
            "",
            "## Risks / Unknowns",
            "",
            "- The planner must preserve stable section headings for downstream validation.",
            "",
            "## Proposed execution outline",
            "",
            "1. Inspect the repo map and reconnaissance.\n2. Draft the durable plan.md.\n3. Review the durable plan.md.\n4. Prepare versioned artifacts.",
            "",
            "## Verification approach",
            "",
            "- Run targeted change-plan and prepare tests.\n- Review the generated plan.md for scope correctness.",
            "",
            "## Open questions",
            "",
            "- None.",
            "```",
          ].join("\n")

          if (typeof input.output === "string") {
            await fs.mkdir(path.dirname(input.output), { recursive: true })
            await fs.writeFile(input.output, body, "utf-8")
          }

          return { ok: true, rawOutput: "", outputPath: input.output }
        },
        runParallel: async () => ({ ok: true, results: [] }),
      })
      registry.claim({
        capability: "profiles",
        version: "0.1.0",
        provider: "test-profiles",
        sourcePath: import.meta.url,
      })
      registry.provide("profiles", {
        getResolvedAgentBinding: async () => ({ resolvedModel: "openai-codex/gpt-5.4" }),
      })

      const result = await runChangePlanWorkflow({
        cwd: repoRoot,
        changeId: "oracle-mssql-entitlements-readonly",
        changeSeed: "oracle mssql entitlements readonly",
        changeDescription: "Draft a durable plan for a read-only Oracle and MSSQL entitlements change.",
      })

      assert.match(receivedTask, /Return ONLY markdown for the `plan.md` body/)
      assert.match(receivedTask, /## Goals \/ Success Criteria/)
      assert.ok(result.planDocPath.endsWith(path.join("docs", "zflow-changes", "oracle-mssql-entitlements-readonly", "plan.md")))

      const doc = await readDurablePlanDoc("oracle-mssql-entitlements-readonly", { repoRoot })
      assert.equal(doc?.frontmatter.changeId, "oracle-mssql-entitlements-readonly")
      assert.deepEqual(doc?.validationErrors, [])
      assert.deepEqual(doc?.bodyValidationErrors, [])
      assert.ok(doc?.body.includes("## Relevant codebase areas"))
      assert.ok(doc?.body.includes("src/entitlements.ts"))
      assert.ok(!doc?.body.includes("_Describe the change, why it is needed, and what it accomplishes._"))
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })

  test("replaces scaffold-only free content with drafted detail", async () => {
    const repoRoot = await createTestRepo()
    try {
      await writeDurablePlanDoc("replace-scaffold", {
        changeId: "replace-scaffold",
      }, {
        repoRoot,
        draftNotes: "Initial scaffold note",
      })

      const registry = getZflowRegistry()
      registry.claim({
        capability: DISPATCH_SERVICE_CAPABILITY,
        version: "0.1.0",
        provider: "test-dispatch",
        sourcePath: import.meta.url,
      })
      registry.provide(DISPATCH_SERVICE_CAPABILITY, {
        name: "test-dispatch",
        runAgent: async (input: any) => {
          const body = scaffoldDurablePlanDocBody("replace-scaffold")
            .replace("_Describe the change, why it is needed, and what it accomplishes._", "Replace scaffold content with a detailed durable planning narrative.")
            .replace("_List the desired outcomes, user-visible success criteria, and technical completion checks._", "- Produce a reviewable durable plan.md.\n- Prepare versioned docs from it later.")
            .replace("_What is included in this change._", "- Durable planning workflow updates.")
            .replace("_What is explicitly excluded._", "- Product implementation work.")
            .replace("_Files, modules, services, docs, and neighboring systems that should be inspected or are likely to change._", "- packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/index.ts")
            .replace("_Technical, architectural, or process constraints._", "- Keep .zflow runtime-only.")
            .replace("_Key decisions and trade-offs made during planning._", "- plan.md becomes the reviewed intake document.")
            .replace("_Known risks, open questions, and dependencies._", "- Draft quality depends on repository reconnaissance.")
            .replace("_High-level execution approach, groups, and order._", "1. Inspect repo context.\n2. Draft plan.md.\n3. Review plan.md.\n4. Prepare artifacts.")
            .replace("_Concrete commands, focused tests, manual checks, and pass/fail expectations._", "- Run targeted change-workflow tests.")
            .replace("_Any remaining user decisions or unresolved assumptions that could materially change the plan._", "- None.")

          if (typeof input.output === "string") {
            await fs.mkdir(path.dirname(input.output), { recursive: true })
            await fs.writeFile(input.output, body, "utf-8")
          }
          return { ok: true, rawOutput: "", outputPath: input.output }
        },
        runParallel: async () => ({ ok: true, results: [] }),
      })

      await runChangePlanWorkflow({
        cwd: repoRoot,
        changeId: "replace-scaffold",
        changeSeed: "replace scaffold",
        changeDescription: "Replace scaffold with a detailed durable plan.",
      })

      const doc = await readDurablePlanDoc("replace-scaffold", { repoRoot })
      assert.ok(doc?.body.includes("Replace scaffold content with a detailed durable planning narrative."))
      assert.ok(!doc?.body.includes("Initial scaffold note"))
      assert.deepEqual(doc?.bodyValidationErrors, [])
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })
})
