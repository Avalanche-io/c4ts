import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Manifest } from '../src/manifest.js'
import { encode } from '../src/encoder.js'

// Byte identity over every shared vector this port vendors (2026-11-13).
// A c4m file's byte ID is a C4 ID, so a decode and canonical re-encode
// that changes a byte writes a different file: nothing compared bytes
// before, which is how such a loss could go unseen. Each .c4m under
// fixtures/ is decoded and re-encoded canonically, and the SHA-512 of the
// output is compared with the input's using node:crypto, never c4ts's own
// C4 ID code.
//
// Every file is classified below, and an unclassified file fails, so a
// newly vendored vector cannot be passed over silently. The classes follow
// the Go reference's measurement on c4 7a6ba94 (#156):
// - stable: written canonically by the library; byte identity MUST hold.
// - noncanonical: decodes, but is not canonical text by design (the
//   vector's README says why); its re-encoding must differ, or this table
//   is stale.
// - rejected: refused on decode by design.

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))

type Class =
  | { kind: 'stable' }
  | { kind: 'noncanonical'; why: string }
  | { kind: 'rejected'; why: string }

const noncanonical: Record<string, string> = {
  'backslash-name-vector/pretty.c4m': 'pretty form (README: "the Go encoder, pretty form")',
  'link-target-vector/pretty.c4m': 'pretty form (README: "the Go encoder, pretty form")',
  'zero-null-vector/pretty.c4m': 'pretty form',
  'null-size-vector/zero-spelled.c4m': 'a null size spelled 0 (README: "canonical.c4m with the size field of every - line rewritten to 0")',
  'sequence-null-size-vector/frames-zero-spelled.c4m': 'a null size spelled 0 (README: "frames.c4m with the null size field rewritten to 0")',
  'legacy/ten-dash-null-1.0.21.c4m': 'legacy null mode: a real file written by c4 1.0.21 in pretty form',
  'chain-vector/vector.c4m': 'a patch chain, which decodes to the resolved state',
  'deepen-vector/deepen.c4m': 'a patch chain, which decodes to the resolved state',
  'deepen-vector/remove.c4m': 'a patch chain, which decodes to the resolved state',
  'name-escape-vector/ok-indent-3.c4m': 'non-canonical indent (README: written with SetIndent(3); canonical output always indents by 2)',
}

function classify(rel: string): Class | undefined {
  const [dir, file] = [rel.slice(0, rel.lastIndexOf('/')), rel.slice(rel.lastIndexOf('/') + 1)]
  if (rel in noncanonical) return { kind: 'noncanonical', why: noncanonical[rel] }
  if (rel === 'safename-vector/names.c4m') {
    // Go round-trips this file byte for byte; c4ts refuses it on decode by
    // design: it holds names whose bytes are not UTF-8, which a JavaScript
    // string cannot hold exactly, and c4ts refuses a name rather than
    // replace it (safename-vector.test.ts).
    return { kind: 'rejected', why: 'names that are not UTF-8, which c4ts refuses rather than replace (Go round-trips it)' }
  }
  if (dir === 'chain-vector' && file.startsWith('bad-')) return { kind: 'rejected', why: 'a checkpoint that does not match' }
  if (dir === 'damaged-line-vector' && file !== 'ok.c4m') return { kind: 'rejected', why: 'a damaged line' }
  if (dir === 'name-escape-vector' && (file.startsWith('file-') || file === 'dir-unescaped-space.c4m')) {
    return { kind: 'rejected', why: 'a name that is not escaped' }
  }
  if (dir === 'name-rule-vector' && !file.startsWith('ok-')) return { kind: 'rejected', why: 'a name that is a path' }
  const stable = new Set([
    'apply-from-vector/metadata-only/base.c4m',
    'apply-from-vector/metadata-only/expected.c4m',
    'apply-from-vector/metadata-only/patch.c4m',
    'backslash-name-vector/canonical.c4m',
    'backslash-name-vector/patch.c4m',
    'childless-dir-vector/normalized.c4m',
    'childless-dir-vector/stated.c4m',
    'damaged-line-vector/ok.c4m',
    'link-target-vector/canonical.c4m',
    'link-target-vector/patch.c4m',
    'name-escape-vector/ok-dir.c4m',
    'name-escape-vector/ok-escaped.c4m',
    'name-escape-vector/ok-file.c4m',
    'name-rule-vector/ok-dir.c4m',
    'name-rule-vector/ok-file.c4m',
    'null-size-vector/canonical.c4m',
    'sequence-null-size-vector/folded.c4m',
    'sequence-null-size-vector/frames.c4m',
    'zero-null-vector/canonical.c4m',
  ])
  return stable.has(rel) ? { kind: 'stable' } : undefined
}

const walk = (d: string): string[] => readdirSync(d).flatMap(n => {
  const p = join(d, n)
  return statSync(p).isDirectory() ? walk(p) : p.endsWith('.c4m') ? [p] : []
})
const sha512 = (b: Uint8Array) => createHash('sha512').update(b).digest('hex')
const files = walk(fixtures).map(p => relative(fixtures, p).split('\\').join('/')).sort()

describe('every shared vector file re-encodes as its class says', () => {
  it('finds the vendored vectors', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  for (const rel of files) {
    const c = classify(rel)
    const why = c && c.kind !== 'stable' ? `: ${c.why}` : ''
    it(`${rel} is ${c?.kind ?? 'unclassified'}${why}`, async () => {
      expect(c, `${rel} is not classified in vector-bytes.test.ts`).toBeDefined()
      const bytes = readFileSync(join(fixtures, rel))
      const text = bytes.toString('utf8')
      if (c!.kind === 'rejected') {
        await expect(Manifest.parse(text)).rejects.toThrow()
        return
      }
      const out = new TextEncoder().encode(encode(await Manifest.parse(text)))
      if (c!.kind === 'stable') expect(sha512(out)).toBe(sha512(bytes))
      else expect(sha512(out)).not.toBe(sha512(bytes))
    })
  }
})
