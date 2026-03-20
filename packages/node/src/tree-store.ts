import { readFile, writeFile, mkdir, rm, stat, rename as fsRename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { C4ID } from '../../core/src/id.js'
import { identifyBytes } from '../../core/src/id.js'
import { bytesToStream, streamToBytes } from '../../core/src/filesystem.js'
import type { Store } from '../../core/src/store.js'
import { ContentNotFoundError } from '../../core/src/store.js'

/**
 * Filesystem content store compatible with Go's store.TreeStore
 * and Python's FSStore.
 *
 * Layout: store/c4/REMAINING_88_CHARS
 * All C4 IDs start with "c4", so top level has a single "c4" directory.
 */
export class TreeStore implements Store {
  readonly path: string

  constructor(path: string) {
    this.path = path
  }

  async has(id: C4ID): Promise<boolean> {
    try {
      await stat(this.idToPath(id))
      return true
    } catch {
      return false
    }
  }

  async get(id: C4ID): Promise<ReadableStream<Uint8Array>> {
    try {
      const data = await readFile(this.idToPath(id))
      return bytesToStream(new Uint8Array(data))
    } catch {
      throw new ContentNotFoundError(id)
    }
  }

  async put(data: ReadableStream<Uint8Array> | Uint8Array): Promise<C4ID> {
    const bytes = data instanceof Uint8Array ? data : await streamToBytes(data)
    const id = await identifyBytes(bytes)
    if (await this.has(id)) return id

    const dir = this.idToDir(id)
    await mkdir(dir, { recursive: true })

    const tmpName = `.ingest.${randomBytes(8).toString('hex')}`
    const tmpPath = join(dir, tmpName)
    const finalPath = this.idToPath(id)

    await writeFile(tmpPath, bytes)
    await fsRename(tmpPath, finalPath)
    return id
  }

  async remove(id: C4ID): Promise<void> {
    try { await rm(this.idToPath(id)) } catch { /* ignore */ }
  }

  private idToPath(id: C4ID): string {
    const s = id.toString()
    return join(this.path, s.substring(0, 2), s.substring(2))
  }

  private idToDir(id: C4ID): string {
    const s = id.toString()
    return join(this.path, s.substring(0, 2))
  }
}

/** Open the default content store (C4_STORE env or ~/.c4/store). */
export async function openStore(path?: string): Promise<TreeStore> {
  if (path) return new TreeStore(path)
  const envStore = process.env.C4_STORE
  if (envStore) return new TreeStore(envStore)
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  const defaultPath = join(home, '.c4', 'store')
  await mkdir(defaultPath, { recursive: true })
  return new TreeStore(defaultPath)
}
