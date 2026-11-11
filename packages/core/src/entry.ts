import type { C4ID } from './id.js'
import { formatName, formatTarget } from './safename.js'

/** Flow link direction for cross-location data relationships. */
export const enum FlowDirection {
  None = 0,
  Outbound = 1,   // -> content here propagates there
  Inbound = 2,    // <- content there propagates here
  Bidirectional = 3, // <> two-way sync
}

/** Canonical timestamp format (RFC 3339, UTC). */
export const TIMESTAMP_FORMAT = 'YYYY-MM-DDTHH:MM:SSZ'

/** Unix epoch — the sentinel for null/unspecified timestamps. */
export const NULL_TIMESTAMP = new Date(0)

/** Sentinel for null/unspecified size. */
export const NULL_SIZE = -1

/**
 * The known zero mode: a regular file with no permission bits, written
 * `----------`. It is not the null mode, which is `mode === 0` and is
 * written `-`. The two differ for progressive resolution: null means not
 * yet checked, zero means checked and found zero (SPECIFICATION.md "Null
 * and Zero Values"). Bit 18 is set by no operating system mode and is
 * removed by `permBits`, so ZERO_MODE acts as 0 everywhere a mode is
 * applied. The same sentinel as the Go reference (`c4m.ZeroMode`).
 */
export const ZERO_MODE = 1 << 18

/** The permission and special bits of a mode (setuid, setgid, sticky, rwx). */
export const MODE_PERM_MASK = 0o7777

/**
 * Return a mode read from disk as a known mode: no on-disk mode is null,
 * so an all-zero mode becomes ZERO_MODE.
 */
export function knownMode(mode: number): number {
  return mode === 0 ? ZERO_MODE : mode
}

/** Returns true if the mode is null (unspecified). ZERO_MODE is not null. */
export function isNullMode(mode: number): boolean {
  return mode === 0
}

/** The bits a filesystem can apply: the mode without the ZERO_MODE sentinel. */
export function permBits(mode: number): number {
  return mode & MODE_PERM_MASK
}

/** A single file or directory entry in a c4m manifest. */
export interface Entry {
  mode: number          // Unix-style permissions (e.g. 0o644); 0 = null, ZERO_MODE = known zero
  modeType: string      // File type character: '-', 'd', 'l', 'p', 's', 'b', 'c'
  timestamp: Date       // UTC timestamp
  size: number          // File size in bytes, -1 = null
  name: string          // Bare filename (dirs end with '/')
  target: string        // Symlink target
  c4id: C4ID | null     // Content identifier
  depth: number         // Indentation level (0 = root)
  hardLink: number      // 0=none, -1=ungrouped, >0=group N
  flowDirection: FlowDirection
  flowTarget: string    // Location reference (e.g. "nas:renders/")
  isSequence: boolean
  pattern: string       // Original sequence pattern
}

/**
 * True if `name` is a path, not a bare entry name. Only "/" separates paths
 * in c4m, and a name may end in "/" only as a directory's marker: a name
 * holding any other "/", and ".", "..", "./", "../", "/" and "", are path
 * components (SPECIFICATION.md "Invalid names"; the shared name-rule
 * vector). A backslash is a literal name character, never a separator.
 * Go: c4m.isPathName.
 */
export function isPathName(name: string): boolean {
  if (name === '') return true
  const base = name.endsWith('/') ? name.slice(0, -1) : name
  return base === '' || base === '.' || base === '..' || base.includes('/') || base.includes('\0')
}

/** Create a new Entry with defaults. */
export function createEntry(partial: Partial<Entry> = {}): Entry {
  return {
    mode: 0,
    modeType: '-',
    timestamp: NULL_TIMESTAMP,
    size: NULL_SIZE,
    name: '',
    target: '',
    c4id: null,
    depth: 0,
    hardLink: 0,
    flowDirection: FlowDirection.None,
    flowTarget: '',
    isSequence: false,
    pattern: '',
    ...partial,
  }
}

/** Returns true if the entry represents a directory. */
export function isDir(e: Entry): boolean {
  return e.modeType === 'd' || e.name.endsWith('/')
}

/** Returns true if the entry represents a symbolic link. */
export function isSymlink(e: Entry): boolean {
  return e.modeType === 'l'
}

