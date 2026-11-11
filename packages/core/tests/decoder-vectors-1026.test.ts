import { describe, it, expect } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { decode } from '../src/decoder.js'
import { Manifest } from '../src/manifest.js'

// Cross-implementation conformance for the 1.0.26 decoder rules. The files
// under fixtures/link-target-vector, fixtures/backslash-name-vector and
// fixtures/damaged-line-vector are byte-identical copies of the Go reference
// repo's c4m/testdata vectors of the same names; each README states what
// every implementation MUST do:
// - after a link operator, one field that is "-" or a C4 ID is an ungrouped
//   hard link's ID field; two fields are a target and the ID field, even
//   when the target starts with "c4" (under a null mode);
// - the pretty form's padding before the C4 ID field is not part of a target;
// - a backslash always starts a two-byte escape, so a name or target ending
//   in a backslash reads back as itself;
// - a damaged field is an error, never a value: a size token ends at a
//   space, and each mode position holds only its own letter or "-".

const fixture = (rel: string): string =>
  fileURLToPath(new URL(`./fixtures/${rel}`, import.meta.url))
const load = (rel: string): Promise<string> => readFile(fixture(rel), 'utf8')

const ID_TEXT = 'c43312d4NsKWQvybWGtgLk6iaWeuHUjz6PzjYgD6bNgqkqk4u6ECWjD2v88R1eRBPw3nNQnG6QMrmofSZcKfmMmJpy'
const CONTENT = 'c45WurN5j5WeFqxZMB8ZY9p4D2Ks9rNTEmbXFihjWmCJjDM66pNmRYvW41hGt1Bzj8iJ8WsqyXwNmH7VAJSjvwV91v'

const LINK_TARGET: Record<string, [string, number, string | null]> = {
  'id-null': [ID_TEXT, 0, null],
  'id-set': [ID_TEXT, 0, CONTENT],
  'id-exr-null': [ID_TEXT + '.exr', 0, null],
  'id-exr-set': [ID_TEXT + '.exr', 0, CONTENT],
  'c4-prefix-null': ['c4studio', 0, null],
  'objects-null': ['../objects/' + ID_TEXT, 0, null],
  'hard-null-id': ['', -1, CONTENT],
  'hard-null-nil': ['', -1, null],
  'epoch-link-nil': ['missing.txt', 0, null],
  'epoch-link-id': ['real.txt', 0, CONTENT],
}

const BACKSLASH: Record<string, string> = {
  'plain.txt': '',
  'trail\\': '',
  'end\\\\': '',
  'a\\ b': '',
  link: 'target\\',
  'dir\\x/': '',
  'in.txt': '',
}

async function rootID(dir: string, entries: Awaited<ReturnType<typeof decode>>['entries']): Promise<[string, string]> {
  const m = new Manifest()
  for (const e of entries) m.addEntry(e)
  return [(await m.computeC4ID()).toString(), (await load(`${dir}/root-id.txt`)).trim()]
}

describe('link-target vector', () => {
  for (const form of ['canonical.c4m', 'pretty.c4m', 'patch.c4m']) {
    it(`${form} decodes to the vector's links`, async () => {
      const r = await decode(await load(`link-target-vector/${form}`))
      const got: Record<string, [string, number, string | null]> = {}
      for (const e of r.entries) got[e.name] = [e.target, e.hardLink, e.c4id ? e.c4id.toString() : null]
      expect(got).toEqual(LINK_TARGET)
      if (form !== 'patch.c4m') {
        const [have, want] = await rootID('link-target-vector', r.entries)
        expect(have).toBe(want)
      }
    })
  }
})

describe('backslash-name vector', () => {
  for (const form of ['canonical.c4m', 'pretty.c4m', 'patch.c4m']) {
    it(`${form} reads every name and target back as itself`, async () => {
      const r = await decode(await load(`backslash-name-vector/${form}`))
      const got: Record<string, string> = {}
      for (const e of r.entries) got[e.name] = e.target
      expect(got).toEqual(BACKSLASH)
      if (form !== 'patch.c4m') {
        const [have, want] = await rootID('backslash-name-vector', r.entries)
        expect(have).toBe(want)
      }
    })
  }
})

describe('damaged-line vector', () => {
  it('ok.c4m decodes', async () => {
    await decode(await load('damaged-line-vector/ok.c4m'))
  })
  it('every damaged file is refused', async () => {
    const files = (await readdir(fixture('damaged-line-vector'))).filter((f) => f.endsWith('.c4m') && f !== 'ok.c4m')
    expect(files.length).toBe(9)
    for (const f of files) {
      await expect(decode(await load(`damaged-line-vector/${f}`)), f).rejects.toThrow()
    }
  })
})
