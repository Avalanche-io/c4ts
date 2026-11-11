import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Manifest } from '../src/manifest.js'
import { createEntry, isPathName } from '../src/entry.js'
import { encode } from '../src/encoder.js'
import { identifyBytes } from '../src/id.js'

// Cross-implementation name-rule vector (c4 core, c4m/testdata/
// name-rule-vector; the files under fixtures/name-rule-vector/ are
// byte-identical copies). A name is a bare entry name, never a path: only
// "/" separates paths in c4m, and a name may end in "/" only as a
// directory's marker; ".", "..", "./", "../" and "/" are path components.
// Through 1.0.26 c4ts cut a name at its first "/" and dropped the rest of
// the line, C4 ID included ("sub/real.txt" read as a directory "sub/"),
// read the path components as names, and wrote all of them raw.

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/name-rule-vector/${name}`, import.meta.url))
const load = (name: string): Promise<string> => readFile(fixture(name), 'utf8')

const cases: Record<string, string> = {
  'file-sub': 'sub/real.txt',
  'file-leading-slash': '/real.txt',
  'file-trailing-path': 'real.txt/x',
  'file-dotdot-inside': 'a/../real.txt',
  'file-dot': '.',
  'file-dotdot': '..',
  'dir-nested': 'a/empty/',
  'dir-dot': './',
  'dir-dotdot': '../',
  'dir-root': '/',
  'dir-double-slash': 'empty//',
}
const ts = new Date(Date.UTC(2026, 0, 2, 3, 4, 5))

describe('name-rule vector: a name is never a path', () => {
  it('decodes both ok lines', async () => {
    for (const ok of ['ok-file.c4m', 'ok-dir.c4m']) {
      expect((await Manifest.parse(await load(ok))).entries.length, ok).toBe(1)
    }
  })

  it('refuses every damaged name, naming line 1', async () => {
    for (const c of Object.keys(cases)) {
      await expect(Manifest.parse(await load(`${c}.c4m`)), c).rejects.toThrow(/line 1/)
    }
  })

  it('never writes a forbidden name, and still writes a directory marker', () => {
    for (const name of Object.values(cases)) {
      const m = Manifest.create()
      m.addEntry(createEntry({ name, modeType: name.endsWith('/') ? 'd' : '-', mode: 0o644, timestamp: ts, size: 1 }))
      expect(() => encode(m), name).toThrow(/path traversal/)
    }
    const ok = Manifest.create()
    ok.addEntry(createEntry({ name: 'empty/', modeType: 'd', mode: 0o755, timestamp: ts, size: 0 }))
    expect(encode(ok)).toContain(' empty/ ')
  })

  it('gives a forbidden name no C4 ID and no canonical text, flat or nested', async () => {
    const hello = await identifyBytes(new TextEncoder().encode('hello\n'))
    const flat = Manifest.create()
    flat.addEntry(createEntry({ name: 'sub/real.txt', mode: 0o644, timestamp: ts, size: 6, c4id: hello }))
    const nested = Manifest.create()
    nested.addEntry(createEntry({ name: 'd/', modeType: 'd', mode: 0o755, timestamp: ts, size: -1 }))
    nested.addEntry(createEntry({ name: '../real.txt', mode: 0o644, timestamp: ts, size: 6, c4id: hello, depth: 1 }))
    for (const m of [flat, nested]) {
      expect((await m.computeC4ID()).isNil()).toBe(true)
      expect(m.canonical()).toBe('')
    }
    const ok = Manifest.create()
    ok.addEntry(createEntry({ name: 'real.txt', mode: 0o644, timestamp: ts, size: 6, c4id: hello }))
    expect((await ok.computeC4ID()).isNil()).toBe(false)
  })

  it('treats a backslash as a literal name character, as Go does', () => {
    expect(isPathName('a\\b.txt')).toBe(false)
    expect(isPathName('a/b.txt')).toBe(true)
  })
})
