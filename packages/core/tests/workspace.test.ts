import { describe, it, expect } from 'vitest'
import {
  MemoryStore,
  MemoryFS,
  Manifest,
  createEntry,
  identifyBytes,
  scan,
  verify,
  reconcilePlan,
  reconcileApply,
  Workspace,
  pool,
  ingest,
  ContentNotFoundError,
  FileNotFoundError,
  streamToBytes,
  type ScanOptions,
} from '../src/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const enc = new TextEncoder()
const dec = new TextDecoder()

async function idOf(text: string) {
  return identifyBytes(enc.encode(text))
}

/** Set up a MemoryFS with a few files and a MemoryStore with their content. */
async function makeFixture() {
  const fs = new MemoryFS()
  const store = new MemoryStore()

  await fs.mkdir('project', { recursive: true })
  await fs.mkdir('project/sub', { recursive: true })
  await fs.writeText('project/hello.txt', 'hello world')
  await fs.writeText('project/foo.txt', 'foo')
  await fs.writeText('project/sub/bar.txt', 'bar')

  const helloId = await store.put(enc.encode('hello world'))
  const fooId = await store.put(enc.encode('foo'))
  const barId = await store.put(enc.encode('bar'))

  return { fs, store, helloId, fooId, barId }
}

// ===========================================================================
// 1. MemoryStore
// ===========================================================================

describe('MemoryStore', () => {
  it('put returns a C4ID and has reports true', async () => {
    const store = new MemoryStore()
    const id = await store.put(enc.encode('hello'))
    expect(await store.has(id)).toBe(true)
  })

  it('get retrieves stored content', async () => {
    const store = new MemoryStore()
    const id = await store.put(enc.encode('test data'))
    const stream = await store.get(id)
    const bytes = await streamToBytes(stream)
    expect(dec.decode(bytes)).toBe('test data')
  })

  it('put is idempotent — same content same ID', async () => {
    const store = new MemoryStore()
    const id1 = await store.put(enc.encode('duplicate'))
    const id2 = await store.put(enc.encode('duplicate'))
    expect(id1.equals(id2)).toBe(true)
    expect(store.size).toBe(1)
  })

  it('remove deletes content', async () => {
    const store = new MemoryStore()
    const id = await store.put(enc.encode('bye'))
    expect(await store.has(id)).toBe(true)
    await store.remove(id)
    expect(await store.has(id)).toBe(false)
  })

  it('get throws ContentNotFoundError for missing ID', async () => {
    const store = new MemoryStore()
    const id = await identifyBytes(enc.encode('never stored'))
    await expect(store.get(id)).rejects.toThrow(ContentNotFoundError)
  })

  it('has returns false for missing ID', async () => {
    const store = new MemoryStore()
    const id = await identifyBytes(enc.encode('absent'))
    expect(await store.has(id)).toBe(false)
  })

  it('size and totalBytes track content', async () => {
    const store = new MemoryStore()
    expect(store.size).toBe(0)
    expect(store.totalBytes).toBe(0)
    await store.put(enc.encode('abc'))
    expect(store.size).toBe(1)
    expect(store.totalBytes).toBe(3)
  })

  it('clear removes all content', async () => {
    const store = new MemoryStore()
    await store.put(enc.encode('a'))
    await store.put(enc.encode('b'))
    expect(store.size).toBe(2)
    store.clear()
    expect(store.size).toBe(0)
  })
})

// ===========================================================================
// 2. MemoryFS
// ===========================================================================

