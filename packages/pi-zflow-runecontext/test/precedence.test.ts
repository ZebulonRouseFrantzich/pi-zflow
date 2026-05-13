import * as assert from 'node:assert/strict'
import { test, describe } from 'node:test'

const {
  getRequirementsSource,
  classifyArtifact,
  isCanonicalArtifact,
  listCanonicalDocNames,
  listDerivedArtifactNames,
} = await import('../extensions/pi-runecontext/precedence.ts')

describe('getRequirementsSource', () => {
  test('returns canonical-runecontext-docs for runecontext mode', () => {
    const source = getRequirementsSource('runecontext')
    assert.equal(source, 'canonical-runecontext-docs')
  })

  test('returns versioned-plan-artifacts for adhoc mode', () => {
    const source = getRequirementsSource('adhoc')
    assert.equal(source, 'versioned-plan-artifacts')
  })
})

describe('classifyArtifact', () => {
  describe('runecontext mode', () => {
    test('classifies proposal.md as canonical', () => {
      assert.equal(classifyArtifact('proposal.md', 'runecontext'), 'canonical')
    })

    test('classifies design.md as canonical', () => {
      assert.equal(classifyArtifact('design.md', 'runecontext'), 'canonical')
    })

    test('classifies standards.md as canonical', () => {
      assert.equal(classifyArtifact('standards.md', 'runecontext'), 'canonical')
    })

    test('classifies verification.md as canonical', () => {
      assert.equal(classifyArtifact('verification.md', 'runecontext'), 'canonical')
    })

    test('classifies tasks.md as canonical', () => {
      assert.equal(classifyArtifact('tasks.md', 'runecontext'), 'canonical')
    })

    test('classifies references.md as canonical', () => {
      assert.equal(classifyArtifact('references.md', 'runecontext'), 'canonical')
    })

    test('classifies status.yaml as canonical', () => {
      assert.equal(classifyArtifact('status.yaml', 'runecontext'), 'canonical')
    })

    test('classifies execution-groups.md as derived', () => {
      assert.equal(classifyArtifact('execution-groups.md', 'runecontext'), 'derived')
    })

    test('classifies plan-state.json as derived', () => {
      assert.equal(classifyArtifact('plan-state.json', 'runecontext'), 'derived')
    })

    test('classifies run.json as derived', () => {
      assert.equal(classifyArtifact('run.json', 'runecontext'), 'derived')
    })

    test('classifies deviation-report.md as derived', () => {
      assert.equal(classifyArtifact('deviation-report.md', 'runecontext'), 'derived')
    })

    test('classifies review-findings.md as derived', () => {
      assert.equal(classifyArtifact('review-findings.md', 'runecontext'), 'derived')
    })

    test('classifies repo-map.md as derived', () => {
      assert.equal(classifyArtifact('repo-map.md', 'runecontext'), 'derived')
    })

    test('classifies reconnaissance.md as derived', () => {
      assert.equal(classifyArtifact('reconnaissance.md', 'runecontext'), 'derived')
    })

    test('classifies unknown files as runtime-only', () => {
      assert.equal(classifyArtifact('package.json', 'runecontext'), 'runtime-only')
      assert.equal(classifyArtifact('README.md', 'runecontext'), 'runtime-only')
      assert.equal(classifyArtifact('src/index.ts', 'runecontext'), 'runtime-only')
    })
  })

  describe('adhoc mode', () => {
    test('classifies execution-groups.md as canonical', () => {
      assert.equal(classifyArtifact('execution-groups.md', 'adhoc'), 'canonical')
    })

    test('classifies plan-state.json as canonical', () => {
      assert.equal(classifyArtifact('plan-state.json', 'adhoc'), 'canonical')
    })

    test('classifies run.json as canonical', () => {
      assert.equal(classifyArtifact('run.json', 'adhoc'), 'canonical')
    })

    test('classifies proposal.md as runtime-only in adhoc mode', () => {
      assert.equal(classifyArtifact('proposal.md', 'adhoc'), 'runtime-only')
    })

    test('classifies design.md as runtime-only in adhoc mode', () => {
      assert.equal(classifyArtifact('design.md', 'adhoc'), 'runtime-only')
    })

    test('classifies unknown files as runtime-only', () => {
      assert.equal(classifyArtifact('README.md', 'adhoc'), 'runtime-only')
      assert.equal(classifyArtifact('deviation-report.md', 'adhoc'), 'runtime-only')
    })
  })
})

describe('isCanonicalArtifact', () => {
  test('returns true for canonical docs in runecontext mode', () => {
    assert.equal(isCanonicalArtifact('proposal.md', 'runecontext'), true)
    assert.equal(isCanonicalArtifact('status.yaml', 'runecontext'), true)
  })

  test('returns false for derived artifacts in runecontext mode', () => {
    assert.equal(isCanonicalArtifact('execution-groups.md', 'runecontext'), false)
    assert.equal(isCanonicalArtifact('run.json', 'runecontext'), false)
  })

  test('returns false for runtime-only files in runecontext mode', () => {
    assert.equal(isCanonicalArtifact('README.md', 'runecontext'), false)
  })

  test('returns true for adhoc canonical artifacts', () => {
    assert.equal(isCanonicalArtifact('execution-groups.md', 'adhoc'), true)
    assert.equal(isCanonicalArtifact('plan-state.json', 'adhoc'), true)
    assert.equal(isCanonicalArtifact('run.json', 'adhoc'), true)
  })

  test('returns false for non-canonical files in adhoc mode', () => {
    assert.equal(isCanonicalArtifact('proposal.md', 'adhoc'), false)
    assert.equal(isCanonicalArtifact('design.md', 'adhoc'), false)
  })
})

describe('listCanonicalDocNames', () => {
  test('returns all canonical doc names', () => {
    const names = listCanonicalDocNames()
    assert.ok(Array.isArray(names))
    assert.equal(names.length, 7)
    assert.ok(names.includes('proposal.md'))
    assert.ok(names.includes('design.md'))
    assert.ok(names.includes('standards.md'))
    assert.ok(names.includes('verification.md'))
    assert.ok(names.includes('tasks.md'))
    assert.ok(names.includes('references.md'))
    assert.ok(names.includes('status.yaml'))
  })

  test('returns a copy (not the original reference)', () => {
    const names = listCanonicalDocNames()
    const originalLength = names.length
    names.push('extra.md')
    const names2 = listCanonicalDocNames()
    assert.equal(names2.length, originalLength)
    assert.equal(names2.includes('extra.md'), false)
  })
})

describe('listDerivedArtifactNames', () => {
  test('returns all derived artifact names', () => {
    const names = listDerivedArtifactNames()
    assert.ok(Array.isArray(names))
    assert.equal(names.length, 7)
    assert.ok(names.includes('execution-groups.md'))
    assert.ok(names.includes('plan-state.json'))
    assert.ok(names.includes('run.json'))
    assert.ok(names.includes('deviation-report.md'))
    assert.ok(names.includes('review-findings.md'))
    assert.ok(names.includes('repo-map.md'))
    assert.ok(names.includes('reconnaissance.md'))
  })

  test('returns a copy (not the original reference)', () => {
    const names = listDerivedArtifactNames()
    const originalLength = names.length
    names.push('extra.json')
    const names2 = listDerivedArtifactNames()
    assert.equal(names2.length, originalLength)
    assert.equal(names2.includes('extra.json'), false)
  })
})
