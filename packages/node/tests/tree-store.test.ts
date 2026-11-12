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

describe('TreeStore keeps c4m text as its bytes', () => {
  it('stores pretty c4m as given, under its byte ID; the description ID is a separate question', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'c4ts-tree-store-'))
    const store = new TreeStore(tmpDir)

    const m = await Manifest.parse(vector.canonical)
    const pretty = enc.encode(m.encode({ pretty: true }))

    // The ID is the bytes' ID, and the bytes come back exactly. Through
    // 1.0.26 this returned the description ID and stored the one-level
    // canonical listing instead.
    const id = await store.put(pretty)
    expect(id.toString()).toBe((await identifyBytes(pretty)).toString())
    const stored = await streamToBytes(await store.get(id))
    expect(new TextDecoder().decode(stored)).toBe(new TextDecoder().decode(pretty))

    // The description it holds still resolves to its description ID.
    const reparsed = await Manifest.parse(new TextDecoder().decode(stored))
    expect((await reparsed.computeC4ID()).toString()).toBe(vector.manifest_c4id)
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
