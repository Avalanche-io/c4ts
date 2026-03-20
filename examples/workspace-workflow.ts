// workspace-workflow.ts -- Full workspace lifecycle demonstration
//
// Usage:
//   npx tsx examples/workspace-workflow.ts
//
// Demonstrates the Workspace class: create a workspace backed by a content
// store, snapshot the initial state, modify files, diff to see changes,
// reset to restore, and checkout a different manifest.
//
// This example uses MemoryFS and MemoryStore so it runs without touching
// the real filesystem.

import {
  Workspace,
  MemoryFS,
  MemoryStore,
  Manifest,
  createEntry,
  diff,
  isDir,
} from '@avalanche-io/c4'

async function main() {
  const fs = new MemoryFS()
  const store = new MemoryStore()

  // Set up an initial directory with some files
  await fs.mkdir('project', { recursive: true })
  await fs.mkdir('project/src', { recursive: true })
  await fs.writeText('project/README.md', '# My Project\n\nA sample project.\n')
  await fs.writeText('project/src/main.ts', 'console.log("hello world")\n')
  await fs.writeText('project/src/util.ts', 'export function add(a: number, b: number) { return a + b }\n')

  console.log('=== Step 1: Create workspace and take initial snapshot ===\n')

  const workspace = new Workspace('project', fs, store)
  await workspace.load()

  const snap1 = await workspace.snapshot({ storeContent: true, skipHidden: true })
  console.log(`Initial snapshot: ${snap1.summary()}`)
  console.log('Files:')
  for (const [path, entry] of snap1.files()) {
    const id = entry.c4id ? entry.c4id.toString().substring(0, 16) + '...' : '-'
    console.log(`  ${path}  ${id}`)
  }
  console.log()

  // Checkout the snapshot so workspace tracks it
  const checkoutResult = await workspace.checkout(snap1)
  console.log(`Checked out. Status: manifest tracked = ${workspace.status().hasManifest}\n`)

  console.log('=== Step 2: Modify files ===\n')

  // Simulate changes
  await fs.writeText('project/src/main.ts', 'console.log("hello c4 world")\n')
  await fs.writeText('project/src/config.ts', 'export const VERSION = "1.0.0"\n')
  await fs.remove('project/src/util.ts')

  console.log('Changes made:')
  console.log('  ~ modified src/main.ts')
  console.log('  + added    src/config.ts')
  console.log('  - removed  src/util.ts')
  console.log()

  console.log('=== Step 3: Diff to see changes ===\n')

  const diffResult = await workspace.diffFromCurrent()
  if (diffResult.added.length > 0) {
    console.log('Added:')
    for (const { path } of diffResult.added) {
      if (!isDir({ modeType: '-', name: path } as any)) {
        console.log(`  + ${path}`)
      }
    }
  }
  if (diffResult.removed.length > 0) {
    console.log('Removed:')
    for (const { path } of diffResult.removed) {
      console.log(`  - ${path}`)
    }
  }
  if (diffResult.modified.length > 0) {
    console.log('Modified:')
    for (const { path } of diffResult.modified) {
      console.log(`  ~ ${path}`)
    }
  }
  console.log()

  console.log('=== Step 4: Reset to restore original state ===\n')

  const resetResult = await workspace.reset()
  console.log(`Reset complete: created=${resetResult.created}, updated=${resetResult.updated}, removed=${resetResult.removed}`)

  // Verify reset by taking a new snapshot
  const snap2 = await workspace.snapshot({ skipHidden: true })
  const afterReset = diff(snap1, snap2)
  const unchanged =
    afterReset.added.length === 0 &&
    afterReset.removed.length === 0 &&
    afterReset.modified.length === 0
  console.log(`State matches original: ${unchanged}\n`)

  console.log('=== Step 5: Checkout a different manifest ===\n')

  // Build a new manifest representing a different version of the project
  const altManifest = Manifest.create()
  const readmeContent = new TextEncoder().encode('# My Project v2\n\nNow with more features.\n')
  const newMainContent = new TextEncoder().encode('import { greet } from "./greet"\ngreet()\n')
  const greetContent = new TextEncoder().encode('export function greet() { console.log("Hi from C4!") }\n')

  const readmeId = await store.put(readmeContent)
  const newMainId = await store.put(newMainContent)
  const greetId = await store.put(greetContent)

  altManifest.addEntry(createEntry({
    mode: 0o644, modeType: '-', name: 'README.md',
    size: readmeContent.length, c4id: readmeId,
    timestamp: new Date(), depth: 0,
  }))
  altManifest.addEntry(createEntry({
    mode: 0o755, modeType: 'd', name: 'src/',
    size: -1, depth: 0,
    timestamp: new Date(0),
  }))
  altManifest.addEntry(createEntry({
    mode: 0o644, modeType: '-', name: 'main.ts',
    size: newMainContent.length, c4id: newMainId,
    timestamp: new Date(), depth: 1,
  }))
  altManifest.addEntry(createEntry({
    mode: 0o644, modeType: '-', name: 'greet.ts',
    size: greetContent.length, c4id: greetId,
    timestamp: new Date(), depth: 1,
  }))
  altManifest.sortEntries()

  const altResult = await workspace.checkout(altManifest)
  console.log('Checked out alternate manifest.')

  const snap3 = await workspace.snapshot({ skipHidden: true })
  console.log(`New state: ${snap3.summary()}`)
  console.log('Files:')
  for (const [path] of snap3.files()) {
    console.log(`  ${path}`)
  }
  console.log()

  const status = workspace.status()
  console.log('Workspace status:')
  console.log(`  path:         ${status.path}`)
  console.log(`  hasManifest:  ${status.hasManifest}`)
  console.log(`  manifestC4ID: ${status.manifestC4ID?.substring(0, 16)}...`)
  console.log(`  lastCheckout: ${status.lastCheckout}`)
}

main().catch((err) => {
  console.error(`Error: ${err.message}`)
  process.exit(1)
})
