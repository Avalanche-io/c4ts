# c4ts Examples

Practical scripts demonstrating common workflows with `@avalanche-io/c4` and
`@avalanche-io/c4-node`. Each example is self-contained and runnable with
[tsx](https://github.com/privatenumber/tsx).

## Prerequisites

```bash
npm install -g tsx          # or: pnpm add -g tsx
cd c4ts && pnpm install     # install workspace dependencies
```

All Node.js examples import from `@avalanche-io/c4` (core, platform-agnostic)
and `@avalanche-io/c4-node` (Node.js filesystem + TreeStore). The browser
example has no dependencies beyond a modern browser.

---

## Examples

### verify-delivery.ts -- Verify a delivery against a c4m manifest

Check that every file in a directory matches the C4 IDs recorded in a c4m file.
Reports missing files, corrupted content, and unexpected extras.

```bash
npx tsx examples/verify-delivery.ts delivery.c4m /mnt/incoming/
```

**Replaces:** manual checksums, `md5sum -c`, per-file hash comparison scripts.

---

### find-duplicates.ts -- Find files with identical content

Scan a directory tree and group files that share the same C4 ID (byte-identical
content regardless of filename, path, or timestamp).

```bash
npx tsx examples/find-duplicates.ts /projects/HERO/
```

**Replaces:** `fdupes`, `jdupes`, custom dedup scripts.

---

### track-changes.ts -- Snapshot and diff a directory over time

First run scans a directory and saves a `.c4m` snapshot. Subsequent runs scan
again and diff against the saved snapshot, showing added, removed, and modified
files.

```bash
npx tsx examples/track-changes.ts /projects/shots/
```

**Replaces:** `rsync --dry-run`, `diff -rq`, manual before/after comparison.

---

### browser-verify.html -- Browser-based manifest verification

A single HTML file (no build step) that uses the File System Access API to
verify a local directory against a pasted c4m manifest. Works in Chrome, Edge,
and other Chromium browsers.

Open `examples/browser-verify.html` in your browser. Paste c4m text, pick a
directory, and watch the verification progress.

**Replaces:** downloading CLI tools just to check a delivery.

---

### workspace-workflow.ts -- Full workspace lifecycle

Demonstrates the Workspace class: create a workspace backed by a content store,
snapshot the initial state, modify files, diff to see changes, reset to restore,
and checkout a different manifest.

```bash
npx tsx examples/workspace-workflow.ts
```

**Replaces:** manual `cp -r` backup/restore, git for non-code asset directories.

---

### content-resolver.ts -- Multi-source content resolution

Shows ContentResolver with multiple stores (MemoryStore as fast cache,
TreeStore on disk as persistent storage). Demonstrates both race mode
(fastest source wins) and sequential fallback (priority order).

```bash
npx tsx examples/content-resolver.ts
```

**Replaces:** custom fallback logic, manual "check local then check remote"
code.

---

### observable-dashboard.ts -- Reactive manifest mutations

Wraps a Manifest in ObservableManifest, subscribes to change events, and
demonstrates add/remove/modify operations with both individual and batched
mutations. Events are printed as they fire.

```bash
npx tsx examples/observable-dashboard.ts
```

**Replaces:** polling for changes, manual dirty-tracking in UI code.

---

### portable-bundle.ts -- Bundle content for USB or air-gap transfer

Pack a directory and its content into a portable bundle (manifest + object
store), then unpack it on the receiving end. Content is deduplicated by C4 ID.

```bash
# Pack a delivery into a bundle directory
npx tsx examples/portable-bundle.ts pack /projects/delivery/ ./bundle/

# Unpack a received bundle into the local store
npx tsx examples/portable-bundle.ts unpack ./bundle/
```

**Replaces:** zip/tar archives, rsync over sneakernet, manual USB workflows.
