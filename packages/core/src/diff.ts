import { type Entry, isDir, canonicalEntry } from './entry.js'
import { Manifest } from './manifest.js'

/** Result of diffing two manifests. */
export interface DiffResult {
  added: Array<{ path: string; entry: Entry }>
  removed: Array<{ path: string; entry: Entry }>
  modified: Array<{ path: string; oldEntry: Entry; newEntry: Entry }>
}

/** Compute the diff between two manifests. */
export function diff(oldManifest: Manifest, newManifest: Manifest): DiffResult {
  const result: DiffResult = { added: [], removed: [], modified: [] }

  // Build path maps
  const oldPaths = new Map<string, Entry>()
  for (const [path, entry] of oldManifest) {
    oldPaths.set(path, entry)
  }

  const newPaths = new Map<string, Entry>()
  for (const [path, entry] of newManifest) {
    newPaths.set(path, entry)
  }

  // Find removed and modified
  for (const [path, oldEntry] of oldPaths) {
    const newEntry = newPaths.get(path)
    if (!newEntry) {
      result.removed.push({ path, entry: oldEntry })
    } else if (!entriesEqual(oldEntry, newEntry)) {
      result.modified.push({ path, oldEntry, newEntry })
    }
  }

  // Find added
  for (const [path, newEntry] of newPaths) {
    if (!oldPaths.has(path)) {
      result.added.push({ path, entry: newEntry })
    }
  }

  return result
}

/**
 * Check if two entries are identical. As in the Go reference, when both
 * carry a C4 ID the entries are equal by identity and mode alone — a
 * directory's own mtime, or a file's, is not a modification when the
 * content it names is unchanged. Otherwise every canonical field must match.
 */
function entriesEqual(a: Entry, b: Entry): boolean {
  if (a.c4id && b.c4id && !a.c4id.isNil() && !b.c4id.isNil()) {
    return a.c4id.equals(b.c4id) && a.mode === b.mode && a.modeType === b.modeType
  }
  return canonicalEntry(a) === canonicalEntry(b)
}

/**
 * The patch identity rule (SPECIFICATION.md "Patch Entry Semantics": "All
 * fields identical means: same name, mode, timestamp, size, C4 ID, and
 * target"), as Go's entriesIdentical: the canonical lines match, so every
 * field matches at the format's resolution. Patches use it in both
 * directions: a restatement is a removal only when it is identical, and a
 * patch restates every entry whose line differs. entriesEqual above is
 * diff()'s looser "modified" test and must never decide either; through
 * 1.0.25 it decided both, so a change of time alone was left out of the
 * patches c4ts wrote, and a time-only restatement in a patch it read
 * removed the file.
 */
function entriesIdentical(a: Entry, b: Entry): boolean {
  return canonicalEntry(a) === canonicalEntry(b)
}

/** Merge result. */
export interface MergeResult {
  merged: Manifest
  conflicts: MergeConflict[]
}

/** A merge conflict. */
export interface MergeConflict {
  path: string
  base: Entry | undefined
  local: Entry
  remote: Entry
}

/** Three-way merge of manifests. */
export function merge(base: Manifest, local: Manifest, remote: Manifest): MergeResult {
  const localDiff = diff(base, local)
  const remoteDiff = diff(base, remote)
  const merged = base.copy()
  const conflicts: MergeConflict[] = []

  // Build sets of changed paths
  const localChanges = new Map<string, Entry>()
  for (const { path, entry } of localDiff.added) localChanges.set(path, entry)
  for (const { path, newEntry } of localDiff.modified) localChanges.set(path, newEntry)

  const localRemoved = new Set(localDiff.removed.map(r => r.path))

  const remoteChanges = new Map<string, Entry>()
  for (const { path, entry } of remoteDiff.added) remoteChanges.set(path, entry)
  for (const { path, newEntry } of remoteDiff.modified) remoteChanges.set(path, newEntry)

  const remoteRemoved = new Set(remoteDiff.removed.map(r => r.path))

  // Apply non-conflicting changes
  const allPaths = new Set([...localChanges.keys(), ...localRemoved, ...remoteChanges.keys(), ...remoteRemoved])

  for (const path of allPaths) {
    const inLocal = localChanges.has(path) || localRemoved.has(path)
    const inRemote = remoteChanges.has(path) || remoteRemoved.has(path)

    if (inLocal && !inRemote) {
      // Only local changed
      if (localRemoved.has(path)) {
        const entry = merged.get(path)
        if (entry) merged.removeEntry(entry)
      } else {
        applyChange(merged, path, localChanges.get(path)!)
      }
    } else if (!inLocal && inRemote) {
      // Only remote changed
      if (remoteRemoved.has(path)) {
        const entry = merged.get(path)
        if (entry) merged.removeEntry(entry)
      } else {
        applyChange(merged, path, remoteChanges.get(path)!)
      }
    } else {
      // Both changed — check if they agree
      const localEntry = localChanges.get(path)
      const remoteEntry = remoteChanges.get(path)
      const localDel = localRemoved.has(path)
      const remoteDel = remoteRemoved.has(path)

      if (localDel && remoteDel) {
        // Both deleted — no conflict
        const entry = merged.get(path)
        if (entry) merged.removeEntry(entry)
      } else if (localEntry && remoteEntry && entriesEqual(localEntry, remoteEntry)) {
        // Same change — no conflict
        applyChange(merged, path, localEntry)
      } else {
        // Conflict
        conflicts.push({
          path,
          base: merged.get(path),
          local: localEntry ?? merged.get(path)!,
          remote: remoteEntry ?? merged.get(path)!,
        })
      }
    }
  }

  return { merged, conflicts }
}

