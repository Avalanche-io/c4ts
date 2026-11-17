import { describe, it, expect, afterEach } from 'vitest'
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { TreeStore, foldVariants } from '../src/tree-store.js'
import { identifyBytes, parse as parseC4ID } from '../../core/src/id.js'
import { streamToBytes } from '../../core/src/filesystem.js'
import { ContentNotFoundError } from '../../core/src/store.js'

// c4ts's TreeStore writes Go's store.TreeStore layout (c4 release/1.0.27,
// #172) and reads both it and the layout c4ts wrote through 1.0.26, `c4/<the ID's
// last 88 characters>`, which neither the c4 CLI nor c4py ever read.

const enc = new TextEncoder()
const dec = new TextDecoder()
let tmpDir: string

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
})

async function fresh(): Promise<string> {
  tmpDir = await mkdtemp(join(tmpdir(), 'c4ts-store-layout-'))
  return tmpDir
}

/** Every file under root with the SHA-256 of its bytes, by relative path. */
async function snapshot(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  async function walk(d: string) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else out.set(relative(root, p), createHash('sha256').update(await readFile(p)).digest('hex'))
    }
  }
  await walk(root)
  return out
}

async function bytesOf(s: TreeStore, idStr: string): Promise<string> {
  return dec.decode(await streamToBytes(await s.get(parseC4ID(idStr))))
}

describe('the shared split-race-store fixture', () => {
  const fixture = fileURLToPath(new URL('./fixtures/split-race-store/', import.meta.url))

  it('finds every object, the one a level too high included, and writes nothing', async () => {
    const root = join(await fresh(), 'store')
    await cp(join(fixture, 'store'), root, { recursive: true })
    const before = await snapshot(root)
    const s = new TreeStore(root)
    const lines = (await readFile(join(fixture, 'objects.txt'), 'utf8')).split('\n').filter(l => l)
    expect(lines.length).toBeGreaterThan(12)
    for (const line of lines) {
      const sp = line.indexOf(' ')
      const idStr = line.slice(0, sp)
      expect(await s.has(parseC4ID(idStr)), idStr).toBe(true)
      expect(await bytesOf(s, idStr)).toBe(line.slice(sp + 1))
      expect((await identifyBytes(enc.encode(line.slice(sp + 1)))).toString()).toBe(idStr)
    }
    const misplaced = (await readFile(join(fixture, 'misplaced.txt'), 'utf8')).trim()
    expect(await s.has(parseC4ID(misplaced))).toBe(true)
    expect(await snapshot(root)).toEqual(before)
  })
})

