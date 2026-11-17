import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

// The Go reference CLI: C4_BIN, else the first c4 on PATH, if it is 1.1 or
// later (on 1.0.x `c4 id -q` prints nothing and `c4 patch -` reads no
// stdin). CI installs a pinned c4 master on every leg, and
// scripts/allowed-skips.txt names where this may skip, so it cannot skip
// there unnoticed.
export function findGoC4(): string | undefined {
  const c4 = lookPath()
  if (c4 === undefined) return undefined
  const dir = mkdtempSync(join(tmpdir(), 'c4ts-go-c4-'))
  try {
    const out = execFileSync(c4, ['id', '-q', dir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, HOME: dir, USERPROFILE: dir, C4_STORE: join(dir, 'store') },
    })
    return /^c4[1-9A-HJ-NP-Za-km-z]{88}$/.test(out.trim()) ? c4 : undefined
  } catch {
    return undefined
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function lookPath(): string | undefined {
  if (process.env.C4_BIN) return process.env.C4_BIN
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE').split(delimiter) : ['']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    for (const ext of exts) {
      const p = join(dir, 'c4' + ext)
      if (existsSync(p) && statSync(p).isFile()) return p
    }
  }
  return undefined
}