/** Returns true if the entry has a flow link declaration. */
export function isFlowLinked(e: Entry): boolean {
  return e.flowDirection !== FlowDirection.None
}

/** Returns the string representation of the flow direction. */
export function flowOperator(dir: FlowDirection): string {
  switch (dir) {
    case FlowDirection.Outbound: return '->'
    case FlowDirection.Inbound: return '<-'
    case FlowDirection.Bidirectional: return '<>'
    default: return ''
  }
}

/** Returns true if entry has any null metadata values. */
export function hasNullValues(e: Entry): boolean {
  const hasNullMode = isNullMode(e.mode)
  const hasNullTimestamp = e.timestamp.getTime() === 0
  const hasNullSize = e.size < 0
  return hasNullMode || hasNullTimestamp || hasNullSize
}

/** Returns list of fields that have null values. */
export function getNullFields(e: Entry): string[] {
  const fields: string[] = []
  if (isNullMode(e.mode)) fields.push('Mode')
  if (e.timestamp.getTime() === 0) fields.push('Timestamp')
  if (e.size < 0) fields.push('Size')
  return fields
}

// ---- Mode formatting/parsing ----

/** Convert numeric mode + type char to Unix mode string (e.g. "-rw-r--r--"). */
export function formatMode(modeType: string, mode: number): string {
  const buf: string[] = [modeType]
  const rwx = 'rwxrwxrwx'
  for (let i = 0; i < 9; i++) {
    if (mode & (1 << (8 - i))) {
      buf.push(rwx[i])
    } else {
      buf.push('-')
    }
  }
  // Special bits (setuid, setgid, sticky)
  if (mode & 0o4000) { // setuid
    buf[3] = buf[3] === 'x' ? 's' : 'S'
  }
  if (mode & 0o2000) { // setgid
    buf[6] = buf[6] === 'x' ? 's' : 'S'
  }
  if (mode & 0o1000) { // sticky
    buf[9] = buf[9] === 'x' ? 't' : 'T'
  }
  return buf.join('')
}

/**
 * Parse a 10-char Unix mode string to [modeType, mode]. A ten-character
 * mode is always known: all dashes is ZERO_MODE, never null.
 */
export function parseMode(s: string): [string, number] {
  if (s.length !== 10) {
    throw new Error(`mode must be 10 characters, got ${s.length}`)
  }

  const modeType = s[0]
  if (!"-dlpsbc".includes(modeType)) {
    throw new Error(`unknown file type: ${modeType}`)
  }
  // Each permission position holds its own letter or "-"; the execute
  // positions may also carry s/S (owner, group) or t/T (other), exactly what
  // every encoder writes. Any other character is refused: it used to read
  // as a clear bit (damaged-line vector).
  for (let i = 1; i < 10; i++) {
    const c = s[i]
    let allowed = "rwx"[(i - 1) % 3] + "-"
    if (i === 3 || i === 6) allowed += "sS"
    else if (i === 9) allowed += "tT"
    if (!allowed.includes(c)) {
      throw new Error(`invalid permission character "${c}" at position ${i + 1}`)
    }
  }
  let perm = 0

  // Permission bits
  if (s[1] === 'r') perm |= 0o400
  if (s[2] === 'w') perm |= 0o200
  if (s[3] === 'x' || s[3] === 's') perm |= 0o100
  if (s[4] === 'r') perm |= 0o040
  if (s[5] === 'w') perm |= 0o020
  if (s[6] === 'x' || s[6] === 's') perm |= 0o010
  if (s[7] === 'r') perm |= 0o004
  if (s[8] === 'w') perm |= 0o002
  if (s[9] === 'x' || s[9] === 't') perm |= 0o001

  // Special bits
  if (s[3] === 's' || s[3] === 'S') perm |= 0o4000
  if (s[6] === 's' || s[6] === 'S') perm |= 0o2000
  if (s[9] === 't' || s[9] === 'T') perm |= 0o1000

  return [modeType, knownMode(perm)]
}

// ---- Timestamp formatting/parsing ----

