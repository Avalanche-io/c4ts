import { C4ID, parse as parseC4ID, identifyBytes } from './id.js'
import {
  type Entry,
  createEntry,
  FlowDirection,
  parseMode,
  parseTimestamp,
  isDir,
  isPathName,
} from './entry.js'
import { unsafeName } from './safename.js'
import {
  InvalidEntryError,
  EmptyPatchError,
} from './errors.js'
import type { Manifest } from './manifest.js'

const C4_ID_PATTERN = /^c4[1-9A-HJ-NP-Za-km-z]{88}$/
const SEQUENCE_PATTERN = /\[[\d,:-]+\]/

/** Check if a line is exactly a bare C4 ID (90 chars starting with "c4"). */
function isBareC4ID(s: string): boolean {
  return s.length === 90 && s[0] === 'c' && s[1] === '4'
}

/** Check if a line is an inline ID list (>90 chars, multiple of 90, all valid IDs). */
function isInlineIDList(s: string): boolean {
  const n = s.length
  if (n <= 90 || n % 90 !== 0 || s[0] !== 'c' || s[1] !== '4') return false
  for (let i = 0; i < n; i += 90) {
    if (!C4_ID_PATTERN.test(s.substring(i, i + 90))) return false
  }
  return true
}

/** Check if text at position matches a flow target pattern (name:...). */
function isFlowTarget(s: string): boolean {
  if (s.length === 0) return false
  const ch = s[0]
  if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z'))) return false
  for (let i = 1; i < s.length; i++) {
    const c = s[i]
    if (c === ':') return true
    if (c === ' ') return false
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '-')) {
      return false
    }
  }
  return false
}

/** Check if raw text contains unescaped sequence notation. */
function hasUnescapedSequenceNotation(raw: string): boolean {
  let buf = ''
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\' && i + 1 < raw.length) {
      buf += '__'
      i++
      continue
    }
    buf += raw[i]
  }
  return SEQUENCE_PATTERN.test(buf)
}

/**
 * Parse a name or target from a line, handling backslash escapes.
 * Returns [parsed, newPos, hasUnescapedBrackets].
 */
function parseNameOrTarget(line: string, pos: number): [string, number, boolean] {
  const n = line.length
  let buf = ''
  let hasUnescapedBrackets = false

  while (pos < n) {
    const ch = line[pos]

    // A backslash always starts a two-byte escape: a c4m field-boundary
    // escape becomes its literal, any other (a SafeName escape such as
    // \\\\) passes through whole, so its second byte never starts an escape
    // of its own. A name ending in a backslash read back with a space added
    // before this (backslash-name vector).
    if (ch === '\\' && pos + 1 < n) {
      const next = line[pos + 1]
      if (next === ' ' || next === '"' || next === '[' || next === ']') {
        buf += next
      } else {
        buf += ch + next
      }
      pos += 2
      continue
    }

    if (ch === '[' || ch === ']') {
      hasUnescapedBrackets = true
    }

    // A "/" ends a directory's name, and only where the field ends with it.
    // Anything after it but a space is part of the name, which then holds
    // a "/" and is refused with its line by parseEntryFromLine. Before, the
    // name was cut at its first "/" and the rest of the line, C4 ID
    // included, dropped (name-rule vector).
    if (ch === '/' && (pos + 1 >= n || line[pos + 1] === ' ')) {
      buf += '/'
      pos++
      return [buf, pos, hasUnescapedBrackets]
    }

    // Check for boundary: space(s) followed by link operator, c4 prefix, or
    // null. Aligned (pretty) forms pad fields with runs of spaces, so the
    // lookahead skips the whole run before testing (mirrors Go's
    // parseNameOrTarget). Through 1.0.24 only one space was tested, so a
    // pretty line whose C4 ID column is "-" read its padding into the name
    // and a names-only pretty file matched nothing real (2026-11-09).
    if (ch === ' ') {
      let j = pos
      while (j < n && line[j] === ' ') j++
      const rest = line.substring(j)
      if (rest === '') {
        // Trailing padding: the name ended at the first space.
        return [buf, pos, hasUnescapedBrackets]
      }
      if (rest.startsWith('-> ') || rest.startsWith('<- ') || rest.startsWith('<> ')) {
        return [buf, pos, hasUnescapedBrackets]
      }
      // Hard link group: "->N"
      if (rest.length >= 3 && rest[0] === '-' && rest[1] === '>' && rest[2] >= '1' && rest[2] <= '9') {
        return [buf, pos, hasUnescapedBrackets]
      }
      if (rest.length >= 2 && rest[0] === 'c' && rest[1] === '4') {
        return [buf, pos, hasUnescapedBrackets]
      }
      if (rest[0] === '-' && (rest.length === 1 || rest[1] === ' ')) {
        return [buf, pos, hasUnescapedBrackets]
      }
    }
    buf += ch
    pos++
  }

  return [buf, pos, hasUnescapedBrackets]
}

