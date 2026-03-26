import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
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
