import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { NodeFS } from '../src/node-fs.js'
import { scan } from '../../core/src/scanner.js'
import { Manifest } from '../../core/src/manifest.js'
import { buildVectorTree } from './vector-tree.js'

// The shared epoch-second vector (c4 #192, c4m/testdata/epoch-second-vector),
// vendored byte for byte under packages/core/tests/fixtures. A time inside
// the epoch second is null, so half.txt (0.5 s) and sub/in.txt (0.25 s) are
// written "-"; the scan's description ID is its own c4m's, and on a
// platform with POSIX modes the scan is saved.c4m and resolves to
// root-id.txt.

const dir = fileURLToPath(new URL('../../core/tests/fixtures/epoch-second-vector/', import.meta.url))
const load = (name: string) => readFile(dir + name, 'utf8')
const win = process.platform === 'win32'

let tmpDir: string

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
})

async function scanned(): Promise<Manifest> {
  tmpDir = await mkdtemp(join(tmpdir(), 'c4ts-epoch-'))
  const tree = join(tmpDir, 'tree')
  await mkdir(tree)
  await buildVectorTree(dir, tree)
  return scan(new NodeFS(), tree)
}

function field(text: string, name: string): string {
  for (const line of text.split('\n')) {
    const f = line.trim().split(/ +/)
    if (f[3] === name) return f[1]
  }
  throw new Error(`no line for ${name}`)
}

describe('epoch-second vector', { timeout: 30_000 }, () => {
  it('a scan writes the times inside the epoch second as "-" and has its own c4m\'s ID', async () => {
    const m = await scanned()
    const text = m.encode()
    expect(field(text, 'half.txt')).toBe('-')
    expect(field(text, 'in.txt')).toBe('-')
    expect(field(text, 'one.txt')).toBe('1970-01-01T00:00:01Z')
    const again = await Manifest.parse(text)
    expect((await m.computeC4ID()).toString()).toBe((await again.computeC4ID()).toString())
  })

  // Windows observes no POSIX modes, and Node there reads pre.txt's
  // −0.5 s 2^32 seconds late (see vector-tree.ts), so the scan differs from
  // saved.c4m by mode and by that row.
  it.skipIf(win)('the scan is saved.c4m byte for byte and resolves to root-id.txt', async () => {
    const m = await scanned()
    expect(m.encode()).toBe(await load('saved.c4m'))
    expect((await m.computeC4ID()).toString()).toBe((await load('root-id.txt')).trim())
  })

  it('saved.c4m resolves to root-id.txt', async () => {
    const saved = await Manifest.parse(await load('saved.c4m'))
    expect((await saved.computeC4ID()).toString()).toBe((await load('root-id.txt')).trim())
  })
})
