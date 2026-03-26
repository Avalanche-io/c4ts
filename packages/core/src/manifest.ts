import { C4ID, identifyBytes } from './id.js'
import {
  type Entry,
  createEntry,
  isDir,
  hasNullValues,
  canonicalEntry,
  FlowDirection,
} from './entry.js'
import { naturalLess } from './naturalsort.js'
import {
  InvalidEntryError,
  DuplicatePathError,
  PathTraversalError,
} from './errors.js'
import { decode, type DecodeResult } from './decoder.js'
import { encode } from './encoder.js'
import { applyPatch } from './diff.js'

/** Check if a name contains path semantics (invalid for c4m entries). */
function isPathName(name: string): boolean {
  if (name === '') return true
  const base = name.endsWith('/') ? name.slice(0, -1) : name
  if (base === '') return true
  if (base === '.' || base === '..') return true
  if (base.includes('/') || base.includes('\\') || base.includes('\0')) return true
  return false
}

/** Tree index for O(1) path lookups. */
interface TreeIndex {
  byPath: Map<string, Entry>
  byName: Map<string, Entry>
  pathOf: Map<Entry, string>
  children: Map<Entry, Entry[]>
  parent: Map<Entry, Entry>
  root: Entry[]
}

/** C4M Manifest — a self-contained description of a filesystem. */
export class Manifest {
  version: string = '1.0'
  base: C4ID | null = null
  entries: Entry[] = []
  rangeData: Map<string, string> = new Map()  // C4ID string -> inline ID list

  private _index: TreeIndex | null = null

  /** Create a new empty manifest. */
  static create(): Manifest {
    return new Manifest()
  }

  /** Parse c4m text into a Manifest. */
  static async parse(text: string): Promise<Manifest> {
    const result = await decode(text)

    // If there are patch boundaries, apply patch semantics.
    // Boundary IDs are block links (the ID of the previous block) — recorded
    // but not verified, making this O(1) instead of O(n).
    if (result.patchBoundaries.length > 0) {
      // First section is the base entries
      let accumulated = new Manifest()
      accumulated.version = result.version
      accumulated.base = result.base
      accumulated.entries = result.sections[0] ?? []
      accumulated.rangeData = result.rangeData

      // Apply each patch section in sequence
      for (let i = 0; i < result.patchBoundaries.length; i++) {
        // The next section (i+1) contains patch entries
        const patchSection = result.sections[i + 1]
        if (patchSection && patchSection.length > 0) {
          const patchManifest = new Manifest()
          patchManifest.entries = patchSection
          accumulated = applyPatch(accumulated, patchManifest)
          accumulated.rangeData = result.rangeData
        }
      }

      return accumulated
    }

    // Non-patch mode: simple assembly
    const m = new Manifest()
    m.version = result.version
    m.base = result.base
    m.entries = result.entries
    m.rangeData = result.rangeData
    return m
  }

  /** Invalidate the tree index, forcing it to be rebuilt on next access. */
  invalidateIndex(): void {
    this._index = null
  }

  /** Add an entry. */
  addEntry(e: Entry): void {
    this.entries.push(e)
    this._index = null
  }

  /** Remove an entry by reference equality. */
  removeEntry(e: Entry): void {
    const idx = this.entries.indexOf(e)
    if (idx !== -1) {
      this.entries.splice(idx, 1)
      this._index = null
    }
  }

  /** Sort entries: files before directories at each level, natural sort within groups. */
  sortEntries(): void {
    this.sortSiblingsHierarchically()
  }

  /** Returns the canonical text form (top-level entries only, sorted). */
  canonical(): string {
    // Find minimum depth
    let minDepth = -1
    for (const entry of this.entries) {
      if (minDepth === -1 || entry.depth < minDepth) {
        minDepth = entry.depth
      }
    }
    if (minDepth === -1) return ''

    // Collect top-level entries
    const topLevel: Entry[] = []
    for (const entry of this.entries) {
      if (entry.depth === minDepth) {
        topLevel.push(entry)
      }
    }

    // Sort
    topLevel.sort((a, b) => {
      const aIsDir = isDir(a)
      const bIsDir = isDir(b)
      if (aIsDir !== bIsDir) return aIsDir ? 1 : -1
      return naturalLess(a.name, b.name) ? -1 : naturalLess(b.name, a.name) ? 1 : 0
    })

    return topLevel.map(e => canonicalEntry(e) + '\n').join('')
  }

  /** Compute the C4 ID of this manifest. */
  async computeC4ID(): Promise<C4ID> {
    const copy = this.copy()
    copy.canonicalize()
    const text = copy.canonical()
    const encoder = new TextEncoder()
    return identifyBytes(encoder.encode(text))
  }

  /** Propagate metadata from children to parents. */
  canonicalize(): void {
    propagateMetadata(this.entries)
  }

