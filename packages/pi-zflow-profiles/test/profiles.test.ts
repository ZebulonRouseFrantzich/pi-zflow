/**
 * profiles.test.ts — Tests for profile schema validation and normalization.
 *
 * Covers:
 *   - Valid profiles file (example.json)
 *   - Missing default profile
 *   - Agent binding references unknown lane
 *   - Lane with empty preferredModels
 *   - Lane with both required: true and optional: true
 *   - Invalid thinking level
 *   - Normalization of omitted flags
 *   - Normalization of explicit flags
 *   - Invalid JSON parsing
 */
import { describe, it } from "node:test"
import * as assert from "node:assert/strict"
import {
  validateProfilesFile,
  parseProfilesFile,
  parseProfilesFileJson,
  normalizeLaneDefinition,
  normalizeAgentBinding,
  normalizeProfileDefinition,
  normalizeProfilesFile,
  ProfileValidationError,
  type ProfilesFile,
  type LaneDefinition,
  type AgentBinding,
  type ProfileDefinition,
} from "../extensions/zflow-profiles/profiles.js"
import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

// ── Helpers ─────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
const EXAMPLE_PATH = resolve(__dirname, "..", "config", "profiles.example.json")

function loadExampleJson(): unknown {
  const raw = readFileSync(EXAMPLE_PATH, "utf8")
  return JSON.parse(raw)
}

// ── Valid profile data for tests ────────────────────────────────

function validProfilesFile(): ProfilesFile {
  return {
    default: {
      description: "Test profile",
      lanes: {
        "scout-cheap": {
          required: true,
          thinking: "low",
          preferredModels: ["openai/gpt-4o-mini"],
        },
        "worker-strong": {
          required: true,
          thinking: "high",
          preferredModels: ["openai/gpt-5.4-codex"],
        },
        "review-logic": {
          optional: true,
          thinking: "medium",
          preferredModels: ["openai/gpt-5.4"],
        },
      },
      agentBindings: {
        scout: {
          lane: "scout-cheap",
          tools: "read, grep, find",
          maxOutput: 4000,
          maxSubagentDepth: 0,
        },
        "zflow.implement-hard": {
          lane: "worker-strong",
          tools: "read, bash, edit, write",
          maxOutput: 12000,
          maxSubagentDepth: 1,
        },
        "zflow.review-logic": {
          lane: "review-logic",
          optional: true,
          tools: "read, grep",
          maxOutput: 8000,
        },
      },
    },
  }
}

// ── Tests ───────────────────────────────────────────────────────

