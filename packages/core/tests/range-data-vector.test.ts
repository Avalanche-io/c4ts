import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Manifest } from '../src/manifest.js'
import { encode } from '../src/encoder.js'
import { merge, applyPatch, patchDiff } from '../src/diff.js'
import { C4ID } from '../src/id.js'

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
// The decode half: resolving a chain keeps the lists of the ranges the
// resolved state holds and drops the list of a range a patch removed
// (remove-chain.c4m). A range line whose list is not inline is valid and
// re-encodes as is (folded-no-lists.c4m). The lists never change a
// description ID. The operations half runs every merge, diff and patch row
// of the vector's MUST table. c4ts has no sequence expander, so the two
// expansion rows (#160) have no operation to run here.

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

// The operations half: the vector's MUST rows for merge, diff and patch.
// Each output, encoded canonically, is the named file byte for byte. A
// two-way merge is a three-way merge over an empty base, as core's
// Merge(nil, a, b). A patch is written as c4 diff writes it: the old
// state's C4 ID, then the patch's entries, then the lists of the ranges it
// adds or changes.
const parse = async (name: string) => Manifest.parse(await load(name))

async function writtenPatch(oldName: string, newName: string): Promise<string> {
  const { oldID, patch } = await patchDiff(await parse(oldName), await parse(newName))
  patch.base = C4ID.parse(oldID)
  return encode(patch)
}

describe('range data vector (operations)', () => {
  for (const [a, b] of [['folded.c4m', 'plain.c4m'], ['plain.c4m', 'folded.c4m']]) {
    it(`merge ${a} with ${b} is merged.c4m: both lists carried`, async () => {
      const { merged, conflicts } = merge(Manifest.create(), await parse(a), await parse(b))
      expect(conflicts).toEqual([])
      expect(merged.rangeData.size).toBe(2)
      expect(encode(merged)).toBe(await load('merged.c4m'))
    })
  }

  it('merge folded.c4m with itself is folded.c4m', async () => {
    const { merged, conflicts } = merge(Manifest.create(), await parse('folded.c4m'), await parse('folded.c4m'))
    expect(conflicts).toEqual([])
    expect(encode(merged)).toBe(await load('folded.c4m'))
  })

  it('a merge that removes a range drops its list', async () => {
    const { merged } = merge(await parse('folded.c4m'), await parse('no-plate.c4m'), await parse('folded.c4m'))
    expect(merged.entries.some(e => e.name === PLATE)).toBe(false)
    expect(encode(merged)).toBe(await load('no-plate.c4m'))
  })

  it('diff plain.c4m to folded.c4m is add.c4m: both lists after the entries', async () => {
    expect(await writtenPatch('plain.c4m', 'folded.c4m')).toBe(await load('add.c4m'))
  })

  it('diff folded.c4m to no-plate.c4m is remove.c4m: a removal line takes no list', async () => {
    expect(await writtenPatch('folded.c4m', 'no-plate.c4m')).toBe(await load('remove.c4m'))
  })

  it('patch plain.c4m with add.c4m is folded.c4m', async () => {
    const out = applyPatch(await parse('plain.c4m'), await parse('add.c4m'))
    expect(out.rangeData.size).toBe(2)
    expect(encode(out)).toBe(await load('folded.c4m'))
  })

  it('patch folded.c4m with remove.c4m is no-plate.c4m: the removed range takes its list with it', async () => {
    const out = applyPatch(await parse('folded.c4m'), await parse('remove.c4m'))
    expect(out.rangeData.size).toBe(1)
    expect(encode(out)).toBe(await load('no-plate.c4m'))
  })
})

// filter is an operation that builds a c4m from a c4m, so it carries the
// lists of the ranges it keeps, as core's FilterByPath does. The vector has
// no filter row; these hold it to the same rule over the vector's files.
describe('range data vector (filter)', () => {
  it('a filter that keeps every entry is folded.c4m', async () => {
    const m = (await parse('folded.c4m')).filter(() => true)
    expect(encode(m)).toBe(await load('folded.c4m'))
  })

  it('a filter that leaves out the plate range carries only the shot list', async () => {
    const folded = await parse('folded.c4m')
    const shot = folded.entries.find(e => e.name === 'shot.[001-003].exr')!
    const m = folded.filter(p => p !== PLATE)
    expect([...m.rangeData.keys()]).toEqual([shot.c4id!.toString()])
    expect(m.rangeData.get(shot.c4id!.toString())).toBe(folded.rangeData.get(shot.c4id!.toString()))
  })
})
