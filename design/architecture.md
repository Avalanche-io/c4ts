# c4ts Architecture — Open Source Package Design

## Principle

Provide a complete, composable toolkit for building C4 applications in any JavaScript environment. The packages define abstract interfaces and ship concrete implementations for Node.js and browsers. Anyone can combine them to build desktop apps, web tools, CLI utilities, or editor extensions.

## Package Structure

```
@avalanche-io/c4          — Core (zero deps, browser + Node)
@avalanche-io/c4-node     — Node.js: filesystem store, scanner, workspace
```

Browser capabilities (IndexedDB store, File System Access API scanner, Web Worker pool) live in the core package because they use only standard web APIs — no bundler or polyfill needed.

## Core Package: @avalanche-io/c4

### Already Shipped (v1.0.5)

- C4 ID computation (SHA-512 + base58, WebCrypto)
- Tree ID (order-independent Merkle set identity)
- c4m format parser and encoder (canonical + pretty)
- Manifest class (sort, index, validate, computeC4ID)
- Entry type with full metadata (mode, timestamp, size, links, flow, sequences)
- Diff, three-way merge, patch chains
- Natural sort, SafeName encoding
- Typed errors matching Go sentinel errors

### Abstract Interfaces

The core package defines interfaces that decouple operations from storage and filesystem backends. Implementations are provided by the core (browser) and node packages.

#### Store

Content-addressed blob storage. Any object retrievable by its C4 ID.

```typescript
interface Store {
  has(id: C4ID): Promise<boolean>
  get(id: C4ID): Promise<ReadableStream<Uint8Array>>
  put(stream: ReadableStream<Uint8Array>): Promise<C4ID>
  remove?(id: C4ID): Promise<void>
}
```

Implementations:
- `MemoryStore` (core) — in-memory Map, useful for tests and small operations
- `IndexedDBStore` (core/browser) — browser-persistent, survives tab close
- `TreeStore` (node) — filesystem trie, compatible with Go/Python stores
- `CompositeStore` (core) — reads from multiple stores, writes to one

#### FileSystem

Abstract filesystem operations. Allows workspace/scanner/reconciler to work against any backend.

```typescript
interface FileSystem {
  readDir(path: string): AsyncIterable<DirEntry>
  stat(path: string): Promise<FileStat>
  readFile(path: string): Promise<ReadableStream<Uint8Array>>
  writeFile(path: string, data: ReadableStream<Uint8Array>): Promise<void>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  remove(path: string, options?: { recursive?: boolean }): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
}

interface DirEntry {
  name: string
  isDirectory: boolean
  isSymlink: boolean
}

interface FileStat {
  size: number
  mode: number
  mtime: Date
  isDirectory: boolean
  isSymlink: boolean
}
```

Implementations:
- `NodeFS` (node) — wraps `node:fs/promises`
- `FileSystemAccessFS` (core/browser) — wraps File System Access API handles
- `MemoryFS` (core) — in-memory tree, useful for tests

#### ContentResolver

Multi-source lazy content resolution. When content is needed, try sources in parallel (or priority order) and return the first to respond.

```typescript
interface ContentSource {
  has(id: C4ID): Promise<boolean>
  get(id: C4ID): Promise<ReadableStream<Uint8Array>>
  readonly name: string
  readonly priority: number  // lower = tried first
}

class ContentResolver {
  addSource(source: ContentSource): void
  removeSource(name: string): void

  // Resolve from fastest available source
  get(id: C4ID): Promise<ReadableStream<Uint8Array>>

  // Check availability across all sources
  has(id: C4ID): Promise<boolean>

  // Resolve with metadata about which source served it
  resolve(id: C4ID): Promise<{ stream: ReadableStream; source: string }>
}
```

Every Store is also a ContentSource. The resolver adds multi-source racing and fallback. This is the "pull content from anywhere" abstraction.

### Reactive Manifest

The Manifest class gains an optional observable layer. When entries change, subscribers are notified. This enables live UIs without polling.

```typescript
// Opt-in: wrap any manifest to make it observable
const reactive = new ObservableManifest(manifest)

reactive.on('add', (path, entry) => { ... })
reactive.on('remove', (path) => { ... })
reactive.on('modify', (path, oldEntry, newEntry) => { ... })
reactive.on('sort', () => { ... })

// Mutations fire events
reactive.addEntry(entry)    // fires 'add'
reactive.removeEntry(entry) // fires 'remove'

// Batch mutations (single event at end)
reactive.batch(() => {
  reactive.addEntry(a)
  reactive.addEntry(b)
  reactive.removeEntry(c)
}) // fires single 'batch' event with all changes
```

Built on EventTarget (standard, works in browser and Node 18+).

### Browser Features (in core, standard web APIs only)

#### IndexedDBStore

```typescript
const store = new IndexedDBStore('my-project')
await store.put(fileStream)
const stream = await store.get(c4id)
await store.has(c4id)
```

Uses IndexedDB object stores with C4 ID string keys. Blobs stored directly (no base64 overhead). Supports iteration for GC.