describe("Go's layout", () => {
  it('a new store is flat, full-ID names at the root, then splits only its objects', async () => {
    const root = join(await fresh(), 'store')
    const s = new TreeStore(root)
    s.splitThreshold = 4
    const first = await s.put(enc.encode('object 1'))
    expect((await stat(join(root, first.toString()))).isFile()).toBe(true)
    await writeFile(join(root, 'journal'), 'a journal another tool keeps here\n')
    await writeFile(join(root, 'config'), 'store /somewhere\n')
    const ids = [first]
    for (let n = 2; n <= 40; n++) ids.push(await s.put(enc.encode(`object ${n}`)))
    // The root split: objects went down to c4/ (and deeper); the journal
    // and config stayed.
    expect(await readFile(join(root, 'journal'), 'utf8')).toBe('a journal another tool keeps here\n')
    expect(await readFile(join(root, 'config'), 'utf8')).toBe('store /somewhere\n')
    const rootFiles = (await readdir(root, { withFileTypes: true })).filter(e => e.isFile() && !e.name.startsWith('.'))
    expect(rootFiles.map(e => e.name).sort()).toEqual(['config', 'journal'])
    for (let n = 1; n <= 40; n++) expect(await bytesOf(s, ids[n - 1].toString())).toBe(`object ${n}`)
    // A second store on the same root reads it all too.
    const again = new TreeStore(root)
    for (const id of ids) expect(await again.has(id)).toBe(true)
  })

  it('remove deletes every copy, a level-too-high one included', async () => {
    const root = join(await fresh(), 'store')
    const s = new TreeStore(root)
    s.splitThreshold = 4
    const ids = []
    for (let n = 1; n <= 12; n++) ids.push(await s.put(enc.encode(`object ${n}`)))
    const id = ids[0].toString()
    const deep = (await snapshot(root))
    const where = [...deep.keys()].find(p => p.endsWith(id))!
    // A second copy one level up, as a write that raced a split leaves.
    const up = join(root, 'c4', id)
    if (join(root, where) !== up) await writeFile(up, await readFile(join(root, where)))
    await s.remove(ids[0])
    expect(await s.has(ids[0])).toBe(false)
    await expect(s.get(ids[0])).rejects.toBeInstanceOf(ContentNotFoundError)
  })


  it('get searches again when a split moves the file, and the search is bounded', async () => {
    const root = join(await fresh(), 'store')
    const s = new TreeStore(root)
    const id = await s.put(enc.encode('object'))
    let reads = 0
    s.read = async p => {
      reads++
      throw Object.assign(new Error(`gone: ${p}`), { code: 'ENOENT' })
    }
    await expect(s.get(id)).rejects.toBeInstanceOf(ContentNotFoundError)
    expect(reads).toBe(1 + id.toString().length)
  })

  it('a publishing rename that fails because another writer published the same ID is a success', async () => {
    const root = join(await fresh(), 'store')
    const s = new TreeStore(root)
    const data = enc.encode('published twice')
    const id = await identifyBytes(data)
    const other = new TreeStore(root)
    s.rename = async (from, to) => {
      await other.put(data) // the other writer wins the race
      throw Object.assign(new Error('Access is denied (simulated)'), { code: 'EPERM' })
    }
    expect((await s.put(data)).toString()).toBe(id.toString())
    expect(dec.decode(await streamToBytes(await s.get(id)))).toBe('published twice')
    expect((await readdir(root)).filter(n => n.startsWith('.ingest.'))).toEqual([])
  })

  it('foldVariants gives every ASCII case variant, the segment first', () => {
    expect(foldVariants('aB')).toEqual(['aB', 'AB', 'ab', 'Ab'])
    expect(foldVariants('12')).toEqual(['12'])
  })
})

describe('a store c4ts wrote through 1.0.26', () => {
  /** The legacy layout: c4/<the ID's last 88 characters>, as c4ts 1.0.26's put wrote it. */
  async function legacy(root: string, bodies: string[], goSplit: boolean): Promise<string[]> {
    const ids: string[] = []
    for (const b of bodies) {
      const id = (await identifyBytes(enc.encode(b))).toString()
      const rest = id.slice(2)
      const dir = goSplit ? join(root, 'c4', rest.slice(0, 2)) : join(root, 'c4')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, rest), b)
      ids.push(id)
    }
    return ids
  }

  for (const goSplit of [false, true]) {
    it(`is read where it lies and nothing moves${goSplit ? ', after a pre-#171 Go split moved it' : ''}`, async () => {
      const root = join(await fresh(), 'store')
      const bodies = ['legacy 1', 'legacy 2', 'legacy 3']
      const ids = await legacy(root, bodies, goSplit)
      const before = await snapshot(root)
      const s = new TreeStore(root)
      for (let i = 0; i < ids.length; i++) {
        expect(await s.has(parseC4ID(ids[i]))).toBe(true)
        expect(await bytesOf(s, ids[i])).toBe(bodies[i])
      }
      expect(await snapshot(root)).toEqual(before)
      // A new object goes to Go's layout: c4/ exists, so the root is
      // already split and the object is at c4/<ID>, under its full ID.
      const fresh1 = await s.put(enc.encode('new object'))
      expect((await stat(join(root, 'c4', fresh1.toString()))).isFile()).toBe(true)
      // Putting a legacy object again publishes it in Go's layout too, and
      // leaves the legacy file where it is. After a Go split the legacy
      // shard c4/<88[0:2]>/ is the directory Go's trie walks into next.
      const again = await s.put(enc.encode(bodies[0]))
      expect(again.toString()).toBe(ids[0])
      const goPlace = goSplit ? join(root, 'c4', ids[0].slice(2, 4), ids[0]) : join(root, 'c4', ids[0])
      expect((await stat(goPlace)).isFile()).toBe(true)
      for (const [p, h] of before) expect((await snapshot(root)).get(p)).toBe(h)
    })
  }
})