/**
 * Parse a symlink target — unlike names, `/` is not a boundary.
 */
function parseTarget(line: string, pos: number): [string, number] {
  const n = line.length
  let buf = ''

  while (pos < n) {
    const ch = line[pos]
    // A backslash always starts a two-byte escape (as in names).
    if (ch === '\\' && pos + 1 < n) {
      const next = line[pos + 1]
      if (next === ' ' || next === '"') {
        buf += next
      } else {
        buf += ch + next
      }
      pos += 2
      continue
    }
    // The pretty form pads before the C4 ID field; the whole run of
    // spaces is skipped before asking whether that field starts.
    if (ch === ' ' && startsIDField(line, pos)) {
      return [buf, pos]
    }
    buf += ch
    pos++
  }

  return [buf, pos]
}

/** Parse a flow target (location:path). */
function parseFlowTarget(line: string, pos: number): [string, number] {
  const n = line.length
  const start = pos
  while (pos < n) {
    if (line[pos] === ' ' && startsIDField(line, pos)) {
      return [line.substring(start, pos), pos]
    }
    pos++
  }
  return [line.substring(start, pos), pos]
}

/**
 * Whether the run of spaces at pos is followed by the C4 ID field: a C4 ID,
 * or the null "-" as the last field.
 */
function startsIDField(line: string, pos: number): boolean {
  while (pos < line.length && line[pos] === ' ') pos++
  const rest = line.substring(pos)
  return rest.startsWith('c4') || rest === '-' || rest.startsWith('- ')
}

/**
 * Whether s, the rest of a line after a link operator, is exactly one field
 * that is a C4 ID or the null "-". A field ends at an unescaped space.
 */
function isLoneIDField(s: string): boolean {
  if (s === '-') return true
  if (!s.startsWith('c4')) return false
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      i++
      continue
    }
    if (s[i] === ' ') return false
  }
  try {
    parseC4ID(s)
    return true
  } catch {
    return false
  }
}

