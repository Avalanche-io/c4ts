// portable-bundle.ts -- Bundle content for USB or air-gap transfer
//
// Usage:
//   npx tsx examples/portable-bundle.ts pack <source-dir> <bundle-dir>
//   npx tsx examples/portable-bundle.ts unpack <bundle-dir>
//
// Examples:
//   npx tsx examples/portable-bundle.ts pack /projects/delivery/ ./bundle/
//   npx tsx examples/portable-bundle.ts unpack ./bundle/
//
// Pack: scans a source directory, stores all content in a TreeStore, then
// bundles the manifest and objects into a portable directory that can be
// copied to USB, shipped via sneakernet, or transferred over any medium.
//
// Unpack: reads a bundle directory, ingests all objects into the local
// TreeStore, and prints the manifests found.

import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { scan, pool, ingest, Manifest } from '@avalanche-io/c4'
import { NodeFS, TreeStore, openStore } from '@avalanche-io/c4-node'

async function pack(sourceDir: string, bundleDir: string) {
  const fs = new NodeFS()
  const store = await openStore()

  console.log(`Scanning: ${sourceDir}\n`)

  // Scan the source directory and store content
  const manifest = await scan(fs, sourceDir, {
    computeIds: true,
    skipHidden: true,
    store: store,
    progress: (path, count) => {
      process.stdout.write(`  Scanned ${count} files...\r`)
    },
  })

  process.stdout.write('\n')
  console.log(`${manifest.summary()}`)
  console.log()

  // Bundle the manifest and objects into the output directory
  console.log(`Bundling to: ${bundleDir}\n`)

  const result = await pool(manifest, bundleDir, fs, store, {
    manifestName: 'delivery.c4m',
    progress: (c4id, index, total) => {
      process.stdout.write(`  [${index + 1}/${total}] ${c4id.substring(0, 20)}...\r`)
    },
  })

  process.stdout.write('\n')
  console.log()
  console.log('Bundle complete:')
  console.log(`  Manifest: ${result.manifestPath}`)
  console.log(`  Objects copied:  ${result.copied}`)
  console.log(`  Objects skipped: ${result.skipped} (already in bundle)`)
  if (result.missing > 0) {
    console.log(`  Objects missing: ${result.missing} (not in local store)`)
  }
  console.log()
  console.log(`Bundle is ready at: ${bundleDir}`)
  console.log('Copy this directory to USB, external drive, or any transfer medium.')
}

async function unpack(bundleDir: string) {
  const fs = new NodeFS()
  const store = await openStore()

  console.log(`Ingesting bundle: ${bundleDir}\n`)

  const result = await ingest(bundleDir, fs, store, {
    progress: (path, index, total) => {
      process.stdout.write(`  [${index + 1}/${total}] ${path.substring(0, 20)}...\r`)
    },
  })

  process.stdout.write('\n')
  console.log()
  console.log('Ingest complete:')
  console.log(`  Objects imported: ${result.copied}`)
  console.log(`  Objects skipped:  ${result.skipped} (already in local store)`)
  console.log()

  if (result.manifests.length > 0) {
    console.log('Manifests found in bundle:')
    for (const name of result.manifests) {
      const manifestPath = join(bundleDir, name)
      const c4mText = await readFile(manifestPath, 'utf-8')
      const manifest = await Manifest.parse(c4mText)
      console.log(`  ${name}: ${manifest.summary()}`)
    }
  } else {
    console.log('No manifests found in bundle.')
  }

  console.log()
  console.log('Content is now available in your local store.')
  console.log('Use a workspace checkout to materialize files from a manifest.')
}

async function main() {
  const args = process.argv.slice(2)

  if (args.length < 2) {
    console.error('Usage:')
    console.error('  npx tsx examples/portable-bundle.ts pack <source-dir> <bundle-dir>')
    console.error('  npx tsx examples/portable-bundle.ts unpack <bundle-dir>')
    process.exit(1)
  }

  const command = args[0]

  switch (command) {
    case 'pack': {
      if (args.length !== 3) {
        console.error('Usage: npx tsx examples/portable-bundle.ts pack <source-dir> <bundle-dir>')
        process.exit(1)
      }
      await pack(resolve(args[1]), resolve(args[2]))
      break
    }
    case 'unpack': {
      if (args.length !== 2) {
        console.error('Usage: npx tsx examples/portable-bundle.ts unpack <bundle-dir>')
        process.exit(1)
      }
      await unpack(resolve(args[1]))
      break
    }
    default:
      console.error(`Unknown command: ${command}`)
      console.error('Use "pack" or "unpack".')
      process.exit(1)
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`)
  process.exit(1)
})
