import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Manifest } from '../src/manifest.js'
import { MemoryFS } from '../src/memory-fs.js'
import { MemoryStore } from '../src/memory-store.js'
import { scan } from '../src/scanner.js'
import { plan, apply } from '../src/reconcile.js'
import {
  type Entry,
  createEntry,
  ZERO_MODE,
  isNullMode,
  knownMode,
  permBits,
  parseMode,
  formatMode,
  canonicalEntry,
} from '../src/entry.js'

// Cross-implementation vector: known zero against null (2026-11-09).
// The shared conformance contract lives in the Go reference repo at
// c4m/testdata/zero-null-vector (see its README.md); the files under
// fixtures/zero-null-vector/ here are byte-identical copies, and
// fixtures/legacy/ten-dash-null-1.0.21.c4m is a real file written by c4
// 1.0.21, whose pretty encoder wrote every null mode as ten dashes.
//
// The rule (SPECIFICATION.md "Mode" and "Null and Zero Values";
// C4M-STANDARD §4.1): a null mode is a single `-`; ten dashes is the KNOWN
// zero, a regular file with zero permissions; `d---------` is a directory
// at 0000, known, not null. Null decodes and encodes as `-` in every form,
// pretty included. The one legacy exception: ten dashes on a directory
// line can only be an old encoder's null, so it decodes as null.

const fixture = (rel: string): string =>
  fileURLToPath(new URL(`./fixtures/${rel}`, import.meta.url))

const load = (rel: string): Promise<string> => readFile(fixture(rel), 'utf8')

/** C4 ID of empty content — the ID of an empty file and of an empty directory. */
const EMPTY_ID = 'c459dsjfscH38cYeXXYogktxf4Cd9ibshE3BHUo6a58hBXmRQdZrAkZzsWcbWtDg5oQstpDuni4Hirj75GEmTc1sFT'

/** Expected per-entry results, shared by both forms of the vector. */
function checkVector(m: Manifest, label: string): void {
  const get = (path: string): Entry => {
    const e = m.get(path)
    expect(e, `${label}: ${path} present`).toBeDefined()
    return e!
  }

  const zero = get('zero.txt')
  expect(isNullMode(zero.mode), `${label}: zero.txt is not null`).toBe(false)
  expect(zero.mode, `${label}: zero.txt is the known zero`).toBe(ZERO_MODE)
  expect(permBits(zero.mode)).toBe(0)
  expect(zero.size).toBe(4)
  expect(zero.c4id).not.toBeNull()

  const nullmode = get('nullmode.txt')
  expect(isNullMode(nullmode.mode), `${label}: nullmode.txt is null`).toBe(true)
  expect(nullmode.size).toBe(4)
  expect(nullmode.c4id).not.toBeNull()

  const empty = get('empty.txt')
  expect(empty.mode).toBe(0o644)
  expect(empty.modeType).toBe('-')
  expect(empty.size).toBe(0)
  expect(empty.c4id?.toString()).toBe(EMPTY_ID)

  const emptydir = get('emptydir/')
  expect(emptydir.mode).toBe(0o755)
  expect(emptydir.modeType).toBe('d')
  expect(emptydir.size).toBe(0)
  expect(emptydir.c4id?.toString()).toBe(EMPTY_ID)

  const locked = get('locked/')
  expect(isNullMode(locked.mode), `${label}: locked/ is known`).toBe(false)
  expect(locked.mode).toBe(ZERO_MODE)
  expect(locked.modeType).toBe('d')
  expect(formatMode(locked.modeType, locked.mode)).toBe('d---------')
  expect(locked.size).toBe(142)
  expect(locked.c4id).not.toBeNull()
  const lockedChildren = m.children(locked)
  expect(lockedChildren.map(e => e.name)).toEqual(['inside.txt'])
  const inside = get('locked/inside.txt')
  expect(inside.mode).toBe(0o644)
  expect(inside.size).toBe(6)
  expect(inside.c4id).not.toBeNull()

  const unread = get('unread/')
  expect(isNullMode(unread.mode), `${label}: unread/ is known`).toBe(false)
  expect(unread.mode).toBe(ZERO_MODE)
  expect(unread.modeType).toBe('d')
  expect(unread.size, `${label}: unread/ keeps a null size`).toBe(-1)
  expect(unread.c4id).toBeNull()
  expect(m.children(unread)).toEqual([])

  expect(m.entries.length).toBe(7)
}

/** The mode column of each non-blank line. */
const modeColumn = (text: string): string[] =>
  text.split('\n').filter(l => l.length > 0).map(l => l.trimStart().split(' ')[0])

