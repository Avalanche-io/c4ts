import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Manifest } from '../src/manifest.js'
import { encode } from '../src/encoder.js'

// Cross-implementation vector: ID lists through merge, diff and patch
// (2026-11-13). The shared contract lives in the Go reference repo at
// c4m/testdata/range-data-vector, from c4 master b82ec07 (#159, #160,
// #161); the files under fixtures/range-data-vector/ here are
// byte-identical copies.
//
// Ruled 2026-11-13 by the maintainer: "A frame id list is a part of the
// c4m format, and is the same thing as a subdirectory being referenced by
// it's ID on a parents directory line." An output carries the list of
// every range it holds and no list for a range it does not; none is
// invented.
//
// This is the decode half. Resolving a chain keeps the lists of the ranges
// the resolved state holds and drops the list of a range a patch removed
// (remove-chain.c4m). A range line whose list is not inline is valid and
// re-encodes as is (folded-no-lists.c4m). The lists never change a
// description ID. c4ts has no sequence expander, so the expansion rows
// (#160) do not apply; neither do the merge, diff and patch rows, which
// c4ts's merge, applyPatch and patchDiff do not yet meet (they carry no
// lists).

const dir = fileURLToPath(new URL('./fixtures/range-data-vector/', import.meta.url))
const load = (name: string) => readFile(dir + name, 'utf8')
const PLATE = 'plate.[1001-1004].exr'

describe('range data vector (decode half)', () => {
  it('remove-chain.c4m resolves to no-plate.c4m: the removed plate range takes its list with it', async () => {
    const m = await Manifest.parse(await load('remove-chain.c4m'))
    expect(m.entries.some(e => e.name === PLATE)).toBe(false)
    expect(m.rangeData.size).toBe(1)
    expect(encode(m)).toBe(await load('no-plate.c4m'))
  })

  it('add-chain.c4m resolves to folded.c4m: both lists, written in the patch section, are kept', async () => {
    const m = await Manifest.parse(await load('add-chain.c4m'))
    expect(m.rangeData.size).toBe(2)
    expect(encode(m)).toBe(await load('folded.c4m'))
  })

  it('folded-no-lists.c4m is valid and re-encodes as is, with no list invented', async () => {
    const text = await load('folded-no-lists.c4m')
    const m = await Manifest.parse(text)
    expect(m.rangeData.size).toBe(0)
    expect(encode(m)).toBe(text)
  })

  it('the lists never change a description ID', async () => {
    const folded = await Manifest.parse(await load('folded.c4m'))
    const bare = await Manifest.parse(await load('folded-no-lists.c4m'))
    expect(folded.rangeData.size).toBe(2)
    expect((await folded.computeC4ID()).toString()).toBe((await bare.computeC4ID()).toString())
    for (const f of ['merged.c4m', 'no-plate.c4m']) {
      const m = await Manifest.parse(await load(f))
      const id = (await m.computeC4ID()).toString()
      m.rangeData = new Map()
      expect((await m.computeC4ID()).toString(), f).toBe(id)
    }
  })
})
