import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Manifest } from '../src/manifest.js'
import { decode, loads } from '../src/decoder.js'
import { PatchIDMismatchError, TrailingIDError } from '../src/errors.js'

// Cross-implementation chain vector (grammar erratum, 2026-07-13; amended
// 2026-11-08). The shared conformance contract lives in the Go reference
// repo at c4m/testdata/chain-vector (see its README.md, copied alongside);
// the files under fixtures/chain-vector/ here are byte-identical copies.
//
//   <base entry>            a.txt
//   c4<checkpoint>          = accumulated state after the base ({a.txt})
//   <patch entry>           b.txt (addition); the stream ends here
//
// A stream ends on an entry line. A bare C4 ID at end of input is a format
// error (ruled 2026-11-08: a c4m file never ends with its own ID), refused
// with TrailingIDError by every reader. The resolving decoder verifies such
// an ID as a checkpoint first, as Go's does, so a wrong one is a
// PatchIDMismatchError there; the shape-level reader does not verify, so it
// reports the trailing ID.

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/chain-vector/${name}`, import.meta.url))

const load = (name: string): Promise<string> => readFile(fixture(name), 'utf8')

// Every public reader entry point: the resolving decoder and the shape-level
// readers.
const readers: [string, (text: string) => Promise<unknown>][] = [
  ['Manifest.parse', t => Manifest.parse(t)],
  ['decode', t => decode(t)],
  ['loads', t => loads(t)],
]

describe('chain-vector conformance', () => {
  it('accepts vector.c4m and resolves to the pinned root ID', async () => {
    const text = await load('vector.c4m')
    const expectedID = (await load('resolved-root-id.txt')).trim()

    const m = await Manifest.parse(text)
    const id = await m.computeC4ID()

    expect(id.toString()).toBe(expectedID)
    // The resolved manifest is {a.txt, b.txt}: a.txt from the base, b.txt added.
    expect(m.entries.map(e => e.name).sort()).toEqual(['a.txt', 'b.txt'])
    // The shape-level readers accept it too: one checkpoint, two sections.
    for (const [name, read] of readers.slice(1)) {
      const r = (await read(text)) as Awaited<ReturnType<typeof decode>>
      expect(r.patchBoundaries.length, name).toBe(1)
      expect(r.sections.length, name).toBe(2)
    }
  })

  it('rejects bad-validator.c4m: a mismatch when resolving, a trailing ID when not', async () => {
    const text = await load('bad-validator.c4m')
    // The resolving decoder verifies the final bare ID as a checkpoint
    // before it reaches end of input, so the mismatch is reported first.
    await expect(Manifest.parse(text)).rejects.toThrow(PatchIDMismatchError)
    // The shape-level readers do not verify; they refuse the trailing ID.
    await expect(decode(text)).rejects.toThrow(TrailingIDError)
    await expect(loads(text)).rejects.toThrow(TrailingIDError)
  })

  it('rejects bad-checkpoint.c4m (interior checkpoint does not match accumulated state)', async () => {
    const text = await load('bad-checkpoint.c4m')
    await expect(Manifest.parse(text)).rejects.toThrow(PatchIDMismatchError)
  })

  it('refuses vector.c4m with its resolved root ID appended, through every reader', async () => {
    // The shape `c4 diff FILE.c4m DIR >> FILE.c4m` wrote through c4 1.0.26.
    const root = (await load('resolved-root-id.txt')).trim()
    const text = (await load('vector.c4m')) + root + '\n'
    const line = text.split('\n').indexOf(root) + 1
    for (const [name, read] of readers) {
      const err = await read(text).then(() => null, (e: unknown) => e)
      expect(err, name).toBeInstanceOf(TrailingIDError)
      expect((err as Error).message, name).toBe(
        `c4m: a bare C4 ID ends the file; a c4m file never ends with its own ID (line ${line}): ` +
          'delete that line, or rewrite the file with `c4 id FILE.c4m > fixed.c4m`',
      )
    }
    // Trailing blank lines do not change the shape, and the error still
    // names the bare ID's own line (the one its hint says to delete), not
    // the line count at end of input.
    for (const [name, read] of readers) {
      const err = await read(text + '\n\n').then(() => null, (e: unknown) => e)
      expect(err, name).toBeInstanceOf(TrailingIDError)
      expect((err as Error).message, name).toContain(`(line ${line}):`)
    }
  })
})

// Shapes around the rule, reusing IDs the vector pins: line 1 is the a.txt
// entry, line 2 the ID of the manifest holding only a.txt.
describe('chain grammar: where a bare C4 ID may stand', () => {
  const parts = async () => {
    const v = (await load('vector.c4m')).split('\n')
    return { aLine: v[0], ckptA: v[1], bLine: v[2] }
  }

  it('accepts consecutive checkpoints followed by a patch', async () => {
    const { aLine, ckptA, bLine } = await parts()
    const stream = `${aLine}\n${ckptA}\n${ckptA}\n${bLine}\n`
    const m = await Manifest.parse(stream)
    expect(m.entries.map(e => e.name).sort()).toEqual(['a.txt', 'b.txt'])
    expect((await m.computeC4ID()).toString()).toBe((await load('resolved-root-id.txt')).trim())
    const r = await decode(stream)
    expect(r.patchBoundaries.length).toBe(2)
  })

  it('refuses consecutive checkpoints at end of input', async () => {
    const { aLine, ckptA } = await parts()
    const stream = `${aLine}\n${ckptA}\n${ckptA}\n`
    for (const [name, read] of readers) {
      await expect(read(stream), name).rejects.toThrow(TrailingIDError)
    }
  })

  it('refuses a single section ending with its own (correct) ID', async () => {
    const { aLine, ckptA } = await parts()
    for (const [name, read] of readers) {
      await expect(read(`${aLine}\n${ckptA}\n`), name).rejects.toThrow(TrailingIDError)
    }
  })

  it('reports a wrong trailing ID as a mismatch when resolving', async () => {
    const { aLine } = await parts()
    // The resolved root ID names {a.txt, b.txt}, never {a.txt} alone.
    const wrong = (await load('resolved-root-id.txt')).trim()
    const stream = `${aLine}\n${wrong}\n`
    await expect(Manifest.parse(stream)).rejects.toThrow(PatchIDMismatchError)
    await expect(decode(stream)).rejects.toThrow(TrailingIDError)
  })

  it('refuses a chain on an external base that ends with a bare ID', async () => {
    // Checkpoints after an external base are not verified here (they defer
    // to the resolver that fetches the base), but the trailing ID is still
    // a format error.
    const { aLine, ckptA, bLine } = await parts()
    const stream = `${ckptA}\n${aLine}\n${ckptA}\n${bLine}\n${ckptA}\n`
    for (const [name, read] of readers) {
      await expect(read(stream), name).rejects.toThrow(TrailingIDError)
    }
    const ok = await Manifest.parse(`${ckptA}\n${aLine}\n${ckptA}\n${bLine}\n`)
    expect(ok.base?.toString()).toBe(ckptA)
  })

  it('keeps a file that is only a first-line base reference', async () => {
    // One bare ID and nothing else is the external base reference (§10.2),
    // not a trailing ID: no entries, base set, as before 2026-11-08.
    const { ckptA } = await parts()
    const m = await Manifest.parse(`${ckptA}\n`)
    expect(m.base?.toString()).toBe(ckptA)
    expect(m.entries).toEqual([])
    const r = await decode(`${ckptA}\n`)
    expect(r.base?.toString()).toBe(ckptA)
    expect(r.patchBoundaries).toEqual([])
  })
})