describe('zero-null-vector conformance (2026-11-09)', () => {
  it('decodes the canonical form to the pinned manifest and root ID', async () => {
    const m = await Manifest.parse(await load('zero-null-vector/canonical.c4m'))
    checkVector(m, 'canonical')
    const rootID = (await load('zero-null-vector/root-id.txt')).trim()
    expect((await m.computeC4ID()).toString()).toBe(rootID)
  })

  it('decodes the pretty form to the same manifest and root ID', async () => {
    const m = await Manifest.parse(await load('zero-null-vector/pretty.c4m'))
    checkVector(m, 'pretty')
    const rootID = (await load('zero-null-vector/root-id.txt')).trim()
    expect((await m.computeC4ID()).toString()).toBe(rootID)
  })

  it('re-encodes the canonical form byte for byte', async () => {
    const text = await load('zero-null-vector/canonical.c4m')
    const m = await Manifest.parse(text)
    expect(m.encode()).toBe(text)
  })

  it('writes the same mode spellings in pretty form as the Go encoder', async () => {
    // Column layout and timestamp rendering may differ by implementation
    // (c4ts writes local time with a numeric offset; Go wrote UTC); the mode
    // column and the decoded manifest must not.
    const goPretty = await load('zero-null-vector/pretty.c4m')
    const m = await Manifest.parse(goPretty)
    const ours = m.encode({ pretty: true })
    expect(modeColumn(ours)).toEqual(modeColumn(goPretty))
    expect(modeColumn(ours)).toEqual([
      '-rw-r--r--', '-', '----------', 'drwxr-xr-x', 'd---------', '-rw-r--r--', 'd---------',
    ])

    // Our pretty form round-trips to the same manifest and root ID.
    const back = await Manifest.parse(ours)
    checkVector(back, 'pretty round-trip')
    const rootID = (await load('zero-null-vector/root-id.txt')).trim()
    expect((await back.computeC4ID()).toString()).toBe(rootID)
  })

  it('canonical and pretty forms decode to one manifest', async () => {
    const a = await Manifest.parse(await load('zero-null-vector/canonical.c4m'))
    const b = await Manifest.parse(await load('zero-null-vector/pretty.c4m'))
    expect(b.canonical()).toBe(a.canonical())
    for (const [path, ea] of a) {
      const eb = b.get(path)!
      expect(eb.mode, path).toBe(ea.mode)
      expect(eb.modeType, path).toBe(ea.modeType)
      expect(canonicalEntry(eb), path).toBe(canonicalEntry(ea))
    }
  })
})

describe('legacy ten-dash null (c4 1.0.21 pretty form)', () => {
  it('reads ten dashes on a directory line as null and on a file line as the known zero', async () => {
    const m = await Manifest.parse(await load('legacy/ten-dash-null-1.0.21.c4m'))
    expect(m.entries.map(e => e.name)).toEqual(['a.txt', 'd/', 'b.txt'])

    const dirs = m.entries.filter(e => e.name.endsWith('/'))
    expect(dirs.length).toBe(1)
    for (const d of dirs) {
      expect(isNullMode(d.mode), `${d.name} decodes with a null mode`).toBe(true)
    }

    for (const f of m.entries.filter(e => !e.name.endsWith('/'))) {
      expect(f.mode, `${f.name} is the known zero`).toBe(ZERO_MODE)
    }
  })

  it('re-encodes every null as "-" in canonical and pretty form alike', async () => {
    const m = await Manifest.parse(await load('legacy/ten-dash-null-1.0.21.c4m'))
    for (const pretty of [false, true]) {
      const out = m.encode({ pretty })
      const lines = out.split('\n').filter(l => l.length > 0)
      const dirLine = lines.find(l => l.includes(' d/ '))!
      expect(dirLine.trimStart().startsWith('- '), `pretty=${pretty}: d/ is "-"`).toBe(true)
      expect(dirLine.includes('----------'), `pretty=${pretty}: no ten dashes beside d/`).toBe(false)
      // The file lines are the known zero and keep their ten dashes.
      for (const name of ['a.txt', 'b.txt']) {
        const line = lines.find(l => l.includes(` ${name} `))!
        expect(line.trimStart().startsWith('---------- '), `pretty=${pretty}: ${name}`).toBe(true)
      }
    }
  })
})

