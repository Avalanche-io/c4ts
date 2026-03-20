import type { C4ID } from './id.js'
import type { Store } from './store.js'
import { ContentNotFoundError } from './store.js'

/**
 * A source of content addressable by C4 ID.
 * Every Store is a ContentSource, but sources can also be
 * HTTP endpoints, peer connections, or anything that serves bytes by ID.
 */
export interface ContentSource {
  /** Human-readable name for this source. */
  readonly name: string

  /** Priority (lower = tried first in sequential mode). */
  readonly priority: number

  /** Check if content is available. */
  has(id: C4ID): Promise<boolean>

  /** Retrieve content. Throws ContentNotFoundError if unavailable. */
  get(id: C4ID): Promise<ReadableStream<Uint8Array>>
}

/** Result of a resolved content fetch. */
export interface ResolveResult {
  stream: ReadableStream<Uint8Array>
  source: string
}

/** Wrap any Store as a ContentSource. */
export function storeAsSource(store: Store, name: string, priority: number = 0): ContentSource {
  return {
    name,
    priority,
    has: (id) => store.has(id),
    get: (id) => store.get(id),
  }
}

/**
 * Multi-source content resolver. Tries sources in parallel (race mode)
 * or sequential (priority mode) to find content by C4 ID.
 *
 * Usage:
 *   const resolver = new ContentResolver()
 *   resolver.addSource(storeAsSource(localStore, 'local', 0))
 *   resolver.addSource(storeAsSource(remoteStore, 'remote', 10))
 *   const stream = await resolver.get(id)
 */
export class ContentResolver {
  private sources: ContentSource[] = []

  /** Add a content source. */
  addSource(source: ContentSource): void {
    this.sources.push(source)
    this.sources.sort((a, b) => a.priority - b.priority)
  }

  /** Remove a source by name. */
  removeSource(name: string): void {
    this.sources = this.sources.filter(s => s.name !== name)
  }

  /** List registered sources. */
  listSources(): ReadonlyArray<{ name: string; priority: number }> {
    return this.sources.map(s => ({ name: s.name, priority: s.priority }))
  }

  /** Check if any source has the content. Tries all in parallel. */
  async has(id: C4ID): Promise<boolean> {
    if (this.sources.length === 0) return false
    const results = await Promise.all(
      this.sources.map(s => s.has(id).catch(() => false))
    )
    return results.some(r => r)
  }

  /**
   * Retrieve content from the fastest available source (race mode).
   * All sources that claim to have the content are raced;
   * the first to deliver wins.
   */
  async get(id: C4ID): Promise<ReadableStream<Uint8Array>> {
    const result = await this.resolve(id)
    return result.stream
  }

  /**
   * Resolve content with metadata about which source served it.
   * Uses a two-phase approach:
   *   1. Check which sources have the content (parallel).
   *   2. Race the available sources for the actual data.
   */
  async resolve(id: C4ID): Promise<ResolveResult> {
    if (this.sources.length === 0) {
      throw new ContentNotFoundError(id)
    }

    // Phase 1: find which sources have it
    const availability = await Promise.all(
      this.sources.map(async (s) => {
        try { return { source: s, available: await s.has(id) } }
        catch { return { source: s, available: false } }
      })
    )

    const available = availability
      .filter(a => a.available)
      .map(a => a.source)

    if (available.length === 0) {
      throw new ContentNotFoundError(id)
    }

    // Phase 2: race available sources
    if (available.length === 1) {
      const s = available[0]
      return { stream: await s.get(id), source: s.name }
    }

    // Race multiple sources
    const result = await Promise.any(
      available.map(async (s) => {
        const stream = await s.get(id)
        return { stream, source: s.name }
      })
    )
    return result
  }

  /**
   * Sequential resolution — try sources in priority order, return first success.
   * More predictable than race mode; useful when source cost varies.
   */
  async getSequential(id: C4ID): Promise<ResolveResult> {
    for (const source of this.sources) {
      try {
        if (await source.has(id)) {
          const stream = await source.get(id)
          return { stream, source: source.name }
        }
      } catch {
        continue
      }
    }
    throw new ContentNotFoundError(id)
  }
}
