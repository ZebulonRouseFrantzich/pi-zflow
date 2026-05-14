/**
 * long-session-scenarios.test.ts — Validation test for the long-session
 * smoke test document (Task 8.16).
 *
 * Verifies that docs/long-session-smoke-tests.md exists and documents
 * all six required compaction/context-management validation scenarios.
 *
 * @module pi-zflow-compaction/test/long-session-scenarios
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"

const __filename = new URL(import.meta.url).pathname
const __dirname = path.dirname(__filename)

/**
 * Resolve the smoke test document path relative to this test file.
 */
function resolveSmokeTestDoc(): string {
  return path.resolve(__dirname, "../../../docs/long-session-smoke-tests.md")
}

describe("long-session smoke test scenarios", () => {
  it("smoke test document exists and has substantial content", async () => {
    const docPath = resolveSmokeTestDoc()
    const content = await fs.readFile(docPath, "utf-8")
    assert.ok(content.length > 500, "document has substantial content")
  })

  it("documents compaction scenario (Scenario 1)", async () => {
    const docPath = resolveSmokeTestDoc()
    const content = await fs.readFile(docPath, "utf-8")
    assert.ok(content.toLowerCase().includes("compaction"), "mentions compaction")
    assert.ok(
      content.includes("60%") || content.includes("0.6"),
      "mentions 60% usage threshold",
    )
    assert.ok(
      content.includes("handoff"),
      "mentions compaction handoff reminder",
    )
  })

  it("documents maxOutput bounded output scenario (Scenario 2)", async () => {
    const docPath = resolveSmokeTestDoc()
    const content = await fs.readFile(docPath, "utf-8")
    assert.ok(content.includes("maxOutput"), "mentions maxOutput")
    assert.ok(
      content.includes("6000") || content.includes("bounded"),
      "mentions output bounds",
    )
  })

  it("documents canonical artifact reread scenario (Scenario 3)", async () => {
    const docPath = resolveSmokeTestDoc()
    const content = await fs.readFile(docPath, "utf-8")
    assert.ok(
      content.includes("reread") || content.includes("re-read"),
      "mentions rereading artifacts",
    )
    assert.ok(content.includes("artifact"), "mentions artifacts")
    assert.ok(
      content.includes("plan-state.json"),
      "mentions plan-state.json as a canonical artifact",
    )
  })

  it("documents missing rtk scenario (Scenario 4)", async () => {
    const docPath = resolveSmokeTestDoc()
    const content = await fs.readFile(docPath, "utf-8")
    assert.ok(content.includes("rtk"), "mentions rtk")
    assert.ok(
      content.includes("Install rtk") || content.includes("missing"),
      "mentions missing rtk or install guidance",
    )
  })

  it("documents context-guard duplicate-read scenario (Scenario 5)", async () => {
    const docPath = resolveSmokeTestDoc()
    const content = await fs.readFile(docPath, "utf-8")
    assert.ok(
      content.includes("duplicate") || content.includes("suppression"),
      "mentions duplicate-read suppression",
    )
    assert.ok(
      content.includes("context-guard") || content.includes("Context guard"),
      "mentions context-guard",
    )
  })

  it("documents review with compacted logs scenario (Scenario 6)", async () => {
    const docPath = resolveSmokeTestDoc()
    const content = await fs.readFile(docPath, "utf-8")
    assert.ok(content.includes("Review") || content.includes("review"), "mentions review")
    assert.ok(
      content.includes("compact") || content.includes("truncat"),
      "mentions compaction or truncation for review",
    )
  })

  it("has a table of contents linking all six scenarios", async () => {
    const docPath = resolveSmokeTestDoc()
    const content = await fs.readFile(docPath, "utf-8")
    assert.ok(content.includes("Scenario 1"), "references Scenario 1")
    assert.ok(content.includes("Scenario 2"), "references Scenario 2")
    assert.ok(content.includes("Scenario 3"), "references Scenario 3")
    assert.ok(content.includes("Scenario 4"), "references Scenario 4")
    assert.ok(content.includes("Scenario 5"), "references Scenario 5")
    assert.ok(content.includes("Scenario 6"), "references Scenario 6")
  })

  it("has a quick validation recipe section", async () => {
    const docPath = resolveSmokeTestDoc()
    const content = await fs.readFile(docPath, "utf-8")
    assert.ok(
      content.includes("Quick Validation") ||
        content.includes("quick validation"),
      "has quick validation recipe",
    )
  })

  it("has a troubleshooting section", async () => {
    const docPath = resolveSmokeTestDoc()
    const content = await fs.readFile(docPath, "utf-8")
    assert.ok(
      content.includes("Troubleshooting"),
      "has troubleshooting section",
    )
  })

  it("document is under 20KB", async () => {
    const docPath = resolveSmokeTestDoc()
    const content = await fs.readFile(docPath, "utf-8")
    assert.ok(
      content.length < 20000,
      `document size ${content.length} bytes is under 20KB`,
    )
  })
})
