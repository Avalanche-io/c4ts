import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFS } from '../src/node-fs.js'
import { scan } from '../../core/src/scanner.js'
import { Workspace } from '../../core/src/workspace.js'
import { MemoryStore } from '../../core/src/memory-store.js'

// On a real filesystem writing a child moves its directory's mtime, so a
// checkout must set each directory's recorded time after its children are
// written, deepest first, or the tree does not read back at the c4m's ID
// (a directory's timestamp is part of its parent's listing). Through
// 2026-11-16 checkout set times on files only.

let dir = ''
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = ''
})

describe('checkout on a real filesystem', () => {
  it('reads back at the c4m\'s ID, directory times included', async () => {
    dir = await mkdtemp(join(tmpdir(), 'c4ts-dirmeta-'))
    const src = join(dir, 'project')
    await mkdir(join(src, 'sub', 'deep'), { recursive: true })
    await writeFile(join(src, 'top.txt'), 'top')
    await writeFile(join(src, 'sub', 'mid.txt'), 'mid')
    await writeFile(join(src, 'sub', 'deep', 'leaf.txt'), 'leaf')
    // Directory times well in the past, set after their children, so the
    // checkout below can never share their second.
    const old = new Date('2020-01-02T03:04:05Z')
    for (const d of [join(src, 'sub', 'deep'), join(src, 'sub')]) await utimes(d, old, old)

    const fs = new NodeFS()
    const store = new MemoryStore()
    const original = await scan(fs, src, { store })
    expect(original.get('sub/deep/')!.timestamp.getTime()).toBe(old.getTime())

    const work = join(dir, 'work')
    await mkdir(work)
    const ws = new Workspace(work, fs, store)
    await ws.checkout(original)

    expect((await ws.diffFromCurrent()).modified.map(x => x.path)).toEqual([])
    const back = await scan(fs, work)
    expect(back.get('sub/deep/')!.timestamp.getTime()).toBe(old.getTime())
    expect(back.get('sub/')!.timestamp.getTime()).toBe(old.getTime())
    expect((await back.computeC4ID()).toString()).toBe((await original.computeC4ID()).toString())
  })
})
