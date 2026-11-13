import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Manifest } from '../src/manifest.js'
import { formatName } from '../src/safename.js'

// Cross-implementation SafeName vector (c4 core, c4m/testdata/
// safename-vector; the files under fixtures/safename-vector/ are
// byte-identical copies). Four of its names hold bytes that are not UTF-8,
// which a JS string cannot hold exactly. Through 1.0.26 c4ts decoded them
// leniently, to U+FFFD: a different name and C4 ID, with no error. They are
// refused, naming the line, for 1.x; every other name is written as Go
// writes it, Tier 1 deciding "printable" from the table pinned to Unicode
// 17.0.0 (both decided 2026-11-13 by the release lead; reversible; vector
// README).

const V = fileURLToPath(new URL('./fixtures/safename-vector/', import.meta.url))
const read = (n: string): Promise<string> => readFile(V + n, 'utf8')
const invalid = ['invalid-ff', 'lone-continuation', 'overlong-nul', 'surrogate']

async function cases(): Promise<Array<{ label: string; raw: Buffer; field: string }>> {
  return (await read('cases.txt')).split('\n').filter(Boolean).map(l => {
    const [label, hx, ...rest] = l.split(' ')
    return { label, raw: Buffer.from(hx, 'hex'), field: rest.join(' ') }
  })
}

describe('SafeName vector: a name c4ts cannot hold exactly is refused, never replaced', () => {
  it('refuses the vector at the line of its first name that is not UTF-8', async () => {
    const text = await read('names.c4m')
    const lines = text.split('\n')
    const first = lines.findIndex(l => invalid.some(label => l.includes(` ${label}-`))) + 1
    await expect(Manifest.parse(text)).rejects.toThrow(new RegExp(`line ${first}:`))
  })

  it('refuses each such line on its own, naming it', async () => {
    const lines = (await read('names.c4m')).split('\n')
    for (const label of invalid) {
      const line = lines.find(l => l.includes(` ${label}-`))!
      await expect(Manifest.parse(line + '\n'), label).rejects.toThrow(/line 1:/)
    }
  })

  it('still reads every other name byte-exact', async () => {
    const lines = (await read('names.c4m')).split('\n').filter(l => l && !invalid.some(label => l.includes(` ${label}-`)))
    const m = await Manifest.parse(lines.join('\n') + '\n')
    const got = new Set(m.entries.map(e => Buffer.from(e.name, 'utf8').toString('hex')))
    for (const c of (await cases()).filter(c => !invalid.includes(c.label))) {
      expect(got.has(c.raw.toString('hex')), c.label).toBe(true)
    }
  })

  it('writes every name as Go writes it', async () => {
    for (const c of (await cases()).filter(c => !invalid.includes(c.label))) {
      expect(formatName(c.raw.toString('utf8'), false), c.label).toBe(c.field)
    }
  })
})