#### File System Access API Scanner

```typescript
const dirHandle = await window.showDirectoryPicker()
const fs = new FileSystemAccessFS(dirHandle)
const manifest = await scan(fs, '', {
  store,                                    // optional: store content during scan
  progress: (path, i) => { ... },
})
```

Also:
```typescript
// Drag-and-drop files
const manifest = await scanFiles(fileList, { progress })

// Single file identification
const id = await identifyFile(file)  // browser File API
```

#### File System Access API FileSystem

Wraps a `FileSystemDirectoryHandle` as a `FileSystem` interface, enabling workspace operations in the browser.

#### Web Worker Hash Pool

```typescript
const pool = createHashPool(4)  // 4 Web Workers
const id = await pool.identify(largeFile)
const ids = await pool.identifyAll(files, { progress })
pool.terminate()
```

Distributes SHA-512 hashing across workers. Each worker uses WebCrypto (hardware-accelerated). Essential for browser UX — hashing a 10 GB file on the main thread freezes the page.

#### Streaming Manifest Parser

For very large manifests (millions of entries), parse line by line without loading everything:

```typescript
for await (const entry of parseStream(readableStream)) {
  console.log(entry.name, entry.c4id?.toString())
}
```

### Verify

Compare a manifest against a filesystem (or store):

```typescript
const report = await verify(manifest, fileSystem, rootPath, { progress })
report.ok       // string[] — matching files
report.missing  // string[] — in manifest but not found
report.corrupt  // { path, expected, actual }[] — wrong C4 ID
report.extra    // string[] — on disk but not in manifest
report.isOk     // boolean — true if fully matches
```

Works with any FileSystem implementation (Node, browser, memory).

## Node Package: @avalanche-io/c4-node

### TreeStore

Filesystem content store compatible with Go's `store.TreeStore` and Python's `FSStore`. Adaptive trie sharding for large collections.

```typescript
const store = await openStore()  // C4_STORE env or ~/.c4/config
const store = new TreeStore('/path/to/store')

await store.put(readStream)           // atomic write (temp + rename)
const stream = await store.get(c4id)  // ReadableStream
const exists = await store.has(c4id)
```

### Scanner

```typescript
const manifest = await scan('/path/to/dir', {
  store,                        // optional: store content during scan
  followSymlinks: false,
  computeIds: true,
  progress: (path, i) => { ... },
})
```

Single-pass scanning: content is identified and stored simultaneously (zero extra I/O when store is provided). Skips hidden directories (`.git`, `.c4`, etc.).

### Workspace

Declarative directory management backed by a content store.

```typescript
const ws = new Workspace('/path/to/data', { store })

// Make directory match a manifest
await ws.checkout(manifest, { progress })

// Capture current state
const snap = await ws.snapshot({ storeContent: true })

// Undo all changes since checkout
await ws.reset()

// What changed?
const diff = await ws.diffFromCurrent()

// Workspace metadata
ws.status()  // { path, hasManifest, manifestC4ID, lastCheckout }
```

State persisted to `.c4-workspace.json` and `.c4-workspace-manifest.c4m` so it survives across process boundaries.

### Reconciler

The engine behind `checkout` and `reset`. Makes a directory match a manifest.

```typescript
// Dry run — see what would happen
const plan = await reconcile.plan(manifest, fileSystem, rootPath, { store })
plan.operations  // mkdir, create, update, remove, rmdir
plan.missing     // C4 IDs not in store

// Execute
const result = await reconcile.apply(plan, { progress })
result.created   // number
result.updated   // number
result.removed   // number
result.skipped   // number (already correct by C4 ID)
result.errors    // { path, error }[]
```

### Pool and Ingest

Bundle a manifest with its content for portable transfer:

```typescript
// Bundle
const result = await pool(manifest, outputDir, { store })
// Creates: outputDir/project.c4m, outputDir/store/...

// Absorb
const result = await ingest(bundleDir, { store })
```

## Design Principles

1. **Interface-first**: Abstract interfaces in core, implementations in packages. Any combination works.
2. **Streaming**: Use ReadableStream everywhere. Never buffer a whole file when a stream suffices.
3. **Progressive**: Manifests work with null values. Start with names, fill in metadata as it becomes available.
4. **Cross-language**: Byte-identical output with Go and Python reference implementations. Shared test vectors.
5. **Zero mandatory dependencies**: Core package has no npm dependencies. Node package depends only on core.
6. **Observable by default**: Reactive patterns are opt-in but first-class.
7. **Composable stores**: Stores stack (memory + IndexedDB + remote). ContentResolver races them.

## What This Enables (for downstream builders)

- **Desktop app** (Tauri/Electron): Core + Node packages, native UI
- **VS Code extension**: Core + Node packages, VS Code API
- **Browser delivery portal**: Core package only, single HTML file
- **CI/CD pipeline tool**: Node package, no UI
- **Mobile app** (React Native): Core package + native modules for hashing
- **Embedded in other tools**: Import just what you need

The open source suite provides every building block. The assembly is left to the builder.
