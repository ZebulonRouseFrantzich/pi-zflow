import * as assert from 'node:assert/strict'
import { test, describe, beforeEach, afterEach } from 'node:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

const {
  detectRuneContext,
  fileExists,
  tryRunectxStatus,
} = await import('../extensions/pi-runecontext/detect.ts')

describe('detectRuneContext', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runecontext-detect-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('detects RuneContext via runecontext.yaml presence', async () => {
    await fs.writeFile(path.join(tmpDir, 'runecontext.yaml'), 'version: 1\n')
    const result = await detectRuneContext(tmpDir)

    assert.equal(result.enabled, true)
    assert.equal(result.detectionSource, 'runecontext.yaml')
    assert.ok(result.source.includes('runecontext.yaml'))
    assert.equal(result.runecontextYamlPath, path.join(tmpDir, 'runecontext.yaml'))
    assert.equal(result.repoRoot, tmpDir)
  })

  test('no detection when neither marker is present', async () => {
    // NOTE: This test assumes `runectx` is not installed on the host
    // (typical for dev and CI environments). If `runectx` is on PATH in the
    // test environment, this test may fail because tryRunectxStatus could
    // succeed against the empty tmpdir or block for up to 10 seconds.
    // TODO(phase-4): Inject a stub for tryRunectxStatus via dependency
    // injection or module mock to make detection tests fully deterministic.
    const result = await detectRuneContext(tmpDir)

    assert.equal(result.enabled, false)
    assert.equal(result.detectionSource, undefined)
    assert.equal(result.runecontextYamlPath, undefined)
    assert.ok(result.source.includes('no RuneContext markers'))
    assert.equal(result.repoRoot, tmpDir)
  })

  test('detection result includes correct source information', async () => {
    await fs.writeFile(path.join(tmpDir, 'runecontext.yaml'), 'version: 1\n')
    const result = await detectRuneContext(tmpDir)

    assert.equal(result.enabled, true)
    assert.equal(typeof result.source, 'string')
    assert.ok(result.source.length > 0)
    assert.equal(result.repoRoot, tmpDir)
  })

  test('runecontext.yaml detection sets correct metadata', async () => {
    await fs.writeFile(path.join(tmpDir, 'runecontext.yaml'), 'version: 1\n')
    const result = await detectRuneContext(tmpDir)

    assert.equal(result.enabled, true)
    assert.equal(result.detectionSource, 'runecontext.yaml')
    assert.equal(result.runecontextYamlPath, path.join(tmpDir, 'runecontext.yaml'))
    assert.equal(result.repoRoot, tmpDir)
  })

  test('returns disabled result with proper metadata when no markers found', async () => {
    const result = await detectRuneContext(tmpDir)

    assert.equal(result.enabled, false)
    assert.equal(result.repoRoot, tmpDir)
    assert.equal(typeof result.source, 'string')
    assert.ok(result.source.length > 0)
  })
})

describe('fileExists', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-exists-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('returns true for existing file', async () => {
    const filePath = path.join(tmpDir, 'existing.txt')
    await fs.writeFile(filePath, 'content')
    assert.equal(await fileExists(filePath), true)
  })

  test('returns false for non-existing file', async () => {
    const filePath = path.join(tmpDir, 'nonexistent.txt')
    assert.equal(await fileExists(filePath), false)
  })
})

describe('tryRunectxStatus', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runectx-status-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('returns false when runectx is not installed (no crash)', () => {
    // runectx is not expected to be installed in test environment
    const result = tryRunectxStatus(tmpDir)
    assert.equal(result, false)
  })

  test('does not throw when command fails', () => {
    assert.doesNotThrow(() => {
      tryRunectxStatus(tmpDir)
    })
  })
})
