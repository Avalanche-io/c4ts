import { readdir, stat, readFile, writeFile, mkdir, rm, rename, chmod, utimes } from 'node:fs/promises'
import type { FileSystem, DirEntry, FileStat } from '../../core/src/filesystem.js'
import { FileNotFoundError, bytesToStream, streamToBytes } from '../../core/src/filesystem.js'

/**
 * FileSystem implementation backed by Node.js fs module.
 * Wraps node:fs/promises to provide the standard FileSystem interface.
 */
export class NodeFS implements FileSystem {
  async *readDir(path: string): AsyncIterable<DirEntry> {
    const entries = await readdir(path, { withFileTypes: true })
    for (const entry of entries) {
      yield {
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isSymlink: entry.isSymbolicLink(),
      }
    }
  }

  async stat(path: string): Promise<FileStat> {
    try {
      const s = await stat(path)
      return {
        size: s.size,
        mode: s.mode & 0o7777,
        mtime: s.mtime,
        isDirectory: s.isDirectory(),
        isSymlink: s.isSymbolicLink(),
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') throw new FileNotFoundError(path)
      throw err
    }
  }

  async readFile(path: string): Promise<ReadableStream<Uint8Array>> {
    try {
      const data = await readFile(path)
      return bytesToStream(new Uint8Array(data))
    } catch (err: any) {
      if (err.code === 'ENOENT') throw new FileNotFoundError(path)
      throw err
    }
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    try {
      const data = await readFile(path)
      return new Uint8Array(data)
    } catch (err: any) {
      if (err.code === 'ENOENT') throw new FileNotFoundError(path)
      throw err
    }
  }

  async writeFile(path: string, data: ReadableStream<Uint8Array> | Uint8Array): Promise<void> {
    const bytes = data instanceof Uint8Array ? data : await streamToBytes(data)
    await writeFile(path, bytes)
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await mkdir(path, { recursive: options?.recursive })
  }

  async remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    try {
      await rm(path, { recursive: options?.recursive, force: true })
    } catch (err: any) {
      if (err.code === 'ENOENT') throw new FileNotFoundError(path)
      throw err
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await rename(oldPath, newPath)
  }

  async setMeta(path: string, meta: { mode?: number; mtime?: Date }): Promise<void> {
    if (meta.mode !== undefined) await chmod(path, meta.mode)
    if (meta.mtime !== undefined) await utimes(path, meta.mtime, meta.mtime)
  }
}
