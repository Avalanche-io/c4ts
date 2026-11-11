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
//   unread/     no ID                  -> 0 on 1.0.x; null on main
// Through 1.0.26 a collapsed directory derived to 0, and computeC4ID hashed
// that invented size. unread/ is a known 1.0.x difference, as on the Go
// reference's 1.0.27 line, so the committed normalized.c4m and root-id.txt
// are main's, and this line's own normalised form and ID are checked against
// themselves and against the 1.0.x ID pinned in every implementation.

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/childless-dir-vector/${name}`, import.meta.url))
const load = (name: string): Promise<string> => readFile(fixture(name), 'utf8')
const WANT: Record<string, number> = { 'empty/': 0, 'collapsed/': -1, 'unread/': 0 }
const LINE_ROOT_ID =
  'c43hjzfaERSHQSgDYwRPabKdXuC1gbHSW1BnXPVhvCm8LNgYj5LEH6a3VoV2gckqiLNMBQEh4dTVKszriwrmZryUkh'

async function manifest(name: string): Promise<Manifest> {
  const m = new Manifest()
  m.entries = (await decode(await load(name))).entries
  return m
}

async function lineNormalized(): Promise<string> {
  const m = await manifest('stated.c4m')
  m.canonicalize()
  return encode(m)
}

describe('childless-dir vector (1.0.x)', () => {
  for (const form of ['stated.c4m', 'normalized.c4m']) {
    it(`${form}: sizes derive from the C4 ID alone`, async () => {
      const m = await manifest(form)
      m.canonicalize()
      expect(Object.fromEntries(m.entries.map(e => [e.name, e.size]))).toEqual(WANT)
    })
  }

  it("main's normalized file differs from this line's only in unread/'s size", async () => {
    const m = await manifest('normalized.c4m')
    for (const e of m.entries) if (e.name === 'unread/') e.size = 0
    expect(encode(m)).toBe(await lineNormalized())
  })

  it("this line's ID is the pinned 1.0.x ID, agrees with itself, and differs from main's", async () => {
    const lineId = (await (await manifest('stated.c4m')).computeC4ID()).toString()
    expect(lineId).toBe(LINE_ROOT_ID)
    const normalized = await lineNormalized()
    const n = new Manifest()
    n.entries = (await decode(normalized)).entries
    expect((await n.computeC4ID()).toString()).toBe(lineId)
    expect((await identifyBytes(new TextEncoder().encode(normalized))).toString()).toBe(lineId)
    // If this ever matches, the unread/ difference is gone: update the test.
    expect(lineId).not.toBe((await load('root-id.txt')).trim())
  })

  it("the normalized file's own bytes are main's description", async () => {
    const bytes = new Uint8Array(await readFile(fixture('normalized.c4m')))
    expect((await identifyBytes(bytes)).toString()).toBe((await load('root-id.txt')).trim())
  })
})