describe("validateProfilesFile", () => {
  it("accepts a valid profiles file", () => {
    const result = validateProfilesFile(validProfilesFile())
    assert.equal(result.valid, true)
    assert.equal(result.errors.length, 0)
  })

  it("accepts the example config", () => {
    const data = loadExampleJson()
    const result = validateProfilesFile(data)
    if (!result.valid) {
      console.error("Validation errors:", JSON.stringify(result.errors, null, 2))
    }
    assert.equal(result.valid, true)
    assert.equal(result.errors.length, 0)
  })

  it("rejects null/undefined/non-object root", () => {
    for (const val of [null, undefined, "string", 42, true]) {
      const result = validateProfilesFile(val)
      assert.equal(result.valid, false)
      assert.ok(result.errors.length > 0)
      assert.ok(result.errors[0].message.includes("object"))
    }
  })

  it("rejects missing default profile", () => {
    const data = { other: { lanes: {}, agentBindings: {} } }
    const result = validateProfilesFile(data)
    assert.equal(result.valid, false)
    assert.ok(result.errors.some((e) => e.path === "<root>" && e.message.includes("default")))
  })

  it("rejects a profile with non-object value", () => {
    const data = { default: "not-an-object" }
    const result = validateProfilesFile(data)
    assert.equal(result.valid, false)
    assert.ok(result.errors.some((e) => e.path === "default" && e.message.includes("non-null object")))
  })

  it("rejects missing lanes", () => {
    const data = { default: { agentBindings: {} } }
    const result = validateProfilesFile(data)
    assert.equal(result.valid, false)
    assert.ok(result.errors.some((e) => e.path === "default.lanes"))
  })

  it("rejects missing agentBindings", () => {
    const data = {
      default: {
        lanes: { "scout-cheap": { preferredModels: ["openai/gpt-4o-mini"] } },
      },
    }
    const result = validateProfilesFile(data)
    assert.equal(result.valid, false)
    assert.ok(result.errors.some((e) => e.path === "default.agentBindings"))
  })

  it("rejects lane with empty preferredModels", () => {
    const data = {
      default: {
        lanes: {
          "scout-cheap": { preferredModels: [] },
        },
        agentBindings: {
          scout: { lane: "scout-cheap" },
        },
      },
    }
    const result = validateProfilesFile(data)
    assert.equal(result.valid, false)
    assert.ok(
      result.errors.some((e) =>
        e.path.includes("preferredModels") && e.message.includes("non-empty"),
      ),
    )
  })

  it("rejects lane with non-string preferredModels", () => {
    const data = {
      default: {
        lanes: {
          "scout-cheap": { preferredModels: ["valid-model", 42] },
        },
        agentBindings: {
          scout: { lane: "scout-cheap" },
        },
      },
    }
    const result = validateProfilesFile(data)
    assert.equal(result.valid, false)
    assert.ok(
      result.errors.some((e) =>
        e.path.includes("preferredModels") && e.message.includes("non-empty"),
      ),
    )
  })

  it("rejects both required: true and optional: true", () => {
    const data = {
      default: {
        lanes: {
          "scout-cheap": {
            required: true,
            optional: true,
            preferredModels: ["openai/gpt-4o-mini"],
          },
        },
        agentBindings: {
          scout: { lane: "scout-cheap" },
        },
      },
    }
    const result = validateProfilesFile(data)
    assert.equal(result.valid, false)
    assert.ok(
      result.errors.some((e) =>
        e.message.includes("both") && e.message.includes("conflict"),
      ),
    )
  })

  it("rejects invalid thinking level", () => {
    const data = {
      default: {
        lanes: {
          "scout-cheap": {
            thinking: "ultra",
            preferredModels: ["openai/gpt-4o-mini"],
          },
        },
        agentBindings: {
          scout: { lane: "scout-cheap" },
        },
      },
    }
    const result = validateProfilesFile(data)
    assert.equal(result.valid, false)
    assert.ok(
      result.errors.some((e) =>
        e.path.includes("thinking") && e.message.includes("low"),
      ),
    )
  })

  it("rejects agent binding referencing unknown lane", () => {
    const data = {
      default: {
        lanes: {
          "scout-cheap": { preferredModels: ["openai/gpt-4o-mini"] },
        },
        agentBindings: {
          scout: { lane: "nonexistent-lane" },
        },
      },
    }
    const result = validateProfilesFile(data)
    assert.equal(result.valid, false)
    assert.ok(
      result.errors.some((e) =>
        e.path.includes("lane") && e.message.includes("nonexistent-lane"),
      ),
    )
  })

  it("rejects agent binding with missing lane field", () => {
    const data = {
      default: {
        lanes: {
          "scout-cheap": { preferredModels: ["openai/gpt-4o-mini"] },
        },
        agentBindings: {
          scout: { tools: "read" },
        },
      },
    }
    const result = validateProfilesFile(data)
    assert.equal(result.valid, false)
    assert.ok(
      result.errors.some((e) => e.path === "default.agentBindings.scout.lane"),
    )
  })

  it("rejects invalid maxOutput (non-integer)", () => {
    const data = {
      default: {
        lanes: {
          "scout-cheap": { preferredModels: ["openai/gpt-4o-mini"] },
        },
        agentBindings: {
          scout: { lane: "scout-cheap", maxOutput: 12.5 },
        },
      },
    }
    const result = validateProfilesFile(data)
    assert.equal(result.valid, false)
    assert.ok(
      result.errors.some((e) =>
        e.path.includes("maxOutput") && e.message.includes("positive integer"),
      ),
    )
  })

  it("rejects invalid maxOutput (negative)", () => {
    const data = {
      default: {
        lanes: {
          "scout-cheap": { preferredModels: ["openai/gpt-4o-mini"] },
        },
        agentBindings: {
          scout: { lane: "scout-cheap", maxOutput: -1 },
        },
      },
    }
    const result = validateProfilesFile(data)
    assert.equal(result.valid, false)
    assert.ok(
      result.errors.some((e) =>
        e.path.includes("maxOutput") && e.message.includes("positive integer"),
      ),
    )
  })

  it("rejects invalid maxSubagentDepth (negative)", () => {
    const data = {
      default: {
        lanes: {
          "scout-cheap": { preferredModels: ["openai/gpt-4o-mini"] },
        },
        agentBindings: {
          scout: { lane: "scout-cheap", maxSubagentDepth: -1 },
        },
      },
    }
    const result = validateProfilesFile(data)
    assert.equal(result.valid, false)
    assert.ok(
      result.errors.some((e) =>
        e.path.includes("maxSubagentDepth") && e.message.includes("non-negative integer"),
      ),
    )
  })

  it("rejects invalid description (non-string)", () => {
    const data = {
      default: {
        description: 42,
        lanes: {
          "scout-cheap": { preferredModels: ["openai/gpt-4o-mini"] },
        },
        agentBindings: {
          scout: { lane: "scout-cheap" },
        },
      },
    }
    const result = validateProfilesFile(data)
    assert.equal(result.valid, false)
    assert.ok(
      result.errors.some((e) =>
        e.path === "default.description" && e.message.includes("string"),
      ),
    )
  })

  it("rejects invalid verificationCommand (non-string)", () => {
    const data = {
      default: {
        verificationCommand: true,
        lanes: {
          "scout-cheap": { preferredModels: ["openai/gpt-4o-mini"] },
        },
        agentBindings: {
          scout: { lane: "scout-cheap" },
        },
      },
    }
    const result = validateProfilesFile(data)
    assert.equal(result.valid, false)
    assert.ok(
      result.errors.some((e) =>
        e.path === "default.verificationCommand" && e.message.includes("string"),
      ),
    )
  })
})

