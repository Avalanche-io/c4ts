// observable-dashboard.ts -- Reactive manifest mutations with event logging
//
// Usage:
//   npx tsx examples/observable-dashboard.ts
//
// Demonstrates ObservableManifest: wraps a Manifest with event subscriptions
// for add, remove, modify, sort, and batch operations. Events are printed
// as they fire to simulate a reactive UI or monitoring dashboard.

import {
  Manifest,
  ObservableManifest,
  createEntry,
  identifyBytes,
  type ManifestChangeEvent,
} from '@avalanche-io/c4'

function logEvent(event: ManifestChangeEvent) {
  const ts = new Date().toISOString().substring(11, 23)
  switch (event.type) {
    case 'add':
      console.log(`  [${ts}] ADD    ${event.path}`)
      break
    case 'remove':
      console.log(`  [${ts}] REMOVE ${event.path}`)
      break
    case 'modify':
      console.log(`  [${ts}] MODIFY ${event.path}`)
      break
    case 'sort':
      console.log(`  [${ts}] SORT   (entries reordered)`)
      break
    case 'batch':
      console.log(`  [${ts}] BATCH  ${event.changes?.length ?? 0} changes:`)
      for (const sub of event.changes ?? []) {
        const prefix = sub.type === 'add' ? '+' : sub.type === 'remove' ? '-' : '~'
        console.log(`           ${prefix} ${sub.path ?? '(sort)'}`)
      }
      break
  }
}

async function main() {
  console.log('=== Creating ObservableManifest ===\n')

  const manifest = Manifest.create()
  const obs = new ObservableManifest(manifest)

  // Subscribe to all events with wildcard
  const unsub = obs.on('*', logEvent)

  console.log('Subscribed to all events via wildcard listener.\n')

  // --- Add entries ---

  console.log('--- Adding entries individually ---\n')

  const readmeContent = new TextEncoder().encode('# Project\n')
  const readmeId = await identifyBytes(readmeContent)

  obs.addEntry(createEntry({
    mode: 0o644, modeType: '-', name: 'README.md',
    size: readmeContent.length, c4id: readmeId,
    timestamp: new Date(), depth: 0,
  }))

  const mainContent = new TextEncoder().encode('console.log("hello")\n')
  const mainId = await identifyBytes(mainContent)

  obs.addEntry(createEntry({
    mode: 0o755, modeType: 'd', name: 'src/',
    size: -1, depth: 0,
    timestamp: new Date(0),
  }))

  obs.addEntry(createEntry({
    mode: 0o644, modeType: '-', name: 'main.ts',
    size: mainContent.length, c4id: mainId,
    timestamp: new Date(), depth: 1,
  }))

  const testContent = new TextEncoder().encode('test("works", () => {})\n')
  const testId = await identifyBytes(testContent)

  obs.addEntry(createEntry({
    mode: 0o644, modeType: '-', name: 'main.test.ts',
    size: testContent.length, c4id: testId,
    timestamp: new Date(), depth: 1,
  }))

  console.log()
  console.log(`Manifest state: ${obs.summary()}\n`)

  // --- Sort entries ---

  console.log('--- Sorting entries ---\n')
  obs.sortEntries()
  console.log()

  // --- Modify an entry ---

  console.log('--- Modifying an entry ---\n')

  const readmeEntry = obs.get('README.md')
  if (readmeEntry) {
    const newContent = new TextEncoder().encode('# Project v2\n\nUpdated README.\n')
    const newId = await identifyBytes(newContent)
    obs.updateEntry(readmeEntry, {
      size: newContent.length,
      c4id: newId,
      timestamp: new Date(),
    })
  }

  console.log()

  // --- Remove an entry ---

  console.log('--- Removing an entry ---\n')

  const testEntry = obs.getByName('main.test.ts')
  if (testEntry) {
    obs.removeEntry(testEntry)
  }

  console.log()

  // --- Batch mutations ---

  console.log('--- Batch mutation (multiple changes, single event) ---\n')

  obs.batch(() => {
    const configContent = new TextEncoder().encode('{ "version": "2.0" }\n')

    obs.addEntry(createEntry({
      mode: 0o644, modeType: '-', name: 'config.json',
      size: configContent.length,
      timestamp: new Date(), depth: 0,
    }))

    obs.addEntry(createEntry({
      mode: 0o644, modeType: '-', name: 'LICENSE',
      size: 1068,
      timestamp: new Date(), depth: 0,
    }))

    obs.sortEntries()
  })

  console.log()

  // --- Type-specific subscription ---

  console.log('--- Type-specific subscription (add only) ---\n')

  const addOnlyUnsub = obs.on('add', (event) => {
    console.log(`  [add-only listener] New entry: ${event.path}`)
  })

  obs.addEntry(createEntry({
    mode: 0o755, modeType: 'd', name: 'docs/',
    size: -1, depth: 0,
    timestamp: new Date(0),
  }))

  console.log()

  // Unsubscribe
  addOnlyUnsub()

  // --- Final state ---

  console.log('--- Final manifest state ---\n')

  console.log(`Summary: ${obs.summary()}`)
  console.log(`Has null values: ${obs.hasNullValues()}`)
  console.log()

  console.log('Entries:')
  for (const [path, entry] of obs.manifest) {
    const id = entry.c4id ? entry.c4id.toString().substring(0, 20) + '...' : '-'
    console.log(`  ${path}  ${id}`)
  }

  console.log()

  // Clean up
  unsub()
  console.log('All listeners unsubscribed.')
}

main().catch((err) => {
  console.error(`Error: ${err.message}`)
  process.exit(1)
})
