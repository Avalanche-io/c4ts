import { describe, it, expect } from 'vitest'
import { C4ID, identify, identifyBytes, parse } from '../src/id.js'
import { treeId } from '../src/tree.js'
import vectors from './vectors/known_ids.json'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a hex string to Uint8Array. Empty string returns empty Uint8Array. */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length === 0) return new Uint8Array(0)
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
  }
  return bytes
}

// ---------------------------------------------------------------------------
// 1. Cross-language single ID vectors (all 9)
// ---------------------------------------------------------------------------

describe('cross-language single ID vectors', () => {
  for (const v of vectors.single_ids) {
    describe(`input: ${v.input_repr}`, () => {
      it(`produces correct c4id string`, async () => {
        const input = hexToBytes(v.input_bytes_hex)
        const id = await identifyBytes(input)
        expect(id.toString()).toBe(v.c4id)
      })

      it(`produces correct digest hex`, async () => {
        const input = hexToBytes(v.input_bytes_hex)
        const id = await identifyBytes(input)
        expect(id.hex()).toBe(v.digest_hex)
      })
    })
  }

  it('empty string vector produces a 90-char string starting with "c4"', async () => {
    const emptyVec = vectors.single_ids[0]
    expect(emptyVec.input_repr).toBe('empty string')
    const id = await identifyBytes(new Uint8Array(0))
    expect(id.toString()).toHaveLength(90)
    expect(id.toString().startsWith('c4')).toBe(true)
    expect(id.toString()).toBe(emptyVec.c4id)
  })
})

// ---------------------------------------------------------------------------
// 2. Cross-language tree ID vectors (all 3)
// ---------------------------------------------------------------------------

describe('cross-language tree ID vectors', () => {
  /** Identify a UTF-8 string and return its C4ID. */
  async function idOf(s: string): Promise<C4ID> {
    return identifyBytes(new TextEncoder().encode(s))
  }

  it('tree of foo+bar', async () => {
    const fooId = await idOf('foo')
    const barId = await idOf('bar')
    const tree = await treeId([fooId, barId])
    expect(tree.toString()).toBe(vectors.tree_ids[0].tree_id)
  })

  it('tree of foo+bar+baz', async () => {
    const fooId = await idOf('foo')
    const barId = await idOf('bar')
    const bazId = await idOf('baz')
    const tree = await treeId([fooId, barId, bazId])
    expect(tree.toString()).toBe(vectors.tree_ids[1].tree_id)
  })

  it('tree of bar+foo equals tree of foo+bar (order independence)', async () => {
    const fooId = await idOf('foo')
    const barId = await idOf('bar')

    const treeFooBar = await treeId([fooId, barId])
    const treeBarFoo = await treeId([barId, fooId])

    expect(treeBarFoo.toString()).toBe(treeFooBar.toString())
    expect(treeFooBar.toString()).toBe(vectors.tree_ids[2].tree_id)
  })
})

// ---------------------------------------------------------------------------
// 3. C4ID class
// ---------------------------------------------------------------------------

