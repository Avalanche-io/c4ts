import type { FileSystem } from './filesystem.js'
import type { Store } from './store.js'
import { Manifest } from './manifest.js'
import type { C4ID } from './id.js'
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
    linkChain: new Set([cleanPath(rootPath)]),
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
  // Directories being resolved: the scan root and every directory reached
  // through a link above the current one (the cycle guard).
  linkChain: Set<string>
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
  const links: Array<{ name: string; relPath: string }> = []

  for await (const dirEntry of fs.readDir(absDir)) {
    if (state.skipHidden && dirEntry.name.startsWith('.')) continue

    const relPath = relDir ? relDir + dirEntry.name : dirEntry.name

    if (dirEntry.isSymlink && !state.followSymlinks) {
      // A link is recorded as itself, as the Go scanner records it: its own
      // mode, mtime and size, and its target. Through 1.0.26 c4ts dropped
      // every link from a scan, so a tree holding one had a C4 ID no other
      // implementation computes. A filesystem that cannot read links (no
      // lstat or readLink) has none to record.
      if (fs.lstat && fs.readLink) links.push({ name: dirEntry.name, relPath })
      continue
    }

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

  // Record symbolic links.
  for (const link of links) {
    const fullPath = joinPath(rootPath, link.relPath)
    const stat = await fs.lstat!(fullPath)
    let target: string | null = null
    try {
      target = await fs.readLink!(fullPath)
    } catch {
      // A link whose target cannot be read keeps a null ID and an empty
      // target; this line has no read-error report (main's onReadError).
    }
    const c4id = state.computeIds && target !== null
      ? await linkTargetID(fs, fullPath, target, state)
      : null
    const entry = createEntry({
      mode: stat.mode & 0o7777,
      modeType: 'l',
      timestamp: stat.mtime,
      size: stat.size,
      name: link.name,
      target: target ?? '',
      c4id,
      depth,
    })
    manifest.addEntry(entry)
    children.push(entry)
    state.counter.value++
    state.progress?.(link.relPath, state.counter.value)
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
 * Normalise a "/"-separated path: drop "." segments and empty ones, and
 * resolve ".." against the segment before it. A leading "/" is kept.
 */
function cleanPath(p: string): string {
  const abs = p.startsWith('/')
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop()
    else if (seg === '..' && abs) continue
    else out.push(seg)
  }
  return (abs ? '/' : '') + out.join('/')
}

/**
 * The C4 ID of a symbolic link, by the Go scanner's rules: a link to a
 * regular file carries the file's ID; a link to a directory carries the ID
 * of that directory scanned; a link that is dangling, or names another
 * link, has none. A link naming a directory already being resolved (the
 * scan's root, or a directory reached through a link above it, as
 * `up -> ..` and `here -> .` do) has none too: that scan would meet the
 * link again, and no fixed point exists.
 */
async function linkTargetID(fs: FileSystem, linkPath: string, target: string, state: WalkState): Promise<C4ID | null> {
  const isAbs = target.startsWith('/') || /^[A-Za-z]:\//.test(target)
  const slash = linkPath.lastIndexOf('/')
  const targetPath = cleanPath(isAbs ? target : (slash >= 0 ? linkPath.slice(0, slash + 1) : '') + target)
  let info
  try {
    info = await fs.lstat!(targetPath)
  } catch {
    return null
  }
  if (info.isSymlink) return null
  if (info.isDirectory) {
    if (state.linkChain.has(targetPath)) return null
    const sub = Manifest.create()
    await walkDir(fs, targetPath, '', 0, sub, {
      ...state,
      progress: undefined,
      counter: { value: 0 },
      linkChain: new Set([...state.linkChain, targetPath]),
    })
    sub.sortEntries()
    return sub.computeC4ID()
  }
  try {
    return await identifyContent(await streamToBytes(await fs.readFile(targetPath)))
  } catch {
    return null
  }
}

/**
 * Resolve a directory entry from its fully-resolved direct children:
 * first its null size (canonical propagation over [self, children]),
 * then its C4 ID — the ID of the children's canonical one-level listing.
 * An empty directory has size 0 and the ID of the empty string.
 */
async function resolveDir(dir: Entry, children: Entry[], computeIds: boolean): Promise<void> {
  // The ID first: the scanner read this directory, so an empty one carries
  // the empty-listing ID, which is what tells propagation it is empty (size
  // 0) rather than unread (a childless directory with no ID keeps a null
  // size). The children are final, so their listing is too.
  if (computeIds) {
    const listing = Manifest.create()
    listing.entries = children
    dir.c4id = await listing.computeC4ID()
  } else if (children.length === 0) {
    // Without IDs a directory listed with no children is still empty by
    // observation: its size is a stated 0 and its ID stays null, ordinary
    // partial knowledge. A stated size is kept by propagation, so the
    // output is byte-identical to 1.0.26's. (1.1 states the empty
    // listing's ID here; the lines differ only in that column.)
    dir.size = 0
  }

  const scope = Manifest.create()
  scope.entries = [dir, ...children]
  scope.canonicalize()
}
