import { describe, it, expect } from 'vitest'
import { C4ID, identifyBytes } from '../src/id.js'
import { MemoryStore } from '../src/memory-store.js'
import { ContentNotFoundError, CompositeStore } from '../src/store.js'
import { ContentResolver, storeAsSource } from '../src/resolver.js'
import type { ContentSource } from '../src/resolver.js'
import { ObservableManifest, type ManifestChangeEvent } from '../src/observable.js'
import { Manifest } from '../src/manifest.js'
import { createEntry } from '../src/entry.js'
import { streamToBytes } from '../src/filesystem.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const enc = new TextEncoder()

async function putText(store: MemoryStore, text: string): Promise<C4ID> {
  return store.put(enc.encode(text))
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const bytes = await streamToBytes(stream)
  return new TextDecoder().decode(bytes)
}

// ---------------------------------------------------------------------------
// 1. ContentResolver
// ---------------------------------------------------------------------------

describe('ContentResolver', () => {
  describe('addSource / removeSource / listSources', () => {
    it('starts with no sources', () => {
      const resolver = new ContentResolver()
      expect(resolver.listSources()).toEqual([])
    })

    it('adds sources and lists them sorted by priority', () => {
      const resolver = new ContentResolver()
      const storeA = new MemoryStore()
      const storeB = new MemoryStore()
      resolver.addSource(storeAsSource(storeA, 'remote', 10))
      resolver.addSource(storeAsSource(storeB, 'local', 0))
      const sources = resolver.listSources()
      expect(sources).toHaveLength(2)
      expect(sources[0].name).toBe('local')
      expect(sources[0].priority).toBe(0)
      expect(sources[1].name).toBe('remote')
      expect(sources[1].priority).toBe(10)
    })

    it('removeSource removes by name', () => {
      const resolver = new ContentResolver()
      resolver.addSource(storeAsSource(new MemoryStore(), 'a', 0))
      resolver.addSource(storeAsSource(new MemoryStore(), 'b', 1))
      resolver.removeSource('a')
      const sources = resolver.listSources()
      expect(sources).toHaveLength(1)
      expect(sources[0].name).toBe('b')
    })
  })

  describe('has()', () => {
    it('returns true if any source has the content', async () => {
      const store = new MemoryStore()
      const id = await putText(store, 'hello')
      const resolver = new ContentResolver()
      resolver.addSource(storeAsSource(store, 'main', 0))
      expect(await resolver.has(id)).toBe(true)
    })

    it('returns false when no sources have the content', async () => {
      const store = new MemoryStore()
      const id = await putText(store, 'ghost')
      const resolver = new ContentResolver()
      resolver.addSource(storeAsSource(new MemoryStore(), 'empty', 0))
      expect(await resolver.has(id)).toBe(false)
    })

    it('returns false with zero sources', async () => {
      const resolver = new ContentResolver()
      const id = await identifyBytes(enc.encode('anything'))
      expect(await resolver.has(id)).toBe(false)
    })

    it('returns true if second source has it but first does not', async () => {
      const storeA = new MemoryStore()
      const storeB = new MemoryStore()
      const id = await putText(storeB, 'only-in-b')
      const resolver = new ContentResolver()
      resolver.addSource(storeAsSource(storeA, 'a', 0))
      resolver.addSource(storeAsSource(storeB, 'b', 1))
      expect(await resolver.has(id)).toBe(true)
    })
  })

  describe('get()', () => {
    it('returns content from available source', async () => {
      const store = new MemoryStore()
      const id = await putText(store, 'payload')
      const resolver = new ContentResolver()
      resolver.addSource(storeAsSource(store, 'main', 0))
      const stream = await resolver.get(id)
      const text = await readStream(stream)
      expect(text).toBe('payload')
    })

    it('throws ContentNotFoundError when no source has it', async () => {
      const resolver = new ContentResolver()
      resolver.addSource(storeAsSource(new MemoryStore(), 'empty', 0))
      const id = await identifyBytes(enc.encode('missing'))
      await expect(resolver.get(id)).rejects.toThrow(ContentNotFoundError)
    })

    it('throws ContentNotFoundError with zero sources', async () => {
      const resolver = new ContentResolver()
      const id = await identifyBytes(enc.encode('nope'))
      await expect(resolver.get(id)).rejects.toThrow(ContentNotFoundError)
    })
  })

  describe('resolve()', () => {
    it('returns stream and source name', async () => {
      const store = new MemoryStore()
      const id = await putText(store, 'content')
      const resolver = new ContentResolver()
      resolver.addSource(storeAsSource(store, 'origin', 0))
      const result = await resolver.resolve(id)
      expect(result.source).toBe('origin')
      const text = await readStream(result.stream)
      expect(text).toBe('content')
    })

    it('race mode: one of the sources wins when multiple have content', async () => {
      const storeA = new MemoryStore()
      const storeB = new MemoryStore()
      const id = await putText(storeA, 'shared')
      await storeB.put(enc.encode('shared'))
      const resolver = new ContentResolver()
      resolver.addSource(storeAsSource(storeA, 'alpha', 0))
      resolver.addSource(storeAsSource(storeB, 'beta', 1))
      const result = await resolver.resolve(id)
      expect(['alpha', 'beta']).toContain(result.source)
      const text = await readStream(result.stream)
      expect(text).toBe('shared')
    })
  })

  describe('getSequential()', () => {
    it('tries in priority order and returns first hit', async () => {
      const storeA = new MemoryStore()
      const storeB = new MemoryStore()
      const id = await putText(storeB, 'only-b')
      const resolver = new ContentResolver()
      resolver.addSource(storeAsSource(storeA, 'high-pri', 0))
      resolver.addSource(storeAsSource(storeB, 'low-pri', 10))
      const result = await resolver.getSequential(id)
      expect(result.source).toBe('low-pri')
      const text = await readStream(result.stream)
      expect(text).toBe('only-b')
    })

    it('prefers higher priority source when both have content', async () => {
      const storeA = new MemoryStore()
      const storeB = new MemoryStore()
      const id = await putText(storeA, 'data')
      await storeB.put(enc.encode('data'))
      const resolver = new ContentResolver()
      resolver.addSource(storeAsSource(storeA, 'primary', 0))
      resolver.addSource(storeAsSource(storeB, 'secondary', 10))
      const result = await resolver.getSequential(id)
      expect(result.source).toBe('primary')
    })

    it('throws ContentNotFoundError if no source has it', async () => {
      const resolver = new ContentResolver()
      resolver.addSource(storeAsSource(new MemoryStore(), 'empty', 0))
      const id = await identifyBytes(enc.encode('absent'))
      await expect(resolver.getSequential(id)).rejects.toThrow(ContentNotFoundError)
    })
  })

  describe('storeAsSource()', () => {
    it('wraps a Store correctly with name and priority', () => {
      const store = new MemoryStore()
      const source = storeAsSource(store, 'wrapped', 5)
      expect(source.name).toBe('wrapped')
      expect(source.priority).toBe(5)
    })

    it('delegates has() and get() to the underlying store', async () => {
      const store = new MemoryStore()
      const id = await putText(store, 'delegated')
      const source = storeAsSource(store, 'test', 0)
      expect(await source.has(id)).toBe(true)
      const text = await readStream(await source.get(id))
      expect(text).toBe('delegated')
    })

    it('defaults priority to 0', () => {
      const source = storeAsSource(new MemoryStore(), 'default-pri')
      expect(source.priority).toBe(0)
    })
  })
})

