import type { FileSystem } from './filesystem.js'
import type { Store } from './store.js'
import { Manifest } from './manifest.js'
import { type Entry, createEntry, NULL_SIZE } from './entry.js'
import { identifyContent } from './identify-content.js'
import { streamToBytes, joinPath } from './filesystem.js'

/** Options for the scan function. */
export interface ScanOptions {
  /** Store content during scan for a single-pass ingest. */
  store?: Store
  /** Compute C4 IDs for file content. Default true. */
  computeIds?: boolean
  /** Follow symbolic links. Default false. */
  followSymlinks?: boolean
  /** Skip hidden directories (names starting with '.'). Default true. */
  skipHidden?: boolean
  /** Progress callback invoked for each file processed. */
  progress?: (path: string, filesProcessed: number) => void
}

/**
 * Scan a filesystem directory into a Manifest.
 *
 * Walks the directory tree rooted at rootPath, reads each file,
 * computes its C4 ID, and builds a sorted Manifest. Directories are
 * resolved bottom-up from their already-resolved direct children, as
 * the Go scanner does: a directory keeps its own mtime, its size is the
 * children's sizes plus the bytes of their canonical one-level listing,
 * and its C4 ID is the ID of that listing (identical to
 * `manifest.filter(<direct children>).computeC4ID()`).
 */
export async function scan(
  fs: FileSystem,
  rootPath: string,
  options?: ScanOptions,
): Promise<Manifest> {
  const computeIds = options?.computeIds ?? true
  const skipHidden = options?.skipHidden ?? true
  const followSymlinks = options?.followSymlinks ?? false

  const manifest = Manifest.create()

  await walkDir(fs, rootPath, '', 0, manifest, {
    computeIds,
    skipHidden,
    followSymlinks,
    store: options?.store,
    progress: options?.progress,
    counter: { value: 0 },
  })

  // Sort entries (files before dirs, natural sort).
  manifest.sortEntries()

  return manifest
}

/** Internal state threaded through the recursive walk. */
interface WalkState {
  computeIds: boolean
  skipHidden: boolean
  followSymlinks: boolean
  store?: Store
  progress?: (path: string, filesProcessed: number) => void
  counter: { value: number }
}

/**
 * Recursively walk a directory, adding entries to the manifest.
 * Returns the directory's direct children, fully resolved.
 */
async function walkDir(
  fs: FileSystem,
  rootPath: string,
  relDir: string,
  depth: number,
  manifest: Manifest,
  state: WalkState,
): Promise<Entry[]> {
  const absDir = relDir ? joinPath(rootPath, relDir) : rootPath

  // Collect dir entries so we can process files first, then recurse.
  const files: Array<{ name: string; relPath: string }> = []
  const dirs: Array<{ name: string; relPath: string }> = []

  for await (const dirEntry of fs.readDir(absDir)) {
    if (state.skipHidden && dirEntry.name.startsWith('.')) continue
    if (dirEntry.isSymlink && !state.followSymlinks) continue

    const relPath = relDir ? relDir + dirEntry.name : dirEntry.name

    if (dirEntry.isDirectory) {
      dirs.push({ name: dirEntry.name, relPath })
    } else {
      files.push({ name: dirEntry.name, relPath })
    }
  }

  const children: Entry[] = []

  // Process files.
  for (const file of files) {
    const fullPath = joinPath(rootPath, file.relPath)
    const stat = await fs.stat(fullPath)

    const modeType = stat.isSymlink ? 'l' : '-'
    const mode = stat.mode & 0o7777

    let c4id = null
    if (state.computeIds) {
      const stream = await fs.readFile(fullPath)
      const bytes = await streamToBytes(stream)
      c4id = await identifyContent(bytes)

      if (state.store) {
        await state.store.put(bytes)
      }
    }

    const entry = createEntry({
      mode,
      modeType,
      timestamp: stat.mtime,
      size: stat.size,
      name: file.name,
      c4id,
      depth,
    })

    manifest.addEntry(entry)
    children.push(entry)

    state.counter.value++
    state.progress?.(file.relPath, state.counter.value)
  }

  // Recurse into subdirectories.
  for (const dir of dirs) {
    const fullPath = joinPath(rootPath, dir.relPath)
    const stat = await fs.stat(fullPath)

    const mode = stat.mode & 0o7777
    const dirName = dir.name.endsWith('/') ? dir.name : dir.name + '/'

    // Directory entry: it keeps its own mtime; size and C4 ID are
    // resolved from the direct children once they are scanned.
    const entry = createEntry({
      mode,
      modeType: 'd',
      timestamp: stat.mtime,
      size: NULL_SIZE,
      name: dirName,
      depth,
    })

    manifest.addEntry(entry)
    children.push(entry)

    const direct = await walkDir(fs, rootPath, dir.relPath + '/', depth + 1, manifest, state)
    await resolveDir(entry, direct, state.computeIds)
  }

  return children
}

/**
 * Resolve a directory entry from its fully-resolved direct children:
 * first its null size (canonical propagation over [self, children]),
 * then its C4 ID — the ID of the children's canonical one-level listing.
 * An empty directory has size 0 and the ID of the empty string.
 */
async function resolveDir(dir: Entry, children: Entry[], computeIds: boolean): Promise<void> {
  const scope = Manifest.create()
  scope.entries = [dir, ...children]
  scope.canonicalize()

  if (!computeIds) return
  const listing = Manifest.create()
  listing.entries = children
  dir.c4id = await listing.computeC4ID()
}