describe('MemoryFS', () => {
  it('writeFile and readFile round-trip', async () => {
    const fs = new MemoryFS()
    await fs.writeFile('test.txt', enc.encode('content'))
    const stream = await fs.readFile('test.txt')
    const bytes = await streamToBytes(stream)
    expect(dec.decode(bytes)).toBe('content')
  })

  it('writeText and readText convenience helpers', async () => {
    const fs = new MemoryFS()
    await fs.writeText('note.txt', 'hello')
    expect(await fs.readText('note.txt')).toBe('hello')
  })

  it('mkdir creates nested directories with recursive', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('a/b/c', { recursive: true })
    const stat = await fs.stat('a/b/c')
    expect(stat.isDirectory).toBe(true)
  })

  it('readDir lists sorted children', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('dir')
    await fs.writeText('dir/b.txt', 'b')
    await fs.writeText('dir/a.txt', 'a')
    const entries: string[] = []
    for await (const e of fs.readDir('dir')) {
      entries.push(e.name)
    }
    expect(entries).toEqual(['a.txt', 'b.txt'])
  })

  it('stat returns correct size for files', async () => {
    const fs = new MemoryFS()
    await fs.writeText('f.txt', 'abc')
    const stat = await fs.stat('f.txt')
    expect(stat.size).toBe(3)
    expect(stat.isDirectory).toBe(false)
  })

  it('remove deletes a file', async () => {
    const fs = new MemoryFS()
    await fs.writeText('gone.txt', 'bye')
    await fs.remove('gone.txt')
    await expect(fs.stat('gone.txt')).rejects.toThrow(FileNotFoundError)
  })

  it('remove with recursive deletes non-empty directory', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('dir')
    await fs.writeText('dir/file.txt', 'hi')
    await fs.remove('dir', { recursive: true })
    await expect(fs.stat('dir')).rejects.toThrow(FileNotFoundError)
  })

  it('rename moves a file', async () => {
    const fs = new MemoryFS()
    await fs.writeText('old.txt', 'data')
    await fs.rename('old.txt', 'new.txt')
    expect(await fs.readText('new.txt')).toBe('data')
    await expect(fs.stat('old.txt')).rejects.toThrow(FileNotFoundError)
  })

  it('readFile throws FileNotFoundError for missing file', async () => {
    const fs = new MemoryFS()
    await expect(fs.readFile('nope.txt')).rejects.toThrow(FileNotFoundError)
  })

  it('readDir throws for non-existent directory', async () => {
    const fs = new MemoryFS()
    const collect = async () => {
      for await (const _ of fs.readDir('missing')) { /* drain */ }
    }
    await expect(collect()).rejects.toThrow()
  })

  it('setMeta updates mode and mtime', async () => {
    const fs = new MemoryFS()
    await fs.writeText('f.txt', 'x')
    const ts = new Date('2025-01-01T00:00:00Z')
    await fs.setMeta!('f.txt', { mode: 0o755, mtime: ts })
    const stat = await fs.stat('f.txt')
    expect(stat.mode).toBe(0o755)
    expect(stat.mtime.getTime()).toBe(ts.getTime())
  })
})

// ===========================================================================
// 3. Scanner
// ===========================================================================

describe('Scanner', () => {
  it('scans files and produces manifest entries with C4 IDs', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('root')
    await fs.writeText('root/a.txt', 'aaa')
    await fs.writeText('root/b.txt', 'bbb')

    const manifest = await scan(fs, 'root')
    const files = [...manifest.files()]
    expect(files.length).toBe(2)

    // Entries have C4 IDs
    for (const [, entry] of files) {
      expect(entry.c4id).not.toBeNull()
      expect(entry.c4id!.isNil()).toBe(false)
    }
  })

  it('scans nested directories', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('root/sub', { recursive: true })
    await fs.writeText('root/top.txt', 'top')
    await fs.writeText('root/sub/deep.txt', 'deep')

    const manifest = await scan(fs, 'root')
    const dirs = [...manifest.directories()]
    expect(dirs.length).toBe(1)
    expect(dirs[0][0]).toBe('sub/')

    const files = [...manifest.files()]
    expect(files.length).toBe(2)
  })

  it('skipHidden skips dotfiles', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('root')
    await fs.writeText('root/visible.txt', 'ok')
    await fs.writeText('root/.hidden', 'secret')

    const manifest = await scan(fs, 'root', { skipHidden: true })
    const files = [...manifest.files()]
    expect(files.length).toBe(1)
    expect(files[0][1].name).toBe('visible.txt')
  })

  it('includes hidden files when skipHidden is false', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('root')
    await fs.writeText('root/visible.txt', 'ok')
    await fs.writeText('root/.hidden', 'secret')

    const manifest = await scan(fs, 'root', { skipHidden: false })
    const files = [...manifest.files()]
    expect(files.length).toBe(2)
  })

  it('invokes progress callback', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('root')
    await fs.writeText('root/a.txt', 'a')
    await fs.writeText('root/b.txt', 'b')

    const calls: Array<[string, number]> = []
    await scan(fs, 'root', {
      progress: (path, n) => calls.push([path, n]),
    })
    expect(calls.length).toBe(2)
    expect(calls[0][1]).toBe(1)
    expect(calls[1][1]).toBe(2)
  })

  it('stores content when store option is provided', async () => {
    const fs = new MemoryFS()
    const store = new MemoryStore()
    await fs.mkdir('root')
    await fs.writeText('root/data.txt', 'stored content')

    const manifest = await scan(fs, 'root', { store })
    const files = [...manifest.files()]
    const id = files[0][1].c4id!
    expect(await store.has(id)).toBe(true)
  })
})

