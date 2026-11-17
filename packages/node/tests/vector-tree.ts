import { readFile, writeFile, mkdir, chmod, stat } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { basename, join } from 'node:path'
import { expect } from 'vitest'

// Build a shared vector's tree from its tree.txt (core's vector READMEs):
// "<octal mode> <mtime ns> <path>" per line, a path ending in "/" is a
// directory, a file's bytes are its base name and a newline; modes and
// times are set files first, then directories deepest first.
//
// Node's utimes takes a float of seconds, which cannot hold these times
// (1750000002.999999999 is 1750000003.0 as a double) and treats a negative
// number as "now", so times are set with the platform's own tool: touch -d
// with nanoseconds on POSIX, and on Windows .NET's 100 ns ticks, which NTFS
// keeps and which move none of the vectors' times across a second.

const win = process.platform === 'win32'

export interface Row { mode: number; ns: bigint; path: string }

export async function vectorRows(vector: string): Promise<Row[]> {
  return (await readFile(join(vector, 'tree.txt'), 'utf8')).split('\n').filter(l => l !== '').map(l => {
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
export function held(ns: bigint): bigint {
  return win ? floorDiv(ns, 100n) * 100n : ns
}

/**
 * Whether Node reads the time back. On Windows it reads a pre-1970 mtime
 * 2^32 seconds late, in both stat forms (measured on windows-latest:
 * pre-half.txt's −1.5 s, set and held by NTFS, reads as mtimeNs
 * 4294967294500000000, mtimeMs 4294967294500, 2106-02-07). A genuine time
 * from 2038 to 2106 reads the same way, so no scanner can undo it, and
 * there the pre-1970 rows are not checked.
 */
export function readable(ns: bigint): boolean {
  return !(win && ns < 0n)
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

/** Build the vector's tree under tree (which must exist), and check it holds the vector's times. */
export async function buildVectorTree(vector: string, tree: string): Promise<void> {
  const all = await vectorRows(vector)
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
  // The tree holds the vector's times, or the test proves nothing.
  for (const r of all.filter(r => readable(r.ns))) {
    expect((await stat(join(tree, r.path), { bigint: true })).mtimeNs, r.path).toBe(held(r.ns))
  }
}
