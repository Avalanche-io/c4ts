import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Manifest } from '../src/manifest.js'
import { decode } from '../src/decoder.js'
import { applyPatch } from '../src/diff.js'

// Cross-implementation deepen-vs-remove vector (removal-rule erratum,
// 2026-07-31). The shared conformance contract lives in the Go reference
// repo at c4m/testdata/deepen-vector (see its README.md); the files under
// fixtures/deepen-vector/ here are byte-identical copies.
//
// Both files share a byte-identical base and restate the SAME directory
// line byte-identically; they differ only in whether a child follows it:
//
//   deepen.c4m  resolves to a.txt, docs/, readme.md, guide.md
//   remove.c4m  resolves to a.txt alone
//
// Conformance is checked on the resolved entry set, not only on the ID: a
// reader that removes the directory but leaves its children as orphans can
// still compute the pinned root ID, since only top-level entries feed it.

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/deepen-vector/${name}`, import.meta.url))

const load = (name: string): Promise<string> => readFile(fixture(name), 'utf8')

const isBareID = (line: string): boolean => line.length === 90 && line.startsWith('c4')

const cases = [
  { file: 'deepen.c4m', idFile: 'deepen-root-id.txt', want: ['a.txt', 'docs/', 'guide.md', 'readme.md'] },
  { file: 'remove.c4m', idFile: 'remove-root-id.txt', want: ['a.txt'] },
]

describe('deepen-vector conformance (removal-rule erratum 2026-07-31)', () => {
  it('resolves each fixture to exactly the pinned entries and root ID', async () => {
    // The decoder verifies the interior checkpoint and the closing
    // validator; an implementation carrying the old rule surfaces as a
    // checkpoint mismatch here. The entry set is checked as well, since a
    // non-verifying reader would simply return the wrong manifest.
    const ids: Record<string, string> = {}
    for (const c of cases) {
      const text = await load(c.file)
      const expectedID = (await load(c.idFile)).trim()
      const m = await Manifest.parse(text)
      expect(m.entries.map(e => e.name).sort(), c.file).toEqual(c.want)
      const id = (await m.computeC4ID()).toString()
      expect(id, c.file).toBe(expectedID)
      ids[c.file] = id
    }
    // The contract in one line: the same restated directory means opposite
    // things depending on whether children follow it.
    expect(ids['deepen.c4m']).not.toBe(ids['remove.c4m'])
  })

  it('applies the patch section to the base section with the same result', async () => {
    for (const c of cases) {
      const lines = (await load(c.file)).replace(/\n+$/, '').split('\n')
      const sections: string[][] = [[]]
      for (const line of lines) {
        if (isBareID(line)) sections.push([])
        else sections[sections.length - 1].push(line)
      }
      const toManifest = async (section: string[]): Promise<Manifest> => {
        const m = new Manifest()
        m.entries = (await decode(section.join('\n') + '\n')).entries
        return m
      }
      const base = await toManifest(sections[0])
      const patch = await toManifest(sections[1])
      const applied = applyPatch(base, patch)
      expect(applied.entries.map(e => e.name).sort(), c.file).toEqual(c.want)
      expect((await applied.computeC4ID()).toString(), c.file).toBe((await load(c.idFile)).trim())
    }
  })
})
