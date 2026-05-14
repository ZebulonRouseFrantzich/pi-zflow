/**
 * reread-policy.test.ts — Tests for the reread policy module.
 *
 * @module pi-zflow-compaction/test/reread-policy
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

/**
 * Import the module fresh for each test.
 */
async function importModule(cacheBust: string) {
  return import(`../src/reread-policy.js?cache=${cacheBust}`)
}

// ── Tests ───────────────────────────────────────────────────────

describe("reread-policy", () => {
  it("CANONICAL_ARTIFACTS has expected entries", async () => {
    const mod = await importModule("entries")
    const artifacts = mod.CANONICAL_ARTIFACTS

    assert.ok(Array.isArray(artifacts))
    assert.ok(artifacts.length >= 5, "Should have at least 5 artifact entries")

    // Check that key artifacts exist
    const ids = artifacts.map((a: { id: string }) => a.id)
    assert.ok(ids.includes("plan-state"), "Should include plan-state")
    assert.ok(ids.includes("approved-plan"), "Should include approved-plan")
    assert.ok(ids.includes("repo-map"), "Should include repo-map")
    assert.ok(ids.includes("reconnaissance"), "Should include reconnaissance")
    assert.ok(ids.includes("failure-log"), "Should include failure-log")

    // Check that each entry has required fields
    for (const entry of artifacts) {
      assert.equal(typeof entry.id, "string", "id should be a string")
      assert.equal(typeof entry.path, "string", "path should be a string")
      assert.equal(typeof entry.description, "string", "description should be a string")
      assert.equal(typeof entry.mandatory, "boolean", "mandatory should be a boolean")
    }
  })

  it("getMandatoryRereads returns only mandatory artifacts", async () => {
    const mod = await importModule("mandatory")
    const mandatory = mod.getMandatoryRereads()

    assert.ok(Array.isArray(mandatory))
    assert.ok(mandatory.length > 0, "Should have at least one mandatory artifact")
    assert.ok(mandatory.length < 7, "Should not include all artifacts")

    // Every returned artifact should be mandatory
    for (const entry of mandatory) {
      assert.equal(entry.mandatory, true, "Every returned entry should be mandatory")
    }

    // Mandatory should include core artifacts
    const ids = mandatory.map((a: { id: string }) => a.id)
    assert.ok(ids.includes("plan-state"))
    assert.ok(ids.includes("repo-map"))
    assert.ok(ids.includes("failure-log"))

    // Mandatory should NOT include optional artifacts
    assert.ok(!ids.includes("findings"), "findings is not mandatory")
    assert.ok(!ids.includes("workflow-state"), "workflow-state is not mandatory")
  })

  it('getRereadsForRole("planner") includes plan artifacts', async () => {
    const mod = await importModule("planner")
    const forPlanner = mod.getRereadsForRole("planner")

    // Planner gets mandatory artifacts + optional based on role
    const ids = forPlanner.map((a: { id: string }) => a.id)
    assert.ok(ids.includes("plan-state"), "Planner should include plan-state")
    assert.ok(ids.includes("approved-plan"), "Planner should include approved-plan")
    assert.ok(ids.includes("repo-map"), "Planner should include repo-map")

    // Planner should NOT include reviewer-specific artifacts
    assert.ok(!ids.includes("findings"), "Planner should not include findings")
  })

  it('getRereadsForRole("reviewer") includes findings', async () => {
    const mod = await importModule("reviewer")
    const forReviewer = mod.getRereadsForRole("reviewer")

    const ids = forReviewer.map((a: { id: string }) => a.id)
    assert.ok(ids.includes("findings"), "Reviewer should include findings")
    assert.ok(ids.includes("failure-log"), "Reviewer should include failure-log")
  })

  it('getRereadsForRole("synthesizer") includes findings', async () => {
    const mod = await importModule("synthesizer")
    const forSynth = mod.getRereadsForRole("synthesizer")

    const ids = forSynth.map((a: { id: string }) => a.id)
    assert.ok(ids.includes("findings"), "Synthesizer should include findings")
  })

  it('getRereadsForRole("zflow.synthesizer") namespaced name includes findings', async () => {
    const mod = await importModule("ns-synth")
    const forSynth = mod.getRereadsForRole("zflow.synthesizer")

    const ids = forSynth.map((a: { id: string }) => a.id)
    assert.ok(ids.includes("findings"), "Namespaced synthesizer should include findings")
  })

  it('getRereadsForRole("zflow.synthesizer-summarize") namespaced variant includes findings', async () => {
    const mod = await importModule("ns-synth-sum")
    const forSynth = mod.getRereadsForRole("zflow.synthesizer-summarize")

    const ids = forSynth.map((a: { id: string }) => a.id)
    assert.ok(ids.includes("findings"), "Namespaced synthesizer-summarize should include findings")
  })

  it('getRereadsForRole("orchestrator") includes workflow-state', async () => {
    const mod = await importModule("orchestrator")
    const forOrch = mod.getRereadsForRole("orchestrator")

    const ids = forOrch.map((a: { id: string }) => a.id)
    assert.ok(ids.includes("workflow-state"), "Orchestrator should include workflow-state")
    assert.ok(ids.includes("plan-state"), "Orchestrator should include plan-state")
  })

  it('getRereadsForRole("change-implement") includes workflow-state', async () => {
    const mod = await importModule("impl")
    const forImpl = mod.getRereadsForRole("change-implement")

    const ids = forImpl.map((a: { id: string }) => a.id)
    assert.ok(ids.includes("workflow-state"), "Change-implement should include workflow-state")
    assert.ok(ids.includes("failure-log"), "Change-implement should include failure-log")
  })

  it("formatRereadReminder produces a string with key artifact names", async () => {
    const mod = await importModule("reminder")
    const reminder = mod.formatRereadReminder()

    assert.equal(typeof reminder, "string")
    assert.ok(reminder.length > 50, "Reminder should be substantial")

    // Should mention key artifact types
    assert.ok(
      reminder.includes("plan-state.json"),
      "Should reference plan-state.json",
    )
    assert.ok(
      reminder.includes("repo-map.md"),
      "Should reference repo-map.md",
    )
    assert.ok(
      reminder.includes("failure-log.md"),
      "Should reference failure-log.md",
    )

    // Should include mandatory/optional sections
    assert.ok(
      reminder.includes("Mandatory rereads"),
      "Should include mandatory rereads section",
    )
    assert.ok(
      reminder.includes("Optional rereads"),
      "Should include optional rereads section",
    )
  })

  it("formatRereadReminder with custom artifacts produces targeted reminder", async () => {
    const mod = await importModule("custom")
    const { getMandatoryRereads } = mod
    const mandatory = getMandatoryRereads()

    // Format with only mandatory artifacts
    const reminder = mod.formatRereadReminder(mandatory)

    assert.ok(
      reminder.includes("Mandatory rereads"),
      "Should include mandatory rereads section",
    )
    assert.ok(
      !reminder.includes("Optional rereads"),
      "Should NOT include optional rereads section when only mandatory given",
    )
  })

  it("formatRereadReminder with empty array returns safe fallback", async () => {
    const mod = await importModule("empty")
    const reminder = mod.formatRereadReminder([])

    assert.equal(typeof reminder, "string")
    assert.ok(
      reminder.includes("No canonical artifacts"),
      "Should indicate no artifacts are tracked",
    )
  })

  it('buildCompactionHandoffSection with namespaced "zflow.synthesizer" agent includes findings in output', async () => {
    const mod = await importModule("handoff-synth")
    const output = await mod.buildCompactionHandoffSection("zflow.synthesizer")

    assert.equal(typeof output, "string")
    assert.ok(output.startsWith("## Compaction Handoff"), "Should start with handoff heading")
    // The role-specific reread reminder should reference findings.md for synthesizer role
    assert.ok(
      output.includes("findings.md"),
      "Should include findings.md in reminder for namespaced synthesizer agent",
    )
  })

  it('buildCompactionHandoffSection with namespaced "builtin:synthesizer" agent includes findings in output', async () => {
    const mod = await importModule("handoff-builtin-synth")
    const output = await mod.buildCompactionHandoffSection("builtin:synthesizer")

    assert.equal(typeof output, "string")
    assert.ok(output.startsWith("## Compaction Handoff"), "Should start with handoff heading")
    assert.ok(
      output.includes("findings.md"),
      "Should include findings.md in reminder for builtin:synthesizer agent",
    )
  })
})
