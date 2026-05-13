import * as assert from 'node:assert/strict'
import { test, describe } from 'node:test'

const {
  RuneContextError,
  MissingRequiredFileError,
  ChangeResolutionError,
  AmbiguousStatusError,
  DetectionConflictError,
} = await import('../extensions/pi-runecontext/errors.ts')

describe('RuneContextError', () => {
  test('is base class for all RuneContext errors', () => {
    const error = new RuneContextError('test message', 'TEST_CODE')
    assert.ok(error instanceof Error)
    assert.equal(error.name, 'RuneContextError')
    assert.equal(error.code, 'TEST_CODE')
    assert.equal(error.message, 'test message')
  })

  test('preserves stack trace', () => {
    const error = new RuneContextError('test', 'CODE')
    assert.ok(typeof error.stack === 'string')
    assert.ok(error.stack!.includes('RuneContextError'))
  })
})

describe('MissingRequiredFileError', () => {
  test('has correct code and message', () => {
    const filePath = '/repo/changes/my-change/design.md'
    const error = new MissingRequiredFileError('design.md', filePath)

    assert.equal(error.name, 'MissingRequiredFileError')
    assert.equal(error.code, 'MISSING_REQUIRED_FILE')
    assert.ok(error.message.includes('design.md'))
    assert.ok(error.message.includes(filePath))
  })

  test('extends RuneContextError', () => {
    const error = new MissingRequiredFileError('tasks.md', '/path/to/tasks.md')
    assert.ok(error instanceof RuneContextError)
    assert.ok(error instanceof Error)
  })

  test('describes which file is missing and where it was expected', () => {
    const error = new MissingRequiredFileError('verification.md', '/home/user/repo/changes/CHANGE-001/verification.md')
    assert.match(error.message, /Missing required/)
    assert.match(error.message, /verification\.md/)
    assert.match(error.message, /CHANGE-001/)
  })
})

describe('ChangeResolutionError', () => {
  test('has correct code and message', () => {
    const error = new ChangeResolutionError('Cannot find change folder')

    assert.equal(error.name, 'ChangeResolutionError')
    assert.equal(error.code, 'CHANGE_RESOLUTION_FAILED')
    assert.equal(error.message, 'Cannot find change folder')
  })

  test('extends RuneContextError', () => {
    const error = new ChangeResolutionError('test')
    assert.ok(error instanceof RuneContextError)
    assert.ok(error instanceof Error)
  })

  test('accepts custom resolution failure messages', () => {
    const error = new ChangeResolutionError('No proposal.md found in any parent directory')
    assert.match(error.message, /proposal\.md/)
  })
})

describe('AmbiguousStatusError', () => {
  test('has correct code and message', () => {
    const error = new AmbiguousStatusError('status.yaml has no "status" field')

    assert.equal(error.name, 'AmbiguousStatusError')
    assert.equal(error.code, 'AMBIGUOUS_STATUS')
    assert.equal(error.message, 'status.yaml has no "status" field')
  })

  test('extends RuneContextError', () => {
    const error = new AmbiguousStatusError('test')
    assert.ok(error instanceof RuneContextError)
    assert.ok(error instanceof Error)
  })
})

describe('DetectionConflictError', () => {
  test('has correct code and message', () => {
    const error = new DetectionConflictError(
      'runecontext.yaml and runectx status disagree'
    )

    assert.equal(error.name, 'DetectionConflictError')
    assert.equal(error.code, 'DETECTION_CONFLICT')
    assert.equal(error.message, 'runecontext.yaml and runectx status disagree')
  })

  test('extends RuneContextError', () => {
    const error = new DetectionConflictError('test')
    assert.ok(error instanceof RuneContextError)
    assert.ok(error instanceof Error)
  })
})