// ===========================================================================
// 4. Verify
// ===========================================================================

describe('Verify', () => {
  it('reports ok for matching files', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('root')
    await fs.writeText('root/a.txt', 'aaa')

    const manifest = await scan(fs, 'root')
    const report = await verify(manifest, fs, 'root')

    expect(report.ok.length).toBe(1)
    expect(report.missing.length).toBe(0)
    expect(report.corrupt.length).toBe(0)
    expect(report.isOk).toBe(true)
  })

  it('detects missing files', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('root')
    await fs.writeText('root/a.txt', 'aaa')

    const manifest = await scan(fs, 'root')

    // Remove the file
    await fs.remove('root/a.txt')

    const report = await verify(manifest, fs, 'root')
    expect(report.missing).toContain('a.txt')
    expect(report.isOk).toBe(false)
  })

  it('detects corrupt files', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('root')
    await fs.writeText('root/a.txt', 'original')

    const manifest = await scan(fs, 'root')

    // Overwrite with different content
    await fs.writeText('root/a.txt', 'tampered')

    const report = await verify(manifest, fs, 'root')
    expect(report.corrupt.length).toBe(1)
    expect(report.corrupt[0].path).toBe('a.txt')
    expect(report.isOk).toBe(false)
  })

  it('detects extra files', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('root')
    await fs.writeText('root/a.txt', 'aaa')

    const manifest = await scan(fs, 'root')

    // Add an extra file
    await fs.writeText('root/extra.txt', 'surprise')

    const report = await verify(manifest, fs, 'root')
    expect(report.extra).toContain('extra.txt')
    expect(report.isOk).toBe(false)
  })

  it('handles combined missing, corrupt, and extra', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('root')
    await fs.writeText('root/ok.txt', 'fine')
    await fs.writeText('root/gone.txt', 'will vanish')
    await fs.writeText('root/bad.txt', 'will change')

    const manifest = await scan(fs, 'root')

    await fs.remove('root/gone.txt')
    await fs.writeText('root/bad.txt', 'changed!')
    await fs.writeText('root/bonus.txt', 'new')

    const report = await verify(manifest, fs, 'root')
    expect(report.ok).toContain('ok.txt')
    expect(report.missing).toContain('gone.txt')
    expect(report.corrupt.length).toBe(1)
    expect(report.extra).toContain('bonus.txt')
  })
})

// ===========================================================================
// 5. Reconciler
// ===========================================================================