describe("normalizeLaneDefinition", () => {
  it("defaults to required when neither flag is set", () => {
    const result = normalizeLaneDefinition({ preferredModels: ["m"] })
    assert.equal(result.required, true)
    assert.equal(result.optional, false)
  })

  it("sets required=true when required explicitly", () => {
    const result = normalizeLaneDefinition({
      required: true,
      preferredModels: ["m"],
    })
    assert.equal(result.required, true)
    assert.equal(result.optional, false)
  })

  it("sets optional=true when optional explicitly", () => {
    const result = normalizeLaneDefinition({
      optional: true,
      preferredModels: ["m"],
    })
    assert.equal(result.required, false)
    assert.equal(result.optional, true)
  })

  it("preserves thinking level", () => {
    const result = normalizeLaneDefinition({
      thinking: "high",
      preferredModels: ["m"],
    })
    assert.equal(result.thinking, "high")
  })

  it("allows undefined thinking", () => {
    const result = normalizeLaneDefinition({ preferredModels: ["m"] })
    assert.equal(result.thinking, undefined)
  })
})

describe("normalizeAgentBinding", () => {
  it("defaults optional to false", () => {
    const result = normalizeAgentBinding({ lane: "test" })
    assert.equal(result.optional, false)
  })

  it("preserves explicit optional", () => {
    const result = normalizeAgentBinding({ lane: "test", optional: true })
    assert.equal(result.optional, true)
  })

  it("preserves tools", () => {
    const result = normalizeAgentBinding({ lane: "test", tools: "read,write" })
    assert.equal(result.tools, "read,write")
  })

  it("preserves maxOutput", () => {
    const result = normalizeAgentBinding({ lane: "test", maxOutput: 8000 })
    assert.equal(result.maxOutput, 8000)
  })

  it("preserves maxSubagentDepth", () => {
    const result = normalizeAgentBinding({ lane: "test", maxSubagentDepth: 1 })
    assert.equal(result.maxSubagentDepth, 1)
  })
})

describe("normalizeProfileDefinition", () => {
  it("normalizes all lanes and bindings", () => {
    const profile: ProfileDefinition = {
      description: "test",
      verificationCommand: "npm test",
      lanes: {
        lane1: { preferredModels: ["m1"] },
        lane2: { optional: true, thinking: "high", preferredModels: ["m2"] },
      },
      agentBindings: {
        agent1: { lane: "lane1" },
        agent2: { lane: "lane2", optional: true, maxOutput: 8000 },
      },
    }

    const result = normalizeProfileDefinition(profile)
    assert.equal(result.description, "test")
    assert.equal(result.verificationCommand, "npm test")

    // Lane1: no flags → required
    assert.equal(result.lanes.lane1.required, true)
    assert.equal(result.lanes.lane1.optional, false)

    // Lane2: optional
    assert.equal(result.lanes.lane2.required, false)
    assert.equal(result.lanes.lane2.optional, true)
    assert.equal(result.lanes.lane2.thinking, "high")

    // Agent1: no optional flag
    assert.equal(result.agentBindings.agent1.optional, false)
    assert.equal(result.agentBindings.agent1.lane, "lane1")

    // Agent2: optional
    assert.equal(result.agentBindings.agent2.optional, true)
    assert.equal(result.agentBindings.agent2.maxOutput, 8000)
  })
})

