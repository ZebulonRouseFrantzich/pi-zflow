import * as assert from 'node:assert/strict'
import { test, describe } from 'node:test'

const {
  mapHarnessStateToRuneStatus,
  buildRuntimeMetadata,
  shouldOfferWriteBack,
} = await import('../extensions/pi-runecontext/runectx.ts')

// A vocabulary that recognises common status values
const permissiveVocabulary = {
  allowedStatuses: ['draft', 'active', 'review', 'approved', 'completed', 'cancelled', 'implemented'],
}

// An empty vocabulary (unknown/unrestricted)
const emptyVocabulary = {
  allowedStatuses: [],
}

// A vocabulary missing some status values
const restrictedVocabulary = {
  allowedStatuses: ['draft', 'active', 'review'],
}

describe('mapHarnessStateToRuneStatus', () => {
  describe('draft', () => {
    test('maps to runtime-only', () => {
      const result = mapHarnessStateToRuneStatus('draft', permissiveVocabulary)
      assert.equal(result.mappedStatus, null)
      assert.equal(result.policy, 'runtime-only')
      assert.ok(result.reason.length > 0)
    })

    test('is runtime-only regardless of vocabulary', () => {
      const result = mapHarnessStateToRuneStatus('draft', restrictedVocabulary)
      assert.equal(result.mappedStatus, null)
      assert.equal(result.policy, 'runtime-only')
    })
  })

  describe('validated', () => {
    test('maps to runtime-only', () => {
      const result = mapHarnessStateToRuneStatus('validated', permissiveVocabulary)
      assert.equal(result.mappedStatus, null)
      assert.equal(result.policy, 'runtime-only')
      assert.ok(result.reason.length > 0)
    })
  })

  describe('reviewed', () => {
    test('maps to runtime-only', () => {
      const result = mapHarnessStateToRuneStatus('reviewed', permissiveVocabulary)
      assert.equal(result.mappedStatus, null)
      assert.equal(result.policy, 'runtime-only')
    })
  })

  describe('approved', () => {
    test('maps to prompt when vocabulary includes approved', () => {
      const result = mapHarnessStateToRuneStatus('approved', permissiveVocabulary)
      assert.equal(result.mappedStatus, 'approved')
      assert.equal(result.policy, 'prompt')
      assert.ok(result.reason.includes('approved'))
    })

    test('maps to runtime-only when vocabulary excludes approved', () => {
      const result = mapHarnessStateToRuneStatus('approved', restrictedVocabulary)
      assert.equal(result.mappedStatus, null)
      assert.equal(result.policy, 'runtime-only')
      assert.ok(result.reason.includes('no corresponding status'))
    })
  })

  describe('executing', () => {
    test('maps to runtime-only', () => {
      const result = mapHarnessStateToRuneStatus('executing', permissiveVocabulary)
      assert.equal(result.mappedStatus, null)
      assert.equal(result.policy, 'runtime-only')
    })
  })

  describe('drifted', () => {
    test('maps to runtime-only', () => {
      const result = mapHarnessStateToRuneStatus('drifted', permissiveVocabulary)
      assert.equal(result.mappedStatus, null)
      assert.equal(result.policy, 'runtime-only')
    })
  })

  describe('superseded', () => {
    test('maps to runtime-only', () => {
      const result = mapHarnessStateToRuneStatus('superseded', permissiveVocabulary)
      assert.equal(result.mappedStatus, null)
      assert.equal(result.policy, 'runtime-only')
    })
  })

  describe('completed', () => {
    test('maps to implemented when vocabulary includes it', () => {
      const result = mapHarnessStateToRuneStatus('completed', permissiveVocabulary)
      assert.equal(result.mappedStatus, 'implemented')
      assert.equal(result.policy, 'prompt')
      assert.ok(result.reason.includes('implemented'))
    })

    test('maps to completed when vocabulary has completed but not implemented', () => {
      const vocab = { allowedStatuses: ['draft', 'completed'] }
      const result = mapHarnessStateToRuneStatus('completed', vocab)
      assert.equal(result.mappedStatus, 'completed')
      assert.equal(result.policy, 'prompt')
    })

    test('maps to runtime-only when vocabulary lacks both implemented and completed', () => {
      const result = mapHarnessStateToRuneStatus('completed', restrictedVocabulary)
      assert.equal(result.mappedStatus, null)
      assert.equal(result.policy, 'runtime-only')
    })
  })

  describe('cancelled', () => {
    test('maps to runtime-only with cancelled status when vocabulary includes it', () => {
      const result = mapHarnessStateToRuneStatus('cancelled', permissiveVocabulary)
      assert.equal(result.mappedStatus, 'cancelled')
      assert.equal(result.policy, 'runtime-only')
      assert.ok(result.reason.includes('cancelled'))
    })

    test('maps to runtime-only with null when vocabulary excludes cancelled', () => {
      const result = mapHarnessStateToRuneStatus('cancelled', restrictedVocabulary)
      assert.equal(result.mappedStatus, null)
      assert.equal(result.policy, 'runtime-only')
    })
  })

  describe('edge cases', () => {
    test('handles empty vocabulary (ambiguous) — maps to runtime-only', () => {
      // With empty vocabulary, isAllowedStatus returns false (conservative)
      // so approved falls back to runtime-only to avoid lossy overwrite
      const result = mapHarnessStateToRuneStatus('approved', emptyVocabulary)
      assert.equal(result.mappedStatus, null)
      assert.equal(result.policy, 'runtime-only')
      assert.ok(result.reason.includes('no corresponding status'))
    })

    test('completed uses implemented as preferred status name', () => {
      const vocab = { allowedStatuses: ['draft', 'implemented', 'completed'] }
      const result = mapHarnessStateToRuneStatus('completed', vocab)
      // Should prefer "implemented" over "completed"
      assert.equal(result.mappedStatus, 'implemented')
    })
  })
})

