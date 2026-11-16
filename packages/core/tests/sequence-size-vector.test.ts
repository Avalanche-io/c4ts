import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Manifest } from '../src/manifest.js'
import { encode } from '../src/encoder.js'
import { sizeIsNull, NULL_SIZE } from '../src/entry.js'

// Cross-implementation vector: a range's size counts its ID list
// (2026-11-13). The shared contract lives in the Go reference repo at
// c4m/testdata/sequence-size-vector, from c4 master b82ec07 (#161); the
// files under fixtures/sequence-size-vector/ here are byte-identical copies.
//
// Ruled 2026-11-13 by the maintainer: "The size is the size of every frame
// and the frame id list." A range's size is its frames' bytes plus count ×
// 90; a directory holding a range follows the ordinary rule with the range
// as one child: its children's sizes plus its listing as written, the
// folded one. c4ts neither folds nor expands sequences, so this tests the
// decode and normaliser half: the sizes read back, and the normaliser
// (canonicalize) derives sub/'s size over the range child as 303 + 143.

const dir = fileURLToPath(new URL('./fixtures/sequence-size-vector/', import.meta.url))
const load = (name: string) => readFile(dir + name, 'utf8')

describe('sequence size vector (decode and normaliser half; c4ts does not fold)', () => {
  it('folded.c4m: the range is 303 (33 of frames + 3 × 90 of list) and sub/ is 446 (303 + 143)', async () => {
    const m = await Manifest.parse(await load('folded.c4m'))
    const sub = m.entries.find(e => e.name === 'sub/')!
    const range = m.entries.find(e => e.name === 'f.[001-003].exr')!
    expect(range.isSequence).toBe(true)
    expect(range.size).toBe(303)
    expect(sub.size).toBe(446)
  })

  it('the normaliser derives sub/ as 446 from the folded listing, and writes folded.c4m byte for byte', async () => {
    const text = await load('folded.c4m')
    const m = await Manifest.parse(text)
    const sub = m.entries.find(e => e.name === 'sub/')!
    sub.size = NULL_SIZE
    m.canonicalize()
    expect(sub.size).toBe(446)
    expect(encode(m)).toBe(text)
  })

  it('a null range size makes sub/ null under the normaliser', async () => {
    const m = await Manifest.parse(await load('folded.c4m'))
    const sub = m.entries.find(e => e.name === 'sub/')!
    m.entries.find(e => e.name === 'f.[001-003].exr')!.size = NULL_SIZE
    sub.size = NULL_SIZE
    m.canonicalize()
    expect(sizeIsNull(sub)).toBe(true)
  })

  it('expanded.c4m: the range keeps 303 and each frame reads back with a null size', async () => {
    const m = await Manifest.parse(await load('expanded.c4m'))
    expect(m.entries.find(e => e.name === 'f.[001-003].exr')!.size).toBe(303)
    for (const n of ['f.001.exr', 'f.002.exr', 'f.003.exr']) {
      expect(sizeIsNull(m.entries.find(e => e.name === n)!), n).toBe(true)
    }
    expect(m.entries.find(e => e.name === 'sub/')!.size).toBe(446)
  })
})
