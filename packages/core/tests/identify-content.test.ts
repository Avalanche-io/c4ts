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

describe('identifyContent', () => {
  it('canonical c4m produces the same ID as identifyContent', async () => {
    const data = enc.encode(vector.canonical)
    const id = await identifyContent(data)
    expect(id.toString()).toBe(vector.manifest_c4id)
  })

  it('pretty-printed c4m produces the same C4 ID as canonical form', async () => {
    const m = await Manifest.parse(vector.canonical)
    const pretty = m.encode({ pretty: true })
    const canonical = m.encode({ pretty: false })

    // The text forms differ
    expect(pretty).not.toBe(canonical)

    // But identifyContent gives the same ID for both
    const prettyId = await identifyContent(enc.encode(pretty))
    const canonicalId = await identifyContent(enc.encode(canonical))
    expect(prettyId.toString()).toBe(canonicalId.toString())
    expect(prettyId.toString()).toBe(vector.manifest_c4id)
  })

  it('raw identifyBytes gives different IDs for pretty vs canonical', async () => {
    const m = await Manifest.parse(vector.canonical)
    const pretty = m.encode({ pretty: true })
    const canonical = m.encode({ pretty: false })

    const prettyId = await identifyBytes(enc.encode(pretty))
    const canonicalId = await identifyBytes(enc.encode(canonical))

    // Raw hashing sees different bytes
    expect(prettyId.toString()).not.toBe(canonicalId.toString())
  })

  it('non-c4m content is hashed as raw bytes', async () => {
    const data = enc.encode('just some plain text')
    const contentId = await identifyContent(data)
    const rawId = await identifyBytes(data)
    expect(contentId.toString()).toBe(rawId.toString())
  })

  it('empty input is hashed as raw bytes', async () => {
    const data = new Uint8Array(0)
    const contentId = await identifyContent(data)
    const rawId = await identifyBytes(data)
    expect(contentId.toString()).toBe(rawId.toString())
  })

  it('binary data is hashed as raw bytes', async () => {
    const data = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe])
    const contentId = await identifyContent(data)
    const rawId = await identifyBytes(data)
    expect(contentId.toString()).toBe(rawId.toString())
  })
})

describe('tryCanonicalizeC4m', () => {
  it('returns canonical bytes for valid c4m', async () => {
    const data = enc.encode(vector.canonical)
    const canonical = await tryCanonicalizeC4m(data)
    expect(canonical).not.toBeNull()
    expect(canonical!.length).toBeGreaterThan(0)
  })

  it('returns null for plain text', async () => {
    const data = enc.encode('hello world')
    const result = await tryCanonicalizeC4m(data)
    expect(result).toBeNull()
  })

  it('returns null for binary data', async () => {
    const data = new Uint8Array([0x00, 0x01, 0x02])
    const result = await tryCanonicalizeC4m(data)
    expect(result).toBeNull()
  })

  it('returns null for empty data', async () => {
    const data = new Uint8Array(0)
    const result = await tryCanonicalizeC4m(data)
    expect(result).toBeNull()
  })
})

describe('MemoryStore canonicalizes c4m on put', () => {
  it('stores canonical form and returns canonical ID', async () => {
    const store = new MemoryStore()
    const m = await Manifest.parse(vector.canonical)
    const pretty = m.encode({ pretty: true })

    const id = await store.put(enc.encode(pretty))
    expect(id.toString()).toBe(vector.manifest_c4id)

    // Retrieved content should be canonical, not pretty
    const stream = await store.get(id)
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
    let total = 0
    for (const c of chunks) total += c.length
    const stored = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) { stored.set(c, offset); offset += c.length }
    const storedText = new TextDecoder().decode(stored)

    // The stored text should be the canonical form (top-level entries only)
    const canonicalText = m.copy().canonical()
    // Canonicalize the parsed manifest to compare
    const reparsed = await Manifest.parse(storedText)
    const reparsedCanonical = reparsed.copy()
    reparsedCanonical.canonicalize()
    expect(reparsedCanonical.canonical()).toBe(canonicalText)
  })
})
