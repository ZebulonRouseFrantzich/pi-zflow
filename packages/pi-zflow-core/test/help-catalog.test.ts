/**
 * help-catalog.test.ts — Tests for the library-only help catalog module.
 *
 * Validates types, sort/group helpers, topic lookup, and markdown rendering.
 * Does NOT test Pi extension behavior — that belongs in the umbrella or
 * child-package extension-activation tests.
 */
import * as assert from "node:assert"
import { test, describe } from "node:test"
import {
  sortTopicsByFlow,
  groupTopicsByPackage,
  getTopic,
  renderTopicMarkdown,
  renderAllTopicsMarkdown,
  renderHelpSummary,
} from "../src/help-catalog.js"

import type { ZflowHelpTopic } from "../src/help-catalog.js"

// ── Fixtures ────────────────────────────────────────────────────────

/** Minimal topic factory for tests. */
function topic(overrides: Partial<ZflowHelpTopic> & { id: string }): ZflowHelpTopic {
  return {
    packageName: "test-pkg",
    title: "Test Topic",
    summary: "A test topic for unit tests.",
    commands: [],
    ...overrides,
  }
}

const profilesTopic: ZflowHelpTopic = {
  packageName: "pi-zflow-profiles",
  id: "profiles",
  title: "Profile Management",
  summary: "Load, switch, and validate profiles and lanes.",
  flowOrder: 10,
  flowGuidance: "Start here to configure your active profile before other commands.",
  commands: [
    {
      name: "zflow-profile list",
      usage: "/zflow-profile list",
      description: "List available profiles.",
    },
    {
      name: "zflow-profile switch",
      usage: "/zflow-profile switch <name>",
      description: "Switch to a named profile.",
    },
  ],
  relatedTopics: ["plan-mode"],
}

const planModeTopic: ZflowHelpTopic = {
  packageName: "pi-zflow-plan-mode",
  id: "plan-mode",
  title: "Read-Only Planning Mode",
  summary: "Enter or exit ad-hoc read-only planning mode with restricted tools.",
  flowOrder: 20,
  flowGuidance: "Use after profile setup to plan changes before implementation.",
  commands: [
    {
      name: "zflow-plan",
      usage: "/zflow-plan",
      description: "Show current planning mode status.",
    },
    {
      name: "zflow-plan status",
      usage: "/zflow-plan status",
      description: "Detailed planning mode status.",
    },
  ],
}

const agentsTopic: ZflowHelpTopic = {
  packageName: "pi-zflow-agents",
  id: "agents",
  title: "Agent Setup",
  summary: "Install or update custom agents, chains, and prompt templates.",
  flowOrder: 30,
  flowGuidance: "Run after profile setup to ensure custom agents are installed.",
  commands: [
    {
      name: "zflow-setup-agents",
      usage: "/zflow-setup-agents",
      description: "Install pi-zflow custom agents and chains.",
    },
    {
      name: "zflow-update-agents",
      usage: "/zflow-update-agents",
      description: "Update previously installed agents to latest versions.",
    },
  ],
}

const reviewTopic: ZflowHelpTopic = {
  packageName: "pi-zflow-review",
  id: "review",
  title: "Code Review",
  summary: "Review implemented changes and pull requests.",
  flowOrder: 50,
  flowGuidance: "Use after implementing changes to review before merging.",
  commands: [
    {
      name: "zflow-review-code",
      usage: "/zflow-review-code",
      description: "Review code changes in the working tree.",
    },
    {
      name: "zflow-review-pr",
      usage: "/zflow-review-pr <url>",
      description: "Review an external pull request.",
    },
  ],
}

const changeTopic: ZflowHelpTopic = {
  packageName: "pi-zflow-change-workflows",
  id: "change",
  title: "Change Workflows",
  summary: "Prepare, implement, and clean up formal changes.",
  flowOrder: 40,
  flowGuidance: "Core workflow: prepare a plan, implement it, then clean up.",
  commands: [
    {
      name: "zflow-change-prepare",
      usage: "/zflow-change-prepare <change-path>",
      description: "Prepare a plan for a formal change.",
    },
    {
      name: "zflow-change-implement",
      usage: "/zflow-change-implement <change-path>",
      description: "Implement a prepared change plan.",
    },
    {
      name: "zflow-clean",
      usage: "/zflow-clean",
      description: "Clean up temporary artifacts and worktrees.",
    },
  ],
}