describe('Reconciler', () => {
  it('plans creation of missing files', async () => {
    const fs = new MemoryFS()
    const store = new MemoryStore()
    await fs.mkdir('root')

    const id = await store.put(enc.encode('new content'))
    const manifest = Manifest.create()
    manifest.addEntry(createEntry({
      name: 'file.txt',
      modeType: '-',
      mode: 0o644,
      size: 11,
      c4id: id,
      depth: 0,
    }))

    const p = await reconcilePlan(manifest, fs, 'root', store)
    const createOps = p.operations.filter(o => o.type === 'create')
    expect(createOps.length).toBe(1)
    expect(createOps[0].path).toBe('file.txt')
  })

  it('skips files that already match', async () => {
    const fs = new MemoryFS()
    const store = new MemoryStore()
    await fs.mkdir('root')
    await fs.writeText('root/same.txt', 'unchanged')

    const id = await store.put(enc.encode('unchanged'))

    const manifest = Manifest.create()
    manifest.addEntry(createEntry({
      name: 'same.txt',
      modeType: '-',
      mode: 0o644,
      size: 9,
      c4id: id,
      depth: 0,
    }))

    const p = await reconcilePlan(manifest, fs, 'root', store)
    expect(p.skipped).toContain('same.txt')
    expect(p.operations.filter(o => o.path === 'same.txt').length).toBe(0)
  })

  it('plans update for changed files', async () => {
    const fs = new MemoryFS()
    const store = new MemoryStore()
    await fs.mkdir('root')
    await fs.writeText('root/changed.txt', 'old version')

    const newId = await store.put(enc.encode('new version'))

    const manifest = Manifest.create()
    manifest.addEntry(createEntry({
      name: 'changed.txt',
      modeType: '-',
      mode: 0o644,
      size: 11,
      c4id: newId,
      depth: 0,
    }))

    const p = await reconcilePlan(manifest, fs, 'root', store)
    const updateOps = p.operations.filter(o => o.type === 'update')
    expect(updateOps.length).toBe(1)
  })

  it('plans removal of extra files', async () => {
    const fs = new MemoryFS()
    const store = new MemoryStore()
    await fs.mkdir('root')
    await fs.writeText('root/extra.txt', 'should be removed')

    // Empty manifest — everything on disk is extra
    const manifest = Manifest.create()

    const p = await reconcilePlan(manifest, fs, 'root', store)
    const removeOps = p.operations.filter(o => o.type === 'remove')
    expect(removeOps.some(o => o.path === 'extra.txt')).toBe(true)
  })

  it('plans mkdir for missing directories', async () => {
    const fs = new MemoryFS()
    const store = new MemoryStore()
    await fs.mkdir('root')

    const manifest = Manifest.create()
    manifest.addEntry(createEntry({
      name: 'subdir/',
      modeType: 'd',
      mode: 0o755,
      size: 0,
      depth: 0,
    }))

    const p = await reconcilePlan(manifest, fs, 'root', store)
    const mkdirOps = p.operations.filter(o => o.type === 'mkdir')
    expect(mkdirOps.length).toBe(1)
    expect(mkdirOps[0].path).toBe('subdir/')
  })

  it('apply executes create and update operations', async () => {
    const fs = new MemoryFS()
    const store = new MemoryStore()
    await fs.mkdir('root')
    await fs.writeText('root/old.txt', 'will change')

    const newId = await store.put(enc.encode('updated'))
    const freshId = await store.put(enc.encode('brand new'))

    const manifest = Manifest.create()
    manifest.addEntry(createEntry({
      name: 'old.txt',
      modeType: '-',
      mode: 0o644,
      size: 7,
      c4id: newId,
      depth: 0,
    }))
    manifest.addEntry(createEntry({
      name: 'fresh.txt',
      modeType: '-',
      mode: 0o644,
      size: 9,
      c4id: freshId,
      depth: 0,
    }))

    const p = await reconcilePlan(manifest, fs, 'root', store)
    const result = await reconcileApply(p, fs, 'root', store)

    expect(result.created).toBeGreaterThanOrEqual(1)
    expect(await fs.readText('root/fresh.txt')).toBe('brand new')
    expect(await fs.readText('root/old.txt')).toBe('updated')
  })

  it('apply reports progress', async () => {
    const fs = new MemoryFS()
    const store = new MemoryStore()
    await fs.mkdir('root')

    const id = await store.put(enc.encode('data'))
    const manifest = Manifest.create()
    manifest.addEntry(createEntry({
      name: 'f.txt',
      modeType: '-',
      mode: 0o644,
      size: 4,
      c4id: id,
      depth: 0,
    }))

    const p = await reconcilePlan(manifest, fs, 'root', store)
    const progressCalls: string[] = []
    await reconcileApply(p, fs, 'root', store, {
      progress: (op, path) => progressCalls.push(`${op}:${path}`),
    })
    expect(progressCalls.length).toBeGreaterThan(0)
  })
})

