import type { C4ID } from './id.js'
import { identifyBytes } from './id.js'
import type { FileSystem } from './filesystem.js'
import { streamToBytes, bytesToStream, joinPath } from './filesystem.js'
import type { Store } from './store.js'
import type { Manifest } from './manifest.js'
import { type Entry, isDir, NULL_TIMESTAMP, timestampIsNull } from './entry.js'
import { C4Error } from './errors.js'

/** Types of operations the reconciler can perform. */
export type ReconcileOpType = 'mkdir' | 'create' | 'update' | 'remove' | 'rmdir'

/** A single reconciliation operation. */
export interface ReconcileOp {
  type: ReconcileOpType
  path: string
  entry?: Entry
}

/** Plan computed by the reconciler before execution. */
export interface ReconcilePlan {
  operations: ReconcileOp[]
  missing: string[]    // C4 IDs needed but not in store
  skipped: string[]    // paths already correct
  /**
   * Every directory the c4m holds, with its entry. apply sets each one's
   * recorded time and mode after all operations, deepest first, because
   * writing a child changes a directory's mtime on a real filesystem.
   */
  directories?: Array<{ path: string; entry: Entry }>
}

/** Result of executing a reconciliation plan. */
export interface ReconcileResult {
  created: number
  updated: number
  removed: number
  skipped: number
  errors: Array<{ path: string; error: Error }>
}

export interface ReconcileOptions {
  progress?: (op: ReconcileOpType, path: string, index: number, total: number) => void
  dryRun?: boolean
}

/**
 * Plan reconciliation: determine what operations are needed to make
 * the filesystem at rootPath match the manifest.
 */
export async function plan(
  manifest: Manifest,
  fs: FileSystem,
  rootPath: string,
  store?: Store,
): Promise<ReconcilePlan> {
  refuseFoldedRanges(manifest)
  const operations: ReconcileOp[] = []
  const missing: string[] = []
  const skipped: string[] = []

  // Build desired state from manifest
  const desired = new Map<string, Entry>()
  const desiredDirs = new Set<string>()
  const directories: Array<{ path: string; entry: Entry }> = []
  for (const [path, entry] of manifest) {
    if (isDir(entry)) {
      desiredDirs.add(path)
      directories.push({ path, entry })
    } else {
      desired.set(path, entry)
    }
  }

  // Collect what actually exists on disk
  const actual = new Map<string, boolean>() // path -> isDir
  await collectExisting(fs, rootPath, '', actual)

  // Phase 1: directories to create (sorted by depth for correct ordering)
  const sortedDirs = [...desiredDirs].sort()
  for (const dir of sortedDirs) {
    const fullPath = joinPath(rootPath, dir)
    try {
      const stat = await fs.stat(fullPath)
      if (!stat.isDirectory) {
        operations.push({ type: 'remove', path: dir })
        operations.push({ type: 'mkdir', path: dir })
      }
    } catch {
      operations.push({ type: 'mkdir', path: dir })
    }
  }

  // Phase 2: files to create or update
  for (const [path, entry] of desired) {
    const fullPath = joinPath(rootPath, path)

    try {
      const stat = await fs.stat(fullPath)
      if (stat.isDirectory) {
        // Directory exists where file should be — remove first
        operations.push({ type: 'remove', path })
        operations.push({ type: 'create', path, entry })
      } else if (entry.c4id) {
        // File exists — check if content matches
        const stream = await fs.readFile(fullPath)
        const bytes = await streamToBytes(stream)
        const actualId = await identifyBytes(bytes)
        if (actualId.equals(entry.c4id)) {
          skipped.push(path)
        } else {
          // Check store has the content
          if (store && !(await store.has(entry.c4id))) {
            missing.push(entry.c4id.toString())
          }
          operations.push({ type: 'update', path, entry })
        }
      } else {
        skipped.push(path) // no C4 ID to compare against
      }
    } catch {
      // File doesn't exist — create it
      if (entry.c4id && store && !(await store.has(entry.c4id))) {
        missing.push(entry.c4id.toString())
      }
      operations.push({ type: 'create', path, entry })
    }
  }

  // Phase 3: files/dirs to remove (on disk but not in manifest)
  const desiredPaths = new Set([...desired.keys(), ...desiredDirs])
  const toRemove: string[] = []
  for (const [path, pathIsDir] of actual) {
    // Normalize: directory paths in manifest end with /
    const manifestPath = pathIsDir ? (path.endsWith('/') ? path : path + '/') : path
    if (!desiredPaths.has(manifestPath) && !desiredPaths.has(path)) {
      toRemove.push(path)
    }
  }
  // Sort removals deepest-first so children are removed before parents
  toRemove.sort((a, b) => b.split('/').length - a.split('/').length)
  for (const path of toRemove) {
    const isDirectory = actual.get(path)
    operations.push({ type: isDirectory ? 'rmdir' : 'remove', path })
  }

  return { operations, missing, skipped, directories }
}

