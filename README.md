# c4ts

[![CI](https://github.com/Avalanche-io/c4ts/actions/workflows/ci.yml/badge.svg)](https://github.com/Avalanche-io/c4ts/actions)
[![Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-3178c6.svg)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-301%20passed-brightgreen.svg)](#)
[![npm @avalanche-io/c4](https://img.shields.io/npm/v/@avalanche-io/c4.svg?label=@avalanche-io/c4)](https://www.npmjs.com/package/@avalanche-io/c4)
[![npm @avalanche-io/c4-node](https://img.shields.io/npm/v/@avalanche-io/c4-node.svg?label=@avalanche-io/c4-node)](https://www.npmjs.com/package/@avalanche-io/c4-node)

TypeScript implementation of C4 universal content identification (SMPTE ST 2114:2017).
Runs in the **browser and Node.js** from a single codebase -- zero dependencies in core.

```typescript
import { identify, parse, Manifest, diff, verify, MemoryStore, MemoryFS } from '@avalanche-io/c4'

// Identify content -- async because WebCrypto is async
const id = await identify(new TextEncoder().encode('Hello, World!'))
console.log(id.toString())
// c459dsjfscH38cYeXXYogktxf4Cd9ibshE3BHUo6a58hBXmRQ1rvW...

// Parse an existing C4 ID
const known = parse('c459dsjfscH38cYeXXYogktxf4Cd9ibshE3BHUo6a58hBXmRQ1rvWUo8yu7Xs9kVjiDmVuS6SrKMHNQsJTz7TZLCQ37')

// Parse a c4m file
const manifest = await Manifest.parse(`
-rw-r--r-- 2025-03-15T10:30:00Z 1234 hello.txt c459dsjfscH38cYeXXYogktxf4Cd9ibshE3BHUo6a58hBXmRQ1rvWUo8yu7Xs9kVjiDmVuS6SrKMHNQsJTz7TZLCQ37
-rw-r--r-- 2025-03-15T10:31:00Z 5678 world.txt c42yrSafety4SE7Gez2OPJNppHy6Z7mFAqCmih9DEmyz4CNULvuKJqgPV5r11MFGM8GgfPCq4sFcHdokqKYsToJgJK
`)

// Diff two manifests
const changes = diff(oldManifest, newManifest)
console.log(`${changes.added.length} added, ${changes.modified.length} modified, ${changes.removed.length} removed`)

// Verify files against a manifest
const report = await verify(manifest, fs, '/project')
console.log(report.isOk ? 'all files match' : `${report.corrupt.length} corrupt`)
```

## Install

Two packages: **core** (platform-agnostic) and **node** (filesystem + store for Node.js).

```bash
# Core -- works in browser, Node, Deno, Bun, anywhere with WebCrypto
npm install @avalanche-io/c4

# Node.js extensions -- adds filesystem store and node:fs integration
npm install @avalanche-io/c4-node
```

`@avalanche-io/c4` has **zero runtime dependencies**. All hashing uses the native WebCrypto API (`crypto.subtle.digest`), which is hardware-accelerated in both browsers and Node.js.

## What is C4?

C4 (Cinema Content Creation Cloud) is an open standard for identifying digital content by its SHA-512 hash, encoded as a compact base58 string. Any file, any size, anywhere -- same content always produces the same 90-character ID starting with `c4`.

C4 IDs are:
- **Universal** -- defined by SMPTE ST 2114:2017
- **Deterministic** -- same bytes = same ID, always
- **Unique** -- 512-bit collision resistance
- **Portable** -- base58 encoding, no special characters

## C4M Format

A c4m file is a human-readable text format that describes a filesystem without containing the actual file content. Each line is one entry: permissions, timestamp, size, name, and C4 ID.

```
-rw-r--r-- 2025-03-15T10:30:00Z    1,234 hello.txt   c459dsjfsc...
-rw-r--r-- 2025-03-15T10:31:00Z    5,678 world.txt   c42yrSafet...
drwxr-xr-x 2025-03-15T10:31:00Z    6,912 src/
  -rw-r--r-- 2025-03-15T10:30:00Z  2,048 main.ts     c4Kq8HTriN...
```

c4m stands for "C4 Manifest". Think of it as `ls -la` output that completely describes a directory tree -- small enough to email, precise enough to verify every byte.

## API

### Identification

All hashing is async because WebCrypto's `crypto.subtle.digest` returns a Promise.

```typescript
import { identify, identifyBytes, parse, C4ID } from '@avalanche-io/c4'

// From bytes
const id = await identifyBytes(new Uint8Array([1, 2, 3]))

// From a ReadableStream, ArrayBuffer, or Uint8Array
const id2 = await identify(someStream)

// Parse a C4 ID string (synchronous -- no hashing, just base58 decode)
const id3 = parse('c459dsjfscH38cYeXXYogktxf4Cd9ibshE3BHUo6a58hBXmRQ1rvWUo8yu7Xs9kVjiDmVuS6SrKMHNQsJTz7TZLCQ37')
// or
const id4 = C4ID.parse('c459dsjfsc...')

// C4ID methods
id.toString()      // "c4..." (90 characters)
id.hex()           // lowercase hex of the 64-byte digest
id.isNil()         // true if all bytes are zero
id.equals(other)   // byte-wise equality
id.compareTo(other) // -1, 0, or 1

// Order-independent sum (for Merkle trees)
const combined = await id.sum(other)

// Nil ID
const nil = C4ID.nil()
```

### Tree IDs

Compute order-independent Merkle tree IDs from a set of C4 IDs. The algorithm sorts by digest, deduplicates, then builds a binary tree bottom-up using the order-independent `sum` operation.

```typescript
import { treeId, identifyBytes } from '@avalanche-io/c4'

const ids = await Promise.all([
  identifyBytes(file1Bytes),
  identifyBytes(file2Bytes),
  identifyBytes(file3Bytes),
])

const root = await treeId(ids)
// Same result regardless of input order
```

### C4M Files

```typescript
import { Manifest, decode, encode, loads, dumps } from '@avalanche-io/c4'

// Parse c4m text
const manifest = await Manifest.parse(c4mText)

// Encode back to text
const text = manifest.encode()
const pretty = manifest.encode({ pretty: true, indentWidth: 2 })

// Low-level decode/encode
const result = await decode(c4mText) // returns { version, base, entries, rangeData }
const text2 = encode(manifest, { pretty: true })

// Convenience aliases
const result2 = await loads(c4mText)
const text3 = dumps(manifest)

// Navigate the tree
manifest.get('src/main.ts')         // Entry by full path
manifest.has('src/main.ts')         // existence check
manifest.getByName('main.ts')      // by bare name
manifest.entryPath(entry)          // full path of an entry
manifest.children(dirEntry)        // direct children
manifest.parent(entry)             // parent directory
manifest.root()                    // root-level entries

// Iterate
for (const [path, entry] of manifest) { /* all entries */ }
for (const [path, entry] of manifest.files()) { /* files only */ }
for (const [path, entry] of manifest.directories()) { /* dirs only */ }

// Filter and query
const tsFiles = manifest.filter((path, entry) => path.endsWith('.ts'))
const dupes = manifest.duplicates() // Map<c4id, paths[]>

// Manifest metadata
manifest.summary()       // "42 files, 5 dirs, 1.2 MB"
manifest.hasNullValues()  // true if any entry has unresolved metadata
manifest.validate()       // throws on structural errors (duplicate paths, traversal)

// Compute the manifest's own C4 ID
const c4id = await manifest.computeC4ID()

// Mutate
manifest.addEntry(entry)
manifest.removeEntry(entry)
manifest.sortEntries()    // files before dirs, natural sort
manifest.canonicalize()   // propagate size/timestamp from children to parents
```

### Diff, Merge, Patch

```typescript
import { diff, merge, applyPatch, patchDiff } from '@avalanche-io/c4'

// Two-way diff
const changes = diff(oldManifest, newManifest)
// changes.added    -- [{ path, entry }]
// changes.removed  -- [{ path, entry }]
// changes.modified -- [{ path, oldEntry, newEntry }]

// Three-way merge
const result = merge(base, local, remote)
// result.merged    -- Manifest with non-conflicting changes applied
// result.conflicts -- [{ path, base, local, remote }]

// Patch operations
const { oldID, patch } = await patchDiff(oldManifest, newManifest)
const patched = applyPatch(oldManifest, patch)
```

### Content Store

The `Store` interface defines content-addressed blob storage. Any object is stored and retrieved by its C4 ID.

```typescript
import { type Store, MemoryStore, CompositeStore } from '@avalanche-io/c4'

// In-memory store (tests, small operations, browser use)
const store = new MemoryStore()
const id = await store.put(new TextEncoder().encode('hello'))
const exists = await store.has(id)          // true
const stream = await store.get(id)          // ReadableStream
await store.remove(id)
store.size       // number of objects
store.totalBytes // total bytes stored
store.clear()    // remove everything

// Composite store: reads from multiple backends, writes to one
const local = new MemoryStore()
const cache = new MemoryStore()
const composite = new CompositeStore(local, cache)
// put() goes to local; get() tries local first, falls back to cache
```

### FileSystem

The `FileSystem` interface decouples all operations from the underlying storage backend.

```typescript
import { type FileSystem, MemoryFS, streamToBytes, bytesToStream, joinPath } from '@avalanche-io/c4'

// In-memory filesystem (tests, operations that don't need real I/O)
const fs = new MemoryFS()
await fs.mkdir('src', { recursive: true })
await fs.writeFile('src/main.ts', new TextEncoder().encode('console.log("hi")'))
const stat = await fs.stat('src/main.ts')
const stream = await fs.readFile('src/main.ts')
await fs.rename('src/main.ts', 'src/app.ts')
await fs.remove('src/app.ts')

// MemoryFS convenience methods
await fs.writeText('readme.txt', 'Hello')
const text = await fs.readText('readme.txt')

// Helpers
const bytes = await streamToBytes(stream)
const newStream = bytesToStream(bytes)
const path = joinPath('src', 'main.ts') // "src/main.ts"
```

### ContentResolver

Multi-source content resolution. Tries sources in parallel (race mode) or sequential (priority mode) to find content by C4 ID.

```typescript
import { ContentResolver, storeAsSource, MemoryStore } from '@avalanche-io/c4'

const resolver = new ContentResolver()
resolver.addSource(storeAsSource(localStore, 'local', 0))    // priority 0 (highest)
resolver.addSource(storeAsSource(remoteStore, 'remote', 10)) // priority 10

// Race mode -- fastest source wins
const stream = await resolver.get(id)

// With source metadata
const { stream: s, source } = await resolver.resolve(id)
console.log(`served from: ${source}`)

// Sequential mode -- tries by priority, stops at first success
const result = await resolver.getSequential(id)

// Check availability across all sources
const available = await resolver.has(id) // parallel check

// Manage sources
resolver.listSources()         // [{ name, priority }]
resolver.removeSource('remote')
```

The `ContentSource` interface is broader than `Store` -- any object that serves bytes by C4 ID (HTTP endpoints, peer connections, etc.) can be a source.

### Scanner

Walks a filesystem directory and builds a sorted Manifest with C4 IDs.

```typescript
import { scan } from '@avalanche-io/c4'

const manifest = await scan(fs, '/project', {
  computeIds: true,    // hash file contents (default: true)
  skipHidden: true,    // skip dotfiles/dotdirs (default: true)
  followSymlinks: false, // default: false
  store: myStore,      // optionally store content during scan (single-pass ingest)
  progress: (path, n) => console.log(`[${n}] ${path}`),
})
```

### Verify

Compare a manifest against a real filesystem. Reports missing files, corrupt content (C4 ID mismatch), and extra files not in the manifest.

```typescript
import { verify } from '@avalanche-io/c4'

const report = await verify(manifest, fs, '/project', {
  progress: (path, index, total) => console.log(`[${index}/${total}] ${path}`),
})

report.isOk      // true if everything matches
report.ok        // paths that match
report.missing   // paths in manifest but not on disk
report.corrupt   // [{ path, expected, actual }]
report.extra     // paths on disk but not in manifest
```

### Reconcile

Make a filesystem match a manifest. Plan first, then apply. Only transfers content that actually differs.

```typescript
import { reconcilePlan, reconcileApply } from '@avalanche-io/c4'

// Plan: determine what operations are needed
const plan = await reconcilePlan(manifest, fs, '/output', store)
// plan.operations -- [{ type: 'mkdir'|'create'|'update'|'remove'|'rmdir', path, entry }]
// plan.missing    -- C4 IDs needed but not in store
// plan.skipped    -- paths already correct

// Apply: execute the plan
const result = await reconcileApply(plan, fs, '/output', store, {
  progress: (op, path, i, total) => console.log(`${op} ${path}`),
})
// result: { created, updated, removed, skipped, errors }
```

### Workspace

Declarative directory management. Ties a directory (via `FileSystem`) to a `Store` for checkout, snapshot, reset, and diff operations. Generic over `FileSystem` and `Store` -- works in browser, Node, or memory.

```typescript
import { Workspace, Manifest, MemoryStore, MemoryFS } from '@avalanche-io/c4'

const ws = new Workspace('/project', fs, store)
await ws.load() // restore previous session state

// Checkout: make the directory match a manifest
await ws.checkout(manifest, {
  progress: (op, path, i, total) => console.log(`${op} ${path}`),
  dryRun: false,
})

// Snapshot: capture current directory state as a manifest
const current = await ws.snapshot({
  storeContent: true,  // also store file content
  skipHidden: true,
})

// Diff: compare current state against last checkout
const changes = await ws.diffFromCurrent()

// Reset: revert to the last checked-out manifest
await ws.reset()

// Status
ws.status() // { path, exists, hasManifest, manifestC4ID, created, lastCheckout }
ws.manifest // currently checked-out Manifest or null
```

### Observable Manifest

Event-driven wrapper around a Manifest. Fires events on mutations -- useful for UI bindings and reactive state.

```typescript
import { ObservableManifest, Manifest } from '@avalanche-io/c4'

const obs = new ObservableManifest(Manifest.create())

// Subscribe to specific events
const unsub = obs.on('add', (event) => {
  console.log(`added: ${event.path}`)
})

// Or listen to everything
obs.on('*', (event) => { /* any change */ })

// Mutations fire events
obs.addEntry(entry)       // fires 'add'
obs.removeEntry(entry)    // fires 'remove'
obs.updateEntry(entry, { size: 42 }) // fires 'modify'
obs.sortEntries()         // fires 'sort'

// Batch: accumulate changes, fire a single 'batch' event
obs.batch(() => {
  obs.addEntry(entry1)
  obs.addEntry(entry2)
  obs.removeEntry(entry3)
}) // fires one 'batch' event with all three changes

// Read operations delegate directly
obs.get('src/main.ts')
obs.files()
obs.summary()

unsub() // unsubscribe
```

### Pool / Ingest

Bundle a manifest with its referenced content for portable transfer (USB drives, archives, etc.), and absorb bundles back into a local store.

```typescript
import { pool, ingest } from '@avalanche-io/c4'

// Pool: create a portable bundle
const result = await pool(manifest, '/export/bundle', fs, store, {
  manifestName: 'project.c4m',
  progress: (c4id, i, total) => console.log(`[${i}/${total}] ${c4id}`),
})
// Creates: /export/bundle/project.c4m + /export/bundle/objects/c4...
// result: { copied, skipped, missing, manifestPath }

// Ingest: absorb a bundle into a local store
const ingested = await ingest('/import/bundle', fs, store, {
  progress: (path, i, total) => console.log(`[${i}/${total}] ${path}`),
})
// ingested: { copied, skipped, manifests }
```

## Browser

The core package includes browser-specific implementations that use standard Web APIs. Import from `@avalanche-io/c4/browser` (or directly from the source paths).

### IndexedDBStore

Persistent content store backed by IndexedDB. Content survives tab close, page reload, and browser restart. Blobs are stored as raw ArrayBuffers (no base64 overhead).

```typescript
import { IndexedDBStore } from '@avalanche-io/c4/browser'

const store = new IndexedDBStore('my-project')
const id = await store.put(fileBytes)
const stream = await store.get(id)
const count = await store.count()

// Iterate stored keys
for await (const key of store.keys()) {
  console.log(key) // "c4..."
}

store.close()     // close connection
await store.destroy() // delete entire database
```

### FileSystemAccessFS

Wraps the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API) to provide the standard `FileSystem` interface. Enables scanner, workspace, and reconciler operations on real directories in the browser.

```typescript
import { FileSystemAccessFS } from '@avalanche-io/c4/browser'
import { scan, Workspace } from '@avalanche-io/c4'

// User selects a directory
const dirHandle = await window.showDirectoryPicker()
const fs = new FileSystemAccessFS(dirHandle)

// Now use it like any other FileSystem
const manifest = await scan(fs, '', { computeIds: true })
const ws = new Workspace('', fs, store)
```

### Web Worker Hash Pool

Distributes SHA-512 hashing across multiple Web Workers to prevent UI blocking. Each worker uses WebCrypto (hardware-accelerated in all modern browsers). Worker script is inlined as a blob URL -- no separate file to serve.

```typescript
import { createHashPool } from '@avalanche-io/c4/browser'

const pool = createHashPool(4) // 4 workers (default: navigator.hardwareConcurrency)

// Hash a single item
const id = await pool.identify(largeFileBytes)

// Hash a File object directly
const fileId = await pool.identifyFile(file)

// Hash many items in parallel with progress
const ids = await pool.identifyAll(fileList, {
  progress: (done, total) => console.log(`${done}/${total}`),
})

pool.terminate() // clean up
pool.size        // number of workers
```

## Node.js

The `@avalanche-io/c4-node` package re-exports everything from core plus Node-specific implementations.

```typescript
import { NodeFS, TreeStore, openStore, identify, Manifest } from '@avalanche-io/c4-node'
```

### NodeFS

`FileSystem` implementation backed by `node:fs/promises`. Supports the full interface including `setMeta` (permissions and timestamps via `chmod` and `utimes`).

```typescript
import { NodeFS, scan, verify, Workspace } from '@avalanche-io/c4-node'

const fs = new NodeFS()
const manifest = await scan(fs, '/home/user/project')
const report = await verify(manifest, fs, '/home/user/project')
```

### TreeStore

Filesystem content store compatible with the Go and Python implementations. Uses the same layout: `store/c4/REMAINING_88_CHARS`. Writes use atomic temp-file-then-rename to prevent partial objects.

```typescript
import { TreeStore, openStore } from '@avalanche-io/c4-node'

// Explicit path
const store = new TreeStore('/home/user/.c4/store')

// Or use the default ($C4_STORE env, or ~/.c4/store)
const store2 = await openStore()

const id = await store.put(new TextEncoder().encode('hello'))
const stream = await store.get(id)
await store.remove(id)
```

## Architecture

c4ts is built on **interface-driven composition**. The two core interfaces -- `Store` (content-addressed blobs) and `FileSystem` (directory operations) -- are abstract. Every higher-level operation (scan, verify, reconcile, workspace, pool) is generic over these interfaces.

This means the same code works across environments:

| Component | Browser | Node.js | Testing |
|-----------|---------|---------|---------|
| **Store** | `IndexedDBStore` | `TreeStore` | `MemoryStore` |
| **FileSystem** | `FileSystemAccessFS` | `NodeFS` | `MemoryFS` |

The `ContentResolver` adds a third axis: multi-source content fetching with race and priority modes, accepting any `ContentSource` (stores, HTTP endpoints, peer connections).

## Works With

- **[c4](https://github.com/Avalanche-io/c4)** -- Go reference implementation and CLI
- **[c4py](https://github.com/Avalanche-io/c4-python)** -- Python implementation
- **[c4d](https://github.com/Avalanche-io/c4d)** -- C4 daemon for peer-to-peer content distribution
- **[libc4](https://github.com/Avalanche-io/libc4)** -- C implementation

## Compatibility

All implementations produce identical C4 IDs for the same input. Cross-language test vectors ensure:

- SHA-512 hash computation matches across Go, Python, TypeScript, and C
- Base58 encoding/decoding is identical
- Tree ID (Merkle) computation produces the same root
- c4m format parsing and encoding round-trips cleanly across implementations
- TreeStore on-disk layout (`c4/REMAINING`) is shared between Go, Python, and Node.js

## License

Apache 2.0
