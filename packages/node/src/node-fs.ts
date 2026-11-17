import { readdir, stat, lstat, readlink, readFile, writeFile, mkdir, rm, rename, chmod, utimes } from 'node:fs/promises'
import { sep } from 'node:path'
import type { FileSystem, DirEntry, FileStat } from '../../core/src/filesystem.js'
import { FileNotFoundError, bytesToStream, streamToBytes } from '../../core/src/filesystem.js'

/**
 * The whole second a file time falls in, as a c4m line carries it and Go
 * writes it: the stat's nanoseconds floored toward negative infinity.
 * Node's own stat.mtime is a Date built from a float of milliseconds, and
 * through 1.0.26 c4ts recorded it: a time in a second's last half
 * millisecond rounded up into the next second (an mtime of
 * 15:06:40.9999997 became :41, where Go writes :40), so the same file gave
 * c4ts and Go different C4 IDs, as did every directory above it. Floored
 * here, a scan's entry holds exactly what its c4m line carries. BigInt `/`
 * truncates toward zero, which before 1970 is the later second, so the
 * floor is taken explicitly.
 */
export function secondOf(ns: bigint): Date {
  let s = ns / 1_000_000_000n
  if (ns % 1_000_000_000n < 0n) s -= 1n
  return new Date(Number(s) * 1000)
}

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
      const s = await stat(path, { bigint: true })
      return {
        size: Number(s.size),
        mode: Number(s.mode) & 0o7777,
        mtime: secondOf(s.mtimeNs),
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

  async lstat(path: string): Promise<FileStat> {
    try {
      const s = await lstat(path, { bigint: true })
      return {
        size: Number(s.size),
        mode: Number(s.mode) & 0o7777,
        mtime: secondOf(s.mtimeNs),
        isDirectory: s.isDirectory(),
        isSymlink: s.isSymbolicLink(),
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') throw new FileNotFoundError(path)
      throw err
    }
  }

  async readLink(path: string): Promise<string> {
    const target = await readlink(path)
    // Only "/" separates paths in c4m: convert the platform's own separator
    // (Windows "\"), as Go's filepath.ToSlash does; elsewhere a backslash is
    // a literal byte of the target and is kept.
    return sep === '/' ? target : target.split(sep).join('/')
  }
}
