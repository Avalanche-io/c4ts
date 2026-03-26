import { C4ID, parse as parseC4ID, identifyBytes } from './id.js'
import {
  type Entry,
  createEntry,
  FlowDirection,
  parseMode,
  parseTimestamp,
  isDir,
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

    // c4m field-boundary escapes
    if (ch === '\\' && pos + 1 < n) {
      const next = line[pos + 1]
      if (next === ' ' || next === '"' || next === '[' || next === ']') {
        buf += next
        pos += 2
        continue
      }
    }

    if (ch === '[' || ch === ']') {
      hasUnescapedBrackets = true
    }

    // Directory name ends at / (inclusive)
    if (ch === '/') {
      buf += '/'
      pos++
      return [buf, pos, hasUnescapedBrackets]
    }

    // Check for boundary: space followed by link operator, c4 prefix, or null
    if (ch === ' ') {
      const rest = line.substring(pos)
      if (rest.startsWith(' -> ') || rest.startsWith(' <- ') || rest.startsWith(' <> ')) {
        return [buf, pos, hasUnescapedBrackets]
      }
      // Hard link group: " ->N"
      if (rest.length >= 4 && rest[1] === '-' && rest[2] === '>' && rest[3] >= '1' && rest[3] <= '9') {
        return [buf, pos, hasUnescapedBrackets]
      }
      if (rest.length > 2 && rest[1] === 'c' && rest[2] === '4') {
        return [buf, pos, hasUnescapedBrackets]
      }
      if (rest.length >= 2 && rest[1] === '-' && (rest.length === 2 || rest[2] === ' ')) {
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
    if (ch === '\\' && pos + 1 < n) {
      const next = line[pos + 1]
      if (next === ' ' || next === '"') {
        buf += next
        pos += 2
        continue
      }
    }
    if (ch === ' ') {
      const rest = line.substring(pos)
      if (rest.length > 2 && rest[1] === 'c' && rest[2] === '4') {
        return [buf, pos]
      }
      if (rest.length >= 2 && rest[1] === '-' && (rest.length === 2 || rest[2] === ' ')) {
        return [buf, pos]
      }
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
    const ch = line[pos]
    if (ch === ' ') {
      const rest = line.substring(pos)
      if (rest.length > 2 && rest[1] === 'c' && rest[2] === '4') {
        return [line.substring(start, pos), pos]
      }
      if (rest.length >= 2 && rest[1] === '-' && (rest.length === 2 || rest[2] === ' ')) {
        return [line.substring(start, pos), pos]
      }
    }
    pos++
  }
  return [line.substring(start, pos), pos]
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
        if (remaining === '-' || remaining.startsWith('c4')) {
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
