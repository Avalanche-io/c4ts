import type { FileSystem, DirEntry, FileStat } from '../filesystem.js'
import { FileNotFoundError, bytesToStream, streamToBytes } from '../filesystem.js'

/**
 * FileSystem implementation backed by the File System Access API.
 * Wraps a FileSystemDirectoryHandle to provide the standard FileSystem interface.
 *
 * This enables workspace, scanner, and reconciler operations in the browser
 * using a real directory selected by the user via showDirectoryPicker().
 *
 * Usage:
 *   const dirHandle = await window.showDirectoryPicker()
 *   const fs = new FileSystemAccessFS(dirHandle)
 *   const manifest = await scan(fs, '', options)
 */
export class FileSystemAccessFS implements FileSystem {
  private root: FileSystemDirectoryHandle

  constructor(root: FileSystemDirectoryHandle) {
    this.root = root
  }

  async *readDir(path: string): AsyncIterable<DirEntry> {
    const dir = await this.resolveDir(path)
    for await (const [name, handle] of dir as any) {
      yield {
        name,
        isDirectory: handle.kind === 'directory',
        isSymlink: false, // FSAA doesn't expose symlink info
      }
    }
  }

  async stat(path: string): Promise<FileStat> {
    const handle = await this.resolveHandle(path)
    if (handle.kind === 'directory') {
      return {
        size: 0,
        mode: 0o755,
        mtime: new Date(), // FSAA doesn't expose mtime on dirs
        isDirectory: true,
        isSymlink: false,
      }
    }
    const file = await (handle as FileSystemFileHandle).getFile()
    return {
      size: file.size,
      mode: 0o644,
      mtime: new Date(file.lastModified),
      isDirectory: false,
      isSymlink: false,
    }
  }

  async readFile(path: string): Promise<ReadableStream<Uint8Array>> {
    const handle = await this.resolveFile(path)
    const file = await handle.getFile()
    return file.stream() as unknown as ReadableStream<Uint8Array>
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const handle = await this.resolveFile(path)
    const file = await handle.getFile()
    const buffer = await file.arrayBuffer()
    return new Uint8Array(buffer)
  }

  async writeFile(path: string, data: ReadableStream<Uint8Array> | Uint8Array): Promise<void> {
    const parts = splitPath(path)
    const fileName = parts.pop()!
    const dir = await this.resolveDirParts(parts)

    const fileHandle = await dir.getFileHandle(fileName, { create: true })
    const writable = await fileHandle.createWritable()

    if (data instanceof Uint8Array) {
      await writable.write(data as unknown as FileSystemWriteChunkType)
    } else {
      const bytes = await streamToBytes(data)
      await writable.write(bytes as unknown as FileSystemWriteChunkType)
    }
    await writable.close()
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    if (!path || path === '' || path === '.') return
    const parts = splitPath(path)

    if (options?.recursive) {
      let dir = this.root
      for (const part of parts) {
        dir = await dir.getDirectoryHandle(part, { create: true })
      }
    } else {
      const dirName = parts.pop()!
      const parent = await this.resolveDirParts(parts)
      await parent.getDirectoryHandle(dirName, { create: true })
    }
  }

  async remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    const parts = splitPath(path)
    const name = parts.pop()!
    const parent = await this.resolveDirParts(parts)
    await parent.removeEntry(name, { recursive: options?.recursive })
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    // FSAA doesn't have a native rename — copy + delete
    const oldHandle = await this.resolveHandle(oldPath)
    if (oldHandle.kind === 'file') {
      const file = await (oldHandle as FileSystemFileHandle).getFile()
      const bytes = new Uint8Array(await file.arrayBuffer())
      await this.writeFile(newPath, bytes)
      await this.remove(oldPath)
    } else {
      throw new Error('directory rename not supported in File System Access API')
    }
  }

  // No setMeta support — FSAA doesn't expose permission/timestamp setting

  private async resolveHandle(path: string): Promise<FileSystemHandle> {
    if (!path || path === '' || path === '.') return this.root
    const parts = splitPath(path)
    const name = parts.pop()!
    let dir = this.root

    for (const part of parts) {
      try {
        dir = await dir.getDirectoryHandle(part)
      } catch {
        throw new FileNotFoundError(path)
      }
    }

    // Try as file first, then directory
    try {
      return await dir.getFileHandle(name)
    } catch {
      try {
        return await dir.getDirectoryHandle(name)
      } catch {
        throw new FileNotFoundError(path)
      }
    }
  }

  private async resolveDir(path: string): Promise<FileSystemDirectoryHandle> {
    if (!path || path === '' || path === '.') return this.root
    return this.resolveDirParts(splitPath(path))
  }

  private async resolveDirParts(parts: string[]): Promise<FileSystemDirectoryHandle> {
    let dir = this.root
    for (const part of parts) {
      try {
        dir = await dir.getDirectoryHandle(part)
      } catch {
        throw new FileNotFoundError(parts.join('/'))
      }
    }
    return dir
  }

  private async resolveFile(path: string): Promise<FileSystemFileHandle> {
    const parts = splitPath(path)
    const name = parts.pop()!
    const dir = await this.resolveDirParts(parts)
    try {
      return await dir.getFileHandle(name)
    } catch {
      throw new FileNotFoundError(path)
    }
  }
}

function splitPath(path: string): string[] {
  return path.split('/').filter(p => p !== '' && p !== '.')
}
