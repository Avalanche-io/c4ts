import type { Manifest } from './manifest.js'
import {
  type Entry,
  formatMode,
  formatSizeWithCommas,
  formatEntry,
  flowOperator,
  FlowDirection,
} from './entry.js'
import { formatName, formatTarget } from './safename.js'

/** Encoder options. */
export interface EncoderOptions {
  pretty?: boolean
  indentWidth?: number
}

/** Format a timestamp in human-readable local time. */
function formatTimestampPretty(d: Date): string {
  if (d.getTime() === 0) return '-                        '
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const month = months[d.getMonth()]
  const day = d.getDate().toString().padStart(2, ' ')
  const h = d.getHours().toString().padStart(2, '0')
  const m = d.getMinutes().toString().padStart(2, '0')
  const s = d.getSeconds().toString().padStart(2, '0')
  const year = d.getFullYear()
  // Get timezone abbreviation
  const tzMatch = d.toTimeString().match(/\(([^)]+)\)/)
  const tz = tzMatch ? tzMatch[1].split(' ').map(w => w[0]).join('') : 'UTC'
  return `${month} ${day} ${h}:${m}:${s} ${year} ${tz}`
}

/** Calculate the C4 ID column position for pretty printing. */
function calculateC4IDColumn(entries: Entry[], indentWidth: number): number {
  let maxSize = 0
  for (const entry of entries) {
    if (entry.size > maxSize) maxSize = entry.size
  }
  const maxSizeWidth = formatSizeWithCommas(maxSize).length

  let maxLen = 0
  for (const entry of entries) {
    const indent = ' '.repeat(entry.depth * indentWidth)
    const modeStr = entry.mode === 0 && entry.modeType === '-'
      ? '----------'
      : formatMode(entry.modeType, entry.mode)
    const timeStr = formatTimestampPretty(entry.timestamp)
    const nameStr = formatName(entry.name, entry.isSequence)

    let lineLen = indent.length + modeStr.length + 1 + timeStr.length + 1 + maxSizeWidth + 1 + nameStr.length
    if (entry.target !== '') {
      lineLen += 4 + entry.target.length
    } else if (entry.flowDirection !== FlowDirection.None) {
      lineLen += 1 + flowOperator(entry.flowDirection).length + 1 + entry.flowTarget.length
    }

    if (lineLen > maxLen) maxLen = lineLen
  }

  const minSpacing = 10
  let column = 80
  while (maxLen + minSpacing > column) column += 10
  return column
}

/** Format an entry with pretty printing. */
function formatEntryPretty(
  entry: Entry,
  maxSize: number,
  c4IDColumn: number,
  indentWidth: number,
): string {
  const indent = ' '.repeat(entry.depth * indentWidth)
  const modeStr = entry.mode === 0 && entry.modeType === '-'
    ? '----------'
    : formatMode(entry.modeType, entry.mode)

  const timeStr = entry.timestamp.getTime() === 0
    ? '-                        '
    : formatTimestampPretty(entry.timestamp)

  let sizeStr: string
  if (entry.size < 0) {
    const maxSizeStr = formatSizeWithCommas(maxSize)
    sizeStr = ' '.repeat(maxSizeStr.length - 1) + '-'
  } else {
    const sizeWithCommas = formatSizeWithCommas(entry.size)
    const maxSizeStr = formatSizeWithCommas(maxSize)
    sizeStr = ' '.repeat(maxSizeStr.length - sizeWithCommas.length) + sizeWithCommas
  }

  const nameStr = formatName(entry.name, entry.isSequence)
  const parts: string[] = [indent + modeStr, timeStr, sizeStr, nameStr]

  if (entry.target !== '') {
    parts.push('->', formatTarget(entry.target))
  } else if (entry.hardLink !== 0) {
    parts.push(entry.hardLink < 0 ? '->' : `->${entry.hardLink}`)
  } else if (entry.flowDirection !== FlowDirection.None) {
    parts.push(flowOperator(entry.flowDirection), entry.flowTarget)
  }

  const baseLine = parts.join(' ')

  let padding = c4IDColumn - baseLine.length
  if (padding < 10) padding = 10

  const idStr = entry.c4id && !entry.c4id.isNil() ? entry.c4id.toString() : '-'
  return baseLine + ' '.repeat(padding) + idStr
}

/** Encode a manifest to c4m text. */
export function encode(m: Manifest, options: EncoderOptions = {}): string {
  const pretty = options.pretty ?? false
  const indentWidth = options.indentWidth ?? 2

  // Sort a copy
  const sorted = m.copy()
  sorted.sortEntries()

  const lines: string[] = []

  if (pretty) {
    let maxSize = 0
    for (const entry of sorted.entries) {
      if (entry.size > maxSize) maxSize = entry.size
    }
    const c4IDColumn = calculateC4IDColumn(sorted.entries, indentWidth)
    for (const entry of sorted.entries) {
      lines.push(formatEntryPretty(entry, maxSize, c4IDColumn, indentWidth))
    }
  } else {
    for (const entry of sorted.entries) {
      lines.push(formatEntry(entry, indentWidth, false))
    }
  }

  // Inline range data
  if (sorted.rangeData.size > 0) {
    const keys = [...sorted.rangeData.keys()].sort()
    for (const key of keys) {
      lines.push(sorted.rangeData.get(key)!)
    }
  }

  return lines.map(l => l + '\n').join('')
}

/** Encode a manifest in canonical form (convenience). */
export function dumps(m: Manifest, options?: { pretty?: boolean }): string {
  return encode(m, options)
}
