import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { decode } from '../src/decoder.js'
import { encode } from '../src/encoder.js'
import { identifyBytes } from '../src/id.js'
import { Manifest } from '../src/manifest.js'

// Cross-implementation conformance: a directory with no listed children and
// a null size. fixtures/childless-dir-vector is a byte-identical copy of the
// Go reference repo's c4m/testdata/childless-dir-vector (README there). What
// the size derives to depends on the directory's C4 ID alone:
//   empty/      the empty listing's ID  -> 0: known to hold nothing
//   collapsed/  any other ID           -> null: its listing lives elsewhere
//   unread/     no ID                  -> null: nobody listed it
// Through 2026-11-11 a collapsed directory derived to 0, and computeC4ID
// hashed that invented size.

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/childless-dir-vector/${name}`, import.meta.url))
const load = (name: string): Promise<string> => readFile(fixture(name), 'utf8')
const WANT: Record<string, number> = { 'empty/': 0, 'collapsed/': -1, 'unread/': -1 }

async function manifest(name: string): Promise<Manifest> {
  const m = new Manifest()
  m.entries = (await decode(await load(name))).entries
  return m
}

describe('childless-dir vector', () => {
  for (const form of ['stated.c4m', 'normalized.c4m']) {
    it(`${form} resolves to the root ID`, async () => {
      const m = await manifest(form)
      expect((await m.computeC4ID()).toString()).toBe((await load('root-id.txt')).trim())
    })

    it(`${form}: sizes derive from the C4 ID alone`, async () => {
      const m = await manifest(form)
      m.canonicalize()
      expect(Object.fromEntries(m.entries.map(e => [e.name, e.size]))).toEqual(WANT)
    })
  }

  it('the canonicalized stated form writes the normalized file', async () => {
    const m = await manifest('stated.c4m')
    m.canonicalize()
    expect(encode(m)).toBe(await load('normalized.c4m'))
  })

  it("the normalized file's own bytes are the description", async () => {
    const bytes = new Uint8Array(await readFile(fixture('normalized.c4m')))
    expect((await identifyBytes(bytes)).toString()).toBe((await load('root-id.txt')).trim())
  })
})
