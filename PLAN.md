# c4ts — C4 for TypeScript

> **Note**: This is the original design vision document. The implementation has evolved — see [README.md](./README.md) for the actual API and [design/architecture.md](./design/architecture.md) for the current architecture. API names and structure below may differ from what was shipped.

## Vision

A native TypeScript implementation of C4 that runs in browsers AND Node.js. The browser capability is the killer differentiator — no other C4 implementation can verify a delivery, diff two manifests, or scan a directory without installing anything.

## Package Structure

```
@avalanche-io/c4              — Core: ID, c4m format, operations (browser + Node)
@avalanche-io/c4-node          — Node.js: filesystem scan, store, reconcile
```

The core package has zero dependencies and works in any JavaScript environment. The node package adds filesystem operations.

## Core Package (@avalanche-io/c4)

### C4 ID (browser + Node)

```typescript
import { identify, identifyBytes, parse, treeId, C4ID } from '@avalanche-io/c4'

// SHA-512 via WebCrypto (hardware-accelerated in all modern browsers and Node)
const id = await identify(readableStream)
const id = await identifyBytes(new Uint8Array([...]))
const id = await identifyFile(file)  // browser File API
const id = parse('c45xZeXwMSpq...')

// Tree IDs
const setId = await treeId([id1, id2, id3])

// C4ID type
id.toString()     // 90-char string
id.digest         // Uint8Array(64)
id.hex()          // hex string
id.isNil()        // boolean
id.equals(other)  // comparison
```

Note: all hashing is async because WebCrypto is async. This is the right design for TypeScript.

### c4m Format (browser + Node)

```typescript
import { load, loads, dump, dumps, Manifest, Entry } from '@avalanche-io/c4'

// Parse
const manifest = loads(c4mText)
const manifest = await load(url)       // fetch + parse

// Encode
const text = dumps(manifest)
const text = dumps(manifest, { pretty: true })

// Manifest operations
manifest.get('src/main.go')            // path lookup
manifest.has('src/main.go')            // boolean
manifest.filter('*.exr')               // glob filter
manifest.filter((path, entry) => ...)  // predicate filter
manifest.files()                       // iterate non-directories
manifest.directories()                 // iterate directories
manifest.duplicates()                  // Map<C4ID, string[]>
manifest.summary()                     // "N files, M dirs, X TB"

// Iteration
for (const [path, entry] of manifest) { ... }

// Diff
const result = diff(oldManifest, newManifest)
result.added      // Entry[]
result.removed    // Entry[]
result.modified   // Entry[]

// Merge
const { merged, conflicts } = merge(base, local, remote)

// Patch chains
const sections = decodePatchChain(c4mText)
const resolved = resolvePatchChain(sections)
```

### Browser-Specific Features

```typescript
import { scanFiles, scanDirectory, verifyFiles } from '@avalanche-io/c4'

// File System Access API — scan a real directory in the browser
const dirHandle = await window.showDirectoryPicker()
const manifest = await scanDirectory(dirHandle, {
  progress: (path, i, total) => updateUI(path, i, total),
  workers: navigator.hardwareConcurrency,  // parallel hashing via Web Workers
})

// Drag-and-drop files
dropzone.ondrop = async (e) => {
  const files = e.dataTransfer.files
  const manifest = await scanFiles(files, { progress })
}

// Verify: compare manifest against directory
const report = await verifyDirectory(manifest, dirHandle, { progress })
report.ok        // string[]
report.missing   // string[]
report.corrupt   // { path, expected, actual }[]

// IndexedDB as content store
import { BrowserStore } from '@avalanche-io/c4'
const store = new BrowserStore('my-project')
await store.put(file)
const blob = await store.get(c4id)
```

### Web Worker Hashing

For large files, hashing in a Web Worker prevents UI blocking:

```typescript
import { createHashWorkerPool } from '@avalanche-io/c4'

const pool = createHashWorkerPool(4)  // 4 workers
const id = await pool.identify(largeFile)
pool.terminate()
```

### Streaming

```typescript
import { identifyStream } from '@avalanche-io/c4'

// Hash a ReadableStream (fetch response, file stream, etc.)
const response = await fetch('https://example.com/large-file.bin')
const id = await identifyStream(response.body)
```

## Node Package (@avalanche-io/c4-node)

```typescript
import { scan, reconcile, TreeStore, openStore } from '@avalanche-io/c4-node'

// Scan directory
const manifest = await scan('/path/to/dir', {
  store,
  mode: 'full',
  progress: (path, i) => console.log(path),
})

// Content store (shared with Go tools)
const store = await openStore()  // C4_STORE env or ~/.c4/config
const store = new TreeStore('/path/to/store')
await store.put(readStream)
const stream = await store.get(c4id)

// Reconcile (make directory match manifest)
const plan = await reconcile.plan(manifest, '/path/to/dir', { store })
const result = await reconcile.apply(plan)

// Pool and ingest
await pool(manifest, '/path/to/bundle', { store })
await ingest('/path/to/bundle', { store })

// Workspace
const ws = new Workspace('/path/to/data', { store })
await ws.checkout(manifest)
await ws.reset()
const snap = await ws.snapshot()
const diff = await ws.diffFromCurrent()
```