const allTopics: ZflowHelpTopic[] = [
  profilesTopic,
  planModeTopic,
  agentsTopic,
  reviewTopic,
  changeTopic,
]

// ── Tests ───────────────────────────────────────────────────────────

describe("help catalog — sort / group / lookup", () => {
  test("sortTopicsByFlow returns ordered by flowOrder ascending", () => {
    const sorted = sortTopicsByFlow(allTopics)
    const orders = sorted.map((t) => t.id)
    assert.deepEqual(orders, ["profiles", "plan-mode", "agents", "change", "review"])
  })

  test("sortTopicsByFlow puts topics without flowOrder at end", () => {
    const noOrder: ZflowHelpTopic = topic({ id: "no-order", summary: "no flow order" })
    const withOrder: ZflowHelpTopic = topic({
      id: "with-order",
      summary: "has order",
      flowOrder: 99,
    })
    const result = sortTopicsByFlow([noOrder, withOrder])
    assert.equal(result[0].id, "with-order")
    assert.equal(result[1].id, "no-order")
  })

  test("sortTopicsByFlow does not mutate the input array", () => {
    const original = [...allTopics]
    sortTopicsByFlow(allTopics)
    assert.deepEqual(
      allTopics.map((t) => t.id),
      original.map((t) => t.id),
    )
  })

  test("groupTopicsByPackage groups topics by packageName", () => {
    const groups = groupTopicsByPackage(allTopics)
    assert.equal(groups.size, 5)
    assert.ok(groups.has("pi-zflow-profiles"))
    assert.ok(groups.has("pi-zflow-plan-mode"))
    assert.equal(groups.get("pi-zflow-profiles")!.length, 1)
  })

  test("groupTopicsByPackage handles multiple topics from same package", () => {
    const extra: ZflowHelpTopic = topic({
      id: "profiles-extra",
      packageName: "pi-zflow-profiles",
      summary: "extra profiles topic",
    })
    const groups = groupTopicsByPackage([profilesTopic, extra])
    assert.equal(groups.get("pi-zflow-profiles")!.length, 2)
  })

  test("getTopic finds a topic by id", () => {
    const found = getTopic(allTopics, "profiles")
    assert.ok(found)
    assert.equal(found!.id, "profiles")
  })

  test("getTopic returns undefined for missing id", () => {
    const found = getTopic(allTopics, "nonexistent")
    assert.equal(found, undefined)
  })

  test("getTopic drills into subtopics when subtopicId is provided", () => {
    const sub: ZflowHelpTopic = topic({
      id: "drilldown",
      summary: "a subtopic",
    })
    const parent: ZflowHelpTopic = topic({
      id: "parent",
      summary: "has subtopics",
      subtopics: [sub],
    })
    const found = getTopic([parent], "parent", "drilldown")
    assert.ok(found)
    assert.equal(found!.id, "drilldown")
  })

  test("getTopic returns parent when subtopicId is provided but no subtopics exist", () => {
    const found = getTopic(allTopics, "profiles", "nonexistent")
    assert.ok(found)
    assert.equal(found!.id, "profiles")
  })
})

