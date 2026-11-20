import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NodeFS } from '../src/node-fs.js'
import { TreeStore } from '../src/tree-store.js'
import { Manifest } from '../../core/src/manifest.js'
import { plan, apply } from '../../core/src/reconcile.js'
import { Workspace } from '../../core/src/workspace.js'
import { scan } from '../../core/src/scanner.js'
import { parse } from '../../core/src/id.js'
import { C4Error } from '../../core/src/errors.js'

// A description holding a folded range is refused before anything is
// written. c4ts has no range expander, so it can't write a folded range
// (one line such as `frame.[0001-0003].exr` standing for numbered frames)
// back to files; through this change reconcile wrote the range line as one
// file under the range's name, holding the ID list's bytes, and counted it
// created. The fixture (made by the Go c4 CLI; see its README) holds a range
// beside a file, one nested in a subdirectory, two in one folder, and a
// stored listing whose range carries no inline list. The same trees
// unfolded still round-trip.

const VECTOR = fileURLToPath(new URL('./fixtures/folded-range-refusal/', import.meta.url))
const FOLDED: Record<string, string[]> = {
  'A-folded.c4m': ['frame.[0001-0003].exr'],
  'B-folded.c4m': ['shots/s010/img.[0001-0003].dpx'],
  'C-folded.c4m': ['a.[0001-0003].exr', 'b.[0001-0003].exr'],
  'B-s010.c4m': ['img.[0001-0003].dpx'],
}
const ids = Object.fromEntries(
  readFileSync(join(VECTOR, 'plain-ids.txt'), 'utf8').trim().split('\n').map(l => l.split(' ')),
)

// Windows has no POSIX modes, so a tree materialised there scans with other
// modes and a different description ID (as in core's epoch-second vector:
// the IDs agree "on a platform with POSIX modes"). There the files' paths and
// C4 IDs are compared; the description ID only where modes exist.
const win = process.platform === 'win32'
let dir = ''
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = ''
})

async function walk(root: string, at = root): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(at, { withFileTypes: true })) {
    const p = join(at, e.name)
    out.push(relative(root, p))
    if (e.isDirectory()) out.push(...(await walk(root, p)))
  }
  return out.sort()
}

async function files(at: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(at, { withFileTypes: true })) {
    const p = join(at, e.name)
    if (e.isDirectory()) out.push(...(await files(p)))
    else out.push(p)
  }
  return out
}

/** A store holding every tree file and B's ID list: everything a range needs. */
async function fullStore(): Promise<TreeStore> {
  const store = new TreeStore(join(dir, 'store'))
  for (const p of await files(join(VECTOR, 'trees'))) {
    await store.put(new Uint8Array(await readFile(p)))
  }
  await store.put(new Uint8Array(await readFile(join(VECTOR, 'B-s010.list'))))
  return store
}

async function load(name: string): Promise<Manifest> {
  return Manifest.parse(await readFile(join(VECTOR, name), 'utf8'))
}

describe('a folded range is refused before anything is written', () => {
  for (const [name, ranges] of Object.entries(FOLDED)) {
    for (const withLists of [true, false]) {
      it(`${name}, ${withLists ? 'the store holding its lists' : 'an empty store'}`, async () => {
        dir = await mkdtemp(join(tmpdir(), 'c4ts-folded-'))
        const store = withLists ? await fullStore() : new TreeStore(join(dir, 'empty-store'))
        const m = await load(name)
        if (name === 'B-s010.c4m') {
          // The stored listing carries no inline list; the list is in the
          // store under the range's C4 ID, or (empty store) nowhere.
          expect(m.rangeData.size).toBe(0)
          expect(await store.has(parse(ids.range))).toBe(withLists)
        }
        const target = join(dir, 'out')
        await mkdir(target)
        const fs = new NodeFS()
        const err = await plan(m, fs, target, store).then(() => null, e => e)
        expect(err).toBeInstanceOf(C4Error)
        expect(err.message).toContain("can't write a folded range")
        expect(err.message).toContain('nothing was written')
        for (const r of ranges) expect(err.message).toContain(r)
        expect(await walk(target)).toEqual([])
      })
    }
  }

  it('leaves an existing target untouched', async () => {
    dir = await mkdtemp(join(tmpdir(), 'c4ts-folded-'))
    const target = join(dir, 'out')
    await mkdir(target)
    await writeFile(join(target, 'keep.txt'), 'keep')
    await expect(plan(await load('A-folded.c4m'), new NodeFS(), target, await fullStore())).rejects.toThrow(
      "can't write a folded range",
    )
    expect(await walk(target)).toEqual(['keep.txt'])
    expect(await readFile(join(target, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('Workspace.checkout refuses too, and saves no state', async () => {
    dir = await mkdtemp(join(tmpdir(), 'c4ts-folded-'))
    const target = join(dir, 'ws')
    await mkdir(target)
    const ws = new Workspace(target, new NodeFS(), await fullStore())
    await expect(ws.checkout(await load('B-folded.c4m'))).rejects.toThrow("can't write a folded range")
    await expect(ws.checkout(await load('B-folded.c4m'), { dryRun: true })).rejects.toThrow(
      "can't write a folded range",
    )
    expect(await walk(target)).toEqual([])
    expect(ws.manifest).toBeNull()
  })
})

describe('the same trees unfolded still round-trip', () => {
  for (const tree of ['A', 'B', 'C']) {
    it(`${tree}-plain.c4m`, async () => {
      dir = await mkdtemp(join(tmpdir(), 'c4ts-folded-'))
      const store = await fullStore()
      const m = await load(`${tree}-plain.c4m`)
      expect((await m.computeC4ID()).toString()).toBe(ids[tree])
      const target = join(dir, 'out')
      await mkdir(target)
      const fs = new NodeFS()
      const res = await apply(await plan(m, fs, target, store), fs, target, store)
      expect(res.errors).toEqual([])
      const back = await scan(fs, target)
      const files = (x: Manifest) =>
        [...x].filter(([, e]) => !e.name.endsWith('/')).map(([path, e]) => `${path} ${e.c4id}`)
      expect(files(back)).toEqual(files(m))
      if (!win) expect((await back.computeC4ID()).toString()).toBe(ids[tree])
    })
  }
})
