import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFS } from '../../node/src/node-fs.js'
import { scan } from '../src/scanner.js'

// An unreadable file is recorded with a null C4 ID and reported through
// onReadError; the scan does not abort. Through 1.0.25 one such file threw
// EACCES out of the whole scan (the Go scanner records nulls and exits 2).
describe('scan with an unreadable file', () => {
  const runAsRoot = typeof process.getuid === 'function' && process.getuid() === 0
  it.skipIf(process.platform === 'win32' || runAsRoot)('records it with a null C4 ID and reports it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'c4ts-unreadable-'))
    try {
      await writeFile(join(dir, 'ok.txt'), 'readable')
      await writeFile(join(dir, 'locked.txt'), 'secret')
      await chmod(join(dir, 'locked.txt'), 0o000)
      const reported: string[] = []
      const m = await scan(new NodeFS(), dir, { onReadError: (p) => reported.push(p) })
      const byName = new Map(m.entries.map((e) => [e.name, e]))
      expect(byName.get('ok.txt')?.c4id).not.toBeNull()
      expect(byName.has('locked.txt')).toBe(true)
      expect(byName.get('locked.txt')?.c4id).toBeNull()
      expect(reported).toEqual(['locked.txt'])
    } finally {
      await chmod(join(dir, 'locked.txt'), 0o644).catch(() => {})
      await rm(dir, { recursive: true, force: true })
    }
  })
})