// ===========================================================================
// 6. Workspace
// ===========================================================================

describe('Workspace', () => {
  it('status reports no manifest before checkout', () => {
    const fs = new MemoryFS()
    const store = new MemoryStore()
    const ws = new Workspace('work', fs, store)
    const s = ws.status()
    expect(s.exists).toBe(false)
    expect(s.hasManifest).toBe(false)
    expect(s.manifestC4ID).toBeNull()
  })

  it('checkout materializes files from a manifest', async () => {
    const fs = new MemoryFS()
    const store = new MemoryStore()
    await fs.mkdir('work')

    const id = await store.put(enc.encode('ws content'))

    const manifest = Manifest.create()
    manifest.addEntry(createEntry({
      name: 'doc.txt',
      modeType: '-',
      mode: 0o644,
      size: 10,
      c4id: id,
      depth: 0,
    }))

    const ws = new Workspace('work', fs, store)
    await ws.checkout(manifest)

    expect(await fs.readText('work/doc.txt')).toBe('ws content')
    expect(ws.status().hasManifest).toBe(true)
  })

  it('checkout dry-run returns plan without writing', async () => {
    const fs = new MemoryFS()
    const store = new MemoryStore()
    await fs.mkdir('work')

    const id = await store.put(enc.encode('dry'))

    const manifest = Manifest.create()
    manifest.addEntry(createEntry({
      name: 'dry.txt',
      modeType: '-',
      mode: 0o644,
      size: 3,
      c4id: id,
      depth: 0,
    }))

    const ws = new Workspace('work', fs, store)
    const result = await ws.checkout(manifest, { dryRun: true })

    // Dry run returns a plan, not a result
    expect('operations' in result).toBe(true)
    // File should NOT exist
    await expect(fs.stat('work/dry.txt')).rejects.toThrow()
  })

  it('snapshot captures current directory state', async () => {
    const fs = new MemoryFS()
    const store = new MemoryStore()
    await fs.mkdir('work')
    await fs.writeText('work/snap.txt', 'snapshot me')

    const ws = new Workspace('work', fs, store)
    const manifest = await ws.snapshot()

    const files = [...manifest.files()]
    expect(files.length).toBe(1)
    expect(files[0][1].name).toBe('snap.txt')
    expect(files[0][1].c4id).not.toBeNull()
  })

  it('reset reverts to last checkout state', async () => {
    const fs = new MemoryFS()
    const store = new MemoryStore()
    await fs.mkdir('work')

    const id = await store.put(enc.encode('original'))

    const manifest = Manifest.create()
    manifest.addEntry(createEntry({
      name: 'file.txt',
      modeType: '-',
      mode: 0o644,
      size: 8,
      c4id: id,
      depth: 0,
    }))

    const ws = new Workspace('work', fs, store)
    await ws.checkout(manifest)

    // Modify the file
    await fs.writeText('work/file.txt', 'tampered')
    expect(await fs.readText('work/file.txt')).toBe('tampered')

    // Reset
    await ws.reset()
    expect(await fs.readText('work/file.txt')).toBe('original')
  })

  it('reset throws when no manifest is checked out', async () => {
    const fs = new MemoryFS()
    const store = new MemoryStore()
    const ws = new Workspace('work', fs, store)
    await expect(ws.reset()).rejects.toThrow('no manifest checked out')
  })

  it('diffFromCurrent detects modifications', async () => {
    const fs = new MemoryFS()
    const store = new MemoryStore()
    await fs.mkdir('work')

    const id = await store.put(enc.encode('before'))

    const manifest = Manifest.create()
    manifest.addEntry(createEntry({
      name: 'file.txt',
      modeType: '-',
      mode: 0o644,
      size: 6,
      c4id: id,
      depth: 0,
    }))

    const ws = new Workspace('work', fs, store)
    await ws.checkout(manifest)

    // Modify
    await fs.writeText('work/file.txt', 'after')

    const d = await ws.diffFromCurrent()
    expect(d.modified.length).toBe(1)
    expect(d.modified[0].path).toBe('file.txt')
  })

  it('diffFromCurrent throws when no manifest checked out', async () => {
    const fs = new MemoryFS()
    const store = new MemoryStore()
    const ws = new Workspace('work', fs, store)
    await expect(ws.diffFromCurrent()).rejects.toThrow('no manifest checked out')
  })

  it('load restores persisted state from a previous checkout', async () => {
    const fs = new MemoryFS()
    const store = new MemoryStore()
    await fs.mkdir('work')

    const id = await store.put(enc.encode('persisted'))

    const manifest = Manifest.create()
    manifest.addEntry(createEntry({
      name: 'p.txt',
      modeType: '-',
      mode: 0o644,
      size: 9,
      c4id: id,
      depth: 0,
    }))

    // First workspace — checkout
    const ws1 = new Workspace('work', fs, store)
    await ws1.checkout(manifest)
    const c4id1 = ws1.status().manifestC4ID

    // Second workspace — load from persisted state
    const ws2 = new Workspace('work', fs, store)
    await ws2.load()
    expect(ws2.status().hasManifest).toBe(true)
    expect(ws2.status().manifestC4ID).toBe(c4id1)
  })
})

