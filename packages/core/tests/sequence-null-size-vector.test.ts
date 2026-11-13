import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Manifest } from '../src/manifest.js'
import { encode } from '../src/encoder.js'
import { sizeIsNull, NULL_SIZE } from '../src/entry.js'

// Cross-implementation vector: a folded sequence with a null-size frame
// (2026-11-13). The shared conformance contract lives in the Go reference
// repo at c4m/testdata/sequence-null-size-vector, from c4 commit 7a6ba94
// (#156); the files under fixtures/sequence-null-size-vector/ here are
// byte-identical copies.
//
// The rule (SPECIFICATION.md "Media File Sequences"; c4 #155): a folded
// sequence's size is the sum of its frames' sizes, and null if any frame's
// size is null, whether written - or as a 0 beside a C4 ID other than the
// empty content's (sizeIsNull). Ruled 2026-11-13 by the maintainer: "One
// cannot use size as an expectation if there are nulls present, so we
// must say nothing." Decided for the ports 2026-11-13 by the release lead;
// reversible.
//
// c4ts does not fold sequences (it has no sequence detector; the decoder
// only marks a range as a sequence), so this tests the decode half only:
// folded.c4m decodes to folded-root-id.txt with the plate range's size
// known and the shot range's null, and re-encodes to itself byte for byte.
// The folding half, frames*.c4m to folded.c4m, applies to a port that
// folds.

const dir = fileURLToPath(new URL('./fixtures/sequence-null-size-vector/', import.meta.url))
const load = (name: string) => readFile(dir + name, 'utf8')

describe('sequence null-size vector (decode half; c4ts does not fold)', () => {
  it('folded.c4m decodes to folded-root-id.txt, plate known 24, shot null, and re-encodes to itself', async () => {
    const text = await load('folded.c4m')
    const m = await Manifest.parse(text)

    expect((await m.computeC4ID()).toString()).toBe((await load('folded-root-id.txt')).trim())

    const plate = m.entries.find(e => e.name === 'plate.[1001-1004].exr')!
    const shot = m.entries.find(e => e.name === 'shot.[1001-1004].exr')!
    expect(plate.isSequence).toBe(true)
    expect(shot.isSequence).toBe(true)
    expect(sizeIsNull(plate)).toBe(false)
    expect(plate.size).toBe(24)
    expect(sizeIsNull(shot)).toBe(true)
    expect(shot.size).toBe(NULL_SIZE)

    expect(encode(m)).toBe(text)
  })
})
