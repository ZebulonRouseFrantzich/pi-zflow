import * as assert from 'node:assert/strict'
import { test, describe } from 'node:test'
import * as path from 'node:path'
import * as os from 'node:os'

const {
  isWriteAllowedInRuneContextTree,
  validateRuneContextWriteTarget,
  getForbiddenArtifacts,
} = await import('../extensions/pi-runecontext/guards.ts')

const { listCanonicalDocNames } = await import('../extensions/pi-runecontext/precedence.ts')

describe('isWriteAllowedInRuneContextTree', () => {
  test('rejects known runtime artifacts', () => {
    assert.equal(isWriteAllowedInRuneContextTree('run.json'), false)
    assert.equal(isWriteAllowedInRuneContextTree('plan-state.json'), false)
    assert.equal(isWriteAllowedInRuneContextTree('state-index.json'), false)
    assert.equal(isWriteAllowedInRuneContextTree('execution-groups.md'), false)
    assert.equal(isWriteAllowedInRuneContextTree('deviation-report.md'), false)
    assert.equal(isWriteAllowedInRuneContextTree('review-findings.md'), false)
    assert.equal(isWriteAllowedInRuneContextTree('repo-map.md'), false)
    assert.equal(isWriteAllowedInRuneContextTree('reconnaissance.md'), false)
  })

  test('allows canonical RuneContext docs', () => {
    assert.equal(isWriteAllowedInRuneContextTree('proposal.md'), true)
    assert.equal(isWriteAllowedInRuneContextTree('design.md'), true)
    assert.equal(isWriteAllowedInRuneContextTree('standards.md'), true)
    assert.equal(isWriteAllowedInRuneContextTree('verification.md'), true)
    assert.equal(isWriteAllowedInRuneContextTree('tasks.md'), true)
    assert.equal(isWriteAllowedInRuneContextTree('references.md'), true)
    assert.equal(isWriteAllowedInRuneContextTree('status.yaml'), true)
  })

  test('rejects unrecognised files inside the tree', () => {
    // The guard now fails closed — only canonical docs are allowed
    assert.equal(isWriteAllowedInRuneContextTree('package.json'), false)
    assert.equal(isWriteAllowedInRuneContextTree('README.md'), false)
    assert.equal(isWriteAllowedInRuneContextTree('notes.txt'), false)
    assert.equal(isWriteAllowedInRuneContextTree('.gitkeep'), false)
    assert.equal(isWriteAllowedInRuneContextTree('src/index.ts'), false)
  })
})

describe('validateRuneContextWriteTarget', () => {
  const changePath = path.join(os.tmpdir(), 'runecontext-test-change')

  test('rejects runtime artifacts inside change tree', () => {
    const targetPath = path.join(changePath, 'run.json')
    const result = validateRuneContextWriteTarget(targetPath, changePath)

    assert.equal(result.allowed, false)
    assert.ok(result.reason.includes('run.json'))
    assert.ok(result.reason.includes('canonical RuneContext doc'))
  })

  test('rejects unrecognised files inside change tree', () => {
    const targetPath = path.join(changePath, 'notes.txt')
    const result = validateRuneContextWriteTarget(targetPath, changePath)

    assert.equal(result.allowed, false)
    assert.ok(result.reason.includes('notes.txt'))
    assert.ok(result.reason.includes('canonical RuneContext doc'))
  })

  test('allows canonical docs inside change tree', () => {
    const targetPath = path.join(changePath, 'proposal.md')
    const result = validateRuneContextWriteTarget(targetPath, changePath)

    assert.equal(result.allowed, true)
    assert.equal(result.reason, '')
  })

  test('allows writes outside change tree', () => {
    const targetPath = path.join(os.tmpdir(), 'some-other-dir', 'run.json')
    const result = validateRuneContextWriteTarget(targetPath, changePath)

    assert.equal(result.allowed, true)
    assert.equal(result.reason, '')
  })

  test('allows writes at the change path itself for canonical files', () => {
    // When target === changePath (not a subpath), basename is the dir name
    const result = validateRuneContextWriteTarget(changePath, changePath)
    // The target is exactly the change path, not a file inside it
    // Since the target is not inside the change tree (it IS the change tree),
    // it's allowed
    assert.equal(result.allowed, true)
  })

  test('rejects all non-canonical files inside change tree', () => {
    const canonical = listCanonicalDocNames()
    const nonCanonical = [
      'run.json',
      'plan-state.json',
      'state-index.json',
      'execution-groups.md',
      'deviation-report.md',
      'review-findings.md',
      'repo-map.md',
      'reconnaissance.md',
      'notes.txt',
      'package.json',
      'README.md',
      '.gitkeep',
    ]
    for (const name of nonCanonical) {
      assert.ok(!canonical.includes(name), `${name} should not be in canonical list`)
      const targetPath = path.join(changePath, name)
      const result = validateRuneContextWriteTarget(targetPath, changePath)
      assert.equal(result.allowed, false, `${name} should be forbidden inside change tree`)
    }
  })
})

describe('getForbiddenArtifacts', () => {
  test('returns complete list of forbidden artifacts', () => {
    const artifacts = getForbiddenArtifacts()
    assert.ok(Array.isArray(artifacts))
    assert.equal(artifacts.length, 8)

    const expected = [
      'run.json',
      'plan-state.json',
      'state-index.json',
      'execution-groups.md',
      'deviation-report.md',
      'review-findings.md',
      'repo-map.md',
      'reconnaissance.md',
    ]

    for (const name of expected) {
      assert.ok(artifacts.includes(name), `Expected ${name} in forbidden list`)
    }
  })

  test('returns a copy (not the original reference)', () => {
    const artifacts = getForbiddenArtifacts()
    const originalLength = artifacts.length
    artifacts.push('extra.json')
    const artifacts2 = getForbiddenArtifacts()
    assert.equal(artifacts2.length, originalLength)
    assert.equal(artifacts2.includes('extra.json'), false)
  })
})

describe('listCanonicalDocNames (from precedence.ts)', () => {
  test('returns complete list of canonical doc names', () => {
    const docs = listCanonicalDocNames()
    assert.ok(Array.isArray(docs))

    const expected = [
      'proposal.md',
      'design.md',
      'standards.md',
      'verification.md',
      'tasks.md',
      'references.md',
      'status.yaml',
    ]

    assert.equal(docs.length, expected.length)
    for (const name of expected) {
      assert.ok(docs.includes(name), `Expected ${name} in canonical doc list`)
    }
  })

  test('returns a copy (not the original reference)', () => {
    const docs = listCanonicalDocNames()
    const originalLength = docs.length
    docs.push('extra.md')
    const docs2 = listCanonicalDocNames()
    assert.equal(docs2.length, originalLength)
    assert.equal(docs2.includes('extra.md'), false)
  })
})
