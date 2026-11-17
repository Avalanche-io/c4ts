import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Manifest } from '../src/manifest.js'
import { encode } from '../src/encoder.js'
import { applyPatch, patchDiff } from '../src/diff.js'
import { C4ID } from '../src/id.js'
import { MemoryFS } from '../src/memory-fs.js'
import { scan } from '../src/scanner.js'

// The shared changeset vector (c4 #175, c4m/testdata/changeset-vector),
// vendored byte for byte from c4 bb44b43 (changeset-vector-rmdir), which adds
// the second step, v2 to v3, removing the directory sub/deep/. Its MUST rule:
// every patch writer, given each step's old and new states, writes that
// step's changeset byte for byte, and every chain reader resolves the step's
// chain to its new state. c4ts writes a changeset as c4 diff does:
// patchDiff's patch with the old state's C4 ID as its base line, encoded.

const dir = fileURLToPath(new URL('./fixtures/changeset-vector/', import.meta.url))
const load = (name: string) => readFile(dir + name, 'utf8')
const parse = async (name: string) => Manifest.parse(await load(name))

async function changeset(oldName: string, newName: string): Promise<string> {
  const { oldID, patch } = await patchDiff(await parse(oldName), await parse(newName))
  patch.base = C4ID.parse(oldID)
  return encode(patch)
}

const steps = [
  { old: 'base.c4m', new: 'v2.c4m', changeset: 'changeset.c4m', chain: 'chain.c4m' },
  { old: 'v2.c4m', new: 'v3.c4m', changeset: 'changeset-v3.c4m', chain: 'chain-v3.c4m' },
]

describe.each(steps)('changeset vector, $old to $new', (st) => {
  it(`patchDiff, written as c4 diff writes it, is ${st.changeset} byte for byte`, async () => {
    expect(await changeset(st.old, st.new)).toBe(await load(st.changeset))
  })

  it('the changeset never ends with a bare C4 ID', async () => {
    const last = (await changeset(st.old, st.new)).trimEnd().split('\n').pop()!
    expect(last.length === 90 && last.startsWith('c4')).toBe(false)
  })

  it(`${st.chain} resolves to ${st.new}`, async () => {
    expect(encode(await parse(st.chain))).toBe(await load(st.new))
  })

  it(`${st.old} with c4ts's own changeset appended resolves to ${st.new}`, async () => {
    const chain = (await load(st.old)) + (await changeset(st.old, st.new))
    expect(encode(await Manifest.parse(chain))).toBe(await load(st.new))
  })

  it(`${st.changeset}'s patch applied to ${st.old} is ${st.new}`, async () => {
    const patch = await Manifest.parse((await load(st.changeset)).split('\n').slice(1).join('\n'))
    expect(encode(applyPatch(await parse(st.old), patch))).toBe(await load(st.new))
  })
})

describe('changeset vector, the rows each step pins', () => {
  it('chain.c4m holds no sub/gone.txt', async () => {
    expect((await parse('chain.c4m')).has('sub/gone.txt')).toBe(false)
  })

  it('a removed directory is its own line alone: changeset-v3.c4m restates sub/deep/ and nothing under it', async () => {
    const { patch } = await patchDiff(await parse('v2.c4m'), await parse('v3.c4m'))
    const names = [...patch].map(([p]) => p)
    expect(names).toContain('sub/deep/')
    expect(names.filter(p => p.startsWith('sub/deep/') && p !== 'sub/deep/')).toEqual([])
    expect((await parse('chain-v3.c4m')).has('sub/deep/')).toBe(false)
  })
})

// Beyond the vector: an addition under one directory while a later sibling
// directory also changes. Without a tree-order section the added file sat
// after the later directory's subtree and was read as that directory's
// child. The two states are scanned from trees, never written by hand.
describe('patchDiff section order', () => {
  it('an added file stays under its own directory when a later directory also changes', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('before/a', { recursive: true })
    await fs.mkdir('before/b', { recursive: true })
    await fs.writeText('before/a/x.txt', 'x')
    await fs.writeText('before/b/y.txt', 'y')
    await fs.mkdir('after/a', { recursive: true })
    await fs.mkdir('after/b', { recursive: true })
    await fs.writeText('after/a/x.txt', 'x')
    await fs.writeText('after/a/new.txt', 'new')
    await fs.writeText('after/b/y.txt', 'y changed')
    const t = new Date('2026-01-02T09:04:05Z')
    for (const p of ['before/a', 'before/b', 'after/a', 'after/b', 'before/a/x.txt', 'before/b/y.txt',
      'after/a/x.txt', 'after/a/new.txt', 'after/b/y.txt']) await fs.setMeta(p, { mtime: t })
    const before = await scan(fs, 'before')
    const after = await scan(fs, 'after')
    const { patch } = await patchDiff(before, after)
    const out = applyPatch(before, patch)
    expect(out.has('a/new.txt')).toBe(true)
    expect(out.has('b/new.txt')).toBe(false)
    expect(encode(out)).toBe(encode(after))
    // The same changeset, appended to the old state's c4m, read as a chain.
    patch.base = C4ID.parse((await before.computeC4ID()).toString())
    const chain = await Manifest.parse(encode(before) + encode(patch))
    expect(chain.has('a/new.txt')).toBe(true)
    expect(encode(chain)).toBe(encode(after))
  })
})

// A removed directory is restated alone: a directory restated with children
// under it is deepened, never removed (SPECIFICATION.md "Patch Entry
// Semantics", erratum 2026-07-31), as core's PatchDiff writes it. Through
// 2026-11-16 patchDiff restated each removed child too, so its own patch for
// removing a directory read as a deepen and removed nothing but the files.
describe('patchDiff directory removal', () => {
  it('removing a directory restates it alone, and the patch removes it', async () => {
    const fs = new MemoryFS()
    for (const root of ['before', 'after']) {
      await fs.mkdir(`${root}/sub`, { recursive: true })
      await fs.writeText(`${root}/sub/mid.txt`, 'mid')
    }
    await fs.mkdir('before/sub/deep/deeper', { recursive: true })
    await fs.writeText('before/sub/deep/leaf.txt', 'leaf')
    await fs.writeText('before/sub/deep/deeper/x.txt', 'x')
    const t = new Date('2026-01-02T09:04:05Z')
    for (const p of ['before/sub', 'after/sub', 'before/sub/mid.txt', 'after/sub/mid.txt', 'before/sub/deep',
      'before/sub/deep/leaf.txt', 'before/sub/deep/deeper', 'before/sub/deep/deeper/x.txt']) await fs.setMeta(p, { mtime: t })
    const before = await scan(fs, 'before')
    const after = await scan(fs, 'after')
    const { patch } = await patchDiff(before, after)
    const names = [...patch].map(([p]) => p)
    expect(names).toContain('sub/deep/')
    expect(names.filter(p => p.startsWith('sub/deep/') && p !== 'sub/deep/')).toEqual([])
    const out = applyPatch(before, patch)
    expect(out.has('sub/deep/')).toBe(false)
    expect(out.has('sub/deep/leaf.txt')).toBe(false)
    expect(encode(out)).toBe(encode(after))
  })
})