  /** Deep copy. */
  copy(): Manifest {
    const cp = new Manifest()
    cp.version = this.version
    cp.base = this.base
    cp.entries = this.entries.map(e => ({ ...e }))
    cp.rangeData = new Map(this.rangeData)
    return cp
  }

  /** Check if any entries have null values. */
  hasNullValues(): boolean {
    return this.entries.some(hasNullValues)
  }

  /** Get entry by full path (e.g. "src/main.go"). */
  get(path: string): Entry | undefined {
    return this.ensureIndex().byPath.get(path)
  }

  /** Check if a path exists. */
  has(path: string): boolean {
    return this.ensureIndex().byPath.has(path)
  }

  /** Get entry by bare name. */
  getByName(name: string): Entry | undefined {
    return this.ensureIndex().byName.get(name)
  }

  /** Get the full path of an entry. */
  entryPath(e: Entry): string {
    return this.ensureIndex().pathOf.get(e) ?? ''
  }

  /** Get direct children of a directory entry. */
  children(e: Entry): Entry[] {
    if (!isDir(e)) return []
    return this.ensureIndex().children.get(e) ?? []
  }

  /** Get parent of an entry. */
  parent(e: Entry): Entry | undefined {
    return this.ensureIndex().parent.get(e)
  }

  /** Get root-level entries. */
  root(): Entry[] {
    return this.ensureIndex().root
  }

  /** Iterate all file entries with their full paths. */
  *files(): Iterable<[string, Entry]> {
    const idx = this.ensureIndex()
    for (const entry of this.entries) {
      if (!isDir(entry)) {
        yield [idx.pathOf.get(entry) ?? entry.name, entry]
      }
    }
  }

  /** Iterate all directory entries with their full paths. */
  *directories(): Iterable<[string, Entry]> {
    const idx = this.ensureIndex()
    for (const entry of this.entries) {
      if (isDir(entry)) {
        yield [idx.pathOf.get(entry) ?? entry.name, entry]
      }
    }
  }

  /** Filter entries by glob pattern or predicate. */
  filter(predicate: (path: string, entry: Entry) => boolean): Manifest {
    const idx = this.ensureIndex()
    const filtered = new Manifest()
    filtered.version = this.version
    for (const entry of this.entries) {
      const path = idx.pathOf.get(entry) ?? entry.name
      if (predicate(path, entry)) {
        filtered.entries.push({ ...entry })
      }
    }
    return filtered
  }

  /** Find entries sharing the same C4 ID. */
  duplicates(): Map<string, string[]> {
    const idx = this.ensureIndex()
    const idMap = new Map<string, string[]>()
    for (const entry of this.entries) {
      if (entry.c4id && !entry.c4id.isNil() && !isDir(entry)) {
        const key = entry.c4id.toString()
        const path = idx.pathOf.get(entry) ?? entry.name
        const existing = idMap.get(key)
        if (existing) {
          existing.push(path)
        } else {
          idMap.set(key, [path])
        }
      }
    }
    // Only return entries with duplicates
    const result = new Map<string, string[]>()
    for (const [key, paths] of idMap) {
      if (paths.length > 1) result.set(key, paths)
    }
    return result
  }

  /** Summary string: "N files, M dirs, X bytes" */
  summary(): string {
    let fileCount = 0
    let dirCount = 0
    let totalSize = 0
    let hasNull = false
    for (const entry of this.entries) {
      if (isDir(entry)) {
        dirCount++
      } else {
        fileCount++
        if (entry.size >= 0) totalSize += entry.size
        else hasNull = true
      }
    }
    const sizeStr = hasNull ? 'unknown' : formatBytes(totalSize)
    return `${fileCount} files, ${dirCount} dirs, ${sizeStr}`
  }

  /** Validate the manifest for structural errors. */
  validate(): void {
    const seen = new Set<string>()
    const dirStack: string[] = []

    for (const e of this.entries) {
      if (e.name === '') throw new InvalidEntryError('empty name')
      if (isPathName(e.name)) throw new PathTraversalError(e.name)

      while (dirStack.length > e.depth) dirStack.pop()

      const fullPath = dirStack.join('') + e.name
      if (seen.has(fullPath)) throw new DuplicatePathError(fullPath)
      seen.add(fullPath)

      if (isDir(e)) {
        while (dirStack.length <= e.depth) dirStack.push('')
        dirStack[e.depth] = e.name
      }
    }
  }

  /** Encode to c4m text. */
  encode(options?: { pretty?: boolean; indentWidth?: number }): string {
    return encode(this, options)
  }

  /** Iterable protocol — yields [path, entry] pairs. */
  *[Symbol.iterator](): Iterator<[string, Entry]> {
    const idx = this.ensureIndex()
    for (const entry of this.entries) {
      yield [idx.pathOf.get(entry) ?? entry.name, entry]
    }
  }

  // ---- Private ----

