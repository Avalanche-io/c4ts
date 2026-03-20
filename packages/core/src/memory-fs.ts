import type { FileSystem, DirEntry, FileStat } from './filesystem.js'
import { FileNotFoundError, FileExistsError, bytesToStream, streamToBytes } from './filesystem.js'

interface FSNode {
  name: string
  isDirectory: boolean
  isSymlink: boolean
  mode: number
  mtime: Date
  content?: Uint8Array        // for files
  children?: Map<string, FSNode> // for directories
  target?: string             // for symlinks
}

/**
 * In-memory filesystem tree implementing the FileSystem interface.
 * Useful for tests and operations that don't need real I/O.
 *
 * Paths use forward slashes. Leading/trailing slashes are normalized.
 */
export class MemoryFS implements FileSystem {
  private root: FSNode

  constructor() {
    this.root = {
      name: '',
      isDirectory: true,
      isSymlink: false,
      mode: 0o755,
      mtime: new Date(),
      children: new Map(),
    }
  }

  async *readDir(path: string): AsyncIterable<DirEntry> {
    const node = this.resolve(normalizePath(path))
    if (!node || !node.isDirectory) {
      throw new FileNotFoundError(path)
    }
    const entries = [...node.children!.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    for (const [, child] of entries) {
      yield {
        name: child.name,
        isDirectory: child.isDirectory,
        isSymlink: child.isSymlink,
      }
    }
  }

  async stat(path: string): Promise<FileStat> {
    const node = this.resolve(normalizePath(path))
    if (!node) throw new FileNotFoundError(path)
    return {
      size: node.content?.length ?? 0,
      mode: node.mode,
      mtime: node.mtime,
      isDirectory: node.isDirectory,
      isSymlink: node.isSymlink,
    }
  }

  async readFile(path: string): Promise<ReadableStream<Uint8Array>> {
    const node = this.resolve(normalizePath(path))
    if (!node || node.isDirectory) throw new FileNotFoundError(path)
    return bytesToStream(new Uint8Array(node.content ?? new Uint8Array(0)))
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const node = this.resolve(normalizePath(path))
    if (!node || node.isDirectory) throw new FileNotFoundError(path)
    return new Uint8Array(node.content ?? new Uint8Array(0))
  }

  async writeFile(path: string, data: ReadableStream<Uint8Array> | Uint8Array): Promise<void> {
    const normalized = normalizePath(path)
    const parts = normalized.split('/')
    const fileName = parts.pop()!
    const parentPath = parts.join('/')

    const parent = this.resolve(parentPath)
    if (!parent || !parent.isDirectory) {
      throw new FileNotFoundError(parentPath)
    }

    const bytes = data instanceof Uint8Array ? new Uint8Array(data) : await streamToBytes(data)
    const existing = parent.children!.get(fileName)
    if (existing && existing.isDirectory) {
      throw new FileExistsError(path)
    }

    parent.children!.set(fileName, {
      name: fileName,
      isDirectory: false,
      isSymlink: false,
      mode: existing?.mode ?? 0o644,
      mtime: new Date(),
      content: bytes,
    })
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const normalized = normalizePath(path)
    if (normalized === '') return // root always exists

    const parts = normalized.split('/')
    let current = this.root

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const existing = current.children!.get(part)

      if (existing) {
        if (!existing.isDirectory) {
          throw new FileExistsError(parts.slice(0, i + 1).join('/'))
        }
        current = existing
      } else if (options?.recursive || i === parts.length - 1) {
        const newDir: FSNode = {
          name: part,
          isDirectory: true,
          isSymlink: false,
          mode: 0o755,
          mtime: new Date(),
          children: new Map(),
        }
        current.children!.set(part, newDir)
        current = newDir
      } else {
        throw new FileNotFoundError(parts.slice(0, i).join('/'))
      }
    }
  }

  async remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    const normalized = normalizePath(path)
    if (normalized === '') throw new Error('cannot remove root')

    const parts = normalized.split('/')
    const name = parts.pop()!
    const parentPath = parts.join('/')
    const parent = this.resolve(parentPath)

    if (!parent || !parent.isDirectory) throw new FileNotFoundError(path)

    const target = parent.children!.get(name)
    if (!target) throw new FileNotFoundError(path)

    if (target.isDirectory && target.children!.size > 0 && !options?.recursive) {
      throw new Error(`directory not empty: ${path}`)
    }

    parent.children!.delete(name)
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const oldNorm = normalizePath(oldPath)
    const newNorm = normalizePath(newPath)

    const oldParts = oldNorm.split('/')
    const oldName = oldParts.pop()!
    const oldParent = this.resolve(oldParts.join('/'))
    if (!oldParent?.isDirectory) throw new FileNotFoundError(oldPath)

    const node = oldParent.children!.get(oldName)
    if (!node) throw new FileNotFoundError(oldPath)

    const newParts = newNorm.split('/')
    const newName = newParts.pop()!
    const newParent = this.resolve(newParts.join('/'))
    if (!newParent?.isDirectory) throw new FileNotFoundError(newPath)

    oldParent.children!.delete(oldName)
    node.name = newName
    newParent.children!.set(newName, node)
  }

  async setMeta(path: string, meta: { mode?: number; mtime?: Date }): Promise<void> {
    const node = this.resolve(normalizePath(path))
    if (!node) throw new FileNotFoundError(path)
    if (meta.mode !== undefined) node.mode = meta.mode
    if (meta.mtime !== undefined) node.mtime = meta.mtime
  }

  /** Helper: write a string as a file (convenience for tests). */
  async writeText(path: string, text: string): Promise<void> {
    await this.writeFile(path, new TextEncoder().encode(text))
  }

  /** Helper: read a file as a string (convenience for tests). */
  async readText(path: string): Promise<string> {
    const bytes = await this.readFileBytes(path)
    return new TextDecoder().decode(bytes)
  }

  private resolve(path: string): FSNode | null {
    if (path === '') return this.root
    const parts = path.split('/')
    let current = this.root
    for (const part of parts) {
      if (!current.isDirectory || !current.children) return null
      const child = current.children.get(part)
      if (!child) return null
      current = child
    }
    return current
  }
}

function normalizePath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/')
}
