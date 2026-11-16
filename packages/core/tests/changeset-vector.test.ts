import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Manifest } from '../src/manifest.js'
import { encode } from '../src/encoder.js'
import { applyPatch, patchDiff } from '../src/diff.js'
import { MemoryFS } from '../src/memory-fs.js'
import { scan } from '../src/scanner.js'

// The shared changeset vector (c4 #175, c4m/testdata/changeset-vector),
// vendored byte for byte from c4 0b410a2. Its MUST rule: every patch writer,
// given base.c4m and v2.c4m, writes changeset.c4m byte for byte, and every
// chain reader resolves chain.c4m to v2.c4m. c4ts writes a changeset as c4
// diff does. On the 1.0.x line the encoder drops a base line (keeping it is
// c4 #145, 1.1), so the old state's C4 ID is printed before the encoded
// patch, as core release/1.0.27's c4 diff does.

const dir = fileURLToPath(new URL('./fixtures/changeset-vector/', import.meta.url))
const load = (name: string) => readFile(dir + name, 'utf8')
const parse = async (name: string) => Manifest.parse(await load(name))

async function changeset(): Promise<string> {
  const { oldID, patch } = await patchDiff(await parse('base.c4m'), await parse('v2.c4m'))
  return oldID + '\n' + encode(patch)
}

describe('changeset vector', () => {
  it('patchDiff, written as c4 diff writes it, is changeset.c4m byte for byte', async () => {
    expect(await changeset()).toBe(await load('changeset.c4m'))
  })

  it('the changeset never ends with a bare C4 ID', async () => {
    const last = (await changeset()).trimEnd().split('\n').pop()!
    expect(last.length === 90 && last.startsWith('c4')).toBe(false)
  })

  it('chain.c4m resolves to v2.c4m', async () => {
    const m = await parse('chain.c4m')
    expect(m.has('sub/gone.txt')).toBe(false)
    expect(encode(m)).toBe(await load('v2.c4m'))
  })

  it("base.c4m with c4ts's own changeset appended resolves to v2.c4m", async () => {
    expect(encode(await Manifest.parse((await load('base.c4m')) + (await changeset())))).toBe(await load('v2.c4m'))
  })

  it("changeset.c4m's patch applied to base.c4m is v2.c4m", async () => {
    const patch = await Manifest.parse((await load('changeset.c4m')).split('\n').slice(1).join('\n'))
    expect(encode(applyPatch(await parse('base.c4m'), patch))).toBe(await load('v2.c4m'))
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
    const oldID = (await before.computeC4ID()).toString()
    const chain = await Manifest.parse(encode(before) + oldID + '\n' + encode(patch))
    expect(chain.has('a/new.txt')).toBe(true)
    expect(encode(chain)).toBe(encode(after))
  })
})
