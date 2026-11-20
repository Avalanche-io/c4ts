import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, mkdir, readFile, stat, writeFile, utimes, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFS } from '../src/node-fs.js'
import { scan } from '../../core/src/scanner.js'
import { plan, apply } from '../../core/src/reconcile.js'
import { MemoryStore } from '../../core/src/memory-store.js'
import type { Manifest } from '../../core/src/manifest.js'
import { timestampIsNull } from '../../core/src/entry.js'

// What reconcile does with a null timestamp on a path it creates.
// - A null timestamp on a file this apply writes (a create, or an overwrite
//   of different content), or on a directory it makes, becomes the epoch,
//   which scans back as null, so a null-dated tree reads back at its ID.
//   Through 1.0.26 a directory made from a null time kept the time it was
//   made. On a path that already exists a null never overwrites. This is
//   core's reconcile/apply.go setMetadata (dfd6e12).
// The null-dated inputs are real trees dated at the epoch and scanned.

const KNOWN = new Date('2023-11-14T22:13:20Z')
const EPOCH = new Date(0)
let dir = ''
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = ''
})

async function epochTree(root: string): Promise<void> {
  await mkdir(join(root, 'sub', 'deep'), { recursive: true })
  await writeFile(join(root, 'a.txt'), 'a\n')
  await writeFile(join(root, 'sub', 'deep', 'b.txt'), 'b\n')
  for (const p of ['a.txt', 'sub/deep/b.txt', 'sub/deep', 'sub']) await utimes(join(root, p), EPOCH, EPOCH)
}

async function mtime(p: string): Promise<number> {
  return (await stat(p)).mtime.getTime()
}

async function nullDated(): Promise<{ m: Manifest; store: MemoryStore; fs: NodeFS }> {
  dir = await mkdtemp(join(tmpdir(), 'c4ts-epoch-'))
  await epochTree(join(dir, 'src'))
  const fs = new NodeFS()
  const store = new MemoryStore()
  const m = await scan(fs, join(dir, 'src'), { store })
  for (const [, e] of m) expect(timestampIsNull(e.timestamp)).toBe(true)
  return { m, store, fs }
}

describe('a path reconcile creates from a null timestamp gets the epoch', () => {
  it('files and directories it creates', async () => {
    const { m, store, fs } = await nullDated()
    const out = join(dir, 'out')
    await mkdir(out)
    const res = await apply(await plan(m, fs, out, store), fs, out, store)
    expect(res.errors).toEqual([])
    for (const p of ['a.txt', 'sub', 'sub/deep', 'sub/deep/b.txt']) expect(await mtime(join(out, p)), p).toBe(0)
  })

  it('so a null-dated tree reads back at its ID', async () => {
    const { m, store, fs } = await nullDated()
    const out = join(dir, 'out')
    await mkdir(out)
    await apply(await plan(m, fs, out, store), fs, out, store)
    const back = await scan(fs, out)
    expect((await back.computeC4ID()).toString()).toBe((await m.computeC4ID()).toString())
  })

  it('an overwritten file is fresh too', async () => {
    const { m, store, fs } = await nullDated()
    const out = join(dir, 'out')
    await mkdir(out)
    await writeFile(join(out, 'a.txt'), 'old content\n')
    await utimes(join(out, 'a.txt'), KNOWN, KNOWN)
    await apply(await plan(m, fs, out, store), fs, out, store)
    expect(await readFile(join(out, 'a.txt'), 'utf8')).toBe('a\n')
    expect(await mtime(join(out, 'a.txt'))).toBe(0)
  })

  it('a null never overwrites an existing path', async () => {
    const { m, store, fs } = await nullDated()
    const out = join(dir, 'out')
    await mkdir(join(out, 'sub', 'deep'), { recursive: true })
    await writeFile(join(out, 'a.txt'), 'a\n') // already the right content
    for (const p of ['a.txt', 'sub/deep', 'sub']) await utimes(join(out, p), KNOWN, KNOWN)
    await apply(await plan(m, fs, out, store), fs, out, store)
    // Only sub/deep/b.txt, which this apply wrote, takes the epoch. sub/
    // keeps its time; sub/deep/ gained a child, which moves a directory's
    // time on a real filesystem, and a null doesn't set it back.
    expect(await mtime(join(out, 'a.txt'))).toBe(KNOWN.getTime())
    expect(await mtime(join(out, 'sub'))).toBe(KNOWN.getTime())
    expect(await mtime(join(out, 'sub', 'deep'))).not.toBe(0)
    expect(await mtime(join(out, 'sub', 'deep', 'b.txt'))).toBe(0)
  })
})
