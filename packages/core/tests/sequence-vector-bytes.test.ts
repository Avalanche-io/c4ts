import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Manifest } from '../src/manifest.js'
import { encode } from '../src/encoder.js'

// Round trip over the shared sequence vectors this line vendors
// (2026-11-16, for suite 1.0.27). A c4m file's byte ID is a C4 ID, so a
// decode and canonical re-encode that changes a byte writes a different
// file. This is main's vector-bytes test (c4 #158), scoped on the 1.0.27
// line to the three sequence vectors: those vectors' READMEs carry a
// "## Round trip" table, and the other vectors vendored here are this
// line's copies, whose READMEs carry none.
//
// For each .c4m file, decoded and then encoded canonically, the table's
// second cell says what comes out, compared by SHA-512 from node:crypto,
// never c4ts's own C4 ID code:
// - `itself`: the output is the file, byte for byte;
// - a backticked file: the output is that file (the canonical partner);
// - `ID in` a backticked file: a chain whose resolved state has that ID;
// - `refused`: decoding fails.
// Any other cell fails. Every vendored .c4m must be named by exactly one
// row.
//
// Three rows state 1.1 rules this line does not have; LINE replaces them
// with what the Go library on core's release/1.0.27 writes, as
// fixtures/line-1.0.27/README.md records. The vectors themselves are
// master's, byte for byte.

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))

type Expect =
  | { kind: 'itself' }
  | { kind: 'file'; file: string }
  | { kind: 'id'; file: string }
  | { kind: 'refused' }

interface Row { pattern: string; cell: string; expect: Expect }

// rows reads a README's "## Round trip" table.
function rows(readme: string): Row[] {
  const lines = readme.split(/\r?\n/)
  const start = lines.findIndex(l => l.trim() === '## Round trip')
  if (start < 0) throw new Error('no "## Round trip" section')
  const out: Row[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break
    if (!line.startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map(c => c.trim())
    if (cells[0] === 'File' || /^-+$/.test(cells[0])) continue
    const name = /^`([^`]+)`$/.exec(cells[0])
    if (cells.length !== 2 || !name) throw new Error(`malformed row: ${line}`)
    out.push({ pattern: name[1], cell: cells[1], expect: parseCell(cells[1]) })
  }
  if (out.length === 0) throw new Error('an empty "## Round trip" table')
  return out
}

function parseCell(cell: string): Expect {
  if (cell === 'itself') return { kind: 'itself' }
  if (cell === 'refused') return { kind: 'refused' }
  let m = /^`([^`]+)`$/.exec(cell)
  if (m) return { kind: 'file', file: m[1] }
  m = /^ID in `([^`]+)`$/.exec(cell)
  if (m) return { kind: 'id', file: m[1] }
  throw new Error(`unknown round-trip cell: ${cell}`)
}

// matches reports whether a row's pattern names rel (a path inside the
// vector directory); "*" matches within one path segment.
function matches(pattern: string, rel: string): boolean {
  const re = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
  return new RegExp(`^${re}$`).test(rel)
}

const walk = (d: string): string[] => readdirSync(d).flatMap(n => {
  const p = join(d, n)
  return statSync(p).isDirectory() ? walk(p) : p.endsWith('.c4m') ? [p] : []
})
const rel = (from: string, p: string) => relative(from, p).split('\\').join('/')
const sha512 = (b: Uint8Array) => createHash('sha512').update(b).digest('hex')
const reencode = async (text: string) => new TextEncoder().encode(encode(await Manifest.parse(text)))

const dirs = ['range-data-vector', 'sequence-null-size-vector', 'sequence-size-vector']

const LINE: Record<string, Expect> = {
  // 1.0.x drops an external base line on re-encode (keeping it is c4 #145, 1.1).
  'range-data-vector/add.c4m': { kind: 'file', file: '../line-1.0.27/range-data-vector/add.c4m' },
  'range-data-vector/remove.c4m': { kind: 'file', file: '../line-1.0.27/range-data-vector/remove.c4m' },
  // On 1.0.x a 0 beside a non-empty C4 ID is a known 0 (null is c4 #68, 1.1).
  'sequence-null-size-vector/frames-zero-spelled.c4m': { kind: 'itself' },
}

describe('every shared sequence vector file round-trips as its README table says', () => {
  it('finds the vendored sequence vectors', () => {
    for (const d of dirs) expect(walk(join(fixtures, d)).length, d).toBeGreaterThan(0)
  })

  for (const d of dirs) {
    const dir = join(fixtures, d)
    const readme = join(dir, 'README.md')
    const table = existsSync(readme) ? rows(readFileSync(readme, 'utf8')) : []

    it(`${d}/README.md has a round-trip table naming each vendored file once`, () => {
      expect(table.length, `${d}/README.md has no round-trip table`).toBeGreaterThan(0)
      for (const f of walk(dir).map(p => rel(dir, p))) {
        expect(table.filter(r => matches(r.pattern, f)).map(r => r.pattern), `${d}/${f}`).toHaveLength(1)
      }
    })

    for (const f of walk(dir).map(p => rel(dir, p)).sort()) {
      const row = table.find(r => matches(r.pattern, f))
      const line = LINE[`${d}/${f}`]
      const cell = line ? `${line.kind === 'itself' ? 'itself' : '`' + (line as { file: string }).file + '`'} on this line` : row?.cell ?? '(no row)'
      it(`${d}/${f} re-encodes to ${cell}`, async () => {
        expect(row).toBeDefined()
        const bytes = readFileSync(join(dir, f))
        const text = bytes.toString('utf8')

        const e = line ?? row!.expect
        switch (e.kind) {
          case 'refused':
            await expect(Manifest.parse(text)).rejects.toThrow()
            return
          case 'itself':
            expect(sha512(await reencode(text))).toBe(sha512(bytes))
            return
          case 'file':
            expect(sha512(await reencode(text))).toBe(sha512(readFileSync(join(dir, e.file))))
            return
          case 'id': {
            const want = readFileSync(join(dir, e.file), 'utf8').trim()
            expect((await (await Manifest.parse(text)).computeC4ID()).toString()).toBe(want)
            return
          }
        }
      })
    }
  }
})
