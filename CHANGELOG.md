# Changelog

## Unreleased (1.1)

### ⚠ plan() refuses a manifest holding a folded range, before writing anything

**Silent corruption fixed.** Handed a manifest holding a folded range (one
line such as `frame.[0001-0100].exr`), `plan()`/`apply()` and
`Workspace.checkout` wrote the range's ID list into one file named like the
range, wrote no frame, and reported success; `plan()` now refuses the whole
manifest with a `C4Error` naming the range, before anything is written (#59).

### ⚠ A time inside the epoch second is null, for entries a caller builds too

**Convergence fixed.** An entry built in memory with a time inside the
epoch second (`new Date(500)`, say) was written `1970-01-01T00:00:00Z`,
which reads back as null, so a manifest's C4 ID differed from the ID of its
own text. Every null test compared the unfloored time with the epoch
(`getTime() === 0`). The new `timestampIsNull` floors to the second first,
and every null-time test (the encoder, the entry's null checks, the
manifest's propagation and reconcile) uses it. The Node scan already
floored the second (`secondOf`), so scanned trees don't change. **C4 IDs
change** only for manifests holding a built entry timed in (0, 1) s after
the epoch. Tested by core's shared epoch-second vector (c4 #192), vendored
byte for byte.

### ⚠ `TreeStore` writes Go's store layout, and reads it and its own old one

**Data visibility fixed.** c4ts's `TreeStore` wrote `<store>/c4/<the ID's
last 88 characters>` and looked nowhere else. The c4 CLI and c4py write
`<store>/<ID>`, then `c4/<ID>` and `c4/XX/<ID>` as the store splits. So
in a shared store (both default to `~/.c4/store` and `C4_STORE`) c4ts read
none of the CLI's objects and the CLI read none of c4ts's (measured: 0 of 3,
0 of 34 in core's split-race-store fixture, 0 of 40 after a split, on 1.0.26,
1.0.27 and master). A Go split before c4 #171 also moved c4ts's files to
`c4/<88[0:2]>/<88>`, where c4ts did not look, so c4ts lost sight of its own
objects; no bytes were deleted. The docstrings claiming the two were
compatible were wrong.

`TreeStore` now ports Go's `TreeStore` as landed in c4 f2b05d3: full-ID
names, the root-first trie, the objects-only split (a journal, config or
other file stays where it is), the top-down lookup through case variants,
a three-way answer (an error other than not-found is never read as
absent: `has` says no, `get`, `put` and `remove` raise it), `get`'s
bounded re-search, `remove` of every copy, and a publish that lost a race
to another writer of the same bytes counting as success. Stores c4ts wrote
before stay readable, read-only: a lookup that finds nothing in Go's layout
reads `c4/<88>` and `c4/<88[0:2]>/<88>` where they lie, and never moves,
renames or deletes them. New objects go to Go's layout. Pinned by core's
split-race-store fixture (vendored byte for byte from c4 f2b05d3) and a
two-way test against the Go CLI, before and after a split.

To list the objects only c4ts could see in a store (POSIX shells):
`find "$C4_STORE/c4" -maxdepth 2 -type f | awk -F/ 'length($NF) == 88'`.

### ⚠ `patchDiff` removes a directory by restating its line alone

**Fix, data correctness:** to remove a directory, `patchDiff` restated the
directory's line and every entry under it. A directory restated with
children under it is deepened, never removed (SPECIFICATION.md, "Patch
Entry Semantics", the 2026-07-31 erratum), so c4ts's own patch removed the
directory's files and kept the directory, and so did any chain made by
appending it. A removed directory is now its own line alone, restated
exactly, as core's `PatchDiff` writes it. The shared changeset vector's new
step (c4 #178, vendored byte for byte from c4 6549554) pins this:
`patchDiff(v2, v3)` is `changeset-v3.c4m` byte for byte, and `v2.c4m` with
c4ts's own changeset appended resolves to `v3.c4m`. Measured on main
ad671b3 before the change, four tests failed, among them both of those
rows; every other row passed.

### ⚠ The Node scan records the second a file time falls in, as Go does

**C4 IDs change.** `NodeFS.stat` and `lstat` gave the scan Node's
`stat.mtime`, a Date built from a float of milliseconds, so a time in the
last half millisecond of a second was recorded as the next second, where Go
writes the second it falls in. Measured on main before the change (and on
the 1.0.26 package for the first two): `b.txt` (`…:40.9999997`) was `:41`
and `src/` (`…:42.999999999`) was `:43`, where Go writes `:40` and `:42`;
before 1970, `pre-round.txt` (−1.0000003 s) was `23:59:59Z`, where Go
writes `23:59:58Z`. The same file then gave c4ts and
Go different C4 IDs, as did every directory above it. The scan now reads
`stat(path, { bigint: true })` and floors `mtimeNs` to whole seconds
toward negative infinity (`secondOf`), so its entries hold exactly what
their c4m lines carry, and c4ts scan IDs for such files now match the Go
CLI's. The shared sub-second vector (c4 #173,
`fixtures/subsecond-vector/`, vendored byte for byte from c4 5efd481,
pre-1970 rows included) pins it: on main before the change its scan row
failed for `b.txt`, `src/` and `pre-round.txt`.

### `applyPatch` keeps an added entry under its own directory, and `patchDiff` writes `c4 diff`'s bytes

**Fix, data correctness:** `applyPatch` collected the patched state in a
path map's insertion order, so an addition went to the end and the tree
sort attached it to the last directory at its parent's depth. Patching
`a/new.txt` in while `b/` also changed produced `b/new.txt`. A chain
decode applies patches the same way, so reading a `c4 diff >>` chain could
put an added file in the wrong directory. Entries now go through in
full-path order, so each directory precedes its whole subtree.

`patchDiff` added its lines as additions, then modifications, then
removals, so an added file could come before its own directory's line;
written out, it followed a sibling directory's subtree, and the bytes were
not `c4 diff`'s. The section is now built in full-path order and sorted
canonically, files before directories. The shared changeset vector
(c4 #175, `fixtures/changeset-vector/`, vendored byte for byte from c4
0b410a2) pins it: `patchDiff(base, v2)`, written with the old state's ID
as its base line, is `changeset.c4m` byte for byte. Measured on main
before the change: that row failed (`new.txt` after `deep/`'s subtree),
and so did a two-directory case for both functions.

### Checkout and reset set each directory's recorded time and mode

**Fix, data correctness:** `reconcileApply`, and so `Workspace.checkout`
and `Workspace.reset`, set the recorded time and mode on files only. A
directory kept the time it was made and the platform's default mode. A
directory's timestamp and mode are part of its parent's listing
(SPECIFICATION.md, "Computing Directory C4 IDs"), so a checked-out tree did
not read back at the c4m's C4 ID, and `diffFromCurrent` reported every
directory holding a subdirectory as modified whenever the checkout ran in a
later second than the scan. That was the ordinary case for a user, and
the cause of the intermittent `workspace.test.ts` failure "diffFromCurrent
is clean after checkout and reset of a tree with directories" (`sub/`
reported modified), which passed only when the scan and the checkout fell
in the same second.

`apply` now sets every directory the c4m holds after all other
operations, deepest first, because writing a child moves a directory's
mtime on a real filesystem. A null timestamp on a directory the apply made
becomes the epoch, so it reads back null. On a directory that already
existed, a null timestamp or a null mode never overwrites. These are the
rules of core's `reconcile/apply.go`. `ReconcilePlan` gains an optional
`directories` list, each directory with its entry. No C4 ID of any c4m
changes; the trees a checkout makes now match them.

### ⚠ A range's size counts its ID list, and every operation carries the ID lists of the ranges it keeps

Core changed how folded sequences are sized and carried (c4 #159, #160 and
#161, master b82ec07; ruled 2026-11-13 by the maintainer: "The size is
the size of every frame and the frame id list", and "A frame id list is a
part of the c4m format, and is the same thing as a subdirectory being
referenced by it's ID on a parents directory line"). A range's size is
its frames' bytes plus count × 90, the length of its ID list. **Every
folded range's size line changes, and so do the C4 IDs of the
directories above it and of the c4m files that hold it** (in
`sequence-null-size-vector` the root ID moves from `c44F3Nmb…` to
`c41Jj92x…`). A range's own C4 ID names its list and does not change.
c4ts does not fold, so it writes no new range sizes itself; it reads
them, and derives directory sizes over them, as core does. Measured on main
before this change, against the three vectors re-vendored from
b82ec07: 2 of 92 vector checks failed, and 5 of the range-data
vector's 8 merge, diff and patch MUST rows (all three merges, the diff to
`add.c4m`, and `plain.c4m` patched with `add.c4m`); all pass after.

- **Fix, data loss (#159, merge, applyPatch, patchDiff, filter):** each
  of these dropped the ID lists of the folded ranges in its output, so
  the frames' C4 IDs were gone: ruled 2026-11-13 by the maintainer, "it
  is an error to drop the frame IDs in any context. Just like it would be
  an error to create a c4m tree and drop the subdirectories." `merge`
  and `applyPatch` kept only the base's lists, so a range either side or
  the patch added lost its list, and a range removed kept one.
  `patchDiff` and `filter` carried none. Each output now carries the
  list of every range it holds, from whichever input has it, and none for
  a range it does not; none is invented. A patch carries the lists of the
  ranges it adds or changes, after its entries; a removal line takes
  none. The output's description ID never depended on the lists, so no
  C4 ID of a state changes; the bytes, and so the byte ID, of a written
  merge, patch or filter do. The range-data vector's merge, diff and
  patch rows now pass byte for byte (`merged.c4m`, `add.c4m`,
  `remove.c4m`, and `folded.c4m` from `plain.c4m` patched with
  `add.c4m`).
- **Fix, data correctness (#159, chain decode):** resolving a patch
  chain kept every inline ID list the chain carried, so a range a patch
  removed still had its list written out, for a range the state no
  longer held (`range-data-vector/remove-chain.c4m` re-encoded with the
  plate list in it, not as `no-plate.c4m`). A resolved chain now keeps
  the list of each range it holds and no other; none is invented. A
  chain's description ID never depended on the lists, so no C4 ID
  changes; the bytes, and so the byte ID, of a re-encoded chain do.
- The normaliser (`canonicalize`) already sized a directory over a range
  child as its children's sizes plus its listing as written, so a
  directory holding `f.[001-003].exr` at 303 derives 446, as core's
  `-S` scan and normaliser now do (#161). Nothing changes; a test pins it.
- c4ts has no sequence expander: no such operation, so #160 (no list,
  no expansion) and the vector's two expansion rows have nothing to run.
- Vectors copied byte for byte from c4 master b82ec07:
  `range-data-vector` and `sequence-size-vector` (new) and
  `sequence-null-size-vector` (regenerated by #161: the plate range is
  now 384, 24 bytes of frames and a 4 × 90-byte list).
- The CI comparison CLI stays at b17c393: the comparison's output is
  byte-identical on b82ec07 (measured; only `c4 id -S` output changed,
  which the comparison does not run).

### A folded sequence's size is null when a frame's size is null: vector, no change in c4ts

The Go reference now writes a folded sequence's size as null when any
frame's size is null, where it had added the frame's -1 into the sum
(c4 #155; ruled 2026-11-13 by the maintainer: "One cannot use size as an
expectation if there are nulls present, so we must say nothing"; decided
for the ports 2026-11-13 by the release lead; reversible). c4ts does not
fold sequences, and it already decodes a range's `-` size as null and
keeps its range data, so nothing in c4ts changes and no C4 ID changes.
Measured before this change: `folded.c4m` decoded to its stated root ID
with the plate range known 24 and the shot range null, and re-encoded byte
for byte.

- The shared `sequence-null-size-vector` (c4 commit 7a6ba94, #156) is
  copied byte for byte, and its decode half is tested.
- New test: every vendored shared vector file is decoded and re-encoded
  canonically, as its vector README's "Round trip" table says (c4 #158 at
  7cdc9f3; the READMEs and three canonical partners are copied from
  there). The output's SHA-512 (node:crypto) must equal the file's own
  (`itself`) or its canonical partner's; a chain must resolve to the
  stated ID; a `refused` file must fail to decode. Every vendored file is
  named by exactly one row, and an unknown cell fails.
  `safename-vector/names.c4m` holds names that are not UTF-8, which c4ts
  refuses rather than replace, as its README states: the test asserts the
  refusal at its first such line and that every other line round-trips.
- The c4 CLI that CI installs for the comparison with the Go CLI moves
  from 5ee54b6 to b17c393.
- New test pinning the 2026-11-13 ruling the link-target-vector README
  now carries (decided by the release lead; reversible): a symlink line
  whose target has a flow target's shape (`host:path`, `C:foo`) reads as
  a flow link under a null mode `-` and as the symlink under
  `lrwxrwxrwx`. c4ts already read and wrote both as Go does (measured
  against c4 b17c393), so nothing changes.

### ⚠ On Windows, a directory's C4 ID changes for any tree with a subdirectory

On Windows, `NodeFS` now records a directory's mode as the Go reference
does: `drwxrwxrwx`, or `dr-xr-xr-x` when the directory is read-only. Go's
`os.Stat` on Windows gives every entry 0666 (0444 when read-only) and adds
0111 for a directory. Node gives the same bits without the 0111, so c4ts
wrote `drw-rw-rw-`. Neither side observes Unix permissions on Windows, so
Go's reading is the one to match. Files are unchanged: both give
`-rw-rw-rw-`, or `-r--r--r--` when read-only.

**This changes the C4 ID**, on Windows, of every directory that holds a
subdirectory, and so the description ID of any tree with one. A directory
holding only files keeps its ID, though its own line now reads
`drwxrwxrwx`. Found by the comparison with the Go CLI, once it ran on CI's
Windows leg.

### CI fails on a skipped test the allow-list does not name

A port can drift from a shared vector unnoticed when the test that compares
them is skipped. CI now runs vitest with its JSON reporter
(`pnpm test:json`, into `test-results/vitest.json`) and then
`scripts/skips.mjs` (`pnpm skips`, Node standard library only), which lists
every skipped or todo test with the source line that declared it, and fails
the job when one is not named in `scripts/allowed-skips.txt` for that OS
(`darwin`, `linux`, `win32` or `*`). A listed skip that did not happen is
reported, not failed on. Decided 2026-11-13 by the release lead;
reversible. Measured on CI, the list allows the two symlink tests and the
unreadable-file test on Windows only.

The comparison with the Go CLI no longer skips in CI. It finds `c4` through
`C4_BIN` or `PATH` (it looked only at `/opt/homebrew/bin/c4`, which no
runner has), and CI installs c4 master pinned at 5ee54b6. Since c4 1.1
streams a directory scan as a chain, the test compares c4ts's
`scan()`+`encode()` byte for byte with `c4 id <dir> | c4 patch -`, and
checks that `c4 id -q <dir>` equals c4ts's description ID. A 1.0.x CLI
cannot answer either (its `-q` prints nothing), so the test skips with
one, and the guard fails CI if it ever does.

### ⚠ SafeName's printable test is pinned to Unicode 17.0.0

SafeName writes a printable code point as itself (Tier 1). c4ts decided
"printable" with its own approximation: everything except C0/C1 controls,
DEL, surrogates and noncharacters. So it wrote unassigned code points
(U+0378), format characters (U+00AD, U+200B) and private-use code points as
themselves, where the Go reference escapes them, and a name holding one had
a different written form and C4 ID here than in Go.

Printable now means Go's `unicode.IsPrint` at Unicode 17.0.0 (letters,
marks, numbers, punctuation, symbols, and U+0020), taken from one pinned
table and never from the runtime (decided 2026-11-13 by the release lead;
reversible; c4 PR #149). `src/printable-table.ts` is generated by
`packages/core/scripts/gen-printable.mjs` from the shared
`printable-17.0.0.txt` (741 ranges, copied byte for byte from the Go
reference with the vector's updated README); lookup is a binary search.
U+0870 is written as itself and U+0378 is escaped on every runtime. The
shared SafeName vector's write test, held until now, runs and passes.

**This changes the C4 ID** of a description holding a name whose code
points' class differs between the old approximation and Unicode 17.0.0.

### ⚠ A size of 0 beside a C4 ID is a null size

A size of 0 beside a C4 ID other than the empty content's
(`c459dsjfscH38cYeXXYogktxf4Cd9ibshE3BHUo6a58hBXmRQdZrAkZzsWcbWtDg5oQstpDuni4Hirj75GEmTc1sFT`)
is now a null size on any entry that is not a symlink (ruled 2026-11-08;
landed 2026-11-13 with the Go reference, c4 PR #68, decided by the release
lead; reversible). A filesystem surface has no `-`, so a null size shows
there as 0, and only the empty content truly has size 0.

- New `sizeIsNull(entry)` is the one test, and new `EMPTY_CONTENT_ID` the
  constant it checks against.
- The decoder holds such a 0 as `NULL_SIZE`; `canonicalEntry`,
  `formatEntry` and `encode` (canonical and pretty) write it as `-`, so
  `0 f <ID>` and `- f <ID>` are one description with one C4 ID.
- Directory size propagation treats it as null, so the parent's size goes
  null over it; `hasNullValues`, `getNullFields` and `Manifest.summary`
  report it as unknown.
- Known zeros stay 0: a 0 with no C4 ID, a 0 with the empty content's ID,
  and a symlink's 0.

**This changes the C4 ID** of any description holding a 0 beside a
non-empty C4 ID on a file or directory. No scanner writes that
combination, so no scanned file changes meaning. The shared
`null-size-vector` fixture is copied byte for byte from the Go reference.

### Encoding a description keeps its external base

`encode` (and `Manifest.encode`, `dumps`) never wrote a manifest's `base`,
the first-line bare C4 ID naming the block a description refines, although
`Manifest.parse`, `decode` and `loads` keep it. So parse then encode turned
a block on a base into a standalone description of the block's own entries,
silently (found 2026-11-13 in the Go reference, c4 PR #145). Canonical and
pretty encoding now write a set base as the first line, then the entries
exactly as before. A manifest with no base encodes byte for byte as before;
the description ID and `canonical()` are unchanged. This package has no
patch encoder that writes its own first line, so nothing else changes.

### ⚠ BREAKING: a c4m file that ends with a bare C4 ID is refused

A bare C4 ID at the end of a c4m file is a format error (ruled 2026-11-08:
a c4m file never ends with its own ID). A bare C4 ID stands only as the
first-line external base reference, or as a checkpoint before a patch
section. Until now a final bare ID was accepted as the "closing validator"
of the 2026-07-13 erratum: `Manifest.parse` verified it, and `decode` and
`loads` recorded it without a word.

Every reader now refuses it with the new `TrailingIDError`, whose message
names the line and the fix:

    c4m: a bare C4 ID ends the file; a c4m file never ends with its own ID
    (line N): delete that line, or rewrite the file with
    `c4 id FILE.c4m > fixed.c4m`

`Manifest.parse` still verifies that final ID as a checkpoint first, as the
Go reference does, so a wrong one is a `PatchIDMismatchError`. A file that
is only a first-line base reference is unchanged: no entries, `base` set.

Chains written with `c4 diff FILE.c4m DIR >> FILE.c4m` by c4 1.0.13 through
1.0.26 have this shape. `c4 id FILE.c4m` (c4 1.1) verifies the final ID,
drops it and rewrites the file; this package has no normaliser of its own.

The shared `chain-vector` and `deepen-vector` fixtures lost their final
bare-ID lines (root IDs unchanged), copied byte for byte from the Go
reference.
