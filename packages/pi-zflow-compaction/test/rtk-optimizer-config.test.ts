import { describe, it } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"

describe("rtk-optimizer-config", () => {
  it("config policy document exists and documents key settings", async () => {
    const docPath = path.resolve(
      import.meta.dirname,
      "../../../docs/rtk-optimizer-config.md",
    )
    const content = await fs.readFile(docPath, "utf-8")
    assert.ok(content.includes("pi-rtk-optimizer"), "mentions the optimizer package")
    assert.ok(content.includes("readCompaction"), "documents readCompaction setting")
    assert.ok(content.includes("sourceCodeFiltering"), "documents sourceCodeFiltering")
    assert.ok(content.includes("12000"), "documents truncation limit")
  })

  it("recommended config file is valid JSON with expected structure", async () => {
    const configPath = path.resolve(
      import.meta.dirname,
      "../../../docs/rtk-optimizer-recommended-config.json",
    )
    const content = await fs.readFile(configPath, "utf-8")
    const config = JSON.parse(content)
    assert.equal(config.enabled, true)
    assert.equal(config.mode, "rewrite")
    assert.equal(config.outputCompaction.enabled, true)
    assert.equal(config.outputCompaction.readCompaction.enabled, false)
    assert.equal(config.outputCompaction.sourceCodeFilteringEnabled, false)
    assert.equal(config.outputCompaction.truncate.maxChars, 12000)
  })
})
