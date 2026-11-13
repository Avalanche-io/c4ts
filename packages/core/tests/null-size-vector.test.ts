import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Manifest } from '../src/manifest.js'
import { encode } from '../src/encoder.js'
import { identifyBytes } from '../src/id.js'
import {
  createEntry,
  canonicalEntry,
  formatEntry,
  hasNullValues,
  getNullFields,
  sizeIsNull,
  EMPTY_CONTENT_ID,
  NULL_SIZE,
} from '../src/entry.js'

// Cross-implementation vector: a size of 0 beside a C4 ID (2026-11-13).
// The shared conformance contract lives in the Go reference repo at
// c4m/testdata/null-size-vector (see its README.md); the files under
// fixtures/null-size-vector/ here are byte-identical copies.
//
// The rule (SPECIFICATION.md "Size" and the null table; C4M-STANDARD §4.3;
// ruled 2026-11-08, landed 2026-11-13, decided by the release lead;
// reversible): a size of 0 beside a C4 ID other than the empty content's is
// a null size, on any entry that is not a symlink. A filesystem surface has
// no "-", so a null size shows there as 0, and only the empty content truly
// has size 0.

const dir = fileURLToPath(new URL('./fixtures/null-size-vector/', import.meta.url))
const load = (name: string) => readFile(dir + name, 'utf8')

const wantNull: Record<string, boolean> = {
  'null.txt': true,
  'collapsed/': true,
  'empty.txt': false,
  'emptydir/': false,
  'structure.txt': false,
  'link': false,
  'known.txt': false,
}

describe('null-size vector', () => {
  for (const file of ['canonical.c4m', 'zero-spelled.c4m']) {
    it(`${file} resolves to root-id.txt, sizes per the README, and re-encodes to canonical.c4m`, async () => {
      const root = (await load('root-id.txt')).trim()
      const canonical = await load('canonical.c4m')
      const m = await Manifest.parse(await load(file))

      expect((await m.computeC4ID()).toString()).toBe(root)
      expect(m.entries.map(e => e.name).sort()).toEqual(Object.keys(wantNull).sort())
      for (const e of m.entries) {
        expect(sizeIsNull(e), e.name).toBe(wantNull[e.name])
        // The decoder holds a null size as the package's null.
        if (wantNull[e.name]) expect(e.size, e.name).toBe(NULL_SIZE)
      }
      expect(m.entries.find(e => e.name === 'known.txt')!.size).toBe(5)
      for (const name of ['empty.txt', 'emptydir/', 'structure.txt', 'link']) {
        expect(m.entries.find(e => e.name === name)!.size, name).toBe(0)
      }

      expect(encode(m)).toBe(canonical)
    })
  }
})

describe('a size of 0 beside a C4 ID', () => {
  const ts = '2026-03-06T12:00:00Z'
  const te = new TextEncoder()
  const helloID = async () => identifyBytes(te.encode('hello'))

  it('EMPTY_CONTENT_ID is the C4 ID of zero bytes', async () => {
    expect((await identifyBytes(new Uint8Array(0))).toString()).toBe(EMPTY_CONTENT_ID)
  })

  it('reads as null only beside a non-empty ID on a non-symlink', async () => {
    const hello = (await helloID()).toString()
    const cases: Array<[string, string, boolean]> = [
      ['zero with real content ID is null', `-rw-r--r-- ${ts} 0 f ${hello}`, true],
      ['zero with empty-content ID is known', `-rw-r--r-- ${ts} 0 f ${EMPTY_CONTENT_ID}`, false],
      ['zero with no ID is known (structure scan)', `-rw-r--r-- ${ts} 0 f -`, false],
      ['symlink zero is its own size', `lrwxr-xr-x ${ts} 0 l -> f ${hello}`, false],
      ['directory zero with listing ID is known', `drwxr-xr-x ${ts} 0 d/ ${EMPTY_CONTENT_ID}`, false],
      ['directory zero with other ID is null', `drwxr-xr-x ${ts} 0 d/ ${hello}`, true],
      ['non-zero is known', `-rw-r--r-- ${ts} 5 f ${hello}`, false],
      ['dash is null', `-rw-r--r-- ${ts} - f ${hello}`, true],
    ]
    for (const [name, line, isNull] of cases) {
      const e = (await Manifest.parse(line + '\n')).entries[0]
      expect(sizeIsNull(e), name).toBe(isNull)
      if (isNull) expect(e.size, name).toBe(NULL_SIZE)
      expect(canonicalEntry(e).split(' ')[2] === '-', name).toBe(isNull)
    }
  })

  it('0 and - are one description, however the entry was built', async () => {
    const hello = await helloID()
    const fromZero = await Manifest.parse(`-rw-r--r-- ${ts} 0 f ${hello}\n`)
    const fromDash = await Manifest.parse(`-rw-r--r-- ${ts} - f ${hello}\n`)
    const dashID = (await fromDash.computeC4ID()).toString()
    expect((await fromZero.computeC4ID()).toString()).toBe(dashID)

    // Built through the API with size 0 (as a scan over a mount would build
    // it), the entry still renders and hashes as null.
    const built = Manifest.create()
    const e = createEntry({
      mode: 0o644, modeType: '-', timestamp: new Date(ts), size: 0, name: 'f', c4id: hello,
    })
    built.addEntry(e)
    expect((await built.computeC4ID()).toString()).toBe(dashID)
    expect(encode(built)).toContain(' - f ')
    expect(encode(built, { pretty: true })).not.toMatch(/ 0 f /)
    expect(formatEntry(e, 2, true).split(' ')[2]).toBe('-')
    expect(hasNullValues(e)).toBe(true)
    expect(getNullFields(e)).toContain('Size')
  })

  it('a null written as 0 makes the parent directory size null', async () => {
    const hello = await helloID()
    const m = await Manifest.parse(
      `drwxr-xr-x ${ts} - d/ -\n  -rw-r--r-- ${ts} 0 f ${hello}\n`,
    )
    // Built through the API too, where the decoder has not rewritten it.
    const built = Manifest.create()
    built.addEntry(createEntry({ mode: 0o755, modeType: 'd', timestamp: new Date(ts), name: 'd/' }))
    built.addEntry(createEntry({
      mode: 0o644, modeType: '-', timestamp: new Date(ts), size: 0, name: 'f', c4id: hello, depth: 1,
    }))
    for (const man of [m, built]) {
      man.canonicalize()
      const d = man.entries.find(x => x.name === 'd/')!
      expect(sizeIsNull(d)).toBe(true)
    }
  })
})
