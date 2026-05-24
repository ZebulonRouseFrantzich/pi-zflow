/**
 * verification.test.ts — Verification command execution tests.
 *
 * @module pi-zflow-change-workflows/test/verification
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import {
  runVerification,
  parseVerificationMdCommand,
  resolveVerificationCommand,
  execAsync,
  detectDevServerSmoke,
} from "../extensions/zflow-change-workflows/verification.js"

function withTempRepo(): { repoRoot: string; cleanup: () => void } {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "zflow-verification-test-"))
  return {
    repoRoot,
    cleanup: () => rmSync(repoRoot, { recursive: true, force: true }),
  }
}

void describe("runVerification", () => {
  void it("captures stdout and stderr when shell verification passes", async () => {
    const { repoRoot, cleanup } = withTempRepo()
    try {
      const result = await runVerification(
        "printf 'stdout-ok'; printf 'stderr-ok' >&2",
        repoRoot,
      )

      assert.equal(result.pass, true)
      assert.match(result.output, /stdout-ok/)
      assert.match(result.output, /stderr-ok/)
      assert.equal(result.error, undefined)
    } finally {
      cleanup()
    }
  })

  void it("captures stdout and stderr when shell verification fails", async () => {
    const { repoRoot, cleanup } = withTempRepo()
    try {
      const result = await runVerification(
        "printf 'stdout-fail'; printf 'stderr-fail' >&2; exit 7",
        repoRoot,
      )

      assert.equal(result.pass, false)
      assert.match(result.output, /stdout-fail/)
      assert.match(result.output, /stderr-fail/)
      assert.match(result.error ?? "", /exit code 7/)
    } finally {
      cleanup()
    }
  })

  void it("captures stdout and stderr when argv verification passes", async () => {
    const { repoRoot, cleanup } = withTempRepo()
    try {
      const result = await runVerification(
        { command: "node", args: ["-e", "console.log('argv-ok')"] },
        repoRoot,
      )

      assert.equal(result.pass, true)
      assert.match(result.output, /argv-ok/)
      assert.equal(result.error, undefined)
    } finally {
      cleanup()
    }
  })

  void it("captures stdout and stderr when argv verification fails", async () => {
    const { repoRoot, cleanup } = withTempRepo()
    try {
      const result = await runVerification(
        { command: "node", args: ["-e", "process.exit(3)"] },
        repoRoot,
      )

      assert.equal(result.pass, false)
      assert.match(result.error ?? "", /exit code 3/)
    } finally {
      cleanup()
    }
  })

  void it("treats shell metacharacters in argv args as literal text (no shell interpretation)", async () => {
    const { repoRoot, cleanup } = withTempRepo()
    try {
      // Pass a semicolon as a literal argument — if it went through a shell
      // the semicolon would separate commands.  spawnSync keeps it literal.
      const result = await runVerification(
        { command: "node", args: ["-e",
          "const sep = process.argv[1]; console.log('literal:', JSON.stringify(sep))",
          "; echo 'this-should-not-run'"] },
        repoRoot,
      )

      assert.equal(result.pass, true)
      // The semicolon should appear literally, not cause a second command
      assert.match(result.output, /"; echo/)
      // Only the intended output should be present
      assert.match(result.output, /literal:/)
    } finally {
      cleanup()
    }
  })

  void it("serialises argv commands to a human-readable display string", async () => {
    const { repoRoot, cleanup } = withTempRepo()
    try {
      const result = await runVerification(
        { command: "node", args: ["-e", "true"] },
        repoRoot,
      )

      assert.match(result.command, /^node -e true$/)
    } finally {
      cleanup()
    }
  })
})

void describe("detectDevServerSmoke", () => {
  void it("rejects just cf-dev with curl", () => {
    const result = detectDevServerSmoke("just cf-dev then curl -fsS http://127.0.0.1:8787/health")
    assert.equal(result.detected, true)
    assert.ok(result.reason)
    assert.match(result.reason!, /dev-server/i)
  })

  void it("rejects wrangler dev", () => {
    const result = detectDevServerSmoke("wrangler dev")
    assert.equal(result.detected, true)
  })

  void it("rejects npm run dev", () => {
    const result = detectDevServerSmoke("npm run dev")
    assert.equal(result.detected, true)
  })

  void it("rejects pnpm --dir dev command", () => {
    const result = detectDevServerSmoke("pnpm --dir apps/api run dev")
    assert.equal(result.detected, true)
  })

  void it("rejects vite", () => {
    const result = detectDevServerSmoke("vite")
    assert.equal(result.detected, true)
  })

  void it("allows normal test commands", () => {
    const result = detectDevServerSmoke("npm test")
    assert.equal(result.detected, false)
  })

  void it("allows typecheck commands", () => {
    const result = detectDevServerSmoke("pnpm --dir apps/api typecheck")
    assert.equal(result.detected, false)
  })

  void it("allows just ci-fast", () => {
    const result = detectDevServerSmoke("just ci-fast")
    assert.equal(result.detected, false)
  })

  void it("allows plain curl without dev server", () => {
    const result = detectDevServerSmoke("curl -fsS http://localhost:8787/health")
    assert.equal(result.detected, false)
  })
})

void describe("execAsync", () => {
  void it("captures stdout from a normal command", async () => {
    const result = await execAsync("echo", ["hello"], { cwd: "/tmp" })
    assert.ok(result.stdout.includes("hello"))
    assert.equal(result.status, 0)
    assert.equal(result.killed, false)
  })

  void it("captures stderr from a failing command", async () => {
    const result = await execAsync("bash", ["-c", "echo fail-message >&2; exit 5"], { cwd: "/tmp" })
    assert.ok(result.stderr.includes("fail-message"))
    assert.equal(result.status, 5)
    assert.equal(result.killed, false)
  })

  void it("times out and kills a long-running command", async () => {
    const start = Date.now()
    const result = await execAsync("bash", ["-c", "sleep 30"], {
      cwd: "/tmp",
      timeout: 500,
    })
    const elapsed = Date.now() - start
    assert.equal(result.killed, true)
    assert.ok(elapsed < 10000, `should complete before 10s (took ${elapsed}ms)`)
  })

  void it("respects an AbortSignal and kills the process", async () => {
    const ac = new AbortController()
    const promise = execAsync("bash", ["-c", "sleep 30"], {
      cwd: "/tmp",
      signal: ac.signal,
    })
    ac.abort()
    const result = await promise
    assert.equal(result.killed, true)
  })
})

void describe("runVerification — dev-server protection", () => {
  void it("skips dev-server commands with a clear fail result", async () => {
    const { repoRoot, cleanup } = withTempRepo()
    try {
      const result = await runVerification(
        "just cf-dev && curl http://localhost:8787/health",
        repoRoot,
      )
      assert.equal(result.pass, false)
      assert.ok(result.error!.includes("Dev-server command detected"))
    } finally {
      cleanup()
    }
  })
})

void describe("parseVerificationMdCommand", () => {
  void it("extracts bash-fenced block", () => {
    const md = `# Verification\n\nRun this:\n\`\`\`bash\nnpm run verify:readme && test -f src/lib.ts\n\`\`\``
    const result = parseVerificationMdCommand(md)
    assert.equal(result, "npm run verify:readme && test -f src/lib.ts")
  })

  void it("extracts sh-fenced block", () => {
    const md = "`\`\`sh\nmake check\n\`\`\`"
    const result = parseVerificationMdCommand(md)
    assert.equal(result, "make check")
  })

  void it("extracts shell-fenced block", () => {
    const md = "`\`\`shell\necho hello\n\`\`\`"
    const result = parseVerificationMdCommand(md)
    assert.equal(result, "echo hello")
  })

  void it("returns null for markdown with no fenced code block", () => {
    const result = parseVerificationMdCommand("# Verification\n\nNo commands here.")
    assert.equal(result, null)
  })

  void it("returns null for empty bash block", () => {
    const md = "`\`\`bash\n\n\`\`\`"
    const result = parseVerificationMdCommand(md)
    assert.equal(result, null)
  })

  void it("extracts first fenced block when multiple exist", () => {
    const md = "`\`\`bash\nfirst command\n\`\`\`\n\n`\`\`bash\nsecond command\n\`\`\`"
    const result = parseVerificationMdCommand(md)
    assert.equal(result, "first command")
  })

  void it("extracts from CRLF file", () => {
    const md = "# Verification\r\n\r\nRun this:\r\n`\`\`bash\r\nnpm run verify:readme\r\n`\`\`\r\n"
    const result = parseVerificationMdCommand(md)
    assert.equal(result, "npm run verify:readme")
  })

  void it("extracts from CRLF file with shell fence", () => {
    const md = "`\`\`shell\r\necho hello\r\n`\`\`\r\n"
    const result = parseVerificationMdCommand(md)
    assert.equal(result, "echo hello")
  })
})

void describe("resolveVerificationCommand with planCommand", () => {
  void it("returns planCommand when no profile or repo config", () => {
    const { repoRoot, cleanup } = withTempRepo()
    try {
      const result = resolveVerificationCommand(repoRoot, undefined, "npm test")
      assert.equal(result, "npm test")
    } finally {
      cleanup()
    }
  })

  void it("prefers profileCommand over planCommand", () => {
    const { repoRoot, cleanup } = withTempRepo()
    try {
      const result = resolveVerificationCommand(repoRoot, "profile-cmd", "plan-cmd")
      assert.equal(result, "profile-cmd")
    } finally {
      cleanup()
    }
  })

  void it("returns null when no source provides a command", () => {
    const { repoRoot, cleanup } = withTempRepo()
    try {
      const result = resolveVerificationCommand(repoRoot)
      assert.equal(result, null)
    } finally {
      cleanup()
    }
  })
})
