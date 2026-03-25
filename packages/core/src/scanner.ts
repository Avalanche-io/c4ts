import type { FileSystem } from './filesystem.js'
import type { Store } from './store.js'
import { Manifest } from './manifest.js'
import { createEntry } from './entry.js'
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
 * computes its C4 ID, and builds a sorted Manifest with proper
 * directory metadata propagated bottom-up.
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

  // Propagate directory sizes and timestamps bottom-up.
  manifest.canonicalize()

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

/** Recursively walk a directory, adding entries to the manifest. */
async function walkDir(
  fs: FileSystem,
  rootPath: string,
  relDir: string,
  depth: number,
  manifest: Manifest,
  state: WalkState,
): Promise<void> {
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

    state.counter.value++
    state.progress?.(file.relPath, state.counter.value)
  }

  // Recurse into subdirectories.
  for (const dir of dirs) {
    const fullPath = joinPath(rootPath, dir.relPath)
    const stat = await fs.stat(fullPath)

    const mode = stat.mode & 0o7777
    const dirName = dir.name.endsWith('/') ? dir.name : dir.name + '/'

    // Directory entry — size and timestamp will be propagated later.
    const entry = createEntry({
      mode,
      modeType: 'd',
      timestamp: new Date(0),
      size: -1,
      name: dirName,
      depth,
    })

    manifest.addEntry(entry)

    await walkDir(fs, rootPath, dir.relPath + '/', depth + 1, manifest, state)
  }
}
