import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, rm, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFS } from '../../node/src/node-fs.js'
import { scan } from '../src/scanner.js'
import { identifyBytes } from '../src/id.js'

// A symbolic link is recorded as itself, as the Go scanner records it: an
// `l` entry with its own mode, mtime and size, its target, and a C4 ID by
// Go's rules. Through 1.0.26 c4ts dropped every link from a scan, so any
// tree holding one had a C4 ID no other implementation computes. The root
// IDs of these trees were checked against the Go CLI (master, 2026-11-11).
describe('scan records symbolic links', () => {
  it.skipIf(process.platform === 'win32')('records each kind of link with Go\'s target and ID rules', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'c4ts-links-'))
    try {
      await mkdir(join(dir, 'sub'))
      await writeFile(join(dir, 'f.txt'), 'hi')
      await writeFile(join(dir, 'sub', 's.txt'), 's')
      await symlink('f.txt', join(dir, 'to-file'))
      await symlink('sub', join(dir, 'to-dir'))
      await symlink('to-file', join(dir, 'to-link'))
      await symlink('missing', join(dir, 'dangling'))
      await mkdir(join(dir, 'other'))
      await symlink('..', join(dir, 'other', 'up'))
      await symlink('target\\', join(dir, 'trail'))

      const m = await scan(new NodeFS(), dir)
      const byName = new Map(m.entries.map((e) => [e.name, e]))
      const subScan = await scan(new NodeFS(), join(dir, 'sub'))

      const want: Record<string, [string, string | null]> = {
        'to-file': ['f.txt', (await identifyBytes(new TextEncoder().encode('hi'))).toString()],
        'to-dir': ['sub', (await subScan.computeC4ID()).toString()],
        'to-link': ['to-file', null], // a link naming a link has no ID
        'dangling': ['missing', null],
        'up': ['..', null], // names an ancestor being scanned: a cycle
        'trail': ['target\\', null], // a backslash is a literal byte
      }
      for (const [name, [target, id]] of Object.entries(want)) {
        const e = byName.get(name)
        expect(e, name).toBeDefined()
        expect(e!.modeType, name).toBe('l')
        expect(e!.target, name).toBe(target)
        expect(e!.c4id?.toString() ?? null, name).toBe(id)
        const path = name === 'up' ? join(dir, 'other', 'up') : join(dir, name)
        expect(e!.size, name).toBe((await lstat(path)).size)
      }
      // `sub/` is a real directory entry, not a link, and `to-dir` is not
      // written as a directory.
      expect(byName.get('sub/')?.modeType).toBe('d')
      expect(byName.has('to-dir/')).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('a link to its own directory does not recurse', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'c4ts-selflink-'))
    try {
      await symlink('.', join(dir, 'here'))
      const m = await scan(new NodeFS(), dir)
      const here = m.entries.find((e) => e.name === 'here')
      expect(here?.target).toBe('.')
      expect(here?.c4id).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
