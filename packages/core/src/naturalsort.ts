// Natural sorting for c4m manifest entries.

interface Segment {
  text: string
  isNumeric: boolean
  numValue: number // only meaningful if isNumeric
}

// segmentString splits a string into alternating text/numeric segments.
// A segment is numeric if it consists of ASCII digits 0-9 (0x30-0x39) only.
// Unicode digits are treated as text.
function segmentString(s: string): Segment[] {
  if (s === "") {
    return []
  }

  const segments: Segment[] = []
  let current = ""
  let isNumeric = false
  let first = true

  for (const ch of s) {
    const isDigit = ch >= "0" && ch <= "9"

    if (first) {
      first = false
      isNumeric = isDigit
      current = ch
    } else if (isDigit !== isNumeric) {
      // Transition between text and numeric
      const seg: Segment = {
        text: current,
        isNumeric,
        numValue: isNumeric ? parseNumber(current) : 0,
      }
      segments.push(seg)

      current = ch
      isNumeric = isDigit
    } else {
      current += ch
    }
  }

  // Add final segment
  if (current.length > 0) {
    segments.push({
      text: current,
      isNumeric,
      numValue: isNumeric ? parseNumber(current) : 0,
    })
  }

  return segments
}

// parseNumber converts a numeric string to a number using manual parsing.
function parseNumber(s: string): number {
  let result = 0
  for (const ch of s) {
    result = result * 10 + (ch.charCodeAt(0) - 0x30)
  }
  return result
}

// naturalLess compares two strings using natural sorting.
// Natural sorting handles numeric sequences intelligently:
// - "file2.txt" comes before "file10.txt"
// - "render.1.exr" comes before "render.01.exr" (equal value, shorter first)
export function naturalLess(a: string, b: string): boolean {
  const segsA = segmentString(a)
  const segsB = segmentString(b)

  const minLen = Math.min(segsA.length, segsB.length)

  for (let i = 0; i < minLen; i++) {
    const segA = segsA[i]
    const segB = segsB[i]

    if (segA.isNumeric && segB.isNumeric) {
      // Both numeric: compare as integers
      if (segA.numValue !== segB.numValue) {
        return segA.numValue < segB.numValue
      }
      // Equal values: shorter representation first
      if (segA.text.length !== segB.text.length) {
        return segA.text.length < segB.text.length
      }
    } else if (segA.isNumeric !== segB.isNumeric) {
      // Mixed types: text sorts before numeric
      return !segA.isNumeric
    } else {
      // Both text: UTF-8 codepoint comparison (standard JS string comparison)
      if (segA.text !== segB.text) {
        return segA.text < segB.text
      }
    }
  }

  // All compared segments equal: shorter name (fewer segments) first
  return segsA.length < segsB.length
}
