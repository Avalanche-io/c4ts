import { describe, it, expect } from 'vitest'
import {
  Manifest,
  createEntry,
  encode,
  type Entry,
} from '../src/index.js'
import knownIDs from './vectors/known_ids.json'

const vector = knownIDs.manifest_vectors[0]

describe('encode (canonical)', () => {
  it('encodes a simple manifest to canonical form', async () => {
    const m = await Manifest.parse(vector.canonical)
    const output = m.encode()
    // The encoder sorts and formats — should match the canonical vector
    // (entries are already in sorted order in the vector)
    expect(output).toContain('README.md')
    expect(output).toContain('src/')
    expect(output).toContain('main.go')
  })

  it('produces lines ending with newline', async () => {
    const m = await Manifest.parse(vector.canonical)
    const output = m.encode()
    const lines = output.split('\n')
    // Last element after final \n is empty
    expect(lines[lines.length - 1]).toBe('')
    // Every non-empty line has content
    for (const line of lines.slice(0, -1)) {
      expect(line.length).toBeGreaterThan(0)
    }
  })

  it('indents nested entries', async () => {
    const m = await Manifest.parse(vector.canonical)
    const output = m.encode()
    const lines = output.split('\n').filter(l => l.length > 0)
    // main.go is depth 1 => indented by 2 spaces (default indentWidth)
    const mainGoLine = lines.find(l => l.includes('main.go'))
    expect(mainGoLine).toBeDefined()
    expect(mainGoLine!.startsWith('  ')).toBe(true)
  })

  it('sorts files before directories', () => {
    const m = Manifest.create()
    m.addEntry(createEntry({ name: 'zdir/', modeType: 'd', depth: 0, size: 0, timestamp: new Date(0) }))
    m.addEntry(createEntry({ name: 'afile.txt', depth: 0, size: 100, timestamp: new Date(0) }))

    const output = m.encode()
    const lines = output.split('\n').filter(l => l.length > 0)
    const fileIdx = lines.findIndex(l => l.includes('afile.txt'))
    const dirIdx = lines.findIndex(l => l.includes('zdir/'))
    expect(fileIdx).toBeLessThan(dirIdx)
  })

  it('uses custom indent width', async () => {
    const m = await Manifest.parse(vector.canonical)
    const output = m.encode({ indentWidth: 4 })
    const lines = output.split('\n').filter(l => l.length > 0)
    const mainGoLine = lines.find(l => l.includes('main.go'))
    expect(mainGoLine).toBeDefined()
    // depth 1 with indentWidth 4 => 4 spaces
    expect(mainGoLine!.startsWith('    ')).toBe(true)
    expect(mainGoLine![3]).toBe(' ')
  })
})

describe('encode (pretty)', () => {
  it('produces pretty-printed output with aligned columns', async () => {
    const m = await Manifest.parse(vector.canonical)
    const output = m.encode({ pretty: true })
    expect(output.length).toBeGreaterThan(0)

    const lines = output.split('\n').filter(l => l.length > 0)
    expect(lines.length).toBe(3)

    // Pretty output uses local time format and comma-separated sizes
    // Each line should have content
    for (const line of lines) {
      expect(line.length).toBeGreaterThan(0)
    }
  })

  it('right-aligns size column', async () => {
    const m = Manifest.create()
    m.addEntry(createEntry({
      name: 'small.txt',
      depth: 0,
      mode: 0o644,
      modeType: '-',
      size: 5,
      timestamp: new Date('2025-01-01T00:00:00Z'),
    }))
    m.addEntry(createEntry({
      name: 'large.txt',
      depth: 0,
      mode: 0o644,
      modeType: '-',
      size: 1234567,
      timestamp: new Date('2025-01-01T00:00:00Z'),
    }))

    const output = m.encode({ pretty: true })
    const lines = output.split('\n').filter(l => l.length > 0)
    expect(lines.length).toBe(2)
    // The larger file has commas in size
    const largeLine = lines.find(l => l.includes('large.txt'))
    expect(largeLine).toContain('1,234,567')
  })
})

describe('round-trip: parse then encode', () => {
  it('round-trips the canonical vector', async () => {
    const m = await Manifest.parse(vector.canonical)
    const encoded = m.encode()
    const m2 = await Manifest.parse(encoded)

    // Same number of entries
    expect(m2.entries.length).toBe(m.entries.length)

    // Same names in same order (after sorting)
    for (let i = 0; i < m.entries.length; i++) {
      expect(m2.entries[i].name).toBe(m.entries[i].name)
      expect(m2.entries[i].depth).toBe(m.entries[i].depth)
      expect(m2.entries[i].size).toBe(m.entries[i].size)
      expect(m2.entries[i].mode).toBe(m.entries[i].mode)
    }
  })

  it('round-trips c4 IDs', async () => {
    const m = await Manifest.parse(vector.canonical)
    const encoded = m.encode()
    const m2 = await Manifest.parse(encoded)

    for (let i = 0; i < m.entries.length; i++) {
      const id1 = m.entries[i].c4id
      const id2 = m2.entries[i].c4id
      if (id1 === null) {
        expect(id2).toBeNull()
      } else {
        expect(id2).not.toBeNull()
        expect(id2!.toString()).toBe(id1.toString())
      }
    }
  })

  it('computeC4ID is stable across round-trips', async () => {
    const m = await Manifest.parse(vector.canonical)
    const id1 = await m.computeC4ID()

    const encoded = m.encode()
    const m2 = await Manifest.parse(encoded)
    const id2 = await m2.computeC4ID()

    expect(id2.toString()).toBe(id1.toString())
    expect(id1.toString()).toBe(vector.manifest_c4id)
  })
})

describe('encode empty manifest', () => {
  it('produces empty string for empty manifest', () => {
    const m = Manifest.create()
    const output = m.encode()
    expect(output).toBe('')
  })
})
