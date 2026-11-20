import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, readFile, stat, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFS } from '../src/node-fs.js'
import { plan, apply } from '../../core/src/reconcile.js'
import { MemoryStore } from '../../core/src/memory-store.js'
import { Manifest } from '../../core/src/manifest.js'
import { createEntry } from '../../core/src/entry.js'

// A file reconcile creates from a null mode is created with the process's
// default permissions: 0666 less the umask. Through 1.0.26 the null mode
// (mode 0, type '-' on this line) went to chmod as 0, leaving the file at
// 0000, unreadable, and a scan of it lost its C4 ID. The test sets the umask
// to 0027, so the default is 0640, not a constant: what is tested is the
// default. An existing file under a null mode keeps its mode.
//
// Windows has no POSIX modes (a file reads back 0666 whatever chmod was
// given), so the exact modes are checked only where modes exist; readability
// is checked everywhere.

const win = process.platform === 'win32'
let dir = ''
let saved = 0
beforeEach(() => {
  if (!win) saved = process.umask(0o027)
})
afterEach(async () => {
  if (!win) process.umask(saved)
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = ''
})

async function nullModeManifest(store: MemoryStore): Promise<Manifest> {
  const bytes = new TextEncoder().encode('null mode content\n')
  const id = await store.put(bytes)
  const t = new Date('2025-01-01T00:00:00Z')
  const built = Manifest.create()
  built.addEntry(createEntry({ mode: 0, modeType: '-', timestamp: t, size: bytes.length, name: 'nullmode.txt', c4id: id }))
  built.addEntry(createEntry({ mode: 0o600, modeType: '-', timestamp: t, size: bytes.length, name: 'known600.txt', c4id: id }))
  built.sortEntries()
  // Through the text, as a reader of a c4m file has it.
  expect(built.encode()).toContain('- 2025-01-01T00:00:00Z 18 nullmode.txt ')
  return Manifest.parse(built.encode())
}

describe('a file created from a null mode takes the default permissions', () => {
  it('0666 less the umask (0640 under 0027), and readable; a known mode still applies', async () => {
    dir = await mkdtemp(join(tmpdir(), 'c4ts-nullmode-'))
    const store = new MemoryStore()
    const m = await nullModeManifest(store)
    const out = join(dir, 'out')
    await mkdir(out)
    const fs = new NodeFS()
    const res = await apply(await plan(m, fs, out, store), fs, out, store)
    expect(res.errors).toEqual([])
    expect(await readFile(join(out, 'nullmode.txt'), 'utf8')).toBe('null mode content\n')
    if (!win) {
      expect((await stat(join(out, 'nullmode.txt'))).mode & 0o7777).toBe(0o640)
      expect((await stat(join(out, 'known600.txt'))).mode & 0o7777).toBe(0o600)
    }
  })

  it('an existing file keeps its mode under a null mode', async () => {
    dir = await mkdtemp(join(tmpdir(), 'c4ts-nullmode-'))
    const store = new MemoryStore()
    const m = await nullModeManifest(store)
    const out = join(dir, 'out')
    await mkdir(out)
    await writeFile(join(out, 'nullmode.txt'), 'different content\n')
    await chmod(join(out, 'nullmode.txt'), 0o604)
    const fs = new NodeFS()
    await apply(await plan(m, fs, out, store), fs, out, store)
    expect(await readFile(join(out, 'nullmode.txt'), 'utf8')).toBe('null mode content\n')
    if (!win) expect((await stat(join(out, 'nullmode.txt'))).mode & 0o7777).toBe(0o604)
  })
})