describe('known zero against null in the API', () => {
  it('parseMode never returns null; ten dashes is ZERO_MODE', () => {
    expect(parseMode('----------')).toEqual(['-', ZERO_MODE])
    expect(parseMode('d---------')).toEqual(['d', ZERO_MODE])
    expect(parseMode('-rw-r--r--')).toEqual(['-', 0o644])
    expect(formatMode('-', ZERO_MODE)).toBe('----------')
    expect(formatMode('d', ZERO_MODE)).toBe('d---------')
    expect(formatMode('-', 0o644)).toBe('-rw-r--r--')
  })

  it('knownMode and permBits bracket the sentinel', () => {
    expect(knownMode(0)).toBe(ZERO_MODE)
    expect(knownMode(0o644)).toBe(0o644)
    expect(permBits(ZERO_MODE)).toBe(0)
    expect(permBits(0o4755)).toBe(0o4755)
    expect(isNullMode(0)).toBe(true)
    expect(isNullMode(ZERO_MODE)).toBe(false)
  })

  it('a null and a known-zero entry are distinct and both canonical forms round-trip', async () => {
    const ts = new Date('2026-01-02T03:04:05Z')
    const m = Manifest.create()
    m.addEntry(createEntry({ name: 'n.txt', mode: 0, modeType: '-', size: 1, timestamp: ts }))
    m.addEntry(createEntry({ name: 'z.txt', mode: ZERO_MODE, modeType: '-', size: 1, timestamp: ts }))
    expect(m.hasNullValues()).toBe(true)
    const canon = m.encode()
    expect(canon).toBe(
      '- 2026-01-02T03:04:05Z 1 n.txt -\n' +
      '---------- 2026-01-02T03:04:05Z 1 z.txt -\n',
    )
    const back = await Manifest.parse(canon)
    expect(isNullMode(back.get('n.txt')!.mode)).toBe(true)
    expect(back.get('z.txt')!.mode).toBe(ZERO_MODE)
    expect(back.encode()).toBe(canon)

    // Pretty form keeps the distinction too.
    const pretty = m.encode({ pretty: true })
    expect(modeColumn(pretty)).toEqual(['-', '----------'])
    const backPretty = await Manifest.parse(pretty)
    expect(backPretty.canonical()).toBe(m.canonical())
  })
})

describe('scan and reconcile honour the known zero', () => {
  it('a chmod-000 file scans as the known zero, never null', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('root/locked', { recursive: true })
    await fs.writeText('root/zero.txt', 'zero')
    await fs.writeText('root/locked/inside.txt', 'inside')
    await fs.setMeta('root/zero.txt', { mode: 0 })
    await fs.setMeta('root/locked', { mode: 0 })

    const m = await scan(fs, 'root')
    const zero = m.get('zero.txt')!
    expect(zero.mode).toBe(ZERO_MODE)
    expect(isNullMode(zero.mode)).toBe(false)
    const locked = m.get('locked/')!
    expect(locked.mode).toBe(ZERO_MODE)
    expect(locked.modeType).toBe('d')
    expect(m.hasNullValues()).toBe(false)

    const text = m.encode()
    expect(modeColumn(text)).toEqual(['----------', 'd---------', '-rw-r--r--'])
    expect(text).not.toMatch(/^- /m)
  })

  it('applies the known zero as 0000 and leaves a null mode to the platform default', async () => {
    const store = new MemoryStore()
    const enc = new TextEncoder()
    const zeroID = await store.put(enc.encode('zero'))
    const nullID = await store.put(enc.encode('null'))
    const ts = new Date('2026-01-02T03:04:05Z')

    const m = Manifest.create()
    m.addEntry(createEntry({ name: 'zero.txt', mode: ZERO_MODE, modeType: '-', size: 4, timestamp: ts, c4id: zeroID }))
    m.addEntry(createEntry({ name: 'nullmode.txt', mode: 0, modeType: '-', size: 4, timestamp: ts, c4id: nullID }))

    // Creating: the known zero sets 0000; null takes the platform default
    // (MemoryFS creates files at 0644), never 0.
    const fs = new MemoryFS()
    await fs.mkdir('out')
    const p = await plan(m, fs, 'out', store)
    const r = await apply(p, fs, 'out', store)
    expect(r.errors).toEqual([])
    expect(r.created).toBe(2)
    expect((await fs.stat('out/zero.txt')).mode).toBe(0)
    expect((await fs.stat('out/nullmode.txt')).mode).toBe(0o644)

    // Updating an existing file: null never overwrites the mode it has.
    await fs.writeText('out/nullmode.txt', 'stale')
    await fs.setMeta('out/nullmode.txt', { mode: 0o600 })
    const p2 = await plan(m, fs, 'out', store)
    const r2 = await apply(p2, fs, 'out', store)
    expect(r2.errors).toEqual([])
    expect(r2.updated).toBe(1)
    expect((await fs.stat('out/nullmode.txt')).mode).toBe(0o600)
    expect(await fs.readText('out/nullmode.txt')).toBe('null')

    // A scan of the result reads the known zero back as the known zero.
    const back = await scan(fs, 'out')
    expect(back.get('zero.txt')!.mode).toBe(ZERO_MODE)
  })
})
