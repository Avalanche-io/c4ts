import { describe, it, expect } from 'vitest'
import { Manifest } from '../src/manifest.js'
import { createEntry, timestampIsNull, NULL_TIMESTAMP } from '../src/entry.js'

// Core's epoch-second vector (c4 #192), rule 1, for an entry a caller
// builds in memory: a time is null when the second it falls in is the
// epoch, so a time inside it (0.5 s) is written "-", and the manifest has
// the C4 ID of its own text. c4ts's Node scan already floored the second
// (secondOf); an entry built with a millisecond Date did not.
describe('a time is null at the format\'s resolution', () => {
  it.each([
    [0, true],
    [1, true],
    [500, true],
    [999, true],
    [1000, false],
    [-1, false],
    [-500, false],
    [1_750_000_000_000, false],
  ])('a built entry at %i ms is null: %s', async (ms, isNull) => {
    const e = createEntry({ name: 'f.txt', mode: 0o644, modeType: '-', timestamp: new Date(ms), size: 1 })
    expect(timestampIsNull(e.timestamp)).toBe(isNull)
    const m = new Manifest()
    m.addEntry(e)
    const text = m.encode()
    expect(text.split(' ')[1] === '-').toBe(isNull)
    const again = await Manifest.parse(text)
    expect((await m.computeC4ID()).toString()).toBe((await again.computeC4ID()).toString())
    // The pretty form spells the same null and reads back to the same ID.
    const pretty = m.encode({ pretty: true })
    expect(pretty.trim().split(/ +/)[1] === '-').toBe(isNull)
    expect((await (await Manifest.parse(pretty)).computeC4ID()).toString()).toBe((await m.computeC4ID()).toString())
  })

  it('a directory timed inside the epoch second is filled from its children, as a null one is', async () => {
    const build = async (dirTime: Date) => {
      const m = new Manifest()
      m.addEntry(createEntry({ name: 'sub/', mode: 0o755, modeType: 'd', depth: 0, timestamp: dirTime }))
      m.addEntry(createEntry({ name: 'a.txt', mode: 0o644, modeType: '-', depth: 1, timestamp: new Date(1_750_000_000_000), size: 1 }))
      return m
    }
    const inside = await build(new Date(500))
    const nullDir = await build(new Date(0))
    expect(inside.encode()).toBe(nullDir.encode())
    expect((await inside.computeC4ID()).toString()).toBe((await nullDir.computeC4ID()).toString())
    const again = await Manifest.parse(inside.encode())
    expect((await again.computeC4ID()).toString()).toBe((await inside.computeC4ID()).toString())
  })

  it('the epoch itself is still the null sentinel', () => {
    expect(timestampIsNull(NULL_TIMESTAMP)).toBe(true)
  })
})