function applyChange(m: Manifest, path: string, entry: Entry): void {
  const existing = m.get(path)
  if (existing) {
    Object.assign(existing, entry)
  } else {
    m.addEntry({ ...entry })
  }
}

/** Apply a patch manifest to a base manifest.
 * Patch semantics, matched by full path (SPECIFICATION.md "Patch Entry
 * Semantics", erratum 2026-07-31):
 * - Path exists only in patch: addition
 * - Path exists in both, any field differs: modification (patch replaces)
 * - Path exists in both, all fields identical, no child follows it in the
 *   patch: removal, of the entry and of every descendant under it
 * - Path exists in both, all fields identical, a child follows it in the
 *   patch: deepening — the entry is unchanged and the children are applied
 *
 * A restatement that declares children is not removing their parent.
 * Breadth-first discovery learns a directory's children before it learns
 * anything about the directory itself, so the parent line is necessarily
 * restated unchanged before them; reading that as a removal silently
 * discarded the directory, the children just declared, and everything the
 * patch never mentioned beneath it. To remove a subtree, restate the
 * directory alone.
 *
 * A patch is meaningful only over its own base. Because removal is spelled
 * by exact restatement, applying a patch to any other tree reads an
 * addition that meets an identical entry as a removal. To carry a patch's
 * changes to another tree, read each entry against the patch's base first,
 * then apply what it means; the rule and the shared conformance vectors are
 * in c4 core (c4m/testdata/apply-from-vector). Not implemented here until a
 * caller needs it.
 */
export function applyPatch(base: Manifest, patch: Manifest): Manifest {
  const result = base.copy()

  // Insertion-ordered path map of the base; sortEntries restores tree order.
  const byPath = new Map<string, Entry>()
  for (const [path, entry] of result) {
    byPath.set(path, entry)
  }

  const patchPaths: string[] = []
  for (const [path] of patch) {
    patchPaths.push(path)
  }
  const declaresChildren = (dirPath: string): boolean =>
    patchPaths.some(p => p !== dirPath && p.startsWith(dirPath))

  for (const [path, patchEntry] of patch) {
    const existing = byPath.get(path)
    if (existing && entriesIdentical(existing, patchEntry)) {
      if (isDir(patchEntry) && declaresChildren(path)) {
        // Deepening: the directory stays as the base holds it; its
        // children are applied by their own lines.
        continue
      }
      // Removal: the entry and, for a directory, everything under it.
      // Directory paths end in '/', so the prefix names exactly its subtree.
      byPath.delete(path)
      if (isDir(existing)) {
        for (const p of Array.from(byPath.keys())) {
          if (p.startsWith(path)) byPath.delete(p)
        }
      }
      continue
    }
    // Modification, or addition.
    byPath.set(path, { ...patchEntry })
  }

  result.entries = Array.from(byPath.values())
  result.invalidateIndex()
  result.sortEntries()
  return result
}

/** Compute the patch between old and new manifests. */
export interface PatchResult {
  oldID: string   // C4 ID of the old manifest
  patch: Manifest // Entries to apply
}

export async function patchDiff(oldManifest: Manifest, newManifest: Manifest): Promise<PatchResult> {
  const oldPaths = new Map<string, Entry>()
  for (const [path, entry] of oldManifest) oldPaths.set(path, entry)
  const newPaths = new Map<string, Entry>()
  for (const [path, entry] of newManifest) newPaths.set(path, entry)

  const added: Entry[] = []
  const modified: Entry[] = []
  const removed: Entry[] = []
  for (const [path, oldEntry] of oldPaths) {
    const newEntry = newPaths.get(path)
    if (!newEntry) {
      removed.push(oldEntry)
    } else if (!entriesIdentical(oldEntry, newEntry)) {
      // Any field differs, a time or a mode alone included: the new line.
      modified.push(newEntry)
    }
  }
  for (const [path, newEntry] of newPaths) {
    if (!oldPaths.has(path)) added.push(newEntry)
  }

  const patch = Manifest.create()
  // Additions and modifications — use new entries
  for (const entry of added) patch.addEntry({ ...entry })
  for (const entry of modified) patch.addEntry({ ...entry })
  // Removals — restate original entry exactly
  for (const entry of removed) patch.addEntry({ ...entry })

  const oldID = await oldManifest.computeC4ID()
  return { oldID: oldID.toString(), patch }
}
