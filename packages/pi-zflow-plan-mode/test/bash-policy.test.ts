/**
 * bash-policy.test.ts — Tests for plan-mode restricted bash policy.
 *
 * @module pi-zflow-plan-mode/test/bash-policy
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { validatePlanModeBash } from "../extensions/zflow-plan-mode/bash-policy.js"

void describe("validatePlanModeBash", () => {
  void describe("allowed commands (read-only)", () => {
    const allowedCommands = [
      // Basic file reading
      ["cat file.ts", "cat with file argument"],
      ["cat -n file.ts", "cat with flags"],
      ["ls -la", "ls with flags"],
      ["grep -r pattern src/", "grep recursive"],
      ["find . -name '*.ts'", "find with name filter"],
      ["rg --type ts pattern", "ripgrep search"],

      // Git read-only
      ["git log --oneline -5", "git log with flags"],
      ["git diff", "git diff (no args)"],
      ["git diff HEAD~1 HEAD", "git diff with refs"],
      ["git diff --cached", "git diff staged"],
      ["git status", "git status"],
      ["git status --short", "git status short"],
      ["git show HEAD", "git show"],
      ["git blame src/index.ts", "git blame"],
      ["git ls-files", "git ls-files"],
      ["git branch --list", "git branch list"],
      ["git branch -a", "git branch all"],
      ["git tag --list", "git tag list"],

      // Other read-only
      ["pwd", "print working directory"],
      ["which node", "find executable"],
      ["node --version", "check node version"],
      ["npm ls", "list installed packages (read-only)"],
      ["npx tsx --test some.test.ts", "run tests"],
      ["echo hello", "echo (no redirection)"],

      // Input redirection (read-only)
      ["grep pattern < file.ts", "grep with input redirection"],
      ["sort < data.txt", "sort with input redirection"],
      ["wc -l < file.ts", "wc with input redirection"],
      ["cat < file.ts", "cat with input redirection"],
      ["cat << EOF", "heredoc (input redirection)"],
      ["env", "list environment variables"],
      ["file some-file.ts", "detect file type"],
    ]

    for (const [command, description] of allowedCommands) {
      void it(`allows: ${description}`, () => {
        const result = validatePlanModeBash(command)
        assert.ok(result.allowed, `Expected "${command}" to be allowed, got: ${result.reason}`)
      })
    }
  })

  void describe("blocked commands (mutations)", () => {
    const blockedCommands: Array<[string, string]> = [
      // Redirections
      ["> output.txt", "stdout redirection"],
      ["cat > output.txt", "stdout redirection to file"],
      ["echo hello > file.txt", "echo with redirection"],
      [">> log.txt", "append redirection"],
      ["ls >> list.txt", "append redirection from ls"],

      // tee
      ["command | tee output.txt", "tee with file output"],

      // Git write commands
      ["git commit -m 'fix'", "git commit"],
      ["git add .", "git add"],
      ["git checkout feature", "git checkout branch"],
      ["git checkout -- file.ts", "git checkout file"],
      ["git reset HEAD~1", "git reset"],
      ["git merge feature", "git merge"],
      ["git rebase main", "git rebase"],
      ["git push origin main", "git push"],
      ["git fetch origin", "git fetch"],
      ["git pull origin main", "git pull"],

      // Destructive file operations
      ["rm file.ts", "rm single file"],
      ["rm -rf node_modules/", "rm -rf recursive"],
      ["mv file.ts new.ts", "mv file"],
      ["cp file.ts backup.ts", "cp file"],
      ["mkdir new-dir", "mkdir"],
      ["rmdir empty-dir", "rmdir"],
      ["chmod +x script.sh", "chmod"],
      ["chown user:group file", "chown"],

      // Package installs
      ["npm install some-pkg", "npm install"],
      ["npm ci", "npm ci"],
      ["npm update", "npm update"],
      ["pnpm add some-pkg", "pnpm add"],
      ["pnpm install", "pnpm install"],
      ["yarn add some-pkg", "yarn add"],

      // Editors
      ["vi file.ts", "vi editor"],
      ["vim file.ts", "vim editor"],
      ["nano file.ts", "nano editor"],
      ["code .", "VS Code"],
    ]

    for (const [command, description] of blockedCommands) {
      void it(`blocks: ${description}`, () => {
        const result = validatePlanModeBash(command)
        assert.ok(!result.allowed, `Expected "${command}" to be blocked`)
        assert.ok(result.reason, `Expected a reason for blocking "${command}"`)
      })
    }
  })

  void describe("edge cases", () => {
    void it("allows empty command", () => {
      assert.ok(validatePlanModeBash("").allowed)
    })

    void it("allows whitespace-only command", () => {
      assert.ok(validatePlanModeBash("   ").allowed)
    })

    void it("blocks output redirection in complex pipeline", () => {
      const result = validatePlanModeBash("cat file.txt | grep pattern > output.txt")
      assert.ok(!result.allowed)
      assert.ok(result.reason?.includes("output redirection"))
    })

    void it("blocks npm install with explicit version", () => {
      const result = validatePlanModeBash("npm install some-pkg@latest")
      assert.ok(!result.allowed)
    })

    void it("allows git status with verbose flag", () => {
      assert.ok(validatePlanModeBash("git status --verbose").allowed)
    })

    void it("allows cat with a specific path", () => {
      assert.ok(validatePlanModeBash("cat /some/path/file.ts").allowed)
    })
  })
})
