import { describe, it, expect } from 'vitest'
import {
  Manifest,
  identifyBytes,
  identifyContent,
  tryCanonicalizeC4m,
  MemoryStore,
} from '../src/index.js'
import knownIDs from './vectors/known_ids.json'

const vector = knownIDs.manifest_vectors[0]
const enc = new TextEncoder()

// Since 1.0.27 a file's C4 ID is its bytes, c4m text included. Through
// 1.0.26 identifyContent and MemoryStore.put re-rendered c4m text to its
// one-level canonical listing first. identifyContent and tryCanonicalizeC4m
// are kept on this line, deprecated, for code built against 1.0.26.

describe('identifyContent (deprecated): the bytes\' ID', () => {
  it('pretty and canonical c4m are two files with two IDs, and one description ID', async () => {
    const m = await Manifest.parse(vector.canonical)
    const pretty = enc.encode(m.encode({ pretty: true }))
    const canonical = enc.encode(m.encode({ pretty: false }))
    expect(new TextDecoder().decode(pretty)).not.toBe(new TextDecoder().decode(canonical))

    expect((await identifyContent(pretty)).toString()).toBe((await identifyBytes(pretty)).toString())
    expect((await identifyContent(canonical)).toString()).toBe((await identifyBytes(canonical)).toString())
    expect((await identifyContent(pretty)).toString()).not.toBe((await identifyContent(canonical)).toString())

    // The description both hold resolves to one ID.
    const a = await Manifest.parse(new TextDecoder().decode(pretty))
    const b = await Manifest.parse(new TextDecoder().decode(canonical))
    expect((await a.computeC4ID()).toString()).toBe(vector.manifest_c4id)
    expect((await b.computeC4ID()).toString()).toBe(vector.manifest_c4id)
  })

  it('non-c4m, empty and binary input are the bytes\' ID', async () => {
    for (const data of [enc.encode('just some plain text'), new Uint8Array(0), new Uint8Array([0, 1, 2, 0xff])]) {
      expect((await identifyContent(data)).toString()).toBe((await identifyBytes(data)).toString())
    }
  })
})

describe('tryCanonicalizeC4m (deprecated, unchanged)', () => {
  it('returns canonical bytes for valid c4m', async () => {
    const canonical = await tryCanonicalizeC4m(enc.encode(vector.canonical))
    expect(canonical).not.toBeNull()
    expect(canonical!.length).toBeGreaterThan(0)
  })

  it('returns null for plain text, binary data and empty data', async () => {
    for (const data of [enc.encode('hello world'), new Uint8Array([0, 1, 2]), new Uint8Array(0)]) {
      expect(await tryCanonicalizeC4m(data)).toBeNull()
    }
  })
})

describe('MemoryStore keeps c4m text as its bytes', () => {
  it('get(put(pretty)) is the pretty text, under its byte ID', async () => {
    const store = new MemoryStore()
    const m = await Manifest.parse(vector.canonical)
    const pretty = enc.encode(m.encode({ pretty: true }))

    const id = await store.put(pretty)
    expect(id.toString()).toBe((await identifyBytes(pretty)).toString())
    const back = new Uint8Array(await new Response(await store.get(id)).arrayBuffer())
    expect(new TextDecoder().decode(back)).toBe(new TextDecoder().decode(pretty))
  })
})
