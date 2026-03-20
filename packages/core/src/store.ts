import type { C4ID } from './id.js'

/**
 * Content-addressed blob storage. Any object is retrievable by its C4 ID.
 *
 * Implementations:
 * - MemoryStore (core) — in-memory, for tests and small operations
 * - IndexedDBStore (core/browser) — persistent browser storage
 * - TreeStore (c4-node) — filesystem trie, compatible with Go/Python stores
 */
export interface Store {
  /** Check if content exists for the given ID. */
  has(id: C4ID): Promise<boolean>

  /** Retrieve content as a ReadableStream. Throws if not found. */
  get(id: C4ID): Promise<ReadableStream<Uint8Array>>

  /** Store content, returning its C4 ID. Idempotent: same content = same ID, no duplicate. */
  put(data: ReadableStream<Uint8Array> | Uint8Array): Promise<C4ID>

  /** Remove content by ID. Optional — not all stores support deletion. */
  remove?(id: C4ID): Promise<void>
}

/** Error thrown when content is not found in a store. */
export class ContentNotFoundError extends Error {
  readonly c4id: string
  constructor(id: C4ID) {
    super(`content not found: ${id}`)
    this.name = 'ContentNotFoundError'
    this.c4id = id.toString()
  }
}

/**
 * A store that reads from multiple backends and writes to one.
 * Reads try each store in order; the first hit wins.
 * Writes go to the primary store only.
 */
export class CompositeStore implements Store {
  private readonly primary: Store
  private readonly secondaries: Store[]

  constructor(primary: Store, ...secondaries: Store[]) {
    this.primary = primary
    this.secondaries = secondaries
  }

  async has(id: C4ID): Promise<boolean> {
    if (await this.primary.has(id)) return true
    for (const s of this.secondaries) {
      if (await s.has(id)) return true
    }
    return false
  }

  async get(id: C4ID): Promise<ReadableStream<Uint8Array>> {
    // Try primary first
    try {
      if (await this.primary.has(id)) return this.primary.get(id)
    } catch { /* fall through */ }

    // Try secondaries
    for (const s of this.secondaries) {
      try {
        if (await s.has(id)) return s.get(id)
      } catch { /* fall through */ }
    }

    throw new ContentNotFoundError(id)
  }

  async put(data: ReadableStream<Uint8Array> | Uint8Array): Promise<C4ID> {
    return this.primary.put(data)
  }

  async remove(id: C4ID): Promise<void> {
    if (this.primary.remove) await this.primary.remove(id)
  }
}
