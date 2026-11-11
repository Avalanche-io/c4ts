import { describe, it, expect } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Manifest } from '../src/manifest.js'
import { createEntry } from '../src/entry.js'
import { encode } from '../src/encoder.js'

// Cross-implementation name-escape vector (c4 core, c4m/testdata/
// name-escape-vector; the files under fixtures/name-escape-vector/ are
// byte-identical copies). In a written name a space is "\ ", a double
// quote is '\"', and a control byte is encoded by SafeName; a raw one is
// damage and is refused, naming the line. Through 1.0.26 c4ts read each into
// the name ("real.txt junk" became one name). Any consistent indent reads.

const dir = (v: string): string => fileURLToPath(new URL(`./fixtures/${v}/`, import.meta.url))
const load = (v: string, name: string): Promise<string> => readFile(dir(v) + name, 'utf8')

const damaged = [
  'file-unescaped-space',
  'file-damaged-id-field',
  'file-raw-quote',
  'file-raw-tab',
  'file-raw-control',
  'dir-unescaped-space',
]

describe('name-escape vector: a raw space, quote or control byte in a name is refused', () => {
  it('refuses every damaged name, naming line 1', async () => {
    for (const c of damaged) {
      await expect(Manifest.parse(await load('name-escape-vector', `${c}.c4m`)), c).rejects.toThrow(/line 1:/)
    }
  })

  it('decodes the ok files, the escaped name and the 3-space indent included', async () => {
    expect((await Manifest.parse(await load('name-escape-vector', 'ok-file.c4m'))).entries.length).toBe(1)
    expect((await Manifest.parse(await load('name-escape-vector', 'ok-dir.c4m'))).entries.length).toBe(1)
    const esc = await Manifest.parse(await load('name-escape-vector', 'ok-escaped.c4m'))
    expect(esc.entries.map(e => e.name)).toEqual(['my file "q"\t.txt'])
    const tree = await Manifest.parse(await load('name-escape-vector', 'ok-indent-3.c4m'))
    expect(tree.entries.map(e => [e.name, e.depth])).toEqual([['d/', 0], ['x.txt', 1]])
  })

  it('never writes the raw character: escaped names round-trip', async () => {
    const m = Manifest.create()
    m.addEntry(createEntry({ name: 'my file "q"\t.txt', mode: 0o644, timestamp: new Date(0), size: 1 }))
    const text = encode(m)
    expect(text).not.toContain('my file')
    expect((await Manifest.parse(text)).entries.map(e => e.name)).toEqual(['my file "q"\t.txt'])
  })
})

// Every field error names its line (damaged-line vector: "Refuse every other
// file with an error that names line 1"). Through 1.0.26 c4ts's field
// parsers threw without a line.
it('every damaged-line vector file is refused naming line 1', async () => {
  const files = (await readdir(dir('damaged-line-vector'))).filter(f => f.endsWith('.c4m') && f !== 'ok.c4m')
  expect(files.length).toBeGreaterThan(5)
  for (const f of files) {
    await expect(Manifest.parse(await load('damaged-line-vector', f)), f).rejects.toThrow(/line 1:/)
  }
})
