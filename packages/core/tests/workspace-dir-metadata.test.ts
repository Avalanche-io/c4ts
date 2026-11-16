import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { MemoryStore, MemoryFS, Manifest, scan, Workspace, NULL_TIMESTAMP } from '../src/index.js'

// A directory's timestamp and mode are part of its parent's listing, so of
// its parent's C4 ID (SPECIFICATION.md, "Computing Directory C4 IDs"; a
// directory's timestamp is its own mtime, observed on disk). Materialising
// a c4m must therefore set each directory's recorded time and mode, after
// its children are written, or the tree it makes does not read back at the
// c4m's ID. Through 2026-11-16 checkout and reset set them on files only: a
// directory kept the time it was made, so any checkout in a later second
// than the scan left every directory holding a subdirectory "modified"
// (workspace.test.ts "diffFromCurrent is clean after checkout and reset of a
// tree with directories" failed whenever the two straddled a second).
//
// These tests pin the clock (Date only), so the scan and the checkout always
// fall in different seconds.

const T0 = new Date('2026-01-01T00:00:00.400Z')
const later = (s: number) => new Date(T0.getTime() + s * 1000)

async function tree(fs: MemoryFS): Promise<void> {
  await fs.mkdir('project/sub/deep', { recursive: true })
  await fs.writeText('project/top.txt', 'top')
  await fs.writeText('project/sub/mid.txt', 'mid')
  await fs.writeText('project/sub/deep/leaf.txt', 'leaf')
}

const id = async (m: Manifest) => (await m.computeC4ID()).toString()

describe('checkout and reset set each directory\'s recorded time and mode', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a checkout one second after the scan is clean and reads back at the c4m\'s ID', async () => {
    const fs = new MemoryFS()
    const store = new MemoryStore()
    await tree(fs)
    const original = await scan(fs, 'project', { store })

    vi.setSystemTime(later(1))
    await fs.mkdir('work')
    const ws = new Workspace('work', fs, store)
    await ws.checkout(original)

    const d = await ws.diffFromCurrent()
    expect(d.modified.map(x => x.path)).toEqual([])
    expect(d.added.length).toBe(0)
    expect(d.removed.length).toBe(0)
    expect(await id(await scan(fs, 'work'))).toBe(await id(original))
  })

  it('reset sets a changed directory\'s time and mode back', async () => {
    const fs = new MemoryFS()
    const store = new MemoryStore()
    await tree(fs)
    const original = await scan(fs, 'project', { store })
    await fs.mkdir('work')
    const ws = new Workspace('work', fs, store)
    await ws.checkout(original)

    // As a real filesystem does when a child is added or removed, and as a
    // user's chmod does.
    vi.setSystemTime(later(60))
    await fs.setMeta('work/sub/deep', { mtime: later(60), mode: 0o700 })
    expect((await ws.diffFromCurrent()).modified.map(x => x.path).sort()).toEqual(['sub/', 'sub/deep/'])

    await ws.reset()
    expect((await ws.diffFromCurrent()).modified.map(x => x.path)).toEqual([])
    expect(await id(await scan(fs, 'work'))).toBe(await id(original))
  })

  it('a directory\'s recorded mode is set on checkout', async () => {
    const fs = new MemoryFS()
    const store = new MemoryStore()
    await tree(fs)
    await fs.setMeta('project/sub/deep', { mode: 0o700 })
    const original = await scan(fs, 'project', { store })

    vi.setSystemTime(later(1))
    await fs.mkdir('work')
    await new Workspace('work', fs, store).checkout(original)
    expect((await fs.stat('work/sub/deep')).mode).toBe(0o700)
    expect(await id(await scan(fs, 'work'))).toBe(await id(original))
  })

  it('a null timestamp never overwrites an existing directory\'s time', async () => {
    const fs = new MemoryFS()
    const store = new MemoryStore()
    await tree(fs)
    const original = await scan(fs, 'project', { store })
    await fs.mkdir('work')
    const ws = new Workspace('work', fs, store)
    await ws.checkout(original)

    const bare = original.copy()
    bare.get('sub/deep/')!.timestamp = NULL_TIMESTAMP
    await fs.setMeta('work/sub/deep', { mtime: later(60) })
    await ws.checkout(bare)
    expect((await fs.stat('work/sub/deep')).mtime.getTime()).toBe(later(60).getTime())
  })
})
