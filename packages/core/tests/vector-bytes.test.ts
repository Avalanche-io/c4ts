import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Manifest } from '../src/manifest.js'
import { encode } from '../src/encoder.js'

// Round trip over every shared vector this port vendors (2026-11-13; c4
// #158 at 7cdc9f3). A c4m file's byte ID is a C4 ID, so a decode and
// canonical re-encode that changes a byte writes a different file; nothing
// compared bytes before, which is how such a loss could go unseen.
//
// Each vector's README carries a "## Round trip" table, the one statement
// every implementation reads (Go's TestVectorRoundTrip reads the same
// table). For each .c4m file, decoded and then encoded canonically, the
// second cell says what comes out, compared by SHA-512 from node:crypto,
// never c4ts's own C4 ID code:
// - `itself`: the output is the file, byte for byte;
// - a backticked file: the output is that file (the canonical partner);
// - `ID in` a backticked file: a chain whose resolved state has that ID;
// - `refused`: decoding fails.
// Any other cell fails. Every vendored .c4m must be named by exactly one
// row (a glob row such as `*/*.c4m` counts); a row naming a file this port
// does not vendor is ignored.
//
// One file is treated differently from its row, as its README states:
// safename-vector/names.c4m holds names that are not UTF-8, which a
// JavaScript string cannot hold exactly, so c4ts refuses it on decode
// rather than replace a name (1.x). The test asserts that refusal, naming
// the first such line, and checks that every other line round-trips.

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

// The lines of names.c4m whose raw names are not UTF-8, by the raw bytes
// cases.txt gives in hex (label, hex, name field as Go writes it).
function nonUTF8Lines(dir: string, names: string): number[] {
  const strict = new TextDecoder('utf-8', { fatal: true })
  const bad = new Set<string>()
  for (const line of readFileSync(join(dir, 'cases.txt'), 'utf8').split('\n')) {
    const [, hex, field] = line.split(' ')
    if (!hex || !field) continue
    try {
      strict.decode(Buffer.from(hex, 'hex'))
    } catch {
      bad.add(field)
    }
  }
  return names.split('\n').flatMap((l, i) => [...bad].some(f => l.includes(` ${f} `)) ? [i + 1] : [])
}

const dirs = readdirSync(fixtures).filter(d => statSync(join(fixtures, d)).isDirectory() && walk(join(fixtures, d)).length > 0).sort()

describe('every shared vector file round-trips as its README table says', () => {
  it('finds the vendored vectors', () => {
    expect(dirs.length).toBeGreaterThan(10)
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
      const title = `${d}/${f}` === 'safename-vector/names.c4m'
        ? `${d}/${f} is refused at its first name that is not UTF-8, and its other lines re-encode to themselves (README)`
        : `${d}/${f} re-encodes to ${row?.cell ?? '(no row)'}`
      it(title, async () => {
        expect(row).toBeDefined()
        const bytes = readFileSync(join(dir, f))
        const text = bytes.toString('utf8')

        if (`${d}/${f}` === 'safename-vector/names.c4m') {
          const bad = nonUTF8Lines(dir, text)
          expect(bad.length).toBeGreaterThan(0)
          await expect(Manifest.parse(text)).rejects.toThrow(`line ${bad[0]}:`)
          const kept = text.split('\n').filter((_, i) => !bad.includes(i + 1)).join('\n')
          const keptBytes = new TextEncoder().encode(kept)
          expect(sha512(await reencode(kept))).toBe(sha512(keptBytes))
          return
        }

        const e = row!.expect
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
