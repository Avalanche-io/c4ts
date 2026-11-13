# Changelog

## Unreleased (1.1)

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