describe("help catalog — markdown rendering", () => {
  test("renderTopicMarkdown produces a valid section with commands table", () => {
    const md = renderTopicMarkdown(profilesTopic)
    assert.ok(md.includes("## Profile Management"))
    assert.ok(md.includes("zflow-profile list"))
    assert.ok(md.includes("/zflow-profile list"))
    assert.ok(md.includes("zflow-profile switch"))
    assert.ok(md.includes("| Command | Usage | Description |"))
    assert.ok(md.includes("Flow guidance"))
  })

  test("renderTopicMarkdown includes flow guidance when present", () => {
    const md = renderTopicMarkdown(profilesTopic)
    assert.ok(md.includes("Start here"))
  })

  test("renderTopicMarkdown handles empty commands gracefully", () => {
    const empty: ZflowHelpTopic = topic({
      id: "empty",
      summary: "no commands",
    })
    const md = renderTopicMarkdown(empty)
    assert.ok(md.includes("## Test Topic"))
    assert.ok(!md.includes("| Command |"))
  })

  test("renderTopicMarkdown escapes pipe characters in usage/description", () => {
    const withPipe: ZflowHelpTopic = topic({
      id: "pipe-test",
      summary: "has pipes",
      commands: [
        {
          name: "pipe-cmd",
          usage: "/pipe-cmd a|b",
          description: "Does a|b thing",
        },
      ],
    })
    const md = renderTopicMarkdown(withPipe)
    // The rendered table should have escaped pipes
    assert.ok(md.includes("\\|"))
    // Should not have unescaped pipes breaking the table
    assert.ok(!md.includes("| /pipe-cmd a|b |"))
  })

  test("renderTopicMarkdown renders subtopics recursively", () => {
    const sub: ZflowHelpTopic = topic({
      id: "sub-one",
      title: "Sub Topic",
      summary: "a nested subtopic",
      commands: [
        { name: "sub-cmd", usage: "/sub-cmd", description: "a sub command" },
      ],
    })
    const parent: ZflowHelpTopic = topic({
      id: "parent",
      summary: "has a subtopic",
      subtopics: [sub],
    })
    const md = renderTopicMarkdown(parent)
    assert.ok(md.includes("Sub Topic"))
    assert.ok(md.includes("sub-cmd"))
  })

  test("renderAllTopicsMarkdown produces a complete document with overview, workflow, and sections", () => {
    const md = renderAllTopicsMarkdown(allTopics)
    // Document title
    assert.ok(md.startsWith("# pi-zflow Help"))
    // Overview table
    assert.ok(md.includes("## Overview"))
    assert.ok(md.includes("| `profiles` |"))
    assert.ok(md.includes("| `plan-mode` |"))
    // Recommended workflow section
    assert.ok(md.includes("## Recommended Workflow"))
    assert.ok(md.includes("1. **Profile Management**"))
    assert.ok(md.includes("2. **Read-Only Planning Mode**"))
    // Detail sections
    assert.ok(md.includes("## Profile Management"))
    assert.ok(md.includes("## Read-Only Planning Mode"))
    assert.ok(md.includes("## Code Review"))
    // Footer
    assert.ok(md.includes("_Generated by"))
  })

  test("renderAllTopicsMarkdown includes all topics passed in", () => {
    const md = renderAllTopicsMarkdown(allTopics)
    for (const t of allTopics) {
      assert.ok(md.includes(t.title), `Expected title "${t.title}" in output`)
      assert.ok(md.includes(t.summary), `Expected summary "${t.summary}" in output`)
    }
  })

  test("renderAllTopicsMarkdown shows drill-down hint", () => {
    const md = renderAllTopicsMarkdown(allTopics)
    assert.ok(md.includes("/zflow-help <topic>"))
  })

  test("renderAllTopicsMarkdown handles empty topic array", () => {
    const md = renderAllTopicsMarkdown([])
    assert.ok(md.includes("# pi-zflow Help"))
    assert.ok(!md.includes("## Recommended Workflow"))
  })

  test("renderHelpSummary returns a compact one-liner", () => {
    const summary = renderHelpSummary(allTopics)
    assert.ok(summary.startsWith("pi-zflow: "))
    assert.ok(summary.includes("5 topics"))
    assert.ok(summary.includes("11 commands"))
    assert.ok(summary.includes("5 packages"))
    assert.ok(summary.includes("/zflow-help"))
  })

  test("renderHelpSummary handles singular counts", () => {
    const single: ZflowHelpTopic = topic({
      id: "single",
      summary: "only one",
      commands: [{
        name: "single-cmd",
        usage: "/single-cmd",
        description: "just one",
      }],
    })
    const summary = renderHelpSummary([single])
    assert.ok(summary.includes("1 topic"))
    assert.ok(summary.includes("1 command"))
    assert.ok(summary.includes("1 package"))
  })

  test("renderHelpSummary handles empty topics", () => {
    const summary = renderHelpSummary([])
    assert.ok(summary.includes("0 topics"))
    assert.ok(summary.includes("0 commands"))
    assert.ok(summary.includes("0 packages"))
  })
})
