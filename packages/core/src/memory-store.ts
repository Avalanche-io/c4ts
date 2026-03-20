import type { C4ID } from './id.js'
import { identifyBytes } from './id.js'
import type { Store } from './store.js'
import { ContentNotFoundError } from './store.js'
import { streamToBytes, bytesToStream } from './filesystem.js'

/**
 * In-memory content-addressed store backed by a Map.
 * Useful for tests, small operations, and browser environments
 * where persistence isn't needed.
 */
export class MemoryStore implements Store {
  private data = new Map<string, Uint8Array>()

  async has(id: C4ID): Promise<boolean> {
    return this.data.has(id.toString())
  }

  async get(id: C4ID): Promise<ReadableStream<Uint8Array>> {
    const key = id.toString()
    const bytes = this.data.get(key)
    if (!bytes) throw new ContentNotFoundError(id)
    return bytesToStream(new Uint8Array(bytes))
  }

  async put(data: ReadableStream<Uint8Array> | Uint8Array): Promise<C4ID> {
    const bytes = data instanceof Uint8Array ? data : await streamToBytes(data)
    const id = await identifyBytes(bytes)
    const key = id.toString()
    if (!this.data.has(key)) {
      this.data.set(key, new Uint8Array(bytes))
    }
    return id
  }

  async remove(id: C4ID): Promise<void> {
    this.data.delete(id.toString())
  }

  /** Number of objects in the store. */
  get size(): number {
    return this.data.size
  }

  /** Total bytes stored. */
  get totalBytes(): number {
    let total = 0
    for (const v of this.data.values()) total += v.length
    return total
  }

  /** Clear all stored content. */
  clear(): void {
    this.data.clear()
  }
}
