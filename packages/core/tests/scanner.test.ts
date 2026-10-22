import { describe, it, expect } from 'vitest'
import { MemoryFS } from '../src/memory-fs.js'
import { scan } from '../src/scanner.js'
import { Manifest } from '../src/manifest.js'
import { type Entry, canonicalEntry, isDir } from '../src/entry.js'
import { identifyBytes } from '../src/id.js'

/** C4 ID of the empty string — the ID of an empty directory. */
const EMPTY_ID = 'c459dsjfscH38cYeXXYogktxf4Cd9ibshE3BHUo6a58hBXmRQdZrAkZzsWcbWtDg5oQstpDuni4Hirj75GEmTc1sFT'

/** Direct children of a directory path ('docs/'), as [path, entry]. */
function directChildren(m: Manifest, dirPath: string): Entry[] {
  const out: Entry[] = []
  const dir = m.get(dirPath)!
  for (const [path, entry] of m) {
    if (path === dirPath || !path.startsWith(dirPath)) continue
    if (entry.depth === dir.depth + 1) out.push(entry)
  }
  return out
}

/** The directory size rule: child sizes plus the bytes of their canonical lines. */
function ruleSize(children: Entry[]): number {
  const enc = new TextEncoder()
  let n = 0
  for (const c of children) n += c.size + enc.encode(canonicalEntry(c)).byteLength + 1
  return n
}

async function seed(): Promise<MemoryFS> {
  const fs = new MemoryFS()
  await fs.mkdir('root/docs', { recursive: true })
  await fs.mkdir('root/x/y/z', { recursive: true })
  await fs.mkdir('root/empty', { recursive: true })
  await fs.mkdir('root/two/a', { recursive: true })
  await fs.mkdir('root/two/b', { recursive: true })
  await fs.writeText('root/root.txt', 'hello\n')
  await fs.writeText('root/docs/a.md', 'a\n')
  await fs.writeText('root/docs/b.md', 'b\n')
  await fs.writeText('root/x/m.txt', 'm\n')
  await fs.writeText('root/x/y/z/f.txt', 'f\n')
  await fs.writeText('root/two/a/1.txt', 'aa\n')
  await fs.writeText('root/two/b/2.txt', 'bb\n')
  return fs
}

describe('scan resolves directories bottom-up', () => {
  it('every directory carries a C4 ID; none is null', async () => {
    const m = await scan(await seed(), 'root')
    const dirs = [...m.directories()]
    expect(dirs.map(([p]) => p).sort()).toEqual(
      ['docs/', 'empty/', 'two/', 'two/a/', 'two/b/', 'x/', 'x/y/', 'x/y/z/'],
    )
    for (const [, e] of dirs) {
      expect(e.c4id).not.toBeNull()
      expect(e.c4id!.isNil()).toBe(false)
    }
    // The encoded text has no null ID column anywhere.
    for (const line of m.encode().split('\n')) {
      if (line === '') continue
      expect(line.endsWith(' -')).toBe(false)
    }
  })

  it('directory ID is the ID of its direct children\'s canonical listing', async () => {
    const m = await scan(await seed(), 'root')
    for (const [path, e] of m.directories()) {
      const listing = m.filter(p => p.startsWith(path) && p !== path)
      const want = await listing.computeC4ID()
      expect(e.c4id!.toString(), path).toBe(want.toString())
    }
  })

  it('directory size is child sizes plus their canonical line bytes, with final IDs', async () => {
    const m = await scan(await seed(), 'root')
    for (const [path, e] of m.directories()) {
      expect(e.size, path).toBe(ruleSize(directChildren(m, path)))
    }
    // Concrete: docs/ holds two 2-byte files whose canonical lines are
    // 129 bytes each (mode 10, timestamp 20, size 1, name 4, ID 90, 4 spaces)
    // plus a newline — the same 264 the Go CLI reports for this tree.
    expect(m.get('docs/')!.size).toBe(2 + 2 + 130 + 130)
    // x/ depends on x/y/, which depends on x/y/z/ — resolved deepest-first.
    const z = m.get('x/y/z/')!, y = m.get('x/y/')!, x = m.get('x/')!
    expect(z.size).toBe(2 + 131) // f.txt: a 5-char name, 130-byte line
    expect(y.size).toBe(z.size + new TextEncoder().encode(canonicalEntry(z)).byteLength + 1)
    expect(x.size).toBe(ruleSize([m.get('x/m.txt')!, y]))
  })

  it('empty directory has size 0 and the ID of the empty string', async () => {
    const m = await scan(await seed(), 'root')
    const empty = m.get('empty/')!
    expect(empty.size).toBe(0)
    expect(empty.c4id!.toString()).toBe(EMPTY_ID)
    expect((await identifyBytes(new Uint8Array(0))).toString()).toBe(EMPTY_ID)
  })

  it('directory timestamp is the directory\'s own mtime, never null', async () => {
    const fs = await seed()
    const m = await scan(fs, 'root')
    for (const [path, e] of m.directories()) {
      const own = await fs.stat('root/' + path.slice(0, -1))
      expect(e.timestamp.getTime(), path).toBe(own.mtime.getTime())
      expect(e.timestamp.getTime()).not.toBe(0)
    }
  })

  it('root ID covers directory IDs and matches a re-parse of the encoded text', async () => {
    const m = await scan(await seed(), 'root')
    const id = await m.computeC4ID()
    const reparsed = await Manifest.parse(m.encode())
    expect((await reparsed.computeC4ID()).toString()).toBe(id.toString())
    // Nulling a directory ID changes the root ID: directory IDs are load-bearing.
    const copy = m.copy()
    copy.get('docs/')!.c4id = null
    expect((await copy.computeC4ID()).toString()).not.toBe(id.toString())
  })

  it('computeIds: false resolves sizes but leaves IDs null, as Go metadata mode does', async () => {
    const m = await scan(await seed(), 'root', { computeIds: false })
    for (const [, e] of m) {
      expect(e.c4id).toBeNull()
      expect(e.size).toBeGreaterThanOrEqual(0)
    }
    expect(m.get('empty/')!.size).toBe(0)
    expect(isDir(m.get('docs/')!)).toBe(true)
  })
})