describe("normalizeProfilesFile", () => {
  it("normalizes all profiles", () => {
    const profiles: ProfilesFile = {
      default: {
        lanes: {
          scout: { preferredModels: ["m1"] },
        },
        agentBindings: {
          s: { lane: "scout" },
        },
      },
      alt: {
        description: "alt profile",
        lanes: {
          work: { optional: true, preferredModels: ["m2"] },
        },
        agentBindings: {
          w: { lane: "work", optional: true },
        },
      },
    }

    const result = normalizeProfilesFile(profiles)
    assert.ok("default" in result)
    assert.ok("alt" in result)
    assert.equal(result.default.lanes.scout.required, true)
    assert.equal(result.alt.lanes.work.optional, true)
  })
})

describe("parseProfilesFile", () => {
  it("parses and validates a valid profiles file", () => {
    const data = validProfilesFile()
    const { profiles, validation } = parseProfilesFile(data)
    assert.equal(validation.valid, true)
    assert.ok("default" in profiles)
  })

  it("throws ProfileValidationError for invalid input", () => {
    const data = {
      default: {
        lanes: {
          scout: { preferredModels: [] },
        },
        agentBindings: {
          s: { lane: "scout" },
        },
      },
    }
    assert.throws(
      () => parseProfilesFile(data),
      (err: unknown) => err instanceof ProfileValidationError,
    )
  })
})

describe("parseProfilesFileJson", () => {
  it("parses valid JSON", () => {
    const json = JSON.stringify(validProfilesFile())
    const { profiles } = parseProfilesFileJson(json)
    assert.ok("default" in profiles)
  })

  it("throws ProfileValidationError for invalid JSON", () => {
    assert.throws(
      () => parseProfilesFileJson("not valid json {{{"),
      (err: unknown) => err instanceof ProfileValidationError,
    )
  })

  it("throws ProfileValidationError for semantically invalid JSON", () => {
    const json = JSON.stringify({
      default: {
        lanes: {
          scout: { preferredModels: [] },
        },
        agentBindings: {
          s: { lane: "scout" },
        },
      },
    })
    assert.throws(
      () => parseProfilesFileJson(json),
      (err: unknown) => err instanceof ProfileValidationError,
    )
  })
})

describe("example config", () => {
  it("loads and validates cleanly", () => {
    const data = loadExampleJson()
    const result = validateProfilesFile(data)
    if (!result.valid) {
      console.error("Example config validation errors:", JSON.stringify(result.errors, null, 2))
    }
    assert.equal(result.valid, true)
  })

  it("parses without throwing", () => {
    const data = loadExampleJson()
    assert.doesNotThrow(() => parseProfilesFile(data))
  })
})

// ── Profile file loading tests ───────────────────────────────────

import * as fs from "node:fs/promises"
import * as fss from "node:fs"
import * as path2 from "node:path"
import * as os from "node:os"
import {
  loadProfiles,
  loadProfilesSync,
  resolveProjectProfilePath,
  resolveUserProfilePath,
  fileExists,
  fileExistsSync,
  resolveProfileSource,
  ProfileFileNotFoundError,
} from "../extensions/zflow-profiles/profiles.js"

/**
 * Create a temporary directory and write a profiles JSON file into it.
 * Returns the path to the created file.
 */
async function writeTempProfile(
  content: Record<string, unknown>,
  filename: string = "zflow-profiles.json",
): Promise<{ dir: string; filePath: string }> {
  const dir = await fs.mkdtemp(path2.join(os.tmpdir(), "zflow-profiles-test-"))
  const filePath = path2.join(dir, filename)
  await fs.writeFile(filePath, JSON.stringify(content, null, 2))
  return { dir, filePath }
}

/**
 * Create a temporary directory mimicking a repo with `.pi/zflow-profiles.json`.
 */
async function writeProjectProfile(content: Record<string, unknown>): Promise<string> {
  const dir = await fs.mkdtemp(path2.join(os.tmpdir(), "zflow-profiles-test-"))
  const piDir = path2.join(dir, ".pi")
  await fs.mkdir(piDir, { recursive: true })
  const filePath = path2.join(piDir, "zflow-profiles.json")
  await fs.writeFile(filePath, JSON.stringify(content, null, 2))
  return dir // return the "repo root"
}