// ===========================================================================
// 7. Pool / Ingest
// ===========================================================================

describe('Pool and Ingest', () => {
  it('pool bundles manifest and objects to a directory', async () => {
    const fs = new MemoryFS()
    const store = new MemoryStore()

    const id = await store.put(enc.encode('pooled'))

    const manifest = Manifest.create()
    manifest.addEntry(createEntry({
      name: 'data.txt',
      modeType: '-',
      mode: 0o644,
      size: 6,
      c4id: id,
      depth: 0,
    }))

    await fs.mkdir('bundle')
    const result = await pool(manifest, 'bundle', fs, store)

    expect(result.copied).toBe(1)
    expect(result.missing).toBe(0)
    expect(result.manifestPath).toBe('bundle/manifest.c4m')

    // Manifest file exists
    const c4mText = await fs.readText('bundle/manifest.c4m')
    expect(c4mText.length).toBeGreaterThan(0)

    // Object file exists
    const objectPath = `bundle/objects/${id.toString()}`
    const stat = await fs.stat(objectPath)
    expect(stat.isDirectory).toBe(false)
  })

  it('ingest absorbs a pool bundle into a store', async () => {
    const sourceFs = new MemoryFS()
    const sourceStore = new MemoryStore()
    const destStore = new MemoryStore()

    const id = await sourceStore.put(enc.encode('transfer me'))

    const manifest = Manifest.create()
    manifest.addEntry(createEntry({
      name: 'payload.txt',
      modeType: '-',
      mode: 0o644,
      size: 11,
      c4id: id,
      depth: 0,
    }))

    await sourceFs.mkdir('bundle')
    await pool(manifest, 'bundle', sourceFs, sourceStore)

    // Now ingest into destStore
    const result = await ingest('bundle', sourceFs, destStore)

    expect(result.copied).toBe(1)
    expect(result.manifests).toContain('manifest.c4m')

    // Verify the content arrived
    expect(await destStore.has(id)).toBe(true)
    const stream = await destStore.get(id)
    const bytes = await streamToBytes(stream)
    expect(dec.decode(bytes)).toBe('transfer me')
  })

  it('pool reports missing when store lacks content', async () => {
    const fs = new MemoryFS()
    const store = new MemoryStore()

    // Create an ID for content NOT in the store
    const id = await identifyBytes(enc.encode('ghost'))

    const manifest = Manifest.create()
    manifest.addEntry(createEntry({
      name: 'ghost.txt',
      modeType: '-',
      mode: 0o644,
      size: 5,
      c4id: id,
      depth: 0,
    }))

    await fs.mkdir('bundle')
    const result = await pool(manifest, 'bundle', fs, store)

    expect(result.missing).toBe(1)
    expect(result.copied).toBe(0)
  })

  it('pool skips objects already in the bundle', async () => {
    const fs = new MemoryFS()
    const store = new MemoryStore()

    const id = await store.put(enc.encode('once'))

    const manifest = Manifest.create()
    manifest.addEntry(createEntry({
      name: 'f.txt',
      modeType: '-',
      mode: 0o644,
      size: 4,
      c4id: id,
      depth: 0,
    }))

    await fs.mkdir('bundle')
    // Pool twice to the same directory
    await pool(manifest, 'bundle', fs, store)
    const result2 = await pool(manifest, 'bundle', fs, store)

    expect(result2.skipped).toBe(1)
    expect(result2.copied).toBe(0)
  })

  it('ingest skips objects already in the destination store', async () => {
    const fs = new MemoryFS()
    const sourceStore = new MemoryStore()
    const destStore = new MemoryStore()

    const id = await sourceStore.put(enc.encode('already there'))
    // Pre-populate destination
    await destStore.put(enc.encode('already there'))

    const manifest = Manifest.create()
    manifest.addEntry(createEntry({
      name: 'dup.txt',
      modeType: '-',
      mode: 0o644,
      size: 13,
      c4id: id,
      depth: 0,
    }))

    await fs.mkdir('bundle')
    await pool(manifest, 'bundle', fs, sourceStore)

    const result = await ingest('bundle', fs, destStore)
    expect(result.skipped).toBe(1)
    expect(result.copied).toBe(0)
  })

  it('round-trips: pool then ingest into fresh store, verify content', async () => {
    const fs = new MemoryFS()
    const srcStore = new MemoryStore()
    const dstStore = new MemoryStore()

    const files = [
      { name: 'alpha.txt', content: 'alpha content' },
      { name: 'beta.txt', content: 'beta content' },
      { name: 'gamma.txt', content: 'gamma content' },
    ]

    const manifest = Manifest.create()
    for (const f of files) {
      const id = await srcStore.put(enc.encode(f.content))
      manifest.addEntry(createEntry({
        name: f.name,
        modeType: '-',
        mode: 0o644,
        size: f.content.length,
        c4id: id,
        depth: 0,
      }))
    }

    await fs.mkdir('pool-dir')
    await pool(manifest, 'pool-dir', fs, srcStore)
    await ingest('pool-dir', fs, dstStore)

    // All content should now be in dstStore
    for (const f of files) {
      const id = await identifyBytes(enc.encode(f.content))
      expect(await dstStore.has(id)).toBe(true)
    }
    expect(dstStore.size).toBe(3)
  })
})

