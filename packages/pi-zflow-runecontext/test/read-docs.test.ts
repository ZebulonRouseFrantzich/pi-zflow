import * as assert from 'node:assert/strict'
import { test, describe, afterEach, beforeEach } from 'node:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

const { readRuneContextDocs } = await import('../extensions/pi-runecontext/read-docs.ts')
const { resolveRuneChange } = await import('../extensions/pi-runecontext/resolve-change.ts')

describe('readRuneContextDocs', () => {
  let tmpDir: string
  let repoRoot: string
  let plainChangeDir: string
  let verifiedChangeDir: string
  let cwd: string

  beforeEach(async () => {
    cwd = process.cwd()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runectx-read-test-'))
    repoRoot = path.join(tmpDir, 'my-repo')

    await fs.mkdir(path.join(repoRoot, 'changes'), { recursive: true })

    // Plain flavor change
    plainChangeDir = path.join(repoRoot, 'changes', 'CHANGE-PLAIN')
    await fs.mkdir(plainChangeDir, { recursive: true })
    await fs.writeFile(path.join(plainChangeDir, 'proposal.md'), '# Proposal\ndescription: A simple proposal')
    await fs.writeFile(path.join(plainChangeDir, 'design.md'), '# Design\narchitecture: simple')
    await fs.writeFile(path.join(plainChangeDir, 'standards.md'), '# Standards\n- follow eslint\n- use typescript')
    await fs.writeFile(path.join(plainChangeDir, 'verification.md'), '# Verification\n- test coverage >= 80%')
    await fs.writeFile(path.join(plainChangeDir, 'status.yaml'), 'status: draft\npriority: medium')

    // Verified flavor change
    verifiedChangeDir = path.join(repoRoot, 'changes', 'CHANGE-VERIFIED')
    await fs.mkdir(verifiedChangeDir, { recursive: true })
    await fs.writeFile(path.join(verifiedChangeDir, 'proposal.md'), '# Verified Proposal')
    await fs.writeFile(path.join(verifiedChangeDir, 'design.md'), '# Verified Design')
    await fs.writeFile(path.join(verifiedChangeDir, 'standards.md'), '# Verified Standards')
    await fs.writeFile(path.join(verifiedChangeDir, 'verification.md'), '# Verified Verification')
    await fs.writeFile(path.join(verifiedChangeDir, 'status.yaml'), 'status: review\nreviewers:\n  - alice\n  - bob')
    await fs.writeFile(path.join(verifiedChangeDir, 'tasks.md'), '# Tasks\n- [ ] implement feature')
    await fs.writeFile(path.join(verifiedChangeDir, 'references.md'), '# References\n- RFC 1234')
  })

  afterEach(async () => {
    process.chdir(cwd)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('reads all docs for plain flavor', async () => {
    const change = await resolveRuneChange({ repoRoot, changePath: plainChangeDir })
    const docs = await readRuneContextDocs(change)

    assert.equal(docs.proposal, '# Proposal\ndescription: A simple proposal')
    assert.equal(docs.design, '# Design\narchitecture: simple')
    assert.equal(docs.standards, '# Standards\n- follow eslint\n- use typescript')
    assert.equal(docs.verification, '# Verification\n- test coverage >= 80%')
    assert.equal(docs.tasks, null)
    assert.equal(docs.references, null)
  })

  test('reads all docs for verified flavor', async () => {
    const change = await resolveRuneChange({ repoRoot, changePath: verifiedChangeDir })
    const docs = await readRuneContextDocs(change)

    assert.equal(docs.proposal, '# Verified Proposal')
    assert.equal(docs.design, '# Verified Design')
    assert.equal(docs.standards, '# Verified Standards')
    assert.equal(docs.verification, '# Verified Verification')
    assert.equal(docs.tasks, '# Tasks\n- [ ] implement feature')
    assert.equal(docs.references, '# References\n- RFC 1234')
  })

  test('parses status.yaml as structured data for plain flavor', async () => {
    const change = await resolveRuneChange({ repoRoot, changePath: plainChangeDir })
    const docs = await readRuneContextDocs(change)

    assert.equal(typeof docs.status, 'object')
    assert.equal(docs.status.status, 'draft')
    assert.equal(docs.status.priority, 'medium')
  })

  test('parses status.yaml as structured data for verified flavor', async () => {
    const change = await resolveRuneChange({ repoRoot, changePath: verifiedChangeDir })
    const docs = await readRuneContextDocs(change)

    assert.equal(typeof docs.status, 'object')
    assert.equal(docs.status.status, 'review')
    assert.ok(Array.isArray(docs.status.reviewers))
    assert.equal(docs.status.reviewers[0], 'alice')
    assert.equal(docs.status.reviewers[1], 'bob')
  })

  test('handles minimal status.yaml content', async () => {
    const minimalDir = path.join(repoRoot, 'changes', 'CHANGE-MINIMAL')
    await fs.mkdir(minimalDir, { recursive: true })
    await fs.writeFile(path.join(minimalDir, 'proposal.md'), '# P')
    await fs.writeFile(path.join(minimalDir, 'design.md'), '# D')
    await fs.writeFile(path.join(minimalDir, 'standards.md'), '# S')
    await fs.writeFile(path.join(minimalDir, 'verification.md'), '# V')
    await fs.writeFile(path.join(minimalDir, 'status.yaml'), 'status: active')

    const change = await resolveRuneChange({ repoRoot, changePath: minimalDir })
    const docs = await readRuneContextDocs(change)

    assert.equal(docs.status.status, 'active')
    assert.equal(docs.tasks, null)
  })

  test('tasks field is null for plain flavor, string for verified', async () => {
    const plain = await resolveRuneChange({ repoRoot, changePath: plainChangeDir })
    const verified = await resolveRuneChange({ repoRoot, changePath: verifiedChangeDir })

    const plainDocs = await readRuneContextDocs(plain)
    const verifiedDocs = await readRuneContextDocs(verified)

    assert.equal(plainDocs.tasks, null)
    assert.equal(typeof verifiedDocs.tasks, 'string')
    assert.ok(verifiedDocs.tasks.length > 0)
  })

  test('references field is null for plain flavor, string for verified', async () => {
    const plain = await resolveRuneChange({ repoRoot, changePath: plainChangeDir })
    const verified = await resolveRuneChange({ repoRoot, changePath: verifiedChangeDir })

    const plainDocs = await readRuneContextDocs(plain)
    const verifiedDocs = await readRuneContextDocs(verified)

    assert.equal(plainDocs.references, null)
    assert.equal(typeof verifiedDocs.references, 'string')
    assert.ok(verifiedDocs.references.length > 0)
  })
})
