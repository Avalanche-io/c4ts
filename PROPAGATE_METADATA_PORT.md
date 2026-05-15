# c4 Go reference release v1.0.13 — port report for c4ts

The Go reference implementation at `~/ws/active/c4/oss/c4` cut v1.0.13 with
seven changes. Some are algorithmic bugs that almost certainly exist in
TypeScript too; others are API additions you may or may not want to
mirror. This file is for the c4ts agent's next-run review.

When you've audited everything below, **delete this file** (or replace it
with a `PORT_STATUS.md` recording what you decided about each item).

## Algorithmic bugs likely shared with c4ts

### 1. O(D × N) metadata propagation — almost certainly present

Whole-tree directory size / timestamp propagation was `O(directories ×
entries)` in the Go code because `getDirectoryChildren` (or its
equivalent) rescanned the full entry array once per null-sized directory.
On a 5.14M-entry tree this produced a 16-20 minute hang. V8's
single-threaded event loop makes the hang even more user-visible.

The fix: single-pass depth-stack accumulator. See
`~/ws/active/c4/oss/c4/c4m/manifest.go` `PropagateMetadata` and
`~/ws/active/c4/oss/c4/design/scan-memory-and-throughput.md` for the full
investigation, the algorithm, the empty-directory edge case (an empty
dir resolves to Size = 0 with a still-null Timestamp — needs an explicit
`hadChildren` flag), and the cheap whole-manifest early-out.

**Action**: inspect c4ts for any loop of the shape "for each directory
with null size, walk all entries looking for children." Convert to a
single-pass depth-stack pass. Preserve nil-infectious semantics
(`SPECIFICATION.md` rule: any descendant with null Size or Timestamp
poisons the parent recursively to root).

### 2. O(N²) sibling sort on pathological trees — likely present

Manifest sort was `O(N²)` worst case on a deeply nested single-child
chain (depth = N) because a recursive `processLevel` rescanned the
remaining entry tail at each level. On a 100K-deep chain this took 10.9
seconds; the single-pass children-by-parent index gets it to 33 ms
(327× speedup). Normal balanced trees were unaffected.

**Action**: inspect c4ts's manifest sort. If it uses recursive
level-by-level scanning of the entry list, convert to a depth-stack
parent index built in one linear pass, then sort each parent's child
group with the existing comparator (files-before-dirs + natural sort),
then emit depth-first.

## Go-specific API additions — port only if c4ts wants them

### 3. `c4m.PropagateMetadata` is now exported

Producers of manifests should call the canonical implementation rather
than maintain parallel copies. If c4ts has a scan-side propagator that
diverges semantically from the c4m-side one (the Go scan version had
permissive null handling, which violated the spec), the same consolidation
applies.

### 4. Streaming canonical form

`c4m.Manifest.WriteCanonical(io.Writer) error` streams canonical bytes
one entry per line. `Canonical()` still returns a string for back-compat;
`ComputeC4ID` now hashes via the stream. Cuts allocations ~23% at 100K
entries.

In TypeScript / Node: a `writeCanonical(writable: stream.Writable): void`
method, or pipe through a `crypto.createHash('sha512')` transform. In
the browser: feed `SubtleCrypto.digest` chunks via a streaming API.

### 5. Bounded parallel subdirectory walk

Opt-in parallel walk via a shared buffered-channel semaphore.
**Byte-identical output regardless of concurrency level** — children are
stitched in source order. 5.6× cold-cache speedup on a 122K-entry tree.

In Node: `Promise.all` over subdirectory tasks with a semaphore (e.g.
`p-limit`). Most c4 scan time is I/O, so async fs operations parallelize
well. In browser context this is less relevant.

### 6. Scan progress callback

`scan.WithProgress(func(ScanStats))` fires at most every 1000 entries
or every 250 ms (whichever first), plus once at end. Zero overhead when
not registered.

In TypeScript: an `onProgress?: (stats: ScanStats) => void` option.
`performance.now()` or `Date.now()` for the rate limit.

### 7. Streaming entries + cancellation

`scan.WithEntryStream(cb)` fires per discovered entry; non-nil error
halts the scan. `scan.WithContext(ctx)` for cancellation at directory
and entry boundaries.

In TypeScript: an `AsyncIterable<Entry>` API (most idiomatic), or a
callback parameter. For cancellation, accept an `AbortSignal` and check
`signal.aborted` at the same points the Go code checks `ctx.Done()`.

## Reference material in the Go repo

- `~/ws/active/c4/oss/c4/CHANGELOG.md` — full v1.0.13 entry
- `~/ws/active/c4/oss/c4/design/scan-memory-and-throughput.md` — design
  doc for the propagation fix
- `~/ws/active/c4/oss/c4/c4m/SPECIFICATION.md` — unchanged
- `~/ws/active/c4/oss/c4/c4m/manifest.go` — `PropagateMetadata`,
  `WriteCanonical`, `sortSiblingsHierarchically`
- `~/ws/active/c4/oss/c4/scan/generator.go` — new options
- `~/ws/active/c4/oss/c4/ARCHITECTURAL_CATALOG.md` — updated API
  inventory

Delete this file (or convert to `PORT_STATUS.md`) once you've audited
items 1 and 2 and decided on items 3-7.
