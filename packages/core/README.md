# @avalanche-io/c4

C4 Universal Content Identification for TypeScript.

[![npm](https://img.shields.io/npm/v/@avalanche-io/c4.svg)](https://www.npmjs.com/package/@avalanche-io/c4)
[![Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

TypeScript implementation of C4 (SMPTE ST 2114:2017) -- content identification by SHA-512 hash, encoded as base58. Zero runtime dependencies. Uses the native WebCrypto API for hardware-accelerated hashing.

Works in **browser and Node.js** from a single codebase.

## Install

```bash
npm install @avalanche-io/c4
```

## Quick Start

```typescript
import { identify, parse, Manifest, diff, verify } from '@avalanche-io/c4'

// Identify content (async -- WebCrypto)
const id = await identify(new TextEncoder().encode('Hello, World!'))
console.log(id.toString())
// c459dsjfscH38cYeXXYogktxf4Cd9ibshE3BHUo6a58hBXmRQ1rvW...

// Parse an existing C4 ID (synchronous)
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

## What's Included

- **Identification** -- `identify`, `identifyBytes`, `parse`, `C4ID`, `treeId`
- **c4m files** -- `Manifest`, `decode`, `encode`, `diff`, `merge`, `applyPatch`
- **Verify & Reconcile** -- compare a manifest against a filesystem, then make them match
- **Workspace** -- declarative directory management with checkout, snapshot, reset, diff
- **Content Store** -- `MemoryStore`, `CompositeStore`, `ContentResolver`
- **FileSystem** -- `MemoryFS` (in-memory), plus abstract `FileSystem` interface
- **Observable** -- event-driven manifest wrapper for reactive UI
- **Scanner** -- walk a directory, build a manifest with C4 IDs
- **Pool / Ingest** -- bundle content for portable transfer, absorb bundles back
- **Browser** -- `IndexedDBStore`, `FileSystemAccessFS`, Web Worker hash pool (import from `@avalanche-io/c4/browser`)

## Related Packages

- [@avalanche-io/c4-node](https://www.npmjs.com/package/@avalanche-io/c4-node) -- Node.js extensions (filesystem store, `node:fs` integration)

## Links

- [GitHub](https://github.com/Avalanche-io/c4ts) -- full documentation and source
- [C4 specification](https://www.smpte.org/) -- SMPTE ST 2114:2017

## License

Apache 2.0
