// track-changes.ts -- Snapshot a directory and show what changed since last run
//
// Usage:
//   npx tsx examples/track-changes.ts <directory>
//
// Example:
//   npx tsx examples/track-changes.ts /projects/shots/
//
// First run: scans the directory and saves a .c4m snapshot file.
// Subsequent runs: scans again, diffs against the saved snapshot, and prints
// added, removed, and modified files. Then saves the new snapshot.

import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { Manifest, scan, diff, isDir, formatSizeWithCommas } from '@avalanche-io/c4'
import { NodeFS } from '@avalanche-io/c4-node'

const SNAPSHOT_NAME = '.c4-snapshot.c4m'

async function main() {
  const args = process.argv.slice(2)
  if (args.length !== 1) {
    console.error('Usage: npx tsx examples/track-changes.ts <directory>')
    process.exit(1)
  }

  const targetDir = resolve(args[0])
  const snapshotPath = join(targetDir, SNAPSHOT_NAME)
  const fs = new NodeFS()

  // Scan current state
  console.log(`Scanning: ${targetDir}\n`)
  const current = await scan(fs, targetDir, {
    computeIds: true,
    skipHidden: true,
    progress: (path, count) => {
      process.stdout.write(`  Scanned ${count} files...\r`)
    },
  })
  process.stdout.write('\n')
  console.log(`Current state: ${current.summary()}\n`)

  // Try to load previous snapshot
  let previous: Manifest | null = null
  try {
    const prevText = await readFile(snapshotPath, 'utf-8')
    previous = await Manifest.parse(prevText)
  } catch {
    // No previous snapshot
  }

  if (!previous) {
    // First run -- save snapshot and exit
    console.log('No previous snapshot found. Saving initial snapshot.')
    const c4mText = current.encode({ pretty: true })
    await writeFile(snapshotPath, c4mText, 'utf-8')
    console.log(`Snapshot saved: ${snapshotPath}`)
    console.log('Run again after making changes to see the diff.')
    return
  }

  // Diff against previous snapshot
  const result = diff(previous, current)

  const hasChanges =
    result.added.length > 0 ||
    result.removed.length > 0 ||
    result.modified.length > 0

  if (!hasChanges) {
    console.log('No changes detected since last snapshot.')
    return
  }

  console.log('Changes since last snapshot:\n')

  if (result.added.length > 0) {
    const files = result.added.filter(a => !isDir(a.entry))
    const dirs = result.added.filter(a => isDir(a.entry))
    if (files.length > 0) {
      console.log(`ADDED (${files.length} files):`)
      for (const { path, entry } of files) {
        const size = entry.size >= 0 ? formatSizeWithCommas(entry.size) : '?'
        console.log(`  + ${path}  (${size} bytes)`)
      }
    }
    if (dirs.length > 0) {
      console.log(`ADDED (${dirs.length} directories):`)
      for (const { path } of dirs) {
        console.log(`  + ${path}`)
      }
    }
    console.log()
  }

  if (result.removed.length > 0) {
    const files = result.removed.filter(r => !isDir(r.entry))
    const dirs = result.removed.filter(r => isDir(r.entry))
    if (files.length > 0) {
      console.log(`REMOVED (${files.length} files):`)
      for (const { path } of files) {
        console.log(`  - ${path}`)
      }
    }
    if (dirs.length > 0) {
      console.log(`REMOVED (${dirs.length} directories):`)
      for (const { path } of dirs) {
        console.log(`  - ${path}`)
      }
    }
    console.log()
  }

  if (result.modified.length > 0) {
    const files = result.modified.filter(m => !isDir(m.newEntry))
    if (files.length > 0) {
      console.log(`MODIFIED (${files.length} files):`)
      for (const { path, oldEntry, newEntry } of files) {
        const oldSize = oldEntry.size >= 0 ? formatSizeWithCommas(oldEntry.size) : '?'
        const newSize = newEntry.size >= 0 ? formatSizeWithCommas(newEntry.size) : '?'
        console.log(`  ~ ${path}  (${oldSize} -> ${newSize} bytes)`)
      }
      console.log()
    }
  }

  // Save new snapshot
  const c4mText = current.encode({ pretty: true })
  await writeFile(snapshotPath, c4mText, 'utf-8')
  console.log(`Snapshot updated: ${snapshotPath}`)
}

main().catch((err) => {
  console.error(`Error: ${err.message}`)
  process.exit(1)
})