/**
 * Execute a reconciliation plan.
 */
export async function apply(
  reconcilePlan: ReconcilePlan,
  fs: FileSystem,
  rootPath: string,
  store?: Store,
  options?: ReconcileOptions,
): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    created: 0,
    updated: 0,
    removed: 0,
    skipped: reconcilePlan.skipped.length,
    errors: [],
  }

  const made = new Set<string>() // directories this apply created
  const ops = reconcilePlan.operations
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    const fullPath = joinPath(rootPath, op.path)

    options?.progress?.(op.type, op.path, i, ops.length)

    try {
      switch (op.type) {
        case 'mkdir':
          await fs.mkdir(fullPath, { recursive: true })
          made.add(op.path)
          break

        case 'create':
        case 'update': {
          if (op.entry?.c4id && store) {
            const stream = await store.get(op.entry.c4id)
            await fs.writeFile(fullPath, stream)
          }
          // Apply metadata if supported. This apply wrote the file's content
          // (a create, or an overwrite of different content, both fresh in
          // core's apply, dfd6e12), so a null timestamp becomes the epoch,
          // which scans back as null.
          if (op.entry && fs.setMeta) {
            await fs.setMeta(fullPath, {
              mode: op.entry.mode,
              mtime: timestampIsNull(op.entry.timestamp) ? NULL_TIMESTAMP : op.entry.timestamp,
            })
          }
          if (op.type === 'create') result.created++
          else result.updated++
          break
        }

        case 'remove':
          await fs.remove(fullPath)
          result.removed++
          break

        case 'rmdir':
          await fs.remove(fullPath, { recursive: true })
          result.removed++
          break
      }
    } catch (err) {
      result.errors.push({ path: op.path, error: err as Error })
    }
  }

  // Post-pass: each directory's recorded time and mode, set after every
  // child is written and deepest first, so setting a child directory does
  // not move its parent's time again. A directory's timestamp and mode are
  // part of its parent's listing, so without this the tree does not read
  // back at the c4m's ID. Through 2026-11-16 directories kept the time they
  // were made, so a checkout in a later second than the scan left every
  // directory holding a subdirectory modified. A null timestamp on a
  // directory this apply made becomes the epoch, so it reads back null; on
  // one that already existed a null never overwrites, nor does a null mode
  // (core reconcile/apply.go setMetadata, dfd6e12). Through 1.0.26 a
  // directory made from a null timestamp kept the time it was made.
  if (fs.setMeta && reconcilePlan.directories) {
    const dirs = [...reconcilePlan.directories].sort(
      (a, b) => b.path.split('/').length - a.path.split('/').length,
    )
    for (const { path, entry } of dirs) {
      const nullTime = timestampIsNull(entry.timestamp)
      const mtime = nullTime ? (made.has(path) ? NULL_TIMESTAMP : undefined) : entry.timestamp
      const mode = nullModeOnThisLine(entry) ? undefined : entry.mode
      if (mtime === undefined && mode === undefined) continue
      try {
        await fs.setMeta(joinPath(rootPath, path), { mode, mtime })
      } catch (err) {
        result.errors.push({ path, error: err as Error })
      }
    }
  }

  return result
}

/**
 * Refuse a manifest holding a folded range, before anything is written.
 * A folded range is one line standing for numbered frames
 * (`frame.[0001-0100].exr`); writing it back means expanding it from its ID
 * list into one file per frame, and c4ts has no expander. Without this check
 * the range line was written as a single file under the range's name,
 * holding the ID list's bytes, and counted as created. plan() is the gate
 * for reconcile and Workspace.checkout alike, the dry run included.
 */
function refuseFoldedRanges(manifest: Manifest): void {
  const folded: string[] = []
  for (const [path, entry] of manifest) {
    if (entry.isSequence) folded.push(path)
  }
  if (folded.length > 0) {
    throw new C4Error(
      "this version of c4ts can't write a folded range back to files, so nothing was written; " +
        'use a description made without folding (c4 id without -S). Folded ranges: ' +
        folded.join(', '),
    )
  }
}

/**
 * On the 1.0.x line a null mode is mode 0 with type '-' (entry.ts
 * hasNullValues); this line's decoder reads a known zero the same way.
 */
function nullModeOnThisLine(entry: Entry): boolean {
  return entry.mode === 0 && entry.modeType === '-'
}

/** Recursively collect all paths that exist on disk. */
async function collectExisting(
  fs: FileSystem,
  rootPath: string,
  relativePath: string,
  result: Map<string, boolean>,
): Promise<void> {
  const fullPath = relativePath ? joinPath(rootPath, relativePath) : rootPath
  try {
    for await (const entry of fs.readDir(fullPath)) {
      // Skip hidden files/dirs
      if (entry.name.startsWith('.')) continue

      const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name
      result.set(childRelative, entry.isDirectory)

      if (entry.isDirectory) {
        await collectExisting(fs, rootPath, childRelative, result)
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable — skip
  }
}
