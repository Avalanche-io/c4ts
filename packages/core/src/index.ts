// C4 Universal Content Identification — TypeScript Implementation
// @avalanche-io/c4 v1.0.5

// Core ID
export { C4ID, identify, identifyBytes, parse } from './id.js'
export { treeId } from './tree.js'

// c4m Entry
export {
  type Entry,
  createEntry,
  FlowDirection,
  isDir,
  isSymlink,
  isFlowLinked,
  flowOperator,
  hasNullValues,
  getNullFields,
  formatMode,
  parseMode,
  formatTimestamp,
  parseTimestamp,
  formatEntry,
  canonicalEntry,
  formatSizeWithCommas,
  NULL_TIMESTAMP,
  NULL_SIZE,
} from './entry.js'

// c4m Manifest
export { Manifest } from './manifest.js'

// c4m Decoder/Encoder
export { decode, loads, type DecodeResult } from './decoder.js'
export { encode, dumps, type EncoderOptions } from './encoder.js'

// Diff, Merge, Patch
export {
  diff,
  merge,
  applyPatch,
  patchDiff,
  type DiffResult,
  type MergeResult,
  type MergeConflict,
  type PatchResult,
} from './diff.js'

// Natural Sort
export { naturalLess } from './naturalsort.js'

// SafeName Encoding
export {
  safeName,
  unsafeName,
  escapeC4MName,
  unescapeC4MName,
  formatName,
  formatTarget,
} from './safename.js'

// Errors
export {
  C4Error,
  InvalidEntryError,
  DuplicatePathError,
  PathTraversalError,
  InvalidFlowTargetError,
  PatchIDMismatchError,
  EmptyPatchError,
  BadIDLengthError,
  BadIDCharError,
} from './errors.js'
