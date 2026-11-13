import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, chmod, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NodeFS, permissions } from '../src/node-fs.js'
import { scan } from '../../core/src/scanner.js'
import { formatMode } from '../../core/src/entry.js'

// Go's os.fileStat.Mode on Windows: 0666, or 0444 when read-only, and a
// directory adds 0111. Node gives the same bits without the 0111.
describe('a directory on Windows has the mode Go gives it', () => {
  const dir = (mode: number) => ({ mode: 0o040000 | mode, isDirectory: () => true })
  const file = (mode: number) => ({ mode: 0o100000 | mode, isDirectory: () => false })

  it('reads Node\'s Windows bits as Go does', () => {
    expect(permissions(dir(0o666), 'win32')).toBe(0o777)
    expect(permissions(dir(0o444), 'win32')).toBe(0o555)
    expect(permissions(file(0o666), 'win32')).toBe(0o666)
    expect(permissions(file(0o444), 'win32')).toBe(0o444)
  })

  it('leaves other platforms\' bits as they are', () => {
    expect(permissions(dir(0o755), 'linux')).toBe(0o755)
    expect(permissions(dir(0o700), 'darwin')).toBe(0o700)
    expect(permissions(file(0o644), 'linux')).toBe(0o644)
  })
})

describe('a scanned directory reads back with Go\'s mode on this platform', () => {
  let tmpDir: string | undefined

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
    tmpDir = undefined
  })

  it('is drwxrwxrwx on Windows, and its own permissions elsewhere', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'c4ts-win-mode-'))
    const tree = join(tmpDir, 'tree')
    await mkdir(join(tree, 'sub'), { recursive: true })
    await writeFile(join(tree, 'sub', 'f.txt'), 'f\n')
    await writeFile(join(tree, 'ro.txt'), 'r\n')
    await chmod(join(tree, 'ro.txt'), 0o444)

    const m = await scan(new NodeFS(), tree)
    // Windows will not remove a read-only file.
    await chmod(join(tree, 'ro.txt'), 0o644)
    const line = (name: string) => {
      const e = m.entries.find(e => e.name === name)
      expect(e).toBeDefined()
      return formatMode(e!.modeType, e!.mode)
    }
    if (process.platform === 'win32') {
      expect(line('sub/')).toBe('drwxrwxrwx')
      expect(line('f.txt')).toBe('-rw-rw-rw-')
      expect(line('ro.txt')).toBe('-r--r--r--')
    } else {
      const own = async (p: string) => (await stat(join(tree, p))).mode & 0o7777
      expect(m.entries.find(e => e.name === 'sub/')!.mode).toBe(await own('sub'))
      expect(line('ro.txt')).toBe('-r--r--r--')
    }
  })
})
