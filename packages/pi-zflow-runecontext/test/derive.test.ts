import * as assert from 'node:assert/strict'
import { test, describe } from 'node:test'

const {
  deriveExecutionGroupsFromRuneDocs,
  parseTasksMd,
  inferGroupsFromDocs,
} = await import('../extensions/pi-runecontext/derive.ts')

describe('parseTasksMd', () => {
  test('parses structured tasks.md with headings', () => {
    const content = `# Tasks

## Setup
- Install dependencies
- Configure environment

## Implementation
- Write core logic
- Add error handling

## Testing
- Write unit tests
- Run integration tests
`
    const groups = parseTasksMd(content)

    assert.equal(groups.length, 3)
    assert.equal(groups[0].name, 'Setup')
    assert.equal(groups[1].name, 'Implementation')
    assert.equal(groups[2].name, 'Testing')
    assert.equal(groups[0].confidence, 'full')
    assert.equal(groups[1].confidence, 'full')
    assert.equal(groups[2].confidence, 'full')
  })

  test('each task traces back to tasks.md source', () => {
    const content = `## Phase 1
- Task A
- Task B
`
    const groups = parseTasksMd(content)
    assert.equal(groups.length, 1)
    assert.equal(groups[0].tasks.length, 2)
    for (const task of groups[0].tasks) {
      assert.deepEqual(task.sources, ['tasks.md'])
      assert.equal(task.origin, 'tasks.md')
    }
  })

  test('handles tasks.md with no headings as single group', () => {
    const content = `- Build the thing
- Test the thing
- Deploy the thing
`
    const groups = parseTasksMd(content)
    assert.equal(groups.length, 1)
    assert.equal(groups[0].name, 'tasks')
    assert.equal(groups[0].tasks.length, 3)
    assert.equal(groups[0].confidence, 'full')
  })

  test('handles empty tasks.md', () => {
    const groups = parseTasksMd('')
    assert.equal(groups.length, 1)
    assert.equal(groups[0].name, 'tasks')
    assert.equal(groups[0].tasks.length, 0)
    assert.equal(groups[0].confidence, 'full')
  })

  test('extracts verification criteria from task items', () => {
    const content = `## Verify
- Check output (verify: output matches expected)
- Run linter [verify: no errors]
`
    const groups = parseTasksMd(content)
    assert.equal(groups.length, 1)
    assert.equal(groups[0].tasks.length, 2)
    assert.equal(groups[0].tasks[0].verification, 'output matches expected')
    assert.equal(groups[0].tasks[1].verification, 'no errors')
  })

  test('handles task list markers (- [ ] and - [x])', () => {
    const content = `## Todo
- [ ] Not done yet
- [x] Completed task
- Simple item
`
    const groups = parseTasksMd(content)
    assert.equal(groups.length, 1)
    assert.equal(groups[0].tasks.length, 3)
    assert.equal(groups[0].tasks[0].title, 'Not done yet')
    assert.equal(groups[0].tasks[1].title, 'Completed task')
    assert.equal(groups[0].tasks[2].title, 'Simple item')
  })
})

describe('inferGroupsFromDocs', () => {
  test('infers groups from documents with headings', () => {
    const docs = {
      proposal: `## Architecture
- Use microservices
- Use event-driven messaging

## Database
- Use PostgreSQL
- Use connection pooling
`,
      design: `## API Design
- RESTful endpoints
- Versioned APIs
`,
      verification: `## Load Testing
- Test with 1000 concurrent users
- Monitor response times
`,
    }

    const groups = inferGroupsFromDocs(docs)

    assert.ok(groups.length >= 3) // At least one group per doc
    for (const group of groups) {
      assert.equal(group.confidence, 'partial')
      for (const task of group.tasks) {
        assert.equal(task.origin, 'inferred')
        assert.ok(task.sources.length > 0)
      }
    }
  })

  test('produces uncertain group when documents are empty', () => {
    const docs = {
      proposal: '',
      design: '',
      verification: '',
    }

    const groups = inferGroupsFromDocs(docs)

    assert.equal(groups.length, 1)
    assert.equal(groups[0].name, 'uncertain')
    assert.equal(groups[0].confidence, 'partial')
    assert.deepEqual(groups[0].tasks, [])
  })

  test('traces inferred tasks back to source documents', () => {
    const docs = {
      proposal: `## Setup
- Configure logging`,
      design: '',
      verification: '',
    }

    const groups = inferGroupsFromDocs(docs)
    const proposalGroup = groups.find(g => g.name === 'Setup')
    assert.ok(proposalGroup)
    assert.ok(proposalGroup.tasks.length > 0)
    for (const task of proposalGroup.tasks) {
      assert.ok(task.sources.includes('proposal.md'))
    }
  })

  test('infers groups even with only one document having content', () => {
    const docs = {
      proposal: '',
      design: `## Refactor
- Extract utility functions`,
      verification: '',
    }

    const groups = inferGroupsFromDocs(docs)
    const refactorGroup = groups.find(g => g.name === 'Refactor')
    assert.ok(refactorGroup)
    assert.equal(refactorGroup.confidence, 'partial')
  })
})

describe('deriveExecutionGroupsFromRuneDocs', () => {
  test('with tasks.md produces full confidence groups', () => {
    const runeDocs = {
      proposal: '# P',
      design: '# D',
      standards: '# S',
      verification: '# V',
      status: { status: 'draft' },
      tasks: `## Implementation\n- Write code\n- Test code`,
      references: null,
    }

    const result = deriveExecutionGroupsFromRuneDocs(runeDocs as any)

    assert.equal(result.mode, 'runecontext')
    assert.equal(result.sourceDocument, 'tasks.md')
    assert.ok(result.groups.length >= 1)
    for (const group of result.groups) {
      assert.equal(group.confidence, 'full')
    }
  })

  test('without tasks.md produces partial confidence groups', () => {
    const runeDocs = {
      proposal: `## Changes\n- Update API\n- Add tests`,
      design: `## Architecture\n- Modular design`,
      standards: '# S',
      verification: `## Verify\n- Run checks`,
      status: { status: 'draft' },
      tasks: null,
      references: null,
    }

    const result = deriveExecutionGroupsFromRuneDocs(runeDocs as any)

    assert.equal(result.mode, 'runecontext')
    assert.equal(result.sourceDocument, 'proposal+design+verification')
    assert.ok(result.groups.length >= 1)
    for (const group of result.groups) {
      assert.equal(group.confidence, 'partial')
    }
  })

  test('derived groups trace back to source documents', () => {
    const runeDocs = {
      proposal: '# P',
      design: '# D',
      standards: '# S',
      verification: '# V',
      status: { status: 'draft' },
      tasks: `## Tasks\n- Do the work`,
      references: null,
    }

    const result = deriveExecutionGroupsFromRuneDocs(runeDocs as any)
    for (const group of result.groups) {
      for (const task of group.tasks) {
        assert.ok(task.sources.length > 0)
      }
    }
  })

  test('empty docs produce uncertain group', () => {
    const runeDocs = {
      proposal: '',
      design: '',
      standards: '',
      verification: '',
      status: { status: 'draft' },
      tasks: null,
      references: null,
    }

    const result = deriveExecutionGroupsFromRuneDocs(runeDocs as any)

    assert.equal(result.sourceDocument, 'proposal+design+verification')
    assert.equal(result.groups.length, 1)
    assert.equal(result.groups[0].name, 'uncertain')
    assert.equal(result.groups[0].confidence, 'partial')
  })
})