describe('C4ID class', () => {
  it('toString() produces a 90-char string starting with "c4"', async () => {
    const id = await identifyBytes(new TextEncoder().encode('hello'))
    const s = id.toString()
    expect(s).toHaveLength(90)
    expect(s.slice(0, 2)).toBe('c4')
  })

  it('parse() round-trips correctly', async () => {
    const id = await identifyBytes(new TextEncoder().encode('test'))
    const s = id.toString()
    const parsed = C4ID.parse(s)
    expect(parsed.toString()).toBe(s)
    expect(parsed.hex()).toBe(id.hex())
    expect(parsed.equals(id)).toBe(true)
  })

  it('parse() round-trips for all single_id vectors', async () => {
    for (const v of vectors.single_ids) {
      const id = await identifyBytes(hexToBytes(v.input_bytes_hex))
      const parsed = C4ID.parse(v.c4id)
      expect(parsed.toString()).toBe(v.c4id)
      expect(parsed.equals(id)).toBe(true)
    }
  })

  it('isNil() returns true for nil ID', () => {
    const nil = C4ID.nil()
    expect(nil.isNil()).toBe(true)
  })

  it('isNil() returns false for non-nil ID', async () => {
    const id = await identifyBytes(new Uint8Array(0))
    expect(id.isNil()).toBe(false)
  })

  it('equals() returns true for identical IDs', async () => {
    const id1 = await identifyBytes(new TextEncoder().encode('same'))
    const id2 = await identifyBytes(new TextEncoder().encode('same'))
    expect(id1.equals(id2)).toBe(true)
  })

  it('equals() returns false for different IDs', async () => {
    const id1 = await identifyBytes(new TextEncoder().encode('one'))
    const id2 = await identifyBytes(new TextEncoder().encode('two'))
    expect(id1.equals(id2)).toBe(false)
  })

  it('compareTo() returns 0 for equal IDs', async () => {
    const id1 = await identifyBytes(new TextEncoder().encode('same'))
    const id2 = await identifyBytes(new TextEncoder().encode('same'))
    expect(id1.compareTo(id2)).toBe(0)
  })

  it('compareTo() returns -1 or 1 for different IDs', async () => {
    const id1 = await identifyBytes(new TextEncoder().encode('alpha'))
    const id2 = await identifyBytes(new TextEncoder().encode('beta'))
    const cmp = id1.compareTo(id2)
    expect(cmp === -1 || cmp === 1).toBe(true)
    expect(id2.compareTo(id1)).toBe(-cmp)
  })

  it('compareTo() is antisymmetric', async () => {
    const id1 = await identifyBytes(new TextEncoder().encode('x'))
    const id2 = await identifyBytes(new TextEncoder().encode('y'))
    const a = id1.compareTo(id2)
    const b = id2.compareTo(id1)
    expect(a).toBe(-b)
  })

  it('hex() returns 128-char lowercase hex string', async () => {
    const id = await identifyBytes(new TextEncoder().encode('foo'))
    const h = id.hex()
    expect(h).toHaveLength(128)
    expect(h).toMatch(/^[0-9a-f]+$/)
  })

  it('hex() matches known vector', async () => {
    const fooVec = vectors.single_ids.find(v => v.input_repr === 'foo')!
    const id = await identifyBytes(hexToBytes(fooVec.input_bytes_hex))
    expect(id.hex()).toBe(fooVec.digest_hex)
  })

  it('fromDigest() creates a valid ID from raw digest bytes', async () => {
    const id = await identifyBytes(new TextEncoder().encode('bar'))
    const copy = C4ID.fromDigest(id.digest)
    expect(copy.equals(id)).toBe(true)
    expect(copy.toString()).toBe(id.toString())
  })

  it('fromDigest() copies the data (no aliasing)', async () => {
    const id = await identifyBytes(new TextEncoder().encode('test'))
    const digestCopy = new Uint8Array(id.digest)
    const fromD = C4ID.fromDigest(digestCopy)
    // Mutate the source array
    digestCopy[0] ^= 0xff
    // fromDigest should have its own copy
    expect(fromD.equals(id)).toBe(true)
  })

  it('sum() is order-independent', async () => {
    const id1 = await identifyBytes(new TextEncoder().encode('a'))
    const id2 = await identifyBytes(new TextEncoder().encode('b'))
    const s1 = await id1.sum(id2)
    const s2 = await id2.sum(id1)
    expect(s1.equals(s2)).toBe(true)
  })

  it('sum() of equal IDs returns self', async () => {
    const id = await identifyBytes(new TextEncoder().encode('same'))
    const s = await id.sum(id)
    expect(s.equals(id)).toBe(true)
  })

  it('nil() returns a 64-byte all-zero digest', () => {
    const nil = C4ID.nil()
    expect(nil.digest.length).toBe(64)
    for (let i = 0; i < 64; i++) {
      expect(nil.digest[i]).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------
// 4. Parse edge cases
// ---------------------------------------------------------------------------

describe('parse edge cases', () => {
  it('throws on wrong length (too short)', () => {
    expect(() => parse('c4abc')).toThrow(/must be 90 characters/)
  })

  it('throws on wrong length (too long)', () => {
    const tooLong = 'c4' + '1'.repeat(89)
    expect(() => parse(tooLong)).toThrow(/must be 90 characters/)
  })

  it('throws on empty string', () => {
    expect(() => parse('')).toThrow(/must be 90 characters/)
  })

  it('throws on invalid prefix', () => {
    // 90 chars but wrong prefix
    const bad = 'x4' + '1'.repeat(88)
    expect(() => parse(bad)).toThrow(/must start with "c4"/)
  })

  it('throws on invalid prefix "c5"', () => {
    const bad = 'c5' + '1'.repeat(88)
    expect(() => parse(bad)).toThrow(/must start with "c4"/)
  })

  it('throws on invalid base58 character (0)', () => {
    // '0' is not in the base58 alphabet
    const bad = 'c4' + '0'.repeat(88)
    expect(() => parse(bad)).toThrow(/non c4 id character/)
  })

  it('throws on invalid base58 character (O)', () => {
    // 'O' (uppercase letter O) is not in the base58 alphabet
    const bad = 'c4' + 'O'.repeat(88)
    expect(() => parse(bad)).toThrow(/non c4 id character/)
  })

  it('throws on invalid base58 character (I)', () => {
    // 'I' (uppercase letter I) is not in the base58 alphabet
    const bad = 'c4' + 'I'.repeat(88)
    expect(() => parse(bad)).toThrow(/non c4 id character/)
  })

  it('throws on invalid base58 character (l)', () => {
    // 'l' (lowercase letter L) is not in the base58 alphabet
    const bad = 'c4' + 'l'.repeat(88)
    expect(() => parse(bad)).toThrow(/non c4 id character/)
  })

  it('constructor throws on wrong digest length', () => {
    expect(() => new C4ID(new Uint8Array(32))).toThrow(/digest must be 64 bytes/)
    expect(() => new C4ID(new Uint8Array(0))).toThrow(/digest must be 64 bytes/)
    expect(() => new C4ID(new Uint8Array(128))).toThrow(/digest must be 64 bytes/)
  })
})

// ---------------------------------------------------------------------------
// 5. identifyBytes and identify with various inputs
// ---------------------------------------------------------------------------

describe('identifyBytes', () => {
  it('identifies empty input', async () => {
    const emptyVec = vectors.single_ids[0]
    const id = await identifyBytes(new Uint8Array(0))
    expect(id.toString()).toBe(emptyVec.c4id)
  })

  it('identifies single byte (null byte)', async () => {
    const nullVec = vectors.single_ids.find(v => v.input_repr === 'null byte')!
    const id = await identifyBytes(new Uint8Array([0x00]))
    expect(id.toString()).toBe(nullVec.c4id)
  })

  it('identifies single byte (newline)', async () => {
    const nlVec = vectors.single_ids.find(v => v.input_repr === 'newline')!
    const id = await identifyBytes(new Uint8Array([0x0a]))
    expect(id.toString()).toBe(nlVec.c4id)
  })

  it('identifies multi-byte UTF-8 string', async () => {
    const helloVec = vectors.single_ids.find(v => v.input_repr === 'hello world')!
    const input = new TextEncoder().encode('hello world')
    const id = await identifyBytes(input)
    expect(id.toString()).toBe(helloVec.c4id)
  })

  it('same input always produces same ID', async () => {
    const data = new TextEncoder().encode('deterministic')
    const id1 = await identifyBytes(data)
    const id2 = await identifyBytes(data)
    expect(id1.toString()).toBe(id2.toString())
    expect(id1.equals(id2)).toBe(true)
  })

  it('different inputs produce different IDs', async () => {
    const id1 = await identifyBytes(new TextEncoder().encode('input1'))
    const id2 = await identifyBytes(new TextEncoder().encode('input2'))
    expect(id1.equals(id2)).toBe(false)
    expect(id1.toString()).not.toBe(id2.toString())
  })
})

describe('identify', () => {
  it('accepts Uint8Array', async () => {
    const fooVec = vectors.single_ids.find(v => v.input_repr === 'foo')!
    const data = new TextEncoder().encode('foo')
    const id = await identify(data)
    expect(id.toString()).toBe(fooVec.c4id)
  })

  it('accepts ArrayBuffer', async () => {
    const fooVec = vectors.single_ids.find(v => v.input_repr === 'foo')!
    const data = new TextEncoder().encode('foo')
    const id = await identify(data.buffer as ArrayBuffer)
    expect(id.toString()).toBe(fooVec.c4id)
  })

  it('accepts ReadableStream', async () => {
    const fooVec = vectors.single_ids.find(v => v.input_repr === 'foo')!
    const data = new TextEncoder().encode('foo')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data)
        controller.close()
      },
    })
    const id = await identify(stream)
    expect(id.toString()).toBe(fooVec.c4id)
  })

  it('handles ReadableStream with multiple chunks', async () => {
    const helloVec = vectors.single_ids.find(v => v.input_repr === 'hello world')!
    const enc = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('hello'))
        controller.enqueue(enc.encode(' '))
        controller.enqueue(enc.encode('world'))
        controller.close()
      },
    })
    const id = await identify(stream)
    expect(id.toString()).toBe(helloVec.c4id)
  })

  it('handles ReadableStream with empty content', async () => {
    const emptyVec = vectors.single_ids[0]
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    })
    const id = await identify(stream)
    expect(id.toString()).toBe(emptyVec.c4id)
  })
})

// ---------------------------------------------------------------------------
// Additional tree ID tests
// ---------------------------------------------------------------------------

describe('treeId edge cases', () => {
  it('empty input returns nil ID', async () => {
    const tree = await treeId([])
    expect(tree.isNil()).toBe(true)
  })

  it('single element returns itself', async () => {
    const id = await identifyBytes(new TextEncoder().encode('solo'))
    const tree = await treeId([id])
    expect(tree.equals(id)).toBe(true)
  })

  it('deduplicates equal IDs', async () => {
    const id = await identifyBytes(new TextEncoder().encode('dup'))
    const tree1 = await treeId([id])
    const tree2 = await treeId([id, id])
    expect(tree1.equals(tree2)).toBe(true)
  })

  it('order independence with three elements', async () => {
    const a = await identifyBytes(new TextEncoder().encode('a'))
    const b = await identifyBytes(new TextEncoder().encode('b'))
    const c = await identifyBytes(new TextEncoder().encode('c'))

    const tree1 = await treeId([a, b, c])
    const tree2 = await treeId([c, a, b])
    const tree3 = await treeId([b, c, a])

    expect(tree1.equals(tree2)).toBe(true)
    expect(tree2.equals(tree3)).toBe(true)
  })
})
