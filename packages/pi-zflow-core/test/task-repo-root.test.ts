import { describe, test } from "node:test"
import * as assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import {
  inferClaimedFileRepoRoots,
  inferTaskRepoRoot,
} from "../src/task-repo-root.js"

function initGitRepo(repoRoot: string): void {
  fs.mkdirSync(repoRoot, { recursive: true })
  execFileSync("git", ["init"], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] })
  execFileSync("git", ["config", "user.name", "Pi Zflow Test"], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] })
  execFileSync("git", ["config", "user.email", "pi-zflow-test@example.com"], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] })
}

describe("task repo-root inference helpers", () => {
  test("returns explicit cwd when provided", () => {
    const sharedCwd = "/tmp/workspace-root"
    assert.equal(
      inferTaskRepoRoot(sharedCwd, { cwd: "nested/repo" }),
      path.resolve(sharedCwd, "nested/repo"),
    )
  })

  test("discovers a nested git repo from claimed files", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-zflow-task-root-"))
    const workspaceRoot = path.join(tempRoot, "workspace")
    const nestedRepoRoot = path.join(workspaceRoot, "services", "api-client")
    initGitRepo(nestedRepoRoot)
    fs.mkdirSync(path.join(nestedRepoRoot, "src"), { recursive: true })
    fs.writeFileSync(path.join(nestedRepoRoot, "package.json"), "{}\n", "utf-8")

    assert.deepEqual(
      inferClaimedFileRepoRoots(workspaceRoot, ["services/api-client/src/index.ts"]),
      [nestedRepoRoot],
    )
    assert.equal(
      inferTaskRepoRoot(workspaceRoot, {
        claimedFiles: ["services/api-client/src/index.ts"],
      }),
      nestedRepoRoot,
    )
  })

  test("throws when claimed files span multiple nested git repos", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-zflow-task-root-"))
    const workspaceRoot = path.join(tempRoot, "workspace")
    const repoA = path.join(workspaceRoot, "services", "api-client")
    const repoB = path.join(workspaceRoot, "services", "worker-client")
    initGitRepo(repoA)
    initGitRepo(repoB)
    fs.mkdirSync(path.join(repoA, "src"), { recursive: true })
    fs.mkdirSync(path.join(repoB, "src"), { recursive: true })

    assert.throws(
      () => inferTaskRepoRoot(workspaceRoot, {
        claimedFiles: [
          "services/api-client/src/index.ts",
          "services/worker-client/src/index.ts",
        ],
      }),
      /span multiple git repositories/i,
    )
  })
})
