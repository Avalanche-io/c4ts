import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { NodeFS, secondOf } from '../src/node-fs.js'
import { scan } from '../../core/src/scanner.js'
import { Manifest } from '../../core/src/manifest.js'
import { diff, patchDiff } from '../../core/src/diff.js'
import { formatTimestamp } from '../../core/src/entry.js'
import { buildVectorTree, readable, vectorRows } from './vector-tree.js'

// The shared sub-second vector (c4 #174 on release/1.0.27, c4m/testdata/subsecond-vector),
// vendored byte for byte under packages/core/tests/fixtures. Its MUST
// rules: a scan of the tree records each mtime floored to its whole second,
// toward negative infinity before 1970, as Go writes it; a diff of the scan
// against its own saved c4m, and against saved.c4m on a platform with
// POSIX modes, is empty; saved.c4m resolves to root-id.txt.
//
// Node's utimes takes a float of seconds, which cannot hold these times
// (1750000002.999999999 is 1750000003.0 as a double) and treats a negative
// number as "now", so the tree is built with the platform's own tool:
// touch -d with nanoseconds on POSIX, and on Windows .NET's 100 ns ticks,
// which NTFS keeps and which move none of the vector's times across a
// second.

const dir = fileURLToPath(new URL('../../core/tests/fixtures/subsecond-vector/', import.meta.url))
const load = (name: string) => readFile(dir + name, 'utf8')
const win = process.platform === 'win32'
const rows = () => vectorRows(dir)

let tmpDir: string

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
})

async function build(): Promise<string> {
  tmpDir = await mkdtemp(join(tmpdir(), 'c4ts-subsecond-'))
  const tree = join(tmpDir, 'tree')
  await mkdir(tree)
  await buildVectorTree(dir, tree)
  return tree
}

/** Each path's timestamp field, for the rows whose times Node reads back. */
async function times(m: Iterable<[string, { timestamp: Date }]>): Promise<Map<string, string>> {
  const keep = new Set((await rows()).filter(r => readable(r.ns)).map(r => r.path))
  const out = new Map<string, string>()
  for (const [path, e] of m) if (keep.has(path)) out.set(path, formatTimestamp(e.timestamp))
  return out
}

describe('sub-second vector', { timeout: 30_000 }, () => {
  it('a scan records each mtime floored to its second, as saved.c4m shows', async () => {
    const got = await times(await scan(new NodeFS(), await build()))
    expect(got).toEqual(await times(await Manifest.parse(await load('saved.c4m'))))
    expect(got.get('b.txt')).toBe('2025-06-15T15:06:40Z')
    expect(got.get('src/')).toBe('2025-06-15T15:06:42Z')
  })

  it.skipIf(win)('before 1970 the scan floors toward negative infinity', async () => {
    const got = await times(await scan(new NodeFS(), await build()))
    expect(got.get('pre-half.txt')).toBe('1969-12-31T23:59:58Z')
    expect(got.get('pre-round.txt')).toBe('1969-12-31T23:59:58Z')
  })

  it('a diff of the scan against its own saved c4m is empty', async () => {
    const m = await scan(new NodeFS(), await build())
    const saved = await Manifest.parse(m.encode())
    const d = diff(saved, m)
    expect([d.added, d.removed, d.modified]).toEqual([[], [], []])
    expect((await patchDiff(saved, m)).patch.entries).toEqual([])
  })

  // Windows observes no POSIX modes, so the scan's lines differ from
  // saved.c4m there by mode alone (the vector's README, rule 2).
  it.skipIf(win)('the scan is saved.c4m byte for byte, a diff against it is empty, and it resolves to root-id.txt', async () => {
    const m = await scan(new NodeFS(), await build())
    const saved = await Manifest.parse(await load('saved.c4m'))
    expect(m.encode()).toBe(await load('saved.c4m'))
    const d = diff(saved, m)
    expect([d.added, d.removed, d.modified]).toEqual([[], [], []])
    expect((await patchDiff(saved, m)).patch.entries).toEqual([])
    expect((await m.computeC4ID()).toString()).toBe((await load('root-id.txt')).trim())
  })

  it('saved.c4m resolves to root-id.txt', async () => {
    const saved = await Manifest.parse(await load('saved.c4m'))
    expect((await saved.computeC4ID()).toString()).toBe((await load('root-id.txt')).trim())
  })
})

describe('secondOf', () => {
  // Every time in tree.txt, plus the edges of a second on both sides of 1970.
  it.each([
    [1_750_000_000_500_000_000n, '2025-06-15T15:06:40Z'],
    [1_750_000_000_999_999_700n, '2025-06-15T15:06:40Z'],
    [1_750_000_002_999_999_999n, '2025-06-15T15:06:42Z'],
    [1_750_000_001_123_456_789n, '2025-06-15T15:06:41Z'],
    [-1_500_000_000n, '1969-12-31T23:59:58Z'],
    [-1_000_000_300n, '1969-12-31T23:59:58Z'],
    [-1_000_000_000n, '1969-12-31T23:59:59Z'],
    [-999_999_700n, '1969-12-31T23:59:59Z'],
    [-1n, '1969-12-31T23:59:59Z'],
  ])('%s ns is %s', (ns, want) => {
    expect(formatTimestamp(secondOf(ns))).toBe(want)
  })
})