## Unique TypeScript/Web Features

### 1. Browser c4m Viewer Component

A zero-dependency web component for viewing c4m files:

```html
<c4m-viewer src="project.c4m"></c4m-viewer>
```

Or programmatic:
```typescript
import { C4MViewer } from '@avalanche-io/c4'
const viewer = new C4MViewer(manifest)
document.body.appendChild(viewer.element)
```

### 2. Delivery Portal

A self-contained HTML page (single file, no build step) that:
- Accepts a c4m file (paste or drag)
- Lets the user select a directory (File System Access API)
- Verifies every file against the manifest
- Shows results with progress

This is the "email someone a c4m file and a link" workflow.

### 3. c4m Diff Viewer

Browser-based side-by-side diff of two manifests:
```typescript
import { DiffViewer } from '@avalanche-io/c4'
const viewer = new DiffViewer(oldManifest, newManifest)
```

### 4. Streaming Manifest Parser

For very large manifests, parse line by line without loading everything:
```typescript
import { parseStream } from '@avalanche-io/c4'

for await (const entry of parseStream(readableStream)) {
  console.log(entry.name, entry.c4id?.toString())
}
```

### 5. TypeScript-Native Types

Full type safety with generics, discriminated unions for entry types:
```typescript
type FileEntry = Entry & { isDir: false, c4id: C4ID }
type DirEntry = Entry & { isDir: true }
type SymlinkEntry = Entry & { target: string }

// Type-safe filtering
manifest.files()       // Iterable<[string, FileEntry]>
manifest.directories() // Iterable<[string, DirEntry]>
```

## Project Structure

```
c4ts/
  packages/
    core/                    — @avalanche-io/c4
      src/
        id.ts               — C4ID, identify, parse, treeId
        manifest.ts          — Manifest class
        entry.ts             — Entry type
        encoder.ts           — c4m text output
        decoder.ts           — c4m text parser
        diff.ts              — diff, merge, patch operations
        naturalsort.ts       — natural sort
        safename.ts          — filename encoding
        base58.ts            — base58 encode/decode (BigInt)
        store.ts             — abstract Store interface
        browser/
          scanner.ts         — File System Access API scanner
          store.ts           — IndexedDB store
          worker.ts          — Web Worker hash pool
          viewer.ts          — c4m viewer web component
        index.ts             — public API
      tests/
        id.test.ts
        manifest.test.ts
        cross-language.test.ts  — same vectors as Go/Python/C++
      package.json
      tsconfig.json
    node/                    — @avalanche-io/c4-node
      src/
        scanner.ts           — fs.readdir + crypto scanner
        store.ts             — TreeStore (filesystem)
        reconcile.ts         — plan + apply
        workspace.ts         — Workspace class
        pool.ts              — pool + ingest
        index.ts
      tests/
      package.json
      tsconfig.json
  vitest.config.ts
  pnpm-workspace.yaml
```

## Build Targets

- ESM (modern browsers, Node 18+)
- CJS (legacy Node)
- Browser bundle (single file, for CDN/script tag)
- TypeScript declarations (.d.ts)
- Source maps

## Test Strategy

- Vitest for unit tests
- Playwright for browser integration tests
- Cross-language vectors from Go reference (same known_ids.json as c4py)
- Browser-specific tests: Web Worker hashing, File System Access API, IndexedDB store

## Performance Notes

- WebCrypto SHA-512 is hardware-accelerated in Chrome, Firefox, Safari, Node.js
- BigInt for base58 is native and fast (no library needed)
- Web Workers for parallel hashing (crucial for browser UX)
- ReadableStream for streaming hash (no memory copy)
- TextDecoder for c4m parsing (fast UTF-8)

## Naming

- npm: `@avalanche-io/c4` and `@avalanche-io/c4-node`
- Alternative if scoped packages are an issue: `c4js` and `c4js-node`
- Import: `import { identify } from '@avalanche-io/c4'`

## Priority Order

1. Core ID computation + cross-language tests (prove byte-identical output)
2. c4m parser + encoder (canonical output matches Go)
3. Manifest operations (diff, merge, patch chains)
4. Browser scanner (File System Access API)
5. Node.js scanner + store
6. Browser store (IndexedDB)
7. Web Worker pool
8. Viewer web component
9. Delivery verification portal
10. Node.js reconcile + workspace
