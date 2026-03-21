import { describe, it, expect } from 'vitest'
import {
  Manifest,
  createEntry,
  diff,
  merge,
  applyPatch,
  patchDiff,
  identifyBytes,
} from '../src/index.js'

// Helper: build a simple manifest from name/size pairs
function buildManifest(entries: Array<{ name: string; size: number; modeType?: string; depth?: number }>): Manifest {
  const m = Manifest.create()
  for (const e of entries) {
    m.addEntry(createEntry({
      name: e.name,
      size: e.size,
      modeType: e.modeType ?? (e.name.endsWith('/') ? 'd' : '-'),
      depth: e.depth ?? 0,
      mode: e.name.endsWith('/') ? 0o755 : 0o644,
      timestamp: new Date('2025-01-01T00:00:00Z'),
    }))
  }
  return m
}

describe('diff', () => {
  it('finds added entries', () => {
    const old = buildManifest([{ name: 'a.txt', size: 10 }])
    const newer = buildManifest([
      { name: 'a.txt', size: 10 },
      { name: 'b.txt', size: 20 },
    ])
    const result = diff(old, newer)
    expect(result.added.length).toBe(1)
    expect(result.added[0].path).toBe('b.txt')
    expect(result.removed.length).toBe(0)
    expect(result.modified.length).toBe(0)
  })

  it('finds removed entries', () => {
    const old = buildManifest([
      { name: 'a.txt', size: 10 },
      { name: 'b.txt', size: 20 },
    ])
    const newer = buildManifest([{ name: 'a.txt', size: 10 }])
    const result = diff(old, newer)
    expect(result.removed.length).toBe(1)
    expect(result.removed[0].path).toBe('b.txt')
    expect(result.added.length).toBe(0)
  })

  it('finds modified entries', () => {
    const old = buildManifest([{ name: 'a.txt', size: 10 }])
    const newer = buildManifest([{ name: 'a.txt', size: 99 }])
    const result = diff(old, newer)
    expect(result.modified.length).toBe(1)
    expect(result.modified[0].path).toBe('a.txt')
    expect(result.modified[0].oldEntry.size).toBe(10)
    expect(result.modified[0].newEntry.size).toBe(99)
  })

  it('reports no changes for identical manifests', () => {
    const m = buildManifest([{ name: 'a.txt', size: 10 }])
    const result = diff(m, m.copy())
    expect(result.added.length).toBe(0)
    expect(result.removed.length).toBe(0)
    expect(result.modified.length).toBe(0)
  })

  it('handles empty manifests', () => {
    const result = diff(Manifest.create(), Manifest.create())
    expect(result.added.length).toBe(0)
    expect(result.removed.length).toBe(0)
    expect(result.modified.length).toBe(0)
  })
})

describe('merge', () => {
  it('merges non-conflicting local addition', () => {
    const base = buildManifest([{ name: 'a.txt', size: 10 }])
    const local = buildManifest([
      { name: 'a.txt', size: 10 },
      { name: 'b.txt', size: 20 },
    ])
    const remote = base.copy()
    const { merged, conflicts } = merge(base, local, remote)
    expect(conflicts.length).toBe(0)
    expect(merged.has('b.txt')).toBe(true)
  })

  it('merges non-conflicting remote addition', () => {
    const base = buildManifest([{ name: 'a.txt', size: 10 }])
    const local = base.copy()
    const remote = buildManifest([
      { name: 'a.txt', size: 10 },
      { name: 'c.txt', size: 30 },
    ])
    const { merged, conflicts } = merge(base, local, remote)
    expect(conflicts.length).toBe(0)
    expect(merged.has('c.txt')).toBe(true)
  })

  it('merges non-conflicting additions from both sides', () => {
    const base = buildManifest([{ name: 'a.txt', size: 10 }])
    const local = buildManifest([
      { name: 'a.txt', size: 10 },
      { name: 'b.txt', size: 20 },
    ])
    const remote = buildManifest([
      { name: 'a.txt', size: 10 },
      { name: 'c.txt', size: 30 },
    ])
    const { merged, conflicts } = merge(base, local, remote)
    expect(conflicts.length).toBe(0)
    expect(merged.has('b.txt')).toBe(true)
    expect(merged.has('c.txt')).toBe(true)
  })

  it('detects conflicts when both sides modify the same entry differently', () => {
    const base = buildManifest([{ name: 'a.txt', size: 10 }])
    const local = buildManifest([{ name: 'a.txt', size: 20 }])
    const remote = buildManifest([{ name: 'a.txt', size: 30 }])
    const { conflicts } = merge(base, local, remote)
    expect(conflicts.length).toBe(1)
    expect(conflicts[0].path).toBe('a.txt')
  })

  it('no conflict when both sides make the same modification', () => {
    const base = buildManifest([{ name: 'a.txt', size: 10 }])
    const local = buildManifest([{ name: 'a.txt', size: 99 }])
    const remote = buildManifest([{ name: 'a.txt', size: 99 }])
    const { merged, conflicts } = merge(base, local, remote)
    expect(conflicts.length).toBe(0)
    expect(merged.get('a.txt')!.size).toBe(99)
  })

  it('no conflict when both sides delete the same entry', () => {
    const base = buildManifest([
      { name: 'a.txt', size: 10 },
      { name: 'b.txt', size: 20 },
    ])
    const local = buildManifest([{ name: 'a.txt', size: 10 }])
    const remote = buildManifest([{ name: 'a.txt', size: 10 }])
    const { merged, conflicts } = merge(base, local, remote)
    expect(conflicts.length).toBe(0)
    expect(merged.has('b.txt')).toBe(false)
  })
})

