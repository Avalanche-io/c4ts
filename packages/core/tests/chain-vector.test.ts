import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Manifest } from '../src/manifest.js'
import { PatchIDMismatchError } from '../src/errors.js'

// Cross-implementation chain vector (grammar erratum, 2026-07-13).
// The shared conformance contract lives in the Go reference repo at
// c4m/testdata/chain-vector (see its README.md); the files under
// fixtures/chain-vector/ here are byte-identical copies.
//
//   <base entry>            a.txt
//   c4<checkpoint>          = accumulated state after the base ({a.txt})
//   <patch entry>           b.txt (addition)
//   c4<closing validator>   = the resolved manifest's ID, at EOF ({a.txt,b.txt})

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/chain-vector/${name}`, import.meta.url))

const load = (name: string): Promise<string> => readFile(fixture(name), 'utf8')

describe('chain-vector conformance (grammar erratum 2026-07-13)', () => {
  it('accepts vector.c4m and resolves to the pinned root ID', async () => {
    const text = await load('vector.c4m')
    const expectedID = (await load('resolved-root-id.txt')).trim()

    const m = await Manifest.parse(text)
    const id = await m.computeC4ID()

    expect(id.toString()).toBe(expectedID)
    // The resolved manifest is {a.txt, b.txt}: a.txt from the base, b.txt added.
    expect(m.entries.map(e => e.name).sort()).toEqual(['a.txt', 'b.txt'])
  })

  it('rejects bad-validator.c4m (closing validator does not match resolved manifest)', async () => {
    const text = await load('bad-validator.c4m')
    await expect(Manifest.parse(text)).rejects.toThrow(PatchIDMismatchError)
  })

  it('rejects bad-checkpoint.c4m (interior checkpoint does not match accumulated state)', async () => {
    const text = await load('bad-checkpoint.c4m')
    await expect(Manifest.parse(text)).rejects.toThrow(PatchIDMismatchError)
  })
})

// The three shared fixtures cover an interior checkpoint and a closing
// validator that both differ from the good stream. These cases isolate the two
// shapes the erratum newly legalizes — a single-section closing validator at
// EOF and consecutive checkpoints — reusing IDs the vector fixture pins.
describe('chain erratum: newly-legal shapes', () => {
  it('accepts a closing validator at EOF of a single section', async () => {
    const vlines = (await load('vector.c4m')).split('\n')
    const aLine = vlines[0] // a.txt entry
    const ckptA = vlines[1] // = C4 ID of the manifest containing just a.txt

    const stream = `${aLine}\n${ckptA}\n`
    const m = await Manifest.parse(stream)
    expect(m.entries.map(e => e.name)).toEqual(['a.txt'])
    expect((await m.computeC4ID()).toString()).toBe(ckptA)
  })

  it('accepts consecutive checkpoints naming the same accumulated state', async () => {
    const vlines = (await load('vector.c4m')).split('\n')
    const aLine = vlines[0]
    const ckptA = vlines[1]

    const stream = `${aLine}\n${ckptA}\n${ckptA}\n`
    const m = await Manifest.parse(stream)
    expect(m.entries.map(e => e.name)).toEqual(['a.txt'])
  })

  it('rejects a closing validator that does not match its single section', async () => {
    const vlines = (await load('vector.c4m')).split('\n')
    const aLine = vlines[0]
    // The resolved root ID names {a.txt, b.txt}, never {a.txt} alone.
    const wrong = (await load('resolved-root-id.txt')).trim()

    const stream = `${aLine}\n${wrong}\n`
    await expect(Manifest.parse(stream)).rejects.toThrow(PatchIDMismatchError)
  })
})
