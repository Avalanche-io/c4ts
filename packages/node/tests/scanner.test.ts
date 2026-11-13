import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, utimes, chmod, stat } from 'node:fs/promises'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { NodeFS } from '../src/node-fs.js'
import { scan } from '../../core/src/scanner.js'

let tmpDir: string

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true })
  }
})

describe('scan empty directories', () => {
  it('empty leaf directory has size 0', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'c4ts-scan-'))
    await mkdir(join(tmpDir, 'empty'))
    await writeFile(join(tmpDir, 'hello.txt'), 'hello')

    const fs = new NodeFS()
    const m = await scan(fs, tmpDir, { computeIds: true, skipHidden: true })

    const emptyDir = m.entries.find(e => e.name === 'empty/')
    expect(emptyDir).toBeDefined()
    expect(emptyDir!.size).toBe(0)
  })

  it('nested empty directory has size 0', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'c4ts-scan-'))
    await mkdir(join(tmpDir, 'parent'))
    await mkdir(join(tmpDir, 'parent', 'empty'))
    await writeFile(join(tmpDir, 'parent', 'file.txt'), 'data')

    const fs = new NodeFS()
    const m = await scan(fs, tmpDir, { computeIds: true, skipHidden: true })

    const emptyDir = m.entries.find(e => e.name === 'empty/')
    expect(emptyDir).toBeDefined()
    expect(emptyDir!.size).toBe(0)
  })

  it('directory containing only an empty subdirectory has non-negative size', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'c4ts-scan-'))
    await mkdir(join(tmpDir, 'parent'))
    await mkdir(join(tmpDir, 'parent', 'empty'))

    const fs = new NodeFS()
    const m = await scan(fs, tmpDir, { computeIds: true, skipHidden: true })

    const parentDir = m.entries.find(e => e.name === 'parent/')
    const emptyDir = m.entries.find(e => e.name === 'empty/')
    expect(emptyDir).toBeDefined()
    expect(emptyDir!.size).toBe(0)
    expect(parentDir).toBeDefined()
    expect(parentDir!.size).toBeGreaterThanOrEqual(0)
  })
})

// The Go reference CLI: C4_BIN, else the first c4 on PATH, if it is 1.1 or
// later (on 1.0.x `c4 id -q` prints nothing and `c4 patch -` reads no
// stdin). CI installs a pinned c4 master on every leg, and
// scripts/allowed-skips.txt names where this may skip, so it cannot skip
// there unnoticed.
function findGoC4(): string | undefined {
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
const GO_C4 = findGoC4()
const hasGoC4 = GO_C4 !== undefined

describe('scan matches the Go CLI byte for byte', () => {
  it.skipIf(!hasGoC4)('c4 id <tree> | c4 patch - and scan()+encode() produce identical text and one description ID', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'c4ts-scan-go-'))
    const tree = join(tmpDir, 'tree')
    const home = join(tmpDir, 'home')
    await mkdir(join(tree, 'docs'), { recursive: true })
    await mkdir(join(tree, 'x', 'y', 'z'), { recursive: true })
    await mkdir(join(tree, 'empty'), { recursive: true })
    await mkdir(join(tree, 'two', 'a'), { recursive: true })
    await mkdir(join(tree, 'two', 'b'), { recursive: true })
    await mkdir(home, { recursive: true })
    await writeFile(join(tree, 'root.txt'), 'hello\n')
    await writeFile(join(tree, 'README'), 'r')
    await writeFile(join(tree, 'docs', 'a.md'), 'a\n')
    await writeFile(join(tree, 'docs', 'b.md'), 'b\n')
    await writeFile(join(tree, 'x', 'm.txt'), 'm\n')
    await writeFile(join(tree, 'x', 'y', 'z', 'f.txt'), 'f\n')
    await writeFile(join(tree, 'two', 'a', '1.txt'), 'aa\n')
    await writeFile(join(tree, 'two', 'b', '2.txt'), 'bb\n')
    // A directory older than its children, and a file newer than its directory:
    // a directory's timestamp is its own mtime, not derived from its children.
    const old = new Date('2020-01-01T00:00:00Z')
    const future = new Date('2030-01-01T00:00:00Z')
    await utimes(join(tree, 'docs'), old, old)
    await utimes(join(tree, 'empty'), old, old)
    await utimes(join(tree, 'x', 'm.txt'), future, future)
    // A read-only file: on Windows chmod 0o444 sets the read-only
    // attribute, the one permission Windows has, and the mode both sides
    // read from it must agree.
    const ro = join(tree, 'two', 'a', 'ro.txt')
    await writeFile(ro, 'ro\n')
    await chmod(ro, 0o444)
    expect((await stat(ro)).mode & 0o222).toBe(0)

    // c4 1.1 streams a directory scan as a chain (aggregates null, then a
    // refinement patch); `c4 patch -` flattens it to the one plain c4m that
    // c4ts writes, and `c4 id -q` names the description both resolve to.
    const opts = {
      encoding: 'utf8' as const,
      env: { ...process.env, HOME: home, USERPROFILE: home, C4_STORE: join(home, 'store') },
    }
    const chain = execFileSync(GO_C4!, ['id', tree], opts)
    const goText = execFileSync(GO_C4!, ['patch', '-'], { ...opts, input: chain })
    const goID = execFileSync(GO_C4!, ['id', '-q', tree], opts).trim()
    const m = await scan(new NodeFS(), tree)
    // Windows will not remove a read-only file.
    await chmod(ro, 0o644)
    expect(m.encode()).toBe(goText)
    expect(goText.split('\n').filter(l => l !== '').length).toBe(17)
    expect((await m.computeC4ID()).toString()).toBe(goID)
  })
})
