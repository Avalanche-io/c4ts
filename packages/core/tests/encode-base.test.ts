import { describe, it, expect } from 'vitest'
import { Manifest, createEntry, encode, identifyBytes } from '../src/index.js'
import { canonicalEntry } from '../src/entry.js'

// A description that names an external base keeps it through encode and
// decode. Through 2026-11-13 the encoder dropped `base`, so parse then
// encode turned a block on a base into a standalone description of the
// block's own entries (Go core, c4 PR #145).
describe('encode keeps an external base', () => {
  const te = new TextEncoder()

  async function fixture(): Promise<{ base: string; entry: string; text: string }> {
    const base = (await identifyBytes(te.encode('prior block'))).toString()
    // The entry line comes from the package's own formatter, not typed by hand.
    const entry = canonicalEntry(createEntry({
      mode: 0o644,
      modeType: '-',
      timestamp: new Date('2026-01-01T00:00:00Z'),
      size: 1,
      name: 'a.txt',
      c4id: await identifyBytes(te.encode('a')),
    })) + '\n'
    return { base, entry, text: base + '\n' + entry }
  }

  it('writes the base first and changes nothing else', async () => {
    const { base, text } = await fixture()
    const m = await Manifest.parse(text)
    expect(m.base?.toString()).toBe(base)

    const out = encode(m)
    expect(out).toBe(text)

    const back = await Manifest.parse(out)
    expect(back.base?.toString()).toBe(base)
    expect(back.entries).toHaveLength(1)
  })

  it('starts pretty output with the base', async () => {
    const { base, text } = await fixture()
    const m = await Manifest.parse(text)
    expect(encode(m, { pretty: true }).startsWith(base + '\n')).toBe(true)
  })

  it('writes no bare line for a manifest with no base', async () => {
    const { entry, text } = await fixture()
    const m = await Manifest.parse(text)
    m.base = null
    expect(encode(m)).toBe(entry)
  })

  it('leaves the description ID alone', async () => {
    const { entry, text } = await fixture()
    const withBase = await Manifest.parse(text)
    const without = await Manifest.parse(entry)
    expect((await withBase.computeC4ID()).toString()).toBe((await without.computeC4ID()).toString())
    expect(withBase.canonical()).toBe(entry)
  })
})
