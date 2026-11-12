import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NodeFS, TreeStore, MemoryStore, scan, encode, identifyBytes, verify, reconcilePlan, Manifest,
} from '../src/index.js'

// A file's C4 ID summons exactly that file, on every path, and c4m text is
// no exception (the C4 rule of 2026-11-03; the Go reference's
// design/no-self-id.md). Through 1.0.26 c4ts re-rendered anything that
// parsed as c4m to its ONE-LEVEL canonical listing before identifying or
// storing it: scan entries, MemoryStore.put and TreeStore.put all gave the
// description ID, and the stores kept the listing, so the nested entries
// were gone from what came back. verify and reconcile compared files
// against that re-rendered ID too.

// An independent C4 ID: SHA-512, base58 with the C4 alphabet, "c4" prefix,
// padded to 90 characters. It shares no code with c4ts.
function independentC4ID(data: Uint8Array): string {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let n = BigInt('0x' + createHash('sha512').update(data).digest('hex'))
  let s = ''
  while (n > 0n) {
    s = A[Number(n % 58n)] + s
    n /= 58n
  }
  return 'c4' + s.padStart(88, '1')
}

const enc = new TextEncoder()

async function prettyNested(): Promise<{ dir: string; pretty: Uint8Array; canonical: Uint8Array }> {
  const dir = await mkdtemp(join(tmpdir(), 'c4ts-fileid-'))
  const src = join(dir, 'src')
  await mkdir(join(src, 'd'), { recursive: true })
  await writeFile(join(src, 'a.txt'), 'a\n')
  await writeFile(join(src, 'd', 'b'), 'b\n')
  const m = await scan(new NodeFS(), src)
  const pretty = enc.encode(encode(m, { pretty: true }))
  const canonical = enc.encode(encode(m))
  return { dir, pretty, canonical }
}

describe('a file\'s C4 ID is its bytes on every path', () => {
  it('the independent encoder is right', () => {
    expect(independentC4ID(new Uint8Array(0))).toBe(
      'c459dsjfscH38cYeXXYogktxf4Cd9ibshE3BHUo6a58hBXmRQdZrAkZzsWcbWtDg5oQstpDuni4Hirj75GEmTc1sFT')
  })

  it('the test file parses as c4m and is not canonical', async () => {
    const { pretty, canonical } = await prettyNested()
    const m = await Manifest.parse(new TextDecoder().decode(pretty))
    expect(m.entries.some(e => e.depth > 0)).toBe(true)
    expect(Buffer.from(pretty).equals(Buffer.from(canonical))).toBe(false)
  })

  for (const name of ['tree.c4m', 'tree.bin', 'tree.txt']) {
    it(`scan, with and without a store, records ${name} by its bytes and the store returns them`, async () => {
      const { dir, pretty } = await prettyNested()
      const want = independentC4ID(pretty)
      const files = join(dir, 'files')
      await mkdir(files)
      await writeFile(join(files, name), pretty)

      const plain = await scan(new NodeFS(), files)
      expect(plain.get(name)!.c4id!.toString()).toBe(want)

      const store = new TreeStore(join(dir, 'store'))
      const stored = await scan(new NodeFS(), files, { store })
      const id = stored.get(name)!.c4id!
      expect(id.toString()).toBe(want)
      const back = new Uint8Array(await new Response(await store.get(id)).arrayBuffer())
      expect(Buffer.from(back).equals(Buffer.from(pretty))).toBe(true)
    })
  }

  it('identifyBytes is the byte ID', async () => {
    const { pretty } = await prettyNested()
    expect((await identifyBytes(pretty)).toString()).toBe(independentC4ID(pretty))
  })

  it('MemoryStore and TreeStore: get(put(x)) is x for a nested pretty c4m, under its byte ID', async () => {
    const { dir, pretty } = await prettyNested()
    const want = independentC4ID(pretty)
    for (const store of [new MemoryStore(), new TreeStore(join(dir, 'store2'))]) {
      const id = await store.put(pretty)
      expect(id.toString()).toBe(want)
      expect(await store.has(id)).toBe(true)
      const back = new Uint8Array(await new Response(await store.get(id)).arrayBuffer())
      expect(Buffer.from(back).equals(Buffer.from(pretty))).toBe(true)
    }
  })

  it('verify and reconcile accept a c4m-looking file recorded under its byte ID', async () => {
    const { dir, pretty } = await prettyNested()
    const files = join(dir, 'vfiles')
    await mkdir(files)
    await writeFile(join(files, 'tree.c4m'), pretty)
    const m = await scan(new NodeFS(), files)
    expect(m.get('tree.c4m')!.c4id!.toString()).toBe(independentC4ID(await readFile(join(files, 'tree.c4m'))))

    const report = await verify(m, new NodeFS(), files)
    expect(report.corrupt).toEqual([])
    expect(report.ok).toContain('tree.c4m')

    const p = await reconcilePlan(m, new NodeFS(), files)
    expect(p.operations).toEqual([])
    expect(p.skipped).toContain('tree.c4m')
  })
})