/** Format a Date as canonical c4m timestamp: YYYY-MM-DDTHH:MM:SSZ */
export function formatTimestamp(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, '0')
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0')
  const day = d.getUTCDate().toString().padStart(2, '0')
  const h = d.getUTCHours().toString().padStart(2, '0')
  const min = d.getUTCMinutes().toString().padStart(2, '0')
  const sec = d.getUTCSeconds().toString().padStart(2, '0')
  return `${y}-${m}-${day}T${h}:${min}:${sec}Z`
}

/** Parse a timestamp string to Date. Accepts canonical and ergonomic forms. */
export function parseTimestamp(s: string): Date {
  if (s === '-' || s === '0') return new Date(0)
  // Try ISO 8601 / RFC 3339 (handles both Z and offset)
  const d = new Date(s)
  if (!isNaN(d.getTime())) return d
  throw new Error(`cannot parse timestamp "${s}"`)
}

// ---- Size formatting ----

/** Format size with comma separators (e.g. 1,234,567). */
export function formatSizeWithCommas(size: number): string {
  if (size < 0) return '-'
  const s = size.toString()
  if (s.length <= 3) return s
  const parts: string[] = []
  for (let i = s.length - 1, count = 0; i >= 0; i--, count++) {
    if (count > 0 && count % 3 === 0) parts.push(',')
    parts.push(s[i])
  }
  return parts.reverse().join('')
}

// ---- Entry formatting ----

/** Format an entry as a c4m line with indentation. */
export function formatEntry(e: Entry, indentWidth: number, displayFormat: boolean): string {
  const indent = ' '.repeat(e.depth * indentWidth)

  // Mode: null is "-" in every form, display included; the known zero
  // (ZERO_MODE) formats as ten dashes.
  let modeStr: string
  if (isNullMode(e.mode)) {
    modeStr = '-'
  } else {
    modeStr = formatMode(e.modeType, e.mode)
  }

  // Timestamp
  let timeStr: string
  if (e.timestamp.getTime() === 0) {
    timeStr = '-'
  } else {
    timeStr = formatTimestamp(e.timestamp)
  }

  // Size
  let sizeStr: string
  if (e.size < 0) {
    sizeStr = '-'
  } else {
    sizeStr = displayFormat ? formatSizeWithCommas(e.size) : e.size.toString()
  }

  // Name
  const nameStr = formatName(e.name, e.isSequence)

  const parts: string[] = [indent + modeStr, timeStr, sizeStr, nameStr]

  // Link operators
  if (e.target !== '') {
    parts.push('->', formatTarget(e.target))
  } else if (e.hardLink !== 0) {
    if (e.hardLink < 0) {
      parts.push('->')
    } else {
      parts.push(`->${e.hardLink}`)
    }
  } else if (e.flowDirection !== FlowDirection.None) {
    parts.push(flowOperator(e.flowDirection), e.flowTarget)
  }

  // C4 ID
  if (e.c4id && !e.c4id.isNil()) {
    parts.push(e.c4id.toString())
  } else {
    parts.push('-')
  }

  return parts.join(' ')
}

/** Format an entry in canonical form (no indentation, null mode as "-"). */
export function canonicalEntry(e: Entry): string {
  // No indentation. Null mode renders as "-"; the known zero as "----------".
  let modeStr: string
  if (isNullMode(e.mode)) {
    modeStr = '-'
  } else {
    modeStr = formatMode(e.modeType, e.mode)
  }

  let timeStr: string
  if (e.timestamp.getTime() === 0) {
    timeStr = '-'
  } else {
    timeStr = formatTimestamp(e.timestamp)
  }

  let sizeStr: string
  if (e.size < 0) {
    sizeStr = '-'
  } else {
    sizeStr = e.size.toString()
  }

  const nameStr = formatName(e.name, e.isSequence)
  const parts: string[] = [modeStr, timeStr, sizeStr, nameStr]

  if (e.target !== '') {
    parts.push('->', formatTarget(e.target))
  } else if (e.hardLink !== 0) {
    if (e.hardLink < 0) {
      parts.push('->')
    } else {
      parts.push(`->${e.hardLink}`)
    }
  } else if (e.flowDirection !== FlowDirection.None) {
    parts.push(flowOperator(e.flowDirection), e.flowTarget)
  }

  if (e.c4id && !e.c4id.isNil()) {
    parts.push(e.c4id.toString())
  } else {
    parts.push('-')
  }

  return parts.join(' ')
}
