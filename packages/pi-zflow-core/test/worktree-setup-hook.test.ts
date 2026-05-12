/**
 * Worktree setup hook contract tests.
 */
import * as assert from "node:assert"
import { test, describe } from "node:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import {
  DEFAULT_HOOK_TIMEOUT_MS,
  classifyRepo,
  runWorktreeSetupHook,
} from "../src/worktree-setup-hook.js"

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zflow-hook-test-"))
  try {
    return await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe("worktreeSetupHook defaults", () => {
  test("default timeout is 30 seconds", () => {
    assert.equal(DEFAULT_HOOK_TIMEOUT_MS, 30_000)
  })
})

describe("classifyRepo", () => {
  test("classifies pnpm workspace", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n")
      assert.equal(await classifyRepo(dir), "pnpm-workspace")
    })
  })

  test("classifies env-stub-required", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, ".env.example"), "KEY=value\n")
      assert.equal(await classifyRepo(dir), "env-stub-required")
    })
  })

  test("classifies plain TS/JS repo", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "package.json"), "{}\n")
      await fs.writeFile(path.join(dir, "tsconfig.json"), "{}\n")
      assert.equal(await classifyRepo(dir), "plain-ts-js")
    })
  })

  test("classifies unknown repo", async () => {
    await withTempDir(async (dir) => {
      assert.equal(await classifyRepo(dir), "unknown")
    })
  })
})

describe("runWorktreeSetupHook", () => {
  test("runs a shell hook successfully", async () => {
    await withTempDir(async (repoRoot) => {
      const script = path.join(repoRoot, "hook.sh")
      await fs.writeFile(script, "#!/usr/bin/env bash\necho worktree ready: $1\n")
      await fs.chmod(script, 0o755)

      const result = await runWorktreeSetupHook(
        { script: "hook.sh", runtime: "shell", timeoutMs: 5_000, description: "test hook" },
        { repoRoot, worktreeRoot: path.join(repoRoot, "wt"), ref: "HEAD" },
      )

      assert.equal(result.success, true)
      assert.match(result.message, /worktree ready/)
    })
  })

  test("returns actionable failure for missing hook", async () => {
    await withTempDir(async (repoRoot) => {
      const result = await runWorktreeSetupHook(
        { script: "missing.sh", runtime: "shell" },
        { repoRoot, worktreeRoot: path.join(repoRoot, "wt"), ref: "HEAD" },
      )

      assert.equal(result.success, false)
      assert.match(result.message, /not found or not executable/)
      assert.match(result.error?.hint ?? "", /chmod \+x/)
    })
  })

  test("runs a module hook successfully", async () => {
    await withTempDir(async (repoRoot) => {
      const script = path.join(repoRoot, "hook.mjs")
      await fs.writeFile(script, "export default function (ctx) { return { success: true, message: `module ready ${ctx.ref}` } }\n")
      await fs.chmod(script, 0o755)

      const result = await runWorktreeSetupHook(
        { script: "hook.mjs", runtime: "module", description: "module hook" },
        { repoRoot, worktreeRoot: path.join(repoRoot, "wt"), ref: "feature/test" },
      )

      assert.equal(result.success, true)
      assert.equal(result.message, "module ready feature/test")
    })
  })
})