// Two ways against the Go CLI: c4 id -s writes and c4ts reads; c4ts puts
// and c4 cat reads. Before a split and after one (the CLI splits at 4,096
// objects; c4ts at a low threshold).
// The Go reference CLI from C4_BIN (this line's CI installs none, and a
// 1.0.x CLI fails the 1.1 finder's `c4 id -q` probe).
const GO_C4 = process.env.C4_BIN

describe('the Go CLI and c4ts read each other', { timeout: 300_000 }, () => {
  // CI installs a pinned Go c4 and sets C4_BIN (.github/workflows/ci.yml);
  // this line has no skip gate, so a missing CLI in CI fails here instead
  // of skipping the two-way tests unnoticed.
  it('CI provides the Go CLI', () => {
    if (process.env.CI) expect(GO_C4, 'C4_BIN is not set in CI').toBeTruthy()
  })

  const env = (dir: string) => ({ ...process.env, HOME: dir, USERPROFILE: dir, C4_STORE: join(dir, 'store') })

  async function goStores(dir: string, n: number): Promise<string[]> {
    const tree = join(dir, 'tree')
    await mkdir(tree, { recursive: true })
    for (let i = 0; i < n; i++) await writeFile(join(tree, `f${i}.txt`), `go file ${i}\n`)
    execFileSync(GO_C4!, ['id', '-s', tree], { env: env(dir), stdio: ['ignore', 'ignore', 'pipe'] })
    const ids: string[] = []
    for (let i = 0; i < n; i++) ids.push((await identifyBytes(enc.encode(`go file ${i}\n`))).toString())
    return ids
  }

  for (const n of [3, 4200]) {
    it.skipIf(!GO_C4)(`c4 id -s writes ${n} and c4ts reads every one${n > 4096 ? ' after the store split' : ''}`, async () => {
      const dir = await fresh()
      const ids = await goStores(dir, n)
      const s = new TreeStore(join(dir, 'store'))
      let found = 0
      for (let i = 0; i < n; i++) if ((await bytesOf(s, ids[i])) === `go file ${i}\n`) found++
      expect(found).toBe(n)
      if (n > 4096) expect((await stat(join(dir, 'store', 'c4'))).isDirectory()).toBe(true)
    })
  }

  for (const threshold of [4096, 4]) {
    it.skipIf(!GO_C4)(`c4ts puts and c4 cat reads every one${threshold === 4 ? ' after c4ts split the store' : ''}`, async () => {
      const dir = await fresh()
      const s = new TreeStore(join(dir, 'store'))
      s.splitThreshold = threshold
      const ids: string[] = []
      for (let i = 0; i < 40; i++) ids.push((await s.put(enc.encode(`c4ts object ${i}`))).toString())
      for (let i = 0; i < 40; i++) {
        const out = execFileSync(GO_C4!, ['cat', ids[i]], { env: env(dir), encoding: 'utf8' })
        expect(out).toBe(`c4ts object ${i}`)
      }
      if (threshold === 4) expect((await stat(join(dir, 'store', 'c4'))).isDirectory()).toBe(true)
    })
  }
})

// The 1.0.27 notes' command for finding the objects only c4ts could see:
// the files under <store>/c4/ and <store>/c4/XX/ whose names are 88
// characters, the ID without its "c4". POSIX shells only.
const LEGACY_LIST = `find "$C4_STORE/c4" -maxdepth 2 -type f | awk -F/ 'length($NF) == 88'`

describe('the notes command for c4ts-only objects', () => {
  it.skipIf(process.platform === 'win32')('lists exactly the legacy files, plain and Go-split, and no Go-layout object', async () => {
    const root = join(await fresh(), 'store')
    const want: string[] = []
    for (const [goSplit, body] of [[false, 'old a'], [false, 'old b'], [true, 'old c']] as const) {
      const id = (await identifyBytes(enc.encode(body))).toString()
      const rest = id.slice(2)
      const dir = goSplit ? join(root, 'c4', rest.slice(0, 2)) : join(root, 'c4')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, rest), body)
      want.push(join(dir, rest))
    }
    const s = new TreeStore(root)
    s.splitThreshold = 4
    for (let n = 0; n < 12; n++) await s.put(enc.encode(`go layout ${n}`))
    const out = execFileSync('sh', ['-c', LEGACY_LIST], { env: { ...process.env, C4_STORE: root }, encoding: 'utf8' })
    expect(out.split('\n').filter(l => l).sort()).toEqual(want.sort())
  })
})