/** Parse the fields after timestamp: size, name, link ops, c4id. */
function parseEntryFields(
  line: string,
  mode: number,
  modeType: string,
): {
  size: number
  name: string
  rawName: string
  target: string
  c4id: C4ID | null
  hardLink: number
  flowDir: FlowDirection
  flowTarget: string
} {
  let pos = 0
  const n = line.length

  // Skip leading whitespace
  while (pos < n && line[pos] === ' ') pos++

  // 1. Parse size
  const tokStart = pos
  let size: number
  if (line[pos] === '-') {
    size = -1
    pos++
  } else {
    const sizeStart = pos
    while (pos < n && ((line[pos] >= '0' && line[pos] <= '9') || line[pos] === ',')) pos++
    const sizeStr = line.substring(sizeStart, pos).replace(/,/g, '')
    size = parseInt(sizeStr, 10)
    if (isNaN(size)) throw new InvalidEntryError(`invalid size "${line.substring(sizeStart, pos)}"`)
  }
  // The size token ends at a space: "6x a.txt" read as size 6 and the name
  // "x a.txt", a different entry with no error (damaged-line vector).
  if (pos < n && line[pos] !== ' ') {
    let end = pos
    while (end < n && line[end] !== ' ') end++
    throw new InvalidEntryError(`invalid size "${line.substring(tokStart, end)}"`)
  }

  // Skip whitespace
  while (pos < n && line[pos] === ' ') pos++

  // 2. Parse name
  const nameStart = pos
  let hasUnescapedBrackets: boolean
  let name: string
  ;[name, pos, hasUnescapedBrackets] = parseNameOrTarget(line, pos)
  const rawName = line.substring(nameStart, pos)

  // Skip whitespace
  while (pos < n && line[pos] === ' ') pos++

  // 3. Check for link operators
  let target = ''
  let hardLink = 0
  let flowDir = FlowDirection.None
  let flowTarget = ''
  let c4id: C4ID | null = null

  const isSymlinkMode = modeType === 'l'

  if (pos + 1 < n && line[pos] === '-' && line[pos + 1] === '>') {
    pos += 2

    if (isSymlinkMode) {
      while (pos < n && line[pos] === ' ') pos++
      if (pos < n) {
        ;[target, pos] = parseTarget(line, pos)
        while (pos < n && line[pos] === ' ') pos++
      }
    } else if (pos < n && line[pos] >= '1' && line[pos] <= '9') {
      const groupStart = pos
      while (pos < n && line[pos] >= '0' && line[pos] <= '9') pos++
      hardLink = parseInt(line.substring(groupStart, pos), 10)
      while (pos < n && line[pos] === ' ') pos++
    } else {
      while (pos < n && line[pos] === ' ') pos++

      if (pos < n && isFlowTarget(line.substring(pos))) {
        flowDir = FlowDirection.Outbound
        ;[flowTarget, pos] = parseFlowTarget(line, pos)
        while (pos < n && line[pos] === ' ') pos++
      } else {
        const remaining = line.substring(pos).trim()
        // One field that is "-" or a C4 ID is the hard link's ID field; two
        // fields are a target and the ID field, even when the target starts
        // with "c4" (link-target vector).
        if (isLoneIDField(remaining)) {
          hardLink = -1
        } else if (pos < n) {
          ;[target, pos] = parseTarget(line, pos)
          while (pos < n && line[pos] === ' ') pos++
        }
      }
    }
  } else if (pos + 1 < n && line[pos] === '<' && line[pos + 1] === '-') {
    pos += 2
    while (pos < n && line[pos] === ' ') pos++
    flowDir = FlowDirection.Inbound
    ;[flowTarget, pos] = parseFlowTarget(line, pos)
    while (pos < n && line[pos] === ' ') pos++
  } else if (pos + 1 < n && line[pos] === '<' && line[pos + 1] === '>') {
    pos += 2
    while (pos < n && line[pos] === ' ') pos++
    flowDir = FlowDirection.Bidirectional
    ;[flowTarget, pos] = parseFlowTarget(line, pos)
    while (pos < n && line[pos] === ' ') pos++
  }

  // 4. Parse C4 ID
  if (pos < n) {
    const remaining = line.substring(pos).trim()
    if (remaining === '-') {
      c4id = null
    } else if (remaining.startsWith('c4')) {
      c4id = parseC4ID(remaining)
    }
  }

  return { size, name, rawName, target, c4id, hardLink, flowDir, flowTarget }
}

/** Parse a single entry from a line of c4m text. */
function parseEntryFromLine(
  line: string,
  indentWidth: { value: number },
  lineNum: number,
): Entry {
  // Detect indentation
  let indent = 0
  while (indent < line.length && line[indent] === ' ') indent++

  if (indentWidth.value === -1 && indent > 0) {
    indentWidth.value = indent
  }

  const depth = indentWidth.value > 0 ? Math.floor(indent / indentWidth.value) : 0
  let content = line.substring(indent)

  // Parse mode
  let modeStr: string
  if (content.startsWith('- ')) {
    modeStr = '-'
    content = content.substring(2)
  } else if (content.length >= 11) {
    modeStr = content.substring(0, 10)
    content = content.substring(11)
  } else {
    throw new InvalidEntryError(`line ${lineNum}: line too short`)
  }

  let modeType = '-'
  let mode = 0
  if (modeStr === '-' || modeStr === '----------') {
    modeType = '-'
    mode = 0
  } else {
    ;[modeType, mode] = parseMode(modeStr)
  }

  // Parse timestamp
  let timestampStr: string
  let remaining: string

  if (content.startsWith('- ') || content.startsWith('0 ')) {
    timestampStr = '-'
    remaining = content.substring(2)
  } else if (content.length >= 20 && content[4] === '-' && content[10] === 'T') {
    let endIdx = 20
    if (content.length >= 25 && (content[19] === '-' || content[19] === '+')) {
      endIdx = 25
    }
    timestampStr = content.substring(0, endIdx)
    remaining = content.length > endIdx ? content.substring(endIdx + 1) : ''
  } else {
    // Try pretty format
    const parts = content.split(/\s+/)
    if (parts.length >= 5) {
      timestampStr = parts.slice(0, 5).join(' ')
      remaining = parts.slice(5).join(' ')
    } else {
      throw new InvalidEntryError(`line ${lineNum}: cannot parse timestamp from "${content}"`)
    }
  }

  const timestamp = parseTimestamp(timestampStr)

  // Parse remaining fields
  const fields = parseEntryFields(remaining, mode, modeType)

  const entry = createEntry({
    depth,
    mode,
    modeType,
    timestamp,
    size: fields.size,
    name: unsafeName(fields.name),
    target: unsafeName(fields.target),
    c4id: fields.c4id,
    hardLink: fields.hardLink,
    flowDirection: fields.flowDir,
    flowTarget: fields.flowTarget,
  })

  // A name is a bare entry name, checked once decoded, so an escaped "/"
  // is refused as surely as a raw one (name-rule vector).
  if (isPathName(entry.name)) {
    throw new InvalidEntryError(
      `line ${lineNum}: name ${JSON.stringify(entry.name)} is a path, not an entry name (only a directory's trailing / is allowed)`,
    )
  }

  // Check for sequence notation
  if (hasUnescapedSequenceNotation(fields.rawName)) {
    entry.isSequence = true
    entry.pattern = entry.name
  }

  return entry
}

