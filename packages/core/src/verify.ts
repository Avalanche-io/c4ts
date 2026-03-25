import type { FileSystem } from './filesystem.js'
import type { Manifest } from './manifest.js'
import { identifyContent } from './identify-content.js'
import { isDir } from './entry.js'
import { streamToBytes, joinPath, FileNotFoundError } from './filesystem.js'

/** A file whose content does not match the manifest's expected C4 ID. */
export interface CorruptEntry {
  path: string
  expected: string
  actual: string
}

/** Result of verifying a manifest against a real filesystem. */
export interface VerifyReport {
  ok: string[]
  missing: string[]
  corrupt: CorruptEntry[]
  extra: string[]
  get isOk(): boolean
}

/** Options for the verify function. */
export interface VerifyOptions {
  progress?: (path: string, index: number, total: number) => void
}

/**
 * Compare a manifest against a real filesystem.
 *
 * Walks every file entry in the manifest and checks that the on-disk
 * content produces the same C4 ID. Then walks the actual directory tree
 * to find files present on disk but absent from the manifest.
 */
export async function verify(
  manifest: Manifest,
  fs: FileSystem,
  rootPath: string,
  options?: VerifyOptions,
): Promise<VerifyReport> {
  const ok: string[] = []
  const missing: string[] = []
  const corrupt: CorruptEntry[] = []

  // Collect expected file paths from the manifest.
  const expectedFiles: Array<[string, string]> = [] // [relativePath, c4idString]
  for (const [path, entry] of manifest) {
    if (isDir(entry)) continue
    const idStr = entry.c4id && !entry.c4id.isNil() ? entry.c4id.toString() : ''
    expectedFiles.push([path, idStr])
  }

  const expectedSet = new Set<string>()
  const total = expectedFiles.length

  // Check each manifest entry against the filesystem.
  for (let i = 0; i < expectedFiles.length; i++) {
    const [relPath, expectedId] = expectedFiles[i]
    expectedSet.add(relPath)
    const fullPath = joinPath(rootPath, relPath)

    options?.progress?.(relPath, i, total)

    try {
      await fs.stat(fullPath)
    } catch (err) {
      if (err instanceof FileNotFoundError) {
        missing.push(relPath)
        continue
      }
      throw err
    }

    // No expected C4 ID — can only confirm existence, not integrity.
    if (!expectedId) {
      ok.push(relPath)
      continue
    }

    const stream = await fs.readFile(fullPath)
    const bytes = await streamToBytes(stream)
    const actualId = await identifyContent(bytes)
    const actualStr = actualId.toString()

    if (actualStr === expectedId) {
      ok.push(relPath)
    } else {
      corrupt.push({ path: relPath, expected: expectedId, actual: actualStr })
    }
  }

  // Walk the real filesystem to find extra files.
  const extra: string[] = []
  await walkDir(fs, rootPath, '', expectedSet, extra)

  return {
    ok,
    missing,
    corrupt,
    extra,
    get isOk() {
      return missing.length === 0 && corrupt.length === 0 && extra.length === 0
    },
  }
}

/** Recursively walk a directory, collecting paths not in the expected set. */
async function walkDir(
  fs: FileSystem,
  rootPath: string,
  relDir: string,
  expected: Set<string>,
  extra: string[],
): Promise<void> {
  const absDir = relDir ? joinPath(rootPath, relDir) : rootPath

  for await (const entry of fs.readDir(absDir)) {
    const relPath = relDir ? relDir + entry.name : entry.name

    if (entry.isDirectory) {
      const dirRel = relPath.endsWith('/') ? relPath : relPath + '/'
      await walkDir(fs, rootPath, dirRel, expected, extra)
      continue
    }

    if (!expected.has(relPath)) {
      extra.push(relPath)
    }
  }
}
