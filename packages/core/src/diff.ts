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

/** Check if two entries are identical (all fields match). */
function entriesEqual(a: Entry, b: Entry): boolean {
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
 * Patch semantics:
 * - Entry exists only in patch: addition
 * - Entry exists in both, any field differs: modification (patch replaces)
 * - Entry exists in both, all fields identical: removal
 */
export function applyPatch(base: Manifest, patch: Manifest): Manifest {
  const result = base.copy()

  for (const patchEntry of patch.entries) {
    // Find matching entry in result by name and depth
    let found = false
    for (let i = 0; i < result.entries.length; i++) {
      const existing = result.entries[i]
      if (existing.name === patchEntry.name && existing.depth === patchEntry.depth) {
        if (entriesEqual(existing, patchEntry)) {
          // Identical = removal
          result.entries.splice(i, 1)
        } else {
          // Different = modification
          result.entries[i] = { ...patchEntry }
        }
        found = true
        break
      }
    }
    if (!found) {
      // Addition
      result.entries.push({ ...patchEntry })
    }
  }

  result.sortEntries()
  return result
}

/** Compute the patch between old and new manifests. */
export interface PatchResult {
  oldID: string   // C4 ID of the old manifest
  patch: Manifest // Entries to apply
}

export async function patchDiff(oldManifest: Manifest, newManifest: Manifest): Promise<PatchResult> {
  const d = diff(oldManifest, newManifest)
  const patch = Manifest.create()

  // Additions and modifications — use new entries
  for (const { entry } of d.added) patch.addEntry({ ...entry })
  for (const { newEntry } of d.modified) patch.addEntry({ ...newEntry })
  // Removals — restate original entry exactly
  for (const { entry } of d.removed) patch.addEntry({ ...entry })

  const oldID = await oldManifest.computeC4ID()
  return { oldID: oldID.toString(), patch }
}
