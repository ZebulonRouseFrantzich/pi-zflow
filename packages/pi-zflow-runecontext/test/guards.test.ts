import * as assert from 'node:assert/strict'
import { test, describe } from 'node:test'
import * as path from 'node:path'
import * as os from 'node:os'

const {
  isWriteAllowedInRuneContextTree,
  validateRuneContextWriteTarget,
  getForbiddenArtifacts,
} = await import('../extensions/pi-runecontext/guards.ts')

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

  test('allows unrecognised files inside the tree', () => {
    // The guard only rejects known runtime artifacts
    assert.equal(isWriteAllowedInRuneContextTree('package.json'), true)
    assert.equal(isWriteAllowedInRuneContextTree('README.md'), true)
    assert.equal(isWriteAllowedInRuneContextTree('notes.txt'), true)
    assert.equal(isWriteAllowedInRuneContextTree('.gitkeep'), true)
    assert.equal(isWriteAllowedInRuneContextTree('src/index.ts'), true)
  })
})

describe('validateRuneContextWriteTarget', () => {
  const changePath = path.join(os.tmpdir(), 'runecontext-test-change')

  test('rejects runtime artifacts inside change tree', () => {
    const targetPath = path.join(changePath, 'run.json')
    const result = validateRuneContextWriteTarget(targetPath, changePath)

    assert.equal(result.allowed, false)
    assert.ok(result.reason.includes('run.json'))
    assert.ok(result.reason.includes('RuneContext tree'))
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

  test('rejects all forbidden artifacts inside change tree', () => {
    const forbidden = getForbiddenArtifacts()
    for (const artifact of forbidden) {
      const targetPath = path.join(changePath, artifact)
      const result = validateRuneContextWriteTarget(targetPath, changePath)
      assert.equal(result.allowed, false, `${artifact} should be forbidden`)
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
