import type { C4ID } from './id.js'
import { parse as parseC4ID } from './id.js'
import type { FileSystem } from './filesystem.js'
import { joinPath, streamToBytes, bytesToStream } from './filesystem.js'
import type { Store } from './store.js'
import { Manifest } from './manifest.js'
import { isDir } from './entry.js'

/** Result of a pool (bundle) operation. */
export interface PoolResult {
  copied: number
  skipped: number
  missing: number
  manifestPath: string
}

/** Result of an ingest (absorb) operation. */
export interface IngestResult {
  copied: number
  skipped: number
  manifests: string[]
}

export interface PoolOptions {
  progress?: (c4id: string, index: number, total: number) => void
  manifestName?: string  // default: 'manifest.c4m'
}

/**
 * Bundle a manifest with its referenced content for portable transfer.
 *
 * Creates:
 *   outputDir/
 *     <name>.c4m        — the manifest
 *     objects/           — content store (flat, keyed by C4 ID string)
 */
export async function pool(
  manifest: Manifest,
  outputDir: string,
  fs: FileSystem,
  store: Store,
  options?: PoolOptions,
): Promise<PoolResult> {
  const name = options?.manifestName ?? 'manifest.c4m'
  const objectsDir = joinPath(outputDir, 'objects')
  let copied = 0
  let skipped = 0
  let missing = 0

  // Create output structure
  await fs.mkdir(outputDir, { recursive: true })
  await fs.mkdir(objectsDir, { recursive: true })

  // Write manifest
  const c4mText = manifest.encode()
  const c4mBytes = new TextEncoder().encode(c4mText)
  const manifestPath = joinPath(outputDir, name)
  await fs.writeFile(manifestPath, c4mBytes)

  // Collect unique C4 IDs from manifest
  const ids = new Set<string>()
  for (const [, entry] of manifest) {
    if (!isDir(entry) && entry.c4id && !entry.c4id.isNil()) {
      ids.add(entry.c4id.toString())
    }
  }

  // Copy objects
  const idList = [...ids]
  for (let i = 0; i < idList.length; i++) {
    const idStr = idList[i]
    options?.progress?.(idStr, i, idList.length)

    const objectPath = joinPath(objectsDir, idStr)

    // Check if already in bundle
    try {
      await fs.stat(objectPath)
      skipped++
      continue
    } catch { /* doesn't exist, proceed */ }

    // Copy from store
    try {
      const c4id = parseC4ID(idStr)
      if (await store.has(c4id)) {
        const stream = await store.get(c4id)
        await fs.writeFile(objectPath, stream)
        copied++
      } else {
        missing++
      }
    } catch {
      missing++
    }
  }

  return { copied, skipped, missing, manifestPath }
}

/**
 * Absorb a pool bundle into a local store.
 * Reads objects from bundleDir/objects/ and puts them in the store.
 * Returns paths to any .c4m files found in the bundle.
 */
export async function ingest(
  bundleDir: string,
  fs: FileSystem,
  store: Store,
  options?: { progress?: (path: string, index: number, total: number) => void },
): Promise<IngestResult> {
  let copied = 0
  let skipped = 0
  const manifests: string[] = []

  // Find .c4m files in bundle root
  for await (const entry of fs.readDir(bundleDir)) {
    if (entry.name.endsWith('.c4m')) {
      manifests.push(entry.name)
    }
  }

  // Ingest objects
  const objectsDir = joinPath(bundleDir, 'objects')
  const objects: string[] = []
  try {
    for await (const entry of fs.readDir(objectsDir)) {
      if (!entry.isDirectory && entry.name.startsWith('c4')) {
        objects.push(entry.name)
      }
    }
  } catch {
    // No objects directory — just manifests
  }

  for (let i = 0; i < objects.length; i++) {
    const name = objects[i]
    options?.progress?.(name, i, objects.length)

    try {
      const c4id = parseC4ID(name)
      if (await store.has(c4id)) {
        skipped++
        continue
      }
    } catch {
      // Invalid C4 ID filename — skip
      continue
    }

    const objectPath = joinPath(objectsDir, name)
    const stream = await fs.readFile(objectPath)
    await store.put(stream)
    copied++
  }

  return { copied, skipped, manifests }
}