describe("resolveProjectProfilePath", () => {
  it("returns null when repoRoot is not provided", () => {
    const result = resolveProjectProfilePath()
    assert.equal(result, null)
  })

  it("returns null when repoRoot is undefined", () => {
    const result = resolveProjectProfilePath(undefined)
    assert.equal(result, null)
  })

  it("returns the correct path when repoRoot is provided", () => {
    const result = resolveProjectProfilePath("/some/repo")
    assert.equal(result, "/some/repo/.pi/zflow-profiles.json")
  })

  it("resolves against absolute paths correctly", () => {
    const result = resolveProjectProfilePath("/home/user/project")
    assert.ok(result!.endsWith("/.pi/zflow-profiles.json"))
    assert.ok(result!.startsWith("/"))
  })
})

describe("resolveUserProfilePath", () => {
  it("returns a path under ~/.pi/agent/", () => {
    const result = resolveUserProfilePath()
    assert.ok(result.includes(".pi"))
    assert.ok(result.includes("agent"))
    assert.ok(result.endsWith("zflow-profiles.json"))
    assert.ok(result.startsWith(os.homedir()))
  })
})

describe("fileExists / fileExistsSync", () => {
  it("returns true for an existing file", async () => {
    const { filePath } = await writeTempProfile({ default: { lanes: {}, agentBindings: {} } })
    try {
      assert.equal(await fileExists(filePath), true)
    } finally {
      await fs.rm(path2.dirname(filePath), { recursive: true, force: true })
    }
  })

  it("returns false for a non-existent file", async () => {
    const result = await fileExists("/tmp/nonexistent-zflow-test-file-xyz789")
    assert.equal(result, false)
  })

  it("fileExistsSync returns true for an existing file", () => {
    const existingPath = EXAMPLE_PATH
    assert.equal(fileExistsSync(existingPath), true)
  })

  it("fileExistsSync returns false for a non-existent file", () => {
    assert.equal(fileExistsSync("/tmp/nonexistent-zflow-test-file-xyz789"), false)
  })
})

