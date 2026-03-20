import type { C4ID } from './id.js'
import { identifyBytes } from './id.js'
import type { FileSystem } from './filesystem.js'
import { streamToBytes, bytesToStream, joinPath } from './filesystem.js'
import type { Store } from './store.js'
import type { Manifest } from './manifest.js'
import { type Entry, isDir } from './entry.js'

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
  const operations: ReconcileOp[] = []
  const missing: string[] = []
  const skipped: string[] = []

  // Build desired state from manifest
  const desired = new Map<string, Entry>()
  const desiredDirs = new Set<string>()
  for (const [path, entry] of manifest) {
    if (isDir(entry)) {
      desiredDirs.add(path)
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

  return { operations, missing, skipped }
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

  const ops = reconcilePlan.operations
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    const fullPath = joinPath(rootPath, op.path)

    options?.progress?.(op.type, op.path, i, ops.length)

    try {
      switch (op.type) {
        case 'mkdir':
          await fs.mkdir(fullPath, { recursive: true })
          break

        case 'create':
        case 'update': {
          if (op.entry?.c4id && store) {
            const stream = await store.get(op.entry.c4id)
            await fs.writeFile(fullPath, stream)
          }
          // Apply metadata if supported
          if (op.entry && fs.setMeta) {
            await fs.setMeta(fullPath, {
              mode: op.entry.mode,
              mtime: op.entry.timestamp,
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

  return result
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