// ---------------------------------------------------------------------------
// 2. CompositeStore
// ---------------------------------------------------------------------------

describe('CompositeStore', () => {
  it('reads from primary first', async () => {
    const primary = new MemoryStore()
    const secondary = new MemoryStore()
    const id = await putText(primary, 'primary-data')
    const composite = new CompositeStore(primary, secondary)
    const text = await readStream(await composite.get(id))
    expect(text).toBe('primary-data')
  })

  it('falls through to secondary if primary does not have it', async () => {
    const primary = new MemoryStore()
    const secondary = new MemoryStore()
    const id = await putText(secondary, 'secondary-data')
    const composite = new CompositeStore(primary, secondary)
    const text = await readStream(await composite.get(id))
    expect(text).toBe('secondary-data')
  })

  it('writes go to primary only', async () => {
    const primary = new MemoryStore()
    const secondary = new MemoryStore()
    const composite = new CompositeStore(primary, secondary)
    const id = await composite.put(enc.encode('written'))
    expect(await primary.has(id)).toBe(true)
    expect(await secondary.has(id)).toBe(false)
  })

  it('has() checks all stores', async () => {
    const primary = new MemoryStore()
    const secondary = new MemoryStore()
    const id = await putText(secondary, 'in-secondary')
    const composite = new CompositeStore(primary, secondary)
    expect(await composite.has(id)).toBe(true)
  })

  it('has() returns false when no store has the content', async () => {
    const primary = new MemoryStore()
    const secondary = new MemoryStore()
    const composite = new CompositeStore(primary, secondary)
    const id = await identifyBytes(enc.encode('nowhere'))
    expect(await composite.has(id)).toBe(false)
  })

  it('remove() only affects primary', async () => {
    const primary = new MemoryStore()
    const secondary = new MemoryStore()
    const id = await putText(primary, 'removable')
    await secondary.put(enc.encode('removable'))
    const composite = new CompositeStore(primary, secondary)
    await composite.remove(id)
    expect(await primary.has(id)).toBe(false)
    expect(await secondary.has(id)).toBe(true)
  })

  it('throws ContentNotFoundError when neither store has content', async () => {
    const primary = new MemoryStore()
    const secondary = new MemoryStore()
    const composite = new CompositeStore(primary, secondary)
    const id = await identifyBytes(enc.encode('gone'))
    await expect(composite.get(id)).rejects.toThrow(ContentNotFoundError)
  })
})