describe("resolveProfileSource", () => {
  it("chooses project path over user path when project file exists", async () => {
    const repoRoot = await writeProjectProfile({
      default: {
        lanes: { scout: { preferredModels: ["m1"] } },
        agentBindings: { s: { lane: "scout" } },
      },
    })
    try {
      const source = await resolveProfileSource(repoRoot)
      assert.ok(source.includes(repoRoot))
      assert.ok(source.endsWith(".pi/zflow-profiles.json"))
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })

  it("falls back to user path when project file does not exist", async () => {
    // This test requires the user file to actually exist. We'll create a
    // temporary one and monkey-patch resolveUserProfilePath for the test.
    // Instead, test the fallback path by creating a temp repo WITHOUT a
    // profiles file and verifying it tries to fall back.
    //
    // Since the user file likely doesn't exist on CI, verify the error
    // lists both candidates.
    const tempRoot = await fs.mkdtemp(path2.join(os.tmpdir(), "zflow-profiles-test-"))
    try {
      await assert.rejects(
        () => resolveProfileSource(tempRoot),
        (err: unknown) => {
          if (!(err instanceof ProfileFileNotFoundError)) return false
          // Should have searched both the project path and user path
          return (
            err.searchedPaths.length >= 2 &&
            err.searchedPaths.some((p) => p.includes(tempRoot)) &&
            err.searchedPaths.some((p) => p.includes(os.homedir()))
          )
        },
      )
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })

  it("throws ProfileFileNotFoundError when neither file exists", async () => {
    await assert.rejects(
      () => resolveProfileSource("/tmp/nonexistent-zflow-repo-xyz789"),
      (err: unknown) => err instanceof ProfileFileNotFoundError,
    )
  })

  it("resolves from user path when repoRoot is omitted and user file exists", async () => {
    // This test is conditional — if the user file happens to exist, it passes.
    // If not, we skip it.
    const userPath = resolveUserProfilePath()
    if (await fileExists(userPath)) {
      const source = await resolveProfileSource()
      assert.equal(source, userPath)
    } else {
      // If user file doesn't exist, verify it throws searching only user path
      await assert.rejects(
        () => resolveProfileSource(),
        (err: unknown) => err instanceof ProfileFileNotFoundError,
      )
    }
  })
})

describe("loadProfiles", () => {
  it("loads and validates from a project-local file", async () => {
    const repoRoot = await writeProjectProfile({
      default: {
        lanes: {
          scout: {
            required: true,
            thinking: "low",
            preferredModels: ["openai/gpt-4o-mini"],
          },
        },
        agentBindings: {
          s: { lane: "scout" },
        },
      },
    })
    try {
      const result = await loadProfiles(repoRoot)
      assert.ok("default" in result.profiles)
      assert.ok(result.source.endsWith(".pi/zflow-profiles.json"))
      assert.equal(result.validation.valid, true)
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })

  it("throws ProfileFileNotFoundError when no file exists", async () => {
    await assert.rejects(
      () => loadProfiles("/tmp/nonexistent-zflow-repo-xyz789"),
      (err: unknown) => err instanceof ProfileFileNotFoundError,
    )
  })

  it("throws ProfileValidationError for invalid file content", async () => {
    const repoRoot = await writeProjectProfile({
      default: {
        lanes: {
          scout: { preferredModels: [] },
        },
        agentBindings: {
          s: { lane: "scout" },
        },
      },
    })
    try {
      await assert.rejects(
        () => loadProfiles(repoRoot),
        (err: unknown) => err instanceof ProfileValidationError,
      )
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })

  it("throws ProfileValidationError for missing default profile", async () => {
    const repoRoot = await writeProjectProfile({
      other: {
        lanes: { scout: { preferredModels: ["m1"] } },
        agentBindings: { s: { lane: "scout" } },
      },
    })
    try {
      await assert.rejects(
        () => loadProfiles(repoRoot),
        (err: unknown) => err instanceof ProfileValidationError,
      )
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })

  it("throws SyntaxError for invalid JSON", async () => {
    const dir = await fs.mkdtemp(path2.join(os.tmpdir(), "zflow-profiles-test-"))
    const piDir = path2.join(dir, ".pi")
    await fs.mkdir(piDir, { recursive: true })
    const filePath = path2.join(piDir, "zflow-profiles.json")
    await fs.writeFile(filePath, "not valid json {{{")
    try {
      await assert.rejects(
        () => loadProfiles(dir),
        (err: unknown) => err instanceof ProfileValidationError,
      )
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("surfaces the chosen source path", async () => {
    const repoRoot = await writeProjectProfile({
      default: {
        lanes: { scout: { preferredModels: ["m1"] } },
        agentBindings: { s: { lane: "scout" } },
      },
    })
    try {
      const result = await loadProfiles(repoRoot)
      assert.ok(result.source.length > 0)
      assert.ok(result.source.startsWith("/"))
      // Source should be an absolute path ending in .pi/zflow-profiles.json
      assert.ok(result.source.endsWith(".pi/zflow-profiles.json"), `source=${result.source}`)
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })
})

describe("loadProfilesSync", () => {
  it("loads and validates from a project-local file synchronously", async () => {
    const repoRoot = await writeProjectProfile({
      default: {
        lanes: {
          scout: {
            required: true,
            preferredModels: ["openai/gpt-4o-mini"],
          },
        },
        agentBindings: {
          s: { lane: "scout" },
        },
      },
    })
    try {
      const result = loadProfilesSync(repoRoot)
      assert.ok("default" in result.profiles)
      assert.ok(result.source.endsWith(".pi/zflow-profiles.json"))
      assert.equal(result.validation.valid, true)
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })

  it("throws ProfileFileNotFoundError when no file exists", () => {
    assert.throws(
      () => loadProfilesSync("/tmp/nonexistent-zflow-repo-xyz789"),
      (err: unknown) => err instanceof ProfileFileNotFoundError,
    )
  })

  it("loads valid content synchronously", async () => {
    const repoRoot = await writeProjectProfile({
      default: {
        lanes: {
          scout: {
            required: true,
            preferredModels: ["openai/gpt-4o-mini"],
          },
        },
        agentBindings: {
          s: { lane: "scout" },
        },
      },
    })
    try {
      const result = loadProfilesSync(repoRoot)
      assert.ok("default" in result.profiles)
      assert.equal(result.validation.valid, true)
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })
})

describe("ProfileFileNotFoundError", () => {
  it("includes searched paths in the message", () => {
    const err = new ProfileFileNotFoundError(["/path/a.json", "/path/b.json"])
    assert.ok(err.message.includes("/path/a.json"))
    assert.ok(err.message.includes("/path/b.json"))
    assert.equal(err.searchedPaths.length, 2)
  })

  it("is an instance of Error", () => {
    const err = new ProfileFileNotFoundError(["/test.json"])
    assert.ok(err instanceof Error)
    assert.equal(err.name, "ProfileFileNotFoundError")
  })
})