  private ensureIndex(): TreeIndex {
    if (this._index) return this._index

    const idx: TreeIndex = {
      byPath: new Map(),
      byName: new Map(),
      pathOf: new Map(),
      children: new Map(),
      parent: new Map(),
      root: [],
    }

    // First pass
    for (const e of this.entries) {
      idx.byName.set(e.name, e)
      if (e.depth === 0) idx.root.push(e)
    }

    // Second pass: parent-child
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]
      if (e.depth === 0) continue
      for (let j = i - 1; j >= 0; j--) {
        const candidate = this.entries[j]
        if (candidate.depth === e.depth - 1 && isDir(candidate)) {
          idx.parent.set(e, candidate)
          const kids = idx.children.get(candidate) ?? []
          kids.push(e)
          idx.children.set(candidate, kids)
          break
        }
        if (candidate.depth < e.depth - 1) break
      }
    }

    // Third pass: full paths
    for (const e of this.entries) {
      const parts: string[] = []
      let current: Entry | undefined = e
      while (current) {
        parts.push(current.name)
        current = idx.parent.get(current)
      }
      parts.reverse()
      const fullPath = parts.join('')
      idx.byPath.set(fullPath, e)
      idx.pathOf.set(e, fullPath)
    }

    this._index = idx
    return idx
  }

  private sortSiblingsHierarchically(): void {
    if (this.entries.length === 0) return

    const result: Entry[] = []
    const used = new Array(this.entries.length).fill(false)

    const processLevel = (parentIdx: number, parentDepth: number) => {
      const childDepth = parentIdx === -1 ? 0 : parentDepth + 1
      const startIdx = parentIdx === -1 ? 0 : parentIdx + 1

      interface Child { entry: Entry; index: number }
      const children: Child[] = []

      for (let i = startIdx; i < this.entries.length; i++) {
        if (used[i]) continue
        const entry = this.entries[i]
        if (entry.depth < childDepth) break
        if (entry.depth > childDepth) continue
        children.push({ entry, index: i })
      }

      // Deduplicate by name
      const seen = new Map<string, number>()
      const deduped: Child[] = []
      for (const c of children) {
        const existing = seen.get(c.entry.name)
        if (existing !== undefined) {
          used[deduped[existing].index] = true
          deduped[existing] = c
        } else {
          seen.set(c.entry.name, deduped.length)
          deduped.push(c)
        }
      }

      // Sort: files before dirs, then natural sort
      deduped.sort((a, b) => {
        const aIsDir = isDir(a.entry)
        const bIsDir = isDir(b.entry)
        if (aIsDir !== bIsDir) return aIsDir ? 1 : -1
        return naturalLess(a.entry.name, b.entry.name) ? -1
          : naturalLess(b.entry.name, a.entry.name) ? 1 : 0
      })

      for (const c of deduped) {
        used[c.index] = true
        result.push(c.entry)
        if (isDir(c.entry)) {
          processLevel(c.index, c.entry.depth)
        }
      }
    }

    processLevel(-1, -1)

    // Orphaned entries
    for (let i = 0; i < this.entries.length; i++) {
      if (!used[i]) result.push(this.entries[i])
    }

    this.entries = result
    this._index = null
  }
}

// ---- Metadata Propagation ----

function propagateMetadata(entries: Entry[]): void {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (!isDir(entry)) continue

    // Robust null check: size may be -1, null, or undefined at runtime.
    const needsSize = !(entry.size >= 0)
    const needsTimestamp = entry.timestamp.getTime() === 0

    if (!needsSize && !needsTimestamp) continue

    const children = getDirectoryChildren(entries, entry)
    if (needsSize) {
      entry.size = calculateDirectorySize(children)
    }
    if (needsTimestamp) {
      entry.timestamp = getMostRecentModtime(children)
    }
  }
}

function getDirectoryChildren(entries: Entry[], dir: Entry): Entry[] {
  const children: Entry[] = []
  let collecting = false
  for (const e of entries) {
    if (e === dir) { collecting = true; continue }
    if (collecting) {
      if (e.depth === dir.depth + 1) children.push(e)
      else if (e.depth <= dir.depth) break
    }
  }
  return children
}

function calculateDirectorySize(entries: Entry[]): number {
  let total = 0
  for (const e of entries) {
    if (!(e.size >= 0)) return -1
    total += e.size
  }
  total += c4mContentSize(entries)
  return total
}

/** Byte length of the canonical c4m text for one directory level. */
function c4mContentSize(entries: Entry[]): number {
  const encoder = new TextEncoder()
  let n = 0
  for (const e of entries) {
    n += encoder.encode(canonicalEntry(e)).byteLength + 1 // +1 for '\n'
  }
  return n
}

function getMostRecentModtime(entries: Entry[]): Date {
  let mostRecent = new Date(0)
  for (const e of entries) {
    if (e.timestamp.getTime() === 0) return new Date(0)
    if (e.timestamp > mostRecent) mostRecent = e.timestamp
  }
  return mostRecent.getTime() === 0 ? new Date(0) : mostRecent
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const val = bytes / Math.pow(1024, i)
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}
