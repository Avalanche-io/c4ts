/**
 * Abstract filesystem interface. Decouples workspace/scanner/reconciler
 * from the underlying storage backend.
 *
 * Implementations:
 * - MemoryFS (core) — in-memory tree, for tests
 * - FileSystemAccessFS (core/browser) — wraps File System Access API handles
 * - NodeFS (c4-node) — wraps node:fs/promises
 */

/** A single directory entry returned by readDir. */
export interface DirEntry {
  name: string
  isDirectory: boolean
  isSymlink: boolean
}

/** File/directory metadata. */
export interface FileStat {
  size: number
  mode: number
  mtime: Date
  isDirectory: boolean
  isSymlink: boolean
}

/** Abstract filesystem operations. */
export interface FileSystem {
  /** List entries in a directory. */
  readDir(path: string): AsyncIterable<DirEntry>

  /** Get metadata for a path. */
  stat(path: string): Promise<FileStat>

  /** Read file content as a stream. */
  readFile(path: string): Promise<ReadableStream<Uint8Array>>

  /** Read file content as bytes (convenience, default implementation collects stream). */
  readFileBytes?(path: string): Promise<Uint8Array>

  /** Write file content from a stream or bytes. */
  writeFile(path: string, data: ReadableStream<Uint8Array> | Uint8Array): Promise<void>

  /** Create a directory (and parents if recursive). */
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>

  /** Remove a file or directory. */
  remove(path: string, options?: { recursive?: boolean }): Promise<void>

  /** Rename/move a file or directory. */
  rename(oldPath: string, newPath: string): Promise<void>

  /** Set file metadata (permissions, timestamps). Optional. */
  setMeta?(path: string, meta: { mode?: number; mtime?: Date }): Promise<void>
}

/** Error thrown when a path is not found. */
export class FileNotFoundError extends Error {
  readonly path: string
  constructor(path: string) {
    super(`not found: ${path}`)
    this.name = 'FileNotFoundError'
    this.path = path
  }
}

/** Error thrown when a path already exists (e.g. mkdir without recursive). */
export class FileExistsError extends Error {
  readonly path: string
  constructor(path: string) {
    super(`already exists: ${path}`)
    this.name = 'FileExistsError'
    this.path = path
  }
}

/** Helper: collect a ReadableStream into a Uint8Array. */
export async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.length
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

/** Helper: create a ReadableStream from a Uint8Array. */
export function bytesToStream(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(data)
      controller.close()
    },
  })
}

/** Helper: join path segments with /. */
export function joinPath(...parts: string[]): string {
  return parts
    .filter(p => p !== '')
    .join('/')
    .replace(/\/+/g, '/')
}
