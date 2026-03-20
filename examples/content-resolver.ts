// content-resolver.ts -- Multi-source content resolution with fallback
//
// Usage:
//   npx tsx examples/content-resolver.ts
//
// Demonstrates ContentResolver with multiple stores:
//   - MemoryStore as a fast local cache (priority 0)
//   - TreeStore on disk as persistent storage (priority 10)
//
// Shows both race mode (fastest source wins) and sequential fallback
// (priority order). Uses MemoryStore for both sources so this example
// runs without creating files on disk.

import {
  ContentResolver,
  storeAsSource,
  MemoryStore,
  identifyBytes,
  streamToBytes,
} from '@avalanche-io/c4'

async function main() {
  // Create two stores to simulate different storage backends
  const cacheStore = new MemoryStore()   // fast in-memory cache
  const diskStore = new MemoryStore()    // simulates persistent disk store

  console.log('=== Setting up content sources ===\n')

  // Put some content in the "disk" store only
  const fileA = new TextEncoder().encode('Shot 001 final render - 4K EXR\n')
  const fileB = new TextEncoder().encode('Shot 002 final render - 4K EXR\n')
  const fileC = new TextEncoder().encode('Shot 003 final render - 4K EXR\n')

  const idA = await diskStore.put(fileA)
  const idB = await diskStore.put(fileB)
  const idC = await diskStore.put(fileC)

  // Put fileA in both stores (simulating a cached copy)
  await cacheStore.put(fileA)

  console.log(`File A (${idA.toString().substring(0, 20)}...): in cache + disk`)
  console.log(`File B (${idB.toString().substring(0, 20)}...): in disk only`)
  console.log(`File C (${idC.toString().substring(0, 20)}...): in disk only`)
  console.log()

  // Create the resolver with prioritized sources
  const resolver = new ContentResolver()
  resolver.addSource(storeAsSource(cacheStore, 'memory-cache', 0))
  resolver.addSource(storeAsSource(diskStore, 'disk-store', 10))

  console.log('Registered sources:')
  for (const src of resolver.listSources()) {
    console.log(`  [priority ${src.priority}] ${src.name}`)
  }
  console.log()

  // --- Race mode: all sources checked in parallel, fastest wins ---

  console.log('=== Race mode (resolver.resolve) ===\n')

  const resultA = await resolver.resolve(idA)
  const bytesA = await streamToBytes(resultA.stream)
  console.log(`File A resolved from: "${resultA.source}" (${bytesA.length} bytes)`)

  const resultB = await resolver.resolve(idB)
  const bytesB = await streamToBytes(resultB.stream)
  console.log(`File B resolved from: "${resultB.source}" (${bytesB.length} bytes)`)

  console.log()

  // --- Sequential mode: sources tried in priority order ---

  console.log('=== Sequential mode (resolver.getSequential) ===\n')

  const seqA = await resolver.getSequential(idA)
  console.log(`File A resolved from: "${seqA.source}" (priority order, cache checked first)`)

  const seqC = await resolver.getSequential(idC)
  console.log(`File C resolved from: "${seqC.source}" (not in cache, fell through to disk)`)

  console.log()

  // --- Check availability across all sources ---

  console.log('=== Availability check ===\n')

  console.log(`Has file A: ${await resolver.has(idA)}`)
  console.log(`Has file B: ${await resolver.has(idB)}`)
  console.log(`Has file C: ${await resolver.has(idC)}`)

  // Create an ID for content that does not exist anywhere
  const missingContent = new TextEncoder().encode('this content was never stored')
  const missingId = await identifyBytes(missingContent)
  console.log(`Has missing: ${await resolver.has(missingId)}`)

  console.log()

  // --- Dynamic source management ---

  console.log('=== Dynamic source management ===\n')

  console.log('Removing "memory-cache" source...')
  resolver.removeSource('memory-cache')

  console.log('Remaining sources:')
  for (const src of resolver.listSources()) {
    console.log(`  [priority ${src.priority}] ${src.name}`)
  }

  const afterRemove = await resolver.resolve(idA)
  console.log(`File A now resolves from: "${afterRemove.source}"`)

  console.log()

  // --- Error handling for missing content ---

  console.log('=== Missing content error ===\n')

  try {
    await resolver.get(missingId)
  } catch (err: any) {
    console.log(`Expected error: ${err.message}`)
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`)
  process.exit(1)
})
