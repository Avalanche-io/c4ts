# @avalanche-io/c4-node

Node.js extensions for C4 Universal Content Identification.

[![npm](https://img.shields.io/npm/v/@avalanche-io/c4-node.svg)](https://www.npmjs.com/package/@avalanche-io/c4-node)
[![Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

Adds `NodeFS` and `TreeStore` on top of [@avalanche-io/c4](https://www.npmjs.com/package/@avalanche-io/c4). Carries its own copy of core and re-exports it, so import everything from `@avalanche-io/c4-node`; mixing it with `@avalanche-io/c4` imports breaks `instanceof` checks.

## Install

```bash
npm install @avalanche-io/c4-node
```

## Quick Start

### NodeFS

`FileSystem` implementation backed by `node:fs/promises`. Supports the full interface including permissions and timestamps.

```typescript
import { NodeFS, scan, verify, Workspace } from '@avalanche-io/c4-node'

const fs = new NodeFS()
const manifest = await scan(fs, '/home/user/project')
const report = await verify(manifest, fs, '/home/user/project')
```

### TreeStore

Filesystem content store in Go's `store.TreeStore` layout, which c4py's `FSStore` shares: each object is a file named by its full 90-character C4 ID, in `store/<ID>` until a folder holds more than 4,096 objects, then split into `store/c4/<ID>` and `store/c4/XX/<ID>`. Stores written by c4ts 1.0.26 or earlier (`store/c4/<the ID's last 88 characters>`) stay readable. Writes are atomic (temp file then rename).

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

### openStore

Opens the default content store from `$C4_STORE` environment variable, or `~/.c4/store` if unset.

```typescript
import { openStore } from '@avalanche-io/c4-node'

const store = await openStore()
// or with an explicit path:
const store2 = await openStore('/tmp/my-store')
```

## Related Packages

- [@avalanche-io/c4](https://www.npmjs.com/package/@avalanche-io/c4) -- core package (identification, c4m, diff, verify, workspace)

## Links

- [GitHub](https://github.com/Avalanche-io/c4ts) -- full documentation and source

## License

Apache 2.0
