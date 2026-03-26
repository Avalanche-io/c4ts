import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TreeStore } from '../src/tree-store.js'
import { Manifest, identifyBytes, streamToBytes } from '../../core/src/index.js'
import knownIDs from '../../core/tests/vectors/known_ids.json'

const vector = knownIDs.manifest_vectors[0]
const enc = new TextEncoder()

let tmpDir: string

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true })
  }
})

describe('TreeStore c4m canonicalization', () => {
  it('stores canonical form and returns canonical ID for c4m content', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'c4ts-tree-store-'))
    const store = new TreeStore(tmpDir)

    const m = await Manifest.parse(vector.canonical)
    const pretty = m.encode({ pretty: true })

    const id = await store.put(enc.encode(pretty))
    expect(id.toString()).toBe(vector.manifest_c4id)

    // Retrieved content should be canonical, not pretty
    const stream = await store.get(id)
    const stored = await streamToBytes(stream)
    const storedText = new TextDecoder().decode(stored)

    const reparsed = await Manifest.parse(storedText)
    const reparsedCanonical = reparsed.copy()
    reparsedCanonical.canonicalize()
    const canonicalText = m.copy().canonical()
    expect(reparsedCanonical.canonical()).toBe(canonicalText)
  })

  it('non-c4m content is stored and identified as raw bytes', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'c4ts-tree-store-'))
    const store = new TreeStore(tmpDir)

    const data = enc.encode('just some plain text')
    const id = await store.put(data)
    const rawId = await identifyBytes(data)
    expect(id.toString()).toBe(rawId.toString())

    // Retrieved content matches original
    const stream = await store.get(id)
    const stored = await streamToBytes(stream)
    expect(new TextDecoder().decode(stored)).toBe('just some plain text')
  })
})
