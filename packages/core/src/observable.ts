import type { C4ID } from './id.js'
import { Manifest } from './manifest.js'
import { type Entry, isDir } from './entry.js'

export type ManifestEventType = 'add' | 'remove' | 'modify' | 'sort' | 'batch'

export interface ManifestChangeEvent {
  type: ManifestEventType
  path?: string
  entry?: Entry
  oldEntry?: Entry
  changes?: ManifestChangeEvent[] // for batch events
}

export type ManifestChangeListener = (event: ManifestChangeEvent) => void

/**
 * Observable wrapper around a Manifest. Fires events on mutations.
 * The underlying manifest is accessible via .manifest for read operations.
 */
export class ObservableManifest {
  readonly manifest: Manifest
  private listeners: Map<ManifestEventType | '*', Set<ManifestChangeListener>>
  private batching: boolean
  private batchedChanges: ManifestChangeEvent[]

  constructor(manifest: Manifest) {
    this.manifest = manifest
    this.listeners = new Map()
    this.batching = false
    this.batchedChanges = []
  }

  /** Subscribe to an event type. '*' receives all events. Returns an unsubscribe function. */
  on(event: ManifestEventType | '*', listener: ManifestChangeListener): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)
    return () => this.off(event, listener)
  }

  /** Remove a listener. */
  off(event: ManifestEventType | '*', listener: ManifestChangeListener): void {
    const set = this.listeners.get(event)
    if (!set) return
    set.delete(listener)
    if (set.size === 0) this.listeners.delete(event)
  }

  /** Add an entry. Fires 'add'. */
  addEntry(entry: Entry): void {
    this.manifest.addEntry(entry)
    const path = this.manifest.entryPath(entry)
    this.emit({ type: 'add', path, entry })
  }

  /** Remove an entry. Fires 'remove'. */
  removeEntry(entry: Entry): void {
    const path = this.manifest.entryPath(entry)
    const idx = this.manifest.entries.indexOf(entry)
    if (idx === -1) return
    this.manifest.removeEntry(entry)
    this.emit({ type: 'remove', path, entry })
  }

  /** Update fields on an entry. Fires 'modify' with the old snapshot. */
  updateEntry(entry: Entry, updates: Partial<Entry>): void {
    const idx = this.manifest.entries.indexOf(entry)
    if (idx === -1) return
    const oldEntry = { ...entry }
    const path = this.manifest.entryPath(entry)
    Object.assign(entry, updates)
    // Invalidate the manifest's tree index since entry data changed.
    // The simplest way: remove and re-add at the same position.
    this.manifest.entries.splice(idx, 1, entry)
    this.manifest.invalidateIndex()
    this.emit({ type: 'modify', path, entry, oldEntry })
  }

  /** Sort entries. Fires 'sort'. */
  sortEntries(): void {
    this.manifest.sortEntries()
    this.emit({ type: 'sort' })
  }

  /** Accumulate changes during fn, then fire a single 'batch' event. */
  batch(fn: () => void): void {
    if (this.batching) {
      // Already inside a batch, just run; inner events still accumulate.
      fn()
      return
    }
    this.batching = true
    this.batchedChanges = []
    try {
      fn()
    } finally {
      this.batching = false
      const changes = this.batchedChanges
      this.batchedChanges = []
      if (changes.length > 0) {
        this.emit({ type: 'batch', changes })
      }
    }
  }

  // ---- Read delegates ----

  get entries(): readonly Entry[] {
    return this.manifest.entries
  }

  get(path: string): Entry | undefined {
    return this.manifest.get(path)
  }

  has(path: string): boolean {
    return this.manifest.has(path)
  }

  getByName(name: string): Entry | undefined {
    return this.manifest.getByName(name)
  }

  entryPath(e: Entry): string {
    return this.manifest.entryPath(e)
  }

  children(e: Entry): Entry[] {
    return this.manifest.children(e)
  }

  parent(e: Entry): Entry | undefined {
    return this.manifest.parent(e)
  }

  root(): Entry[] {
    return this.manifest.root()
  }

  files(): Iterable<[string, Entry]> {
    return this.manifest.files()
  }

  directories(): Iterable<[string, Entry]> {
    return this.manifest.directories()
  }

  filter(predicate: (path: string, entry: Entry) => boolean): Manifest {
    return this.manifest.filter(predicate)
  }

  duplicates(): Map<string, string[]> {
    return this.manifest.duplicates()
  }

  summary(): string {
    return this.manifest.summary()
  }

  hasNullValues(): boolean {
    return this.manifest.hasNullValues()
  }

  computeC4ID(): Promise<C4ID> {
    return this.manifest.computeC4ID()
  }

  // ---- Private ----

  private emit(event: ManifestChangeEvent): void {
    if (this.batching && event.type !== 'batch') {
      this.batchedChanges.push(event)
      return
    }

    const typed = this.listeners.get(event.type)
    if (typed) {
      for (const listener of typed) listener(event)
    }

    const wildcard = this.listeners.get('*')
    if (wildcard) {
      for (const listener of wildcard) listener(event)
    }
  }
}
