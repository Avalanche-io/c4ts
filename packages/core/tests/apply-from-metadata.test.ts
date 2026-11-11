import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Manifest } from '../src/manifest.js'
import { applyPatch, patchDiff } from '../src/diff.js'

// Cross-implementation vector, apply-from-vector/metadata-only (c4 core,
// c4m/testdata/apply-from-vector; the files under
// fixtures/apply-from-vector/metadata-only/ are byte-identical copies). The
// patch restates entries with the same C4 ID and size but a different mode
// (run.sh), time (notes.txt), both (both.txt), and one under a directory
// (d/x.txt). "All fields identical" is the removal rule, so each is a write.
// Through 1.0.25 c4ts compared only C4 ID and mode: reading the patch
// removed notes.txt, and its own patchDiff left notes.txt out.

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/apply-from-vector/metadata-only/${name}`, import.meta.url))
const load = (name: string): Promise<string> => readFile(fixture(name), 'utf8')

const want = [
  ['both.txt', '2026-01-02T05:04:05.000Z'],
  ['d/x.txt', '2026-01-02T04:04:05.000Z'],
  ['notes.txt', '2026-01-02T04:04:05.000Z'],
  ['run.sh', '2026-01-02T03:04:05.000Z'],
]

async function checkResult(m: Manifest, label: string): Promise<void> {
  const byPath = new Map<string, string>()
  for (const [path, e] of m) byPath.set(path, e.timestamp.toISOString())
  for (const [path, ts] of want) {
    expect(byPath.get(path), `${label}: ${path} must stay, with the patch's time`).toBe(ts)
  }
  const expectedID = (await load('expected-root-id.txt')).trim()
  expect((await m.computeC4ID()).toString(), label).toBe(expectedID)
}

describe('apply-from-vector metadata-only: a restatement differing only in mode or time is a write', () => {
  it('resolves base then patch, as one chain, to the pinned state', async () => {
    const m = await Manifest.parse((await load('base.c4m')) + (await load('patch.c4m')))
    await checkResult(m, 'chain')
  })

  it('applyPatch reads the patch section against the base', async () => {
    const base = await Manifest.parse(await load('base.c4m'))
    const lines = (await load('patch.c4m')).split('\n')
    const patch = await Manifest.parse(lines.slice(1).join('\n')) // drop the base's ID
    await checkResult(applyPatch(base, patch), 'applyPatch')
  })

  it("c4ts's own patchDiff restates a time-only change, and applying it reaches the new state", async () => {
    const base = await Manifest.parse(await load('base.c4m'))
    const after = await Manifest.parse(await load('expected.c4m'))
    const pr = await patchDiff(base, after)
    const names = pr.patch.entries.map(e => e.name)
    expect(names, 'the time-only change is in the patch').toContain('notes.txt')
    expect(pr.oldID).toBe((await base.computeC4ID()).toString())
    await checkResult(applyPatch(base, pr.patch), 'own patch')
  })
})
