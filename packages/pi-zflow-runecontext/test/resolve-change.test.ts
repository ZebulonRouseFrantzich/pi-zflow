import * as assert from 'node:assert/strict'
import { test, describe, afterEach, beforeEach } from 'node:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

const { resolveRuneChange } = await import('../extensions/pi-runecontext/resolve-change.ts')

describe('resolveRuneChange', () => {
  let tmpDir: string
  let repoRoot: string
  let plainChangeDir: string
  let verifiedChangeDir: string
  let cwd: string

  beforeEach(async () => {
    cwd = process.cwd()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runectx-test-'))
    repoRoot = path.join(tmpDir, 'my-repo')

    await fs.mkdir(path.join(repoRoot, 'packages', 'my-pkg', 'changes'), { recursive: true })

    // Plain flavor change
    plainChangeDir = path.join(repoRoot, 'packages', 'my-pkg', 'changes', 'CHANGE-001')
    await fs.mkdir(plainChangeDir, { recursive: true })
    await fs.writeFile(path.join(plainChangeDir, 'proposal.md'), '# Proposal')
    await fs.writeFile(path.join(plainChangeDir, 'design.md'), '# Design')
    await fs.writeFile(path.join(plainChangeDir, 'standards.md'), '# Standards')
    await fs.writeFile(path.join(plainChangeDir, 'verification.md'), '# Verification')
    await fs.writeFile(path.join(plainChangeDir, 'status.yaml'), 'status: draft')

    // Verified flavor change
    verifiedChangeDir = path.join(repoRoot, 'packages', 'my-pkg', 'changes', 'CHANGE-002')
    await fs.mkdir(verifiedChangeDir, { recursive: true })
    await fs.writeFile(path.join(verifiedChangeDir, 'proposal.md'), '# Proposal')
    await fs.writeFile(path.join(verifiedChangeDir, 'design.md'), '# Design')
    await fs.writeFile(path.join(verifiedChangeDir, 'standards.md'), '# Standards')
    await fs.writeFile(path.join(verifiedChangeDir, 'verification.md'), '# Verification')
    await fs.writeFile(path.join(verifiedChangeDir, 'status.yaml'), 'status: review')
    await fs.writeFile(path.join(verifiedChangeDir, 'tasks.md'), '# Tasks')
    await fs.writeFile(path.join(verifiedChangeDir, 'references.md'), '# References')
  })

  afterEach(async () => {
    process.chdir(cwd)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('resolves explicit plain change path', async () => {
    const result = await resolveRuneChange({ repoRoot, changePath: plainChangeDir })
    assert.equal(result.flavor, 'plain')
    assert.equal(result.changePath, plainChangeDir)
    assert.ok(result.changeId.length > 0)
    assert.equal(result.files.proposal, path.join(plainChangeDir, 'proposal.md'))
    assert.equal(result.files.design, path.join(plainChangeDir, 'design.md'))
    assert.equal(result.files.standards, path.join(plainChangeDir, 'standards.md'))
    assert.equal(result.files.verification, path.join(plainChangeDir, 'verification.md'))
    assert.equal(result.files.status, path.join(plainChangeDir, 'status.yaml'))
    assert.equal(result.files.tasks, undefined)
    assert.equal(result.files.references, undefined)
  })

  test('resolves explicit verified change path', async () => {
    const result = await resolveRuneChange({ repoRoot, changePath: verifiedChangeDir })
    assert.equal(result.flavor, 'verified')
    assert.equal(result.changePath, verifiedChangeDir)
    assert.equal(result.files.tasks, path.join(verifiedChangeDir, 'tasks.md'))
    assert.equal(result.files.references, path.join(verifiedChangeDir, 'references.md'))
  })

  test('resolves change path relative to repoRoot', async () => {
    const relPath = path.relative(repoRoot, verifiedChangeDir)
    const result = await resolveRuneChange({ repoRoot, changePath: relPath })
    assert.equal(result.flavor, 'verified')
    assert.equal(result.changePath, verifiedChangeDir)
  })

  test('resolves change by walking up from CWD', async () => {
    process.chdir(verifiedChangeDir)
    const result = await resolveRuneChange({ repoRoot })
    assert.equal(result.flavor, 'verified')
    assert.equal(result.changePath, verifiedChangeDir)
  })

  test('resolves change by walking up from subdirectory of change folder', async () => {
    const subDir = path.join(verifiedChangeDir, 'subdir')
    await fs.mkdir(subDir, { recursive: true })
    process.chdir(subDir)
    const result = await resolveRuneChange({ repoRoot })
    assert.equal(result.flavor, 'verified')
    assert.equal(result.changePath, verifiedChangeDir)
  })

  test('throws when no change folder found and no explicit path', async () => {
    process.chdir(repoRoot)
    await assert.rejects(
      () => resolveRuneChange({ repoRoot }),
      /Cannot resolve RuneContext change folder/,
    )
  })

  test('throws when explicit path is not a valid change folder', async () => {
    const fakeDir = path.join(repoRoot, 'not-a-change')
    await fs.mkdir(fakeDir, { recursive: true })
    await assert.rejects(
      () => resolveRuneChange({ repoRoot, changePath: fakeDir }),
      /does not appear to be a RuneContext change folder/,
    )
  })

  test('throws when plain flavor is missing required files', async () => {
    await fs.rm(path.join(plainChangeDir, 'design.md'))
    await assert.rejects(
      () => resolveRuneChange({ repoRoot, changePath: plainChangeDir }),
      /Missing required RuneContext change file: "design.md"/,
    )
  })

  test('throws when verified flavor is missing extra required files', async () => {
    await fs.rm(path.join(verifiedChangeDir, 'references.md'))
    await assert.rejects(
      () => resolveRuneChange({ repoRoot, changePath: verifiedChangeDir }),
      /Missing required RuneContext change file: "references.md"/,
    )
  })

  test('generates changeId containing path context for monorepo safety', async () => {
    const result = await resolveRuneChange({ repoRoot, changePath: plainChangeDir })
    assert.ok(result.changeId.includes('CHANGE-001'))
    assert.ok(!result.changeId.includes('/'))
    assert.ok(!result.changeId.includes('\\'))
    assert.ok(/^[a-zA-Z0-9_\-]+$/.test(result.changeId))
  })

  test('generates different changeIds for different change folders', async () => {
    const r1 = await resolveRuneChange({ repoRoot, changePath: plainChangeDir })
    const r2 = await resolveRuneChange({ repoRoot, changePath: verifiedChangeDir })
    assert.notEqual(r1.changeId, r2.changeId)
  })
})
