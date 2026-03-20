# Contributing to c4ts

## Project structure

```
c4ts/
  packages/
    core/          @avalanche-io/c4 — browser + Node, zero deps
      src/
        id.ts           C4 ID computation (SHA-512 + base58)
        tree.ts         Tree ID (Merkle set identity)
        base58.ts       Base58 encode/decode (Bitcoin alphabet)
        entry.ts        c4m entry type and formatting
        manifest.ts     Manifest class (sort, index, validate)
        decoder.ts      c4m text parser
        encoder.ts      c4m text output (canonical + pretty)
        diff.ts         Diff, merge, patch operations
        naturalsort.ts  Natural sort (file1 < file2 < file10)
        safename.ts     Universal filename encoding
        store.ts        Abstract Store interface + CompositeStore
        filesystem.ts   Abstract FileSystem interface
        resolver.ts     Multi-source ContentResolver
        memory-store.ts In-memory Store implementation
        memory-fs.ts    In-memory FileSystem implementation
        observable.ts   Reactive manifest wrapper
        scanner.ts      Directory scanner
        verify.ts       Manifest verification
        reconcile.ts    Filesystem reconciliation
        workspace.ts    Declarative directory management
        pool.ts         Bundle for transport
        errors.ts       Typed error classes
        browser/        Browser-specific implementations
      tests/
        vectors/        Cross-language test fixtures
    node/          @avalanche-io/c4-node — Node.js extensions
      src/
        node-fs.ts      node:fs/promises FileSystem
        tree-store.ts   Filesystem content store
  design/          Architecture documents
  examples/        Practical example scripts
```

## Development setup

```bash
git clone https://github.com/Avalanche-io/c4ts.git
cd c4ts
pnpm install
pnpm test          # run all tests (vitest)
pnpm lint          # type-check (tsc --noEmit)
```

## Running tests

```bash
npx vitest run              # all tests, single run
npx vitest                  # watch mode
npx vitest run id.test      # single test file
```

## Code style

- TypeScript strict mode
- No external dependencies in the core package
- All hashing is async (WebCrypto)
- Use `ReadableStream<Uint8Array>` for content, not `Buffer`
- Import with `.js` extensions (ESM)
- Prefer interfaces over abstract classes
- Functions over methods where it makes sense (e.g., `isDir(entry)` not `entry.isDir()`)

## Cross-language compatibility

C4 IDs and c4m files must be byte-identical across all implementations (Go, Python, C, TypeScript). Test vectors in `tests/vectors/known_ids.json` are shared with every implementation.

When changing ID computation, base58 encoding, c4m parsing, or manifest C4 ID computation, verify against the Go reference at https://github.com/Avalanche-io/c4.

## Adding a new module

1. Create `packages/core/src/modulename.ts`
2. Export from `packages/core/src/index.ts`
3. Write tests in `packages/core/tests/modulename.test.ts`
4. Use `MemoryStore` and `MemoryFS` in tests (no real I/O)
5. Type-check: `npx tsc --noEmit --project packages/core/tsconfig.json`

## Pull requests

- One logical change per PR
- Tests must pass
- Type-check must pass
- Include a test for any new behavior
- Keep the core package at zero dependencies

## License

Apache 2.0. By contributing, you agree that your contributions will be licensed under the same license.
