// find-duplicates.ts -- Find files with identical content in a directory tree
//
// Usage:
//   npx tsx examples/find-duplicates.ts <directory>
//
// Example:
//   npx tsx examples/find-duplicates.ts /projects/HERO/
//
// Scans all files, computes C4 IDs, and groups files that share the same
// content. Two files with the same C4 ID are byte-identical regardless of
// name, path, or timestamp.

import { resolve } from 'node:path'
import { scan } from '@avalanche-io/c4'
import { NodeFS } from '@avalanche-io/c4-node'

async function main() {
  const args = process.argv.slice(2)
  if (args.length !== 1) {
    console.error('Usage: npx tsx examples/find-duplicates.ts <directory>')
    process.exit(1)
  }

  const targetDir = resolve(args[0])
  const fs = new NodeFS()

  console.log(`Scanning: ${targetDir}\n`)

  const manifest = await scan(fs, targetDir, {
    computeIds: true,
    skipHidden: true,
    progress: (path, count) => {
      process.stdout.write(`  Scanned ${count} files...\r`)
    },
  })

  process.stdout.write('\n')
  console.log(`${manifest.summary()}\n`)

  // Find groups of files with the same C4 ID
  const dupes = manifest.duplicates()

  if (dupes.size === 0) {
    console.log('No duplicate content found.')
    return
  }

  console.log(`Found ${dupes.size} groups of duplicate content:\n`)

  let groupNum = 0
  for (const [c4id, paths] of dupes) {
    groupNum++
    console.log(`Group ${groupNum} (${paths.length} copies) -- ${c4id}`)
    for (const path of paths) {
      console.log(`  ${path}`)
    }
    console.log()
  }

  // Summary
  let totalDuplicateFiles = 0
  for (const [, paths] of dupes) {
    totalDuplicateFiles += paths.length - 1 // subtract one original per group
  }
  console.log(`${totalDuplicateFiles} files could be deduplicated across ${dupes.size} groups.`)
}

main().catch((err) => {
  console.error(`Error: ${err.message}`)
  process.exit(1)
})
