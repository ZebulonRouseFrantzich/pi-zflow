/**
 * help.test.ts — Validates that pi-zflow-runecontext exports help topic metadata
 * with namespaced commands (if any).
 */
import * as assert from "node:assert"
import { test, describe } from "node:test"
import { ZFLOW_HELP_TOPICS } from "../src/index.js"

describe("pi-zflow-runecontext help topics", () => {
  test("exports at least one help topic", () => {
    assert.ok(ZFLOW_HELP_TOPICS.length >= 1)
  })

  test("all command names are namespaced (zflow-* or zflow_*)", () => {
    for (const topic of ZFLOW_HELP_TOPICS) {
      for (const cmd of topic.commands) {
        const ok = cmd.name.startsWith("zflow-") || cmd.name.startsWith("zflow_")
        assert.ok(ok, `Command "${cmd.name}" must be namespaced (zflow-* or zflow_*)`)
      }
    }
  })

  test("topic has a packageName, id, title, and summary", () => {
    for (const topic of ZFLOW_HELP_TOPICS) {
      assert.ok(topic.packageName, "topic must have a packageName")
      assert.ok(topic.id, "topic must have an id")
      assert.ok(topic.title, "topic must have a title")
      assert.ok(topic.summary, "topic must have a summary")
    }
  })
})
