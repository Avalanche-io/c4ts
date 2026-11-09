import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Manifest, MemoryFS, reconcilePlan } from '../src/index.js'

// A pretty (aligned) line whose C4 ID column is "-" must not read its
// padding into the name. Through 1.0.24 the decoder tested a single space
// for the field boundary, so `a.txt` in a names-only pretty file decoded
// as `a.txt` plus 35 spaces; a reconcile plan for such a file then removed
// every real file and created padded-name decoys (measured on the released
// 1.0.24 package, 2026-11-09). The fixture is a real file written by c4
// 1.0.21's pretty encoder.
const legacy = readFileSync(join(__dirname, 'fixtures', 'legacy', 'ten-dash-null-1.0.21.c4m'), 'utf8')

describe('pretty null-ID lines (c4 1.0.21 file)', () => {
  it('decodes names without alignment padding', async () => {
    const m = await Manifest.parse(legacy)
    const names = m.entries.map((e) => e.name)
    expect(names).toEqual(['a.txt', 'd/', 'b.txt'])
  })

  it('plans no removals against the tree it describes', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('/tree', { recursive: true })
    await fs.mkdir('/tree/d', { recursive: true })
    await fs.writeText('/tree/a.txt', 'A\n')
    await fs.writeText('/tree/d/b.txt', 'B\n')

    const m = await Manifest.parse(legacy)
    const plan = await reconcilePlan(m, fs, '/tree', undefined)
    const removes = plan.operations.filter((op) => op.type === 'remove' || op.type === 'rmdir')
    expect(removes).toEqual([])
    const padded = plan.operations.filter((op) => op.path.endsWith(' '))
    expect(padded).toEqual([])
  })
})