describe('applyPatch', () => {
  it('applies additions', () => {
    const base = buildManifest([{ name: 'a.txt', size: 10 }])
    const patch = buildManifest([{ name: 'b.txt', size: 20 }])
    const result = applyPatch(base, patch)
    expect(result.has('a.txt')).toBe(true)
    expect(result.has('b.txt')).toBe(true)
  })

  it('applies modifications', () => {
    const base = buildManifest([{ name: 'a.txt', size: 10 }])
    const patch = buildManifest([{ name: 'a.txt', size: 99 }])
    const result = applyPatch(base, patch)
    expect(result.get('a.txt')!.size).toBe(99)
  })

  it('applies removals (identical entry in patch)', () => {
    const base = buildManifest([
      { name: 'a.txt', size: 10 },
      { name: 'b.txt', size: 20 },
    ])
    // Patch restates a.txt identically => removal
    const patch = buildManifest([{ name: 'a.txt', size: 10 }])
    const result = applyPatch(base, patch)
    expect(result.has('a.txt')).toBe(false)
    expect(result.has('b.txt')).toBe(true)
  })

  it('does not modify the original base manifest', () => {
    const base = buildManifest([{ name: 'a.txt', size: 10 }])
    const patch = buildManifest([{ name: 'b.txt', size: 20 }])
    applyPatch(base, patch)
    expect(base.entries.length).toBe(1)
    expect(base.entries[0].name).toBe('a.txt')
  })
})

describe('patchDiff', () => {
  it('produces a patch that captures additions', async () => {
    const old = buildManifest([{ name: 'a.txt', size: 10 }])
    const newer = buildManifest([
      { name: 'a.txt', size: 10 },
      { name: 'b.txt', size: 20 },
    ])
    const { oldID, patch } = await patchDiff(old, newer)
    expect(oldID).toBe((await old.computeC4ID()).toString())
    // Patch should contain b.txt (addition)
    const names = patch.entries.map(e => e.name)
    expect(names).toContain('b.txt')
  })

  it('produces a patch that captures modifications', async () => {
    const old = buildManifest([{ name: 'a.txt', size: 10 }])
    const newer = buildManifest([{ name: 'a.txt', size: 99 }])
    const { patch } = await patchDiff(old, newer)
    const entry = patch.entries.find(e => e.name === 'a.txt')
    expect(entry).toBeDefined()
    expect(entry!.size).toBe(99)
  })

  it('produces a patch that captures removals', async () => {
    const old = buildManifest([
      { name: 'a.txt', size: 10 },
      { name: 'b.txt', size: 20 },
    ])
    const newer = buildManifest([{ name: 'a.txt', size: 10 }])
    const { patch } = await patchDiff(old, newer)
    // Removal: original entry restated exactly
    const entry = patch.entries.find(e => e.name === 'b.txt')
    expect(entry).toBeDefined()
    expect(entry!.size).toBe(20)
  })
})
