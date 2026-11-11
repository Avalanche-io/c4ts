import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, chmod, utimes, readFile, readdir, stat } from 'node:fs/promises'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NodeFS, scan, encode, Manifest, identifyBytes } from '../src/index.js'

// 1.0.27 must upgrade blind: scan() then encode(), with and without IDs,
// writes what c4ts 1.0.26 (release/1.0.x f2aa714) wrote, on a flat tree with
// an empty directory and a nested one with an empty directory two levels
// down (fixtures/blind-upgrade/, written by 1.0.26 running this same file
// with C4TS_BLIND_UPGRADE_WRITE=1). A childless directory with no ID keeps a
// null size, but a scan states 0 for a directory it listed as empty, so
// nothing changes. A directory the scan cannot read throws, as in 1.0.26.
// And a scan's C4 ID is the C4 ID of its root's one-level written listing.

const GOLDEN = fileURLToPath(new URL('./fixtures/blind-upgrade/', import.meta.url))
const WHEN = new Date('2026-01-02T03:04:05Z')
const isWindows = process.platform === 'win32'

async function build(root: string, files: Record<string, string>, dirs: string[]): Promise<string> {
  for (const d of dirs) await mkdir(join(root, d), { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel)
    await mkdir(join(p, '..'), { recursive: true })
    await writeFile(p, content)
  }
  // Fixed modes and times, deepest first.
  const all: string[] = []
  const walk = async (d: string): Promise<void> => {
    for (const name of await readdir(d)) {
      const p = join(d, name)
      all.push(p)
      if ((await stat(p)).isDirectory()) await walk(p)
    }
  }
  await walk(root)
  all.sort((a, b) => b.split('/').length - a.split('/').length)
  for (const p of all) {
    await chmod(p, (await stat(p)).isDirectory() ? 0o755 : 0o644)
    await utimes(p, WHEN, WHEN)
  }
  return root
}

async function trees(): Promise<Record<string, string>> {
  const base = await mkdtemp(join(tmpdir(), 'c4ts-blind-'))
  return {
    flat: await build(join(base, 'flat'), { 'a.txt': 'a\n' }, ['empty']),
    nested: await build(join(base, 'nested'), { z: 'z\n', 'a/f': 'f\n' }, ['a/b/empty']),
  }
}

describe.skipIf(isWindows)('scan output upgrades blind from 1.0.26', () => {
  for (const mode of ['ids', 'noids'] as const) {
    it(`is byte-identical to 1.0.26 (${mode})`, async () => {
      const t = await trees()
      for (const [name, root] of Object.entries(t)) {
        const text = encode(await scan(new NodeFS(), root, { computeIds: mode === 'ids' }))
        const file = join(GOLDEN, `${name}-${mode}.c4m`)
        if (process.env.C4TS_BLIND_UPGRADE_WRITE) {
          if (!existsSync(GOLDEN)) mkdirSync(GOLDEN, { recursive: true })
          writeFileSync(file, text)
          continue
        }
        expect(text, `${name} ${mode}`).toBe(await readFile(file, 'utf8'))
      }
    })

    it(`a scan's C4 ID is the C4 ID of its root's written listing (${mode})`, async () => {
      if (process.env.C4TS_BLIND_UPGRADE_WRITE) return
      const t = await trees()
      for (const root of Object.values(t)) {
        const m = await scan(new NodeFS(), root, { computeIds: mode === 'ids' })
        const top = Manifest.create()
        top.entries = m.entries.filter(e => e.depth === 0)
        const textId = (await identifyBytes(new TextEncoder().encode(encode(top)))).toString()
        expect((await m.computeC4ID()).toString(), root).toBe(textId)
      }
    })
  }

  it('a directory the scan cannot read throws, as in 1.0.26', async () => {
    if (process.env.C4TS_BLIND_UPGRADE_WRITE || process.getuid?.() === 0) return
    const base = await mkdtemp(join(tmpdir(), 'c4ts-unread-'))
    const root = await build(join(base, 'unread'), { f: 'f\n', 'locked/inner': 'in\n' }, ['empty'])
    await chmod(join(root, 'locked'), 0)
    try {
      await expect(scan(new NodeFS(), root)).rejects.toThrow()
      await expect(scan(new NodeFS(), root, { computeIds: false })).rejects.toThrow()
    } finally {
      await chmod(join(root, 'locked'), 0o755)
    }
  })
})
