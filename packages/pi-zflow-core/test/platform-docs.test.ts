/**
 * Platform docs tests — section building, deduplication, path handling.
 */
import * as assert from "node:assert"
import { test, describe } from "node:test"
import {
  buildPlatformDocsSection,
  isPlatformDocsInjected,
  DEFAULT_DOCS_MARKER,
} from "../src/platform-docs.js"

describe("buildPlatformDocsSection", () => {
  const pi = {
    readmePath: "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/README.md",
    docsPath: "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/docs",
    examplesPath: "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/examples",
  }

  const zflow = {
    implementationPlanPath: "/home/user/project/pi-config-implementation-plan.md",
    packageSplitContractPath: "/home/user/project/implementation-phases/package-split-details.md",
    agentsPath: "/home/user/project/packages/pi-zflow-agents/agents",
    promptFragmentsPath: "/home/user/project/packages/pi-zflow-agents/prompt-fragments",
    skillsPath: "/home/user/project/packages/pi-zflow-agents/skills",
  }

  test("builds full section with Pi and zflow paths", () => {
    const result = buildPlatformDocsSection({ pi, zflow })
    assert.ok(result.length > 0)
    assert.ok(result.includes("## Platform Documentation"))
    assert.ok(result.includes("Pi documentation"))
    assert.ok(result.includes("Pi Zflow documentation"))
    assert.ok(result.includes(pi.readmePath))
    assert.ok(result.includes(pi.docsPath))
    assert.ok(result.includes(pi.examplesPath))
    assert.ok(result.includes(zflow.implementationPlanPath!))
    assert.ok(result.includes(zflow.agentsPath!))
    assert.ok(result.includes(zflow.promptFragmentsPath!))
    assert.ok(result.includes(zflow.skillsPath!))
    assert.ok(result.includes(DEFAULT_DOCS_MARKER))
    assert.ok(result.includes("read the docs and examples"))
  })

  test("builds Pi-only section when zflow paths are empty", () => {
    const result = buildPlatformDocsSection({
      pi,
      zflow: {},
    })
    assert.ok(result.includes("Pi documentation"))
    assert.ok(!result.includes("Pi Zflow documentation"))
    assert.ok(result.includes(DEFAULT_DOCS_MARKER))
  })

  test("builds zflow-only section when Pi paths are empty", () => {
    const result = buildPlatformDocsSection({
      pi: { readmePath: "", docsPath: "", examplesPath: "" },
      zflow,
    })
    assert.ok(result.includes("Pi Zflow documentation"))
    assert.ok(!result.includes("Pi documentation"))
    assert.ok(result.includes(DEFAULT_DOCS_MARKER))
  })

  test("returns empty string when no paths are available", () => {
    const result = buildPlatformDocsSection({
      pi: { readmePath: "", docsPath: "", examplesPath: "" },
      zflow: {},
    })
    assert.equal(result, "")
  })

  test("returns empty string when only readmePath is empty but other paths exist", () => {
    // readmePath empty but docsPath exists — still builds
    const result = buildPlatformDocsSection({
      pi: { readmePath: "", docsPath: pi.docsPath, examplesPath: pi.examplesPath },
      zflow: {},
    })
    assert.ok(result.length > 0)
    assert.ok(result.includes("Additional docs"))
  })

  test("uses custom marker", () => {
    const customMarker = "<!-- custom-marker -->"
    const result = buildPlatformDocsSection({
      pi,
      zflow: {},
      marker: customMarker,
    })
    assert.ok(result.includes(customMarker))
    assert.ok(!result.includes(DEFAULT_DOCS_MARKER))
  })

  test("section starts with a leading newline", () => {
    const result = buildPlatformDocsSection({ pi, zflow })
    assert.ok(result.startsWith("\n"))
  })

  test("includes Pi doc topics reference", () => {
    const result = buildPlatformDocsSection({ pi, zflow })
    assert.ok(result.includes("extensions"))
    assert.ok(result.includes("themes"))
    assert.ok(result.includes("skills"))
    assert.ok(result.includes("TUI"))
    assert.ok(result.includes("keybindings"))
    assert.ok(result.includes("SDK"))
    assert.ok(result.includes("custom provider"))
    assert.ok(result.includes("models"))
    assert.ok(result.includes("packages"))
  })
})

describe("isPlatformDocsInjected", () => {
  test("returns true when marker is present", () => {
    const prompt = `some prompt text\n${DEFAULT_DOCS_MARKER}\nmore text`
    assert.ok(isPlatformDocsInjected(prompt))
  })

  test("returns false when marker is absent", () => {
    const prompt = "some prompt text without marker"
    assert.ok(!isPlatformDocsInjected(prompt))
  })

  test("returns false for empty string", () => {
    assert.ok(!isPlatformDocsInjected(""))
  })

  test("uses custom marker when provided", () => {
    const marker = "<!-- custom -->"
    const prompt = `text\n${marker}`
    assert.ok(isPlatformDocsInjected(prompt, marker))
    assert.ok(!isPlatformDocsInjected(prompt))
  })
})
