import * as assert from 'node:assert/strict'
import { test, describe, afterEach, beforeEach } from 'node:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

const {
  createAmendment,
  approveAmendment,
  writeApprovedAmendment,
} = await import('../extensions/pi-runecontext/runectx.ts')

describe('amendment flow (Task 3.7)', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'amendment-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('createAmendment creates unapproved amendment with timestamp', () => {
    const am = createAmendment(
      'CHANGE-001',
      '/fake/path',
      { 'status.yaml': 'status: approved' },
      'drifted',
    )

    assert.equal(am.changeId, 'CHANGE-001')
    assert.equal(am.changePath, '/fake/path')
    assert.equal(am.approved, false)
    assert.equal(am.triggerState, 'drifted')
    assert.ok(am.createdAt)
    assert.ok(am.createdAt.length > 0)
    assert.deepEqual(am.docChanges, { 'status.yaml': 'status: approved' })
  })

  test('approveAmendment returns copy with approved: true, original unchanged', () => {
    const am = createAmendment('CHANGE-001', '/fake/path', {}, 'draft')
    const approved = approveAmendment(am)

    assert.equal(approved.approved, true)
    assert.equal(am.approved, false, 'original should not be mutated')
    assert.equal(approved.changeId, 'CHANGE-001')
    assert.equal(approved.triggerState, 'draft')
    assert.equal(approved.createdAt, am.createdAt)
  })

  test('writeApprovedAmendment returns deferred for unapproved amendment', async () => {
    const am = createAmendment('CHANGE-001', '/fake/path', {}, 'drifted')
    const result = await writeApprovedAmendment(am)

    assert.equal(result.success, false)
    assert.equal(result.deferred, true)
    assert.deepEqual(result.writtenFiles, [])
    assert.deepEqual(result.failedFiles, [])
    assert.ok(result.summary.includes('deferred'))
    assert.ok(result.summary.includes('CHANGE-001'))
  })

  test('writeApprovedAmendment writes approved amendment files (canonical docs only)', async () => {
    const am = createAmendment(
      'CHANGE-002',
      tmpDir,
      { 'proposal.md': '# Updated proposal', 'status.yaml': 'status: approved' },
      'approved',
    )
    const approvedAm = approveAmendment(am)
    const result = await writeApprovedAmendment(approvedAm)

    assert.equal(result.success, true)
    assert.equal(result.deferred, false)
    assert.equal(result.writtenFiles.length, 2)

    const content1 = await fs.readFile(path.join(tmpDir, 'proposal.md'), 'utf-8')
    assert.equal(content1, '# Updated proposal')

    const content2 = await fs.readFile(path.join(tmpDir, 'status.yaml'), 'utf-8')
    assert.equal(content2, 'status: approved')
  })

  test('writeApprovedAmendment rejects non-canonical doc names', async () => {
    const am = createAmendment(
      'CHANGE-005',
      tmpDir,
      { 'notes.txt': 'not a canonical doc', 'execution-groups.md': 'derived artifact' },
      'approved',
    )
    const approvedAm = approveAmendment(am)
    const result = await writeApprovedAmendment(approvedAm)

    assert.equal(result.success, false)
    assert.equal(result.deferred, false)
    assert.equal(result.writtenFiles.length, 0)
    assert.equal(result.failedFiles.length, 2)
    assert.ok(result.failedFiles[0].error.includes('not a recognised canonical RuneContext doc'))
    assert.ok(result.failedFiles[1].error.includes('not a recognised canonical RuneContext doc'))
  })

  test('writeApprovedAmendment rejects path traversal in docChanges keys', async () => {
    const am = createAmendment(
      'CHANGE-006',
      tmpDir,
      { '../../outside.txt': 'data' },
      'approved',
    )
    const approvedAm = approveAmendment(am)
    const result = await writeApprovedAmendment(approvedAm)

    assert.equal(result.success, false)
    assert.equal(result.deferred, false)
    assert.equal(result.writtenFiles.length, 0)
    assert.equal(result.failedFiles.length, 1)
    assert.ok(result.failedFiles[0].error.includes('path separators') ||
              result.failedFiles[0].error.includes('parent references'))
  })

  test('writeApprovedAmendment reports file write failures', async () => {
    const am = createAmendment(
      'CHANGE-003',
      '/nonexistent/path',
      { 'fail.txt': 'data' },
      'approved',
    )
    const approvedAm = approveAmendment(am)
    const result = await writeApprovedAmendment(approvedAm)

    assert.equal(result.success, false)
    assert.equal(result.deferred, false)
    assert.equal(result.failedFiles.length, 1)
    assert.ok(result.failedFiles[0].error.length > 0)
    assert.ok(result.failedFiles[0].path.endsWith('fail.txt'))
    assert.equal(result.writtenFiles.length, 0)
    assert.ok(result.summary.includes('CHANGE-003'))
  })

  test('writeApprovedAmendment partial failure when some dirs exist but filenames are non-canonical', async () => {
    await fs.mkdir(path.join(tmpDir, 'subdir'), { recursive: true })

    const am = createAmendment(
      'CHANGE-004',
      tmpDir,
      {
        'proposal.md': 'valid canonical doc',
        'bad.txt': 'non-canonical',
      },
      'approved',
    )
    const approvedAm = approveAmendment(am)
    const result = await writeApprovedAmendment(approvedAm)

    // proposal.md succeeds, bad.txt is rejected as non-canonical
    assert.equal(result.success, false)
    assert.equal(result.writtenFiles.length, 1)
    assert.equal(result.failedFiles.length, 1)
    assert.ok(result.writtenFiles[0].endsWith('proposal.md'))
    assert.ok(result.failedFiles[0].path.endsWith('bad.txt'))
    assert.ok(result.failedFiles[0].error.includes('not a recognised canonical RuneContext doc'))

    // Verify the successful write
    const content = await fs.readFile(path.join(tmpDir, 'proposal.md'), 'utf-8')
    assert.equal(content, 'valid canonical doc')
  })
})
