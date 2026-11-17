import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir, chmod, stat } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { NodeFS, secondOf } from '../src/node-fs.js'
import { scan } from '../../core/src/scanner.js'
import { Manifest } from '../../core/src/manifest.js'
import { diff, patchDiff } from '../../core/src/diff.js'
import { formatTimestamp } from '../../core/src/entry.js'

// The shared sub-second vector (c4 #173, c4m/testdata/subsecond-vector),
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

interface Row { mode: number; ns: bigint; path: string }

async function rows(): Promise<Row[]> {
  return (await load('tree.txt')).split('\n').filter(l => l !== '').map(l => {
    const [mode, ns, ...rest] = l.split(' ')
    return { mode: parseInt(mode, 8), ns: BigInt(ns), path: rest.join(' ') }
  })
}

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b
  return a % b < 0n ? q - 1n : q
}

/** The instant as ISO 8601 with nanoseconds: the floored second plus a non-negative fraction. */
function isoNs(ns: bigint): string {
  const s = floorDiv(ns, 1_000_000_000n)
  const frac = (ns - s * 1_000_000_000n).toString().padStart(9, '0')
  return new Date(Number(s) * 1000).toISOString().slice(0, 19) + '.' + frac + 'Z'
}

/** What the platform can hold: nanoseconds, or NTFS's 100 ns ticks. */
function held(ns: bigint): bigint {
  return win ? floorDiv(ns, 100n) * 100n : ns
}

/** Set each path's mtime, in order: one touch per path on POSIX, one PowerShell run on Windows. */
function setMtimes(list: Array<{ path: string; ns: bigint; isDir: boolean }>): void {
  if (win) {
    const lines = list.map(({ path, ns, isDir }) => {
      const ticks = 621_355_968_000_000_000n + floorDiv(ns, 100n)
      const cls = isDir ? 'Directory' : 'File'
      return `[System.IO.${cls}]::SetLastWriteTimeUtc('${path}', [DateTime]::new(${ticks}, [DateTimeKind]::Utc))`
    })
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', lines.join('; ')])
    return
  }
  for (const { path, ns } of list) execFileSync('touch', ['-m', '-d', isoNs(ns), path])
}

let tmpDir: string

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
})

/** Build tree.txt's tree: paths, then modes and times, files first and then directories deepest first. */
async function build(): Promise<string> {
  tmpDir = await mkdtemp(join(tmpdir(), 'c4ts-subsecond-'))
  const tree = join(tmpDir, 'tree')
  await mkdir(tree)
  const all = await rows()
  for (const r of all) {
    const p = join(tree, r.path)
    if (r.path.endsWith('/')) await mkdir(p, { recursive: true })
    else await writeFile(p, basename(r.path) + '\n')
  }
  const files = all.filter(r => !r.path.endsWith('/'))
  const dirs = all.filter(r => r.path.endsWith('/'))
    .sort((a, b) => b.path.split('/').length - a.path.split('/').length)
  for (const r of [...files, ...dirs]) await chmod(join(tree, r.path), r.mode)
  setMtimes([...files, ...dirs].map(r => ({ path: join(tree, r.path), ns: r.ns, isDir: r.path.endsWith('/') })))
  if (win) {
    const seen: string[] = []
    for (const r of all) {
      const p = join(tree, r.path)
      seen.push(`${r.path}: want ${held(r.ns)} bigint ${(await stat(p, { bigint: true })).mtimeNs} mtimeMs ${(await stat(p)).mtimeMs}`)
    }
    console.log('sub-second vector tree on win32:\n' + seen.join('\n'))
  }
  // The tree holds the vector's times, or the test proves nothing.
  for (const r of all) {
    expect((await stat(join(tree, r.path), { bigint: true })).mtimeNs, r.path).toBe(held(r.ns))
  }
  return tree
}

describe('sub-second vector', { timeout: 30_000 }, () => {
  it('a scan records each mtime floored to its second, as saved.c4m shows', async () => {
    const tree = await build()
    const want = new Map<string, string>()
    for (const [path, e] of await Manifest.parse(await load('saved.c4m'))) want.set(path, formatTimestamp(e.timestamp))
    const got = new Map<string, string>()
    for (const [path, e] of await scan(new NodeFS(), tree)) got.set(path, formatTimestamp(e.timestamp))
    expect(got).toEqual(want)
    expect(got.get('b.txt')).toBe('2025-06-15T15:06:40Z')
    expect(got.get('src/')).toBe('2025-06-15T15:06:42Z')
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

  // Measured with Go master 5efd481: a file at 1970-01-01T00:00:00.5Z is
  // written `-`, the null the epoch second reads back as.
  it('a time in the epoch second is the epoch, as Go master writes it', () => {
    expect(secondOf(500_000_000n).getTime()).toBe(0)
    expect(secondOf(999_999_999n).getTime()).toBe(0)
  })
})