// ===========================================================================
// Integration: scan -> checkout -> modify -> diff -> reset
// ===========================================================================

describe('Full workflow integration', () => {
  it('scan, checkout, modify, diff, reset', async () => {
    const fs = new MemoryFS()
    const store = new MemoryStore()

    // Seed the filesystem
    await fs.mkdir('project')
    await fs.writeText('project/readme.txt', 'read me')
    await fs.writeText('project/code.txt', 'function main() {}')

    // Scan to get manifest and store content
    const original = await scan(fs, 'project', { store })

    // Start a workspace in a different dir
    await fs.mkdir('workdir')
    const ws = new Workspace('workdir', fs, store)
    await ws.checkout(original)

    // Verify files materialized
    expect(await fs.readText('workdir/readme.txt')).toBe('read me')
    expect(await fs.readText('workdir/code.txt')).toBe('function main() {}')

    // Modify a file
    await fs.writeText('workdir/code.txt', 'function main() { return 42 }')

    // Diff should show one modification
    const d = await ws.diffFromCurrent()
    expect(d.modified.length).toBe(1)
    expect(d.modified[0].path).toBe('code.txt')
    expect(d.added.length).toBe(0)
    expect(d.removed.length).toBe(0)

    // Reset to original
    await ws.reset()
    expect(await fs.readText('workdir/code.txt')).toBe('function main() {}')

    // After reset, diff should be empty
    const d2 = await ws.diffFromCurrent()
    expect(d2.modified.length).toBe(0)
    expect(d2.added.length).toBe(0)
    expect(d2.removed.length).toBe(0)
  })
})
