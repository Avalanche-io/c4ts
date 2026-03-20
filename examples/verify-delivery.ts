// verify-delivery.ts -- Verify a delivery directory against a c4m manifest
//
// Usage:
//   npx tsx examples/verify-delivery.ts <manifest.c4m> <directory>
//
// Example:
//   npx tsx examples/verify-delivery.ts delivery.c4m /mnt/incoming/
//
// Reads the c4m file, scans the target directory, and reports which files
// are OK, missing, corrupted, or unexpected.

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Manifest, verify } from '@avalanche-io/c4'
import { NodeFS } from '@avalanche-io/c4-node'

async function main() {
  const args = process.argv.slice(2)
  if (args.length !== 2) {
    console.error('Usage: npx tsx examples/verify-delivery.ts <manifest.c4m> <directory>')
    process.exit(1)
  }

  const manifestPath = resolve(args[0])
  const targetDir = resolve(args[1])

  // Read and parse the c4m manifest
  console.log(`Reading manifest: ${manifestPath}`)
  const c4mText = await readFile(manifestPath, 'utf-8')
  const manifest = await Manifest.parse(c4mText)
  console.log(`Manifest: ${manifest.summary()}`)

  // Verify the directory against the manifest
  const fs = new NodeFS()
  let filesChecked = 0

  console.log(`\nVerifying: ${targetDir}\n`)
  const report = await verify(manifest, fs, targetDir, {
    progress: (path, index, total) => {
      filesChecked = index + 1
      process.stdout.write(`  [${filesChecked}/${total}] ${path}\r`)
    },
  })

  // Clear the progress line
  process.stdout.write('\n')

  // Print results
  if (report.isOk) {
    console.log(`\nAll ${report.ok.length} files verified OK.`)
  } else {
    if (report.ok.length > 0) {
      console.log(`\nOK: ${report.ok.length} files`)
    }

    if (report.missing.length > 0) {
      console.log(`\nMISSING: ${report.missing.length} files`)
      for (const path of report.missing) {
        console.log(`  - ${path}`)
      }
    }

    if (report.corrupt.length > 0) {
      console.log(`\nCORRUPT: ${report.corrupt.length} files`)
      for (const entry of report.corrupt) {
        console.log(`  - ${entry.path}`)
        console.log(`    expected: ${entry.expected}`)
        console.log(`    actual:   ${entry.actual}`)
      }
    }

    if (report.extra.length > 0) {
      console.log(`\nEXTRA: ${report.extra.length} files (not in manifest)`)
      for (const path of report.extra) {
        console.log(`  + ${path}`)
      }
    }

    process.exit(1)
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`)
  process.exit(1)
})