describe('buildRuntimeMetadata', () => {
  test('produces correct structure with harness state', () => {
    const metadata = buildRuntimeMetadata('draft')

    assert.equal(metadata.harnessState, 'draft')
    assert.equal(typeof metadata.timestamp, 'string')
    assert.ok(metadata.timestamp.length > 0)
  })

  test('includes extra fields when provided', () => {
    const metadata = buildRuntimeMetadata('approved', { reason: 'All tasks completed' })

    assert.equal(metadata.harnessState, 'approved')
    assert.equal(metadata.reason, 'All tasks completed')
    assert.equal(typeof metadata.timestamp, 'string')
  })

  test('does not mutate the extra object', () => {
    const extra = { key: 'value' }
    const original = { ...extra }
    buildRuntimeMetadata('draft', extra)
    assert.deepEqual(extra, original)
  })

  test('handles undefined extra gracefully', () => {
    const metadata = buildRuntimeMetadata('draft')
    assert.equal(metadata.harnessState, 'draft')
    // No extra keys beyond harnessState and timestamp
    assert.deepEqual(Object.keys(metadata).sort(), ['harnessState', 'timestamp'])
  })
})

describe('shouldOfferWriteBack', () => {
  test('returns true for prompt policy', () => {
    const result = mapHarnessStateToRuneStatus('approved', permissiveVocabulary)
    assert.equal(shouldOfferWriteBack(result), true)
  })

  test('returns true for auto policy', () => {
    // Create a synthetic result with auto policy
    const result = {
      mappedStatus: 'approved',
      policy: 'auto' as const,
      reason: 'test',
    }
    assert.equal(shouldOfferWriteBack(result), true)
  })

  test('returns false for runtime-only policy', () => {
    const result = mapHarnessStateToRuneStatus('draft', permissiveVocabulary)
    assert.equal(shouldOfferWriteBack(result), false)
  })

  test('returns false for cancelled mapping (runtime-only policy)', () => {
    const result = mapHarnessStateToRuneStatus('cancelled', permissiveVocabulary)
    assert.equal(shouldOfferWriteBack(result), false)
  })
})
