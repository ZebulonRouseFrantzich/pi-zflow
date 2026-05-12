/**
 * ID helpers tests — namespaced identifier generation and validation.
 */
import * as assert from "node:assert"
import { test, describe } from "node:test"
import {
  command,
  tool,
  event,
  sessionEntryType,
  statusKey,
  messageType,
  BUILTIN_TOOLS,
  checkBuiltinToolCollision,
  checkCommandNaming,
  checkToolNaming,
  COMMAND_PREFIX,
  TOOL_PREFIX,
  EVENT_PREFIX,
  SESSION_ENTRY_PREFIX,
  STATUS_KEY_PREFIX,
  MESSAGE_TYPE_PREFIX,
} from "../src/ids.js"

describe("identifier helpers", () => {
  // ── Command names ──────────────────────────────────────────────

  test('command() prepends "/zflow-"', () => {
    assert.equal(command("profile"), "/zflow-profile")
    assert.equal(command("change-prepare"), "/zflow-change-prepare")
    assert.equal(command("plan"), "/zflow-plan")
  })

  test("command() handles empty string", () => {
    assert.equal(command(""), "/zflow-")
  })

  // ── Tool names ─────────────────────────────────────────────────

  test('tool() prepends "zflow_"', () => {
    assert.equal(tool("write_plan_artifact"), "zflow_write_plan_artifact")
    assert.equal(tool("resolve_profile"), "zflow_resolve_profile")
  })

  test("tool() handles single segment", () => {
    assert.equal(tool("test"), "zflow_test")
  })

  // ── Event names ────────────────────────────────────────────────

  test('event() prepends "zflow:"', () => {
    assert.equal(event("profileChanged"), "zflow:profileChanged")
    assert.equal(event("planApproved"), "zflow:planApproved")
    assert.equal(event("reviewCompleted"), "zflow:reviewCompleted")
  })

  // ── Session entry types ────────────────────────────────────────

  test('sessionEntryType() prepends "zflow:"', () => {
    assert.equal(sessionEntryType("planApproved"), "zflow:planApproved")
    assert.equal(sessionEntryType("workflowState"), "zflow:workflowState")
  })

  // ── Status keys ────────────────────────────────────────────────

  test('statusKey() prepends "zflow:"', () => {
    assert.equal(statusKey("planMode"), "zflow:planMode")
    assert.equal(statusKey("profile"), "zflow:profile")
  })

  // ── Message types ──────────────────────────────────────────────

  test('messageType() prepends "zflow:"', () => {
    assert.equal(messageType("workflowState"), "zflow:workflowState")
    assert.equal(messageType("findings"), "zflow:findings")
  })

  // ── Prefix constants ───────────────────────────────────────────

  test("prefix constants have correct values", () => {
    assert.equal(COMMAND_PREFIX, "zflow")
    assert.equal(TOOL_PREFIX, "zflow")
    assert.equal(EVENT_PREFIX, "zflow")
    assert.equal(SESSION_ENTRY_PREFIX, "zflow")
    assert.equal(STATUS_KEY_PREFIX, "zflow")
    assert.equal(MESSAGE_TYPE_PREFIX, "zflow")
  })
})

describe("BUILTIN_TOOLS", () => {
  test("contains core builtin names", () => {
    assert.ok(BUILTIN_TOOLS.has("read"))
    assert.ok(BUILTIN_TOOLS.has("bash"))
    assert.ok(BUILTIN_TOOLS.has("edit"))
    assert.ok(BUILTIN_TOOLS.has("write"))
    assert.ok(BUILTIN_TOOLS.has("grep"))
    assert.ok(BUILTIN_TOOLS.has("find"))
    assert.ok(BUILTIN_TOOLS.has("ls"))
  })

  test("contains Pi agent tools", () => {
    assert.ok(BUILTIN_TOOLS.has("subagent"))
    assert.ok(BUILTIN_TOOLS.has("intercom"))
    assert.ok(BUILTIN_TOOLS.has("interview"))
  })

  test("does not contain zflow-namespaced names", () => {
    assert.ok(!BUILTIN_TOOLS.has("zflow_write_plan_artifact"))
    assert.ok(!BUILTIN_TOOLS.has("zflow_profile"))
  })
})

describe("checkBuiltinToolCollision", () => {
  test("returns message for builtin tool name", () => {
    const result = checkBuiltinToolCollision("read")
    assert.ok(result !== null)
    assert.ok(result!.includes("built-in Pi tool"))
    assert.ok(result!.includes("zflow_read"))
  })

  test("returns null for non-builtin name", () => {
    assert.strictEqual(checkBuiltinToolCollision("zflow_write_plan_artifact"), null)
  })

  test("returns null for zflow-namespaced name that happens to match", () => {
    assert.strictEqual(checkBuiltinToolCollision("zflow_bash"), null)
  })
})

describe("checkCommandNaming", () => {
  test("accepts properly namespaced command", () => {
    assert.strictEqual(checkCommandNaming("/zflow-profile"), null)
    assert.strictEqual(checkCommandNaming("/zflow-change-prepare"), null)
  })

  test("rejects un-aliased command", () => {
    const result = checkCommandNaming("/profile")
    assert.ok(result !== null)
    assert.ok(result!.includes("/zflow-"))
  })

  test("rejects non-slash command", () => {
    const result = checkCommandNaming("zflow-profile")
    assert.ok(result !== null)
  })

  test("rejects empty string", () => {
    const result = checkCommandNaming("")
    assert.ok(result !== null)
  })
})

describe("checkToolNaming", () => {
  test("accepts properly namespaced tool", () => {
    assert.strictEqual(checkToolNaming("zflow_write_plan_artifact"), null)
    assert.strictEqual(checkToolNaming("zflow_resolve_profile"), null)
  })

  test("rejects un-namespaced tool", () => {
    const result = checkToolNaming("write_plan_artifact")
    assert.ok(result !== null)
    assert.ok(result!.includes("zflow_"))
  })

  test("rejects empty string", () => {
    const result = checkToolNaming("")
    assert.ok(result !== null)
  })
})
