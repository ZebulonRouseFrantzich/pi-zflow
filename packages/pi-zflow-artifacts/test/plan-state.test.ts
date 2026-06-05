/**
 * plan-state.test.ts — Plan-state metadata persistence tests.
 */
import { describe, it } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { execFileSync } from "node:child_process"

import { resolvePlanStatePath } from "../src/artifact-paths.js"
import { recordArtifactMetadata } from "../src/plan-state.js"

async function createTestRepo(): Promise<string> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-plan-state-"))
  execFileSync("git", ["init"], { cwd: repoRoot, stdio: "pipe" })
  return repoRoot
}

describe("recordArtifactMetadata", () => {
  it("serializes concurrent updates without corrupting plan-state.json", async () => {
    const repoRoot = await createTestRepo()
    try {
      const changeId = "concurrent-plan-state"
      const planVersion = "v1"
      const artifacts = [
        "design",
        "execution-groups",
        "standards",
        "verification",
        "implementation-tasks",
      ] as const

      await Promise.all(artifacts.map((artifact, index) =>
        recordArtifactMetadata(changeId, planVersion, artifact, `hash-${index}`, repoRoot)
      ))

      const raw = await fs.readFile(resolvePlanStatePath(changeId, repoRoot), "utf-8")
      const parsed = JSON.parse(raw) as {
        versions: Record<string, { artifacts: Record<string, { hash: string }> }>
      }
      assert.deepEqual(
        Object.keys(parsed.versions.v1.artifacts).sort(),
        [...artifacts].sort(),
      )
      for (const [index, artifact] of artifacts.entries()) {
        assert.equal(parsed.versions.v1.artifacts[artifact].hash, `hash-${index}`)
      }
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })
})
