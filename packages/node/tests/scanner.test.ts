import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, utimes } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
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

// The Go reference CLI, when installed. Skipped elsewhere so CI passes.
const GO_C4 = '/opt/homebrew/bin/c4'
const hasGoC4 = existsSync(GO_C4)

describe('scan matches the Go CLI byte for byte', () => {
  it.skipIf(!hasGoC4)('c4 id <tree> and scan()+encode() produce identical text', async () => {
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

    const goText = execFileSync(GO_C4, ['id', tree], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, C4_STORE: join(home, 'store') },
    })
    const m = await scan(new NodeFS(), tree)
    expect(m.encode()).toBe(goText)
    expect(goText.split('\n').filter(l => l !== '').length).toBe(16)
  })
})