/**
 * Decode a c4m text string into entries and metadata.
 * Returns the raw components; the Manifest class assembles them.
 *
 * When patch boundaries (bare C4 IDs between entry sections) are present,
 * sections and patchBoundaries are populated so that Manifest.parse() can
 * verify each boundary and apply patch semantics.
 */
export interface DecodeResult {
  version: string
  base: C4ID | null
  entries: Entry[]
  sections: Entry[][]       // each section between patch boundaries
  patchBoundaries: C4ID[]   // the bare C4 IDs between sections
  rangeData: Map<string, string>  // C4ID string -> inline ID list
}

/** Decode c4m text into a DecodeResult. */
export async function decode(text: string): Promise<DecodeResult> {
  const lines = text.split('\n')
  const result: DecodeResult = {
    version: '1.0',
    base: null,
    entries: [],
    sections: [],
    patchBoundaries: [],
    rangeData: new Map(),
  }

  const indentWidth = { value: -1 }
  let lineNum = 0
  let section: Entry[] = []
  let firstLine = true
  let patchMode = false

  for (const rawLine of lines) {
    lineNum++
    const trimmed = rawLine.trim()

    if (trimmed === '') continue

    // Reject CR
    if (rawLine.includes('\r')) {
      throw new InvalidEntryError(`line ${lineNum}: CR (0x0D) not allowed`)
    }

    // Check for inline ID list
    if (isInlineIDList(trimmed)) {
      const encoder = new TextEncoder()
      const bytes = encoder.encode(trimmed)
      const id = await identifyBytes(bytes)
      result.rangeData.set(id.toString(), trimmed)
      continue
    }

    // Check for bare C4 ID
    if (isBareC4ID(trimmed)) {
      const id = parseC4ID(trimmed)

      if (firstLine && section.length === 0) {
        result.base = id
      } else {
        if (patchMode && section.length === 0) {
          throw new EmptyPatchError(`line ${lineNum}`)
        }

        // Save the current section and the boundary ID
        result.sections.push(section)
        result.patchBoundaries.push(id)
        section = []
        patchMode = true
      }
      firstLine = false
      continue
    }

    // Reject directives
    if (trimmed.startsWith('@')) {
      throw new InvalidEntryError(`directives not supported (line ${lineNum})`)
    }

    // Parse entry
    const entry = parseEntryFromLine(rawLine, indentWidth, lineNum)
    section.push(entry)
    firstLine = false
  }

  // Flush remaining section
  if (patchMode && section.length === 0) {
    throw new EmptyPatchError('at end of input')
  }
  if (section.length > 0) {
    result.sections.push(section)
  }

  // For non-patch mode, entries is just the flat list from all sections.
  // For patch mode, entries is populated by Manifest.parse() after applying patches.
  if (!patchMode) {
    for (const s of result.sections) {
      result.entries.push(...s)
    }
  }

  return result
}

/** Parse c4m text into entries (convenience). */
export async function loads(text: string): Promise<DecodeResult> {
  return decode(text)
}