// ---------------------------------------------------------------------------
// 3. ObservableManifest
// ---------------------------------------------------------------------------

describe('ObservableManifest', () => {
  function makeEntry(name: string, dir = false): ReturnType<typeof createEntry> {
    return createEntry({
      name: dir ? name + '/' : name,
      modeType: dir ? 'd' : '-',
      mode: dir ? 0o755 : 0o644,
      size: dir ? 0 : 100,
      depth: 0,
    })
  }

  describe('event firing', () => {
    it('addEntry fires add event', () => {
      const om = new ObservableManifest(Manifest.create())
      const events: ManifestChangeEvent[] = []
      om.on('add', (e) => events.push(e))
      const entry = makeEntry('file.txt')
      om.addEntry(entry)
      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('add')
      expect(events[0].entry).toBe(entry)
    })

    it('removeEntry fires remove event', () => {
      const om = new ObservableManifest(Manifest.create())
      const entry = makeEntry('file.txt')
      om.addEntry(entry)
      const events: ManifestChangeEvent[] = []
      om.on('remove', (e) => events.push(e))
      om.removeEntry(entry)
      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('remove')
      expect(events[0].entry).toBe(entry)
    })

    it('updateEntry fires modify event with old and new entry', () => {
      const om = new ObservableManifest(Manifest.create())
      const entry = makeEntry('file.txt')
      om.addEntry(entry)
      const events: ManifestChangeEvent[] = []
      om.on('modify', (e) => events.push(e))
      om.updateEntry(entry, { size: 999 })
      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('modify')
      expect(events[0].oldEntry!.size).toBe(100)
      expect(events[0].entry!.size).toBe(999)
    })

    it('sortEntries fires sort event', () => {
      const om = new ObservableManifest(Manifest.create())
      om.addEntry(makeEntry('b.txt'))
      om.addEntry(makeEntry('a.txt'))
      const events: ManifestChangeEvent[] = []
      om.on('sort', (e) => events.push(e))
      om.sortEntries()
      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('sort')
    })
  })

  describe('wildcard listener', () => {
    it('receives all events', () => {
      const om = new ObservableManifest(Manifest.create())
      const events: ManifestChangeEvent[] = []
      om.on('*', (e) => events.push(e))
      const entry = makeEntry('file.txt')
      om.addEntry(entry)
      om.updateEntry(entry, { size: 200 })
      om.removeEntry(entry)
      expect(events).toHaveLength(3)
      expect(events[0].type).toBe('add')
      expect(events[1].type).toBe('modify')
      expect(events[2].type).toBe('remove')
    })
  })

  describe('on() / off()', () => {
    it('on() returns unsubscribe function that works', () => {
      const om = new ObservableManifest(Manifest.create())
      const events: ManifestChangeEvent[] = []
      const unsub = om.on('add', (e) => events.push(e))
      om.addEntry(makeEntry('first.txt'))
      unsub()
      om.addEntry(makeEntry('second.txt'))
      expect(events).toHaveLength(1)
    })

    it('off() removes listener', () => {
      const om = new ObservableManifest(Manifest.create())
      const events: ManifestChangeEvent[] = []
      const listener = (e: ManifestChangeEvent) => events.push(e)
      om.on('add', listener)
      om.addEntry(makeEntry('first.txt'))
      om.off('add', listener)
      om.addEntry(makeEntry('second.txt'))
      expect(events).toHaveLength(1)
    })
  })

  describe('batch()', () => {
    it('fires single batch event with accumulated changes', () => {
      const om = new ObservableManifest(Manifest.create())
      const batchEvents: ManifestChangeEvent[] = []
      const addEvents: ManifestChangeEvent[] = []
      om.on('batch', (e) => batchEvents.push(e))
      om.on('add', (e) => addEvents.push(e))

      om.batch(() => {
        om.addEntry(makeEntry('a.txt'))
        om.addEntry(makeEntry('b.txt'))
        om.addEntry(makeEntry('c.txt'))
      })

      // Individual add events are suppressed during batch
      expect(addEvents).toHaveLength(0)
      // One batch event with all 3 changes
      expect(batchEvents).toHaveLength(1)
      expect(batchEvents[0].type).toBe('batch')
      expect(batchEvents[0].changes).toHaveLength(3)
      expect(batchEvents[0].changes![0].type).toBe('add')
      expect(batchEvents[0].changes![1].type).toBe('add')
      expect(batchEvents[0].changes![2].type).toBe('add')
    })

    it('empty batch does not fire', () => {
      const om = new ObservableManifest(Manifest.create())
      const events: ManifestChangeEvent[] = []
      om.on('batch', (e) => events.push(e))
      om.batch(() => {})
      expect(events).toHaveLength(0)
    })
  })

  describe('read delegates', () => {
    it('get() delegates to underlying manifest', () => {
      const manifest = Manifest.create()
      const entry = makeEntry('file.txt')
      manifest.addEntry(entry)
      const om = new ObservableManifest(manifest)
      expect(om.get('file.txt')).toBe(entry)
    })

    it('has() delegates to underlying manifest', () => {
      const manifest = Manifest.create()
      manifest.addEntry(makeEntry('file.txt'))
      const om = new ObservableManifest(manifest)
      expect(om.has('file.txt')).toBe(true)
      expect(om.has('missing.txt')).toBe(false)
    })

    it('entries returns the manifest entries', () => {
      const manifest = Manifest.create()
      manifest.addEntry(makeEntry('a.txt'))
      manifest.addEntry(makeEntry('b.txt'))
      const om = new ObservableManifest(manifest)
      expect(om.entries).toHaveLength(2)
    })

    it('root() returns root entries', () => {
      const manifest = Manifest.create()
      manifest.addEntry(makeEntry('a.txt'))
      manifest.addEntry(makeEntry('b.txt'))
      const om = new ObservableManifest(manifest)
      expect(om.root()).toHaveLength(2)
    })

    it('computeC4ID() delegates to underlying manifest', async () => {
      const manifest = Manifest.create()
      manifest.addEntry(makeEntry('file.txt'))
      const om = new ObservableManifest(manifest)
      const idFromOm = await om.computeC4ID()
      const idFromManifest = await manifest.computeC4ID()
      expect(idFromOm.toString()).toBe(idFromManifest.toString())
    })
  })

  describe('removeEntry edge case', () => {
    it('does not fire event for entry not in manifest', () => {
      const om = new ObservableManifest(Manifest.create())
      const events: ManifestChangeEvent[] = []
      om.on('remove', (e) => events.push(e))
      const entry = makeEntry('phantom.txt')
      om.removeEntry(entry)
      expect(events).toHaveLength(0)
    })
  })
})
